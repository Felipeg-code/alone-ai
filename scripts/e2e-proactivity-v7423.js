const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-e2e-proactivity-'));
process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');
const settings=require('../codigo-fonte-dev/server/settings');
const ops=require('../codigo-fonte-dev/server/ops');

// Force business hours open and deterministic proactivity.
const allDay={0:[[0,1440]],1:[[0,1440]],2:[[0,1440]],3:[[0,1440]],4:[[0,1440]],5:[[0,1440]],6:[[0,1440]]};
const st=settings.saveSettings({businessSchedule:allDay,proactiveEnabled:true,accountProtectionMode:'off',outboundAutomationMode:'automatic',proactiveUserPreferenceSet:true,proactiveGlobalMinIntervalSeconds:10,proactiveDailyLimit:80,proactiveScenarios:{
 plans_silence:{enabled:true,label:'Pediu planos e sumiu',silenceHours:0,minScore:35,maxAttempts:2,betweenAttemptsHours:0,messages:['T1 {nome}','T2 {nome}']},
 hot_silence:{enabled:true,label:'Lead quente em silêncio',silenceHours:0,minScore:75,maxAttempts:2,betweenAttemptsHours:0,messages:['H1 {nome}','H2 {nome}']},
 closing_silence:{enabled:true,label:'Fechamento sem resposta',silenceHours:0,minScore:55,maxAttempts:3,betweenAttemptsHours:0,messages:['C1 {nome}','C2 {nome}','C3 {nome}']},
 unanswered_segment:{enabled:true,label:'Aguardando cliente',silenceHours:0,minScore:0,maxAttempts:1,betweenAttemptsHours:0,messages:['U1 {nome}']},
}});

// Stub WhatsApp before loading proactivity module.
const waPath=require.resolve('../codigo-fonte-dev/server/whatsapp');
const sent=[]; let failPhone='';
require.cache[waPath]={id:waPath,filename:waPath,loaded:true,exports:{
  sendManualMessage:async(phone,text)=>{ if(String(phone)===failPhone) throw new Error('simulated send failure'); sent.push({phone:String(phone),text}); return {ok:true}; },
  getStatus:()=>({status:'conectado'}),
  sendManualResponse:async()=>({ok:true})
}};
const proactivity=require('../codigo-fonte-dev/server/proactivity');

function contact(phone,name,patch){const c=db.upsertContact(phone,name,{consentStatus:'opted_in'});db.updateContact(c.id,{status:'interessado',...patch},{activity:false});return db.getContactById(c.id);}
function hist(id,dir,body,hoursAgo,ext){db.importHistoricalMessage(id,dir,'text',body,new Date(Date.now()-hoursAgo*3600000).toISOString(),ext);}

(async()=>{
  // Eligible plan lead.
  const plan=contact('45990000001','Ana Plano',{lead_score:60,interest:'plano mensal',last_intent:'planos e valores'});
  hist(plan.id,'in','Quais os planos e valores?',4,'p-in'); hist(plan.id,'out','Temos três opções. Qual fez mais sentido?',3,'p-out');
  // Hot generic lead.
  const hot=contact('45990000002','Bruno Quente',{lead_score:90,interest:'academia',last_intent:'informações'});
  hist(hot.id,'in','Tenho interesse',4,'h-in'); hist(hot.id,'out','Posso te ajudar a avançar',3,'h-out');
  // Closing lead.
  const closing=contact('45990000003','Carla Fecha',{lead_score:80,journey_stage:'fechamento',last_intent:'pagamento'});
  hist(closing.id,'in','Pode mandar o pix',4,'c-in'); hist(closing.id,'out','Segue o pagamento',3,'c-out');
  // Exclusions.
  const opt=contact('45990000004','Opt Out',{lead_score:90,interest:'plano'});hist(opt.id,'out','planos',3,'o-out');db.setConsent(opt.id,'opted_out');
  const human=contact('45990000005','Humano',{lead_score:90,interest:'plano'});hist(human.id,'out','planos',3,'hu-out');db.setHumanReview(human.id,true,'teste');
  const replied=contact('45990000006','Respondeu',{lead_score:90,interest:'plano'});hist(replied.id,'out','planos',4,'r-out');hist(replied.id,'in','obrigado, já vi',2,'r-in');

  // Segment buttons backend definitions.
  assert(db.segmentContacts('hot').some(x=>x.id===hot.id),'card Gestão: hot deveria incluir Bruno');
  assert(db.segmentContacts('waiting_customer').some(x=>x.id===plan.id),'card Gestão: aguardando cliente deveria incluir Ana');
  assert(db.segmentContacts('abandoned').some(x=>x.id===replied.id),'card Gestão: precisa responder deveria incluir contato com inbound mais recente');
  const inbox=db.getInboxSummaryFromList(db.listContacts());
  assert(inbox.groups.waiting_customer.some(x=>x.id===plan.id),'card Inbox: aguardando cliente deveria incluir Ana');
  assert(inbox.groups.urgent.some(x=>x.id===replied.id),'card Inbox: precisa responder deveria incluir contato inbound');

  // Eligibility excludes unsafe contacts.
  const ids=new Set(db.getProactiveCandidates(settings.loadSettings(),{limit:100}).map(x=>x.id));
  assert(ids.has(plan.id) && ids.has(hot.id) && ids.has(closing.id),'cenários elegíveis ausentes');
  assert(!ids.has(opt.id),'opt-out não pode ser proativo');
  assert(!ids.has(human.id),'handoff humano não pode ser proativo');
  assert(!ids.has(replied.id),'cliente que já respondeu não pode ser proativo');

  // End-to-end first and second attempt for same contact.
  let out=await proactivity.processProactiveFollowups({contactIds:[plan.id]});
  assert(out.ok && out.contactId===plan.id && out.scenario==='plans_silence' && out.attempt===1,'tentativa 1 falhou');
  assert.strictEqual(sent.at(-1).text,'T1 Ana');
  let p=db.getContactById(plan.id);assert.strictEqual(p.proactive_attempts,1);assert.strictEqual(p.next_action,'Aguardar resposta do follow-up proativo');
  assert(db.getContactMessages(plan.id,20).some(m=>m.flow_matched==='proatividade:plans_silence'&&m.body==='T1 Ana'),'mensagem proativa não persistida no histórico');

  // Advance logical Date.now beyond global gap. markProactiveSent timestamps are real, arithmetic uses Date.now.
  const realNow=Date.now; const base=realNow(); Date.now=()=>base+12000;
  out=await proactivity.processProactiveFollowups({contactIds:[plan.id]});
  Date.now=realNow;
  assert(out.ok && out.attempt===2,'tentativa 2 falhou');
  assert.strictEqual(sent.at(-1).text,'T2 Ana');
  p=db.getContactById(plan.id);assert.strictEqual(p.proactive_attempts,2);
  // Limit reached.
  const dueAfterLimit=db.getProactiveCandidates(settings.loadSettings(),{limit:100}).some(x=>x.id===plan.id);assert(!dueAfterLimit,'contato ultrapassou máximo de tentativas');

  // Customer reply immediately cancels/reset cycle.
  db.touchInbound(plan.id); p=db.getContactById(plan.id);assert.strictEqual(p.proactive_attempts,0);assert.strictEqual(p.proactive_scenario,'');

  // Send failure becomes persistent retry.
  failPhone=hot.phone; const realNow2=Date.now; const b2=realNow2(); Date.now=()=>b2+25000;
  out=await proactivity.processProactiveFollowups({contactIds:[hot.id]}); Date.now=realNow2;
  assert(!out.ok && out.reason==='send_error_retry_scheduled','falha de envio deveria criar retry');
  assert(ops.listRetry({status:'pending'}).some(j=>j.payload?.contactId===hot.id),'retry persistente ausente');
  failPhone=''; const reliability=require('../codigo-fonte-dev/server/reliability');
  const retryOut=await reliability.processRetryQueue(); assert(retryOut.ok,'retry proativo deveria enviar com sucesso');
  const hotAfter=db.getContactById(hot.id); assert.strictEqual(hotAfter.proactive_attempts,1,'retry bem-sucedido precisa consumir a tentativa proativa'); assert.strictEqual(hotAfter.proactive_scenario,'hot_silence');

  // UI button wiring: all management/inbox cards have clickable handlers; settings buttons are present/wired.
  const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
  for(const id of ['managementMetrics','managementSegmentPanel','proactiveEnabled','proactiveGlobalInterval','proactiveDailyLimit','proactiveScenarios','saveProactiveSettingsBtn','processProactiveNowBtn','inboxMetrics','inboxGroups']) assert(html.includes(`id="${id}"`),`UI ausente: ${id}`);
  for(const token of ["data-management-segment=\"hot\"","data-management-segment=\"warm\"","data-management-segment=\"pipeline\"","data-management-segment=\"closed\"","data-management-segment=\"abandoned\"","data-management-segment=\"waiting_customer\"","data-management-segment=\"pending_tasks\"","data-management-segment=\"open\"","data-inbox-group=\"urgent\"","data-inbox-group=\"waiting_customer\"","data-inbox-group=\"ai_attending\"","data-inbox-group=\"human_attending\"","data-inbox-group=\"followup_today\"","data-inbox-group=\"problems\""]) assert(js.includes(token),`card não renderizado: ${token}`);
  for(const token of ["el.onclick=()=>showManagementSegment","el.onclick=()=>{activeInboxGroup=", "segmentProactiveBtn').onclick", "saveProactiveSettingsBtn').onclick", "processProactiveNowBtn').onclick"]) assert(js.includes(token),`handler ausente: ${token}`);
  console.log('E2E proatividade v7.4.23 OK', {sent:sent.length,retries:ops.listRetry({}).length,managementCards:8,inboxCards:6});
  db.flush();fs.rmSync(tmp,{recursive:true,force:true});
})().catch(err=>{console.error(err);try{db.flush()}catch(_){};process.exit(1)});
