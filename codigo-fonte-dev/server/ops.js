const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {dataDir}=require('./paths');

const OPS_PATH=path.join(dataDir,'ops-state.json');
const BACKUP_DIR=path.join(dataDir,'backups');
const MAX_RETRIES=5;
const DEFAULT_TEMPLATES=[
  {id:'lead_academia',name:'Jornada comercial',description:'Da primeira abordagem ao pós-venda/acompanhamento',stages:['contato_inicial','apresentacao_plano','fechamento','agendamento_avaliacao','pos_avaliacao','primeiro_treino','acompanhamento'],active:true},
  {id:'aula_experimental',name:'Agendamento e conversão',description:'Contato, agendamento, experiência inicial e conversão',stages:['contato_inicial','agendamento_avaliacao','primeiro_treino','fechamento','acompanhamento'],active:true},
  {id:'cancelado',name:'Cancelamento e reativação',description:'Cancelamento, pós-cancelamento e retorno',stages:['cancelamento','pos_cancelamento','reativacao'],active:true},
];
function now(){return new Date().toISOString();}
function empty(){return {schemaVersion:5,nextAuditId:1,nextKnowledgeId:1,nextRetryId:1,nextApprovalId:1,auditLogs:[],knowledgeBase:[],knowledgeGaps:[],journeyTemplates:DEFAULT_TEMPLATES,retryQueue:[],outboundApprovals:[],systemEvents:[],feedbackExamples:[],lastBackupAt:null,lastBackupPath:null};}
function migrate(s){s=s&&typeof s==='object'?s:empty();s.schemaVersion=5;s.auditLogs=Array.isArray(s.auditLogs)?s.auditLogs:[];s.knowledgeBase=Array.isArray(s.knowledgeBase)?s.knowledgeBase:[];s.knowledgeGaps=Array.isArray(s.knowledgeGaps)?s.knowledgeGaps:[];s.journeyTemplates=Array.isArray(s.journeyTemplates)&&s.journeyTemplates.length?s.journeyTemplates:DEFAULT_TEMPLATES;for(const t of s.journeyTemplates){if(t.id==='lead_academia'&&t.name==='Lead academia'){t.name='Jornada comercial';t.description='Da primeira abordagem ao pós-venda/acompanhamento';}if(t.id==='aula_experimental'&&t.name==='Aula experimental'){t.name='Agendamento e conversão';t.description='Contato, agendamento, experiência inicial e conversão';}}s.retryQueue=Array.isArray(s.retryQueue)?s.retryQueue:[];s.outboundApprovals=Array.isArray(s.outboundApprovals)?s.outboundApprovals:[];s.systemEvents=Array.isArray(s.systemEvents)?s.systemEvents:[];s.feedbackExamples=Array.isArray(s.feedbackExamples)?s.feedbackExamples:[];s.nextAuditId=Math.max(Number(s.nextAuditId||1),...s.auditLogs.map(x=>Number(x.id||0)+1),1);s.nextKnowledgeId=Math.max(Number(s.nextKnowledgeId||1),...s.knowledgeBase.map(x=>Number(x.id||0)+1),1);s.nextRetryId=Math.max(Number(s.nextRetryId||1),...s.retryQueue.map(x=>Number(x.id||0)+1),1);s.nextApprovalId=Math.max(Number(s.nextApprovalId||1),...s.outboundApprovals.map(x=>Number(x.id||0)+1),1);
  for(const k of s.knowledgeBase){
    const auto=Boolean(k.auto_generated);
    if(!k.status) k.status=k.active===false?'expired':(auto?'learned':'official');
    if(k.locked===undefined) k.locked=!auto || Boolean(k.last_auto_content&&String(k.content||'')!==String(k.last_auto_content||''));
    if(k.priority===undefined) k.priority=k.status==='official'?100:k.status==='reviewed'?80:k.status==='learned'?45:10;
    if(!k.learned_at && auto) k.learned_at=k.created_at||k.updated_at||now();
    if(!k.last_seen_at && auto) k.last_seen_at=k.updated_at||k.created_at||now();
    if(!k.review_after && auto && k.status==='learned'){const d=new Date(k.last_seen_at||now());d.setDate(d.getDate()+90);k.review_after=d.toISOString();}
    if(k.valid_from===undefined) k.valid_from=null;
    if(k.last_verified_at===undefined) k.last_verified_at=!auto?(k.updated_at||k.created_at||now()):null;
  }
  // recuperação de jobs interrompidos por fechamento abrupto
  for(const j of s.retryQueue){if(j.status==='processing'){j.status='pending';j.next_attempt_at=now();j.last_error='Recuperado após reinício do sistema';}}
  return s;}
function load(){try{return migrate(JSON.parse(fs.readFileSync(OPS_PATH,'utf8')));}catch(_){return empty();}}
let state=load();
function save(){fs.mkdirSync(dataDir,{recursive:true});const tmp=OPS_PATH+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,OPS_PATH);}
save();
function sanitizeDetails(v){if(v==null)return v;if(Array.isArray(v))return v.map(sanitizeDetails);if(typeof v==='object'){const o={};for(const[k,val]of Object.entries(v)){if(/pin|password|gemini.*key|api.*key|token|authorization/i.test(k))o[k]='[oculto]';else o[k]=sanitizeDetails(val);}return o;}if(typeof v==='string'&&v.length>1000)return v.slice(0,1000)+'…';return v;}
function audit(action,{agentId=null,contactId=null,resource='',resourceId=null,details={}}={}){const row={id:state.nextAuditId++,action:String(action),agent_id:agentId==null?null:Number(agentId),contact_id:contactId==null?null:Number(contactId),resource:String(resource||''),resource_id:resourceId==null?null:String(resourceId),details:sanitizeDetails(details),created_at:now()};state.auditLogs.push(row);if(state.auditLogs.length>10000)state.auditLogs=state.auditLogs.slice(-10000);save();return row;}
function listAudit({limit=200,agentId,action,contactId}={}){let x=[...state.auditLogs];if(agentId)x=x.filter(a=>a.agent_id===Number(agentId));if(action)x=x.filter(a=>a.action===action);if(contactId)x=x.filter(a=>a.contact_id===Number(contactId));return x.slice(-Math.min(1000,Number(limit||200))).reverse();}
function effectiveKnowledgeStatus(row,at=Date.now()){
  const raw=String(row?.status||'learned');
  if(raw==='expired'||row?.active===false)return 'expired';
  if(row?.expires_at&&new Date(row.expires_at).getTime()<=at)return 'expired';
  if(raw==='learned'&&row?.review_after&&new Date(row.review_after).getTime()<=at)return 'review';
  return ['official','reviewed','learned','review','expired'].includes(raw)?raw:'learned';
}
function listKnowledge(){const at=Date.now();return [...state.knowledgeBase].map(x=>({...x,effective_status:effectiveKnowledgeStatus(x,at)})).sort((a,b)=>Number(b.priority||0)-Number(a.priority||0)||String(a.category).localeCompare(String(b.category))||String(a.title).localeCompare(String(b.title)));}
function upsertKnowledge(payload,agentId){
  let row=payload.id?state.knowledgeBase.find(x=>x.id===Number(payload.id)):null;
  if(!row&&payload.source_key)row=state.knowledgeBase.find(x=>x.source_key===String(payload.source_key));
  const isNew=!row;
  if(!row){row={id:state.nextKnowledgeId++,created_at:now()};state.knowledgeBase.push(row);}
  const humanEdit=agentId!=null;
  const requestedStatus=String(payload.status||'').trim();
  const status=['official','reviewed','learned','review','expired'].includes(requestedStatus)?requestedStatus:(humanEdit?(isNew?'official':'reviewed'):(row.status||'learned'));
  const defaultPriority=status==='official'?100:status==='reviewed'?80:status==='learned'?45:status==='review'?20:0;
  Object.assign(row,{
    category:String(payload.category||row.category||'geral').trim(),title:String(payload.title||row.title||'').trim(),content:String(payload.content??row.content??'').trim(),
    keywords:Array.isArray(payload.keywords)?payload.keywords.map(String).map(x=>x.trim()).filter(Boolean):String(payload.keywords??(row.keywords||[]).join(',')).split(',').map(x=>x.trim()).filter(Boolean),
    active:status!=='expired'&&payload.active!==false,status,
    priority:Math.max(0,Math.min(100,Number(payload.priority??row.priority??defaultPriority))),
    valid_from:payload.valid_from!==undefined?(payload.valid_from||null):(row.valid_from||null),
    expires_at:payload.expires_at!==undefined?(payload.expires_at||null):(row.expires_at||null),
    review_after:payload.review_after!==undefined?(payload.review_after||null):(row.review_after||null),
    source:String(payload.source??(humanEdit?(row.auto_generated?'manual_override':'manual'):(row.source||''))),
    source_key:String(payload.source_key??row.source_key??''),auto_generated:Boolean(payload.auto_generated??row.auto_generated),
    locked:payload.locked!==undefined?Boolean(payload.locked):(humanEdit?true:Boolean(row.locked)),
    last_auto_content:String(payload.last_auto_content??row.last_auto_content??''),confidence:Number(payload.confidence??row.confidence??0),evidence_count:Number(payload.evidence_count??row.evidence_count??0),
    last_verified_at:humanEdit?now():(payload.last_verified_at??row.last_verified_at??null),updated_at:now()
  });
  if(status==='expired')row.active=false;
  save();audit('knowledge_saved',{agentId,resource:'knowledge',resourceId:row.id,details:{title:row.title,category:row.category,status:row.status,priority:row.priority,locked:row.locked}});return {...row,effective_status:effectiveKnowledgeStatus(row)};
}
function deleteKnowledge(id,agentId){const n=state.knowledgeBase.length;state.knowledgeBase=state.knowledgeBase.filter(x=>x.id!==Number(id));save();if(state.knowledgeBase.length<n)audit('knowledge_deleted',{agentId,resource:'knowledge',resourceId:id});return state.knowledgeBase.length<n;}

function syncBootstrapKnowledge(knowledge={}){
  const items=[];const stamp=now();
  const reviewAfter=()=>{const d=new Date(stamp);d.setDate(d.getDate()+90);return d.toISOString();};
  const add=(category,title,content,key,keywords=[])=>{const c=String(content||'').trim();if(c)items.push({category,title,content:c,source:'bootstrap_history',source_key:key,auto_generated:true,last_auto_content:c,keywords,status:'learned',priority:45,learned_at:stamp,last_seen_at:stamp,review_after:reviewAfter(),locked:false});};
  add('empresa','Perfil operacional',knowledge.business_profile,'bootstrap:business',['empresa','operação']);
  add('comunicação','Estilo de atendimento',knowledge.style_profile,'bootstrap:style',['tom','atendimento','comunicação']);
  (knowledge.facts||[]).slice(0,40).forEach((x,i)=>add('fatos',`Fato aprendido ${i+1}`,typeof x==='string'?x:JSON.stringify(x),`bootstrap:fact:${i}`));
  (knowledge.faq||[]).slice(0,30).forEach((x,i)=>{if(x?.question&&x?.answer)add('faq',String(x.question).slice(0,140),String(x.answer),`bootstrap:faq:${i}`,[String(x.question)]);});
  (knowledge.processes||[]).slice(0,25).forEach((x,i)=>{if(x)add('processos',String(x.topic||`Processo ${i+1}`).slice(0,140),String(x.steps||x.description||JSON.stringify(x)),`bootstrap:process:${i}`);});
  let created=0,updated=0,preservedManual=0,preservedExpired=0;
  for(const item of items){
    let row=state.knowledgeBase.find(x=>x.source_key===item.source_key);
    if(row){
      const status=effectiveKnowledgeStatus(row);const humanEdited=Boolean(row.locked)||['official','reviewed'].includes(status)||(row.auto_generated&&row.last_auto_content&&String(row.content)!==String(row.last_auto_content));
      if(humanEdited){preservedManual++;continue;}
      if(status==='expired'){preservedExpired++;continue;}
      Object.assign(row,item,{created_at:row.created_at||stamp,learned_at:row.learned_at||stamp,updated_at:stamp});updated++;
    }else{row={id:state.nextKnowledgeId++,created_at:stamp,active:true,expires_at:null,valid_from:null,last_verified_at:null,...item,confidence:0,evidence_count:0,updated_at:stamp};state.knowledgeBase.push(row);created++;}
  }
  save();return {created,updated,preservedManual,preservedExpired,total:state.knowledgeBase.filter(x=>['official','reviewed','learned'].includes(effectiveKnowledgeStatus(x))).length};
}
function syncKnowledgeGaps(gaps=[]){const map=new Map();for(const g of gaps){const text=String(typeof g==='string'?g:(g?.gap||g?.question||g?.topic||'')).trim();if(!text)continue;const key=text.toLowerCase();const prev=map.get(key)||{gap:text,count:0,source:'bootstrap_history'};prev.count+=Number(g?.count||1);map.set(key,prev);}state.knowledgeGaps=[...map.values()].sort((a,b)=>b.count-a.count).slice(0,80);save();return state.knowledgeGaps;}
function listKnowledgeGaps(){return [...state.knowledgeGaps];}
function companyMemoryText(query='',maxChars=18000){
  const nowTs=Date.now();
  const active=state.knowledgeBase.filter(x=>{const st=effectiveKnowledgeStatus(x,nowTs);if(!['official','reviewed'].includes(st))return false;if(x.valid_from&&new Date(x.valid_from).getTime()>nowTs)return false;return true;});
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const q=norm(query);const tokens=[...new Set(q.split(' ').filter(x=>x.length>2))];
  const statusWeight={official:30,reviewed:20};
  const scored=active.map((x,i)=>{const st=effectiveKnowledgeStatus(x,nowTs),title=norm(x.title),keywords=(x.keywords||[]).map(norm),content=norm(x.content),hay=[norm(x.category),title,content,...keywords].join(' ');let score=statusWeight[st]||0;score+=Number(x.priority||0)/5;if(q&&hay.includes(q))score+=12;for(const t of tokens){if(title.includes(t))score+=4;if(keywords.some(k=>k===t||k.includes(t)||t.includes(k)))score+=5;if(content.includes(t))score+=1;}score+=Math.min(2,Number(x.confidence||0)*2);return{x,i,score,st};}).sort((a,b)=>b.score-a.score||b.x.evidence_count-a.x.evidence_count||a.i-b.i);
  const selected=scored.filter(r=>r.score>0).slice(0,24);const fallback=scored.filter(r=>r.score<=0).slice(0,8);
  return [...selected,...fallback].map(({x,st})=>`[${st.toUpperCase()}][${x.category}] ${x.title}: ${x.content}`).join('\n').slice(0,Math.max(1000,Number(maxChars||18000)));
}

function recordFeedbackExample({input='',suggestion='',correction='',score=-1,contactId=null,agentId=null}={}){const row={id:crypto.randomBytes(6).toString('hex'),input:String(input||'').slice(0,2000),suggestion:String(suggestion||'').slice(0,2000),correction:String(correction||'').slice(0,2000),score:Number(score)>=0?1:-1,contact_id:contactId==null?null:Number(contactId),agent_id:agentId==null?null:Number(agentId),created_at:now()};state.feedbackExamples.push(row);if(state.feedbackExamples.length>200)state.feedbackExamples=state.feedbackExamples.slice(-200);save();audit('ai_feedback_example_saved',{agentId,contactId,resource:'ai_feedback',resourceId:row.id,details:{score:row.score,hasCorrection:Boolean(row.correction)}});return row;}
function feedbackMemoryText(max=16){const limit=Math.max(2,Number(max||16));const recent=state.feedbackExamples.slice(-Math.max(limit*3,30));const corrected=recent.filter(x=>x.score<0&&x.correction).slice(-Math.ceil(limit/2)).map(x=>`EXEMPLO CORRIGIDO\nCliente: ${x.input}\nEvitar: ${x.suggestion}\nPreferir: ${x.correction}`);const approved=recent.filter(x=>x.score>=0&&(x.correction||x.suggestion)).slice(-Math.ceil(limit/2)).map(x=>`EXEMPLO APROVADO/HUMANO\nCliente: ${x.input}\nResposta da equipe: ${x.correction||x.suggestion}`);return [...corrected,...approved].join('\n---\n').slice(0,16000);}

function listTemplates(){return state.journeyTemplates;}
function saveTemplate(payload,agentId){let t=payload.id?state.journeyTemplates.find(x=>x.id===String(payload.id)):null;if(!t){t={id:payload.id||crypto.randomBytes(5).toString('hex')};state.journeyTemplates.push(t);}Object.assign(t,{name:String(payload.name||'Template').trim(),description:String(payload.description||''),stages:Array.isArray(payload.stages)?payload.stages.map(String):[],active:payload.active!==false,updated_at:now()});save();audit('journey_template_saved',{agentId,resource:'journey_template',resourceId:t.id,details:{name:t.name,stages:t.stages}});return t;}
function deleteTemplate(id,agentId){const before=state.journeyTemplates.length;state.journeyTemplates=state.journeyTemplates.filter(x=>x.id!==String(id));save();if(state.journeyTemplates.length<before)audit('journey_template_deleted',{agentId,resource:'journey_template',resourceId:id});return state.journeyTemplates.length<before;}
function enqueueRetry(payload){const uniqueKey=payload.uniqueKey||'';if(uniqueKey){const existing=state.retryQueue.find(x=>x.unique_key===uniqueKey&&x.status!=='done');if(existing)return existing;}const row={id:state.nextRetryId++,kind:payload.kind||'message',status:'pending',attempts:0,max_attempts:Number(payload.maxAttempts||MAX_RETRIES),next_attempt_at:payload.nextAttemptAt||now(),last_error:'',payload:sanitizeDetails(payload.payload||{}),unique_key:uniqueKey,created_at:now(),updated_at:now()};state.retryQueue.push(row);save();return row;}
function listRetry({status,limit=200}={}){let x=[...state.retryQueue];if(status)x=x.filter(j=>j.status===status);return x.slice(-Math.min(1000,Number(limit||200))).reverse();}
function claimDueRetry(preferredId=null){const t=Date.now();const eligible=x=>x.status==='pending'&&new Date(x.next_attempt_at||0).getTime()<=t;const j=preferredId?state.retryQueue.find(x=>x.id===Number(preferredId)&&eligible(x)):state.retryQueue.find(eligible);if(!j)return null;j.status='processing';j.attempts=Number(j.attempts||0)+1;j.updated_at=now();save();return JSON.parse(JSON.stringify(j));}
function completeRetry(id){const j=state.retryQueue.find(x=>x.id===Number(id));if(!j)return null;j.status='done';j.completed_at=now();j.updated_at=now();const done=state.retryQueue.filter(x=>x.status==='done');if(done.length>500){const remove=new Set(done.slice(0,done.length-500).map(x=>x.id));state.retryQueue=state.retryQueue.filter(x=>!remove.has(x.id));}save();return j;}
function failRetry(id,error,permanent=false){const j=state.retryQueue.find(x=>x.id===Number(id));if(!j)return null;j.last_error=String(error||'Erro desconhecido').slice(0,800);j.updated_at=now();if(permanent||j.attempts>=j.max_attempts){j.status='dead';j.failed_at=now();j.permanent_failure=Boolean(permanent);}else{j.status='pending';const mins=Math.min(60,Math.pow(2,Math.max(0,j.attempts-1)));j.next_attempt_at=new Date(Date.now()+mins*60000).toISOString();}save();return j;}

function deferRetry(id,delayMinutes=5,reason='Pausado pela política de segurança'){const j=state.retryQueue.find(x=>x.id===Number(id));if(!j)return null;j.status='pending';j.attempts=Math.max(0,Number(j.attempts||0)-1);j.last_error=String(reason||'Pausado pela política de segurança').slice(0,800);j.next_attempt_at=new Date(Date.now()+Math.max(1,Number(delayMinutes||5))*60000).toISOString();j.updated_at=now();save();return j;}
function retryNow(id){const j=state.retryQueue.find(x=>x.id===Number(id));if(!j)return null;if(j.status==='done')return j;j.status='pending';j.next_attempt_at=now();j.last_error=j.last_error||'';j.updated_at=now();save();return j;}

function retryMetrics(){const o={pending:0,processing:0,done:0,dead:0,total:state.retryQueue.length};for(const j of state.retryQueue)o[j.status]=(o[j.status]||0)+1;return o;}

function enqueueOutboundApproval(payload={}){
  const uniqueKey=String(payload.uniqueKey||'').trim();
  if(uniqueKey){const existing=state.outboundApprovals.find(x=>x.unique_key===uniqueKey&&x.status==='pending');if(existing)return existing;}
  const row={id:state.nextApprovalId++,status:'pending',kind:String(payload.kind||'auto'),contact_id:Number(payload.contactId||0)||null,text:String(payload.text||'').slice(0,5000),source:String(payload.source||''),category:String(payload.category||''),reason:String(payload.reason||'approval_required'),meta:sanitizeDetails(payload.meta||{}),unique_key:uniqueKey,created_at:now(),updated_at:now(),resolved_at:null,resolved_by:null};
  state.outboundApprovals.push(row);if(state.outboundApprovals.length>2000)state.outboundApprovals=state.outboundApprovals.slice(-2000);save();audit('outbound_approval_queued',{contactId:row.contact_id,resource:'outbound_approval',resourceId:row.id,details:{kind:row.kind,source:row.source,category:row.category,reason:row.reason}});return row;
}
function listOutboundApprovals({status='pending',limit=300}={}){let rows=[...state.outboundApprovals];if(status)rows=rows.filter(x=>x.status===status);return rows.slice(-Math.max(1,Math.min(1000,Number(limit||300)))).reverse();}
function getOutboundApproval(id){return state.outboundApprovals.find(x=>x.id===Number(id))||null;}
function resolveOutboundApproval(id,status,agentId=null,note=''){const row=getOutboundApproval(id);if(!row)return null;if(!['approved','rejected','cancelled','sent'].includes(status))return null;row.status=status;row.resolved_at=now();row.resolved_by=agentId==null?null:Number(agentId);row.note=String(note||'').slice(0,500);row.updated_at=now();save();audit('outbound_approval_resolved',{agentId,contactId:row.contact_id,resource:'outbound_approval',resourceId:row.id,details:{status,note:row.note,kind:row.kind,source:row.source}});return row;}
function approvalMetrics(){const o={pending:0,approved:0,rejected:0,cancelled:0,sent:0,total:state.outboundApprovals.length};for(const x of state.outboundApprovals)o[x.status]=(o[x.status]||0)+1;return o;}
function createBackup(label='auto'){fs.mkdirSync(BACKUP_DIR,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const dir=path.join(BACKUP_DIR,`${stamp}-${String(label).replace(/[^a-z0-9_-]/gi,'')||'backup'}`);fs.mkdirSync(dir,{recursive:true});for(const name of ['ra-bot-db.json','alone.db','flows.json','crm-config.json','agents.json','ops-state.json']){const src=path.join(dataDir,name);if(fs.existsSync(src))fs.copyFileSync(src,path.join(dir,name));}const settingsPath=path.join(dataDir,'settings.json');if(fs.existsSync(settingsPath)){try{const cfg=JSON.parse(fs.readFileSync(settingsPath,'utf8'));delete cfg.geminiApiKey;fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify(cfg,null,2),'utf8');}catch(_){}}const mediaSrc=path.join(dataDir,'media');if(fs.existsSync(mediaSrc))fs.cpSync(mediaSrc,path.join(dir,'media'),{recursive:true});state.lastBackupAt=now();state.lastBackupPath=dir;save();audit('backup_created',{resource:'backup',resourceId:path.basename(dir),details:{label,secretExcluded:true,mediaIncluded:fs.existsSync(mediaSrc)}});pruneBackups(14);return {name:path.basename(dir),path:dir,created_at:state.lastBackupAt};}
function listBackups(){if(!fs.existsSync(BACKUP_DIR))return[];return fs.readdirSync(BACKUP_DIR,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>({name:x.name,path:path.join(BACKUP_DIR,x.name)})).sort((a,b)=>b.name.localeCompare(a.name));}
function pruneBackups(keep=14){const all=listBackups();for(const b of all.slice(keep)){try{fs.rmSync(b.path,{recursive:true,force:true});}catch(_){}}}
function restoreBackup(name,agentId){
  const safe=path.basename(String(name||''));
  const dir=path.join(BACKUP_DIR,safe);
  if(!fs.existsSync(dir))throw new Error('Backup não encontrado');
  const files=['ra-bot-db.json','alone.db','settings.json','flows.json','crm-config.json','agents.json','ops-state.json'];
  const available=files.filter(file=>fs.existsSync(path.join(dir,file)));
  if((!available.includes('ra-bot-db.json')&&!available.includes('alone.db'))||!available.includes('settings.json'))throw new Error('Backup incompleto: banco ou configurações ausentes');
  for(const file of available.filter(file=>file!=='alone.db')){
    const raw=fs.readFileSync(path.join(dir,file),'utf8');
    try{JSON.parse(raw);}catch(_){throw new Error(`Backup inválido: ${file} está corrompido`);}
  }
  const sqliteBackup=path.join(dir,'alone.db');
  if(fs.existsSync(sqliteBackup) && fs.statSync(sqliteBackup).size<4096) throw new Error('Backup inválido: alone.db está vazio ou corrompido');
  createBackup('pre-restore');
  for(const file of available){
    const src=path.join(dir,file),dst=path.join(dataDir,file),tmp=dst+'.restoretmp';
    if(file==='settings.json'){
      const cfg=JSON.parse(fs.readFileSync(src,'utf8'));delete cfg.geminiApiKey;
      fs.writeFileSync(tmp,JSON.stringify(cfg,null,2),'utf8');
    } else fs.copyFileSync(src,tmp);
    fs.renameSync(tmp,dst);
  }
  if(available.includes('ra-bot-db.json')) fs.writeFileSync(path.join(dataDir,'force-json-import.flag'),'restore JSON backup on next startup','utf8');
  else fs.rmSync(path.join(dataDir,'force-json-import.flag'),{force:true});
  const mediaSrc=path.join(dir,'media');
  if(fs.existsSync(mediaSrc)){const mediaDst=path.join(dataDir,'media');fs.rmSync(mediaDst,{recursive:true,force:true});fs.cpSync(mediaSrc,mediaDst,{recursive:true});}
  audit('backup_restored',{agentId,resource:'backup',resourceId:safe,details:{files:available,mediaRestored:fs.existsSync(mediaSrc),secretPreserved:true,storage:available.includes('alone.db')?'sqlite':'json'}});
  return {ok:true,restartRequired:true};
}
function healthSnapshot({whatsappStatus='desconectado',geminiConfigured=false,geminiRuntime={},dbMetrics={},scheduler=true}={}){const retries=retryMetrics();const backupAge=state.lastBackupAt?Math.round((Date.now()-new Date(state.lastBackupAt).getTime())/3600000):null;const geminiHasSuccess=Boolean(geminiRuntime.lastSuccessAt);const geminiOk=Boolean(geminiConfigured)&&(!geminiRuntime.lastFailureAt||geminiHasSuccess&&new Date(geminiRuntime.lastSuccessAt)>=new Date(geminiRuntime.lastFailureAt));return {generated_at:now(),uptime_seconds:Math.round(process.uptime()),whatsapp:{status:whatsappStatus,ok:whatsappStatus==='conectado'},gemini:{configured:Boolean(geminiConfigured),ok:geminiOk,last_success_at:geminiRuntime.lastSuccessAt||null,last_failure_at:geminiRuntime.lastFailureAt||null,last_error:geminiRuntime.lastError||'',calls:Number(geminiRuntime.totalCalls||0),failures:Number(geminiRuntime.totalFailures||0)},database:{ok:true,...dbMetrics},scheduler:{ok:Boolean(scheduler?.started ?? scheduler),...(typeof scheduler==='object'?scheduler:{})},retry_queue:{...retries,ok:retries.dead===0},backup:{last_at:state.lastBackupAt,last_path:state.lastBackupPath,age_hours:backupAge,ok:backupAge!==null&&backupAge<=30},overall: whatsappStatus==='conectado'&&geminiOk&&retries.dead===0};}
module.exports={audit,listAudit,listKnowledge,upsertKnowledge,deleteKnowledge,effectiveKnowledgeStatus,syncBootstrapKnowledge,syncKnowledgeGaps,listKnowledgeGaps,companyMemoryText,recordFeedbackExample,feedbackMemoryText,listTemplates,saveTemplate,deleteTemplate,enqueueRetry,listRetry,claimDueRetry,completeRetry,failRetry,retryNow,deferRetry,retryMetrics,enqueueOutboundApproval,listOutboundApprovals,getOutboundApproval,resolveOutboundApproval,approvalMetrics,createBackup,listBackups,restoreBackup,healthSnapshot};
