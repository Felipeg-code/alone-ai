require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { loadFlows, saveFlows, matchFlow, findSystemFlow, isWithinBusinessHours, businessHoursDiagnostics } = require('./flows');
const { startWhatsApp, getStatus, disconnectWhatsApp } = require('./whatsapp');
const { sendText:sendManualMessage, sendResponse:sendManualResponse, sendBuffer:sendManualBuffer } = require('./messaging-provider');
const { startScheduler, getSchedulerStatus } = require('./scheduler');
const { processProspectingQueue, processProspectingCampaign, getProspectingDiagnostics } = require('./prospecting');
const { processProactiveFollowups, diagnostics: getProactiveDiagnostics } = require('./proactivity');
const agents = require('./agents');
const settings = require('./settings');
const crmConfig = require('./crm-config');
const gemini = require('./gemini');
const onboarding = require('./onboarding');
const ops = require('./ops');
const { processRetryQueue } = require('./reliability');
const safetyEngine = require('./safety-engine');
const outboundPolicy = require('./outbound-policy');
const messagingProvider = require('./messaging-provider');
const { publicDir, dataDir, isPackaged, baseDir } = require('./paths');
const packageInfo = require('../package.json');
const INSTANCE_ID = String(process.env.ALONE_INSTANCE_ID || 'unknown');

// Eventos assíncronos de bibliotecas externas não podem derrubar silenciosamente o servidor.
process.on('unhandledRejection',(reason)=>{
  const detail=String(reason?.stack||reason?.message||reason).slice(0,5000);
  console.error('[process:unhandledRejection]',detail);
  try { ops.audit('process_unhandled_rejection',{resource:'backend',details:{error:String(reason?.message||reason).slice(0,1000)}}); } catch (_) {}
});
process.on('uncaughtExceptionMonitor',(err,origin)=>{
  console.error('[process:uncaughtException]',origin,String(err?.stack||err));
});

// A preparação da IA só pode existir quando a conexão WhatsApp está realmente aberta.
onboarding.setConnectionChecker(()=>getStatus().status);

// Recuperação determinística de acesso local. O flag só vale para esta inicialização.
if (process.env.ALONE_RESET_ACCESS === '1') {
  try { agents.resetDefaultAccess(); console.log('[access] Gestor resetado para PIN temporário 123456'); }
  catch (err) { console.error('[access] falha ao resetar acesso:', err.message); }
}

const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
app.use(express.json({ limit:'30mb' }));
app.use(express.static(publicDir));

app.get('/api/agents', (_req,res) => res.json(agents.publicAgents()));
app.get('/api/public-config', (_req,res)=>{const s=settings.publicSettings();res.json({themeColor:s.themeColor,gymName:s.gymName,instanceId:INSTANCE_ID,appVersion:packageInfo.version});});
app.post('/api/agents/login', (req,res) => {
  const key=`${req.ip||'local'}:${Number(req.body.agentId||0)}`; const now=Date.now();
  const attempt=loginAttempts.get(key)||{fails:0,lockedUntil:0,firstAt:now};
  if(attempt.lockedUntil>now)return res.status(429).json({error:'Muitas tentativas. Aguarde alguns minutos.'});
  const agent = agents.login(req.body.agentId, req.body.pin);
  if (!agent) {
    if(now-attempt.firstAt>5*60*1000){attempt.fails=0;attempt.firstAt=now;}
    attempt.fails++; if(attempt.fails>=5)attempt.lockedUntil=now+10*60*1000; loginAttempts.set(key,attempt);
    return res.status(401).json({error:'PIN incorreto'});
  }
  loginAttempts.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { agentId: agent.id, createdAt: Date.now(), lastSeenAt: Date.now() });
  res.json({ ...agent, token });
});
function requireAuth(req,res,next) {
  const token = req.get('x-session-token') || (req.path==='/events' ? String(req.query?.token||'') : '');
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({error:'Sessão inválida. Entre novamente.'});
  const now = Date.now();
  if (now - Number(session.lastSeenAt || session.createdAt) > SESSION_IDLE_MS || now - Number(session.createdAt) > SESSION_MAX_MS) {
    sessions.delete(token); return res.status(401).json({error:'Sessão expirada. Entre novamente.'});
  }
  const agent = agents.getAgent(session.agentId);
  if (!agent || !agent.active) { sessions.delete(token); return res.status(401).json({error:'Usuário inativo.'}); }
  session.lastSeenAt = now;
  req.agent = agent; req.sessionToken = token; next();
}
function requireManager(req,res,next) { if (req.agent?.role !== 'gestor') return res.status(403).json({error:'Apenas gestores podem executar esta ação.'}); next(); }
function requireCapability(name) { return (req,res,next)=> req.agent?.[name] ? next() : res.status(403).json({error:'Sem permissão para esta ação.'}); }
function blockIfOptedOut(res,contact){
  const policy=outboundPolicy.check({settings:settings.loadSettings(),contact,kind:'manual',source:'manual_ui'});
  if(policy.allowed)return false;
  res.status(409).json({error:'Contato em opt-out. Reative o consentimento explicitamente antes de enviar.',reason:policy.reason});
  return true;
}

app.use('/api', requireAuth);
app.get('/api/me', (req,res)=>res.json(req.agent));
app.put('/api/me/pin',(req,res)=>{
  const pin=String(req.body.pin||'').trim();
  if(!/^\d{6,12}$/.test(pin))return res.status(400).json({error:'O novo PIN deve ter de 6 a 12 dígitos.'});
  if(['000000','111111','222222','333333','123456'].includes(pin))return res.status(400).json({error:'Escolha um PIN diferente do padrão.'});
  const list=agents.loadAgents(); const idx=list.findIndex(a=>a.id===req.agent.id);
  if(idx<0)return res.status(404).json({error:'Usuário não encontrado.'});
  list[idx]={...list[idx],pin,must_change_pin:false}; agents.saveAgents(list);
  res.json({ok:true,agent:agents.getAgent(req.agent.id)});
});
app.use('/api',(req,res,next)=>{
  if(!req.agent?.must_change_pin)return next();
  const allowed=(req.method==='GET'&&['/me','/agents'].includes(req.path)) || (req.method==='PUT'&&req.path==='/me/pin') || (req.method==='POST'&&req.path==='/agents/logout');
  if(allowed)return next();
  return res.status(428).json({error:'Troque o PIN padrão antes de operar o sistema.',code:'PIN_CHANGE_REQUIRED'});
});
app.get('/api/status', (_req,res) => res.json(getStatus()));
app.get('/api/bootstrap-status', (_req,res) => {
  const wa=getStatus();
  let st=onboarding.status();
  if(wa.status!=='conectado' && !st.ready && (st.status!=='aguardando_whatsapp' || Number(st.percent||0)!==0)) st=onboarding.markWaitingForWhatsApp({preserveReady:false});
  res.json({...st,whatsappStatus:wa.status,whatsappConnected:wa.status==='conectado'});
});
app.get('/api/settings', (_req,res)=>res.json(settings.publicSettings()));
app.get('/api/business-hours/status', (_req,res)=>{const st=settings.loadSettings();res.json({...businessHoursDiagnostics(new Date(),st),businessHours:st.businessHours,settingsRevision:st.settingsRevision||0});});
app.get('/api/crm-config',(req,res)=>res.json(crmConfig.publicFor(req.agent)));
app.put('/api/crm-config/global',requireManager,(req,res)=>res.json({ok:true,global:crmConfig.saveGlobal(req.body||{})}));
app.put('/api/crm-config/me',(req,res)=>res.json({ok:true,personal:crmConfig.savePersonal(req.agent.id,req.body||{})}));
app.use('/api', (req,res,next)=>{
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    res.on('finish',()=>{ if(res.statusCode<500) ops.audit('api_mutation',{agentId:req.agent?.id,resource:req.path,details:{method:req.method,status:res.statusCode,bodyKeys:Object.keys(req.body||{}).filter(k=>!/(pin|key|token|fileData)/i.test(k))}}); });
  }
  next();
});
app.use('/api/contacts/:id', (req,res,next)=>{
  const c=db.getContactById(req.params.id);
  if (!c) return res.status(404).json({error:'Contato não encontrado'});
  if (!req.agent.canViewAllCRM && c.assigned_agent_id != null && c.assigned_agent_id !== req.agent.id) return res.status(403).json({error:'Sem permissão para acessar este contato.'});
  req.contact=c; next();
});


// Sincronização em tempo real do CRM/UI via Server-Sent Events.
// Envia apenas metadados mínimos; os dados completos continuam protegidos pelas rotas autenticadas.
app.get('/api/events',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  if(res.flushHeaders)res.flushHeaders();
  const send=(name,payload)=>{try{res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);}catch(_){}};
  send('ready',{ok:true,at:new Date().toISOString()});
  const unsubscribe=db.subscribeRealtime((evt)=>{
    try{
      if(evt.contactId!=null){
        const c=db.getContactById(evt.contactId);
        if(!c)return;
        if(!req.agent.canViewAllCRM && c.assigned_agent_id!=null && c.assigned_agent_id!==req.agent.id)return;
      }
      send('crm',evt);
    }catch(_){ }
  });
  const heartbeat=setInterval(()=>{
    const session=sessions.get(req.sessionToken); const now=Date.now();
    if(!session || now-Number(session.lastSeenAt||session.createdAt)>SESSION_IDLE_MS || now-Number(session.createdAt)>SESSION_MAX_MS){
      send('session',{expired:true}); clearInterval(heartbeat); unsubscribe(); try{res.end();}catch(_){}; return;
    }
    send('ping',{at:new Date().toISOString()});
  },25000);
  req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
});

app.post('/api/agents/logout', (req,res)=>{sessions.delete(req.sessionToken);res.json({ok:true});});

// ----- Operação / robustez v6 -----
app.get('/api/health', (_req,res)=>{
  const st=settings.loadSettings(); const wa=getStatus(); const boot=onboarding.status();
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  const snapshot=ops.healthSnapshot({whatsappStatus:wa.status,geminiConfigured:Boolean(st.geminiApiKey),geminiRuntime:gemini.runtimeStatus(),dbMetrics:{...db.getMetrics(),storage:db.getStorageStatus()},scheduler:getSchedulerStatus()});
  const safety=safetyEngine.calculateHealth(st);
  res.json({...snapshot,safety:{...safety,automationMode:st.outboundAutomationMode||'approval',accountProtectionMode:st.accountProtectionMode||'strict',approvals:ops.approvalMetrics()},bootstrap:{status:boot.status,phase:boot.phase,percent:boot.percent,ready:boot.ready,error:boot.error,current:boot.current,last_update_at:boot.lastUpdateAt,quality:st.aiBootstrapQuality||'',has_style_profile:Boolean(String(st.learnedStyleProfile||'').trim()),has_business_profile:Boolean(String(st.learnedBusinessProfile||'').trim()),profiled_contacts:Number(st.aiBootstrapProfiledContacts||0),sampled_messages:Number(st.aiBootstrapSampledMessages||0),diagnostics:st.aiBootstrapDiagnostics||{}},whatsapp_error:wa.error||null});
});
app.get('/api/safety/status', requireCapability('canSeeDashboard'), (_req,res)=>{const st=settings.loadSettings();const health=safetyEngine.calculateHealth(st);res.json({...health,automationMode:st.outboundAutomationMode||'approval',accountProtectionMode:st.accountProtectionMode||'strict',approvals:ops.approvalMetrics(),provider:messagingProvider.providerInfo(),whatsapp:getStatus()});});
app.get('/api/safety/approvals', requireCapability('canSeeDashboard'), (req,res)=>res.json(ops.listOutboundApprovals({status:req.query.status||'pending',limit:req.query.limit||300})));
app.post('/api/safety/approvals/:id/reject', requireManager, (req,res)=>{const row=ops.resolveOutboundApproval(req.params.id,'rejected',req.agent.id,req.body.note||'');if(!row)return res.status(404).json({error:'Aprovação não encontrada'});res.json(row);});
app.post('/api/safety/approvals/:id/approve', requireManager, async (req,res)=>{
  const row=ops.getOutboundApproval(req.params.id);if(!row||row.status!=='pending')return res.status(404).json({error:'Aprovação pendente não encontrada'});
  const c=db.getContactById(row.contact_id);if(!c)return res.status(404).json({error:'Contato não encontrado'});
  const st=settings.loadSettings();const maxAge=Math.max(1,Number(st.safetyApprovalMaxAgeHours||24))*3600000;
  if(Date.now()-new Date(row.created_at).getTime()>maxAge){ops.resolveOutboundApproval(row.id,'cancelled',req.agent.id,'Aprovação expirada');return res.status(409).json({error:'Esta aprovação expirou e foi cancelada.'});}
  if(c.last_inbound_at&&new Date(c.last_inbound_at).getTime()>new Date(row.created_at).getTime()){ops.resolveOutboundApproval(row.id,'cancelled',req.agent.id,'Cliente respondeu após a criação da aprovação');return res.status(409).json({error:'O cliente respondeu depois desta sugestão. A aprovação antiga foi cancelada.'});}
  const alreadySent=db.getContactMessages(c.id,true).some(m=>m.direction==='out'&&String(m.body||'').trim()===String(row.text||'').trim()&&new Date(m.created_at).getTime()>=new Date(row.created_at).getTime());
  if(alreadySent){ops.resolveOutboundApproval(row.id,'cancelled',req.agent.id,'Mensagem já enviada por outro fluxo');return res.json({ok:true,alreadySent:true,id:row.id});}
  if(c.opted_out||c.consent_status==='opted_out')return res.status(409).json({error:'Contato em opt-out. Envio bloqueado.'});
  if(row.kind==='campaign' && db.getConsentLedger(c.id)?.categories?.marketing!=='opted_in')return res.status(409).json({error:'Consentimento de marketing não confirmado.'});
  if(String(row.source||'').toLowerCase().includes('reativ') && db.getConsentLedger(c.id)?.categories?.reactivation!=='opted_in')return res.status(409).json({error:'Consentimento de reativação não confirmado.'});
  const result=await safetyEngine.withAutomationLock(async()=>{
    const currentApproval=ops.getOutboundApproval(row.id);
    if(!currentApproval||currentApproval.status!=='pending')return {ok:true,id:row.id,contactId:c.id,alreadyResolved:true};
    const fresh=db.getContactById(c.id);
    if(!fresh)return {ok:false,status:404,error:'Contato não encontrado'};
    const duplicateNow=db.getContactMessages(fresh.id,true).some(m=>m.direction==='out'&&String(m.body||'').trim()===String(currentApproval.text||'').trim()&&new Date(m.created_at).getTime()>=new Date(currentApproval.created_at).getTime());
    if(duplicateNow){ops.resolveOutboundApproval(currentApproval.id,'cancelled',req.agent.id,'Mensagem já enviada por outro fluxo');return {ok:true,id:currentApproval.id,contactId:fresh.id,alreadySent:true};}
    const recheck=outboundPolicy.check({settings:settings.loadSettings(),contact:fresh,kind:currentApproval.kind,source:currentApproval.source,humanApproved:true});
    if(!recheck.allowed){
      ops.resolveOutboundApproval(row.id,'cancelled',req.agent.id,`Bloqueado na revalidação de segurança: ${recheck.reason}`);
      return {ok:false,status:409,reason:recheck.reason,safety:recheck.health||null};
    }
    try{
      await sendManualMessage(fresh.phone,currentApproval.text);db.logMessage(fresh.id,'out','text',currentApproval.text,`aprovado:${currentApproval.source}`,req.agent.id);db.touchOutbound(fresh.id);
      const meta=currentApproval.meta||{};
      if(currentApproval.kind==='proactive'&&meta.scenario){db.markProactiveSent(fresh.id,meta.scenario,currentApproval.text);db.updateContact(fresh.id,{next_action:'Aguardar resposta do follow-up proativo'},{activity:false});}
      if(currentApproval.kind==='journey'&&meta.journeyStage){db.markJourneyFollowupSent(fresh.id,meta.journeyStage);db.updateContact(fresh.id,{next_action:'Acompanhar resposta do follow-up da jornada'},{activity:false});}
      if(currentApproval.kind==='campaign'&&meta.prospectQueueId){db.markProspectSent(meta.prospectQueueId);if(meta.stage)db.setJourneyStage(fresh.id,meta.stage,{reason:`campanha_aprovada:${meta.campaignId||''}`,agentId:req.agent.id});}
      if(meta.reactivation){db.markCampaignSent(fresh.id);db.setJourneyStage(fresh.id,'reativacao',{reason:'reativacao_aprovada',agentId:req.agent.id});}
      ops.resolveOutboundApproval(currentApproval.id,'sent',req.agent.id,req.body.note||'Aprovado e enviado');return {ok:true,id:currentApproval.id,contactId:fresh.id};
    }catch(err){return {ok:false,status:500,error:err.message};}
  });
  if(!result.ok)return res.status(result.status||500).json(result.status===409?{error:'Envio bloqueado pela revalidação de segurança.',reason:result.reason,safety:result.safety}:{error:result.error||'Falha no envio'});
  res.json({ok:true,id:result.id,contactId:result.contactId});
});

app.get('/api/retries', requireManager, (req,res)=>res.json(ops.listRetry({status:req.query.status,limit:req.query.limit||200})));
app.post('/api/retries/process-now', requireManager, async (_req,res)=>{try{res.json(await processRetryQueue());}catch(err){res.status(500).json({error:err.message});}});

app.post('/api/retries/:id/now', requireManager, (req,res)=>{const j=ops.retryNow(req.params.id);if(!j)return res.status(404).json({error:'Job não encontrado'});res.json(j);});
app.get('/api/operations-queue', requireCapability('canSeeDashboard'), (req,res)=>{const retry=ops.listRetry({limit:100}).filter(x=>x.status!=='done');const approvals=ops.listOutboundApprovals({status:'pending',limit:100});const prospect=[];for(const c of db.listProspectCampaigns())for(const q of db.listProspectQueue(c.id,200).filter(x=>['pending','sending','failed'].includes(x.status)))prospect.push({...q,kind:'prospecting',campaign_name:c.name});const journey=db.getJourneyFollowupCandidates(settings.loadSettings().journeyAutomations||{},50).map(c=>({id:`journey-${c.id}`,kind:'journey',status:'pending',contact_id:c.id,stage:c.journey_stage,next_attempt_at:c.follow_up_at||c.journey_updated_at}));res.json({retry,approvals,prospecting:prospect.slice(0,100),journey});});

app.get('/api/backups', requireCapability('canRestoreBackup'), (_req,res)=>res.json(ops.listBackups()));
app.post('/api/backups', requireManager, (req,res)=>{try{res.json(ops.createBackup(req.body.label||'manual'));}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/backups/:name/restore', requireManager, (req,res)=>{try{res.json(ops.restoreBackup(req.params.name,req.agent.id));}catch(err){res.status(400).json({error:err.message});}});
app.get('/api/audit', requireManager, (req,res)=>res.json(ops.listAudit({limit:req.query.limit||300,agentId:req.query.agentId,action:req.query.action,contactId:req.query.contactId})));
app.get('/api/knowledge', (_req,res)=>res.json(ops.listKnowledge()));
app.post('/api/knowledge', requireManager, (req,res)=>{if(!String(req.body.title||'').trim()||!String(req.body.content||'').trim())return res.status(400).json({error:'Título e conteúdo são obrigatórios'});res.json(ops.upsertKnowledge(req.body,req.agent.id));});
app.put('/api/knowledge/:id', requireManager, (req,res)=>res.json(ops.upsertKnowledge({...req.body,id:req.params.id},req.agent.id)));
app.delete('/api/knowledge/:id', requireManager, (req,res)=>res.json({ok:ops.deleteKnowledge(req.params.id,req.agent.id)}));
app.post('/api/knowledge/preview', requireManager, async (req,res)=>{const st=settings.loadSettings();if(!st.geminiApiKey)return res.status(400).json({error:'Gemini não configurado'});try{const reply=await gemini.previewKnowledge({settings:st,category:req.body.category||'geral',title:req.body.title||'',content:req.body.content||'',question:req.body.question||''});res.json({reply});}catch(err){res.status(500).json({error:err.message});}});

app.get('/api/journey-templates', (_req,res)=>res.json(ops.listTemplates()));
app.post('/api/journey-templates', requireManager, (req,res)=>res.json(ops.saveTemplate(req.body,req.agent.id)));
app.put('/api/journey-templates/:id', requireManager, (req,res)=>res.json(ops.saveTemplate({...req.body,id:req.params.id},req.agent.id)));
app.delete('/api/journey-templates/:id', requireManager, (req,res)=>res.json({ok:ops.deleteTemplate(req.params.id,req.agent.id)}));
app.get('/api/inbox', (req,res)=>{if(req.query.scope==='all'&&req.agent.canViewAllCRM)return res.json(db.getInboxSummary(null));res.json(db.getInboxSummary(req.agent.id,true));});
app.get('/api/contacts/:id/memory', (req,res)=>{const c=req.contact||db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});res.json({company:ops.companyMemoryText(),memory:db.getCustomerMemory(c.id),customer:{profile_summary:c.profile_summary,needs:c.needs,objections:c.objections,goals:c.goals,interest:c.interest,plan_name:c.plan_name,jornada:c.journey_stage,status:c.status,lead_score:c.lead_score},conversation:db.getRecentConversation(c.id,16)});});
app.put('/api/contacts/:id/memory', (req,res)=>{const c=req.contact||db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});const memory=db.updateCustomerMemory(c.id,req.body||{},{source:'manual',agentId:req.agent?.id});res.json(memory);});
app.post('/api/contacts/:id/memory/event', (req,res)=>{const c=req.contact||db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});const m=db.appendCustomerMemoryEvent(c.id,req.body.type||'manual',req.body.label||'',req.body.details||'',`agent:${req.agent?.id||''}`);res.json(m);});
app.get('/api/contacts/:id/diagnostics', (req,res)=>{
  const c=req.contact||db.getContactById(req.params.id); const st=settings.loadSettings(); const history=db.getRecentConversation(c.id,40);
  const lastInbound=[...history].reverse().find(m=>m.direction==='in'&&String(m.body||'').trim());
  const hours=businessHoursDiagnostics(new Date(),st); const fm=lastInbound?matchFlow(loadFlows(),String(lastInbound.body||''),false,{contact:c,settings:st,withinBusinessHours:hours.within}):null;
  const q=lastInbound?String(lastInbound.body||''):''; const knowledge=ops.listKnowledge().filter(k=>['official','reviewed','learned'].includes(k.effective_status));
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); const tokens=[...new Set(norm(q).split(/[^a-z0-9]+/).filter(x=>x.length>3))];
  const relevantKnowledge=knowledge.map(k=>({k,score:tokens.reduce((n,t)=>n+(norm(k.title).includes(t)?3:0)+(norm((k.keywords||[]).join(' ')).includes(t)?3:0)+(norm(k.content).includes(t)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||Number(b.k.priority||0)-Number(a.k.priority||0)).slice(0,5).map(x=>({id:x.k.id,title:x.k.title,status:x.k.effective_status,priority:x.k.priority,score:x.score}));
  const retryJobs=ops.listRetry({limit:300}).filter(j=>j.status!=='done'&&Number(j.payload?.contactId)===Number(c.id)).map(j=>({id:j.id,kind:j.kind,status:j.status,attempts:j.attempts,next_attempt_at:j.next_attempt_at,last_error:j.last_error}));
  res.json({generated_at:new Date().toISOString(),contact:{id:c.id,ai_paused:Boolean(c.ai_paused),requires_human:Boolean(c.requires_human),human_reason:c.human_reason||'',confidence:Number(c.ai_confidence||0),decision_reason:c.ai_decision_reason||'',last_intent:c.last_intent||c.interest||''},last_inbound:lastInbound?{id:lastInbound.id,text:lastInbound.body,created_at:lastInbound.created_at}:null,business_hours:hours,matched_flow:fm?.flow?{key:fm.key,label:fm.flow.label,execution:fm.flow.execution||'',priority:fm.flow.priority||0,cooldown_hours:fm.flow.cooldownHours||0}:null,knowledge:relevantKnowledge,agent:{enabled:Boolean(st.aiEnabled),ready:Boolean(st.aiReady),mode:st.aiMode||'assistido',delay_min_ms:Number(st.agentDelayMinMs||0),delay_max_ms:Number(st.agentDelayMaxMs||0)},whatsapp:getStatus(),retries:retryJobs});
});
app.post('/api/contacts/:id/human-review', (req,res)=>{const c=db.setHumanReview(req.params.id,Boolean(req.body.required),req.body.reason||'',req.agent.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});res.json(c);});
const whatsappConnectionStatePath = path.join(dataDir, 'whatsapp-connection.json');
const whatsappAuthDir = path.join(dataDir, 'auth');
function readWhatsAppConnectionState(){ try{return JSON.parse(fs.readFileSync(whatsappConnectionStatePath,'utf8'));}catch(_){return {userRequested:false};} }
function writeWhatsAppConnectionState(value){ fs.mkdirSync(dataDir,{recursive:true}); const tmp=whatsappConnectionStatePath+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8'); fs.renameSync(tmp,whatsappConnectionStatePath); }

app.post('/api/whatsapp/connect', requireCapability('canDisconnectWhatsApp'), async (_req,res) => {
  try {
    const previous=readWhatsAppConnectionState();
    // Se esta instalação nunca recebeu um clique explícito em Conectar, qualquer auth existente é resíduo antigo e deve ser ignorado.
    if(!previous.userRequested && fs.existsSync(whatsappAuthDir)) fs.rmSync(whatsappAuthDir,{recursive:true,force:true});
    writeWhatsAppConnectionState({userRequested:true,requestedAt:new Date().toISOString()});
    await startWhatsApp();
    res.json(getStatus());
  } catch (err) {
    res.status(500).json({error:err.message || 'Falha ao iniciar conexão do WhatsApp'});
  }
});
app.post('/api/whatsapp/disconnect', requireCapability('canDisconnectWhatsApp'), async (_req,res) => {
  try { const result=await disconnectWhatsApp(); writeWhatsAppConnectionState({userRequested:false,disconnectedAt:new Date().toISOString()}); res.json(result); }
  catch (err) { res.status(500).json({error:err.message || 'Falha ao desconectar WhatsApp'}); }
});
app.post('/api/agents', requireManager, (req,res) => {
  const name=String(req.body.name||'').trim();
  const role=String(req.body.role||'atendimento').trim();
  const allowedRoles=new Set(['atendimento','comercial','financeiro','gestor']);
  if(name.length<2) return res.status(400).json({error:'Nome do atendente é obrigatório.'});
  if(!allowedRoles.has(role)) return res.status(400).json({error:'Função inválida.'});
  if(!/^\d{6,12}$/.test(String(req.body.pin||''))) return res.status(400).json({error:'PIN é obrigatório e deve ter de 6 a 12 dígitos.'});
  const list = agents.loadAgents();
  const nextId = Math.max(0,...list.map((a)=>a.id))+1;
  const newAgent = {
    id:nextId, name, pin:req.body.pin,
    color:req.body.color || '#FF6B00', active:true, role,
    specialties:Array.isArray(req.body.specialties) && req.body.specialties.length ? req.body.specialties : ['geral'], ...(agents.rolePermissions(role)), ...Object.fromEntries(Object.entries(req.body).filter(([k])=>k.startsWith('can'))),
  };
  list.push(newAgent); agents.saveAgents(list); res.status(201).json(agents.getAgent(nextId));
});
app.put('/api/agents/:id', requireManager, (req,res) => {
  if(req.body.pin && !/^\d{6,12}$/.test(String(req.body.pin))) return res.status(400).json({error:'PIN deve ter de 6 a 12 dígitos.'});
  const allowedRoles=new Set(['atendimento','comercial','financeiro','gestor']);
  if(req.body.role!==undefined && !allowedRoles.has(String(req.body.role))) return res.status(400).json({error:'Função inválida.'});
  const list=agents.loadAgents(); const idx=list.findIndex((a)=>a.id===Number(req.params.id));
  if(idx<0) return res.status(404).json({error:'Atendente não encontrado'});
  const allowed=['name','pin','color','active','role','specialties','canViewAllCRM','canManageProspecting','canManageKnowledge','canManageQuickReplies','canExportCRM','canSeeDashboard','canRestoreBackup','canDisconnectWhatsApp','canManageTeam','canViewAllTasks','canViewAllCalendar','canManageTasks','canManageCalendar'];
  const patch={}; for(const k of allowed) if(req.body[k]!==undefined) patch[k]=req.body[k];
  if(patch.role && patch.role!==list[idx].role){
    const defaults=agents.rolePermissions(patch.role);
    Object.assign(patch,defaults);
    for(const k of Object.keys(defaults)) if(req.body[k]!==undefined) patch[k]=Boolean(req.body[k]);
  }
  list[idx]={...list[idx],...patch,id:list[idx].id}; agents.saveAgents(list); res.json(agents.getAgent(list[idx].id));
});

app.get('/api/metrics', (_req,res)=>res.json(db.getMetrics()));

app.get('/api/search', (req,res)=>{const result=db.searchGlobal(req.query.q||'',req.query.limit||60);if(req.agent.canViewAllCRM)return res.json(result);const allowed=new Set(db.listOperationalContactsForAgent(req.agent.id).map(c=>Number(c.id)));res.json({contacts:(result.contacts||[]).filter(c=>allowed.has(Number(c.id))),messages:(result.messages||[]).filter(m=>allowed.has(Number(m.contact_id))),activities:(result.activities||[]).filter(a=>allowed.has(Number(a.contact_id)))});});
app.get('/api/knowledge-gaps', requireCapability('canManageKnowledge'), (_req,res)=>{
  const merged=new Map();
  const add=(row,source)=>{const gap=String(row?.gap||'').trim();if(!gap)return;const key=gap.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');const prev=merged.get(key)||{gap,count:0,sources:[]};prev.count+=Math.max(1,Number(row?.count||1));if(!prev.sources.includes(source))prev.sources.push(source);merged.set(key,prev);};
  for(const row of ops.listKnowledgeGaps())add(row,'empresa');
  for(const row of db.listKnowledgeGaps())add(row,'clientes');
  res.json([...merged.values()].sort((a,b)=>b.count-a.count).slice(0,80));
});
app.get('/api/ai/runtime', requireCapability('canSeeDashboard'), (_req,res)=>res.json(gemini.runtimeStatus()));
app.get('/api/ai/learning-status', requireCapability('canSeeDashboard'), (_req,res)=>{
  const st=settings.loadSettings(); const knowledge=ops.listKnowledge();
  const byStatus={official:0,reviewed:0,learned:0,review:0,expired:0}; for(const k of knowledge)byStatus[k.effective_status]=(byStatus[k.effective_status]||0)+1;
  const recent=[...ops.listAudit({limit:80}).filter(x=>['continuous_learning_completed','continuous_learning_failed'].includes(x.action))].slice(0,12);
  res.json({enabled:st.continuousLearningEnabled!==false,status:st.continuousLearningStatus||'',last_at:st.continuousLearningLastAt||null,pending:Number(st.continuousLearningLastNewMessages||0),batch:Number(st.continuousLearningBatchMessages||8),runs:Number(st.continuousLearningRuns||0),failures:Number(st.continuousLearningFailures||0),last_duration_ms:Number(st.continuousLearningLastDurationMs||0),last_profiled:Number(st.continuousLearningLastProfiled||0),last_knowledge_delta:Number(st.continuousLearningLastKnowledgeDelta||0),last_error:String(st.continuousLearningLastError||''),knowledge:byStatus,recent});
});
app.get('/api/team-performance', requireCapability('canSeeDashboard'), (_req,res)=>res.json(db.teamPerformance()));
app.post('/api/bootstrap/control', requireManager, (req,res)=>{try{const ctl=String(req.body.control||'');if(ctl==='running'&&getStatus().status!=='conectado')return res.status(409).json({error:'Conecte o WhatsApp antes de iniciar ou continuar a preparação.'});const st=onboarding.setControl(ctl);if(ctl==='running')setTimeout(()=>onboarding.runBootstrap({force:false}).catch(()=>{}),100);res.json(st);}catch(err){res.status(400).json({error:err.message});}});

app.get('/api/dashboard', (req,res)=>{const contacts=req.agent.canSeeDashboard?db.listContacts():db.listOperationalContactsForAgent(req.agent.id);res.json(db.commercialDashboard(contacts,req.agent.canSeeDashboard?null:req.agent.id));});
app.get('/api/segments/:segment', requireCapability('canSeeDashboard'), (req,res)=>{const contacts=req.agent.canViewAllCRM?db.listContacts():db.listOperationalContactsForAgent(req.agent.id);const rows=db.segmentContacts(String(req.params.segment||'all'),contacts).slice(0,1000);res.json({segment:req.params.segment,count:rows.length,contacts:rows});});
app.get('/api/proactivity/status', requireCapability('canSeeDashboard'), (req,res)=>res.json(getProactiveDiagnostics(settings.loadSettings(),req.query.segment||null)));
app.post('/api/proactivity/process-now', requireCapability('canSeeDashboard'), async (req,res)=>{try{const allowed=req.agent.canViewAllCRM?db.listContacts():db.listOperationalContactsForAgent(req.agent.id);const allowedIds=new Set(allowed.map(c=>Number(c.id)));const ids=Array.isArray(req.body.contactIds)?req.body.contactIds.map(Number).filter(id=>allowedIds.has(id)):null;res.json(await processProactiveFollowups({segment:req.body.segment||null,contactIds:ids}));}catch(err){res.status(500).json({error:err.message});}});
app.get('/api/alerts/abandoned', (req,res)=>{let rows=db.getAbandonedContacts(req.query.minutes||30);if(!req.agent.canViewAllCRM)rows=rows.filter(c=>c.assigned_agent_id===req.agent.id||c.assigned_agent_id==null);res.json(rows);});
function validAssignableAgent(id){if(id===undefined||id===null||id==='')return true;const a=agents.getAgent(Number(id));return Boolean(a&&a.active);}
function canAccessOperationalContact(agent,contactId){if(!contactId)return true;const c=db.getContactById(contactId);if(!c)return false;return Boolean(agent.canViewAllCRM||c.assigned_agent_id==null||c.assigned_agent_id===agent.id);}
function filterRowsByContactAccess(agent,rows){return agent.canViewAllCRM?rows:rows.filter(r=>!r.contact_id||canAccessOperationalContact(agent,r.contact_id));}
app.get('/api/tasks', (req,res)=>{if(req.query.contactId&&!canAccessOperationalContact(req.agent,req.query.contactId))return res.status(403).json({error:'Sem permissão para acessar tarefas deste contato.'});const agentId=req.agent.canViewAllTasks?(req.query.agentId||undefined):req.agent.id;res.json(filterRowsByContactAccess(req.agent,db.listTasks({agentId,status:req.query.status,contactId:req.query.contactId})));});
app.post('/api/tasks', requireCapability('canManageTasks'), (req,res)=>{const body={...req.body};if(body.contact_id&&!canAccessOperationalContact(req.agent,body.contact_id))return res.status(403).json({error:'Sem permissão para vincular tarefa a este contato.'});if(!req.agent.canViewAllTasks)body.assigned_agent_id=req.agent.id;if(!validAssignableAgent(body.assigned_agent_id))return res.status(400).json({error:'Atendente responsável inválido ou inativo.'});res.json(db.createTask(body,req.agent.id));});
app.put('/api/tasks/:id', requireCapability('canManageTasks'), (req,res)=>{const own=db.listTasks({agentId:req.agent.id}).find(t=>t.id===Number(req.params.id));if(!req.agent.canViewAllTasks&&!own)return res.status(403).json({error:'Sem permissão para alterar esta tarefa.'});const current=(req.agent.canViewAllTasks?db.listTasks({}):db.listTasks({agentId:req.agent.id})).find(t=>t.id===Number(req.params.id));if(current?.contact_id&&!canAccessOperationalContact(req.agent,current.contact_id))return res.status(403).json({error:'Sem permissão para alterar tarefa vinculada a outro contato.'});if(req.body.contact_id&&!canAccessOperationalContact(req.agent,req.body.contact_id))return res.status(403).json({error:'Sem permissão para vincular tarefa a este contato.'});const patch={...req.body};if(!req.agent.canViewAllTasks)patch.assigned_agent_id=req.agent.id;const t=db.updateTask(req.params.id,patch,req.agent.id);if(!t)return res.status(404).json({error:'Tarefa não encontrada'});res.json(t);});
app.get('/api/calendar', (req,res)=>{if(req.query.contactId&&!canAccessOperationalContact(req.agent,req.query.contactId))return res.status(403).json({error:'Sem permissão para acessar agenda deste contato.'});const agentId=req.agent.canViewAllCalendar?(req.query.agentId||undefined):req.agent.id;res.json(filterRowsByContactAccess(req.agent,db.listCalendarEvents({agentId,contactId:req.query.contactId,from:req.query.from,to:req.query.to})));});
app.post('/api/calendar', requireCapability('canManageCalendar'), (req,res)=>{if(!req.body.start_at)return res.status(400).json({error:'Informe data e horário'});const body={...req.body};if(body.contact_id&&!canAccessOperationalContact(req.agent,body.contact_id))return res.status(403).json({error:'Sem permissão para vincular compromisso a este contato.'});if(!req.agent.canViewAllCalendar)body.assigned_agent_id=req.agent.id;if(!validAssignableAgent(body.assigned_agent_id))return res.status(400).json({error:'Atendente responsável inválido ou inativo.'});res.json(db.createCalendarEvent(body,req.agent.id));});
app.put('/api/calendar/:id', requireCapability('canManageCalendar'), (req,res)=>{const own=db.listCalendarEvents({agentId:req.agent.id}).find(e=>e.id===Number(req.params.id));if(!req.agent.canViewAllCalendar&&!own)return res.status(403).json({error:'Sem permissão para alterar este compromisso.'});const current=(req.agent.canViewAllCalendar?db.listCalendarEvents({}):db.listCalendarEvents({agentId:req.agent.id})).find(e=>e.id===Number(req.params.id));if(current?.contact_id&&!canAccessOperationalContact(req.agent,current.contact_id))return res.status(403).json({error:'Sem permissão para alterar compromisso vinculado a outro contato.'});if(req.body.contact_id&&!canAccessOperationalContact(req.agent,req.body.contact_id))return res.status(403).json({error:'Sem permissão para vincular compromisso a este contato.'});const patch={...req.body};if(!req.agent.canViewAllCalendar)patch.assigned_agent_id=req.agent.id;const e=db.updateCalendarEvent(req.params.id,patch,req.agent.id);if(!e)return res.status(404).json({error:'Compromisso não encontrado'});res.json(e);});
app.get('/api/quick-replies', (_req,res)=>res.json(db.listQuickReplies()));
app.post('/api/quick-replies/cleanup-media',requireManager,(_req,res)=>res.json({ok:true,...cleanupOrphanQuickReplyMedia()}));
app.post('/api/quick-replies/audit-learning',requireCapability('canManageQuickReplies'),(req,res)=>{
  const now=Date.now();let pending=0,archived=0,protectedCount=0;
  for(const q of db.listQuickReplies()){
    const historical=['bootstrap_history','bootstrap_history_adapted'].includes(String(q.source||''));
    if(q.human_locked||q.source==='manual_override'){protectedCount++;continue;}
    const expired=q.expires_at&&new Date(q.expires_at).getTime()<now;
    if(expired){const updated=db.updateQuickReply(q.id,{review_status:'archived',enabled:false,auto_use:false});if(updated){syncQuickReplyFlow(updated);archived++;}continue;}
    if(historical){const updated=db.updateQuickReply(q.id,{review_status:'pending',enabled:true,auto_use:false});if(updated){syncQuickReplyFlow(updated);pending++;}}
  }
  ops.audit('quick_reply_learning_audited',{agentId:req.agent.id,resource:'quick_reply',details:{pending,archived,protected:protectedCount}});
  res.json({ok:true,pending,archived,protected:protectedCount,total:db.listQuickReplies().length});
});
function quickReplyMediaPath(file){const safe=path.basename(String(file||''));return safe?path.join(dataDir,'media',safe):'';}
function removeQuickReplyMedia(file){if(!file)return;try{const target=quickReplyMediaPath(file);if(target&&fs.existsSync(target))fs.unlinkSync(target);}catch(_){} }
function cleanupOrphanQuickReplyMedia(){
  const mediaDir=path.join(dataDir,'media'); if(!fs.existsSync(mediaDir))return {removed:0,kept:0,bytes:0};
  const used=new Set(db.listQuickReplies().map(q=>path.basename(String(q.file||''))).filter(Boolean)); let removed=0,kept=0,bytes=0;
  for(const name of fs.readdirSync(mediaDir)){
    if(!/^qr-/i.test(name)){kept++;continue;} if(used.has(name)){kept++;continue;}
    try{const target=path.join(mediaDir,name);const stat=fs.statSync(target);fs.unlinkSync(target);removed++;bytes+=Number(stat.size||0);}catch(_){kept++;}
  }
  if(removed)ops.audit('quick_reply_orphan_media_cleaned',{resource:'media',details:{removed,bytes}}); return {removed,kept,bytes};
}
function saveQuickReplyMedia(payload={}){
  if(!payload.fileData)return payload;
  const raw=String(payload.fileData).replace(/^data:[^;]+;base64,/, '');
  if(Math.ceil(raw.length*3/4)>15*1024*1024) throw new Error('Arquivo acima do limite de 15 MB.');
  const mediaDir=path.join(dataDir,'media'); if(!fs.existsSync(mediaDir))fs.mkdirSync(mediaDir,{recursive:true});
  const ext=String(payload.fileName||'arquivo.bin').split('.').pop().replace(/[^a-zA-Z0-9]/g,'').slice(0,8)||'bin';
  const safe=`qr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir,safe),Buffer.from(raw,'base64')); payload.file=safe; delete payload.fileData; return payload;
}
function syncQuickReplyFlow(q){
  const key=`quick_reply_${q.id}`,flows=loadFlows();
  if(q.review_status!=='approved' || !q.auto_use || q.enabled===false){ if(flows[key]){delete flows[key];saveFlows(flows);} return; }
  const keywords=(Array.isArray(q.triggers)?q.triggers:[]).map(String).map(x=>x.trim()).filter(Boolean);
  if(!keywords.length){ if(flows[key]){delete flows[key];saveFlows(flows);} return; }
  flows[key]={id:key,label:`Resposta editável · ${q.title}`,description:'Resposta controlada manualmente na biblioteca da aba Respostas.',enabled:q.enabled!==false,triggerType:'keywords',keywords,matchMode:q.match_mode||'smart',smartThreshold:Number(q.smart_threshold||.76),caseSensitive:false,execution:'fixed',priority:Number(q.priority||35),cooldownHours:Number(q.cooldown_hours||0),validFrom:String(q.valid_from||''),expiresAt:String(q.expires_at||''),conditions:{stages:[],departments:[],businessHours:'any',aiModes:[],firstContactOnly:false},actions:{setStatus:'',routeDepartment:'',nextAction:'',addTags:[],pauseAI:false,humanReview:false},responses:[{id:`reply_${q.id}`,enabled:true,type:q.type||'text',text:q.text||'',file:q.file||'',mimetype:q.mimetype||'',ptt:q.ptt!==false,delayMs:0,delayMinMs:Number(q.delay_min_ms||0),delayMaxMs:Number(q.delay_max_ms||0)}],source:'response_library',responseLibraryId:q.id,autoGenerated:false,allowFixedSend:true};
  saveFlows(flows);
}
app.post('/api/quick-replies', requireCapability('canManageQuickReplies'), (req,res)=>{
  let uploadedFile='';
  try{
    const payload=saveQuickReplyMedia({...req.body}); uploadedFile=req.body.fileData?String(payload.file||''):''; if(!payload.review_status)payload.review_status='approved'; if(payload.review_status==='approved')payload.human_locked=true;
    payload.shortcut=String(payload.shortcut||'').replace(/^#/,'').trim().toLowerCase();
    payload.type=['text','audio','image','video','document'].includes(payload.type)?payload.type:'text';
    if(!payload.shortcut || !/^[a-z0-9_-]{2,32}$/i.test(payload.shortcut)) return res.status(400).json({error:'Atalho inválido. Use 2 a 32 letras, números, _ ou -.'});
    if(payload.type==='text'&&!String(payload.text||'').trim()) return res.status(400).json({error:'Informe o texto da resposta rápida.'});
    if(payload.type!=='text'&&!payload.file) return res.status(400).json({error:'Envie um arquivo para respostas de mídia.'});
    if(payload.auto_use && !(Array.isArray(payload.triggers)?payload.triggers:String(payload.triggers||'').split(',')).some(x=>String(x).trim())) return res.status(400).json({error:'Informe ao menos um gatilho para uso automático.'});
    if(db.listQuickReplies().some(q=>q.shortcut===payload.shortcut)) return res.status(409).json({error:'Já existe uma resposta rápida com este atalho.'});
    const q=db.createQuickReply(payload); uploadedFile=''; syncQuickReplyFlow(q); res.json(q);
  }catch(err){if(uploadedFile)removeQuickReplyMedia(uploadedFile);res.status(400).json({error:err.message});}
});
app.put('/api/quick-replies/:id',requireCapability('canManageQuickReplies'),(req,res)=>{
  let uploadedFile='';
  try{
    const existing=db.listQuickReplies().find(x=>x.id===Number(req.params.id)); if(!existing)return res.status(404).json({error:'Resposta rápida não encontrada'});
    const hadUploadedFile=Boolean(req.body.fileData);
    const patch=saveQuickReplyMedia({...req.body}); uploadedFile=hadUploadedFile?String(patch.file||''):'';
    const removeRequested=Boolean(patch.removeFile); delete patch.removeFile;
    if(removeRequested){patch.file='';patch.mimetype='';}
    const requestedType=patch.type||existing.type;
    if(requestedType!=='text' && requestedType!==existing.type && existing.file && !hadUploadedFile && !removeRequested){
      if(patch.file)removeQuickReplyMedia(patch.file);
      return res.status(400).json({error:'Ao trocar o tipo de mídia, envie um novo arquivo compatível.'});
    }
    if(requestedType==='text' && existing.file && !hadUploadedFile){patch.file='';patch.mimetype='';}
    if(patch.shortcut!==undefined){patch.shortcut=String(patch.shortcut||'').replace(/^#/,'').trim().toLowerCase();if(!/^[a-z0-9_-]{2,32}$/i.test(patch.shortcut))return res.status(400).json({error:'Atalho inválido.'});if(db.listQuickReplies().some(q=>q.id!==existing.id&&q.shortcut===patch.shortcut))return res.status(409).json({error:'Já existe outra resposta com este atalho.'});}
    const nextType=patch.type||existing.type,nextText=patch.text!==undefined?patch.text:existing.text,nextFile=patch.file!==undefined?patch.file:existing.file;
    if(nextType==='text'&&!String(nextText||'').trim())return res.status(400).json({error:'Informe o texto da resposta.'});
    if(nextType!=='text'&&!nextFile)return res.status(400).json({error:'Envie um arquivo para respostas de mídia.'});
    const nextAuto=patch.auto_use!==undefined?Boolean(patch.auto_use):Boolean(existing.auto_use),nextTriggers=patch.triggers!==undefined?patch.triggers:existing.triggers;
    if(nextAuto && !(Array.isArray(nextTriggers)?nextTriggers:String(nextTriggers||'').split(',')).some(x=>String(x).trim()))return res.status(400).json({error:'Informe ao menos um gatilho para uso automático.'});
    // Qualquer edição humana em aprendizado histórico vira override protegido. Aprovar é explícito.
    if(existing.source==='bootstrap_history'){patch.source='manual_override';patch.human_locked=true;}
    if(patch.review_status==='approved')patch.human_locked=true;
    if(patch.review_status==='archived'){patch.auto_use=false;patch.enabled=false;}
    const q=db.updateQuickReply(req.params.id,patch);
    if(existing.file && existing.file!==q.file)removeQuickReplyMedia(existing.file);
    uploadedFile='';syncQuickReplyFlow(q);ops.audit('quick_reply_updated',{agentId:req.agent.id,resource:'quick_reply',resourceId:q.id,details:{type:q.type,auto_use:q.auto_use,triggers:(q.triggers||[]).length}});res.json(q);
  }catch(err){if(uploadedFile)removeQuickReplyMedia(uploadedFile);res.status(400).json({error:err.message});}
});
app.delete('/api/quick-replies/:id',requireCapability('canManageQuickReplies'),(req,res)=>{const id=Number(req.params.id),existing=db.listQuickReplies().find(x=>x.id===id),flows=loadFlows(),key=`quick_reply_${id}`;if(flows[key]){delete flows[key];saveFlows(flows);}const ok=db.deleteQuickReply(id);if(ok&&existing?.file)removeQuickReplyMedia(existing.file);res.json({ok});});
app.post('/api/contacts/:id/send-quick-reply', async (req,res)=>{
  const c=db.getContactById(req.params.id); if(!c)return res.status(404).json({error:'Contato não encontrado'});
  if(blockIfOptedOut(res,c))return;
  const q=db.listQuickReplies().find(x=>x.id===Number(req.body.quickReplyId)); if(!q)return res.status(404).json({error:'Resposta rápida não encontrada'}); if(q.review_status!=='approved')return res.status(409).json({error:'Esta resposta ainda não foi aprovada. Revise e marque como Aprovada antes de enviar.'});
  try{
    const response={...q}; if(q.file)response.path=path.join(dataDir,'media',q.file);
    await sendManualResponse(c.phone,response); db.logMessage(c.id,'out',q.type,q.text||q.file,`quick:${q.shortcut}`,req.agent.id);db.touchOutbound(c.id);db.setAssignedAgent(c.id,req.agent.id,{reason:'resposta_rapida',byAgentId:req.agent.id});db.setAIPaused(c.id,true,{reason:'resposta_rapida',agentId:req.agent.id});res.json({ok:true});
  }catch(err){ ops.enqueueRetry({kind:'quick_reply',uniqueKey:`quick:${c.id}:${q.id}:${Date.now()}`,payload:{contactId:c.id,quickReplyId:q.id,agentId:req.agent.id}}); ops.audit('quick_reply_queued_retry',{agentId:req.agent.id,contactId:c.id,resource:'quick_reply',resourceId:q.id,details:{error:err.message}}); res.status(202).json({ok:false,queuedForRetry:true,error:err.message});}
});
app.get('/api/export/contacts.csv', requireCapability('canExportCRM'), (req,res)=>{
  const allowedContacts=req.agent.canViewAllCRM?undefined:db.listOperationalContactsForAgent(req.agent.id); const rows=db.exportRows(allowedContacts); const cols=rows.length?Object.keys(rows[0]):['id']; const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`; const csv='\ufeff'+[cols.join(';'),...rows.map(r=>cols.map(c=>esc(r[c])).join(';'))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="chatbot-alone-crm.csv"');res.send(csv);
});

function localCommercialFallback(contacts=[],messages=[],dashboard={}){
  const list=Array.isArray(contacts)?contacts:[];
  const statusCounts={}; for(const c of list)statusCounts[String(c.status||'sem_status')]=(statusCounts[String(c.status||'sem_status')]||0)+1;
  const noNext=list.filter(c=>!String(c.next_best_action||c.next_action||'').trim()).length;
  const noInterest=list.filter(c=>!String(c.interest||'').trim()).length;
  const human=list.filter(c=>c.requires_human||c.ai_paused).length;
  const inbound=(messages||[]).filter(m=>m.direction==='in').length, outbound=(messages||[]).filter(m=>m.direction==='out').length;
  const topStatuses=Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}: ${v}`);
  const total=list.length;
  return {
    summary:`Diagnóstico local gerado sem Gemini por limite temporário de quota. CRM com ${total} contatos na amostra e ${Number(dashboard?.totalMessages||messages?.length||0)} mensagens registradas.`,
    funnel_findings:[topStatuses.length?`Distribuição principal de status: ${topStatuses.join(', ')}.`:'Ainda não há status suficientes para resumir o funil.',`${noNext} contatos estão sem próxima ação definida.`,`${noInterest} contatos estão sem interesse registrado.`],
    common_objections:['Não foi possível inferir objeções com segurança sem a análise semântica do Gemini.'],
    opportunities:[noNext?`Priorizar os ${noNext} contatos sem próxima ação.`:'Próximas ações estão preenchidas na amostra.',human?`Revisar ${human} contatos pausados ou encaminhados para humano.`:'Não há contatos pausados/encaminhados na amostra.'],
    risks:[inbound>outbound?`Na amostra recente há mais mensagens recebidas (${inbound}) do que enviadas (${outbound}); vale revisar conversas pendentes.`:'A amostra não mostra desequilíbrio evidente entre entradas e saídas.','A análise semântica completa está temporariamente indisponível por quota do Gemini.'],
    recommended_actions:['Aguardar a liberação automática da quota e rodar a análise semântica novamente.','Revisar contatos sem próxima ação e conversas pendentes enquanto isso.'],
    unanswered_patterns:['Indisponível no fallback local; exige análise semântica das conversas.'],
    source:'local_fallback', degraded:true
  };
}

app.post('/api/intelligence/commercial', requireManager, async (_req,res)=>{
  const st=settings.loadSettings(); if(!st.geminiApiKey)return res.status(400).json({error:'Gemini não configurado'});
  try{
    const contacts=db.listContacts().slice(0,1000);
    const messages=db.getRecentMessagesForAnalysis(500);
    const result=await gemini.analyzeCommercialIntelligence({settings:st,contacts,messages,dashboard:db.commercialDashboard()});
    if(!result||!Object.keys(result).length)return res.status(502).json({error:'Gemini respondeu sem um diagnóstico comercial estruturado.'});
    res.json(result);
  }catch(err){
    console.error('[commercial-intelligence]',err?.stack||err);
    if(Number(err?.status)===429 || err?.quota || /RESOURCE_EXHAUSTED|quota exceeded|current quota/i.test(String(err?.message||''))){
      const contacts=db.listContacts().slice(0,1000),messages=db.getRecentMessagesForAnalysis(500);
      const fallback=localCommercialFallback(contacts,messages,db.commercialDashboard());
      fallback.warning=err?.userMessage||'Limite temporário do Gemini atingido. Foi exibido um diagnóstico local enquanto a quota não libera.';
      fallback.retry_at=err?.retryAt||null;
      return res.json(fallback);
    }
    res.status(500).json({error:`Falha ao analisar operação: ${String(err.message||err).slice(0,800)}`});
  }
});

app.get('/api/contacts', (req,res) => {
  const {status,agentId}=req.query;
  if (agentId) {
    const requested = Number(agentId);
    if (requested !== req.agent.id && !req.agent.canViewAllCRM) return res.status(403).json({error:'Sem permissão para visualizar este CRM.'});
    return res.json(requested===req.agent.id&&!req.agent.canViewAllCRM?db.listOperationalContactsForAgent(requested,status||null):db.listContactsByAgent(requested, status||null));
  }
  if (!req.agent.canViewAllCRM) return res.json(db.listOperationalContactsForAgent(req.agent.id, status||null));
  res.json(db.listContacts(status||null));
});
app.get('/api/contacts/:id', (req,res) => {
  const c=db.getContactById(req.params.id); if(!c) return res.status(404).json({error:'Contato não encontrado'}); res.json(c);
});
app.put('/api/contacts/:id', (req,res) => {
  const c=db.updateContact(req.params.id,req.body,{agentId:req.agent.id}); if(!c) return res.status(404).json({error:'Contato não encontrado'}); res.json(c);
});
app.get('/api/contacts/:id/messages', (req,res) => {const all=db.getContactMessages(req.params.id, req.query.history !== '0');const limit=Math.max(20,Math.min(500,Number(req.query.limit||120)));res.json(all.slice(-limit));});
app.get('/api/contacts/:id/activities', (req,res) => res.json(db.getActivities(req.params.id)));
app.post('/api/contacts/:id/read', (req,res) => { db.markRead(req.params.id); res.json({ok:true}); });
app.post('/api/contacts/:id/assign', (req,res) => {
  const c=db.setAssignedAgent(req.params.id, req.body.agentId, { reason:req.body.reason||'manual', byAgentId:req.agent.id });
  if(!c) return res.status(404).json({error:'Contato não encontrado'}); res.json(c);
});
app.post('/api/contacts/:id/status', (req,res) => {
  if(!db.setStatus(req.params.id,req.body.status,{reason:'manual',agentId:req.agent.id})) return res.status(400).json({error:'Status inválido'});
  res.json({ok:true});
});
app.post('/api/contacts/:id/journey', (req,res) => {
  if(!db.setJourneyStage(req.params.id,req.body.stage,{reason:'manual',agentId:req.agent.id})) return res.status(400).json({error:'Etapa de jornada inválida'});
  res.json({ok:true,contact:db.getContactById(req.params.id)});
});

app.post('/api/contacts/:id/undo', (req,res)=>{const r=db.undoLastContactAction(req.params.id,req.agent.id);if(!r.ok)return res.status(400).json({error:r.error});res.json(r);});
app.post('/api/contacts/:id/ai-feedback', (req,res)=>{const c=db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});db.recordAIFeedback(c.id,Number(req.body.score||0),req.body.note||'',req.agent.id);const hist=db.getRecentConversation(c.id,20);const last=[...hist].reverse().find(m=>m.direction==='in'&&m.body);ops.recordFeedbackExample({input:last?.body||'',suggestion:req.body.suggestion||c.ai_suggested_reply||'',correction:req.body.correction||'',score:Number(req.body.score||0),contactId:c.id,agentId:req.agent.id});res.json({ok:true,contact:db.getContactById(c.id)});});

app.get('/api/contacts/:id/suggest-stream', async (req,res)=>{const st=settings.loadSettings(),c=db.getContactById(req.params.id);if(!c)return res.status(404).end('Contato não encontrado');if(!st.geminiApiKey)return res.status(400).end('Gemini não configurado');const hist=db.getRecentConversation(c.id,Number(st.aiContextMessages||30));const last=[...hist].reverse().find(m=>m.direction==='in'&&m.body);if(!last)return res.status(400).end('Sem mensagem recente');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','no-cache');res.setHeader('X-Accel-Buffering','no');let full='';const prior=hist.filter(m=>m.id!==last.id);try{for await(const chunk of gemini.streamGenerateReply({settings:st,conversationHistory:prior,incomingText:last.body,contact:c,intentContext:(()=>{const fm=matchFlow(loadFlows(),String(last.body||''),false,{contact:c,settings:st,withinBusinessHours:isWithinBusinessHours(new Date(),st)});return fm?.flow?{label:fm.flow.label,actions:fm.flow.actions||{},ai_context:fm.flow.ai_context||null}:null;})()})){full+=chunk;res.write(chunk);}if(!full)throw new Error('Gemini não retornou conteúdo');db.setAISuggestion(c.id,full,'geracao_stream');res.end();}catch(err){ops.audit('ai_stream_failed',{contactId:c.id,resource:'gemini',details:{error:String(err.message||err).slice(0,500),model:st.geminiModel}});try{const fallback=await gemini.generateReply({settings:st,conversationHistory:prior,incomingText:last.body,contact:c});if(fallback){full=fallback;res.write(fallback);db.setAISuggestion(c.id,full,'geracao_fallback');return res.end();}}catch(fallbackErr){ops.audit('ai_stream_fallback_failed',{contactId:c.id,resource:'gemini',details:{error:String(fallbackErr.message||fallbackErr).slice(0,500)}});}res.write(`
[Erro ao gerar sugestão: ${String(err.message||err).slice(0,500)}]`);res.end();}});
app.post('/api/contacts/:id/suggest-reply', async (req,res)=>{const st=settings.loadSettings(),c=db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});if(!st.geminiApiKey)return res.status(400).json({error:'Gemini não configurado'});try{const hist=db.getRecentConversation(c.id,Number(st.aiContextMessages||30));const last=[...hist].reverse().find(m=>m.direction==='in'&&m.body);if(!last)return res.status(400).json({error:'Não há mensagem recente do cliente'});const prior=hist.filter(m=>m.id!==last.id);const fm=matchFlow(loadFlows(),String(last.body||''),false,{contact:c,settings:st,withinBusinessHours:isWithinBusinessHours(new Date(),st)});const intentContext=fm?.flow?{label:fm.flow.label,actions:fm.flow.actions||{},ai_context:fm.flow.ai_context||null}:null;const reply=String(await gemini.generateReply({settings:st,conversationHistory:prior,incomingText:last.body,contact:c,intentContext})||'').trim();if(!reply)return res.status(502).json({error:'O Gemini concluiu a chamada, mas não retornou uma sugestão de texto. Tente novamente.'});db.setAISuggestion(c.id,reply,'geracao_manual');res.json({ok:true,reply,contact:db.getContactById(c.id)});}catch(err){ops.audit('ai_suggestion_failed',{contactId:c.id,resource:'gemini',details:{error:String(err.message||err).slice(0,500)}});res.status(500).json({error:`Falha ao gerar sugestão: ${String(err.message||err).slice(0,700)}`});}});
app.post('/api/contacts/:id/send-suggestion', async (req,res)=>{const c=db.getContactById(req.params.id);if(!c)return res.status(404).json({error:'Contato não encontrado'});if(blockIfOptedOut(res,c))return;const text=String(req.body.text||c.ai_suggested_reply||'').trim();if(!text)return res.status(400).json({error:'Sem sugestão para enviar'});try{await sendManualMessage(c.phone,text);db.logMessage(c.id,'out','text',text,'ia_assistida_aprovada',req.agent.id);db.touchOutbound(c.id);db.setAISuggestion(c.id,'','aprovada_por_humano');db.recordAIFeedback(c.id,1,'Sugestão aprovada e enviada',req.agent.id);onboarding.scheduleContinuousLearning({delayMs:30000});res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

app.post('/api/contacts/:id/consent', (req,res) => {
  if(!db.setConsent(req.params.id,req.body.status,req.body.source||'manual',req.agent.id)) return res.status(400).json({error:'Consentimento inválido'});
  res.json({ok:true,contact:db.getContactById(req.params.id)});
});
app.get('/api/contacts/:id/consent-ledger',(req,res)=>{const ledger=db.getConsentLedger(req.params.id);if(!ledger)return res.status(404).json({error:'Contato não encontrado'});res.json(ledger);});
app.put('/api/contacts/:id/consent-ledger',(req,res)=>{const category=String(req.body.category||'');const status=String(req.body.status||'');if(!db.setConsentCategory(req.params.id,category,status,req.body.source||'painel',req.agent.id))return res.status(400).json({error:'Categoria ou status inválido'});res.json(db.getConsentLedger(req.params.id));});

// Prospecção sequencial. A lista pode ser importada em vários lotes; a fila persistida não tem limite fixo.
app.get('/api/prospecting/campaigns', requireCapability('canManageProspecting'), (_req,res)=>res.json(db.listProspectCampaigns()));
app.get('/api/prospecting/status', requireCapability('canManageProspecting'), (_req,res)=>res.json(getProspectingDiagnostics()));
app.post('/api/prospecting/campaigns', requireCapability('canManageProspecting'), (req,res)=>{
  const campaign=db.createProspectCampaign(req.body,req.agent.id); res.json(campaign);
});
app.put('/api/prospecting/campaigns/:id', requireCapability('canManageProspecting'), (req,res)=>{
  const c=db.updateProspectCampaign(req.params.id,req.body); if(!c)return res.status(404).json({error:'Campanha não encontrada'}); res.json(c);
});
app.post('/api/prospecting/campaigns/:id/start', requireCapability('canManageProspecting'), async (req,res)=>{
  const c=db.getProspectCampaign(req.params.id); if(!c)return res.status(404).json({error:'Campanha não encontrada'});
  if(!c.confirmed_permission)return res.status(400).json({error:'Confirme que esta lista pode ser contatada antes de iniciar.'});
  if(!c.initial_message)return res.status(400).json({error:'Defina a mensagem inicial da campanha.'});
  const metrics=db.getProspectCampaignMetrics(c.id);
  if(!metrics.total)return res.status(400).json({error:'A campanha está sem contatos. Adicione ou importe pelo menos um número antes de iniciar.'});
  // Confirmar a permissão no cartão vale para a lista desta campanha. Não reativa opt-outs explícitos.
  const consentSync=db.syncCampaignConsentFromPermission(c.id,req.agent.id);
  // Clicar em Iniciar é uma intenção explícita de operar campanhas. Garante que o processador global esteja ligado.
  if(!settings.loadSettings().prospectingEnabled) settings.saveSettings({prospectingEnabled:true});
  const started=db.setProspectCampaignStatus(c.id,'running');
  let dispatch={ok:false,reason:'queued'};
  try{ dispatch=await processProspectingCampaign(c.id); }catch(err){ dispatch={ok:false,reason:'processor_error',error:err.message}; }
  res.json({...started,metrics:db.getProspectCampaignMetrics(c.id),consentSync,dispatch});
});
app.post('/api/prospecting/campaigns/:id/pause', requireCapability('canManageProspecting'), (req,res)=>{
  const c=db.setProspectCampaignStatus(req.params.id,'paused'); if(!c)return res.status(404).json({error:'Campanha não encontrada'}); res.json(c);
});
app.post('/api/prospecting/campaigns/:id/import', requireCapability('canManageProspecting'), (req,res)=>{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  if(!rows.length)return res.status(400).json({error:'Nenhum número recebido.'});
  if(rows.length>5000)return res.status(400).json({error:'Envie a lista em lotes de até 5.000 contatos.'});
  try {
    const result=db.addProspectsToCampaign(req.params.id,rows,{confirmedPermission:Boolean(req.body.confirmedPermission),source:req.body.source||'lista_importada',agentId:req.agent.id});
    res.json(result);
  } catch(err){res.status(400).json({error:err.message});}
});
app.get('/api/prospecting/campaigns/:id/queue', requireCapability('canManageProspecting'), (req,res)=>res.json(db.listProspectQueue(req.params.id,req.query.limit||500)));
app.post('/api/prospecting/campaigns/:id/requeue-failures', requireCapability('canManageProspecting'), (req,res)=>{const c=db.getProspectCampaign(req.params.id);if(!c)return res.status(404).json({error:'Campanha não encontrada'});res.json(db.requeueCampaignFailures(c.id));});
app.post('/api/prospecting/campaigns/:id/process-now', requireCapability('canManageProspecting'), async (req,res)=>{
  const c=db.getProspectCampaign(req.params.id);if(!c)return res.status(404).json({error:'Campanha não encontrada'});
  try{res.json(await processProspectingCampaign(c.id));}catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/prospecting/process-now', requireCapability('canManageProspecting'), async (_req,res)=>{
  try{res.json(await processProspectingQueue());}catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/contacts/:id/take-over', (req,res) => {
  db.setAssignedAgent(req.params.id, req.agent.id, {reason:'atendente_assumiu',byAgentId:req.agent.id});
  db.setAIPaused(req.params.id,true,{reason:'atendente_assumiu',agentId:req.agent.id}); res.json({ok:true});
});
app.post('/api/contacts/:id/resume-ai', (req,res) => { const c=db.getContactById(req.params.id); if(!c)return res.status(404).json({error:'Contato não encontrado'}); if(c.requires_human)return res.status(409).json({error:'Resolva o alerta de intervenção humana antes de devolver a conversa para a IA.'}); db.setAIPaused(req.params.id,false,{reason:'devolvido_para_ia',agentId:req.agent.id}); res.json({ok:true}); });
app.post('/api/contacts/:id/send', async (req,res) => {
  const {text}=req.body; const agentId=req.agent.id; const c=db.getContactById(req.params.id);
  if(!c) return res.status(404).json({error:'Contato não encontrado'}); if(blockIfOptedOut(res,c))return; if(!text?.trim()) return res.status(400).json({error:'Mensagem vazia'});
  try {
    await sendManualMessage(c.phone,text.trim()); db.logMessage(c.id,'out','text',text.trim(),'manual',agentId); db.touchOutbound(c.id);
    const recent=db.getRecentConversation(c.id,12); const lastInbound=[...recent].reverse().find(m=>m.direction==='in'&&String(m.body||'').trim());
    if(lastInbound) ops.recordFeedbackExample({input:lastInbound.body,suggestion:text.trim(),correction:text.trim(),score:1,contactId:c.id,agentId});
    onboarding.scheduleContinuousLearning({delayMs:30000});
    db.setAssignedAgent(c.id,agentId,{reason:'resposta_manual',byAgentId:agentId}); db.setAIPaused(c.id,true,{reason:'resposta_manual',agentId});
    res.json({ok:true});
  } catch(err){ ops.enqueueRetry({kind:'text_message',uniqueKey:`manual:${c.id}:${Date.now()}`,payload:{contactId:c.id,text:text.trim(),source:'manual_retry',agentId}}); ops.audit('manual_send_queued_retry',{agentId,contactId:c.id,resource:'message',details:{error:err.message}}); res.status(202).json({ok:false,queuedForRetry:true,error:err.message});}
});

app.post('/api/contacts/:id/send-media', async (req,res) => {
  const c=db.getContactById(req.params.id); if(!c)return res.status(404).json({error:'Contato não encontrado'});
  if(blockIfOptedOut(res,c))return;
  try{
    const type=String(req.body.type||'').toLowerCase();
    if(!['audio','image','video','document'].includes(type))return res.status(400).json({error:'Tipo de mídia inválido'});
    const raw=String(req.body.fileData||'').replace(/^data:[^;]+;base64,/, ''); if(!raw)return res.status(400).json({error:'Arquivo não enviado'});
    const buf=Buffer.from(raw,'base64'); if(!buf.length)return res.status(400).json({error:'Arquivo vazio'}); if(buf.length>20*1024*1024)return res.status(400).json({error:'Arquivo acima de 20 MB'});
    const mimetype=String(req.body.mimetype||'application/octet-stream'); const fileName=String(req.body.fileName||`arquivo-${Date.now()}`).replace(/[\/:*?"<>|]/g,'_').slice(0,160);
    const caption=String(req.body.caption||'').slice(0,4000); const ptt=Boolean(req.body.ptt);
    await sendManualBuffer(c.phone,{type,buffer:buf,mimetype,fileName,caption,ptt});
    const mediaDir=path.join(dataDir,'media'); fs.mkdirSync(mediaDir,{recursive:true});
    const ext=(fileName.split('.').pop()||'bin').replace(/[^a-zA-Z0-9]/g,'').slice(0,8)||'bin'; const safe=`sent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`; fs.writeFileSync(path.join(mediaDir,safe),buf);
    db.logMessage(c.id,'out',type,caption||`[${type} enviado: ${fileName}]`,'manual_media',req.agent.id); db.touchOutbound(c.id);
    db.setAssignedAgent(c.id,req.agent.id,{reason:'midia_manual',byAgentId:req.agent.id}); db.setAIPaused(c.id,true,{reason:'midia_manual',agentId:req.agent.id});
    ops.audit('manual_media_sent',{agentId:req.agent.id,contactId:c.id,resource:'message',details:{type,fileName,mimetype,bytes:buf.length,ptt}});
    res.json({ok:true,type,file:safe});
  }catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/contacts/:id/analyze', async (req,res) => {
  const s=settings.loadSettings(); const c=db.getContactById(req.params.id);
  if(!c) return res.status(404).json({error:'Contato não encontrado'}); if(!s.geminiApiKey) return res.status(400).json({error:'Gemini não configurado'});
  try {
    const profile=await gemini.analyzeCustomerContext({settings:s,conversationHistory:db.getRecentConversation(c.id,50),contact:c});
    db.applyAIProfile(c.id,profile);
    if(s.autoRoutingEnabled && profile.department) db.assignAgentAutomatically(c.id,agents.activeAgents(),profile.department,'analise_manual_ia');
    res.json({ok:true,contact:db.getContactById(c.id),profile});
  } catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/flows', (_req,res)=>res.json(loadFlows()));
app.post('/api/flows', requireManager, (req,res)=>{try{const saved=saveFlows(req.body);const cleared=db.clearAllAISuggestions('flows_changed');ops.audit('flows_updated',{agentId:req.agent.id,resource:'settings',details:{clearedSuggestions:cleared,flowCount:Object.keys(saved).length}});res.json({ok:true,flows:saved,clearedSuggestions:cleared});}catch(err){res.status(400).json({error:err.message});}});
app.post('/api/flows/test', requireManager, (req,res)=>{
  const flows=req.body.flows?req.body.flows:loadFlows(); const sample=req.body.sample||{};
  const settingsNow=settings.loadSettings(); const contact={status:sample.status||'novo_lead',department:sample.department||'',...sample.contact};
  const within=sample.businessHours==='outside'?false:sample.businessHours==='inside'?true:undefined;
  const hit=matchFlow(flows,String(sample.text||''),!!sample.isFirstContact,{contact,settings:{...settingsNow,aiMode:sample.aiMode||settingsNow.aiMode},withinBusinessHours:within});
  res.json({matched:!!hit,key:hit?.key||null,label:hit?.flow?.label||null,flow:hit?.flow||null});
});
app.post('/api/flows/media', requireManager, (req,res)=>{
  try{
    const raw=String(req.body.fileData||'').replace(/^data:[^;]+;base64,/, ''); if(!raw)return res.status(400).json({error:'Arquivo não enviado'});
    const buf=Buffer.from(raw,'base64'); if(buf.length>15*1024*1024)return res.status(400).json({error:'Arquivo acima de 15 MB'});
    const mediaDir=path.join(dataDir,'media'); fs.mkdirSync(mediaDir,{recursive:true});
    const ext=String(req.body.fileName||'arquivo.bin').split('.').pop().replace(/[^a-zA-Z0-9]/g,'').slice(0,8)||'bin';
    const safe=`flow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`; fs.writeFileSync(path.join(mediaDir,safe),buf);
    res.json({ok:true,file:safe,mimetype:String(req.body.mimetype||'application/octet-stream')});
  }catch(err){res.status(400).json({error:err.message});}
});
app.post('/api/settings', requireManager, (req,res)=>{
  try{
    const patch={...req.body}; if(Object.prototype.hasOwnProperty.call(patch,'aiEnabled'))patch.aiUserPreferenceSet=true; if(patch.aiMode&&!['observacao','assistido','autonomo'].includes(patch.aiMode))return res.status(400).json({error:'Modo de IA inválido'});
    const updated=settings.saveSettings(patch); const {geminiApiKey,...safe}=updated;
    const behaviorKeys=['businessHours','businessSchedule','businessTimezone','gymName','businessType','businessDescription','aiMode','aiEnabled','autoRoutingEnabled','autoCustomerProfiling','learnedStyleProfile','learnedBusinessProfile'];
    const affectsBehavior=behaviorKeys.some(k=>Object.prototype.hasOwnProperty.call(patch,k));
    const cleared=affectsBehavior?db.clearAllAISuggestions('settings_changed'):0;
    ops.audit('settings_updated',{agentId:req.agent.id,resource:'settings',details:{keys:Object.keys(patch).filter(k=>k!=='geminiApiKey'),revision:updated.settingsRevision,clearedSuggestions:cleared}});
    if (geminiApiKey && getStatus().status === 'conectado' && !updated.aiReady && updated.aiBootstrapAutoStart) {
      setTimeout(()=>onboarding.runBootstrap({force:false}).catch(err=>console.error('Onboarding IA:',err.message)),250);
    }
    res.json({...safe,geminiKeyConfigured:Boolean(geminiApiKey),clearedSuggestions:cleared});
  }catch(err){
    res.status(400).json({error:err.message||'Não foi possível salvar as configurações.'});
  }
});

function chunkMessages(messages, maxChars=22000) {
  const chunks=[]; let current=[], size=0;
  for(const m of messages){
    const len=String(m.body||'').length+100;
    if(current.length && size+len>maxChars){chunks.push(current);current=[];size=0;}
    current.push(m);size+=len;
  }
  if(current.length) chunks.push(current); return chunks;
}

app.post('/api/history-scan/analyze', requireManager, async (_req,res) => {
  const s=settings.loadSettings();
  if(getStatus().status!=='conectado') { onboarding.markWaitingForWhatsApp({preserveReady:true}); return res.status(409).json({error:'Conecte o WhatsApp antes de iniciar a preparação. Sem WhatsApp conectado não existe histórico para analisar.'}); }
  if(!s.geminiApiKey) return res.status(400).json({error:'Configure a chave do Gemini antes de analisar o histórico.'});
  try {
    // Inicia em background para o frontend conseguir acompanhar o progresso em tempo real.
    onboarding.runBootstrap({force:true}).catch(err=>console.error('Preparação IA:',err.message));
    await new Promise(r=>setTimeout(r,25));
    res.status(202).json({ok:true,started:true,...onboarding.status()});
  } catch(err){res.status(500).json({error:err.message});}
});



// v7.2.3 — watchdog da preparação: recupera análise interrompida sem criar loops paralelos.
setInterval(()=>{
  try {
    const st=onboarding.status(); const cfg=settings.loadSettings(); const wa=getStatus();
    const active=['consolidando_empresa','perfilando_clientes','erro','importando_historico'].includes(st.status);
    const stale=st.lastUpdateAt ? (Date.now()-new Date(st.lastUpdateAt).getTime()>25000) : true;
    if(wa.status==='conectado' && cfg.geminiApiKey && !st.ready && !st.running && st.control==='running' && active && stale && db.getMetrics().totalMessages>0) {
      console.log('🛟 Watchdog: retomando preparação da IA interrompida...');
      onboarding.runBootstrap({force:false}).catch(err=>console.error('Watchdog onboarding:',err.message));
    }
  } catch(err) { console.warn('Watchdog onboarding ignorado:',err.message); }
},15000);

app.listen(PORT,HOST,()=>{
  console.log(`\n🧠 Alone.AI / ${settings.loadSettings().gymName}: http://localhost:${PORT}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost') console.log(`   Rede habilitada em ${HOST}:${PORT}`);
  console.log(isPackaged?'   (.exe)\n':'   (modo desenvolvimento)\n');
});
function hasSavedWhatsAppSession(){
  try { return fs.existsSync(whatsappAuthDir) && fs.readdirSync(whatsappAuthDir).some(name=>name !== '.gitkeep'); }
  catch (_) { return false; }
}
const whatsappBootState=readWhatsAppConnectionState();
if(whatsappBootState.userRequested === true && hasSavedWhatsAppSession()) startWhatsApp().catch((err)=>console.error('⚠️ Erro ao reconectar WhatsApp:',err.message));
else {
  // Sem autorização explícita desta instalação, nunca tentar reconectar só porque sobrou uma pasta auth.
  onboarding.markWaitingForWhatsApp({preserveReady:true});
  console.log('📱 WhatsApp desconectado. Use Configurações > Conexão para gerar o QR.');
}
setTimeout(()=>{try{cleanupOrphanQuickReplyMedia();}catch(err){console.warn('Limpeza de mídia órfã:',err.message);}},1200);
startScheduler();
setTimeout(()=>onboarding.reconcileLearnedState().catch(err=>console.warn('Reconciliação pós-inicialização:',err.message)),800);
