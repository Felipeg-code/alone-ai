const fs=require('fs');const os=require('os');const path=require('path');const assert=require('assert');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7416-'));
process.env.ALONE_BASE_DIR=tmp;
const ops=require('../codigo-fonte-dev/server/ops');
const learned={business_profile:'Academia antiga com plano Bronze por R$ 59',style_profile:'Respostas curtas e humanas',facts:['Plano Bronze custa R$ 59'],faq:[{question:'Quanto custa o Bronze?',answer:'R$ 59'}],processes:[]};
let r=ops.syncBootstrapKnowledge(learned);assert(r.created>=3,'deveria materializar aprendizado');
let list=ops.listKnowledge();let fact=list.find(x=>x.source_key==='bootstrap:fact:0');assert(fact&&fact.effective_status==='learned');
assert(!ops.companyMemoryText('Bronze').includes('R$ 59'),'aprendido sem revisão não deve entrar como verdade operacional');
// revisão humana substitui e protege
ops.upsertKnowledge({...fact,content:'Plano Atual custa R$ 89',status:'official',priority:100,locked:true},1);
ops.syncBootstrapKnowledge({...learned,facts:['Plano Bronze custa R$ 49']});
fact=ops.listKnowledge().find(x=>x.id===fact.id);assert.equal(fact.content,'Plano Atual custa R$ 89','IA não pode sobrescrever override humano');assert.equal(fact.effective_status,'official');
const mem=ops.companyMemoryText('Plano Atual');assert(mem.includes('R$ 89'));assert(!mem.includes('R$ 49'));
// expirado sai imediatamente
ops.upsertKnowledge({...fact,status:'expired',locked:true},1);assert(!ops.companyMemoryText('Plano Atual').includes('R$ 89'),'expirado não pode ir ao prompt');
// revisar também não entra
const k=ops.upsertKnowledge({category:'preços',title:'Plano X',content:'R$ 123',status:'review',priority:20,locked:true},1);assert(!ops.companyMemoryText('Plano X').includes('R$ 123'),'revisar não pode ir ao prompt');
// validade futura não entra
ops.upsertKnowledge({category:'promo',title:'Promo futura',content:'R$ 10',status:'official',priority:100,locked:true,valid_from:new Date(Date.now()+86400000).toISOString()},1);assert(!ops.companyMemoryText('Promo futura').includes('R$ 10'));
console.log('Smoke v7.4.16 OK');
