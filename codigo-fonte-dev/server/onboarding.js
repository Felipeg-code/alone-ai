// onboarding.js — preparação automática da IA após conectar o WhatsApp.
// Consolida memória da empresa e cria perfil inicial dos contatos antes de liberar respostas automáticas.
const db = require('./db');
const settings = require('./settings');
const gemini = require('./gemini');
const { activeAgents } = require('./agents');
const ops = require('./ops');
const { loadFlows, saveFlows, newFlowKey, normalize } = require('./flows');

let runningPromise = null;
let connectionChecker = () => 'desconectado';
let continuousLearningTimer = null;

function setConnectionChecker(fn) { connectionChecker = typeof fn === 'function' ? fn : (() => 'desconectado'); }
function whatsappConnected() { try { return connectionChecker() === 'conectado'; } catch (_) { return false; } }
function markWaitingForWhatsApp({preserveReady=true}={}) {
  const s=settings.loadSettings();
  const hasMemory=Boolean(String(s.learnedStyleProfile||'').trim() && String(s.learnedBusinessProfile||'').trim());
  if (preserveReady && s.aiReady && hasMemory) {
    update({aiReady:true,aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:'Agente treinado · WhatsApp desconectado; aguardando reconexão',aiBootstrapError:''});
    return status();
  }
  update({
    aiReady:false, aiBootstrapStatus:'aguardando_whatsapp', aiBootstrapPhase:'aguardando_whatsapp',
    aiBootstrapPercent:0, aiBootstrapCurrent:'Conecte o WhatsApp para iniciar a preparação',
    aiBootstrapError:'', aiBootstrapStartedAt:null, aiBootstrapCompletedAt:null,
    aiBootstrapImportedMessages:0, aiBootstrapTotalMessages:0, aiBootstrapTotalContacts:0, aiBootstrapSampledMessages:0, aiBootstrapProfiledContacts:0,
    aiBootstrapTargetContacts:0, aiBootstrapDeferredContacts:0, aiBootstrapEligibleContacts:0, aiBootstrapSkippedContacts:0,
    aiBootstrapGeneratedFlows:0, aiBootstrapGeneratedQuickReplies:0, aiBootstrapLearnedRules:0,
    aiBootstrapKnowledgeItems:0, aiBootstrapKnowledgeGaps:0, aiBootstrapProspectingDrafts:0, aiBootstrapSeededContacts:0,
    historyScanStatus:'nunca_rodado'
  });
  return status();
}

const DEFAULT_FAST_MAX_MESSAGES = 280;
const DEFAULT_FAST_MAX_CONTACTS = 10;
const DEFAULT_CONTACT_MAX_MESSAGES = 20;
const DEFAULT_COMPANY_CHAR_BUDGET = 62000;
const DEFAULT_BOOTSTRAP_BUDGET_MS = 95000;

function uniqueMessages(messages=[]) {
  const seen=new Set(); const out=[];
  for(const m of messages){
    const key=String(m.id||m.external_id||`${m.contact_id||''}:${m.created_at||''}:${m.direction||''}:${String(m.body||'').slice(0,80)}`);
    if(seen.has(key)) continue; seen.add(key); out.push(m);
  }
  return out;
}

function evenlySample(items=[], count=0) {
  if(count<=0 || !items.length) return [];
  if(items.length<=count) return [...items];
  const out=[]; const step=(items.length-1)/Math.max(1,count-1);
  for(let i=0;i<count;i++) out.push(items[Math.round(i*step)]);
  return out;
}

function fitMessageBudget(messages=[], maxChars=DEFAULT_COMPANY_CHAR_BUDGET) {
  const out=[]; let chars=0;
  for(const m of [...messages].reverse()) {
    const cost=Math.max(40,String(m.body||'').length+70);
    if(out.length && chars+cost>maxChars) continue;
    out.push(m); chars+=cost;
    if(chars>=maxChars) break;
  }
  return out.reverse();
}

function localKnowledgeFallback(summaries=[], previous={}) {
  const flat=(key)=>[...new Set(summaries.flatMap(x=>Array.isArray(x?.[key])?x[key]:[]).filter(Boolean).map(x=>typeof x==='string'?x:JSON.stringify(x)))];
  const tones=flat('tone').slice(0,12), facts=flat('facts').slice(0,40), profiles=flat('customer_profiles').slice(0,20), risks=flat('risks').slice(0,20);
  const faq=[]; const processes=[]; const routing=[]; const outreach=[]; const gaps=flat('knowledge_gaps').slice(0,40);
  for(const x of summaries){for(const q of (x?.faq||[]))if(q?.question&&q?.answer)faq.push(q);for(const pr of (x?.processes||[]))if(pr?.topic)processes.push(pr);for(const r of (x?.routing||[]))if(r?.intent)routing.push(r);for(const o of (x?.outreach_patterns||[]))if(o?.message)outreach.push(o);}
  const inheritedStyle=String(previous.style_profile||'').trim();
  const inheritedBusiness=String(previous.business_profile||'').trim();
  const styleFallback=tones.length
    ? `Tom observado: ${tones.join('; ').slice(0,900)}`
    : 'Perfil inicial criado a partir do histórico sincronizado. O estilo será refinado conforme novas respostas da empresa forem observadas.';
  const businessFallback=facts.length
    ? `Padrões operacionais observados: ${facts.slice(0,16).join('; ').slice(0,1800)}`
    : `Memória operacional inicial criada a partir de ${summaries.length} bloco(s) de histórico. Ainda não há fatos comerciais recorrentes suficientes para consolidar detalhes sem risco de inventar informação.`;
  return {
    ...previous,
    style_profile: inheritedStyle || styleFallback,
    business_profile: inheritedBusiness || businessFallback,
    facts:facts.length?facts:(previous.facts||[]), faq:faq.slice(0,30), processes:processes.slice(0,20),
    customer_profiles:profiles.length?profiles:(previous.customer_profiles||[]), routing:routing.slice(0,20),
    knowledge_gaps:gaps.length?gaps:(previous.knowledge_gaps||[]), outreach_patterns:outreach.slice(0,20),
    do_not_do:[...(previous.do_not_do||[]),...risks].slice(0,30), fallback_local:true
  };
}


function localChunkFallback(messages=[]) {
  const outbound=messages.filter(m=>m.direction==='out').map(m=>String(m.body||'').trim()).filter(Boolean);
  const inbound=messages.filter(m=>m.direction==='in').map(m=>String(m.body||'').trim()).filter(Boolean);
  const signal=/\b(plano|pacote|assinatura|produto|servi[cç]o|or[cç]amento|proposta|cota[cç][aã]o|pre[cç]o|valor|mensalidade|matr[ií]cula|hor[aá]rio|consulta|reuni[aã]o|visita|demonstra[cç][aã]o|avalia[cç][aã]o|pagamento|pix|cart[aã]o|boleto|cancel|contrato|pedido|entrega|frete|promo[cç][aã]o|desconto|vencimento|agendar|agenda|suporte|garantia)\b/i;
  const facts=[...new Set(outbound.filter(x=>signal.test(x)).slice(-18))].map(x=>x.slice(0,280));
  const toneSamples=outbound.slice(-12);
  const questions=[...new Set(inbound.filter(x=>x.includes('?')||signal.test(x)).slice(-12))].map(x=>x.slice(0,180));
  return {
    tone:toneSamples.length?[`Amostra local de ${toneSamples.length} respostas da empresa disponível para inferir estilo`]:[],
    phrases:toneSamples.slice(-6).map(x=>x.slice(0,160)), facts,
    faq:questions.slice(0,8).map(q=>({question:q,answer:'Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.'})),
    processes:[], customer_profiles:[], routing:[],
    risks:['Fallback local utilizado porque o Gemini não produziu uma análise estruturada neste lote.'],
    fallback_local:true
  };
}

function selectRepresentativeMessages(messages=[], maxMessages=DEFAULT_FAST_MAX_MESSAGES) {
  const all=[...messages].filter(m=>String(m.body||'').trim()).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const max=Math.max(80,Math.min(1600,Number(maxMessages||DEFAULT_FAST_MAX_MESSAGES)));
  if(all.length<=max) return all;
  const signal=/\b(plano|pacote|assinatura|produto|servi[cç]o|or[cç]amento|proposta|cota[cç][aã]o|pre[cç]o|valor|mensalidade|matr[ií]cula|hor[aá]rio|consulta|reuni[aã]o|visita|demonstra[cç][aã]o|avalia[cç][aã]o|pagamento|pix|cart[aã]o|boleto|cancel|contrato|pedido|entrega|frete|promo[cç][aã]o|desconto|vencimento|agendar|agenda|suporte|garantia)\b/i;
  const recent=all.slice(-Math.floor(max*0.5));
  const businessSignals=all.filter(m=>m.direction==='out' && signal.test(String(m.body||''))).slice(-Math.floor(max*0.2));
  const customerSignals=all.filter(m=>m.direction==='in' && signal.test(String(m.body||''))).slice(-Math.floor(max*0.15));
  const temporal=evenlySample(all,Math.floor(max*0.25));
  return uniqueMessages([...temporal,...businessSignals,...customerSignals,...recent])
    .sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')))
    .slice(-max);
}

function sampleContactHistory(history=[], maxMessages=DEFAULT_CONTACT_MAX_MESSAGES) {
  const all=[...history].filter(m=>String(m.body||'').trim()).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const max=Math.max(12,Math.min(80,Number(maxMessages||DEFAULT_CONTACT_MAX_MESSAGES)));
  if(all.length<=max) return all;
  const signal=/\b(plano|pacote|assinatura|produto|servi[cç]o|or[cç]amento|proposta|cota[cç][aã]o|pre[cç]o|valor|mensalidade|matr[ií]cula|hor[aá]rio|consulta|reuni[aã]o|visita|demonstra[cç][aã]o|avalia[cç][aã]o|pagamento|pix|cart[aã]o|boleto|cancel|contrato|pedido|entrega|frete|promo[cç][aã]o|desconto|vencimento|agendar|agenda|suporte|garantia)\b|\b(objetivo|interess|quero|d[uú]vida|retorno)\b/i;
  const recent=all.slice(-Math.floor(max*0.62));
  const signals=all.filter(m=>signal.test(String(m.body||''))).slice(-Math.floor(max*0.25));
  const temporal=evenlySample(all,Math.max(4,Math.floor(max*0.22)));
  return uniqueMessages([...temporal,...signals,...recent])
    .sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')))
    .slice(-max);
}

async function mapLimit(items, limit, worker) {
  const out=new Array(items.length); let next=0, completed=0;
  async function run(){while(true){const i=next++;if(i>=items.length)return;out[i]=await worker(items[i],i,()=>++completed);}}
  await Promise.all(Array.from({length:Math.min(Math.max(1,limit),Math.max(1,items.length))},run)); return out;
}
function percent(part,total,start=0,span=100){return total?Math.min(99,Math.round(start+(part/total)*span)):Math.round(start+span);}


function chunkMessages(messages, maxChars = 22000) {
  const chunks=[]; let current=[], size=0;
  for(const m of messages){
    const len=String(m.body||'').length+100;
    if(current.length && size+len>maxChars){chunks.push(current);current=[];size=0;}
    current.push(m);size+=len;
  }
  if(current.length) chunks.push(current);
  return chunks;
}

function update(patch={}) { return settings.saveSettings({...patch,aiBootstrapLastUpdateAt:new Date().toISOString()}); }
function status() {
  const s=settings.loadSettings();
  return {
    status:s.aiBootstrapStatus,
    ready:Boolean(s.aiReady),
    startedAt:s.aiBootstrapStartedAt,
    completedAt:s.aiBootstrapCompletedAt,
    error:s.aiBootstrapError||'',
    importedMessages:Number(s.aiBootstrapImportedMessages||0),
    totalMessages:Number(s.aiBootstrapTotalMessages||0),
    totalContacts:Number(s.aiBootstrapTotalContacts||0),
    eligibleContacts:Number(s.aiBootstrapEligibleContacts||0),
    profiledContacts:Number(s.aiBootstrapProfiledContacts||0),
    targetContacts:Number(s.aiBootstrapTargetContacts||0),
    deferredContacts:Number(s.aiBootstrapDeferredContacts||0),
    sampledMessages:Number(s.aiBootstrapSampledMessages||0),
    generatedFlows:Number(s.aiBootstrapGeneratedFlows||0),
    generatedQuickReplies:Number(s.aiBootstrapGeneratedQuickReplies||0),
    learnedRules:Number(s.aiBootstrapLearnedRules||0),
    knowledgeItems:Number(s.aiBootstrapKnowledgeItems||0),
    knowledgeGaps:Number(s.aiBootstrapKnowledgeGaps||0),
    prospectingDrafts:Number(s.aiBootstrapProspectingDrafts||0),
    seededContacts:Number(s.aiBootstrapSeededContacts||0),
    skippedContacts:Number(s.aiBootstrapSkippedContacts||0),
    analyzedMessages:Number(s.historyMessagesAnalyzed||0),
    historyScanStatus:s.historyScanStatus,
    control:s.aiBootstrapControl||'running',
    phase:s.aiBootstrapPhase||s.aiBootstrapStatus||'aguardando',
    percent:Number(s.aiBootstrapPercent||0),
    current:s.aiBootstrapCurrent||'',
    lastUpdateAt:s.aiBootstrapLastUpdateAt||'',
    paused:(s.aiBootstrapControl||'running')==='paused',
    running:Boolean(runningPromise),
  };
}

async function waitForControl() {
  while(true){
    const s=settings.loadSettings(); const ctl=s.aiBootstrapControl||'running';
    if(ctl==='cancelled') throw new Error('Preparação cancelada pelo usuário');
    if(ctl!=='paused') return;
    await new Promise(r=>setTimeout(r,1000));
  }
}
function setControl(control){
  if(!['running','paused','cancelled'].includes(control)) throw new Error('Controle inválido');
  const s=settings.loadSettings();
  if(control==='paused'){
    if(s.aiReady) return status();
    update({
      aiBootstrapControl:'paused',
      aiBootstrapPausedStatus:s.aiBootstrapStatus==='pausado'?(s.aiBootstrapPausedStatus||'consolidando_empresa'):s.aiBootstrapStatus,
      aiBootstrapPausedPhase:s.aiBootstrapPhase||'',
      aiBootstrapPausedCurrent:s.aiBootstrapCurrent||'',
      aiBootstrapCurrent:`Pausado${s.aiBootstrapCurrent?` · ${s.aiBootstrapCurrent}`:''}`,
    });
  } else if(control==='running'){
    const restoreStatus=s.aiBootstrapStatus==='pausado'?(s.aiBootstrapPausedStatus||'consolidando_empresa'):s.aiBootstrapStatus;
    update({
      aiBootstrapControl:'running',
      aiBootstrapStatus:restoreStatus==='cancelado'?'consolidando_empresa':restoreStatus,
      aiBootstrapPhase:s.aiBootstrapPausedPhase||s.aiBootstrapPhase||'iniciando_analise',
      aiBootstrapCurrent:`Retomando${s.aiBootstrapPausedCurrent?` · ${s.aiBootstrapPausedCurrent}`:''}`,
      aiBootstrapError:'',
    });
  } else {
    update({aiBootstrapControl:'cancelled',aiBootstrapStatus:'cancelado',aiBootstrapPhase:'cancelado',aiBootstrapCurrent:'Preparação cancelada'});
  }
  return status();
}

function markHistoryImported(importedDelta=0) {
  if(!whatsappConnected()) return markWaitingForWhatsApp({preserveReady:true});
  const s=settings.loadSettings();
  const total=db.getMetrics().totalMessages;
  const keepReady=Boolean(s.aiReady && String(s.learnedStyleProfile||'').trim() && String(s.learnedBusinessProfile||'').trim());
  update({
    aiReady:keepReady,
    aiBootstrapStatus:keepReady?'pronto':'importando_historico',
    aiBootstrapImportedMessages:Number(s.aiBootstrapImportedMessages||0)+Number(importedDelta||0),
    aiBootstrapTotalMessages:total,
    aiBootstrapTotalContacts:db.getMetrics().totalContacts,
    aiBootstrapError:'',
    aiBootstrapPhase:'sincronizando_historico',
    aiBootstrapPercent:keepReady?100:Math.min(12,Math.max(3,Number(s.aiBootstrapPercent||3))),
    aiBootstrapCurrent:keepReady?`Agente pronto · sincronizando ${Number(importedDelta||0)} nova(s) mensagem(ns)`:`${Number(s.aiBootstrapImportedMessages||0)+Number(importedDelta||0)} mensagens importadas`,
  });
}


function responseExamplesFromMessages(messages=[]) {
  const groups=new Map();
  for(const m of messages){const id=String(m.contact_id||m.contactId||'');if(!id)continue;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(m);}
  const pairs=[];
  for(const list of groups.values()) {
    list.sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
    for(let i=0;i<list.length;i++) {
      const inbound=list[i]; if(inbound.direction!=='in'||!String(inbound.body||'').trim()) continue;
      const replies=[];
      for(let j=i+1;j<Math.min(list.length,i+5);j++) {
        const m=list[j];
        if(m.direction==='in') break;
        if(m.direction==='out'&&String(m.body||'').trim()) replies.push(String(m.body).trim());
        if(replies.length>=2) break;
      }
      if(replies.length) pairs.push({customer:String(inbound.body).trim(),company:replies.join('\n'),count:1,created_at:String(inbound.created_at||'')});
    }
  }
  const nowTs=Date.now(),day=86400000;
  const weighted=pairs.filter(x=>{const t=new Date(x.created_at||0).getTime();return !t||nowTs-t<=730*day;}).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
  // Estilo recente tem muito mais peso. Conversas antigas ficam como referência residual, nunca como autoridade factual.
  const recent=weighted.filter(x=>{const t=new Date(x.created_at||0).getTime();return t&&nowTs-t<=90*day;});
  const mid=weighted.filter(x=>{const t=new Date(x.created_at||0).getTime();return t&&nowTs-t>90*day&&nowTs-t<=365*day;});
  const old=weighted.filter(x=>{const t=new Date(x.created_at||0).getTime();return t&&nowTs-t>365*day;});
  return [...old.slice(-20),...mid.slice(-60),...recent.slice(-180)].slice(-220);
}

function sanitizeLearnedRule(rule={}) {
  const keywords=[...new Set((Array.isArray(rule.keywords)?rule.keywords:[]).map(x=>String(x||'').trim()).filter(x=>x.length>=2&&x.length<=90))].slice(0,28);
  const response=String(rule.response_text||'').trim().slice(0,1800);
  const confidence=Math.max(0,Math.min(1,Number(rule.confidence||0)));
  const evidence=Math.max(0,Number(rule.evidence_count||0));
  const dept=['comercial','financeiro','retencao','atendimento','gestao',''].includes(String(rule.route_department||''))?String(rule.route_department||''):'';
  const st=['novo_lead','interessado','pendente_pagamento','ativo','inativo',''].includes(String(rule.set_status||''))?String(rule.set_status||''):'';
  if(!keywords.length||!response||confidence<0.65||(evidence<2&&confidence<0.85)) return null;
  return {label:String(rule.label||keywords[0]).trim().slice(0,120),keywords,response_text:response,last_seen_at:String(rule.last_seen_at||''),response_examples:(Array.isArray(rule.response_examples)?rule.response_examples:[]).map(String).map(x=>x.trim()).filter(Boolean).slice(0,6),customer_examples:(Array.isArray(rule.customer_examples)?rule.customer_examples:[]).map(String).map(x=>x.trim()).filter(Boolean).slice(0,8),route_department:dept,set_status:st,confidence,evidence_count:evidence,evidence_ids:Array.isArray(rule.evidence_ids)?rule.evidence_ids.slice(0,12):[]};
}

function keywordOverlap(a=[],b=[]) {
  const aa=new Set(a.map(normalize).filter(Boolean)),bb=new Set(b.map(normalize).filter(Boolean));
  if(!aa.size||!bb.size)return 0; let hit=0;for(const x of aa)if(bb.has(x))hit++;return hit/Math.min(aa.size,bb.size);
}

function shortcutFromLabel(label='resposta') {
  return normalize(label).replace(/[^a-z0-9 ]+/g,' ').trim().split(/\s+/).slice(0,4).join('').slice(0,28)||'resposta';
}

function syncLearnedResponses(rules=[]) {
  const flows=loadFlows();
  const clean=[];
  for(const raw of rules){const r=sanitizeLearnedRule(raw);if(r)clean.push(r);}
  // Aprendizado histórico é somente CANDIDATO. Nunca altera fluxo manual nem dispara sozinho.
  for(const [key,f] of Object.entries({...flows})) if(f?.source==='bootstrap_history'||f?.source==='bootstrap_history_adapted') delete flows[key];
  let createdFlows=0;
  for(const r of clean){
    const key=newFlowKey(flows,`pendente ${r.label}`);
    flows[key]={id:key,label:`PENDENTE · ${r.label}`,description:`Padrão detectado no histórico (${r.evidence_count} evidências). Revise na Biblioteca de Respostas antes de permitir uso.`,enabled:false,triggerType:'keywords',keywords:r.keywords,matchMode:'smart',smartThreshold:.76,caseSensitive:false,execution:'ai_first',priority:900,conditions:{stages:[],departments:[],businessHours:'any',aiModes:[],firstContactOnly:false},actions:{setStatus:'',routeDepartment:'',nextAction:'',addTags:[],pauseAI:false,humanReview:false},responses:[],source:'bootstrap_history',autoGenerated:true,review_status:'pending',confidence:r.confidence,evidence_count:r.evidence_count,generated_at:new Date().toISOString()};
    createdFlows++;
  }
  saveFlows(flows);
  // Mantém overrides humanos/aprovados; candidatos não revisados podem ser regenerados.
  for(const q of db.listQuickReplies()) if(q.source==='bootstrap_history' && q.review_status==='pending') db.deleteQuickReply(q.id);
  let createdQuickReplies=0;
  const used=new Set(db.listQuickReplies().map(q=>String(q.shortcut||'').toLowerCase()));
  for(const r of clean){
    let shortcut=shortcutFromLabel(r.label),base=shortcut,n=2;while(used.has(shortcut))shortcut=`${base}${n++}`.slice(0,32);used.add(shortcut);
    db.createQuickReply({shortcut,title:`Aprendida · ${r.label}`,type:'text',text:r.response_text,triggers:r.keywords,auto_use:false,enabled:true,review_status:'pending',human_locked:false,learned_at:new Date().toISOString(),last_seen_at:r.last_seen_at||'',source:'bootstrap_history',source_key:normalize(r.label),confidence:r.confidence,evidence_count:r.evidence_count});
    createdQuickReplies++;
  }
  return {rules:clean.length,createdFlows,updatedFlows:0,configuredFlows:0,createdQuickReplies,skippedManual:db.listQuickReplies().filter(q=>q.source==='manual_override').length,pendingReview:createdQuickReplies};
}
function responseRulesFromKnowledge(knowledge={}) {
  const stop=new Set(['qual','quais','quanto','como','onde','quando','voce','voces','vocês','para','com','uma','que','tem','dos','das','por','isso','mais']);
  const rows=[];
  for(const item of (Array.isArray(knowledge.faq)?knowledge.faq:[]).slice(0,12)){
    const question=String(item?.question||'').trim(),answer=String(item?.answer||'').trim();
    if(question.length<4||answer.length<5)continue;
    const keywords=[...new Set(question.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(w=>w.length>=4&&!stop.has(w)))].slice(0,6);
    if(!keywords.length)continue;
    rows.push({label:`FAQ aprendida · ${question.slice(0,70)}`,keywords,response_text:answer,route_department:'',set_status:'',confidence:.88,evidence_count:1,evidence_ids:[]});
  }
  return rows;
}

async function configureLearnedResponses(s,messages,knowledge) {
  const examples=responseExamplesFromMessages(messages);
  const knowledgeRules=responseRulesFromKnowledge(knowledge);
  if(!examples.length && !knowledgeRules.length) return {rules:0,createdFlows:0,createdQuickReplies:0,skippedOverlap:0};
  update({aiBootstrapPhase:'configurando_respostas',aiBootstrapCurrent:'Preenchendo respostas aprendidas do histórico',aiBootstrapPercent:52});

  // Materializa PRIMEIRO uma versão local. A interface deixa de ficar vazia enquanto
  // aguarda uma chamada remota do Gemini. Depois a IA refina os mesmos artefatos.
  const localRules=[...localResponseRulesFromExamples(examples),...knowledgeRules];
  let local=syncLearnedResponses(localRules);
  update({aiBootstrapGeneratedFlows:local.configuredFlows,aiBootstrapGeneratedQuickReplies:local.createdQuickReplies,aiBootstrapLearnedRules:local.rules,aiBootstrapCurrent:`${local.createdQuickReplies||0} respostas rápidas disponíveis · refinando com IA`,aiBootstrapPercent:53});

  try {
    const result=examples.length?await gemini.inferResponseRules({settings:settings.loadSettings(),examples,knowledge,fast:true}):{rules:[]};
    const inferred=(result.rules||[]).length?(result.rules||[]):localResponseRulesFromExamples(examples);
    const candidateRules=[...inferred,...knowledgeRules];
    const synced=syncLearnedResponses(candidateRules);
    ops.audit('ai_bootstrap_responses_configured',{details:{...synced,examples:examples.length,local_first:true}});
    update({aiBootstrapGeneratedFlows:synced.configuredFlows,aiBootstrapGeneratedQuickReplies:synced.createdQuickReplies,aiBootstrapLearnedRules:synced.rules,aiBootstrapCurrent:`${synced.createdQuickReplies||0} respostas aprendidas prontas`});
    return synced;
  } catch(err) {
    const detail=String(err.message||err).slice(0,500);
    ops.audit('ai_bootstrap_responses_failed',{details:{error:detail,examples:examples.length,local_kept:true}});
    update({aiBootstrapDiagnostics:{...(settings.loadSettings().aiBootstrapDiagnostics||{}),response_rules_error:detail}});
    if(local.rules) return {...local,fallback_local:true,error:detail};
    return {rules:0,createdFlows:0,createdQuickReplies:0,skippedOverlap:0,error:detail};
  }
}


function localResponseRulesFromExamples(examples=[]) {
  const stop=new Set(['qual','quanto','como','onde','quando','voce','voces','vocês','para','com','uma','que','tem','dos','das','por','meu','minha','seu','sua','isso','aqui','mais']);
  const normalizeText=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const groups=new Map();
  for(const ex of examples){
    const response=String(ex.company||'').trim(); if(response.length<6) continue;
    const key=normalizeText(response); if(!key)continue;
    const g=groups.get(key)||{response,customers:[],count:0,last_seen_at:''}; g.count++; g.customers.push(String(ex.customer||'')); if(String(ex.created_at||'')>String(g.last_seen_at||''))g.last_seen_at=String(ex.created_at||''); groups.set(key,g);
  }
  const rules=[];
  for(const g of [...groups.values()].sort((a,b)=>b.count-a.count)){
    if(g.count<2)continue;
    const words=[];
    for(const customer of g.customers){for(const w of normalizeText(customer).split(' ')){if(w.length>=4&&!stop.has(w)&&!words.includes(w))words.push(w);}}
    if(!words.length)continue;
    rules.push({label:`Resposta recorrente · ${words.slice(0,3).join(' ')}`,keywords:words.slice(0,6),response_text:g.response,route_department:'',set_status:'',confidence:.82,evidence_count:g.count,evidence_ids:[],last_seen_at:g.last_seen_at});
    if(rules.length>=8)break;
  }
  return rules;
}

function detectOutreachFromMessages(messages=[]) {
  const byContact=new Map();
  for(const m of messages){const id=String(m.contact_id||'');if(!id)continue;if(!byContact.has(id))byContact.set(id,[]);byContact.get(id).push(m);}
  const rows=[]; const signal=/\b(passando|retorno|retomar|voltar|lembra|lembrando|agendar|consulta|reuni[aã]o|visita|como foi|tudo bem|sentimos sua falta|or[cç]amento|proposta|pagamento|vencimento|pedido|entrega)\b/i;
  for(const list of byContact.values()){list.sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));for(let i=0;i<list.length;i++){const m=list[i];if(m.direction!=='out')continue;const text=String(m.body||'').trim();if(text.length<12||text.length>900||!signal.test(text))continue;const prev=list[i-1];const proactive=!prev || prev.direction==='out' || (new Date(m.created_at).getTime()-new Date(prev.created_at).getTime()>6*3600000);if(proactive)rows.push(text);}}
  const counts=new Map();for(const text of rows){const key=text.toLowerCase().replace(/\s+/g,' ').trim();const x=counts.get(key)||{message:text,evidence_count:0};x.evidence_count++;counts.set(key,x);}
  return [...counts.values()].filter(x=>x.evidence_count>=1).sort((a,b)=>b.evidence_count-a.evidence_count).slice(0,6).map(x=>({topic:'followup',...x}));
}

function syncLearnedProspecting(knowledge={},messages=[]) {
  const raw=[...(Array.isArray(knowledge.outreach_patterns)?knowledge.outreach_patterns:[]),...detectOutreachFromMessages(messages)];
  const patterns=[]; const seen=new Set();
  for(const x of raw){const message=String(x?.message||'').trim();const evidence=Math.max(1,Number(x?.evidence_count||1));if(message.length<10||message.length>1200||evidence<1)continue; // é apenas rascunho editável; nunca inicia campanha sem permissão humana
    const key=normalize(String(x?.topic||'followup'))+'|'+normalize(message).slice(0,120);if(seen.has(key))continue;seen.add(key);patterns.push({topic:String(x?.topic||'followup'),message,evidence_count:evidence});if(patterns.length>=6)break;}
  const campaigns=db.listProspectCampaigns(); let created=0,updated=0,preservedManual=0;
  const stageFor=topic=>{const t=normalize(topic);if(t.includes('reativ'))return 'reativacao';if(t.includes('agend'))return 'agendamento_avaliacao';if(t.includes('cancel'))return 'pos_cancelamento';if(t.includes('cobr')||t.includes('pag'))return 'fechamento';return 'contato_inicial';};
  patterns.forEach((x,i)=>{
    const sourceKey=`bootstrap:prospect:${normalize(x.topic)||i}`;
    const existing=campaigns.find(c=>c.source_key===sourceKey);
    if(existing){const userEdited=existing.auto_generated&&existing.last_auto_message&&String(existing.initial_message)!==String(existing.last_auto_message);if(userEdited){preservedManual++;return;}db.updateProspectCampaign(existing.id,{initial_message:x.message,stage:stageFor(x.topic),source:'bootstrap_history',source_key:sourceKey,auto_generated:true,last_auto_message:x.message,audience_hint:`Padrão ${x.topic} identificado no histórico`,learned_from_history:true,confirmed_permission:false});updated++;return;}
    db.createProspectCampaign({name:`Rascunho IA · ${String(x.topic||'follow-up').slice(0,60)}`,initial_message:x.message,stage:stageFor(x.topic),interval_seconds:120,daily_limit:50,confirmed_permission:false,source:'bootstrap_history',source_key:sourceKey,auto_generated:true,last_auto_message:x.message,audience_hint:`Padrão ${x.topic} identificado no histórico`,learned_from_history:true},null);created++;
  });
  return {created,updated,preservedManual,total:created+updated};
}

function seedCRMFromHistory() {
  const contacts=db.listContacts(); let seeded=0;
  const patterns=[
    {re:/\b(plano|pacote|produto|servi[cç]o|or[cç]amento|proposta|cota[cç][aã]o|pre[cç]o|valor|mensalidade)\b/i,interest:'Oferta e valores',department:'comercial',stage:'apresentacao_plano',score:62,tag:'interesse_oferta'},
    {re:/\b(agendar|agenda|consulta|reuni[aã]o|visita|demonstra[cç][aã]o|hor[aá]rio para|avalia[cç][aã]o)\b/i,interest:'Agendamento / atendimento',department:'atendimento',stage:'agendamento_avaliacao',score:70,tag:'agendamento'},
    {re:/\b(pix|boleto|cart[aã]o|pagamento|vencimento|cobran[cç]a)\b/i,interest:'Pagamento',department:'financeiro',stage:'fechamento',score:55,tag:'financeiro'},
    {re:/\b(cancelar|cancelamento|trancar|desistir)\b/i,interest:'Cancelamento / retenção',department:'retencao',stage:'cancelamento',score:30,tag:'retencao'},
    {re:/\b(entrega|frete|retirada|prazo)\b/i,interest:'Entrega / logística',department:'atendimento',stage:'acompanhamento',score:45,tag:'logistica'},
    {re:/\b(suporte|garantia|problema|assist[eê]ncia)\b/i,interest:'Suporte / pós-venda',department:'atendimento',stage:'acompanhamento',score:40,tag:'suporte'}
  ];
  for(const c of contacts){const hist=db.getContactMessages(c.id,true);if(!hist.length)continue;const text=hist.map(m=>String(m.body||'')).join(' ');const lastIn=[...hist].reverse().find(m=>m.direction==='in'&&String(m.body||'').trim());const lastOut=[...hist].reverse().find(m=>m.direction==='out'&&String(m.body||'').trim());const hit=patterns.find(p=>p.re.test(text));const patch={};
    if(!String(c.profile_summary||'').trim())patch.profile_summary=`Histórico do WhatsApp sincronizado (${hist.length} mensagens). Última intenção: ${String(lastIn?.body||'não identificada').replace(/\s+/g,' ').slice(0,150)}`;
    if(!String(c.last_intent||'').trim()&&lastIn)patch.last_intent=String(lastIn.body).replace(/\s+/g,' ').slice(0,180);
    if(hit){if(!String(c.interest||'').trim())patch.interest=hit.interest;if(!String(c.department||'').trim()||c.department==='atendimento')patch.department=hit.department;if(Number(c.lead_score||0)===0)patch.lead_score=hit.score;const tags=String(c.tags||'').split(',').map(x=>x.trim()).filter(Boolean);if(!tags.includes(hit.tag))patch.tags=[...tags,hit.tag,'historico_whatsapp'].join(',');if((!c.journey_stage||c.journey_stage==='contato_inicial')&&hit.stage)db.setJourneyStage(c.id,hit.stage,{reason:'bootstrap_seed'});}
    else {const tags=String(c.tags||'').split(',').map(x=>x.trim()).filter(Boolean);if(!tags.includes('historico_whatsapp'))patch.tags=[...tags,'historico_whatsapp'].join(',');}
    const li=lastIn?new Date(lastIn.created_at).getTime():0,lo=lastOut?new Date(lastOut.created_at).getTime():0;if(!String(c.next_action||'').trim()){patch.next_action=li>lo?'Responder a última mensagem do cliente':lo>li?'Aguardar retorno do cliente':'Revisar histórico';patch.next_best_action=patch.next_action;}
    if((!String(c.customer_type||'').trim()||c.customer_type==='nao_identificado')&&hit)patch.customer_type=hit.department==='retencao'?'cliente':'lead';
    if(Object.keys(patch).length){db.updateContact(c.id,patch,{activity:false});seeded++;}
    const latest=db.getContactById(c.id); const cfg=settings.loadSettings();
    if(cfg.autoRoutingEnabled && latest?.assigned_agent_id==null && latest?.department) db.assignAgentAutomatically(c.id,activeAgents(),latest.department,'bootstrap_seed');
  }
  return {seeded,total:contacts.length};
}

function materializeCompanyLearning(knowledge,messages) {
  const kb=ops.syncBootstrapKnowledge(knowledge||{});
  const gaps=ops.syncKnowledgeGaps(knowledge?.knowledge_gaps||[]);
  const prospecting=syncLearnedProspecting(knowledge||{},messages||[]);
  update({aiBootstrapKnowledgeItems:Number(kb.total||0),aiBootstrapKnowledgeGaps:Number(gaps.length||0),aiBootstrapProspectingDrafts:Number(prospecting.total||0)});
  ops.audit('ai_bootstrap_artifacts_materialized',{details:{knowledge:kb.total,gaps:gaps.length,prospecting:prospecting.total}});
  return {kb,gaps,prospecting};
}

async function consolidateCompanyMemory(s, force=false) {
  const allMessages=db.getAllMessagesForAnalysis();
  if(!allMessages.length) return {messagesAnalyzed:0,availableMessages:0,chunks:0,knowledge:s.learnedKnowledge||{}};
  const lastId=Number(s.historyLastMessageIdAnalyzed||0);
  const source=force || !s.learnedKnowledge || !Object.keys(s.learnedKnowledge).length
    ? allMessages
    : allMessages.filter(m=>Number(m.id||0)>lastId);
  if(!source.length) return {messagesAnalyzed:0,availableMessages:allMessages.length,chunks:0,knowledge:s.learnedKnowledge||{},reused:true};
  const maxMessages=Math.max(80,Number(s.aiBootstrapMaxMessages||DEFAULT_FAST_MAX_MESSAGES));
  const messages=fitMessageBudget(selectRepresentativeMessages(source,maxMessages), Number(s.aiBootstrapCompanyCharBudget||DEFAULT_COMPANY_CHAR_BUDGET));
  update({
    aiBootstrapStatus:'consolidando_empresa',historyScanStatus:'analisando',aiBootstrapTotalMessages:allMessages.length,
    aiBootstrapSampledMessages:messages.length,
    aiBootstrapCurrent:`Selecionadas ${messages.length} de ${allMessages.length} mensagens representativas`,
  });
  const chunks=chunkMessages(messages,20000).slice(0,4); let done=0, chunkFailures=0; const chunkErrors=[];
  update({aiBootstrapStatus:'consolidando_empresa',aiBootstrapPhase:'aprendendo_empresa',aiBootstrapCurrent:`0/${chunks.length} lotes rápidos · ${messages.length} mensagens`,aiBootstrapPercent:15,aiBootstrapDiagnostics:{stage:'company_sample',model:'gemini-3.5-flash-lite',errors:[]}});
  const concurrency=Math.max(1,Math.min(2,Number(s.aiBootstrapCompanyConcurrency||2)));
  const rawSummaries=await mapLimit(chunks,concurrency,async(chunk,i)=>{
    await waitForControl();
    try {
      return await gemini.analyzeHistoryChunk({settings:settings.loadSettings(),messages:chunk,chunkIndex:i+1,fast:true});
    } catch(err) {
      chunkFailures++; const detail=String(err.message||err).slice(0,500); chunkErrors.push({chunk:i+1,error:detail});
      ops.audit('ai_bootstrap_company_chunk_failed',{details:{chunk:i+1,error:detail}});
      const fallback=localChunkFallback(chunk);
      return Object.keys(fallback).length?fallback:null;
    } finally {
      done++;
      update({aiBootstrapStatus:'consolidando_empresa',aiBootstrapPhase:'aprendendo_empresa',aiBootstrapCurrent:`${done}/${chunks.length} lotes · ${messages.length}/${allMessages.length} msgs amostradas${chunkFailures?` · ${chunkFailures} fallback(s) local(is)`:''}`,aiBootstrapPercent:percent(done,chunks.length,15,30),aiBootstrapDiagnostics:{stage:'company_sample',model:'gemini-3.5-flash-lite',errors:chunkErrors.slice(-6)}});
    }
  });
  const summaries=rawSummaries.filter(x=>x&&Object.keys(x).length);
  if(!summaries.length) {
    const runtime=gemini.runtimeStatus(); const reason=chunkErrors.map(x=>`lote ${x.chunk}: ${x.error}`).join(' | ')||runtime.lastError||'nenhum resumo estruturado';
    throw new Error(`A amostra não pôde ser estruturada. Motivo: ${reason}`);
  }
  let level=summaries; let round=0;
  while(level.length>8){
    round++; const groups=[]; for(let i=0;i<level.length;i+=8)groups.push(level.slice(i,i+8));
    update({aiBootstrapPhase:'consolidando_memoria',aiBootstrapCurrent:`Consolidando memória · rodada ${round}`,aiBootstrapPercent:48});
    level=await mapLimit(groups,2,async group=>{await waitForControl();return gemini.aggregateHistoryKnowledge({settings:settings.loadSettings(),chunkSummaries:group,previousKnowledge:{},fast:true});});
  }
  update({aiBootstrapPhase:'consolidando_memoria',aiBootstrapCurrent:'Montando identidade operacional da empresa',aiBootstrapPercent:50});
  let knowledge; try { knowledge=await gemini.aggregateHistoryKnowledge({settings:settings.loadSettings(),chunkSummaries:level,previousKnowledge:s.learnedKnowledge||{},fast:true}); } catch(err) { knowledge=localKnowledgeFallback(level,s.learnedKnowledge||{}); ops.audit('ai_bootstrap_aggregate_fallback',{details:{error:String(err.message||err).slice(0,300)}}); }
  // Nunca conclua o bootstrap com memória vazia. Respostas parciais do Gemini podem
  // ser estruturalmente válidas, mas omitir os dois campos usados pela interface.
  if(!String(knowledge?.style_profile||'').trim() || !String(knowledge?.business_profile||'').trim()) {
    knowledge=localKnowledgeFallback(level,{...(s.learnedKnowledge||{}),...knowledge});
  }
  update({
    learnedStyleProfile:String(knowledge.style_profile||s.learnedStyleProfile||'').trim(),
    learnedBusinessProfile:String(knowledge.business_profile||s.learnedBusinessProfile||'').trim(),
    learnedKnowledge:knowledge,
    historyScanStatus:'concluido',historyScanRunAt:new Date().toISOString(),historyMessagesAnalyzed:messages.length,
    historyLastMessageIdAnalyzed:Math.max(0,...allMessages.map(m=>Number(m.id||0))),
    aiBootstrapSampledMessages:messages.length,
  });
  const artifacts=materializeCompanyLearning(knowledge,messages);
  const learnedResponses=await configureLearnedResponses(s,messages,knowledge);
  return {messagesAnalyzed:messages.length,availableMessages:allMessages.length,newMessagesAnalyzed:messages.length,chunks:chunks.length,knowledge,learnedResponses,artifacts};
}

async function profileContacts(s, bootstrapStartedAt=null, force=false, deadlineAt=0) {
  const contacts=db.listContacts().sort((a,b)=>new Date(b.last_message_at||b.updated_at||0)-new Date(a.last_message_at||a.updated_at||0));
  const eligible=contacts.filter(c=>db.getContactMessages(c.id,true).some(m=>String(m.body||'').trim()));
  const maxContacts=Math.max(5,Math.min(20,Number(s.aiBootstrapMaxContacts||DEFAULT_FAST_MAX_CONTACTS))); // perfis prioritários rápidos; o restante continua em worker pós-bootstrap
  const target=eligible.slice(0,maxContacts);
  const deferred=Math.max(0,eligible.length-target.length);
  const skippedNoHistory=Math.max(0,contacts.length-eligible.length);
  let profiled=0, skipped=skippedNoHistory+deferred, failed=0, finished=0;
  update({
    aiBootstrapStatus:'perfilando_clientes',aiBootstrapPhase:'perfilando_clientes',aiBootstrapTotalContacts:contacts.length,
    aiBootstrapEligibleContacts:eligible.length,aiBootstrapTargetContacts:target.length,aiBootstrapDeferredContacts:deferred,
    aiBootstrapSkippedContacts:skipped,aiBootstrapProfiledContacts:0,
    aiBootstrapCurrent:`0/${target.length} perfis prioritários · ${deferred} serão aprendidos sob demanda`,aiBootstrapPercent:55
  });
  const concurrency=Math.max(1,Math.min(5,Number(s.aiBootstrapContactConcurrency||5)));
  await mapLimit(target,concurrency,async(contact)=>{
    await waitForControl();
    if(deadlineAt && Date.now()>=deadlineAt-4000){skipped++;finished++;update({aiBootstrapCurrent:`Tempo-alvo atingido · ${profiled} perfis prontos · restante sob demanda`,aiBootstrapPercent:94});return;}
    const fullHistory=db.getContactMessages(contact.id,true);
    const latest=fullHistory[fullHistory.length-1]?.created_at;
    if(!force && contact.profile_updated_at && latest && new Date(contact.profile_updated_at).getTime()>=new Date(latest).getTime()){profiled++;finished++;return;}
    try {
      const sampledHistory=sampleContactHistory(fullHistory,Number(s.aiBootstrapContactMessages||DEFAULT_CONTACT_MAX_MESSAGES));
      const profile=await gemini.analyzeFullCustomerHistory({settings:settings.loadSettings(),conversationHistory:sampledHistory,contact:db.getContactById(contact.id),fast:true});
      const historicalProfile={...profile,task_title:'',follow_up_at:'',appointment_title:'',appointment_start_at:'',handoff_required:false,handoff_reason:''};
      db.applyAIProfile(contact.id,historicalProfile);
      if(s.autoRoutingEnabled && profile.department) db.assignAgentAutomatically(contact.id,activeAgents(),profile.department,'bootstrap_ia');
      profiled++;
    } catch(err) {
      failed++; db.addActivity(contact.id,'bootstrap_profile_error',{error:String(err.message||err).slice(0,300)});
    } finally {
      finished++; update({
        aiBootstrapStatus:'perfilando_clientes',aiBootstrapPhase:'perfilando_clientes',aiBootstrapProfiledContacts:profiled,
        aiBootstrapTotalContacts:contacts.length,aiBootstrapEligibleContacts:eligible.length,aiBootstrapTargetContacts:target.length,aiBootstrapDeferredContacts:deferred,aiBootstrapSkippedContacts:skipped,
        aiBootstrapCurrent:`${finished}/${target.length} perfis prioritários · ${deferred} sob demanda`,
        aiBootstrapPercent:percent(finished,target.length,55,40)
      });
    }
  });
  return {profiled,skipped,failed,total:contacts.length,eligible:eligible.length,target:target.length,deferred};
}


async function profileDeferredContacts({limit=80}={}) {
  const s=settings.loadSettings();
  if(!s.aiReady || !s.geminiApiKey || !s.autoCustomerProfiling) return {profiled:0,skipped:0};
  const candidates=db.listContacts().filter(c=>{
    const hist=db.getContactMessages(c.id,true);
    if(!hist.some(m=>String(m.body||'').trim())) return false;
    const latest=hist[hist.length-1]?.created_at;
    return !c.profile_updated_at || (latest && new Date(c.profile_updated_at).getTime()<new Date(latest).getTime());
  }).slice(0,Math.max(1,Number(limit||80)));
  let profiled=0,failed=0;
  await mapLimit(candidates,2,async(contact)=>{
    try{
      const hist=sampleContactHistory(db.getContactMessages(contact.id,true),Number(s.aiBootstrapContactMessages||DEFAULT_CONTACT_MAX_MESSAGES));
      const profile=await gemini.analyzeFullCustomerHistory({settings:settings.loadSettings(),conversationHistory:hist,contact:db.getContactById(contact.id),fast:true});
      db.applyAIProfile(contact.id,{...profile,task_title:'',appointment_title:'',handoff_required:false});
      if(s.autoRoutingEnabled&&profile.department)db.assignAgentAutomatically(contact.id,activeAgents(),profile.department,'perfilamento_pos_bootstrap');
      profiled++;
    }catch(err){failed++;ops.audit('deferred_profile_failed',{contactId:contact.id,resource:'gemini',details:{error:String(err.message||err).slice(0,300)}});}
  });
  if(profiled||failed)ops.audit('deferred_profiles_processed',{details:{profiled,failed,candidates:candidates.length}});
  return {profiled,failed,candidates:candidates.length};
}

async function reconcileLearnedState(){
  const s=settings.loadSettings();
  const knowledge=s.learnedKnowledge&&typeof s.learnedKnowledge==='object'?s.learnedKnowledge:{};
  const hasKnowledge=Object.keys(knowledge).length>0;
  let artifacts=null,responses=null,seeded=null;
  if(hasKnowledge){
    artifacts=materializeCompanyLearning(knowledge,db.getAllMessagesForAnalysis());
    responses=await configureLearnedResponses(s,db.getAllMessagesForAnalysis(),knowledge);
  }
  seeded=seedCRMFromHistory();
  // Nunca religar a IA silenciosamente após reinício. A escolha manual do operador prevalece.
  return {ok:true,artifacts,responses,seeded};
}

async function runBootstrap({force=false}={}) {
  if(runningPromise) return runningPromise;

  // Pré-requisitos ficam FORA do worker. Assim uma saída imediata nunca deixa
  // runningPromise preso em uma Promise já concluída.
  const pre=settings.loadSettings();
  if((pre.aiBootstrapControl||'running')==='cancelled' && !force) return {ok:false,reason:'cancelled',...status()};
  if(!whatsappConnected()) {
    markWaitingForWhatsApp({preserveReady:true});
    return {ok:false,reason:'whatsapp_not_connected',...status()};
  }
  if(!pre.geminiApiKey) {
    update({aiReady:false,aiBootstrapStatus:'aguardando_gemini',aiBootstrapPhase:'aguardando_gemini',aiBootstrapPercent:0,aiBootstrapCurrent:'Configure a chave Gemini',aiBootstrapError:'Configure a chave do Gemini para concluir a preparação.'});
    return {ok:false,reason:'gemini_not_configured',...status()};
  }
  const metrics=db.getMetrics();
  const analysisMessages=db.getAllMessagesForAnalysis();
  const contactsWithHistory=db.listContacts().filter(c=>db.getContactMessages(c.id,true).some(m=>String(m.body||'').trim()));
  if(!analysisMessages.length || !contactsWithHistory.length){
    update({aiReady:false,aiBootstrapStatus:'aguardando_historico',aiBootstrapPhase:'sincronizando_historico',aiBootstrapPercent:0,aiBootstrapCurrent:`Aguardando histórico utilizável · ${analysisMessages.length} mensagens · ${contactsWithHistory.length} contatos com conversa`,aiBootstrapTotalMessages:analysisMessages.length,aiBootstrapTotalContacts:Number(metrics.totalContacts||0),aiBootstrapEligibleContacts:contactsWithHistory.length,aiBootstrapProfiledContacts:0,aiBootstrapError:''});
    return {ok:false,reason:'history_empty',...status()};
  }
  const maxMessageId=Math.max(0,...analysisMessages.map(m=>Number(m.id||0)));
  if(pre.aiReady && !force && Number(pre.historyLastMessageIdAnalyzed||0)>=maxMessageId) return {ok:true,alreadyReady:true,...status()};

  const task=(async()=>{
    const s=settings.loadSettings();
    const hadOperationalMemory=Boolean(String(s.learnedStyleProfile||'').trim() && String(s.learnedBusinessProfile||'').trim());
    const keepServing=Boolean(!force && s.aiReady && hadOperationalMemory);
    const resumeable=!force && s.aiBootstrapStartedAt && ['consolidando_empresa','perfilando_clientes','erro'].includes(s.aiBootstrapStatus);
    const startedAt=resumeable?s.aiBootstrapStartedAt:new Date().toISOString();
    update({aiReady:keepServing,aiBootstrapControl:'running',aiBootstrapStatus:'consolidando_empresa',aiBootstrapPhase:'iniciando_analise',aiBootstrapPercent:keepServing?96:10,aiBootstrapCurrent:keepServing?'Atualizando aprendizado com novas conversas · agente continua disponível':'Preparando análise',aiBootstrapStartedAt:startedAt,aiBootstrapCompletedAt:keepServing?s.aiBootstrapCompletedAt:null,aiBootstrapError:'',aiBootstrapProfiledContacts:resumeable?Number(s.aiBootstrapProfiledContacts||0):0});
    try {
      const budgetMs=Math.max(45000,Math.min(180000,Number(settings.loadSettings().aiBootstrapBudgetMs||DEFAULT_BOOTSTRAP_BUDGET_MS)));
      const deadline=Date.now()+budgetMs;
      // CRM básico é correlacionado antes de qualquer chamada remota. Assim Inbox/CRM
      // começam a preencher imediatamente enquanto a memória profunda é consolidada.
      const seeded=seedCRMFromHistory();
      update({aiBootstrapSeededContacts:seeded.seeded,aiBootstrapCurrent:`CRM inicial correlacionado · ${seeded.seeded} contatos preparados · aprendendo empresa`,aiBootstrapPercent:12});
      const company=await consolidateCompanyMemory(settings.loadSettings(), force);
      update({aiBootstrapSeededContacts:seeded.seeded,aiBootstrapCurrent:`CRM inicial correlacionado · ${seeded.seeded} contatos preparados`,aiBootstrapPercent:54});
      let profiles;
      if(Date.now()>=deadline-8000) {
        const all=db.listContacts(), eligible=all.filter(c=>db.getContactMessages(c.id,true).some(m=>String(m.body||'').trim()));
        profiles={profiled:0,failed:0,total:all.length,eligible:eligible.length,target:0,deferred:eligible.length,skipped:all.length};
        update({aiBootstrapCurrent:`Identidade da empresa pronta · ${eligible.length} perfis serão aprendidos sob demanda`,aiBootstrapPercent:94});
      } else {
        profiles=await profileContacts(settings.loadSettings(), startedAt, force, deadline);
      }
      const completedAt=new Date().toISOString();
      const learned=settings.loadSettings();
      const hasOperationalMemory=Boolean(String(learned.learnedStyleProfile||'').trim() && String(learned.learnedBusinessProfile||'').trim());
      if(!hasOperationalMemory) throw new Error('A análise terminou, mas a memória operacional não foi persistida. O agente não será marcado como pronto.');
      const activeKnowledge=ops.listKnowledge().filter(x=>x.active!==false);
      if(!activeKnowledge.length) throw new Error('A memória foi criada, mas a Base de Conhecimento editável não foi materializada. A preparação não será marcada como concluída.');
      if(profiles.eligible>0 && Number(learned.aiBootstrapSeededContacts||0)===0 && Number(profiles.profiled||0)===0) throw new Error('Existem conversas no histórico, mas nenhum contato foi correlacionado ao CRM.');
      const quality=(learned.learnedKnowledge?.fallback_local || Number(profiles.failed||0)>0)?'degradado':'completo';
      update({aiReady:true,aiEnabled:(s.aiUserPreferenceSet ? Boolean(s.aiEnabled) : Boolean(s.aiBootstrapAutoStart)),aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:quality==='degradado'?'Agente pronto · aprendizado inicial em modo degradado':'Agente pronto',aiBootstrapQuality:quality,aiBootstrapCompletedAt:completedAt,aiBootstrapError:'',aiBootstrapTotalMessages:db.getMetrics().totalMessages,aiBootstrapTotalContacts:db.getMetrics().totalContacts,aiBootstrapEligibleContacts:profiles.eligible,aiBootstrapTargetContacts:profiles.target,aiBootstrapDeferredContacts:profiles.deferred,aiBootstrapSkippedContacts:profiles.skipped,aiBootstrapProfiledContacts:profiles.profiled,aiBootstrapSampledMessages:company.messagesAnalyzed});
      ops.audit('ai_bootstrap_completed',{details:{sampledMessages:company.messagesAnalyzed,availableMessages:company.availableMessages,contacts:profiles.total,targetContacts:profiles.target,deferredContacts:profiles.deferred,profiled:profiles.profiled,failed:profiles.failed,knowledgeItems:activeKnowledge.length,gaps:Number(learned.aiBootstrapKnowledgeGaps||0),prospectingDrafts:Number(learned.aiBootstrapProspectingDrafts||0),generatedFlows:Number(learned.aiBootstrapGeneratedFlows||0)}});
      setTimeout(()=>profileDeferredContacts({limit:80}).catch(err=>ops.audit('deferred_profile_worker_failed',{details:{error:String(err.message||err).slice(0,400)}})),1500);
      return {ok:true,company,profiles,...status()};
    } catch(err) {
      const ctl=settings.loadSettings().aiBootstrapControl||'running';
      if(keepServing){
        update({aiReady:true,aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:'Agente pronto · atualização incremental falhou; memória anterior preservada',aiBootstrapError:String(err.message||err).slice(0,1000)});
      } else if(ctl==='cancelled') update({aiReady:false,aiBootstrapStatus:'cancelado',aiBootstrapError:''});
      else update({aiReady:false,aiBootstrapStatus:'erro',aiBootstrapError:String(err.message||err).slice(0,1000)});
      ops.audit('ai_bootstrap_failed',{details:{error:String(err.message||err).slice(0,500),keptServing:keepServing}});
      if(!keepServing) throw err;
      return {ok:false,keptServing:true,error:String(err.message||err),...status()};
    }
  })();

  runningPromise=task;
  try { return await task; }
  finally { if(runningPromise===task) runningPromise=null; }
}

async function runIncrementalLearning({force=false}={}) {
  const s=settings.loadSettings();
  if(!s.continuousLearningEnabled) return {ok:false,reason:'disabled'};
  if(!s.geminiApiKey) return {ok:false,reason:'gemini_not_configured'};
  if(!s.aiReady && !force) return {ok:false,reason:'ai_not_ready'};
  if(runningPromise) return {ok:false,reason:'learning_busy'};
  const all=db.getAllMessagesForAnalysis();
  const lastId=Number(s.historyLastMessageIdAnalyzed||0);
  const newer=all.filter(m=>Number(m.id||0)>lastId && String(m.body||'').trim());
  const batch=Math.max(4,Number(s.continuousLearningBatchMessages||8));
  const minInterval=Math.max(5,Number(s.continuousLearningMinIntervalMinutes||15))*60000;
  const lastRun=s.continuousLearningLastAt?new Date(s.continuousLearningLastAt).getTime():0;
  const elapsed=Date.now()-lastRun;
  if(!force && newer.length<batch && !(newer.length>=2 && elapsed>=minInterval)) {
    settings.saveSettings({continuousLearningStatus:`aguardando · ${newer.length}/${batch} novas mensagens`,continuousLearningLastNewMessages:newer.length});
    return {ok:false,reason:'waiting_batch',pending:newer.length,batch};
  }
  const task=(async()=>{
    const learningStarted=Date.now();
    const knowledgeBefore=ops.listKnowledge().filter(x=>['official','reviewed','learned'].includes(x.effective_status)).length;
    try{
      settings.saveSettings({continuousLearningStatus:`aprendendo com ${newer.length} novas mensagens`,continuousLearningLastNewMessages:newer.length,continuousLearningLastError:''});
      const company=await consolidateCompanyMemory(settings.loadSettings(),false);
      const profiles=await profileDeferredContacts({limit:Math.max(1,Math.min(10,Number(s.continuousLearningProfileLimit||4)))});
      const finishedAt=new Date().toISOString();
      const knowledgeAfter=ops.listKnowledge().filter(x=>['official','reviewed','learned'].includes(x.effective_status)).length;
      const cur=settings.loadSettings();
      const duration=Date.now()-learningStarted;
      settings.saveSettings({continuousLearningLastAt:finishedAt,continuousLearningStatus:`atualizado · ${Number(company.newMessagesAnalyzed||company.messagesAnalyzed||0)} novas mensagens`,continuousLearningLastNewMessages:0,continuousLearningRuns:Number(cur.continuousLearningRuns||0)+1,continuousLearningLastDurationMs:duration,continuousLearningLastProfiled:Number(profiles.profiled||0),continuousLearningLastKnowledgeDelta:knowledgeAfter-knowledgeBefore,continuousLearningLastError:'',aiReady:true,aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:'Agente pronto · aprendizado contínuo atualizado'});
      ops.audit('continuous_learning_completed',{details:{newMessages:Number(company.newMessagesAnalyzed||company.messagesAnalyzed||0),profiled:Number(profiles.profiled||0),failed:Number(profiles.failed||0),durationMs:duration,knowledgeDelta:knowledgeAfter-knowledgeBefore}});
      return {ok:true,company,profiles,finishedAt,durationMs:duration,knowledgeDelta:knowledgeAfter-knowledgeBefore};
    }catch(err){
      const cur=settings.loadSettings(); const duration=Date.now()-learningStarted; const error=String(err.message||err).slice(0,500);
      settings.saveSettings({continuousLearningStatus:`falha temporária · ${error.slice(0,180)}`,continuousLearningFailures:Number(cur.continuousLearningFailures||0)+1,continuousLearningLastDurationMs:duration,continuousLearningLastError:error,aiReady:true,aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:'Agente pronto · aprendizado contínuo aguardando nova tentativa'});
      ops.audit('continuous_learning_failed',{details:{error,durationMs:duration}});
      return {ok:false,error};
    }
  })();
  runningPromise=task;
  try{return await task;}finally{if(runningPromise===task)runningPromise=null;}
}

function scheduleContinuousLearning({delayMs=45000,force=false}={}) {
  const s=settings.loadSettings();
  if(!s.continuousLearningEnabled || !s.geminiApiKey) return;
  if(continuousLearningTimer) clearTimeout(continuousLearningTimer);
  continuousLearningTimer=setTimeout(async()=>{
    continuousLearningTimer=null;
    const result=await runIncrementalLearning({force});
    if(result?.reason==='waiting_batch') {
      const cur=settings.loadSettings();
      const minInterval=Math.max(5,Number(cur.continuousLearningMinIntervalMinutes||15))*60000;
      const lastRun=cur.continuousLearningLastAt?new Date(cur.continuousLearningLastAt).getTime():Date.now();
      const remaining=Math.max(60000,minInterval-(Date.now()-lastRun));
      continuousLearningTimer=setTimeout(()=>{continuousLearningTimer=null;runIncrementalLearning({force:false}).catch(()=>{});},remaining);
    }
  },Math.max(5000,Number(delayMs||45000)));
}

function resetForNewConnection({forceReset=false}={}) {
  const s=settings.loadSettings();
  if(!forceReset && s.aiReady && String(s.learnedStyleProfile||'').trim() && String(s.learnedBusinessProfile||'').trim()) {
    update({aiReady:true,aiBootstrapControl:'running',aiBootstrapStatus:'pronto',aiBootstrapPhase:'pronto',aiBootstrapPercent:100,aiBootstrapCurrent:'Agente treinado · aguardando reconexão do WhatsApp',aiBootstrapError:''});
    return status();
  }
  update({aiReady:false,aiBootstrapControl:'running',aiBootstrapStatus:'aguardando_historico',aiBootstrapPhase:'sincronizando_historico',aiBootstrapPercent:0,aiBootstrapCurrent:'Aguardando histórico do WhatsApp',aiBootstrapStartedAt:null,aiBootstrapCompletedAt:null,aiBootstrapError:'',aiBootstrapImportedMessages:0,aiBootstrapTotalMessages:0,aiBootstrapTotalContacts:0,aiBootstrapEligibleContacts:0,aiBootstrapSkippedContacts:0,aiBootstrapProfiledContacts:0,aiBootstrapTargetContacts:0,aiBootstrapDeferredContacts:0,aiBootstrapSampledMessages:0,aiBootstrapGeneratedFlows:0,aiBootstrapGeneratedQuickReplies:0,aiBootstrapLearnedRules:0,aiBootstrapKnowledgeItems:0,aiBootstrapKnowledgeGaps:0,aiBootstrapProspectingDrafts:0,aiBootstrapSeededContacts:0,historyScanStatus:'nunca_rodado'});
}

function canAutoRespond() {
  const s=settings.loadSettings();
  return !s.aiBootstrapAutoStart || Boolean(s.aiReady);
}

module.exports={runBootstrap,runIncrementalLearning,scheduleContinuousLearning,status,markHistoryImported,resetForNewConnection,canAutoRespond,chunkMessages,setControl,selectRepresentativeMessages,sampleContactHistory,setConnectionChecker,markWaitingForWhatsApp,reconcileLearnedState,profileDeferredContacts};
