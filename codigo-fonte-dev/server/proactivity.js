const db = require('./db');
const ops = require('./ops');
const { loadSettings } = require('./settings');
const { isWithinBusinessHours } = require('./flows');
const outboundPolicy = require('./outbound-policy');
const safetyEngine = require('./safety-engine');
const { sendText: sendManualMessage, getStatus } = require('./messaging-provider');

let processing=false;
let lastGlobalSendAt=0;

function render(template, contact){
  const first=String(contact.name||'').trim().split(/\s+/)[0]||'';
  return String(template||'')
    .replace(/\{nome\}/gi,first)
    .replace(/\{nome_completo\}/gi,contact.name||'')
    .replace(/\{interesse\}/gi,contact.interest||contact.last_intent||'')
    .replace(/\{plano\}/gi,contact.plan_name||'')
    .trim();
}

function scenarioFor(contact, settings, forcedSegment=null){
  const sc=settings.proactiveScenarios||{};
  let key=db.proactiveScenarioForContact(contact,sc);
  if(!key && forcedSegment==='waiting_customer' && sc.unanswered_segment?.enabled) key='unanswered_segment';
  return key;
}

function diagnostics(settings=loadSettings(), segment=null){
  const candidates=db.getProactiveCandidates(settings,{segment,limit:500});
  return {
    enabled:settings.proactiveEnabled!==false,
    accountProtectionMode:outboundPolicy.mode(settings),
    automationMode:String(settings.outboundAutomationMode||'approval'),
    whatsapp:getStatus().status,
    insideBusinessHours:isWithinBusinessHours(new Date(),settings),
    dailyUsed:db.countProactiveSendsToday(),
    dailyLimit:Number(settings.proactiveDailyLimit||80),
    eligible:candidates.length,
    segment:segment||null,
    scenarios:settings.proactiveScenarios||{},
  };
}

async function processProactiveFollowups({segment=null,contactIds=null}={}){
  if(processing)return {ok:false,reason:'busy',diagnostics:diagnostics(loadSettings(),segment)};
  processing=true;
  try{
    const settings=loadSettings();
    if(settings.proactiveEnabled===false)return {ok:false,reason:'disabled',diagnostics:diagnostics(settings,segment)};
    if(outboundPolicy.mode(settings)==='strict')return {ok:false,reason:'account_protection_strict',diagnostics:diagnostics(settings,segment)};
    if(getStatus().status!=='conectado')return {ok:false,reason:'whatsapp_offline',diagnostics:diagnostics(settings,segment)};
    if(!isWithinBusinessHours(new Date(),settings))return {ok:false,reason:'outside_business_hours',diagnostics:diagnostics(settings,segment)};
    if(db.countProactiveSendsToday()>=Number(settings.proactiveDailyLimit||80))return {ok:false,reason:'daily_limit',diagnostics:diagnostics(settings,segment)};
    const minGap=Math.max(10,Number(settings.proactiveGlobalMinIntervalSeconds||45))*1000;
    const persistedLast=db.getLastProactiveSendAt?.();
    const persistedTs=persistedLast?new Date(persistedLast).getTime():0;
    const effectiveLast=Math.max(Number(lastGlobalSendAt||0),Number.isFinite(persistedTs)?persistedTs:0);
    if(effectiveLast && Date.now()-effectiveLast<minGap)return {ok:false,reason:'global_interval',diagnostics:diagnostics(settings,segment)};
    let candidates=db.getProactiveCandidates(settings,{segment,limit:100});
    if(Array.isArray(contactIds)&&contactIds.length){const allow=new Set(contactIds.map(Number));candidates=candidates.filter(c=>allow.has(Number(c.id)));}
    for(const contact of candidates){
      const key=scenarioFor(contact,settings,segment); if(!key)continue;
      const rule=settings.proactiveScenarios?.[key]; if(!rule||rule.enabled===false)continue;
      const attempt=(contact.proactive_scenario===key?Number(contact.proactive_attempts||0):0);
      const msgs=Array.isArray(rule.messages)?rule.messages:[];
      const text=render(msgs[Math.min(attempt,msgs.length-1)]||msgs[0]||'',contact);
      if(!text)continue;
      const policy=outboundPolicy.check({settings,contact,kind:'proactive',source:`proatividade:${key}`});
      if(!policy.allowed){
        if(policy.requiresApproval){ops.enqueueOutboundApproval({kind:'proactive',contactId:contact.id,text,source:`proatividade:${key}`,category:policy.category,reason:policy.reason,uniqueKey:`proactive:${contact.id}:${key}:${attempt+1}:${contact.last_outbound_at||''}`,meta:{scenario:key,attempt:attempt+1}});return {ok:false,reason:'approval_required',contactId:contact.id,scenario:key,diagnostics:diagnostics(settings,segment)};}
        continue;
      }
      return await safetyEngine.withAutomationLock(async()=>{
        const fresh=db.getContactById(contact.id);
        const recheck=outboundPolicy.check({settings:loadSettings(),contact:fresh,kind:'proactive',source:`proatividade:${key}`});
        if(!recheck.allowed)return {ok:false,reason:recheck.reason,contactId:fresh?.id||contact.id,scenario:key,diagnostics:diagnostics(loadSettings(),segment)};
        try{
          await sendManualMessage(fresh.phone,text);
          db.logMessage(fresh.id,'out','text',text,`proatividade:${key}`);
          db.touchOutbound(fresh.id);
          db.markProactiveSent(fresh.id,key,text);
          db.updateContact(fresh.id,{next_action:'Aguardar resposta do follow-up proativo'},{activity:false});
          lastGlobalSendAt=Date.now();
          ops.audit('proactive_followup_sent',{contactId:fresh.id,resource:'proactivity',resourceId:key,details:{attempt:attempt+1,segment:segment||''}});
          return {ok:true,contactId:fresh.id,scenario:key,attempt:attempt+1,diagnostics:diagnostics(loadSettings(),segment)};
        }catch(err){
          ops.enqueueRetry({kind:'text_message',uniqueKey:`proactive:${fresh.id}:${key}:${attempt+1}:${fresh.last_outbound_at||''}`,payload:{contactId:fresh.id,text,source:`proatividade_retry:${key}`,proactiveScenario:key,proactiveAttempt:attempt+1}});
          ops.audit('proactive_followup_retry_queued',{contactId:fresh.id,resource:'proactivity',resourceId:key,details:{error:err.message}});
          return {ok:false,reason:'send_error_retry_scheduled',error:err.message,diagnostics:diagnostics(loadSettings(),segment)};
        }
      });
    }
    return {ok:false,reason:'nothing_due',diagnostics:diagnostics(settings,segment)};
  } finally { processing=false; }
}

module.exports={processProactiveFollowups,diagnostics,render};
