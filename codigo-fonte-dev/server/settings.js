const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const SETTINGS_PATH = path.join(dataDir, 'settings.json');
const SECRETS_PATH = path.join(dataDir, 'secrets.json');

const DEFAULTS = {
  themeColor: '#FF6A00', gymName: 'Sua empresa', businessType:'general', businessDescription:'', businessTimezone:'America/Sao_Paulo', businessHours: 'Seg-Sex 6h-11h e 14h-22h, Sáb 8h-12h, Dom 9h-12h',
  businessSchedule: {
    0:[[9*60,12*60]], 1:[[6*60,11*60],[14*60,22*60]], 2:[[6*60,11*60],[14*60,22*60]],
    3:[[6*60,11*60],[14*60,22*60]], 4:[[6*60,11*60],[14*60,22*60]], 5:[[6*60,11*60],[14*60,22*60]], 6:[[8*60,12*60]],
  },
  aiEnabled: false, aiUserPreferenceSet: false, geminiApiKey: '', geminiModel: 'gemini-3.8-flash',
  learnedStyleProfile: '', learnedBusinessProfile: '', learnedKnowledge: {},
  historyScanStatus: 'nunca_rodado', historyScanRunAt: null, historyMessagesAnalyzed: 0, historyLastMessageIdAnalyzed: 0,
  aiBootstrapStatus: 'aguardando_whatsapp', aiBootstrapStartedAt: null, aiBootstrapCompletedAt: null, aiBootstrapError: '',
  aiBootstrapImportedMessages: 0, aiBootstrapTotalMessages: 0, aiBootstrapTotalContacts: 0, aiBootstrapEligibleContacts: 0, aiBootstrapSkippedContacts: 0, aiBootstrapProfiledContacts: 0,
  aiBootstrapPhase: 'aguardando', aiBootstrapPercent: 0, aiBootstrapCurrent: '',
  aiBootstrapAutoStart: true, aiReady: false, aiBootstrapControl: 'running', aiBootstrapQuality: '',
  aiBootstrapMaxMessages: 280, aiBootstrapMaxContacts: 10, aiBootstrapContactMessages: 20,
  aiBootstrapCompanyConcurrency: 2, aiBootstrapContactConcurrency: 5, aiBootstrapCompanyCharBudget: 62000, aiBootstrapBudgetMs: 95000,
  aiBootstrapSampledMessages: 0, aiBootstrapTargetContacts: 0, aiBootstrapDeferredContacts: 0,
  aiBootstrapGeneratedFlows: 0, aiBootstrapGeneratedQuickReplies: 0, aiBootstrapLearnedRules: 0,
  aiBootstrapKnowledgeItems: 0, aiBootstrapKnowledgeGaps: 0, aiBootstrapProspectingDrafts: 0, aiBootstrapSeededContacts: 0,
  aiMode: 'autonomo', autoRoutingEnabled: true, autoCustomerProfiling: true, aiContextMessages: 30,
  agentDelayMinMs: 1200, agentDelayMaxMs: 3400,
  continuousLearningEnabled: true, continuousLearningBatchMessages: 8, continuousLearningMinIntervalMinutes: 15, continuousLearningProfileLimit: 4,
  continuousLearningLastAt: null, continuousLearningStatus: 'aguardando_novas_mensagens', continuousLearningLastNewMessages: 0,
  continuousLearningRuns: 0, continuousLearningFailures: 0, continuousLearningLastDurationMs: 0, continuousLearningLastProfiled: 0, continuousLearningLastKnowledgeDelta: 0, continuousLearningLastError: '',
  knowledgeGapDetection: true, browserNotifications: true,
  accountProtectionMode:'strict', accountProtectionWindowHours:24, outboundAutomationMode:'approval', safetyHealthEnabled:true, safetyCircuitBreakerEnabled:true, safetyCircuitBreakerThreshold:45, safetyWarningThreshold:70, safetyMaxAutomatedInitiationsPerHour:20, safetyMaxAutomatedInitiationsPerDay:40, safetyRestrictionCooldownHours:48, safetyRateLimitCooldownHours:6, safetyRateLimitReconnectMinutes:30, safetyRecoveryProbationHours:24, safetyRecoveryLimitPercent:25, safetyReconnectStormWindowMinutes:15, safetyReconnectStormLimit:4, safetyApprovalMaxAgeHours:24, safetyMinAutomatedGapSeconds:10,
  prospectingEnabled: false, prospectingMinIntervalSeconds: 180, prospectingGlobalDailyLimit: 30,
  prospectingStartHour: 8, prospectingEndHour: 20, reactivationCampaignEnabled:false, prospectingOptOutKeywords: ['sair','parar','não quero','nao quero','remover','cancelar mensagens'],
  proactiveEnabled: false, proactiveUserPreferenceSet:false,
  proactiveGlobalMinIntervalSeconds: 120,
  proactiveDailyLimit: 30,
  commercialContactWindowDays: 7, commercialContactLimit: 10,
  proactiveScenarios: {
    plans_silence:{enabled:true,label:'Pediu preço/oferta e sumiu',silenceHours:3,minScore:35,maxAttempts:2,betweenAttemptsHours:20,messages:['Oi {nome}! Conseguiu dar uma olhada no que te enviamos? Se quiser, eu te ajudo a escolher a melhor opção.','Oi {nome}! Ficou alguma dúvida sobre as opções ou valores? Posso te explicar por aqui.']},
    hot_silence:{enabled:true,label:'Lead quente em silêncio',silenceHours:6,minScore:75,maxAttempts:2,betweenAttemptsHours:24,messages:['Oi {nome}! Passando porque vi que você estava avaliando com a gente. Ficou alguma dúvida ou posso te ajudar no próximo passo?','Oi {nome}! Se ainda estiver pensando, me fala o que está pesando na decisão que eu tento te ajudar por aqui.']},
    closing_silence:{enabled:true,label:'Fechamento sem resposta',silenceHours:4,minScore:55,maxAttempts:3,betweenAttemptsHours:18,messages:['Oi {nome}! Ficou tudo certo por aí? Se quiser, posso te ajudar a finalizar ou tirar alguma dúvida antes.','Oi {nome}! Só passando para saber se ficou alguma pendência para conseguirmos seguir.','Oi {nome}! Vou deixar você à vontade, mas se ainda quiser seguir ou tiver alguma dúvida, é só me chamar por aqui.']},
    unanswered_segment:{enabled:true,label:'Aguardando cliente - ação manual',silenceHours:1,minScore:0,maxAttempts:1,betweenAttemptsHours:24,messages:['Oi {nome}! Passando para saber se conseguiu ver minha última mensagem. Ficou alguma dúvida?']}
  },
  journeyAutomations: {
    fechamento:{enabled:true,delayHours:24,message:'Oi {nome}! Passando para saber se ficou alguma dúvida e se posso te ajudar com o próximo passo.'},
    agendamento_avaliacao:{enabled:true,delayHours:24,message:'Oi {nome}! Ficou tudo certo para o seu agendamento? Se precisar ajustar o horário, me avisa por aqui.'},
    pos_avaliacao:{enabled:true,delayHours:3,message:'Oi {nome}! Como foi seu atendimento? Se ficou alguma dúvida, pode me chamar por aqui.'},
    primeiro_treino:{enabled:true,delayHours:12,message:'Oi {nome}! Como foi esse primeiro passo com a gente? Se precisar de ajuda nessa fase inicial, estou por aqui.'},
    acompanhamento:{enabled:true,delayHours:168,message:'Oi {nome}! Passando para acompanhar como estão as coisas por aí. Ficou alguma dúvida ou precisa de ajuda com algo?'},
    cancelamento:{enabled:true,delayHours:24,message:'Oi {nome}. Passando apenas para confirmar se ficou tudo certo com o encerramento. Se precisar de algo, seguimos à disposição.'},
    pos_cancelamento:{enabled:true,delayHours:720,message:'Oi {nome}! Faz um tempo desde nosso último contato. Se em algum momento fizer sentido voltar a falar com a gente, pode chamar por aqui.'},
    reativacao:{enabled:false,delayHours:336,message:'Oi {nome}! Passando para saber como você está e se podemos ajudar em uma nova necessidade por aqui.'}
  },
};
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return {}; } }
function writeJSONAtomic(file, value) { fs.mkdirSync(dataDir,{recursive:true}); const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8'); fs.renameSync(tmp,file); }
function migrateLegacySecret(stored) {
  if (!stored?.geminiApiKey) return stored || {};
  const secrets = readJSON(SECRETS_PATH);
  if (!secrets.geminiApiKey) writeJSONAtomic(SECRETS_PATH,{...secrets,geminiApiKey:stored.geminiApiKey});
  const clean={...stored}; delete clean.geminiApiKey; writeJSONAtomic(SETTINGS_PATH,clean); return clean;
}
const RETIRED_GEMINI_MODELS = new Set(['gemini-2.0-flash','models/gemini-2.0-flash','gemini-2.0-flash-001','gemini-2.0-flash-lite','gemini-2.0-flash-lite-001','gemini-1.5-flash','gemini-1.5-pro','gemini-pro']);

function migrateBrandSeparation(stored={}) {
  if(String(stored.gymName||'').trim()==='Alone.AI'){
    const updated={...stored,gymName:'Sua empresa'};
    try{writeJSONAtomic(SETTINGS_PATH,updated);}catch(_){}
    return updated;
  }
  return stored;
}


function migrateGenericBusinessDefaults(stored={}) {
  const next={...stored}; let changed=false;
  if(!next.businessType){next.businessType='general';changed=true;}
  if(next.businessDescription===undefined){next.businessDescription='';changed=true;}
  const ps=next.proactiveScenarios&&typeof next.proactiveScenarios==='object'?JSON.parse(JSON.stringify(next.proactiveScenarios)):null;
  if(ps?.plans_silence){
    if(ps.plans_silence.label==='Pediu planos e sumiu'){ps.plans_silence.label='Pediu preço/oferta e sumiu';changed=true;}
    const msgs=ps.plans_silence.messages||[];
    if(msgs[0]==='Oi {nome}! Conseguiu dar uma olhada nos planos? Se quiser, eu te ajudo a escolher o que faz mais sentido pra você.'){msgs[0]='Oi {nome}! Conseguiu dar uma olhada no que te enviamos? Se quiser, eu te ajudo a escolher a melhor opção.';changed=true;}
    if(msgs[1]==='Oi {nome}! Ficou alguma dúvida sobre os planos ou valores? Posso te explicar por aqui.'){msgs[1]='Oi {nome}! Ficou alguma dúvida sobre as opções ou valores? Posso te explicar por aqui.';changed=true;}
    next.proactiveScenarios=ps;
  }
  const ja=next.journeyAutomations&&typeof next.journeyAutomations==='object'?JSON.parse(JSON.stringify(next.journeyAutomations)):null;
  const map={
    agendamento_avaliacao:['Oi {nome}! Ficou tudo certo para sua avaliação? Se precisar ajustar o horário, me avisa por aqui.','Oi {nome}! Ficou tudo certo para o seu agendamento? Se precisar ajustar o horário, me avisa por aqui.'],
    pos_avaliacao:['Oi {nome}! Como você se sentiu depois da avaliação? Se ficou alguma dúvida, pode me chamar por aqui.','Oi {nome}! Como foi seu atendimento? Se ficou alguma dúvida, pode me chamar por aqui.'],
    primeiro_treino:['Oi {nome}! Como foi seu primeiro treino? Quero saber como você se sentiu para acompanharmos bem esse começo.','Oi {nome}! Como foi esse primeiro passo com a gente? Se precisar de ajuda nessa fase inicial, estou por aqui.'],
    acompanhamento:['Oi {nome}! Passando para acompanhar como está sua rotina de treinos nesta semana. Como você está se sentindo?','Oi {nome}! Passando para acompanhar como estão as coisas por aí. Ficou alguma dúvida ou precisa de ajuda com algo?'],
    pos_cancelamento:['Oi {nome}! Faz um tempo desde nosso último contato. Se em algum momento fizer sentido retomar seus treinos, pode falar com a gente por aqui.','Oi {nome}! Faz um tempo desde nosso último contato. Se em algum momento fizer sentido voltar a falar com a gente, pode chamar por aqui.'],
    reativacao:['Oi {nome}! Passando para saber como você está e se podemos ajudar no seu retorno aos treinos.','Oi {nome}! Passando para saber como você está e se podemos ajudar em uma nova necessidade por aqui.']
  };
  if(ja){for(const [k,[oldMsg,newMsg]] of Object.entries(map)){if(ja[k]?.message===oldMsg){ja[k].message=newMsg;changed=true;}}next.journeyAutomations=ja;}
  if(changed){try{writeJSONAtomic(SETTINGS_PATH,next);}catch(_){}}
  return next;
}

function migrateAccountProtection(stored={}) {
  if(stored.accountProtectionMode!==undefined)return stored;
  const next={...stored,accountProtectionMode:'strict',accountProtectionWindowHours:24};
  try{writeJSONAtomic(SETTINGS_PATH,next);}catch(_){}
  return next;
}
function migrateGeminiModel(stored={}) {
  const raw=String(stored.geminiModel||'').trim();
  if(!raw || RETIRED_GEMINI_MODELS.has(raw)) {
    const updated={...stored,geminiModel:'gemini-3.8-flash'};
    try { writeJSONAtomic(SETTINGS_PATH,updated); } catch (_) {}
    return updated;
  }
  return stored;
}
function normalizeSchedule(schedule) {
  if(!schedule || typeof schedule!=='object' || Array.isArray(schedule)) return null;
  const out={};
  for(let day=0;day<7;day++){
    const ranges=Array.isArray(schedule[day])?schedule[day]:Array.isArray(schedule[String(day)])?schedule[String(day)]:[];
    out[day]=ranges.map(r=>Array.isArray(r)?[Number(r[0]),Number(r[1])]:null)
      .filter(r=>r && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0]>=0 && r[1]<=1440 && r[1]>r[0]);
  }
  return out;
}
function validateScheduleInput(schedule){
  if(!schedule || typeof schedule!=='object' || Array.isArray(schedule)) throw new Error('Agenda de atendimento inválida.');
  for(let day=0;day<7;day++){
    const ranges=Array.isArray(schedule[day])?schedule[day]:Array.isArray(schedule[String(day)])?schedule[String(day)]:[];
    if(!Array.isArray(ranges)) throw new Error(`Agenda inválida no dia ${day}.`);
    for(const range of ranges){
      if(!Array.isArray(range)||range.length<2) throw new Error(`Faixa de horário inválida no dia ${day}.`);
      const a=Number(range[0]),b=Number(range[1]);
      if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>=1440||b<=0||b>1440||b<=a){
        throw new Error(`Horário inválido no dia ${day}: início e fim precisam formar uma faixa válida.`);
      }
    }
  }
  return true;
}
function minsToText(mins){const h=Math.floor(Number(mins)/60),m=Number(mins)%60;return m?`${h}:${String(m).padStart(2,'0')}`:`${h}h`;}
function scheduleToText(schedule={}) {
  const names=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']; const parts=[];
  for(let d=0;d<7;d++){
    const ranges=Array.isArray(schedule[d])?schedule[d]:[];
    if(ranges.length) parts.push(`${names[d]} ${ranges.map(([a,b])=>`${minsToText(a)}-${minsToText(b)}`).join(' e ')}`);
  }
  return parts.join(' / ');
}
function loadSettings() {
  let stored = migrateAccountProtection(migrateGenericBusinessDefaults(migrateBrandSeparation(migrateGeminiModel(migrateLegacySecret(readJSON(SETTINGS_PATH))))));
  const secrets = readJSON(SECRETS_PATH);
  const merged={ ...DEFAULTS, ...stored, geminiApiKey: process.env.GEMINI_API_KEY || secrets.geminiApiKey || '' };
  if(!stored.proactiveUserPreferenceSet) merged.proactiveEnabled=false;
  const normalized=normalizeSchedule(merged.businessSchedule);
  if(normalized){ merged.businessSchedule=normalized; merged.businessHours=scheduleToText(normalized) || merged.businessHours; }
  process.env.ALONE_BUSINESS_TZ=String(merged.businessTimezone||'America/Sao_Paulo');
  return merged;
}
function saveSettings(partial) {
  const currentFile = migrateBrandSeparation(migrateLegacySecret(readJSON(SETTINGS_PATH)));
  const clean = { ...partial };
  if (Object.prototype.hasOwnProperty.call(clean,'businessSchedule')) {
    validateScheduleInput(clean.businessSchedule);
    const normalized=normalizeSchedule(clean.businessSchedule);
    if(!normalized) throw new Error('Agenda de atendimento inválida.');
    clean.businessSchedule=normalized;
    clean.businessHours=scheduleToText(normalized);
  }
  if(Object.prototype.hasOwnProperty.call(clean,'accountProtectionMode')){const m=String(clean.accountProtectionMode||'strict').toLowerCase();if(!['strict','balanced','off'].includes(m))throw new Error('Nível de proteção da conta inválido.');clean.accountProtectionMode=m;}
  if(Object.prototype.hasOwnProperty.call(clean,'accountProtectionWindowHours'))clean.accountProtectionWindowHours=Math.max(1,Math.min(72,Number(clean.accountProtectionWindowHours||24)));
  if(Object.prototype.hasOwnProperty.call(clean,'outboundAutomationMode')){const m=String(clean.outboundAutomationMode||'approval').toLowerCase();if(!['manual','approval','automatic'].includes(m))throw new Error('Modo de outbound inválido.');clean.outboundAutomationMode=m;}
  if(Object.prototype.hasOwnProperty.call(clean,'safetyCircuitBreakerThreshold'))clean.safetyCircuitBreakerThreshold=Math.max(10,Math.min(80,Number(clean.safetyCircuitBreakerThreshold||45)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyWarningThreshold'))clean.safetyWarningThreshold=Math.max(30,Math.min(95,Number(clean.safetyWarningThreshold||70)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyMaxAutomatedInitiationsPerHour'))clean.safetyMaxAutomatedInitiationsPerHour=Math.max(1,Math.min(100,Number(clean.safetyMaxAutomatedInitiationsPerHour||20)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyMaxAutomatedInitiationsPerDay'))clean.safetyMaxAutomatedInitiationsPerDay=Math.max(1,Math.min(500,Number(clean.safetyMaxAutomatedInitiationsPerDay||40)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyRestrictionCooldownHours'))clean.safetyRestrictionCooldownHours=Math.max(1,Math.min(168,Number(clean.safetyRestrictionCooldownHours||48)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyRateLimitCooldownHours'))clean.safetyRateLimitCooldownHours=Math.max(1,Math.min(48,Number(clean.safetyRateLimitCooldownHours||6)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyRateLimitReconnectMinutes'))clean.safetyRateLimitReconnectMinutes=Math.max(5,Math.min(120,Number(clean.safetyRateLimitReconnectMinutes||30)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyRecoveryProbationHours'))clean.safetyRecoveryProbationHours=Math.max(0,Math.min(168,Number(clean.safetyRecoveryProbationHours||24)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyRecoveryLimitPercent'))clean.safetyRecoveryLimitPercent=Math.max(10,Math.min(100,Number(clean.safetyRecoveryLimitPercent||25)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyReconnectStormWindowMinutes'))clean.safetyReconnectStormWindowMinutes=Math.max(5,Math.min(120,Number(clean.safetyReconnectStormWindowMinutes||15)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyReconnectStormLimit'))clean.safetyReconnectStormLimit=Math.max(2,Math.min(20,Number(clean.safetyReconnectStormLimit||4)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyApprovalMaxAgeHours'))clean.safetyApprovalMaxAgeHours=Math.max(1,Math.min(168,Number(clean.safetyApprovalMaxAgeHours||24)));
  if(Object.prototype.hasOwnProperty.call(clean,'safetyMinAutomatedGapSeconds'))clean.safetyMinAutomatedGapSeconds=Math.max(0,Math.min(3600,Number(clean.safetyMinAutomatedGapSeconds||10)));
  clean.settingsUpdatedAt=new Date().toISOString();
  clean.settingsRevision=Number(currentFile.settingsRevision||0)+1;
  if (clean.geminiModel && RETIRED_GEMINI_MODELS.has(String(clean.geminiModel).trim())) clean.geminiModel='gemini-3.8-flash';
  if (Object.prototype.hasOwnProperty.call(clean,'geminiApiKey') || clean.clearGeminiApiKey===true) {
    const key=String(clean.geminiApiKey||'').trim(); delete clean.geminiApiKey;
    const secrets=readJSON(SECRETS_PATH);
    if(clean.clearGeminiApiKey===true){delete secrets.geminiApiKey;writeJSONAtomic(SECRETS_PATH,secrets);}
    else if(key) writeJSONAtomic(SECRETS_PATH,{...secrets,geminiApiKey:key});
  }
  delete clean.clearGeminiApiKey;
  const updated = { ...DEFAULTS, ...currentFile, ...clean };
  delete updated.geminiApiKey;
  writeJSONAtomic(SETTINGS_PATH,updated);
  return loadSettings();
}
function publicSettings() {
  const s = loadSettings(); const { geminiApiKey, ...rest } = s;
  return { ...rest, geminiKeyConfigured: Boolean(geminiApiKey && geminiApiKey.length > 10) };
}
module.exports = { loadSettings, saveSettings, publicSettings };
