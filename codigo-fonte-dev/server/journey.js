// journey.js — follow-ups automáticos após mudanças reais de etapa no CRM.
const db = require('./db');
const ops = require('./ops');
const { loadSettings } = require('./settings');
const { isWithinBusinessHours } = require('./flows');
const { sendText: sendManualMessage, getStatus } = require('./messaging-provider');
const outboundPolicy = require('./outbound-policy');
const safetyEngine = require('./safety-engine');

function render(template, contact) {
  const firstName = String(contact.name || '').trim().split(/\s+/)[0] || '';
  return String(template || '').replace(/\{nome\}/gi, firstName).replace(/\{nome_completo\}/gi, contact.name || '').trim();
}

async function processJourneyFollowups() {
  if (getStatus().status !== 'conectado') return { sent:0, reason:'whatsapp_offline' };
  const settings = loadSettings();
  if(outboundPolicy.mode(settings)==='strict')return {sent:0,reason:'account_protection_strict'};
  const now = new Date();
  if (!isWithinBusinessHours(now, settings)) return { sent:0, reason:'outside_business_hours' };
  const candidates = db.getJourneyFollowupCandidates(settings.journeyAutomations || {}, 10);
  let sent = 0;
  for (const contact of candidates) {
    const rule = settings.journeyAutomations?.[contact.journey_stage];
    if (!rule) continue;
    const text = render(rule.message, contact); if (!text) continue;
    const policy=outboundPolicy.check({settings,contact,kind:'journey',source:`jornada:${contact.journey_stage}`,text});
    if(!policy.allowed){
      if(policy.requiresApproval) ops.enqueueOutboundApproval({kind:'journey',contactId:contact.id,text,source:`jornada:${contact.journey_stage}`,category:policy.category,reason:policy.reason,uniqueKey:`journey:${contact.id}:${contact.journey_stage}:${contact.journey_updated_at||''}`,meta:{journeyStage:contact.journey_stage}});
      continue;
    }
    const result=await safetyEngine.withAutomationLock(async()=>{
      const fresh=db.getContactById(contact.id);
      const recheck=outboundPolicy.check({settings:loadSettings(),contact:fresh,kind:'journey',source:`jornada:${contact.journey_stage}`,text});
      if(!recheck.allowed)return {sent:false,reason:recheck.reason};
      try {
        await sendManualMessage(fresh.phone, text);
        db.logMessage(fresh.id, 'out', 'text', text, `jornada:${contact.journey_stage}`);
        db.touchOutbound(fresh.id);
        db.markJourneyFollowupSent(fresh.id, contact.journey_stage);
        db.updateContact(fresh.id, { next_action:'Acompanhar resposta do follow-up da jornada' }, { activity:false });
        return {sent:true};
      } catch (err) { console.error(`Follow-up da jornada falhou para ${fresh.phone}:`, err.message); ops.enqueueRetry({kind:'text_message',uniqueKey:`journey:${fresh.id}:${contact.journey_stage}:${contact.journey_updated_at||''}`,payload:{contactId:fresh.id,text,source:`jornada_retry:${contact.journey_stage}`,journeyStage:contact.journey_stage}}); ops.audit('journey_followup_queued_retry',{contactId:fresh.id,resource:'journey',resourceId:contact.journey_stage,details:{error:err.message}}); return {sent:false,reason:'send_error'}; }
    });
    if(result.sent){sent++;await new Promise((r)=>setTimeout(r,5000));}
  }
  return { sent };
}
module.exports = { processJourneyFollowups };
