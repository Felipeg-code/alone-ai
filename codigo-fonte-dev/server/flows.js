const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const FLOWS_PATH = path.join(dataDir, 'flows.json');

function normalize(text) { return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function asList(v){ return Array.isArray(v)?v.map(String).map(x=>x.trim()).filter(Boolean):String(v||'').split(',').map(x=>x.trim()).filter(Boolean); }
function bool(v,d=true){ return v===undefined?d:v!==false; }
function uid(prefix='step'){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }

function normalizeStep(step={},i=0){
  const type=['text','audio','image','video','document','wait'].includes(step.type)?step.type:'text';
  return {
    id:String(step.id||`step_${i+1}`), enabled:bool(step.enabled,true), type,
    text:String(step.text||''), file:String(step.file||''), mimetype:String(step.mimetype||''), ptt:step.ptt!==false,
    delayMs:Math.max(0,Math.min(300000,Number(step.delayMs||step.delay||0)||0)),
    delayMinMs:Math.max(0,Math.min(300000,Number(step.delayMinMs||0)||0)),
    delayMaxMs:Math.max(0,Math.min(300000,Number(step.delayMaxMs||0)||0)),
  };
}
function normalizeFlow(key,flow={}){
  const historicalPending=flow?.source==='bootstrap_history'||flow?.source==='bootstrap_history_adapted';
  const legacyTrigger=flow.isCampaign?'campaign':flow.isFallbackOutOfHours?'out_of_hours':flow.isDefaultFallback?'fallback':flow.trigger==='primeiro_contato'?'first_contact':'keywords';
  const trigger=['keywords','first_contact','fallback','out_of_hours','campaign'].includes(flow.triggerType)?flow.triggerType:legacyTrigger;
  const responses=(Array.isArray(flow.responses)?flow.responses:[]).map(normalizeStep);
  return {
    ...flow,
    id:String(flow.id||key), key:String(key), enabled:historicalPending?false:bool(flow.enabled,true), review_status:historicalPending?'pending':String(flow.review_status||flow.reviewStatus||'approved'), label:String(flow.label||key),
    description:String(flow.description||''), triggerType:trigger,
    keywords:asList(flow.keywords), matchMode:['contains_any','contains_all','exact','regex','smart'].includes(flow.matchMode)?flow.matchMode:'contains_any',
    caseSensitive:!!flow.caseSensitive, smartThreshold:Math.max(.55,Math.min(.98,Number(flow.smartThreshold||.72))), cooldownHours:Math.max(0,Math.min(168,Number(flow.cooldownHours||0))),
    execution:['fixed','ai_first','actions_only'].includes(flow.execution)?flow.execution:'ai_first',
    priority:Number.isFinite(Number(flow.priority))?Number(flow.priority):100,
    validFrom:String(flow.validFrom||flow.valid_from||''), expiresAt:String(flow.expiresAt||flow.expires_at||''),
    conditions:{
      stages:asList(flow.conditions?.stages||flow.stages),
      departments:asList(flow.conditions?.departments||flow.departments),
      businessHours:['any','inside','outside'].includes(flow.conditions?.businessHours)?flow.conditions.businessHours:'any',
      aiModes:asList(flow.conditions?.aiModes),
      firstContactOnly:!!flow.conditions?.firstContactOnly,
    },
    actions:{
      setStatus:String(flow.actions?.setStatus||flow.setStatus||''),
      routeDepartment:String(flow.actions?.routeDepartment||flow.routeDepartment||''),
      nextAction:String(flow.actions?.nextAction||flow.nextAction||''),
      addTags:asList(flow.actions?.addTags||flow.addTags),
      pauseAI:!!flow.actions?.pauseAI,
      humanReview:!!flow.actions?.humanReview,
    },
    responses,
    isCampaign:trigger==='campaign', isFallbackOutOfHours:trigger==='out_of_hours', isDefaultFallback:trigger==='fallback',
    trigger:trigger==='first_contact'?'primeiro_contato':flow.trigger,
  };
}
function normalizeFlows(flows={}){
  const out={};
  for(const [key,value] of Object.entries(flows||{})) out[String(key)]=normalizeFlow(key,value||{});
  return out;
}

function migrateLegacyBusinessFlows(flows={}){
  const out={...flows}; let changed=false;
  const rewrite=(key,legacyLabel,patch)=>{const f=out[key];if(!f||String(f.label||'')!==legacyLabel)return;out[key]={...f,...patch};changed=true;};
  rewrite('boasVindas','Primeira mensagem de um novo contato',{responses:[{type:'text',text:'Oi! Aqui é da {company_name} 🧡 Que bom ter você por aqui. Me conta o que você está procurando que eu te ajudo.'}],execution:'ai_first',allowFixedSend:false});
  rewrite('planosPrecos','Perguntou sobre planos, preço, valor, mensalidade',{label:'Perguntou sobre preço, orçamento, produto, serviço ou plano',keywords:['preço','preco','valor','quanto custa','quanto fica','orçamento','orcamento','proposta','produto','serviço','servico','plano','pacote'],responses:[{type:'text',text:'Posso te explicar as opções e valores por aqui. Me conta rapidinho o que você precisa para eu direcionar melhor.'}]});
  rewrite('localizacao','Perguntou onde fica / endereço',{responses:[{type:'text',text:'Posso te passar a localização certinha. Se ela não estiver na nossa base oficial, vou pedir para a equipe confirmar antes de te informar.'}]});
  rewrite('experimental','Pediu aula experimental / gratuita',{label:'Quer agendar, visitar, marcar atendimento ou demonstração',keywords:['agendar','agenda','marcar horário','marcar horario','consulta','reunião','reuniao','visita','demonstração','demonstracao','experimental'],responses:[{type:'text',text:'Claro. Qual o melhor dia e horário para você?'}]});
  rewrite('cobrancaAtraso','Cliente mencionou pagamento, boleto, carnê ou atraso',{label:'Cliente mencionou pagamento, boleto, PIX, fatura ou cobrança',responses:[{type:'text',text:'Já te ajudo com isso. Vou verificar o contexto do pagamento para orientar corretamente.'}]});
  rewrite('cancelamento','Cliente quer cancelar ou trancar o plano',{label:'Cliente quer cancelar, encerrar ou desistir',keywords:['cancelar','cancelamento','encerrar','rescindir','quero sair','quero desistir'],responses:[{type:'text',text:'Entendi. Posso registrar o motivo e encaminhar para o setor responsável continuar esse atendimento com você.'}]});
  rewrite('reativacaoInativos','Campanha automática — clientes inativos (usada pelo agendador, não por palavra-chave)',{label:'Campanha automática — reativação de clientes inativos',responses:[{type:'text',text:'Oi! Faz um tempo desde nosso último contato com a {company_name}. Se surgiu uma nova necessidade ou quiser retomar uma conversa, estamos por aqui.'}]});
  rewrite('lembretePagamento','Campanha automática — lembrete de pagamento próximo do vencimento',{responses:[{type:'text',text:'Oi! Passando para lembrar que existe um pagamento próximo do vencimento. Se precisar confirmar valor, forma de pagamento ou segunda via, é só chamar por aqui.'}]});
  return {flows:out,changed};
}

function loadFlows() {
  try { const raw=JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf-8')); const migrated=migrateLegacyBusinessFlows(raw); if(migrated.changed){try{fs.writeFileSync(FLOWS_PATH,JSON.stringify(migrated.flows,null,2),'utf-8');}catch(_){}} return normalizeFlows(migrated.flows); }
  catch (_) { return {}; }
}
function saveFlows(flows) {
  const normalized=normalizeFlows(flows);
  fs.mkdirSync(dataDir,{recursive:true}); const tmp=FLOWS_PATH+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf-8'); fs.renameSync(tmp,FLOWS_PATH); return normalized;
}
const WEEKDAY_TO_NUM={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
function businessClock(date=new Date(),settings={}){
  const timeZone=String(settings.businessTimezone||'America/Sao_Paulo').trim()||'America/Sao_Paulo';
  try{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const obj=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const day=WEEKDAY_TO_NUM[String(obj.weekday||'').toLowerCase().slice(0,3)];
    const hour=Number(obj.hour),minute=Number(obj.minute);
    if(Number.isInteger(day)&&Number.isFinite(hour)&&Number.isFinite(minute)) return {day,hm:hour*60+minute,hour,minute,timeZone,iso:date.toISOString()};
  }catch(_){}
  // Fallback seguro apenas se o timezone configurado for inválido no runtime.
  return {day:date.getDay(),hm:date.getHours()*60+date.getMinutes(),hour:date.getHours(),minute:date.getMinutes(),timeZone:'system',iso:date.toISOString()};
}
function isWithinBusinessHours(date = new Date(), settings = {}) {
  const clock=businessClock(date,settings),day=clock.day,hm=clock.hm;
  const schedule = settings.businessSchedule || {
    0:[[9*60,12*60]], 1:[[6*60,11*60],[14*60,22*60]], 2:[[6*60,11*60],[14*60,22*60]],
    3:[[6*60,11*60],[14*60,22*60]], 4:[[6*60,11*60],[14*60,22*60]], 5:[[6*60,11*60],[14*60,22*60]], 6:[[8*60,12*60]],
  };
  const ranges = Array.isArray(schedule[day]) ? schedule[day] : Array.isArray(schedule[String(day)])?schedule[String(day)]:[];
  return ranges.some(([start,end]) => hm >= Number(start) && hm < Number(end));
}
function businessHoursDiagnostics(date=new Date(),settings={}){
  const clock=businessClock(date,settings); const schedule=settings.businessSchedule||{};
  const ranges=Array.isArray(schedule[clock.day])?schedule[clock.day]:Array.isArray(schedule[String(clock.day)])?schedule[String(clock.day)]:[];
  return {timeZone:clock.timeZone,day:clock.day,localTime:`${String(clock.hour).padStart(2,'0')}:${String(clock.minute).padStart(2,'0')}`,minuteOfDay:clock.hm,ranges:ranges.map(r=>[Number(r[0]),Number(r[1])]),within:isWithinBusinessHours(date,settings)};
}
function minsToText(mins){const h=Math.floor(Number(mins)/60),m=Number(mins)%60;return m?`${h}:${String(m).padStart(2,'0')}`:`${h}h`;}
function formatBusinessHours(settings={}) {
  const schedule=settings.businessSchedule||{}; const names=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const parts=[];
  for(let d=0;d<7;d++){const ranges=Array.isArray(schedule[d])?schedule[d]:[];if(!ranges.length)continue;parts.push(`${names[d]} ${ranges.map(([a,b])=>`${minsToText(a)}-${minsToText(b)}`).join(' e ')}`);}
  return parts.join(' / ') || String(settings.businessHours||'');
}
function renderResponse(response,settings={}) {
  if(!response||response.type!=='text')return response;
  return {...response,text:String(response.text||'').replace(/\{business_hours\}/g,formatBusinessHours(settings)).replace(/\{company_name\}/g,String(settings.gymName||'nossa empresa'))};
}
const SMART_SYNONYMS={
  preco:['valor','quanto','custa','custo','preco','fica','sai','orcamento','orçamento'], valor:['preco','quanto','custa','custo','fica','sai','orcamento','orçamento'], quanto:['qnt','qto','qt'], qnt:['quanto'], qto:['quanto'], custa:['fica','sai','custo','valor','preco'], fica:['custa','sai','valor','preco'],
  orcamento:['orcamento','orçamento','proposta','cotacao','cotação','valor','preco'], proposta:['orcamento','cotacao','oferta','condicoes','condições'],
  plano:['pacote','assinatura','opcao','opção','oferta'], mensalidade:['mensal','assinatura','plano','valor'],
  produto:['item','mercadoria','modelo'], servico:['serviço','atendimento','solucao','solução'],
  horario:['hora','abre','fecha','funciona','atendimento','disponibilidade'], localizacao:['endereco','endereço','onde fica','local'],
  contratar:['fechar','comprar','assinar','aderir','confirmar'], comprar:['pedido','fechar','adquirir','levar'], matricula:['inscricao','inscrição','entrar','comecar','iniciar'],
  pagamento:['pagar','pix','cartao','cartão','boleto','vencimento','fatura'], cancelar:['cancelamento','encerrar','parar','desistir'],
  agendar:['agenda','marcar','horario','reservar','consulta','reuniao','reunião','visita'], avaliacao:['avaliar','consulta','diagnostico','diagnóstico'],
  entrega:['prazo','envio','frete','retirada'], suporte:['ajuda','problema','duvida','dúvida','assistencia','assistência']
}
const STOP_WORDS=new Set(['a','o','e','de','da','do','das','dos','em','no','na','nos','nas','um','uma','uns','umas','pra','para','por','com','sem','que','qual','quais','eu','me','meu','minha','vc','voce','voces','vocês','tem','ter','isso','esse','essa','ai','aí','aqui']);
function smartTokens(text){return normalize(text).replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(x=>x.length>1&&!STOP_WORDS.has(x));}
function stemToken(w){w=String(w||'');for(const suf of ['mente','coes','cao','sao','ando','endo','indo','ados','adas','idos','idas','amento','imentos','es','s']){if(w.length>suf.length+3&&w.endsWith(suf))return w.slice(0,-suf.length);}return w;}
function editDistanceOne(a,b){if(a===b)return true;if(Math.abs(a.length-b.length)>1)return false;let i=0,j=0,d=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++d>1)return false;if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}}return d+(i<a.length||j<b.length?1:0)<=1;}
function tokenEquivalent(a,b){if(a===b)return true;const sa=stemToken(a),sb=stemToken(b);if(sa.length>=4&&sa===sb)return true;if(a.length>=5&&b.length>=5&&editDistanceOne(a,b))return true;const av=SMART_SYNONYMS[a]||[],bv=SMART_SYNONYMS[b]||[];return av.some(x=>normalize(x)===b)||bv.some(x=>normalize(x)===a);}
function smartKeywordScore(keyword,incomingText){
  const text=normalize(incomingText),kw=normalize(keyword).trim();if(!kw)return 0;
  if(text===kw)return 1;if(text.includes(kw))return kw.includes(' ')?0.98:0.9;
  const kt=smartTokens(kw),tt=smartTokens(text);if(!kt.length||!tt.length)return 0;
  let matched=0;for(const k of kt){if(tt.some(t=>tokenEquivalent(k,t)))matched++;}
  let score=matched/kt.length;
  if(kt.length===1&&matched)score=Math.max(score,.78);
  if(kt.length>=2&&matched===kt.length)score=Math.max(score,.88);
  return score;
}
function keywordMatchScore(flow,incomingText){
  const raw=String(incomingText||''); const text=flow.caseSensitive?raw:normalize(raw); const kws=(flow.keywords||[]).map(k=>flow.caseSensitive?k:normalize(k));
  if(!kws.length)return 0;
  if(flow.matchMode==='exact') return kws.some(k=>text.trim()===k.trim())?1:0;
  if(flow.matchMode==='contains_all') return kws.every(k=>text.includes(k))?1:0;
  if(flow.matchMode==='regex') return kws.some(k=>{try{return new RegExp(k,flow.caseSensitive?'':'i').test(raw);}catch{return false;}})?1:0;
  if(flow.matchMode==='smart') return Math.max(...kws.map(k=>smartKeywordScore(k,raw)),0);
  return kws.some(k=>text.includes(k))?1:0;
}
function keywordMatches(flow,incomingText){return keywordMatchScore(flow,incomingText)>=(flow.matchMode==='smart'?Number(flow.smartThreshold||0.72):1);}
function conditionsMatch(flow,ctx={}){
  const c=flow.conditions||{}, contact=ctx.contact||{}, settings=ctx.settings||{};
  const now=ctx.now?new Date(ctx.now):new Date(); if(flow.validFrom&&new Date(flow.validFrom)>now)return false; if(flow.expiresAt&&new Date(flow.expiresAt)<=now)return false;
  if(c.firstContactOnly && !ctx.isFirstContact)return false;
  if(c.stages?.length && !c.stages.includes(String(contact.journey_stage||contact.status||contact.stage||'')))return false;
  if(c.departments?.length && !c.departments.includes(String(contact.department||'')))return false;
  if(c.aiModes?.length && !c.aiModes.includes(String(settings.aiMode||'assistido')))return false;
  const within=ctx.withinBusinessHours!==undefined?ctx.withinBusinessHours:isWithinBusinessHours(new Date(),settings);
  if(c.businessHours==='inside'&&!within)return false;
  if(c.businessHours==='outside'&&within)return false;
  return true;
}
function matchFlow(flows, incomingText, isFirstContact, ctx={}) {
  const normalized=normalizeFlows(flows);
  const list=Object.entries(normalized).filter(([,f])=>f.enabled!==false).sort((a,b)=>(Number(a[1].priority)||100)-(Number(b[1].priority)||100));
  const candidates=[];
  for (const [key, flow] of list) {
    if(!conditionsMatch(flow,{...ctx,isFirstContact}))continue;
    if(flow.triggerType==='keywords'){
      const score=keywordMatchScore(flow,incomingText),threshold=flow.matchMode==='smart'?Number(flow.smartThreshold||0.72):1;
      if(score>=threshold)candidates.push({key,flow,score});
    }
    if(flow.triggerType==='first_contact' && isFirstContact) candidates.push({key,flow,score:.7});
  }
  if(candidates.length){candidates.sort((a,b)=>b.score-a.score||((Number(a.flow.priority)||100)-(Number(b.flow.priority)||100)));return candidates[0];}
  const fallback=list.find(([,flow])=>flow.triggerType==='fallback'&&conditionsMatch(flow,{...ctx,isFirstContact}));
  return fallback?{key:fallback[0],flow:fallback[1],score:0}:null;
}
function findSystemFlow(flows,type,ctx={}){
  const normalized=normalizeFlows(flows);
  return Object.entries(normalized).filter(([,f])=>f.enabled!==false&&f.triggerType===type&&conditionsMatch(f,ctx)).sort((a,b)=>(Number(a[1].priority)||100)-(Number(b[1].priority)||100))[0]||null;
}
function newFlowKey(flows,label='regra'){
  const base=normalize(label).replace(/[^a-z0-9]+/g,' ').trim().split(' ').map((x,i)=>i?x.charAt(0).toUpperCase()+x.slice(1):x).join('')||'regra';
  let key=base,i=2;while(flows[key])key=`${base}${i++}`;return key;
}
module.exports = { loadFlows, saveFlows, normalizeFlow, normalizeFlows, matchFlow, findSystemFlow, isWithinBusinessHours, businessHoursDiagnostics, businessClock, normalize, formatBusinessHours, renderResponse, newFlowKey, uid, keywordMatchScore, smartKeywordScore };
