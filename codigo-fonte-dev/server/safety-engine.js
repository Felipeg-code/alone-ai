// safety-engine.js — governança de outbound, score de saúde e Risk Control adaptativo.
// O objetivo é reduzir risco operacional por conformidade, qualidade e estabilidade.
// Não tenta mascarar automação nem burlar mecanismos de detecção do WhatsApp.
const db=require('./db');
const ops=require('./ops');

function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n||0)));}
function ageMs(ts){const t=new Date(ts||0).getTime();return Number.isFinite(t)?Date.now()-t:Infinity;}
function recentInbound(contact,hours=24){if(!contact?.last_inbound_at)return false;const t=new Date(contact.last_inbound_at).getTime();return Number.isFinite(t)&&Date.now()-t<=Math.max(1,Number(hours||24))*3600000;}
function consentLedger(contact={}){
  const base={service:'unknown',updates:'unknown',marketing:'unknown',reactivation:'unknown'};
  const src=contact.consent_categories&&typeof contact.consent_categories==='object'?contact.consent_categories:{};
  const out={...base,...src};
  if(contact.opted_out||contact.consent_status==='opted_out')for(const k of Object.keys(out))out[k]='opted_out';
  return out;
}
function categoryFor(kind,source=''){
  const src=String(source||'').toLowerCase();
  if(src.includes('reativ'))return 'reactivation';
  if(kind==='campaign'||src.startsWith('prospeccao'))return 'marketing';
  if(kind==='journey')return 'updates';
  return 'service';
}
function auditRows(action,limit=200){return (ops.listAudit?.({action,limit})||[]).filter(x=>Number.isFinite(new Date(x.created_at).getTime()));}
function latest(rows){return rows.length?[...rows].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0]:null;}

function calculateHealth(settings={}){
  const m=db.getSafetyMetrics?.(24,7)||{}; const r=ops.retryMetrics?.()||{};
  let score=100; const reasons=[];
  const initiated=Math.max(0,Number(m.automatedInitiations7d||0));
  const responses=Math.max(0,Number(m.respondedAfterInitiation7d||0));
  const responseRate=initiated?responses/initiated:1;
  const optOutRate=initiated?Math.max(0,Number(m.optOuts7d||0))/initiated:0;
  const failBase=Math.max(1,Number(m.automatedInitiations24h||0)+Number(m.failedOutbound24h||0));
  const failureRate=Math.max(0,Number(m.failedOutbound24h||0))/failBase;
  if(initiated>=5 && responseRate<.15){score-=22;reasons.push('Baixa taxa de resposta às iniciativas automáticas.');}
  else if(initiated>=5 && responseRate<.30){score-=10;reasons.push('Taxa de resposta às iniciativas automáticas abaixo do ideal.');}
  if(optOutRate>=.10){score-=35;reasons.push('Taxa de opt-out elevada.');}
  else if(optOutRate>=.05){score-=18;reasons.push('Opt-outs acima do padrão desejado.');}
  if(failureRate>=.15){score-=25;reasons.push('Muitas falhas recentes de outbound.');}
  else if(failureRate>=.05){score-=10;reasons.push('Existem falhas recentes de outbound.');}
  if(Number(r.dead||0)>0){score-=15;reasons.push('Há retries esgotados na fila.');}
  if(Number(r.pending||0)>20){score-=8;reasons.push('Fila de retry acumulada.');}

  const restrictionRows=auditRows('whatsapp_restriction_suspected',50);
  const rateLimitRows=auditRows('whatsapp_rate_limited',100);
  const closeRows=auditRows('whatsapp_connection_closed',200);
  const compatibilityRows=auditRows('whatsapp_protocol_incompatible',50);
  const lastRestrictionAt=latest(restrictionRows)?.created_at||null;
  const lastRateLimitAt=latest(rateLimitRows)?.created_at||null;
  const lastCompatibilityAt=latest(compatibilityRows)?.created_at||null;

  const cooldownHours=Math.max(1,Number(settings.safetyRestrictionCooldownHours||48));
  const rateLimitCooldownHours=Math.max(1,Number(settings.safetyRateLimitCooldownHours||6));
  const probationHours=Math.max(0,Number(settings.safetyRecoveryProbationHours||24));
  const recoveryPct=clamp(settings.safetyRecoveryLimitPercent||25,10,100);
  const recentRestriction=Boolean(lastRestrictionAt)&&ageMs(lastRestrictionAt)<=cooldownHours*3600000;
  const recentRateLimit=Boolean(lastRateLimitAt)&&ageMs(lastRateLimitAt)<=rateLimitCooldownHours*3600000;
  const recoveryProbation=Boolean(lastRestrictionAt)&&!recentRestriction&&probationHours>0&&ageMs(lastRestrictionAt)<=(cooldownHours+probationHours)*3600000;

  const stormWindowMinutes=Math.max(5,Number(settings.safetyReconnectStormWindowMinutes||15));
  const stormLimit=Math.max(2,Number(settings.safetyReconnectStormLimit||4));
  const closeCutoff=Date.now()-stormWindowMinutes*60000;
  const recentCloses=closeRows.filter(x=>new Date(x.created_at).getTime()>=closeCutoff);
  const unstableTransport=recentCloses.length>=stormLimit;
  if(unstableTransport){score-=30;reasons.push(`Conexão instável: ${recentCloses.length} encerramentos em ${stormWindowMinutes} min.`);}
  if(recentRateLimit){score-=35;reasons.push(`Rate limit recente: pausa automática por até ${rateLimitCooldownHours}h.`);}
  if(recoveryProbation){score-=10;reasons.push(`Recuperação gradual ativa após cooldown (${probationHours}h).`);}
  if(lastCompatibilityAt&&ageMs(lastCompatibilityAt)<=3600000){score-=5;reasons.push('Incompatibilidade recente de protocolo/cliente detectada.');}

  const baseHourly=Math.max(1,Number(settings.safetyMaxAutomatedInitiationsPerHour||20));
  const baseDaily=Math.max(1,Number(settings.safetyMaxAutomatedInitiationsPerDay||40));
  const hourly=Number(m.automatedInitiations1h||0);
  const daily=Number(m.automatedInitiations24h||0);
  const minGap=Math.max(0,Number(settings.safetyMinAutomatedGapSeconds||10));
  const lastAutoTs=m.lastAutomatedInitiationAt?new Date(m.lastAutomatedInitiationAt).getTime():0;
  const gapRemainingSeconds=lastAutoTs&&minGap?Math.max(0,Math.ceil((minGap*1000-(Date.now()-lastAutoTs))/1000)):0;

  if(hourly>=baseHourly){score-=15;reasons.push('Volume automático na última hora atingiu o limite operacional.');}
  if(daily>=baseDaily){score-=20;reasons.push('Volume automático nas últimas 24 horas atingiu o teto global diário.');}
  if(recentRestriction){score-=60;reasons.push(`Cooldown de segurança ativo após possível restrição (${cooldownHours}h).`);}

  score=clamp(score,0,100);
  const warn=clamp(settings.safetyWarningThreshold||70,20,95); const trip=clamp(settings.safetyCircuitBreakerThreshold||45,10,warn-1);
  const level=score<=trip?'critical':score<warn?'warning':'healthy';
  let adaptiveFactor=1;
  if(level==='warning')adaptiveFactor=.5;
  if(recoveryProbation)adaptiveFactor=Math.min(adaptiveFactor,recoveryPct/100);
  const effectiveHourly=Math.max(1,Math.floor(baseHourly*adaptiveFactor));
  const effectiveDaily=Math.max(1,Math.floor(baseDaily*adaptiveFactor));
  const riskState=recentRestriction?'halted':recentRateLimit?'rate_limited':unstableTransport?'unstable':recoveryProbation?'recovery':level==='warning'?'caution':level==='critical'?'halted':'normal';

  return {
    score,level,riskState,reasons,recentRestriction,lastRestrictionAt,cooldownHours,recentRateLimit,lastRateLimitAt,rateLimitCooldownHours,
    recoveryProbation,probationHours,recoveryPct,unstableTransport,recentConnectionCloses:recentCloses.length,stormWindowMinutes,stormLimit,lastCompatibilityAt,
    metrics:{...m,responseRate:Number(responseRate.toFixed(3)),optOutRate:Number(optOutRate.toFixed(3)),failureRate:Number(failureRate.toFixed(3)),retry:r,gapRemainingSeconds},
    thresholds:{warning:warn,circuitBreaker:trip},
    limits:{hourly:effectiveHourly,daily:effectiveDaily,baseHourly,baseDaily,minGapSeconds:minGap,adaptiveFactor:Number(adaptiveFactor.toFixed(2))}
  };
}
function evaluate({settings={},contact=null,kind='auto',source='',humanApproved=false}={}){
  const protection=String(settings.accountProtectionMode||'strict').toLowerCase();
  const automationMode=String(settings.outboundAutomationMode||'approval').toLowerCase();
  const src=String(source||'').toLowerCase();
  const manual=kind==='manual'||src.startsWith('manual')||src.startsWith('quick');
  if(contact?.opted_out||contact?.consent_status==='opted_out')return {allowed:false,decision:'block',reason:'opted_out',protection,automationMode};
  if(manual)return {allowed:true,decision:'allow',reason:'human_initiated',protection,automationMode};
  const recent=recentInbound(contact,Math.max(1,Number(settings.accountProtectionWindowHours||24)));
  if(kind==='ai_reply')return recent?{allowed:true,decision:'allow',reason:'recent_customer_message',protection,automationMode}:{allowed:false,decision:'block',reason:'outside_customer_window',protection,automationMode};
  if(protection==='strict')return {allowed:false,decision:'block',reason:'automated_initiation_blocked_strict',protection,automationMode};
  if(protection==='balanced' && kind==='campaign')return {allowed:false,decision:'block',reason:'campaign_blocked_account_protection',protection,automationMode};
  if(protection==='balanced' && ['proactive','journey'].includes(kind) && !recent)return {allowed:false,decision:'block',reason:'outside_customer_window',protection,automationMode};
  const category=categoryFor(kind,src); const ledger=consentLedger(contact||{}); const catStatus=ledger[category]||'unknown';
  if(kind==='campaign' && catStatus!=='opted_in')return {allowed:false,decision:'block',reason:'marketing_consent_missing',category,consent:catStatus,protection,automationMode};
  if(category==='reactivation' && catStatus!=='opted_in')return {allowed:false,decision:'block',reason:'reactivation_consent_missing',category,consent:catStatus,protection,automationMode};
  if(['proactive','journey'].includes(kind) && !recent && catStatus!=='opted_in')return {allowed:false,decision:'block',reason:'category_consent_missing',category,consent:catStatus,protection,automationMode};
  const health=calculateHealth(settings);
  if(health.recentRestriction)return {allowed:false,decision:'block',reason:'restriction_cooldown',health,category,protection,automationMode};
  if(health.recentRateLimit)return {allowed:false,decision:'block',reason:'rate_limit_cooldown',health,category,protection,automationMode};
  if(health.unstableTransport)return {allowed:false,decision:'block',reason:'transport_unstable',health,category,protection,automationMode};
  if(Number(health.metrics?.automatedInitiations1h||0)>=Number(health.limits?.hourly||1))return {allowed:false,decision:'block',reason:'hourly_automation_limit',health,category,protection,automationMode};
  if(Number(health.metrics?.automatedInitiations24h||0)>=Number(health.limits?.daily||1))return {allowed:false,decision:'block',reason:'daily_automation_limit',health,category,protection,automationMode};
  const effectiveGap=Number(health.metrics?.gapRemainingSeconds||0);
  if(effectiveGap>0 && !src.includes('retry'))return {allowed:false,decision:'block',reason:'global_automation_interval',health,category,protection,automationMode,retryAfterSeconds:effectiveGap};
  const breaker=Boolean(settings.safetyCircuitBreakerEnabled!==false)&&health.score<=health.thresholds.circuitBreaker;
  if(breaker)return {allowed:false,decision:'block',reason:'circuit_breaker',health,category,protection,automationMode};
  if(humanApproved)return {allowed:true,decision:'allow',reason:'human_approved_after_revalidation',health,category,protection,automationMode};
  if(automationMode==='manual')return {allowed:false,decision:'approval',requiresApproval:true,reason:'manual_mode_requires_approval',health,category,protection,automationMode};
  if(automationMode==='approval')return {allowed:false,decision:'approval',requiresApproval:true,reason:'approval_required',health,category,protection,automationMode};
  return {allowed:true,decision:'allow',reason:health.recoveryProbation?'policy_ok_recovery':'policy_ok',health,category,protection,automationMode};
}
let automationTail=Promise.resolve();
function withAutomationLock(task){
  const run=automationTail.catch(()=>null).then(()=>task());
  automationTail=run.catch(()=>null);
  return run;
}
function classifyTransportError(err){
  const code=Number(err?.output?.statusCode||err?.statusCode||err?.status||err?.data?.status||err?.code||0);
  const message=String(err?.message||err||'');
  const msg=message.toLowerCase();
  if(code===405||/client[_\s-]?too[_\s-]?old|client.*version|protocol.*version|incompatible.*version/.test(msg))return {kind:'compatibility',code:code||null,message};
  if(code===429||/rate.?limit|too many requests|throttl/.test(msg))return {kind:'rate_limit',code:code||null,message};
  if(code===401||/logged.?out|session.*invalid|auth.*fail|unauthenticated/.test(msg))return {kind:'auth',code:code||null,message};
  if(code===403||/forbidden|spam|ban|restrict/.test(msg))return {kind:'restriction',code:code||null,message};
  const permanent=/invalid.*jid|bad request|not found|malformed|unsupported/i.test(message)||[400,404,406,410,422].includes(code);
  if(permanent)return {kind:'permanent',code:code||null,message};
  return {kind:'transient',code:code||null,message};
}
function auditOnce(action,details,windowMs=60000){
  const recent=auditRows(action,20).some(x=>ageMs(x.created_at)<windowMs);
  if(!recent)ops.audit(action,{resource:'whatsapp',details});
}
function recordTransportError(err,details={}){
  const c=classifyTransportError(err); const base={code:c.code,message:c.message.slice(0,500),source:details.source||'transport',phone:details.phone?String(details.phone).slice(-4).padStart(String(details.phone).length,'*'):''};
  if(c.kind==='restriction')auditOnce('whatsapp_restriction_suspected',base,60000);
  else if(c.kind==='rate_limit')auditOnce('whatsapp_rate_limited',base,60000);
  else if(c.kind==='compatibility')auditOnce('whatsapp_protocol_incompatible',base,60000);
  else if(c.kind==='auth')auditOnce('whatsapp_auth_failure',base,60000);
  else if(c.kind==='transient')auditOnce('whatsapp_transport_transient',base,30000);
  return c;
}
module.exports={calculateHealth,evaluate,recentInbound,consentLedger,categoryFor,withAutomationLock,classifyTransportError,recordTransportError};
