// db.js — persistência local do CRM, jornadas e prospecção em JSON.
// Mantém o projeto portátil/.exe e cria trilha auditável de status, transferências, IA e campanhas.

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const crmConfig = require('./crm-config');
const { EventEmitter } = require('events');
const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(100);
function emitRealtime(kind, contactId=null, extra={}) { realtimeBus.emit('event',{kind,contactId:contactId==null?null:Number(contactId),at:nowISO(),...extra}); }
function subscribeRealtime(listener){ realtimeBus.on('event',listener); return ()=>realtimeBus.off('event',listener); }

const DB_PATH = path.join(dataDir, 'ra-bot-db.json');
const SQLITE_PATH = path.join(dataDir, 'alone.db');
const FORCE_JSON_IMPORT_FLAG = path.join(dataDir, 'force-json-import.flag');
let sqliteDb=null;
let sqliteRuntimeError='';
try {
  // Dynamic module name keeps esbuild/pkg from trying to resolve a Node builtin that only exists on Node 22.5+.
  const sqliteModuleName='node:'+'sqlite';
  const { DatabaseSync }=module.require(sqliteModuleName);
  sqliteDb=new DatabaseSync(SQLITE_PATH);
  sqliteDb.exec('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
} catch (err) { sqliteDb=null; sqliteRuntimeError=String(err?.message||err||'SQLite indisponível'); }
const VALID_STATUSES = ['novo_lead', 'interessado', 'ativo', 'pendente_pagamento', 'inativo'];
const JOURNEY_STAGES = [
  'contato_inicial','apresentacao_plano','fechamento','agendamento_avaliacao','pos_avaliacao',
  'primeiro_treino','acompanhamento','cancelamento','pos_cancelamento','reativacao'
];

function nowISO() { return new Date().toISOString(); }
function localDateKey(value=new Date()) { const d=value instanceof Date?value:new Date(value); if(Number.isNaN(d.getTime()))return ''; const timeZone=String(process.env.ALONE_BUSINESS_TZ||'America/Sao_Paulo'); try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const o=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${o.year}-${o.month}-${o.day}`;}catch(_){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;} }
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '55').replace(/\D/g, '') || '55';
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) digits = digits.slice(1);
  if ((digits.length === 10 || digits.length === 11) && DEFAULT_COUNTRY_CODE) digits = DEFAULT_COUNTRY_CODE + digits;
  return digits;
}
function validOperationalDate(value,maxFutureDays=365){if(!value)return false;const t=new Date(value).getTime();if(!Number.isFinite(t))return false;return t>=Date.now()-5*60000&&t<=Date.now()+Math.max(1,maxFutureDays)*86400000;}

function emptyDB() {
  return {
    schemaVersion: 10,
    nextContactId: 1,
    nextMessageId: 1,
    nextActivityId: 1,
    nextCampaignId: 1,
    nextQueueId: 1,
    nextTaskId: 1,
    nextEventId: 1,
    nextQuickReplyId: 1,
    contacts: [],
    messages: [],
    activities: [],
    prospectCampaigns: [],
    prospectQueue: [],
    tasks: [],
    calendarEvents: [],
    quickReplies: [],
  };
}


function uniqTextList(values=[], max=20){
  const out=[]; for(const v of Array.isArray(values)?values:[]){const x=String(v||'').trim();if(x&&!out.some(y=>y.toLowerCase()===x.toLowerCase()))out.push(x.slice(0,500));if(out.length>=max)break;} return out;
}
function normalizeMemoryTimeline(values=[], max=120){
  const rows=(Array.isArray(values)?values:[]).map(x=>({id:String(x?.id||`mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`),type:String(x?.type||'note').slice(0,60),label:String(x?.label||'').slice(0,240),details:String(x?.details||'').slice(0,1200),at:String(x?.at||nowISO()),source:String(x?.source||'system').slice(0,80)}));
  return rows.sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-max);
}
function defaultCustomerMemory(contact={}){
  return {version:1,summary:String(contact.profile_summary||''),relationship_status:contact.status==='ativo'?'cliente_ativo':contact.status==='inativo'?'inativo':'lead',current_interest:String(contact.interest||''),current_plan:String(contact.plan_name||''),preferred_schedule:String(contact.preferred_schedule||''),preferences:[],needs:uniqTextList(String(contact.needs||'').split(/[|;\n]+/)),objections:uniqTextList(String(contact.objections||'').split(/[|;\n]+/)),goals:uniqTextList(String(contact.goals||'').split(/[|;\n]+/)),decision_factors:[],important_facts:[],commitments:[],cancellation:{cancelled_at:null,reason:'',notes:'',retention_attempted:false},reactivation:{score:0,last_signal_at:null,signals:[],suggested_after:null},manual_notes:'',pinned_facts:[],timeline:[],updated_at:nowISO(),last_ai_refresh_at:null};
}
function normalizeCustomerMemory(memory, contact={}){
  const base=defaultCustomerMemory(contact), m=memory&&typeof memory==='object'&&!Array.isArray(memory)?memory:{};
  const cancellation=m.cancellation&&typeof m.cancellation==='object'?m.cancellation:{}; const reactivation=m.reactivation&&typeof m.reactivation==='object'?m.reactivation:{};
  return {...base,...m,version:1,summary:String(m.summary??base.summary).slice(0,2000),relationship_status:String(m.relationship_status||base.relationship_status).slice(0,80),current_interest:String(m.current_interest??base.current_interest).slice(0,500),current_plan:String(m.current_plan??base.current_plan).slice(0,300),preferred_schedule:String(m.preferred_schedule??base.preferred_schedule).slice(0,300),preferences:uniqTextList(m.preferences,30),needs:uniqTextList(m.needs?.length?m.needs:base.needs,30),objections:uniqTextList(m.objections?.length?m.objections:base.objections,30),goals:uniqTextList(m.goals?.length?m.goals:base.goals,30),decision_factors:uniqTextList(m.decision_factors,30),important_facts:uniqTextList(m.important_facts,40),commitments:uniqTextList(m.commitments,30),manual_notes:String(m.manual_notes||'').slice(0,4000),pinned_facts:uniqTextList(m.pinned_facts,40),cancellation:{cancelled_at:cancellation.cancelled_at||null,reason:String(cancellation.reason||'').slice(0,600),notes:String(cancellation.notes||'').slice(0,1200),retention_attempted:Boolean(cancellation.retention_attempted)},reactivation:{score:Math.max(0,Math.min(100,Number(reactivation.score||0))),last_signal_at:reactivation.last_signal_at||null,signals:uniqTextList(reactivation.signals,30),suggested_after:reactivation.suggested_after||null},timeline:normalizeMemoryTimeline(m.timeline),updated_at:m.updated_at||nowISO(),last_ai_refresh_at:m.last_ai_refresh_at||null};
}
function appendCustomerMemoryEvent(contactId,type,label='',details='',source='system'){
  const c=getContactById(contactId); if(!c)return null; const m=normalizeCustomerMemory(c.customer_memory,c); m.timeline.push({id:`mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,type:String(type||'note').slice(0,60),label:String(label||'').slice(0,240),details:String(details||'').slice(0,1200),at:nowISO(),source:String(source||'system').slice(0,80)}); m.timeline=normalizeMemoryTimeline(m.timeline); m.updated_at=nowISO(); c.customer_memory=m; c.updated_at=nowISO(); save(); emitRealtime('customer_memory_updated',c.id,{type}); return m;
}
function getCustomerMemory(contactId){const c=getContactById(contactId);return c?normalizeCustomerMemory(c.customer_memory,c):null;}
function updateCustomerMemory(contactId, patch={}, meta={}){
  const c=getContactById(contactId); if(!c)return null; const current=normalizeCustomerMemory(c.customer_memory,c); const p=patch&&typeof patch==='object'?patch:{};
  const next=normalizeCustomerMemory({...current,...p,cancellation:{...current.cancellation,...(p.cancellation||{})},reactivation:{...current.reactivation,...(p.reactivation||{})},timeline:current.timeline},c);
  // fatos fixados manualmente nunca são substituídos por IA
  if(meta.source==='ai'){next.pinned_facts=current.pinned_facts;next.manual_notes=current.manual_notes;}
  next.updated_at=nowISO(); if(meta.source==='ai')next.last_ai_refresh_at=nowISO(); c.customer_memory=next; c.updated_at=nowISO(); save();
  if(meta.activity!==false)addActivity(c.id,'customer_memory_updated',{source:meta.source||'manual',fields:Object.keys(patch||{})},meta.agentId||null); emitRealtime('customer_memory_updated',c.id,{source:meta.source||'manual'}); return next;
}
function applyMemoryFromProfile(contactId,profile={}){
  const c=getContactById(contactId); if(!c)return null; const current=getCustomerMemory(contactId)||defaultCustomerMemory(c); const mu=profile.memory_update&&typeof profile.memory_update==='object'?profile.memory_update:{};
  const patch={summary:String(mu.summary||profile.profile_summary||current.summary||'').slice(0,2000),relationship_status:String(mu.relationship_status||current.relationship_status||'').slice(0,80),current_interest:String(mu.current_interest||profile.interest||current.current_interest||''),current_plan:String(mu.current_plan||profile.plan_name||current.current_plan||''),preferred_schedule:String(mu.preferred_schedule||profile.preferred_schedule||current.preferred_schedule||''),preferences:uniqTextList([...(current.preferences||[]),...(mu.preferences||[])],30),needs:uniqTextList([...(current.needs||[]),...String(profile.needs||'').split(/[|;\n]+/),...(mu.needs||[])],30),objections:uniqTextList([...(current.objections||[]),...String(profile.objections||'').split(/[|;\n]+/),...(mu.objections||[])],30),goals:uniqTextList([...(current.goals||[]),...String(profile.goals||'').split(/[|;\n]+/),...(mu.goals||[])],30),decision_factors:uniqTextList([...(current.decision_factors||[]),...(mu.decision_factors||[])],30),important_facts:uniqTextList([...(current.important_facts||[]),...(mu.important_facts||[])],40),commitments:uniqTextList([...(current.commitments||[]),...(mu.commitments||[])],30),reactivation:{...current.reactivation,...(mu.reactivation||{})}};
  if(profile.journey_stage==='cancelamento'||profile.journey_stage==='pos_cancelamento'||mu.cancellation?.reason){patch.relationship_status=profile.journey_stage==='pos_cancelamento'?'pos_cancelamento':'cancelamento';patch.cancellation={...current.cancellation,...(mu.cancellation||{}),cancelled_at:(mu.cancellation?.cancelled_at||current.cancellation.cancelled_at||nowISO())};}
  if(profile.journey_stage==='reativacao'){patch.relationship_status='reativacao';patch.reactivation={...current.reactivation,...(mu.reactivation||{}),last_signal_at:nowISO(),score:Math.max(Number(current.reactivation?.score||0),Number(mu.reactivation?.score||60))};}
  return updateCustomerMemory(contactId,patch,{source:'ai',activity:false});
}
function customerMemoryPrompt(contact){
  const m=normalizeCustomerMemory(contact?.customer_memory,contact||{}); return {summary:m.summary,relationship_status:m.relationship_status,current_interest:m.current_interest,current_plan:m.current_plan,preferred_schedule:m.preferred_schedule,preferences:m.preferences,needs:m.needs,objections:m.objections,goals:m.goals,decision_factors:m.decision_factors,important_facts:[...m.pinned_facts,...m.important_facts].slice(0,40),commitments:m.commitments,cancellation:m.cancellation,reactivation:m.reactivation,manual_notes:m.manual_notes,timeline:m.timeline.slice(-12)};
}
function countAutomatedInitiations(contactId,days=7){const cutoff=Date.now()-Math.max(1,Number(days||7))*86400000;return state.activities.filter(a=>Number(a.contact_id)===Number(contactId)&&['proactive_followup_sent','journey_followup_sent'].includes(a.type)&&new Date(a.created_at).getTime()>=cutoff).length;}

function migrate(raw) {
  const state = raw && typeof raw === 'object' ? raw : emptyDB();
  state.schemaVersion = 10;
  state.nextContactId = Number(state.nextContactId || 1);
  state.nextMessageId = Number(state.nextMessageId || 1);
  state.nextActivityId = Number(state.nextActivityId || 1);
  state.nextCampaignId = Number(state.nextCampaignId || 1);
  state.nextQueueId = Number(state.nextQueueId || 1);
  state.nextTaskId = Number(state.nextTaskId || 1);
  state.nextEventId = Number(state.nextEventId || 1);
  state.nextQuickReplyId = Number(state.nextQuickReplyId || 1);
  state.contacts = Array.isArray(state.contacts) ? state.contacts : [];
  state.messages = Array.isArray(state.messages) ? state.messages : [];
  state.activities = Array.isArray(state.activities) ? state.activities : [];
  state.prospectCampaigns = Array.isArray(state.prospectCampaigns) ? state.prospectCampaigns : [];
  state.prospectQueue = Array.isArray(state.prospectQueue) ? state.prospectQueue : [];
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.calendarEvents = Array.isArray(state.calendarEvents) ? state.calendarEvents : [];
  state.quickReplies = Array.isArray(state.quickReplies) ? state.quickReplies : [];
  for (const q of state.quickReplies) {
    q.enabled = q.enabled !== false;
    q.match_mode = ['smart','contains_any','contains_all','exact'].includes(q.match_mode) ? q.match_mode : 'smart';
    q.smart_threshold = Math.max(.55,Math.min(.98,Number(q.smart_threshold||.76)));
    q.priority = Math.max(1,Math.min(999,Number(q.priority||35)));
    q.delay_min_ms = Math.max(0,Math.min(300000,Number(q.delay_min_ms||0)));
    q.delay_max_ms = Math.max(q.delay_min_ms,Math.min(300000,Number(q.delay_max_ms||0)));
    q.cooldown_hours = Math.max(0,Math.min(168,Number(q.cooldown_hours||0)));
    q.review_status = ['pending','approved','archived'].includes(q.review_status) ? q.review_status : ((q.source==='bootstrap_history'||q.source==='bootstrap_history_adapted')?'pending':'approved');
    q.valid_from = String(q.valid_from||'');
    q.expires_at = String(q.expires_at||'');
    q.learned_at = String(q.learned_at||q.created_at||'');
    q.last_seen_at = String(q.last_seen_at||'');
    q.human_locked = q.human_locked!==false && q.review_status!=='pending';
    if(q.review_status!=='approved') q.auto_use=false;
  }

  for (const c of state.contacts) {
    Object.assign(c, {
      phone: normalizePhone(c.phone),
      connection_id: c.connection_id || 'primary',
      name: c.name || null,
      status: VALID_STATUSES.includes(c.status) ? c.status : 'novo_lead',
      tags: c.tags || '',
      notes: c.notes || '',
      opted_out: Number(c.opted_out || 0),
      consent_status: c.consent_status || (c.opted_out ? 'opted_out' : 'unknown'),
      consent_source: c.consent_source || '',
      consent_at: c.consent_at || null,
      consent_categories: (()=>{const base={service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown'};const raw=c.consent_categories&&typeof c.consent_categories==='object'?c.consent_categories:{};const out={...base,...raw};if(c.opted_out||c.consent_status==='opted_out')for(const k of Object.keys(out))out[k]='opted_out';else if(c.consent_status==='opted_in'){out.service=out.service==='unknown'?'opted_in':out.service;if(c.consent_source==='campanha_confirmada')out.marketing='opted_in';}return out;})(),
      assigned_agent_id: c.assigned_agent_id == null ? null : Number(c.assigned_agent_id),
      previous_agent_id: c.previous_agent_id == null ? null : Number(c.previous_agent_id),
      ai_paused: Number(c.ai_paused || 0),
      last_message_at: c.last_message_at || null,
      last_inbound_at: c.last_inbound_at || null,
      last_outbound_at: c.last_outbound_at || null,
      last_campaign_sent_at: c.last_campaign_sent_at || null,
      created_at: c.created_at || nowISO(),
      updated_at: c.updated_at || c.created_at || nowISO(),
      lead_source: c.lead_source || 'whatsapp',
      customer_type: c.customer_type==='aluno'?'cliente':c.customer_type==='ex_aluno'?'ex_cliente':(c.customer_type || 'nao_identificado'),
      interest: c.interest || '',
      profile_summary: c.profile_summary || '',
      needs: c.needs || '',
      objections: c.objections || '',
      goals: c.goals || '',
      preferred_schedule: c.preferred_schedule || '',
      last_intent: c.last_intent || '',
      department: c.department || 'atendimento',
      next_action: c.next_action || '',
      follow_up_at: c.follow_up_at || null,
      unread_count: Number(c.unread_count || 0),
      lifecycle_score: Number(c.lifecycle_score || 0),
      assigned_reason: c.assigned_reason || '',
      transferred_at: c.transferred_at || null,
      profile_updated_at: c.profile_updated_at || null,
      journey_stage: crmConfig.isStage(c.journey_stage) ? c.journey_stage : (crmConfig.stageIds()[0] || 'contato_inicial'),
      journey_updated_at: c.journey_updated_at || null,
      prospecting_campaign_id: c.prospecting_campaign_id == null ? null : Number(c.prospecting_campaign_id),
      prospecting_origin: c.prospecting_origin || '',
      last_prospect_at: c.last_prospect_at || null,
      journey_followup_stage: c.journey_followup_stage || '',
      journey_followup_sent_at: c.journey_followup_sent_at || null,
      deal_value: Number(c.deal_value || 0),
      plan_name: c.plan_name || '',
      lead_score: Number(c.lead_score ?? c.lifecycle_score ?? 0),
      lead_temperature: c.lead_temperature || 'frio',
      next_best_action: c.next_best_action || c.next_action || '',
      last_ai_analysis_at: c.last_ai_analysis_at || null,
      requires_human: Number(c.requires_human || 0),
      human_reason: c.human_reason || '',
      ai_confidence: c.ai_confidence == null ? 1 : Number(c.ai_confidence),
      human_review_at: c.human_review_at || null,
      bootstrap_pending_reply_at: c.bootstrap_pending_reply_at || null,
      bootstrap_pending_external_id: c.bootstrap_pending_external_id || '',
      ai_decision_reason: c.ai_decision_reason || '',
      ai_confidence_reason: c.ai_confidence_reason || '',
      knowledge_gaps: Array.isArray(c.knowledge_gaps) ? c.knowledge_gaps.join(' | ') : (c.knowledge_gaps || ''),
      ai_suggested_reply: c.ai_suggested_reply || '',
      ai_suggestion_at: c.ai_suggestion_at || null,
      last_ai_action: c.last_ai_action || '',
      ai_feedback_score: Number(c.ai_feedback_score || 0),
      custom_fields: c.custom_fields && typeof c.custom_fields === 'object' && !Array.isArray(c.custom_fields) ? c.custom_fields : {},
      proactive_scenario: c.proactive_scenario || '',
      proactive_attempts: Number(c.proactive_attempts || 0),
      proactive_last_sent_at: c.proactive_last_sent_at || null,
      proactive_cycle_anchor: c.proactive_cycle_anchor || null,
      proactive_last_message: c.proactive_last_message || '',
      proactive_disabled: Number(c.proactive_disabled || 0),
      customer_memory: normalizeCustomerMemory(c.customer_memory, c),
    });
  }

  for (const campaign of state.prospectCampaigns) {
    Object.assign(campaign, {
      name: campaign.name || `Campanha ${campaign.id}`,
      initial_message: campaign.initial_message || '',
      stage: crmConfig.isStage(campaign.stage) ? campaign.stage : (crmConfig.stageIds()[0] || 'contato_inicial'),
      status: ['draft','running','paused','completed'].includes(campaign.status) ? campaign.status : 'draft',
      interval_seconds: Math.max(60, Number(campaign.interval_seconds || 120)),
      daily_limit: Math.max(1, Number(campaign.daily_limit || 50)),
      confirmed_permission: Boolean(campaign.confirmed_permission),
      created_by_agent_id: campaign.created_by_agent_id == null ? null : Number(campaign.created_by_agent_id),
      created_at: campaign.created_at || nowISO(),
      started_at: campaign.started_at || null,
      paused_at: campaign.paused_at || null,
      completed_at: campaign.completed_at || null,
      last_sent_at: campaign.last_sent_at || null,
      source: campaign.source || '',
      source_key: campaign.source_key || '',
      auto_generated: Boolean(campaign.auto_generated),
      last_auto_message: campaign.last_auto_message || '',
      audience_hint: campaign.audience_hint || '',
      learned_from_history: Boolean(campaign.learned_from_history),
    });
  }

  for (const item of state.prospectQueue) {
    Object.assign(item, {
      campaign_id: Number(item.campaign_id), contact_id: Number(item.contact_id),
      status: ['pending','sending','sent','replied','skipped','failed'].includes(item.status) ? item.status : 'pending',
      attempts: Number(item.attempts || 0), error: item.error || '', created_at: item.created_at || nowISO(),
      sent_at: item.sent_at || null, replied_at: item.replied_at || null, next_attempt_at:item.next_attempt_at||null, last_attempt_at:item.last_attempt_at||null,
    });
    if(item.status==='sending'){item.status='pending';item.error='Recuperado após reinício durante envio';item.next_attempt_at=new Date(Date.now()+10*60000).toISOString();}
  }

  const maxContact = state.contacts.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
  const maxMessage = state.messages.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
  const maxActivity = state.activities.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
  const maxCampaign = state.prospectCampaigns.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
  const maxQueue = state.prospectQueue.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
  const maxTask = state.tasks.reduce((m,x)=>Math.max(m,Number(x.id||0)),0);
  const maxEvent = state.calendarEvents.reduce((m,x)=>Math.max(m,Number(x.id||0)),0);
  const maxQuick = state.quickReplies.reduce((m,x)=>Math.max(m,Number(x.id||0)),0);
  state.nextContactId = Math.max(state.nextContactId, maxContact + 1);
  state.nextMessageId = Math.max(state.nextMessageId, maxMessage + 1);
  state.nextActivityId = Math.max(state.nextActivityId, maxActivity + 1);
  state.nextCampaignId = Math.max(state.nextCampaignId, maxCampaign + 1);
  state.nextQueueId = Math.max(state.nextQueueId, maxQueue + 1);
  state.nextTaskId = Math.max(state.nextTaskId, maxTask + 1);
  state.nextEventId = Math.max(state.nextEventId, maxEvent + 1);
  state.nextQuickReplyId = Math.max(state.nextQuickReplyId, maxQuick + 1);
  return state;
}

function load() {
  const forceJson=fs.existsSync(FORCE_JSON_IMPORT_FLAG);
  if (sqliteDb && !forceJson) {
    try { const row=sqliteDb.prepare('SELECT state_json FROM app_state WHERE id=1').get(); if(row?.state_json)return migrate(JSON.parse(row.state_json)); } catch(err){ console.error('⚠️ Snapshot SQLite inválido:',err.message); }
  }
  if (!fs.existsSync(DB_PATH)) return emptyDB();
  try { const legacy=migrate(JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))); if(sqliteDb){try{sqliteDb.prepare('INSERT OR REPLACE INTO app_state(id,state_json,updated_at) VALUES(1,?,?)').run(JSON.stringify(legacy),nowISO());if(!forceJson)fs.copyFileSync(DB_PATH,`${DB_PATH}.migrado-${Date.now()}.bak`);if(forceJson)fs.rmSync(FORCE_JSON_IMPORT_FLAG,{force:true});}catch(_){}} return legacy; }
  catch (err) {
    console.error('⚠️ Banco corrompido. Mantendo backup e iniciando base nova:', err.message);
    try { fs.copyFileSync(DB_PATH, `${DB_PATH}.corrompido-${Date.now()}.bak`); } catch (_) {}
    return emptyDB();
  }
}

let state = load();
let batchDepth = 0, dirty = false;
let contactByPhone = new Map(), contactById = new Map(), messageExternalIds = new Set(), messagesByContact = new Map(), activitiesByContact = new Map();
function rebuildIndexes() {
  contactByPhone = new Map(state.contacts.map(c => [String(c.phone), c]));
  contactById = new Map(state.contacts.map(c => [Number(c.id), c]));
  messageExternalIds = new Set(state.messages.map(m => m.external_id).filter(Boolean));
  messagesByContact = new Map();
  for (const m of state.messages) { const id=Number(m.contact_id); if(!messagesByContact.has(id)) messagesByContact.set(id,[]); messagesByContact.get(id).push(m); }
  activitiesByContact = new Map();
  for (const a of state.activities) { const id=Number(a.contact_id); if(!activitiesByContact.has(id)) activitiesByContact.set(id,[]); activitiesByContact.get(id).push(a); }
}
function repairHistoricalContactMetadata() {
  let changed=0;
  for (const c of state.contacts) {
    const rows=messagesByContact.get(Number(c.id))||[];
    if(!rows.length) continue;
    let last=null,lastIn=null,lastOut=null;
    for(const m of rows){
      if(!m.created_at) continue;
      if(!last || String(m.created_at)>String(last.created_at)) last=m;
      if(m.direction==='in' && (!lastIn || String(m.created_at)>String(lastIn.created_at))) lastIn=m;
      if(m.direction==='out' && (!lastOut || String(m.created_at)>String(lastOut.created_at))) lastOut=m;
    }
    const patch={};
    if(last && (!c.last_message_at || String(last.created_at)>String(c.last_message_at))) patch.last_message_at=last.created_at;
    if(lastIn && (!c.last_inbound_at || String(lastIn.created_at)>String(c.last_inbound_at))) patch.last_inbound_at=lastIn.created_at;
    if(lastOut && (!c.last_outbound_at || String(lastOut.created_at)>String(c.last_outbound_at))) patch.last_outbound_at=lastOut.created_at;
    if(Object.keys(patch).length){Object.assign(c,patch);changed++;}
  }
  if(changed) dirty=true;
  return changed;
}

function persist() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const json=JSON.stringify(state);
  if(sqliteDb){try{sqliteDb.exec('BEGIN IMMEDIATE');sqliteDb.prepare('INSERT OR REPLACE INTO app_state(id,state_json,updated_at) VALUES(1,?,?)').run(json,nowISO());sqliteDb.exec('COMMIT');}catch(err){try{sqliteDb.exec('ROLLBACK')}catch(_){};sqliteRuntimeError=`Falha de escrita no SQLite: ${String(err?.message||err)}`;console.error('Falha ao persistir SQLite; alternando para JSON:',err.message);try{sqliteDb.close?.();}catch(_){};sqliteDb=null;}}
  // Mantém um espelho JSON legível/compatível para backup e diagnóstico.
  const tmp = `${DB_PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8'); fs.renameSync(tmp, DB_PATH);
  dirty = false;
}
let persistTimer=null;
function schedulePersist(delay=35){
  if(persistTimer||batchDepth>0)return;
  persistTimer=setTimeout(()=>{persistTimer=null;if(dirty&&batchDepth===0)persist();},Math.max(0,Number(delay||0)));
  if(typeof persistTimer.unref==='function')persistTimer.unref();
}
function save() { dirty = true; if (batchDepth > 0) return; schedulePersist(35); }
function flush(){ if(persistTimer){clearTimeout(persistTimer);persistTimer=null;} if(dirty)persist(); }
function beginBatch() { batchDepth++; }
function endBatch() { batchDepth = Math.max(0, batchDepth - 1); if (batchDepth === 0 && dirty) schedulePersist(0); }
function runBatch(fn) { beginBatch(); try { return fn(); } finally { endBatch(); } }
process.once('beforeExit',()=>{try{flush();}catch(_){}});
process.once('exit',()=>{try{flush();}catch(_){}});
rebuildIndexes();
repairHistoricalContactMetadata();
save();

function getContactByPhone(phone) { const p = normalizePhone(phone); return contactByPhone.get(p) || null; }
function getContactById(id) { return contactById.get(Number(id)) || null; }

function addActivity(contactId, type, details = {}, agentId = null) {
  const activity = { id: state.nextActivityId++, contact_id: Number(contactId), type, details, agent_id: agentId == null ? null : Number(agentId), created_at: nowISO() };
  state.activities.push(activity); if(!activitiesByContact.has(Number(contactId)))activitiesByContact.set(Number(contactId),[]); activitiesByContact.get(Number(contactId)).push(activity); save(); return activity;
}

function upsertContact(phone, name, options = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  let contact = getContactByPhone(normalized);
  if (contact) {
    if (name && (!contact.name || contact.name === contact.phone)) contact.name = name;
    if (options.leadSource) contact.lead_source = options.leadSource;
    if (options.consentStatus) contact.consent_status = options.consentStatus;
    if (options.consentSource) contact.consent_source = options.consentSource;
    contact.updated_at = nowISO(); save(); return contact;
  }
  contact = migrate({ contacts: [{ id: state.nextContactId++, phone: normalized, name: name || null, lead_source: options.leadSource || 'whatsapp', consent_status: options.consentStatus || 'unknown', consent_source: options.consentSource || '' }] }).contacts[0];
  state.contacts.push(contact); contactByPhone.set(contact.phone, contact); contactById.set(Number(contact.id), contact); save(); addActivity(contact.id, 'contact_created', { source: contact.lead_source }); return contact;
}

function updateContact(contactId, patch = {}, options = {}) {
  const c = getContactById(contactId); if (!c) return null;
  const allowed = [
    'name','tags','notes','lead_source','customer_type','interest','profile_summary','needs','objections','goals',
    'preferred_schedule','last_intent','department','next_action','follow_up_at','lifecycle_score','opted_out',
    'consent_status','consent_source','consent_at','prospecting_campaign_id','prospecting_origin','last_prospect_at',
    'deal_value','plan_name','lead_score','lead_temperature','next_best_action','last_ai_analysis_at','requires_human','human_reason','ai_confidence','human_review_at',
    'bootstrap_pending_reply_at','bootstrap_pending_external_id','ai_decision_reason','ai_confidence_reason','knowledge_gaps','ai_suggested_reply','ai_suggestion_at','last_ai_action','ai_feedback_score','custom_fields','customer_memory','proactive_scenario','proactive_attempts','proactive_last_sent_at','proactive_cycle_anchor','proactive_last_message','proactive_disabled'
  ];
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k];
  if (Object.prototype.hasOwnProperty.call(patch,'lead_score')) { c.lead_score=Math.max(0,Math.min(100,Number(c.lead_score||0))); c.lifecycle_score=c.lead_score; c.lead_temperature=c.lead_score>=75?'quente':c.lead_score>=45?'morno':'frio'; }
  if (Object.prototype.hasOwnProperty.call(patch,'tags')) c.tags=normalizeTags(c.tags);
  c.updated_at = nowISO();
  if (options.activity !== false) addActivity(c.id, 'contact_updated', { fields: Object.keys(patch) }, options.agentId || null); else save();
  emitRealtime('contact_updated',c.id,{fields:Object.keys(patch)});
  return c;
}

function setJourneyStage(contactId, stage, meta = {}) {
  const c = getContactById(contactId); if (!c || !crmConfig.isStage(stage)) return false;
  if (c.journey_stage === stage) return true;
  const previous = c.journey_stage; c.journey_stage = stage; c.journey_updated_at = nowISO(); c.journey_followup_stage = ''; c.journey_followup_sent_at = null; c.updated_at = nowISO(); save();
  const mem=getCustomerMemory(c.id); if(mem){const patch={}; if(stage==='cancelamento'||stage==='pos_cancelamento'){patch.relationship_status=stage;patch.cancellation={...mem.cancellation,cancelled_at:mem.cancellation.cancelled_at||nowISO()};} if(stage==='reativacao'){patch.relationship_status='reativacao';patch.reactivation={...mem.reactivation,last_signal_at:nowISO(),score:Math.max(60,Number(mem.reactivation.score||0))};} if(stage==='acompanhamento'&&c.status==='ativo')patch.relationship_status='cliente_ativo'; if(Object.keys(patch).length)updateCustomerMemory(c.id,patch,{source:'system',activity:false}); appendCustomerMemoryEvent(c.id,'journey',`Etapa: ${stage}`,`Mudou de ${previous||'sem etapa'} para ${stage}`,meta.reason||'system');}
  addActivity(c.id, 'journey_stage_changed', { from: previous, to: stage, reason: meta.reason || '', undoable:true }, meta.agentId || null); emitRealtime('journey_changed',c.id,{stage}); return true;
}

function setConsent(contactId, status, source = '', agentId = null) {
  if (!['unknown','opted_in','opted_out'].includes(status)) return false;
  const c = getContactById(contactId); if (!c) return false;
  c.consent_status = status; c.opted_out = status === 'opted_out' ? 1 : 0; c.consent_source = source || c.consent_source || '';
  const ledger={service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown',...(c.consent_categories||{})};
  if(status==='opted_out') for(const k of Object.keys(ledger)) ledger[k]='opted_out';
  if(status==='opted_in'){ledger.service='opted_in'; if(source==='campanha_confirmada')ledger.marketing='opted_in';}
  c.consent_categories=ledger;
  c.consent_at = nowISO(); c.updated_at = nowISO(); save();
  addActivity(c.id, 'consent_changed', { status, source }, agentId); emitRealtime('consent_changed',c.id,{status,categories:ledger}); return true;
}
function setConsentCategory(contactId, category, status, source='', agentId=null){
  const allowed=['service','updates','marketing','reactivation']; if(!allowed.includes(String(category)))return false;
  if(!['unknown','opted_in','opted_out'].includes(status))return false;
  const c=getContactById(contactId);if(!c)return false;
  const ledger={service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown',...(c.consent_categories||{})};ledger[category]=status;c.consent_categories=ledger;c.consent_at=nowISO();c.updated_at=nowISO();
  if(Object.values(ledger).every(v=>v==='opted_out')){c.consent_status='opted_out';c.opted_out=1;}else if(c.consent_status==='opted_out'&&status==='opted_in'){c.consent_status='unknown';c.opted_out=0;}
  save();addActivity(c.id,'consent_category_changed',{category,status,source},agentId);emitRealtime('consent_changed',c.id,{category,status,categories:ledger});return true;
}
function getConsentLedger(contactId){const c=getContactById(contactId);if(!c)return null;return {overall:c.consent_status||'unknown',source:c.consent_source||'',at:c.consent_at||null,categories:{service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown',...(c.consent_categories||{})}};}

function setStatus(contactId, status, meta = {}) {
  const c = getContactById(contactId); if (!c || !VALID_STATUSES.includes(status)) return false;
  if (c.status === status) return true;
  const previous = c.status; c.status = status; c.updated_at = nowISO(); save();
  const mem=getCustomerMemory(c.id); if(mem){let rel=mem.relationship_status;if(status==='ativo')rel='cliente_ativo';else if(status==='inativo'&& !['cancelamento','pos_cancelamento'].includes(rel))rel='inativo';else if(['novo_lead','interessado','pendente_pagamento'].includes(status)&&!['cancelamento','pos_cancelamento'].includes(rel))rel='lead'; if(rel!==mem.relationship_status)updateCustomerMemory(c.id,{relationship_status:rel},{source:'system',activity:false}); appendCustomerMemoryEvent(c.id,'status',`Status: ${status}`,`Mudou de ${previous||'sem status'} para ${status}`,meta.reason||'system');}
  addActivity(c.id, 'status_changed', { from: previous, to: status, reason: meta.reason || '', undoable:true }, meta.agentId || null); emitRealtime('status_changed',c.id,{status}); return true;
}

function touchInbound(contactId) { const c = getContactById(contactId); if (!c) return; c.last_message_at = nowISO(); c.last_inbound_at = c.last_message_at; c.updated_at = c.last_message_at; c.unread_count = Number(c.unread_count || 0) + 1; c.proactive_scenario=''; c.proactive_attempts=0; c.proactive_cycle_anchor=null; c.proactive_last_message=''; if(!c.opted_out){c.next_action='Responder cliente';c.next_best_action='Responder cliente';} save(); emitRealtime('message_in',c.id); }
function touchOutbound(contactId) { const c = getContactById(contactId); if (!c) return; c.last_message_at = nowISO(); c.last_outbound_at = c.last_message_at; c.updated_at = c.last_message_at; if(!c.opted_out){c.next_action='Aguardar resposta do cliente';c.next_best_action='Aguardar resposta do cliente';} save(); emitRealtime('message_out',c.id); }
function markRead(contactId) { const c = getContactById(contactId); if (c) { c.unread_count = 0; save(); emitRealtime('contact_read',c.id); } }

function setAssignedAgent(contactId, agentId, meta = {}) {
  const c = getContactById(contactId); if (!c) return null;
  const next = agentId == null ? null : Number(agentId); if (c.assigned_agent_id === next) return c;
  const previous = c.assigned_agent_id; c.previous_agent_id = previous; c.assigned_agent_id = next; c.assigned_reason = meta.reason || 'manual'; c.transferred_at = nowISO(); c.updated_at = nowISO(); save();
  addActivity(c.id, 'assignment_changed', { from: previous, to: next, reason: meta.reason || 'manual', undoable:true }, meta.byAgentId || null); emitRealtime('assignment_changed',c.id,{agentId:next}); return c;
}

function setAIPaused(contactId, paused, meta = {}) {
  const c = getContactById(contactId); if (!c) return;
  const next = paused ? 1 : 0; if (c.ai_paused === next) return;
  c.ai_paused = next; c.updated_at = nowISO(); save(); addActivity(c.id, paused ? 'ai_paused' : 'ai_resumed', { reason: meta.reason || '' }, meta.agentId || null); emitRealtime(paused?'ai_paused':'ai_resumed',c.id);
}

function workloadForAgent(agentId) { return state.contacts.filter((c) => c.assigned_agent_id === Number(agentId) && c.status !== 'inativo').length; }
function assignAgentAutomatically(contactId, activeAgents, department = 'atendimento', reason = 'distribuicao_automatica') {
  const normalizedDept=String(department||'atendimento').toLowerCase();
  const roleMap={atendimento:['atendimento','comercial'],comercial:['comercial'],financeiro:['financeiro'],retencao:['atendimento','comercial'],gestao:['gestor']};
  const allowedRoles=roleMap[normalizedDept]||['atendimento','comercial'];
  const agentList=(activeAgents||[]).map((a)=>typeof a==='number'?{id:a,role:'atendimento',specialties:[]} : a).filter(a=>a&&a.id&&a.active!==false);
  if(!agentList.length)return null;
  const roleEligible=agentList.filter(a=>allowedRoles.includes(String(a.role||'atendimento')));
  const safeBase=roleEligible.length?roleEligible:agentList.filter(a=>!['gestor','financeiro'].includes(String(a.role||'')));
  const base=safeBase.length?safeBase:agentList;
  const exact=base.filter(a=>Array.isArray(a.specialties)&&a.specialties.map(String).includes(normalizedDept));
  const general=base.filter(a=>Array.isArray(a.specialties)&&a.specialties.map(String).includes('geral'));
  const pool=exact.length?exact:(general.length?general:base);
  const ranked=pool.map(a=>({a,count:workloadForAgent(a.id)})).sort((x,y)=>x.count-y.count||x.a.id-y.a.id);
  const chosen=ranked[0]?.a?.id; if(chosen==null)return null;
  setAssignedAgent(contactId,chosen,{reason:`${reason}:${normalizedDept}`}); return chosen;
}

function applyAIProfile(contactId, profile = {}) {
  const c = getContactById(contactId); if (!c) return null;
  const fields = ['customer_type','interest','profile_summary','needs','objections','goals','preferred_schedule','last_intent','department','next_action','lifecycle_score','deal_value','plan_name','lead_score','lead_temperature','next_best_action','follow_up_at','ai_confidence','ai_decision_reason','ai_confidence_reason','knowledge_gaps','last_ai_action'];
  for (const k of fields) if (profile[k] !== undefined && profile[k] !== null && profile[k] !== '') c[k] = profile[k];
  if (profile.status && ['novo_lead','interessado'].includes(profile.status) && ['novo_lead','interessado'].includes(c.status)) setStatus(contactId, profile.status, { reason: 'classificacao_ia' });
  if (profile.journey_stage && crmConfig.isStage(profile.journey_stage)) setJourneyStage(contactId, profile.journey_stage, { reason: 'classificacao_ia' });
  if (Array.isArray(profile.tags)) c.tags = normalizeTags([...(String(c.tags||'').split(',')), ...profile.tags]);
  if (profile.lead_score !== undefined) { c.lead_score=Math.max(0,Math.min(100,Number(profile.lead_score||0))); c.lifecycle_score=c.lead_score; c.lead_temperature=c.lead_score>=75?'quente':c.lead_score>=45?'morno':'frio'; }
  c.last_ai_analysis_at=nowISO();
  if (profile.handoff_required === true) { c.requires_human=1; c.human_reason=String(profile.handoff_reason || profile.human_reason || 'IA solicitou intervenção humana'); c.human_review_at=nowISO(); c.ai_paused=1; }
  if (profile.task_title && validOperationalDate(profile.follow_up_at) && !state.tasks.some(t=>t.contact_id===c.id&&t.status==='pending'&&t.title===String(profile.task_title)&&t.due_at===profile.follow_up_at)) createTask({contact_id:c.id,title:String(profile.task_title),due_at:profile.follow_up_at,assigned_agent_id:c.assigned_agent_id,priority:'normal'},c.assigned_agent_id);
  if (profile.appointment_title && validOperationalDate(profile.appointment_start_at) && !state.calendarEvents.some(e=>e.contact_id===c.id&&e.start_at===profile.appointment_start_at&&e.title===String(profile.appointment_title))) createCalendarEvent({contact_id:c.id,title:String(profile.appointment_title),start_at:profile.appointment_start_at,type:profile.appointment_type||'geral',assigned_agent_id:c.assigned_agent_id},c.assigned_agent_id);
  applyMemoryFromProfile(contactId,profile); c.profile_updated_at = nowISO(); c.updated_at = nowISO(); save(); addActivity(contactId, 'ai_profile_updated', { intent: profile.last_intent || '', department: profile.department || '', journey_stage: profile.journey_stage || '', decision_reason:profile.ai_decision_reason||'', confidence:Number(profile.ai_confidence??1) }); emitRealtime('ai_profile_updated',c.id,{fields:Object.keys(profile||{})}); return c;
}

function normalizeSignalText(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
function advanceJourneyInstant(c,target){
  const order=['contato_inicial','apresentacao_plano','fechamento','agendamento_avaliacao','pos_avaliacao','primeiro_treino','acompanhamento','cancelamento','pos_cancelamento','reativacao'];
  const current=order.indexOf(c.journey_stage), next=order.indexOf(target);
  if(next<0)return false;
  if(['cancelamento','pos_cancelamento','reativacao'].includes(c.journey_stage)&&!['cancelamento','pos_cancelamento','reativacao'].includes(target))return false;
  if(current<0||next>current){c.journey_stage=target;c.journey_updated_at=nowISO();return true;}
  return false;
}
function applyRealtimeMessageSignals(contactId,text,direction='in'){
  const c=getContactById(contactId);if(!c)return null;
  const raw=String(text||'').trim(); const t=normalizeSignalText(raw); let changed=[]; let close=false,cancel=false;
  if(direction==='out'){
    if(!c.opted_out){c.next_action='Aguardar resposta do cliente';c.next_best_action='Aguardar resposta do cliente';changed.push('next_action');}
  } else if(t){
    const set=(k,v)=>{if(v!==undefined&&v!==null&&v!==''&&c[k]!==v){c[k]=v;changed.push(k);}};
    let floor=0, journey='';
    close=/(quero fechar|vamos fechar|quero contratar|quero comprar|quero pedir|quero assinar|quero (me )?matricular|aprovar (o )?orcamento|aprovar (a )?proposta|pode fechar|pode confirmar|manda (o )?(pix|link)|como (eu )?pago|onde pago)/.test(t);
    const payment=/(pix|cartao|pagamento|boleto|pagar|forma de pagamento|parcel)/.test(t);
    const plans=/(plano|planos|pacote|assinatura|produto|produtos|servico|servicos|serviço|serviços|orcamento|orçamento|proposta|cotacao|cotação|preco|valor|quanto custa|quanto fica|quanto e|valores)/.test(t);
    const trial=/(agendar|marcar horario|marcar horário|consulta|reuniao|reunião|demonstracao|demonstração|visita|experimentar|aula experimental|aula teste|conhecer|atendimento)/.test(t);
    const schedule=/(horario|horarios|que horas|abre|fecha|funciona|atendimento)/.test(t);
    const location=/(onde fica|endereco|localizacao|como chegar)/.test(t);
    cancel=/(cancelar|cancelamento|encerrar|rescindir|desistir|trancar|parar (o )?(servico|serviço|plano|contrato|assinatura))/.test(t);
    if(close){set('last_intent','fechamento');set('interest',c.interest||'Matrícula');set('next_action','Conduzir fechamento');set('next_best_action','Conduzir fechamento');floor=88;journey='fechamento';}
    else if(payment){set('last_intent','pagamento');set('interest',c.interest||'Pagamento / matrícula');set('next_action','Orientar pagamento e avançar fechamento');set('next_best_action','Orientar pagamento e avançar fechamento');floor=80;journey='fechamento';}
    else if(plans){set('last_intent','oferta_e_valores');set('interest',c.interest||'Oferta e valores');set('next_action','Responder sobre opções/valores e qualificar interesse');set('next_best_action','Responder sobre opções/valores e qualificar interesse');floor=60;journey='apresentacao_plano';}
    else if(trial){set('last_intent','agendamento_ou_demonstracao');set('interest',c.interest||'Agendamento / demonstração');set('next_action','Conduzir para agendamento ou próximo passo');set('next_best_action','Conduzir para agendamento ou próximo passo');floor=68;}
    else if(schedule){set('last_intent','horarios');set('next_action','Responder horários e manter conversa');set('next_best_action','Responder horários e manter conversa');floor=45;}
    else if(location){set('last_intent','localizacao');set('next_action','Responder localização e manter conversa');set('next_best_action','Responder localização e manter conversa');floor=42;}
    else if(cancel){set('last_intent','cancelamento');set('next_action','Entender motivo e tratar cancelamento');set('next_best_action','Entender motivo e tratar cancelamento');journey='cancelamento';}
    else {set('next_action','Responder cliente');set('next_best_action','Responder cliente');}
    if(floor>Number(c.lead_score||0)){c.lead_score=floor;c.lifecycle_score=floor;c.lead_temperature=floor>=75?'quente':floor>=45?'morno':'frio';changed.push('lead_score','lead_temperature');}
    if(floor>=45&&c.status==='novo_lead'){c.status='interessado';changed.push('status');}
    if(journey&&advanceJourneyInstant(c,journey))changed.push('journey_stage');
  }
  if(changed.length){c.updated_at=nowISO();save();emitRealtime('crm_instant_update',c.id,{fields:[...new Set(changed)],direction});
    const mem=getCustomerMemory(c.id); if(mem&&direction==='in'){
      const mp={current_interest:c.interest||mem.current_interest,current_plan:c.plan_name||mem.current_plan,preferred_schedule:c.preferred_schedule||mem.preferred_schedule};
      if(cancel){mp.relationship_status='cancelamento';mp.cancellation={...mem.cancellation,cancelled_at:mem.cancellation.cancelled_at||nowISO()};}
      if(close){mp.relationship_status='lead';mp.important_facts=uniqTextList([...(mem.important_facts||[]),'Demonstrou intenção explícita de fechamento'],40);}
      updateCustomerMemory(c.id,mp,{source:'realtime',activity:false});
    }
  }
  return c;
}

function listContacts(filterStatus) { let list = [...state.contacts]; if (filterStatus) list = list.filter((c) => c.status === filterStatus); return list.sort((a,b) => String(b.last_message_at || b.created_at || '').localeCompare(String(a.last_message_at || a.created_at || ''))); }
function listContactsByAgent(agentId, status, includeUnassigned=false) { const id=Number(agentId); let list = state.contacts.filter((c) => c.assigned_agent_id === id || (includeUnassigned && c.assigned_agent_id == null)); if (status) list = list.filter((c) => c.status === status); return list.sort((a,b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''))); }
function listOperationalContactsForAgent(agentId,status){ return listContactsByAgent(agentId,status,true); }

function findInactive(days) {
  const cutoff = Date.now() - days * 86400000; const cooldown = Date.now() - 14 * 86400000;
  return state.contacts.filter((c) => { if (c.status !== 'ativo' || c.opted_out) return false; const lastInbound = c.last_inbound_at ? new Date(c.last_inbound_at).getTime() : 0; const lastCampaign = c.last_campaign_sent_at ? new Date(c.last_campaign_sent_at).getTime() : 0; return lastInbound <= cutoff && lastCampaign <= cooldown; });
}
function markCampaignSent(contactId) { const c = getContactById(contactId); if (c) { c.last_campaign_sent_at = nowISO(); save(); addActivity(c.id,'reactivation_sent',{}); } }

function messageExists(externalId) { return Boolean(externalId && messageExternalIds.has(externalId)); }
function logMessage(contactId, direction, type, body, flowMatched, agentId, isHistorical, timestamp, externalId) {
  if (externalId && messageExists(externalId)) return null;
  const message = { id: state.nextMessageId++, connection_id:'primary', contact_id: Number(contactId), direction, type: type || 'text', body: body || '', flow_matched: flowMatched || null, agent_id: agentId == null ? null : Number(agentId), is_historical: isHistorical ? 1 : 0, external_id: externalId || null, created_at: timestamp || nowISO() };
  state.messages.push(message); if(!messagesByContact.has(Number(contactId)))messagesByContact.set(Number(contactId),[]); messagesByContact.get(Number(contactId)).push(message); if (externalId) messageExternalIds.add(externalId); save(); if(!isHistorical) emitRealtime('message_logged',Number(contactId),{direction,type:message.type,messageId:message.id}); return message;
}
function importHistoricalMessage(contactId, direction, type, body, timestamp, externalId) {
  const m=logMessage(contactId, direction, type, body, null, null, true, timestamp, externalId);
  if(!m) return null;
  const c=getContactById(contactId);
  if(c){
    const ts=m.created_at||timestamp||nowISO();
    if(!c.last_message_at || String(ts)>String(c.last_message_at)) c.last_message_at=ts;
    if(direction==='in' && (!c.last_inbound_at || String(ts)>String(c.last_inbound_at))) c.last_inbound_at=ts;
    if(direction==='out' && (!c.last_outbound_at || String(ts)>String(c.last_outbound_at))) c.last_outbound_at=ts;
    // Histórico reconstrói atividade, mas não cria milhares de mensagens não lidas.
    c.updated_at=c.updated_at||ts;
    save();
  }
  return m;
}
function getContactMessages(contactId, includeHistorical = true) { const rows=messagesByContact.get(Number(contactId))||[]; const filtered=includeHistorical?rows:rows.filter(m=>!m.is_historical); return [...filtered].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))); }
function getRecentConversation(contactId, limit = 30) { return getContactMessages(contactId, true).slice(-limit); }
function getActivities(contactId, limit = 100) { return [...(activitiesByContact.get(Number(contactId))||[])].slice(-limit).reverse(); }
function getAllMessagesForAnalysis() { return [...state.messages].filter((m) => m.body && String(m.body).trim()).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at))).map((m) => ({ ...m, name: getContactById(m.contact_id)?.name || null })); }
function getRecentMessagesForAnalysis(limit = 500) { const max=Math.max(1,Math.min(5000,Number(limit||500))); return state.messages.slice().reverse().filter((m)=>m.body&&String(m.body).trim()).slice(0,max).reverse().map((m)=>({...m,name:getContactById(m.contact_id)?.name||null})); }
function sampleHistoricalMessages(limit = 400) { return getAllMessagesForAnalysis().filter((m) => m.is_historical).slice(-limit); }

// ---------- Prospecção ----------
function createProspectCampaign(payload = {}, agentId = null) {
  const campaign = {
    id: state.nextCampaignId++, name: String(payload.name || `Campanha ${state.nextCampaignId - 1}`).trim(),
    initial_message: String(payload.initial_message || '').trim(),
    stage: crmConfig.isStage(payload.stage) ? payload.stage : (crmConfig.stageIds()[0] || 'contato_inicial'), status: 'draft',
    interval_seconds: Math.max(60, Number(payload.interval_seconds || 120)), daily_limit: Math.max(1, Math.min(500, Number(payload.daily_limit || 50))),
    confirmed_permission: Boolean(payload.confirmed_permission), created_by_agent_id: agentId == null ? null : Number(agentId),
    source:String(payload.source||''),source_key:String(payload.source_key||''),auto_generated:Boolean(payload.auto_generated),last_auto_message:String(payload.last_auto_message||payload.initial_message||''),audience_hint:String(payload.audience_hint||''),learned_from_history:Boolean(payload.learned_from_history),
    created_at: nowISO(), started_at: null, paused_at: null, completed_at: null, last_sent_at: null,
  };
  state.prospectCampaigns.push(campaign); save(); return campaign;
}
function listProspectCampaigns() { return [...state.prospectCampaigns].sort((a,b) => b.id-a.id).map((c) => ({ ...c, metrics: getProspectCampaignMetrics(c.id) })); }
function getProspectCampaign(id) { return state.prospectCampaigns.find((c) => c.id === Number(id)) || null; }
function updateProspectCampaign(id, patch = {}) {
  const c = getProspectCampaign(id); if (!c) return null;
  if (patch.name !== undefined) c.name = String(patch.name).trim();
  if (patch.initial_message !== undefined) c.initial_message = String(patch.initial_message).trim();
  if (patch.stage && crmConfig.isStage(patch.stage)) c.stage = patch.stage;
  if (patch.interval_seconds !== undefined) c.interval_seconds = Math.max(60, Number(patch.interval_seconds || 120));
  if (patch.daily_limit !== undefined) c.daily_limit = Math.max(1, Math.min(500, Number(patch.daily_limit || 50)));
  if (patch.confirmed_permission !== undefined) c.confirmed_permission = Boolean(patch.confirmed_permission);
  for(const k of ['source','source_key','last_auto_message','audience_hint']) if(patch[k]!==undefined) c[k]=String(patch[k]||'');
  for(const k of ['auto_generated','learned_from_history']) if(patch[k]!==undefined) c[k]=Boolean(patch[k]);
  save(); return c;
}
function setProspectCampaignStatus(id, status) {
  const c = getProspectCampaign(id); if (!c || !['draft','running','paused','completed'].includes(status)) return null;
  c.status = status; if (status === 'running' && !c.started_at) c.started_at = nowISO(); if (status === 'paused') c.paused_at = nowISO(); if (status === 'completed') c.completed_at = nowISO(); save(); return c;
}
function addProspectsToCampaign(campaignId, rows = [], options = {}) {
  const campaign = getProspectCampaign(campaignId); if (!campaign) throw new Error('Campanha não encontrada');
  let added = 0, duplicates = 0, invalid = 0;
  beginBatch();
  try {
    const queuedPhones = new Set(state.prospectQueue.filter(q=>q.campaign_id===campaign.id).map(q=>getContactById(q.contact_id)?.phone).filter(Boolean));
    for (const row of rows) {
      const phone = normalizePhone(typeof row === 'string' ? row : row.phone); if (phone.length < 10 || phone.length > 15) { invalid++; continue; }
      if (queuedPhones.has(phone)) { duplicates++; continue; }
      const name = typeof row === 'object' ? row.name : null;
      const contact = upsertContact(phone, name, { leadSource: 'prospeccao', consentStatus: options.confirmedPermission ? 'opted_in' : 'unknown', consentSource: options.source || 'lista_importada' });
      if (options.confirmedPermission) { setConsent(contact.id, 'opted_in', options.source || 'lista_importada', options.agentId || null); setConsentCategory(contact.id,'marketing','opted_in',options.source||'lista_importada',options.agentId||null); }
      contact.prospecting_campaign_id = campaign.id; contact.prospecting_origin = options.source || 'lista_importada'; contact.journey_stage = campaign.stage; contact.updated_at = nowISO();
      state.prospectQueue.push({ id: state.nextQueueId++, campaign_id: campaign.id, contact_id: contact.id, status: 'pending', attempts: 0, error: '', created_at: nowISO(), sent_at: null, replied_at: null, next_attempt_at:null, last_attempt_at:null });
      queuedPhones.add(phone);
      addActivity(contact.id, 'prospect_queued', { campaign_id: campaign.id, campaign_name: campaign.name }, options.agentId || null); added++;
    }
    save();
  } finally { endBatch(); }
  return { added, duplicates, invalid };
}

function syncCampaignConsentFromPermission(campaignId, agentId=null) {
  const campaign=getProspectCampaign(campaignId); if(!campaign||!campaign.confirmed_permission)return {updated:0,requeued:0};
  let updated=0,requeued=0;
  beginBatch();
  try{
    for(const q of state.prospectQueue.filter(x=>x.campaign_id===Number(campaignId))){
      const c=getContactById(q.contact_id); if(!c||c.opted_out||c.consent_status==='opted_out')continue;
      if(c.consent_status!=='opted_in'){c.consent_status='opted_in';c.consent_source='campanha_confirmada';c.consent_at=nowISO();c.updated_at=nowISO();updated++;addActivity(c.id,'consent_updated',{status:'opted_in',source:'campanha_confirmada'},agentId);} c.consent_categories={service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown',...(c.consent_categories||{}),marketing:'opted_in'};
      if(q.status==='skipped' && /Sem confirma[cç][aã]o de permiss[aã]o/i.test(String(q.error||''))){q.status='pending';q.error='';q.next_attempt_at=null;requeued++;}
    }
    if(updated||requeued)save();
  }finally{endBatch();}
  return {updated,requeued};
}
function requeueCampaignFailures(campaignId){
  let requeued=0;beginBatch();
  try{for(const q of state.prospectQueue.filter(x=>x.campaign_id===Number(campaignId))){if(q.status==='failed'){q.status='pending';q.error='';q.next_attempt_at=null;q.attempts=0;requeued++;}}if(requeued)save();}finally{endBatch();}return {requeued};
}
function listProspectQueue(campaignId, limit = 500) {
  return state.prospectQueue.filter((q) => q.campaign_id === Number(campaignId)).slice(-Math.max(1, Number(limit || 500))).map((q) => ({ ...q, contact: getContactById(q.contact_id) }));
}
function getProspectCampaignMetrics(campaignId) {
  const rows = state.prospectQueue.filter((q) => q.campaign_id === Number(campaignId)); const metrics = { total: rows.length, pending:0, sent:0, replied:0, skipped:0, failed:0 };
  for (const q of rows) if (metrics[q.status] !== undefined) metrics[q.status]++;
  return metrics;
}
function countCampaignSendsToday(campaignId) {
  const today = localDateKey();
  return state.prospectQueue.filter((q) => q.campaign_id === Number(campaignId) && q.sent_at && localDateKey(q.sent_at) === today).length;
}

function getLastGlobalProspectSendAt(){let latest=0;for(const q of state.prospectQueue){if(!q.sent_at)continue;const t=new Date(q.sent_at).getTime();if(Number.isFinite(t)&&t>latest)latest=t;}return latest?new Date(latest).toISOString():null;}

function countGlobalProspectSendsToday() {
  const today = localDateKey();
  return state.prospectQueue.filter((q) => q.sent_at && localDateKey(q.sent_at) === today).length;
}
function recoverStuckProspectQueue(maxAgeMinutes = 5) {
  const cutoff = Date.now() - Math.max(1, Number(maxAgeMinutes || 5)) * 60000;
  let recovered = 0;
  for (const q of state.prospectQueue) {
    if (q.status !== 'sending') continue;
    const last = q.last_attempt_at ? new Date(q.last_attempt_at).getTime() : 0;
    if (!last || last <= cutoff) {
      q.status = 'pending';
      q.error = q.error || 'Envio interrompido; devolvido automaticamente para a fila.';
      q.next_attempt_at = null;
      recovered++;
    }
  }
  if (recovered) save();
  return recovered;
}
function getNextProspectQueueItem(campaignId) { const now=Date.now(); return state.prospectQueue.find((q) => q.campaign_id === Number(campaignId) && q.status === 'pending' && (!q.next_attempt_at || new Date(q.next_attempt_at).getTime()<=now)) || null; }
function markProspectSending(queueId) { const q = state.prospectQueue.find((x) => x.id === Number(queueId)); if (!q || q.status !== 'pending') return null; q.status='sending'; q.attempts=Number(q.attempts||0)+1; q.last_attempt_at=nowISO(); save(); return q; }
function markProspectSent(queueId) {
  const q = state.prospectQueue.find((x) => x.id === Number(queueId)); if (!q) return null; q.status='sent'; q.sent_at=nowISO(); q.error='';
  const campaign=getProspectCampaign(q.campaign_id); if (campaign) campaign.last_sent_at=q.sent_at;
  const c=getContactById(q.contact_id); if(c){c.last_prospect_at=q.sent_at;c.prospecting_campaign_id=q.campaign_id;c.updated_at=q.sent_at;}
  save(); addActivity(q.contact_id,'prospect_sent',{campaign_id:q.campaign_id,queue_id:q.id}); return q;
}
function markProspectFailed(queueId, error) { const q=state.prospectQueue.find((x)=>x.id===Number(queueId)); if(!q)return null; q.error=String(error||'Erro de envio').slice(0,500); if(q.attempts>=5){q.status='failed';q.next_attempt_at=null;}else{q.status='pending';const mins=Math.min(60,Math.pow(2,Math.max(0,q.attempts-1)));q.next_attempt_at=new Date(Date.now()+mins*60000).toISOString();} save(); return q; }
function markProspectSkipped(queueId, reason) { const q=state.prospectQueue.find((x)=>x.id===Number(queueId)); if(!q)return null; q.status='skipped'; q.error=String(reason||'ignorado'); save(); return q; }
function markProspectReply(contactId) {
  const pending = state.prospectQueue.filter((q) => q.contact_id === Number(contactId) && q.status === 'sent').sort((a,b)=>b.id-a.id)[0];
  if (!pending) return null; pending.status='replied'; pending.replied_at=nowISO(); save(); addActivity(contactId,'prospect_replied',{campaign_id:pending.campaign_id,queue_id:pending.id}); return pending;
}
function completeFinishedCampaigns() {
  for (const c of state.prospectCampaigns.filter((x)=>x.status==='running')) {
    const pending=state.prospectQueue.some((q)=>q.campaign_id===c.id && ['pending','sending'].includes(q.status));
    if(!pending){c.status='completed';c.completed_at=nowISO();}
  }
  save();
}


function getJourneyFollowupCandidates(journeyAutomations = {}, limit = 20) {
  const now = Date.now();
  return state.contacts.filter((c) => {
    if (!c || c.opted_out || c.consent_status !== 'opted_in' || !c.journey_updated_at || c.requires_human || c.ai_paused) return false;
    if(c.status==='inativo' && !['pos_cancelamento','reativacao'].includes(c.journey_stage)) return false;
    if(c.status==='ativo' && ['contato_inicial','apresentacao_plano','fechamento'].includes(c.journey_stage)) return false;
    const rule = journeyAutomations[c.journey_stage];
    if (!rule || !rule.enabled || !String(rule.message || '').trim()) return false;
    if (c.journey_followup_stage === c.journey_stage) return false;
    const due = new Date(c.journey_updated_at).getTime() + Math.max(0, Number(rule.delayHours || 0)) * 3600000;
    return due <= now;
  }).sort((a,b) => String(a.journey_updated_at).localeCompare(String(b.journey_updated_at))).slice(0, Math.max(1, Number(limit||20)));
}
function markJourneyFollowupSent(contactId, stage) {
  const c = getContactById(contactId); if (!c) return false;
  c.journey_followup_stage = stage; c.journey_followup_sent_at = nowISO(); c.updated_at = nowISO(); save();
  addActivity(c.id, 'journey_followup_sent', { stage }); return true;
}


// ---------- Gestão comercial: tarefas, agenda, respostas rápidas e inteligência ----------
function normalizeTags(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(arr.map(x=>String(x).trim()).filter(Boolean))].slice(0,30).join(', ');
}
function mergeContactTags(contactId, tags = []) {
  const c=getContactById(contactId); if(!c) return null;
  c.tags=normalizeTags([...(String(c.tags||'').split(',')), ...(Array.isArray(tags)?tags:[]) ]); c.updated_at=nowISO(); save(); return c;
}
function createTask(payload={}, agentId=null) {
  const t={id:state.nextTaskId++,contact_id:payload.contact_id?Number(payload.contact_id):null,title:String(payload.title||'Tarefa').trim(),description:String(payload.description||''),due_at:payload.due_at||null,assigned_agent_id:payload.assigned_agent_id==null?(agentId==null?null:Number(agentId)):Number(payload.assigned_agent_id),status:'pending',priority:['low','normal','high'].includes(payload.priority)?payload.priority:'normal',created_at:nowISO(),completed_at:null};
  state.tasks.push(t); save(); if(t.contact_id)addActivity(t.contact_id,'task_created',{task_id:t.id,title:t.title,due_at:t.due_at},agentId); return t;
}
function listTasks(filters={}) { return state.tasks.filter(t=>(!filters.agentId||t.assigned_agent_id===Number(filters.agentId))&&(!filters.status||t.status===filters.status)&&(!filters.contactId||t.contact_id===Number(filters.contactId))).sort((a,b)=>String(a.due_at||'9999').localeCompare(String(b.due_at||'9999'))).map(t=>({...t,contact:t.contact_id?{id:t.contact_id,name:getContactById(t.contact_id)?.name||'',phone:getContactById(t.contact_id)?.phone||'',summary:getContactById(t.contact_id)?.profile_summary||'',last_intent:getContactById(t.contact_id)?.last_intent||''}:null})); }
function updateTask(id,patch={},agentId=null){const t=state.tasks.find(x=>x.id===Number(id));if(!t)return null;for(const k of ['title','description','due_at','assigned_agent_id','priority'])if(patch[k]!==undefined)t[k]=patch[k];if(patch.status&&['pending','done','cancelled'].includes(patch.status)){t.status=patch.status;t.completed_at=patch.status==='done'?nowISO():null;}save();if(t.contact_id)addActivity(t.contact_id,'task_updated',{task_id:t.id,status:t.status},agentId);return t;}
function createCalendarEvent(payload={},agentId=null){const e={id:state.nextEventId++,contact_id:payload.contact_id?Number(payload.contact_id):null,title:String(payload.title||'Compromisso').trim(),type:payload.type||'geral',start_at:payload.start_at,end_at:payload.end_at||null,notes:String(payload.notes||''),assigned_agent_id:payload.assigned_agent_id==null?(agentId==null?null:Number(agentId)):Number(payload.assigned_agent_id),status:payload.status||'scheduled',created_at:nowISO()};state.calendarEvents.push(e);save();if(e.contact_id)addActivity(e.contact_id,'calendar_event_created',{event_id:e.id,title:e.title,start_at:e.start_at},agentId);return e;}
function listCalendarEvents(filters={}){return state.calendarEvents.filter(e=>(!filters.agentId||e.assigned_agent_id===Number(filters.agentId))&&(!filters.contactId||e.contact_id===Number(filters.contactId))&&(!filters.from||String(e.start_at)>=String(filters.from))&&(!filters.to||String(e.start_at)<=String(filters.to))).sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at))).map(e=>({...e,contact:e.contact_id?{id:e.contact_id,name:getContactById(e.contact_id)?.name||'',phone:getContactById(e.contact_id)?.phone||'',summary:getContactById(e.contact_id)?.profile_summary||''}:null}));}
function updateCalendarEvent(id,patch={},agentId=null){const e=state.calendarEvents.find(x=>x.id===Number(id));if(!e)return null;for(const k of ['title','type','start_at','end_at','notes','assigned_agent_id','status'])if(patch[k]!==undefined)e[k]=patch[k];save();if(e.contact_id)addActivity(e.contact_id,'calendar_event_updated',{event_id:e.id,status:e.status,start_at:e.start_at},agentId);return e;}
function createQuickReply(payload={}){const q={id:state.nextQuickReplyId++,shortcut:String(payload.shortcut||'').replace(/^#/,'').trim().toLowerCase(),title:String(payload.title||'Resposta rápida').trim(),type:['text','audio','image','video','document'].includes(payload.type)?payload.type:'text',text:String(payload.text||''),file:payload.file||'',mimetype:payload.mimetype||'',ptt:Boolean(payload.ptt),triggers:Array.isArray(payload.triggers)?payload.triggers.map(String).map(x=>x.trim()).filter(Boolean):String(payload.triggers||'').split(',').map(x=>x.trim()).filter(Boolean),auto_use:Boolean(payload.auto_use),enabled:payload.enabled!==false,match_mode:['smart','contains_any','contains_all','exact'].includes(payload.match_mode)?payload.match_mode:'smart',smart_threshold:Math.max(.55,Math.min(.98,Number(payload.smart_threshold||.76))),priority:Math.max(1,Math.min(999,Number(payload.priority||35))),delay_min_ms:Math.max(0,Math.min(300000,Number(payload.delay_min_ms||0))),delay_max_ms:Math.max(0,Math.min(300000,Number(payload.delay_max_ms||0))),cooldown_hours:Math.max(0,Math.min(168,Number(payload.cooldown_hours||0))),review_status:['pending','approved','archived'].includes(payload.review_status)?payload.review_status:((String(payload.source||'')==='bootstrap_history'||String(payload.source||'')==='bootstrap_history_adapted')?'pending':'approved'),valid_from:String(payload.valid_from||''),expires_at:String(payload.expires_at||''),learned_at:String(payload.learned_at||nowISO()),last_seen_at:String(payload.last_seen_at||''),human_locked:payload.human_locked!==false && !['bootstrap_history','bootstrap_history_adapted'].includes(String(payload.source||'')),source:String(payload.source||''),source_key:String(payload.source_key||''),confidence:Number(payload.confidence||0),evidence_count:Number(payload.evidence_count||0),created_at:nowISO(),updated_at:nowISO()};if(q.delay_max_ms<q.delay_min_ms)q.delay_max_ms=q.delay_min_ms;if(q.review_status!=='approved')q.auto_use=false;state.quickReplies.push(q);save();return q;}
function listQuickReplies(){return [...state.quickReplies].sort((a,b)=>a.title.localeCompare(b.title));}
function updateQuickReply(id,patch={}){const q=state.quickReplies.find(x=>x.id===Number(id));if(!q)return null;for(const k of ['shortcut','title','type','text','file','mimetype','ptt','triggers','auto_use','enabled','match_mode','smart_threshold','priority','delay_min_ms','delay_max_ms','cooldown_hours','review_status','valid_from','expires_at','learned_at','last_seen_at','human_locked','source','source_key','confidence','evidence_count'])if(patch[k]!==undefined){if(k==='ptt'||k==='auto_use'||k==='enabled'||k==='human_locked')q[k]=Boolean(patch[k]);else if(k==='triggers')q[k]=Array.isArray(patch[k])?patch[k].map(String).map(x=>x.trim()).filter(Boolean):String(patch[k]||'').split(',').map(x=>x.trim()).filter(Boolean);else if(k==='smart_threshold')q[k]=Math.max(.55,Math.min(.98,Number(patch[k]||.76)));else if(k==='priority')q[k]=Math.max(1,Math.min(999,Number(patch[k]||35)));else if(k==='delay_min_ms'||k==='delay_max_ms')q[k]=Math.max(0,Math.min(300000,Number(patch[k]||0)));else if(k==='cooldown_hours')q[k]=Math.max(0,Math.min(168,Number(patch[k]||0)));else if(k==='match_mode')q[k]=['smart','contains_any','contains_all','exact'].includes(patch[k])?patch[k]:'smart';else if(k==='review_status')q[k]=['pending','approved','archived'].includes(patch[k])?patch[k]:q.review_status;else q[k]=patch[k];}if(Number(q.delay_max_ms||0)<Number(q.delay_min_ms||0))q.delay_max_ms=q.delay_min_ms;if(q.review_status!=='approved')q.auto_use=false;q.updated_at=nowISO();save();return q;}
function deleteQuickReply(id){const i=state.quickReplies.findIndex(x=>x.id===Number(id));if(i<0)return false;state.quickReplies.splice(i,1);save();return true;}
function getAbandonedContacts(minutes=30){const cutoff=Date.now()-Math.max(1,Number(minutes))*60000;return state.contacts.filter(c=>c.last_inbound_at&&new Date(c.last_inbound_at).getTime()<Date.now()&&new Date(c.last_inbound_at).getTime()<=cutoff&&(!c.last_outbound_at||new Date(c.last_outbound_at)<new Date(c.last_inbound_at))&&c.consent_status!=='opted_out').sort((a,b)=>String(a.last_inbound_at).localeCompare(String(b.last_inbound_at)));}

function serviceMetrics(contactList=state.contacts){
  const responseMs=[]; let open=0,ai=0,human=0;
  for(const c of contactList){const msgs=getContactMessages(c.id,true);let pendingIn=null;for(const m of msgs){const t=new Date(m.created_at).getTime();if(m.direction==='in'){if(pendingIn==null)pendingIn=t;}else if(pendingIn!=null){if(Number.isFinite(t)&&t>=pendingIn)responseMs.push(t-pendingIn);pendingIn=null;}}if(pendingIn!=null)open++;if(c.ai_paused)human++;else ai++;}
  const avg=responseMs.length?Math.round(responseMs.reduce((a,b)=>a+b,0)/responseMs.length):0;const sorted=[...responseMs].sort((a,b)=>a-b);const median=sorted.length?sorted[Math.floor(sorted.length/2)]:0;
  return {avg_response_ms:avg,median_response_ms:median,open_conversations:open,ai_attending:ai,human_attending:human,samples:responseMs.length};
}

function commercialDashboard(contactList=state.contacts, agentId=null){
  const contacts=contactList; const hot=contacts.filter(c=>Number(c.lead_score||0)>=75).length; const warm=contacts.filter(c=>Number(c.lead_score||0)>=45&&Number(c.lead_score||0)<75).length;
  const pipeline=contacts.filter(c=>!['ativo','inativo'].includes(c.status)).reduce((n,c)=>n+Number(c.deal_value||0),0); const closed=contacts.filter(c=>c.status==='ativo').reduce((n,c)=>n+Number(c.deal_value||0),0);
  const journey=Object.fromEntries(crmConfig.stageIds().map(s=>[s,contacts.filter(c=>c.journey_stage===s).length]));
  const tags={}; for(const c of contacts)for(const t of String(c.tags||'').split(',').map(x=>x.trim()).filter(Boolean))tags[t]=(tags[t]||0)+1;
  const allowedIds=new Set(contacts.map(c=>Number(c.id))); const abandoned=getAbandonedContacts(30).filter(c=>allowedIds.has(Number(c.id))).length; const waitingCustomer=segmentContacts('waiting_customer',contacts).length; const pendingTasks=state.tasks.filter(t=>t.status==='pending'&&(agentId==null||t.assigned_agent_id===Number(agentId))).length; const todayEvents=state.calendarEvents.filter(e=>localDateKey(e.start_at)===localDateKey()&&(agentId==null||e.assigned_agent_id===Number(agentId))).length; return {total:contacts.length,hot,warm,pipelineValue:pipeline,closedValue:closed,journey,abandoned,waitingCustomer,pendingTasks,todayEvents,topTags:Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([tag,count])=>({tag,count})),service:serviceMetrics(contacts)};
}
function exportRows(contactList=state.contacts){return contactList.map(c=>({id:c.id,nome:c.name||'',telefone:c.phone,status:c.status,jornada:c.journey_stage,tipo:c.customer_type,interesse:c.interest||'',tags:c.tags||'',score:c.lead_score||0,temperatura:c.lead_temperature||'',valor_negociacao:c.deal_value||0,oferta:c.plan_name||'',setor:c.department||'',responsavel:c.assigned_agent_id||'',proxima_acao:c.next_best_action||c.next_action||'',origem:c.lead_source||'',consentimento:c.consent_status||'',ultima_entrada:c.last_inbound_at||'',ultima_saida:c.last_outbound_at||'',criado_em:c.created_at||''}));}

function getSafetyMetrics(hours24=24,days7=7){
  const now=Date.now(),cut24=now-Math.max(1,Number(hours24||24))*3600000,cut7=now-Math.max(1,Number(days7||7))*86400000,cut1=now-3600000;
  const isAutoType=t=>['proactive_followup_sent','journey_followup_sent','prospect_sent','reactivation_sent'].includes(String(t||''));
  const auto7=state.activities.filter(a=>isAutoType(a.type)&&new Date(a.created_at).getTime()>=cut7);
  const auto24=auto7.filter(a=>new Date(a.created_at).getTime()>=cut24); const auto1=auto24.filter(a=>new Date(a.created_at).getTime()>=cut1);
  const lastAutoByContact=new Map(); for(const a of auto7){const prev=lastAutoByContact.get(Number(a.contact_id));if(!prev||new Date(a.created_at)>new Date(prev.created_at))lastAutoByContact.set(Number(a.contact_id),a);}
  let responded=0; for(const a of lastAutoByContact.values()){const c=getContactById(a.contact_id);if(c?.last_inbound_at&&new Date(c.last_inbound_at).getTime()>new Date(a.created_at).getTime())responded++;}
  const optedOutContacts=new Set(state.activities.filter(a=>new Date(a.created_at).getTime()>=cut7&&['consent_changed','consent_updated','consent_category_changed'].includes(a.type)&&((a.details||{}).status==='opted_out')).map(a=>Number(a.contact_id)).filter(Boolean));
  const optOuts7d=optedOutContacts.size;
  const failedOutbound24h=state.prospectQueue.filter(q=>q.last_attempt_at&&new Date(q.last_attempt_at).getTime()>=cut24&&q.error).length;
  const msgs24=state.messages.filter(m=>!m.is_historical&&new Date(m.created_at).getTime()>=cut24);
  const lastAutomatedInitiationAt=auto7.length?auto7.map(a=>a.created_at).sort().at(-1):null;
  return {automatedInitiations1h:auto1.length,automatedInitiations24h:auto24.length,automatedInitiations7d:auto7.length,respondedAfterInitiation7d:responded,optOuts7d,failedOutbound24h,lastAutomatedInitiationAt,inbound24h:msgs24.filter(m=>m.direction==='in').length,outbound24h:msgs24.filter(m=>m.direction==='out').length,uniqueAutomatedContacts7d:new Set(auto7.map(a=>Number(a.contact_id))).size};
}

function getMetrics() {
  const byStatus = Object.fromEntries(VALID_STATUSES.map((s) => [s, state.contacts.filter((c) => c.status === s).length]));
  return { totalContacts: state.contacts.length, totalMessages: state.messages.length, unread: state.contacts.reduce((n,c)=>n+Number(c.unread_count||0),0), byStatus, prospecting:{campaigns:state.prospectCampaigns.length,queued:state.prospectQueue.length}, commercial:commercialDashboard() };
}



function setAISuggestion(contactId, text, source='gemini') {
  const c=getContactById(contactId); if(!c)return null; c.ai_suggested_reply=String(text||''); c.ai_suggestion_at=text?nowISO():null; c.last_ai_action=source; c.updated_at=nowISO(); save(); addActivity(c.id,text?'ai_suggestion_created':'ai_suggestion_cleared',{source}); return c;
}
function clearAllAISuggestions(source='config_changed') {
  let cleared=0;
  for(const c of state.contacts){
    if(!c.ai_suggested_reply && !c.ai_suggestion_at) continue;
    c.ai_suggested_reply=''; c.ai_suggestion_at=null; c.last_ai_action=source; c.updated_at=nowISO(); cleared++;
  }
  if(cleared) save();
  return cleared;
}
function recordAIFeedback(contactId, score, note='', agentId=null) {
  const c=getContactById(contactId); if(!c)return null; c.ai_feedback_score=Number(c.ai_feedback_score||0)+(Number(score)>=0?1:-1); c.updated_at=nowISO(); save(); addActivity(c.id,'ai_feedback',{score:Number(score)>=0?1:-1,note:String(note||'').slice(0,500)},agentId); return c;
}
function updateMessageBody(messageId, body) { const m=state.messages.find(x=>x.id===Number(messageId)); if(!m)return null; m.body=String(body||''); save(); return m; }
function searchGlobal(query, limit=60) {
  const q=String(query||'').trim().toLowerCase(); if(!q)return {contacts:[],messages:[]}; const max=Math.max(1,Math.min(200,Number(limit||60)));
  const contacts=state.contacts.filter(c=>[c.name,c.phone,c.tags,c.interest,c.profile_summary,c.plan_name,c.department,c.last_intent].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,max);
  const messages=state.messages.filter(m=>String(m.body||'').toLowerCase().includes(q)).slice(-max).reverse().map(m=>({...m,contact:getContactById(m.contact_id)}));
  return {contacts,messages};
}
function listKnowledgeGaps() {
  const counts=new Map(); for(const c of state.contacts){for(const raw of String(c.knowledge_gaps||'').split(/[\n,;|]+/)){const gap=raw.trim(); if(gap)counts.set(gap,(counts.get(gap)||0)+1);}}
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,50).map(([gap,count])=>({gap,count}));
}
function undoLastContactAction(contactId, agentId=null) {
  const c=getContactById(contactId); if(!c)return {ok:false,error:'Contato não encontrado'}; const acts=getActivities(contactId,100); const a=acts.find(x=>x?.details?.undoable && !x?.details?.undone); if(!a)return {ok:false,error:'Nenhuma ação recente disponível para desfazer'};
  if(a.type==='journey_stage_changed' && crmConfig.isStage(a.details.from)){const cur=c.journey_stage;c.journey_stage=a.details.from;c.journey_updated_at=nowISO();a.details.undone=true;save();addActivity(c.id,'action_undone',{action:a.type,from:cur,to:a.details.from},agentId);return {ok:true,contact:c};}
  if(a.type==='status_changed' && VALID_STATUSES.includes(a.details.from)){const cur=c.status;c.status=a.details.from;a.details.undone=true;save();addActivity(c.id,'action_undone',{action:a.type,from:cur,to:a.details.from},agentId);return {ok:true,contact:c};}
  if(a.type==='assignment_changed'){const cur=c.assigned_agent_id;c.assigned_agent_id=a.details.from==null?null:Number(a.details.from);a.details.undone=true;save();addActivity(c.id,'action_undone',{action:a.type,from:cur,to:c.assigned_agent_id},agentId);return {ok:true,contact:c};}
  return {ok:false,error:'A última ação não pode ser desfeita automaticamente'};
}

function getStorageStatus() {
  return {
    mode: sqliteDb ? 'sqlite' : 'json_fallback',
    sqlite: Boolean(sqliteDb),
    sqlite_path: SQLITE_PATH,
    json_path: DB_PATH,
    fallback_reason: sqliteDb ? '' : sqliteRuntimeError,
    node_version: process.versions.node,
  };
}


function segmentContacts(segment='all', contactList=state.contacts) {
  const rows=Array.isArray(contactList)?contactList:state.contacts;
  const now=Date.now();
  const pendingContactIds=new Set(state.tasks.filter(t=>t.status==='pending'&&t.contact_id).map(t=>Number(t.contact_id)));
  const filters={
    hot:c=>Number(c.lead_score||0)>=75,
    warm:c=>Number(c.lead_score||0)>=45&&Number(c.lead_score||0)<75,
    pipeline:c=>!['ativo','inativo'].includes(c.status),
    closed:c=>c.status==='ativo',
    abandoned:c=>{const li=c.last_inbound_at?new Date(c.last_inbound_at).getTime():0,lo=c.last_outbound_at?new Date(c.last_outbound_at).getTime():0;return li>lo&&now-li>=30*60000;},
    waiting_customer:c=>{const li=c.last_inbound_at?new Date(c.last_inbound_at).getTime():0,lo=c.last_outbound_at?new Date(c.last_outbound_at).getTime():0;return lo>li;},
    pending_tasks:c=>pendingContactIds.has(Number(c.id)),
    open:c=>Boolean(c.last_message_at)&&c.status!=='inativo',
  };
  const fn=filters[segment]||(()=>true);
  return rows.filter(fn).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
}
function proactiveScenarioForContact(contact, proactiveScenarios={}) {
  if(!contact)return null;
  const li=contact.last_inbound_at?new Date(contact.last_inbound_at).getTime():0, lo=contact.last_outbound_at?new Date(contact.last_outbound_at).getTime():0;
  if(!lo||lo<=li)return null;
  const messages=getRecentConversation(contact.id,8);
  const recent=messages.slice(-6);
  const recentCorpus=recent.map(m=>String(m.body||'')).join(' ').toLowerCase();
  const intentCorpus=[contact.last_intent,contact.interest,contact.plan_name].join(' ').toLowerCase();
  const plans=/\b(plano|planos|pacote|assinatura|produto|produtos|servi[cç]o|servi[cç]os|pre[cç]o|valor|or[cç]amento|proposta|cota[cç][aã]o|mensalidade)\b/i.test(recentCorpus)||/plano|produto|servi[cç]o|pre[cç]o|valor|or[cç]amento|proposta/i.test(intentCorpus);
  const closing=['fechamento','apresentacao_plano'].includes(contact.journey_stage)||/fechar|contratar|comprar|assinar|aprovar|confirmar|pedido|pagamento|pix|cart[aã]o/i.test(recentCorpus)||/fechamento|pagamento|contrat|compr|aprova/i.test(String(contact.last_intent||''));
  if(closing&&proactiveScenarios.closing_silence?.enabled!==false)return 'closing_silence';
  if(plans&&proactiveScenarios.plans_silence?.enabled!==false)return 'plans_silence';
  if(Number(contact.lead_score||0)>=75&&proactiveScenarios.hot_silence?.enabled!==false)return 'hot_silence';
  return null;
}
function getProactiveCandidates(settings={}, {segment=null,limit=100}={}) {
  const scenarios=settings.proactiveScenarios||{}; const now=Date.now();
  let rows=segment?segmentContacts(segment):state.contacts;
  return rows.filter(c=>{
    if(!c||c.opted_out||c.consent_status==='opted_out'||c.proactive_disabled||c.requires_human||c.ai_paused)return false;
    if(!segment && !['novo_lead','interessado','pendente_pagamento'].includes(c.status))return false;
    const li=c.last_inbound_at?new Date(c.last_inbound_at).getTime():0,lo=c.last_outbound_at?new Date(c.last_outbound_at).getTime():0;
    if(!lo||lo<=li)return false;
    let key=proactiveScenarioForContact(c,scenarios);
    if(segment==='waiting_customer'&&scenarios.unanswered_segment?.enabled)key=key||'unanswered_segment';
    if(!key)return false;
    const rule=scenarios[key]; if(!rule||rule.enabled===false)return false;
    const score=Number(c.lead_score||0); if(score<Number(rule.minScore||0))return false;
    const windowDays=Math.max(1,Number(settings.commercialContactWindowDays||7)); const maxInitiated=Math.max(1,Number(settings.commercialContactLimit||10));
    if(countAutomatedInitiations(c.id,windowDays)>=maxInitiated)return false;
    const silenceMs=Math.max(0,Number(rule.silenceHours||0))*3600000; if(now-lo<silenceMs)return false;
    const attempts=(c.proactive_scenario===key)?Number(c.proactive_attempts||0):0;
    if(attempts>=Math.max(1,Number(rule.maxAttempts||1)))return false;
    if(c.proactive_last_sent_at&&attempts>0&&now-new Date(c.proactive_last_sent_at).getTime()<Math.max(0,Number(rule.betweenAttemptsHours||0))*3600000)return false;
    return true;
  }).sort((a,b)=>Number(b.lead_score||0)-Number(a.lead_score||0)||String(a.last_outbound_at||'').localeCompare(String(b.last_outbound_at||''))).slice(0,Math.max(1,Number(limit||100)));
}
function markProactiveSent(contactId,scenario,message=''){
  const c=getContactById(contactId);if(!c)return null;
  const same=c.proactive_scenario===scenario;c.proactive_scenario=scenario;c.proactive_attempts=same?Number(c.proactive_attempts||0)+1:1;c.proactive_last_sent_at=nowISO();c.proactive_cycle_anchor=c.proactive_cycle_anchor||c.last_outbound_at||c.proactive_last_sent_at;c.proactive_last_message=String(message||'').slice(0,1000);c.updated_at=nowISO();save();addActivity(c.id,'proactive_followup_sent',{scenario,attempt:c.proactive_attempts});return c;
}
function countProactiveSendsToday(){const today=localDateKey();return state.activities.filter(a=>a.type==='proactive_followup_sent'&&localDateKey(a.created_at)===today).length;}
function getLastProactiveSendAt(){const rows=state.activities.filter(a=>a.type==='proactive_followup_sent'&&a.created_at).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));return rows[0]?.created_at||null;}

function teamPerformance() {
  const map=new Map(); for(const c of state.contacts){const id=c.assigned_agent_id; if(id==null)continue; if(!map.has(id))map.set(id,{agent_id:id,contacts:0,hot:0,unread:0,humanReviews:0,active:0}); const r=map.get(id);r.contacts++;r.hot+=Number(c.lead_score||0)>=75?1:0;r.unread+=Number(c.unread_count||0);r.humanReviews+=c.requires_human?1:0;r.active+=c.status==='ativo'?1:0;} return [...map.values()];
}

function markBootstrapPending(contactId, externalId='') { const c=getContactById(contactId); if(!c)return null; c.bootstrap_pending_reply_at=nowISO(); c.bootstrap_pending_external_id=String(externalId||''); c.updated_at=nowISO(); save(); return c; }
function clearBootstrapPending(contactId) { const c=getContactById(contactId); if(!c)return null; c.bootstrap_pending_reply_at=null; c.bootstrap_pending_external_id=''; c.updated_at=nowISO(); save(); return c; }
function listBootstrapPendingContacts(maxAgeHours=6, limit=100) { const cutoff=Date.now()-Math.max(1,Number(maxAgeHours||6))*3600000; return state.contacts.filter(c=>c.bootstrap_pending_reply_at&&new Date(c.bootstrap_pending_reply_at).getTime()>=cutoff).sort((a,b)=>String(a.bootstrap_pending_reply_at).localeCompare(String(b.bootstrap_pending_reply_at))).slice(0,Math.max(1,Number(limit||100))); }

function setHumanReview(contactId, required, reason='', agentId=null) { const c=getContactById(contactId); if(!c)return null; c.requires_human=required?1:0; c.human_reason=required?String(reason||'Revisão humana necessária'):''; c.human_review_at=required?nowISO():null; if(required)c.ai_paused=1; c.updated_at=nowISO(); save(); addActivity(c.id,required?'human_review_required':'human_review_resolved',{reason:c.human_reason},agentId); emitRealtime(required?'human_review_required':'human_review_resolved',c.id); return c; }
function getInboxSummary(agentId=null,includeUnassigned=false) { const list=agentId?listContactsByAgent(agentId,null,includeUnassigned):listContacts(); return getInboxSummaryFromList(list); }
function getInboxSummaryFromList(list=[]) { const now=Date.now(); const groups={urgent:[],waiting_customer:[],ai_attending:[],human_attending:[],followup_today:[],problems:[]}; const today=localDateKey(); for(const c of list){ const li=c.last_inbound_at?new Date(c.last_inbound_at).getTime():0, lo=c.last_outbound_at?new Date(c.last_outbound_at).getTime():0; const hasConversation=Boolean(c.last_message_at||li||lo); const unanswered=li>lo; if(c.requires_human || (unanswered && (Number(c.unread_count||0)>0 || now-li>15*60000)))groups.urgent.push(c); if(hasConversation && lo>li)groups.waiting_customer.push(c); if(hasConversation){if(c.ai_paused)groups.human_attending.push(c); else groups.ai_attending.push(c);} if(c.follow_up_at && localDateKey(c.follow_up_at)===today)groups.followup_today.push(c); if(c.requires_human || c.opted_out || c.consent_status==='opted_out')groups.problems.push(c); } return {counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),groups}; }

module.exports = {
  VALID_STATUSES, JOURNEY_STAGES, getJourneyStages:()=>crmConfig.stageIds(), normalizePhone, upsertContact, updateContact, setStatus, setJourneyStage, setConsent, setConsentCategory, getConsentLedger, touchInbound, touchOutbound, markRead,
  logMessage, listContacts, listOperationalContactsForAgent, getContactMessages, findInactive, markCampaignSent, getContactByPhone, getContactById, assignAgentAutomatically, setAssignedAgent, setAIPaused, listContactsByAgent,
  importHistoricalMessage, getRecentConversation, sampleHistoricalMessages, getAllMessagesForAnalysis, getRecentMessagesForAnalysis, applyAIProfile, getActivities, addActivity, getMetrics, workloadForAgent,
  createProspectCampaign, listProspectCampaigns, getProspectCampaign, updateProspectCampaign, setProspectCampaignStatus, addProspectsToCampaign, syncCampaignConsentFromPermission, requeueCampaignFailures, listProspectQueue,
  getProspectCampaignMetrics, countCampaignSendsToday, countGlobalProspectSendsToday, getLastGlobalProspectSendAt, recoverStuckProspectQueue, getNextProspectQueueItem, markProspectSending, markProspectSent, markProspectFailed, markProspectSkipped,
  markProspectReply, completeFinishedCampaigns, getJourneyFollowupCandidates, markJourneyFollowupSent,
  setHumanReview, getInboxSummary, getInboxSummaryFromList, markBootstrapPending, clearBootstrapPending, listBootstrapPendingContacts, mergeContactTags, createTask, listTasks, updateTask, createCalendarEvent, listCalendarEvents, updateCalendarEvent, createQuickReply, listQuickReplies, updateQuickReply, deleteQuickReply, getAbandonedContacts, commercialDashboard, exportRows,
  setAISuggestion, clearAllAISuggestions, recordAIFeedback, updateMessageBody, searchGlobal, listKnowledgeGaps, undoLastContactAction, teamPerformance, serviceMetrics, segmentContacts, proactiveScenarioForContact, getProactiveCandidates, markProactiveSent, countProactiveSendsToday, getLastProactiveSendAt,
  beginBatch, endBatch, runBatch, flush, messageExists, getStorageStatus, repairHistoricalContactMetadata,
  applyRealtimeMessageSignals, subscribeRealtime, emitRealtime, getSafetyMetrics,
  getCustomerMemory, updateCustomerMemory, appendCustomerMemoryEvent, customerMemoryPrompt, countAutomatedInitiations,
};
