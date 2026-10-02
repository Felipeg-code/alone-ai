const fs=require('fs');
const path=require('path');
const {dataDir}=require('./paths');
const file=path.join(dataDir,'crm-config.json');

const DEFAULT_STAGES=[
  ['contato_inicial','Contato inicial'],['apresentacao_plano','Apresentação da oferta'],['fechamento','Fechamento / conversão'],
  ['agendamento_avaliacao','Agendamento'],['pos_avaliacao','Pós-atendimento'],['primeiro_treino','Início / onboarding'],
  ['acompanhamento','Acompanhamento'],['cancelamento','Cancelamento'],['pos_cancelamento','Pós-cancelamento'],['reativacao','Reativação']
].map(([id,label],i)=>({id,label,enabled:true,order:i+1}));

const LEGACY_DEFAULT_LABELS={
  apresentacao_plano:['Apresentação do plano','Apresentacao do plano'],
  fechamento:['Fechamento'],
  agendamento_avaliacao:['Agendamento da avaliação','Agendamento da avaliacao'],
  pos_avaliacao:['Pós-avaliação','Pos-avaliacao'],
  primeiro_treino:['Primeiro treino']
};
const GENERIC_DEFAULT_LABELS={apresentacao_plano:'Apresentação da oferta',fechamento:'Fechamento / conversão',agendamento_avaliacao:'Agendamento',pos_avaliacao:'Pós-atendimento',primeiro_treino:'Início / onboarding'};
function genericizeLegacyLabel(id,label){const legacy=LEGACY_DEFAULT_LABELS[id]||[];return legacy.includes(String(label||''))?(GENERIC_DEFAULT_LABELS[id]||label):label;}

const DEFAULT_CARD_FIELDS=['phone','interest','lead_score','deal_value','tags','department','assigned_agent'];
const DEFAULT={
  version:1,
  global:{
    stages:DEFAULT_STAGES,
    cardFields:DEFAULT_CARD_FIELDS,
    customFields:[],
    suggestedTags:[],
    defaultSort:'updated_desc',
    cardDensity:'comfortable'
  },
  users:{}
};
function ensure(){fs.mkdirSync(dataDir,{recursive:true});if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(DEFAULT,null,2));}
function load(){ensure();try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));return normalize(raw);}catch(_){return structuredClone(DEFAULT);}}
function save(v){ensure();fs.writeFileSync(file,JSON.stringify(normalize(v),null,2));return normalize(v);}
function safeId(v){return String(v||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48);}
function normalize(input={}){
  const out=structuredClone(DEFAULT); const g=input.global||{};
  if(Array.isArray(g.stages)&&g.stages.length){
    const seen=new Set(); out.global.stages=g.stages.map((s,i)=>({id:safeId(s.id||s.label)||`etapa_${i+1}`,label:String(genericizeLegacyLabel(safeId(s.id||s.label),s.label||s.id||`Etapa ${i+1}`)).trim().slice(0,80),enabled:s.enabled!==false,order:Number(s.order||i+1)})).filter(s=>s.id&&!seen.has(s.id)&&seen.add(s.id)).sort((a,b)=>a.order-b.order);
  }
  if(Array.isArray(g.cardFields))out.global.cardFields=[...new Set(g.cardFields.map(String))];
  if(Array.isArray(g.customFields))out.global.customFields=g.customFields.map((f,i)=>({id:safeId(f.id||f.label)||`campo_${i+1}`,label:String(f.label||f.id||`Campo ${i+1}`).trim().slice(0,80),type:['text','number','date','select','checkbox'].includes(f.type)?f.type:'text',options:Array.isArray(f.options)?f.options.map(String).slice(0,50):[],required:Boolean(f.required),enabled:f.enabled!==false}));
  if(Array.isArray(g.suggestedTags))out.global.suggestedTags=[...new Set(g.suggestedTags.map(x=>String(x).trim()).filter(Boolean))].slice(0,100);
  if(['updated_desc','updated_asc','name_asc','score_desc','score_asc'].includes(g.defaultSort))out.global.defaultSort=g.defaultSort;
  if(['compact','comfortable','detailed'].includes(g.cardDensity))out.global.cardDensity=g.cardDensity;
  out.users={};
  for(const [k,v] of Object.entries(input.users||{}))out.users[String(k)]={hiddenStages:Array.isArray(v.hiddenStages)?v.hiddenStages.map(String):[],stageOrder:Array.isArray(v.stageOrder)?v.stageOrder.map(String):[],cardFields:Array.isArray(v.cardFields)?v.cardFields.map(String):[],sort:['updated_desc','updated_asc','name_asc','score_desc','score_asc'].includes(v.sort)?v.sort:'',cardDensity:['compact','comfortable','detailed'].includes(v.cardDensity)?v.cardDensity:''};
  return out;
}
function publicFor(agent){const c=load();return {global:c.global,personal:c.users[String(agent.id)]||{},canManageGlobal:agent.role==='gestor'};}
function saveGlobal(patch){const c=load();c.global={...c.global,...patch};return save(c).global;}
function savePersonal(agentId,prefs){const c=load();c.users[String(agentId)]={...(c.users[String(agentId)]||{}),...(prefs||{})};return save(c).users[String(agentId)];}
function stageIds(){return load().global.stages.filter(s=>s.enabled!==false).map(s=>s.id);}
function isStage(id){return stageIds().includes(String(id));}
module.exports={load,saveGlobal,savePersonal,publicFor,stageIds,isStage,DEFAULT_STAGES};
