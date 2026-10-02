// scheduler.js — checagens automáticas enquanto o programa estiver aberto, com heartbeat para a central de saúde.
const cron = require('node-cron');
const db = require('./db');
const { loadFlows } = require('./flows');
const settingsStore = require('./settings');
const { sendResponse: sendCampaignMessage } = require('./messaging-provider');
const { processProspectingQueue } = require('./prospecting');
const ops = require('./ops');
const { processRetryQueue } = require('./reliability');
const { processJourneyFollowups } = require('./journey');
const { processProactiveFollowups } = require('./proactivity');
const outboundPolicy = require('./outbound-policy');
const safetyEngine = require('./safety-engine');

const INACTIVE_DAYS = 21;
const runtime={started:false,startedAt:null,lastProspectingAt:null,lastProactiveAt:null,lastRetryAt:null,lastBackupAt:null,lastJourneyAt:null,lastReactivationAt:null,lastError:null};
function stamp(key){runtime[key]=new Date().toISOString();}
function fail(err){runtime.lastError=String(err?.message||err).slice(0,500);}
function getSchedulerStatus(){return {...runtime};}

function startScheduler() {
  if(runtime.started)return;
  runtime.started=true;runtime.startedAt=new Date().toISOString();
  cron.schedule('*/15 * * * * *', async () => {
    stamp('lastProspectingAt');
    try { await processProspectingQueue(); }
    catch (err) { fail(err); console.error('Erro no processador de prospecção:', err.message); }
  });
  cron.schedule('*/30 * * * * *', async () => {
    stamp('lastProactiveAt');
    try { await processProactiveFollowups(); }
    catch (err) { fail(err); console.error('Erro na proatividade comercial:', err.message); }
  });
  cron.schedule('*/2 * * * *', async () => {
    stamp('lastRetryAt');
    try { await processRetryQueue(); }
    catch (err) { fail(err); console.error('Erro no retry persistente:', err.message); }
  });
  const schedulerTimezone=String(settingsStore.loadSettings().businessTimezone||'America/Sao_Paulo');
  cron.schedule('15 2 * * *', () => {
    stamp('lastBackupAt');
    try { ops.createBackup('automatico'); console.log('💾 Backup automático concluído.'); }
    catch (err) { fail(err); console.error('Erro no backup automático:', err.message); }
  }, {timezone:schedulerTimezone});
  cron.schedule('*/15 * * * *', async () => {
    stamp('lastJourneyAt');
    try { await processJourneyFollowups(); }
    catch (err) { fail(err); console.error('Erro nos follow-ups de jornada:', err.message); }
  });
  cron.schedule('0 10 * * *', async () => {
    stamp('lastReactivationAt');
    const settings=settingsStore.loadSettings();
    if(!settings.reactivationCampaignEnabled) return;
    console.log('⏰ Rodando checagem de clientes inativos...');
    const flows = loadFlows();
    const flow = flows['reativacaoInativos'];
    if (!flow) return;
    const candidates = db.findInactive(INACTIVE_DAYS);
    let sent = 0;
    for (const contact of candidates) {
      if (contact.opted_out || contact.consent_status !== 'opted_in') continue;
      const ledger=db.getConsentLedger(contact.id);
      if(ledger?.categories?.reactivation!=='opted_in')continue;
      const policy=outboundPolicy.check({settings,contact,kind:'proactive',source:'reativacao:agendada'});
      if(!policy.allowed){
        if(policy.requiresApproval){
          const firstText=(flow.responses||[]).map(r=>r?.text||'').find(Boolean)||'Reativação programada';
          ops.enqueueOutboundApproval({kind:'proactive',contactId:contact.id,text:firstText,source:'reativacao:agendada',category:'reactivation',reason:policy.reason,uniqueKey:`reactivation:${contact.id}:${contact.last_campaign_sent_at||''}`,meta:{reactivation:true}});
        }
        continue;
      }
      const reactivation=await safetyEngine.withAutomationLock(async()=>{
        const fresh=db.getContactById(contact.id);
        const currentSettings=settingsStore.loadSettings();
        const recheck=outboundPolicy.check({settings:currentSettings,contact:fresh,kind:'proactive',source:'reativacao:agendada'});
        if(!recheck.allowed)return {sent:false,reason:recheck.reason};
        try {
          let delivered=0;
          for (const response of flow.responses) {
            try {
              await sendCampaignMessage(fresh.phone, response);
              db.logMessage(fresh.id, 'out', response.type, response.text || response.file, 'reativacaoInativos');
              delivered++;
            } catch (mediaErr) { console.warn(`Reativação: item não enviado para ${fresh.phone}:`, mediaErr.message); }
            await new Promise((r) => setTimeout(r, 1500));
          }
          if(!delivered) throw new Error('Nenhuma mensagem da reativação pôde ser enviada');
          db.updateContact(fresh.id, { next_action: 'Acompanhar resposta da campanha de reativação' }, { activity: false });
          db.setJourneyStage(fresh.id, 'reativacao', { reason:'campanha_reativacao' });
          db.markCampaignSent(fresh.id); db.touchOutbound(fresh.id);
          return {sent:true};
        } catch (err) { fail(err); console.error(`Erro ao enviar reativação para ${fresh.phone}:`, err.message); return {sent:false,reason:'send_error'}; }
      });
      if(reactivation.sent){sent++;const gap=Math.max(0,Number(settingsStore.loadSettings().safetyMinAutomatedGapSeconds||10))*1000;if(gap)await new Promise(r=>setTimeout(r,gap));}
    }
    console.log(`✅ Campanha de reativação enviada para ${sent} contato(s).`);
  }, {timezone:schedulerTimezone});
  console.log('🗓️  Agendador iniciado: prospecção + proatividade + retry persistente + backup + jornada + reativação.');
}
module.exports = { startScheduler, getSchedulerStatus };
