const assert=require('assert');
const fs=require('fs');const os=require('os');const path=require('path');
const root=path.resolve(__dirname,'..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7419-'));
process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');
const flows=require('../codigo-fonte-dev/server/flows');

// Aprendizado histórico nunca nasce pronto para disparo automático.
const learned=db.createQuickReply({shortcut:'plano_antigo',title:'Plano antigo',text:'Plano antigo R$ 59',triggers:['quanto custa'],auto_use:true,review_status:'pending',source:'bootstrap_history',last_seen_at:new Date(Date.now()-400*86400000).toISOString()});
assert.strictEqual(learned.review_status,'pending');
assert.strictEqual(learned.auto_use,false,'pendente histórico não pode ficar com auto_use ativo');

// Aprovação humana pode ativar, arquivamento desliga novamente.
let q=db.updateQuickReply(learned.id,{review_status:'approved',enabled:true,auto_use:true,source:'manual_override',human_locked:true,text:'Plano atual R$ 89'});
assert.strictEqual(q.auto_use,true);assert.strictEqual(q.text,'Plano atual R$ 89');
q=db.updateQuickReply(q.id,{review_status:'archived'});assert.strictEqual(q.auto_use,false,'arquivado não pode permanecer automático');

// Validade temporal precisa ser respeitada no matching, não só na interface.
const base={triggerType:'keywords',keywords:['preco'],matchMode:'contains_any',enabled:true,execution:'fixed',responses:[{type:'text',text:'ok',enabled:true}],conditions:{businessHours:'any'}};
let f={agora:{...base,id:'agora',validFrom:new Date(Date.now()-3600000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()}};
assert(flows.matchFlow(f,'preco',false,{settings:{}}),'fluxo vigente deveria casar');
f={futuro:{...base,id:'futuro',validFrom:new Date(Date.now()+3600000).toISOString()}};
assert.strictEqual(flows.matchFlow(f,'preco',false,{settings:{}}),null,'fluxo futuro não pode casar');
f={expirado:{...base,id:'expirado',expiresAt:new Date(Date.now()-1000).toISOString()}};
assert.strictEqual(flows.matchFlow(f,'preco',false,{settings:{}}),null,'fluxo expirado não pode casar');

// Fluxo bruto aprendido do histórico é normalizado como pendente/desativado.
const normalized=flows.normalizeFlow('velho',{...base,source:'bootstrap_history',enabled:true});
assert.strictEqual(normalized.enabled,false);assert.strictEqual(normalized.review_status,'pending');

// A nova Central de Respostas precisa manter os controles essenciais no HTML.
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
for(const id of ['responseCenter','responseLibraryStats','responseFilterTabs','responseLibrarySearch','responseEditorForm','auditLearnedResponsesBtn','responseLibraryReviewStatus','responseLibraryAutoUse']) assert(html.includes(`id="${id}"`),`faltou ${id}`);

console.log('Smoke v7.4.19 OK');
try{db.flush();fs.rmSync(tmp,{recursive:true,force:true});}catch(_){ }
