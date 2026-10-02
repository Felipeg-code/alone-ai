const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7422-'));
process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');
const ops=require('../codigo-fonte-dev/server/ops');

// Conhecimento aprendido não pode virar verdade operacional antes de revisão humana.
ops.upsertKnowledge({category:'planos',title:'Preço antigo',content:'Plano antigo custa R$ 70',status:'learned',source:'bootstrap_history',source_key:'old-price',auto_generated:true},null);
ops.upsertKnowledge({category:'planos',title:'Preço oficial',content:'Plano atual custa R$ 99',status:'official',source:'manual'},1);
const mem=ops.companyMemoryText('plano preço',10000);
assert(mem.includes('Plano atual custa R$ 99'),'conhecimento oficial deve entrar na memória operacional');
assert(!mem.includes('Plano antigo custa R$ 70'),'conhecimento apenas aprendido não pode alimentar fatos do agente');

// Proatividade não deve herdar uma menção antiga de plano fora da janela recente.
const c=db.upsertContact('45999992222','Contexto Recente',{consentStatus:'opted_in'});
db.updateContact(c.id,{lead_score:50,status:'interessado',interest:'informações gerais',last_intent:'localização',journey_stage:'contato_inicial'},{activity:false});
const base=Date.now()-10*3600000;
db.importHistoricalMessage(c.id,'in','text','Quanto custa o plano?',new Date(base).toISOString(),'v7422-old-plan');
for(let i=1;i<=7;i++) db.importHistoricalMessage(c.id,i%2?'out':'in','text',`Conversa recente sobre estacionamento ${i}`,new Date(base+i*3600000).toISOString(),`v7422-${i}`);
const scenarios={plans_silence:{enabled:true},closing_silence:{enabled:true},hot_silence:{enabled:true}};
assert.strictEqual(db.proactiveScenarioForContact(db.getContactById(c.id),scenarios),null,'menção antiga de plano não deve disparar follow-up contextual');

// Último envio proativo precisa ser recuperável após reinício.
db.markProactiveSent(c.id,'hot_silence','Teste');
assert(db.getLastProactiveSendAt(),'último envio proativo deve ficar persistido no histórico de atividades');

// Estrutura Minimal Wide.
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
for(const label of ['Visão','Inbox','CRM','Respostas','Comercial','Configurações']) assert(html.includes(`>${label}<`)||html.includes(`<span>${label}</span>`),`navegação principal sem ${label}`);
assert(html.includes('class="app-sidebar"'),'sidebar Minimal Wide ausente');
assert(html.includes('Obsidian Dark Orange'),'identidade visual fixa não documentada na configuração');
const css=fs.readFileSync(path.join(root,'public','style.css'),'utf8');
for(const token of ['--sidebar-w:216px','v7.4.22 — Minimal Wide / Obsidian Dark Orange','.response-workspace{grid-template-columns:minmax(320px,34%)']) assert(css.includes(token),`CSS Minimal Wide sem ${token}`);

console.log('Smoke v7.4.22 OK',{curatedKnowledge:true,recentProactivity:true,persistedProactivityGap:true,minimalWide:true});
try{db.flush();fs.rmSync(tmp,{recursive:true,force:true});}catch(_){ }
