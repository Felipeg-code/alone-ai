const assert=require('assert');
const fs=require('fs'); const path=require('path'); const os=require('os');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v748-'));
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
for(const name of ['settings.json','flows.json','crm-config.json']){const src=path.join(root,'data',name);if(fs.existsSync(src))fs.copyFileSync(src,path.join(tmp,'data',name));}
process.env.ALONE_BASE_DIR=tmp;
const flows=require('../codigo-fonte-dev/server/flows');
const ops=require('../codigo-fonte-dev/server/ops');
const db=require('../codigo-fonte-dev/server/db');

const learned=flows.normalizeFlow('preco',{triggerType:'keywords',keywords:['quanto custa','mensalidade','valor do plano','tem plano'],matchMode:'smart',smartThreshold:.72,source:'response_library',review_status:'approved',enabled:true});
for(const text of ['quanto fica por mês?','qnt custa?','qual valor da mensalidad','tem algum plano pra mim?']){
  const hit=flows.matchFlow({preco:learned},text,false,{});assert(hit&&hit.key==='preco',`não reconheceu variação: ${text}`);
}
for(const text of ['quero cancelar','onde fica a academia','meu pagamento venceu']) assert(!flows.matchFlow({preco:learned},text,false,{}),`falso positivo em preço: ${text}`);

ops.recordFeedbackExample({input:'qual o valor?',suggestion:'Resposta longa e robótica',correction:'Te passo sim 😊 Você quer conhecer o plano individual ou família?',score:-1});
ops.recordFeedbackExample({input:'tem aula hoje?',suggestion:'Tem sim! Hoje funcionamos normalmente.',correction:'Tem sim! Hoje funcionamos normalmente.',score:1});
const mem=ops.feedbackMemoryText(8);assert(mem.includes('EXEMPLO CORRIGIDO')&&mem.includes('EXEMPLO APROVADO/HUMANO'),'feedback adaptativo não entrou na memória');

const c=db.upsertContact('5511990000001','Teste');db.importHistoricalMessage(c.id,'in','qnt fica o plano?',new Date().toISOString(),'v748-in');
assert(db.getRecentConversation(c.id,4).length>0,'conversa não persistiu');
db.flush();
console.log('Smoke v7.4.8 OK',{smartMatching:true,adaptiveFeedback:true});
try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){ }
