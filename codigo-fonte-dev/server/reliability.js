const path=require('path');
const ops=require('./ops');
const db=require('./db');
const {dataDir}=require('./paths');
const {sendText:sendManualMessage,sendResponse:sendManualResponse,getStatus}=require('./messaging-provider');
const {loadSettings}=require('./settings');
const outboundPolicy=require('./outbound-policy');
const safetyEngine=require('./safety-engine');
let processing=false;
async function processRetryQueue(){
  if(processing)return {ok:false,reason:'busy'};
  processing=true;
  try{
    if(getStatus().status!=='conectado')return {ok:false,reason:'whatsapp_offline'};
    const job=ops.claimDueRetry(); if(!job)return {ok:false,reason:'nothing_due'};
    return await safetyEngine.withAutomationLock(async()=>{
      try{
        const p=job.payload||{}; const contact=db.getContactById(p.contactId);
        if(!contact)throw new Error('Contato não encontrado');
        if(job.kind==='text_message'){
          const retryText=String(p.text||'');
          const src=String(p.source||'');
          let kind='manual'; if(src.startsWith('proatividade'))kind='proactive'; else if(src.startsWith('jornada'))kind='journey'; else if(src.startsWith('prospeccao'))kind='campaign'; else if(src.startsWith('ia_'))kind='ai_reply';
          const policy=outboundPolicy.check({settings:loadSettings(),contact:db.getContactById(contact.id),kind,source:src});
          if(!policy.allowed){
            if(policy.requiresApproval){ops.enqueueOutboundApproval({kind,contactId:contact.id,text:retryText,source:src,category:policy.category,reason:policy.reason,uniqueKey:`retry-approval:${job.id}`,meta:{retryId:job.id,proactiveScenario:p.proactiveScenario||'',proactiveAttempt:p.proactiveAttempt||0,journeyStage:p.journeyStage||'',prospectQueueId:p.prospectQueueId||null,agentId:p.agentId||null}});ops.completeRetry(job.id);ops.audit('retry_moved_to_approval',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{kind,source:src}});return {ok:false,id:job.id,reason:'approval_required',movedToApproval:true};}
            if(['restriction_cooldown','rate_limit_cooldown','transport_unstable','hourly_automation_limit','daily_automation_limit','global_automation_interval','circuit_breaker'].includes(policy.reason)){
              const delay=policy.reason==='global_automation_interval'?Math.max(1,Math.ceil(Number(policy.retryAfterSeconds||60)/60)):policy.reason==='rate_limit_cooldown'?60:15;
              ops.deferRetry(job.id,delay,`Safety Engine: ${policy.reason}`);
              ops.audit('retry_deferred_by_safety',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{kind,source:src,reason:policy.reason,delayMinutes:delay}});
              return {ok:false,id:job.id,reason:policy.reason,deferred:true};
            }
            ops.audit('retry_blocked_account_protection',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{kind,source:src,reason:policy.reason,mode:policy.mode}});ops.completeRetry(job.id);return {ok:false,id:job.id,reason:policy.reason,blockedByAccountProtection:true};
          }
          const alreadySent=db.getContactMessages(contact.id,true).some(m=>m.direction==='out'&&String(m.body||'').trim()===retryText.trim()&&new Date(m.created_at).getTime()>=new Date(job.created_at||0).getTime());
          if(alreadySent){if(p.proactiveScenario){db.markProactiveSent(contact.id,p.proactiveScenario,retryText);db.updateContact(contact.id,{next_action:'Aguardar resposta do follow-up proativo'},{activity:false});}ops.audit('retry_skipped_duplicate',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{kind:job.kind,source:p.source,proactiveScenario:p.proactiveScenario||''}});ops.completeRetry(job.id);return {ok:true,id:job.id,skipped:'duplicate_already_sent'};}
          await sendManualMessage(contact.phone,retryText);
          db.logMessage(contact.id,'out','text',retryText,p.source||'retry',p.agentId||null);
          db.touchOutbound(contact.id);
          if(p.proactiveScenario){db.markProactiveSent(contact.id,p.proactiveScenario,retryText);db.updateContact(contact.id,{next_action:'Aguardar resposta do follow-up proativo'},{activity:false});}
          if(p.prospectQueueId)db.markProspectSent(p.prospectQueueId);
          if(p.journeyStage)db.markJourneyFollowupSent(contact.id,p.journeyStage);
        } else if(job.kind==='quick_reply') {
          const policy=outboundPolicy.check({settings:loadSettings(),contact:db.getContactById(contact.id),kind:'manual',source:'quick_retry'});
          if(!policy.allowed){ops.audit('retry_blocked_optout',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{reason:policy.reason}});ops.completeRetry(job.id);return {ok:false,id:job.id,reason:policy.reason,blocked:true};}
          const q=db.listQuickReplies().find(x=>x.id===Number(p.quickReplyId));
          if(!q)throw new Error('Resposta rápida não encontrada');
          const expected=String(q.text||q.file||'').trim();
          const alreadySent=db.getContactMessages(contact.id,true).some(m=>m.direction==='out'&&String(m.body||'').trim()===expected&&new Date(m.created_at).getTime()>=new Date(job.created_at||0).getTime());
          if(alreadySent){ops.audit('retry_skipped_duplicate',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{kind:job.kind,quickReplyId:q.id}});ops.completeRetry(job.id);return {ok:true,id:job.id,skipped:'duplicate_already_sent'};}
          const response={...q}; if(q.file)response.path=path.join(dataDir,'media',q.file);
          await sendManualResponse(contact.phone,response);
          db.logMessage(contact.id,'out',q.type,q.text||q.file,`quick_retry:${q.shortcut}`,p.agentId||null);
          db.touchOutbound(contact.id);
        } else throw new Error(`Tipo de retry não suportado: ${job.kind}`);
        ops.audit('retry_message_sent',{agentId:p.agentId,contactId:contact.id,resource:'retry',resourceId:job.id,details:{source:p.source,kind:job.kind}});
        ops.completeRetry(job.id); return {ok:true,id:job.id};
      }catch(err){const cls=safetyEngine.classifyTransportError(err);ops.failRetry(job.id,err.message,['permanent','auth','restriction'].includes(cls.kind));ops.audit('retry_failed',{resource:'retry',resourceId:job.id,details:{error:err.message,kind:job.kind,classification:cls.kind}});return {ok:false,reason:cls.kind==='restriction'?'restriction_detected':cls.kind==='rate_limit'?'rate_limited':'send_error',error:err.message,id:job.id};}
    });
  }finally{processing=false;}
}
module.exports={processRetryQueue};
