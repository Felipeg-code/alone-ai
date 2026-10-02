// prospecting.js — fila sequencial de prospecção com limites operacionais, consentimento e opt-out.
const db = require('./db');
const ops = require('./ops');
const settingsStore = require('./settings');
const { sendText: sendManualMessage, getStatus } = require('./messaging-provider');
const { businessClock } = require('./flows');
const { isOptOutText } = require('./optout');
const outboundPolicy = require('./outbound-policy');
const safetyEngine = require('./safety-engine');

let processing = false;
let lastGlobalSendAt = 0;

function renderTemplate(template, contact) {
  const firstName = String(contact.name || '').trim().split(/\s+/)[0] || '';
  return String(template || '')
    .replace(/\{nome\}/gi, firstName)
    .replace(/\{nome_completo\}/gi, contact.name || '')
    .replace(/\{telefone\}/gi, contact.phone || '')
    .trim();
}

function withinProspectingWindow(settings, date = new Date()) {
  const clock=businessClock(date,settings); const hour=clock.hour;
  const start = Math.max(0, Math.min(23, Number(settings.prospectingStartHour ?? 8)));
  const end = Math.max(1, Math.min(24, Number(settings.prospectingEndHour ?? 20)));
  // A janela de campanha é independente do expediente do atendimento.
  // Antes as duas regras eram cruzadas e uma campanha podia ficar bloqueada mesmo dentro da janela configurada aqui.
  return hour >= start && hour < end;
}

async function processProspectingQueue(campaignId=null) {
  if (processing) return { ok:false, reason:'busy' };
  processing = true;
  try {
    const settings = settingsStore.loadSettings();
    const recovered = db.recoverStuckProspectQueue(5);
    if (recovered) ops.audit('prospecting_stuck_queue_recovered',{resource:'prospect_queue',details:{recovered}});
    if (!settings.prospectingEnabled) return { ok:false, reason:'disabled', diagnostics:getProspectingDiagnostics(settings) };
    const protection=outboundPolicy.mode(settings);
    if(protection!=='off') return {ok:false,reason:'account_protection_campaigns_blocked',diagnostics:getProspectingDiagnostics(settings)};
    if (getStatus().status !== 'conectado') return { ok:false, reason:'whatsapp_offline', diagnostics:getProspectingDiagnostics(settings) };
    if (!withinProspectingWindow(settings)) return { ok:false, reason:'outside_window', diagnostics:getProspectingDiagnostics(settings) };
    if (db.countGlobalProspectSendsToday() >= Number(settings.prospectingGlobalDailyLimit || 150)) return { ok:false, reason:'global_daily_limit', diagnostics:getProspectingDiagnostics(settings) };

    const campaigns = db.listProspectCampaigns().filter((c) => c.status === 'running' && (campaignId==null || Number(c.id)===Number(campaignId))).sort((a,b) => a.id-b.id);
    for (const campaign of campaigns) {
      if (!campaign.confirmed_permission) continue;
      if (!campaign.initial_message) continue;
      if (db.countCampaignSendsToday(campaign.id) >= campaign.daily_limit) continue;
      const minInterval = Math.max(Number(settings.prospectingMinIntervalSeconds || 60), Number(campaign.interval_seconds || 120));
      const campaignLast = campaign.last_sent_at ? new Date(campaign.last_sent_at).getTime() : 0;
      const persistedGlobalLast=db.getLastGlobalProspectSendAt()?new Date(db.getLastGlobalProspectSendAt()).getTime():0;
      const lastSend = Math.max(campaignLast, lastGlobalSendAt, persistedGlobalLast);
      if (lastSend && Date.now() - lastSend < minInterval * 1000) continue;

      // Descarta bloqueios locais rapidamente. Antes, um contato inválido consumia um ciclo inteiro
      // do scheduler e fazia uma campanha grande parecer travada.
      for (let guard=0; guard<100; guard++) {
        const item = db.getNextProspectQueueItem(campaign.id);
        if (!item) break;
        const contact = db.getContactById(item.contact_id);
        if (!contact) { db.markProspectSkipped(item.id, 'Contato inexistente'); continue; }
        if (contact.opted_out || contact.consent_status === 'opted_out') { db.markProspectSkipped(item.id, 'Contato opt-out'); continue; }
        if (contact.consent_status !== 'opted_in') { db.markProspectSkipped(item.id, 'Sem confirmação de permissão para contato'); continue; }

        const text = renderTemplate(campaign.initial_message, contact);
        if (!text) { db.markProspectSkipped(item.id, 'Mensagem inicial vazia'); continue; }
        const policy=outboundPolicy.check({settings,contact,kind:'campaign',source:`prospeccao:${campaign.id}`});
        if(!policy.allowed){
          if(policy.requiresApproval){ops.enqueueOutboundApproval({kind:'campaign',contactId:contact.id,text,source:`prospeccao:${campaign.id}`,category:policy.category,reason:policy.reason,uniqueKey:`campaign:${campaign.id}:${item.id}`,meta:{campaignId:campaign.id,prospectQueueId:item.id,stage:campaign.stage,agentId:campaign.created_by_agent_id}});return {ok:false,reason:'approval_required',campaignId:campaign.id,contactId:contact.id,queueId:item.id,diagnostics:getProspectingDiagnostics(settings)};}
          if(['marketing_consent_missing','opted_out','category_consent_missing'].includes(policy.reason)){db.markProspectSkipped(item.id,policy.reason);continue;}
          return {ok:false,reason:policy.reason,campaignId:campaign.id,contactId:contact.id,diagnostics:getProspectingDiagnostics(settings)};
        }
        return await safetyEngine.withAutomationLock(async()=>{
          const fresh=db.getContactById(contact.id);
          const recheck=outboundPolicy.check({settings:settingsStore.loadSettings(),contact:fresh,kind:'campaign',source:`prospeccao:${campaign.id}`});
          if(!recheck.allowed)return {ok:false,reason:recheck.reason,campaignId:campaign.id,contactId:contact.id,queueId:item.id,diagnostics:getProspectingDiagnostics(settingsStore.loadSettings())};
          db.markProspectSending(item.id);
          try {
            await sendManualMessage(fresh.phone, text);
            db.logMessage(fresh.id, 'out', 'text', text, `prospeccao:${campaign.id}`, campaign.created_by_agent_id);
            db.touchOutbound(fresh.id);
            db.updateContact(fresh.id, {
              lead_source:'prospeccao', prospecting_campaign_id:campaign.id, prospecting_origin:campaign.name,
              last_prospect_at:new Date().toISOString(), next_action:'Aguardar resposta do primeiro contato'
            }, { activity:false });
            db.setJourneyStage(fresh.id, campaign.stage, { reason:`campanha:${campaign.id}`, agentId:campaign.created_by_agent_id });
            db.markProspectSent(item.id);
            lastGlobalSendAt = Date.now();
            db.completeFinishedCampaigns();
            return { ok:true, campaignId:campaign.id, contactId:fresh.id, queueId:item.id, diagnostics:getProspectingDiagnostics(settingsStore.loadSettings()) };
          } catch (err) {
            const failed=db.markProspectFailed(item.id, err.message);
            ops.audit('prospecting_send_retry_scheduled',{agentId:campaign.created_by_agent_id,contactId:fresh.id,resource:'prospect_queue',resourceId:item.id,details:{error:err.message,campaignId:campaign.id,attempts:failed?.attempts,nextAttemptAt:failed?.next_attempt_at,status:failed?.status}});
            return { ok:false, reason:failed?.status==='failed'?'send_failed_permanently':'send_error_retry_scheduled', error:err.message, diagnostics:getProspectingDiagnostics(settingsStore.loadSettings()) };
          }
        });
      }
    }
    db.completeFinishedCampaigns();
    if(campaignId!=null && !campaigns.length) return {ok:false,reason:'campaign_not_running',campaignId:Number(campaignId),diagnostics:getProspectingDiagnostics(settings)};
    return { ok:false, reason:'nothing_due', campaignId:campaignId==null?null:Number(campaignId), diagnostics:getProspectingDiagnostics(settings) };
  } finally { processing = false; }
}

function getProspectingDiagnostics(settings = settingsStore.loadSettings()) {
  const status=getStatus().status;
  const campaigns=db.listProspectCampaigns();
  const running=campaigns.filter(c=>c.status==='running');
  const pending=running.reduce((n,c)=>n+Number(c.metrics?.pending||0),0);
  const sending=running.reduce((n,c)=>n+Number((db.listProspectQueue(c.id,5000)||[]).filter(q=>q.status==='sending').length),0);
  const blockedPermission=running.filter(c=>!c.confirmed_permission).length;
  const emptyMessage=running.filter(c=>!String(c.initial_message||'').trim()).length;
  const outsideWindow=!withinProspectingWindow(settings);
  const dailyUsed=db.countGlobalProspectSendsToday();
  const dailyLimit=Number(settings.prospectingGlobalDailyLimit||150);
  let reason='ready';
  if(outboundPolicy.mode(settings)!=='off')reason='account_protection_campaigns_blocked';
  else if(String(settings.outboundAutomationMode||'approval')!=='automatic')reason='approval_mode';
  else if(!settings.prospectingEnabled)reason='disabled';
  else if(status!=='conectado')reason='whatsapp_offline';
  else if(outsideWindow)reason='outside_window';
  else if(dailyUsed>=dailyLimit)reason='global_daily_limit';
  else if(!running.length)reason='no_running_campaign';
  else if(!pending&&!sending)reason='no_pending_contacts';
  else if(blockedPermission===running.length)reason='permission_missing';
  else if(emptyMessage===running.length)reason='message_missing';
  const clock=businessClock(new Date(),settings);
  const campaignsDetail=running.map(c=>{const q=db.listProspectQueue(c.id,5000)||[];const eligible=q.filter(x=>x.status==='pending'&&x.contact&&!x.contact.opted_out&&x.contact.consent_status==='opted_in').length;const unknown=q.filter(x=>x.status==='pending'&&x.contact&&x.contact.consent_status!=='opted_in'&&!x.contact.opted_out).length;return {id:c.id,name:c.name,pending:Number(c.metrics?.pending||0),sent:Number(c.metrics?.sent||0),failed:Number(c.metrics?.failed||0),skipped:Number(c.metrics?.skipped||0),eligible,unknownConsent:unknown,permission:Boolean(c.confirmed_permission),hasMessage:Boolean(String(c.initial_message||'').trim())};});
  return {reason,accountProtectionMode:outboundPolicy.mode(settings),automationMode:String(settings.outboundAutomationMode||'approval'),whatsappStatus:status,enabled:Boolean(settings.prospectingEnabled),outsideWindow,runningCampaigns:running.length,pending,sending,blockedPermission,emptyMessage,dailyUsed,dailyLimit,currentHour:clock.hour,currentMinute:clock.minute,timezone:clock.timeZone,campaigns:campaignsDetail};
}

module.exports = { processProspectingQueue, processProspectingCampaign:(campaignId)=>processProspectingQueue(campaignId), withinProspectingWindow, renderTemplate, isOptOutText, getProspectingDiagnostics };
