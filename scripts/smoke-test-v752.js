const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v752-'));process.env.ALONE_BASE_DIR=tmp;
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
const root=path.resolve(__dirname,'..');
const srvDir=path.join(root,'codigo-fonte-dev','server');
const pubDir=path.join(root,'public');
const OLD_PH='Resposta histórica disponível no corpus; revisar antes de publicar como fato';
const NEW_PH='Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.';

// ===== 1. Migração funcional de banco legado: placeholder antigo -> rótulo amigável =====
// Simula uma instalação real com quick replies já salvos com o texto técnico antigo.
const legacyDb={schemaVersion:10,nextContactId:1,nextMessageId:1,nextActivityId:1,nextCampaignId:1,nextQueueId:1,nextTaskId:1,nextEventId:1,nextQuickReplyId:3,
  contacts:[],messages:[],activities:[],prospectCampaigns:[],prospectQueue:[],tasks:[],calendarEvents:[],
  quickReplies:[
    {id:1,shortcut:'plano',title:'FAQ aprendida · quanto custa o plano?',type:'text',text:OLD_PH,enabled:true,review_status:'pending',source:'bootstrap_history',triggers:['quanto','plano'],auto_use:false},
    {id:2,shortcut:'horario',title:'FAQ aprendida · horário de funcionamento',type:'text',text:'Atendemos de segunda a sexta, das 8h às 18h.',enabled:true,review_status:'pending',source:'bootstrap_history',triggers:['horario'],auto_use:false}
  ]};
fs.writeFileSync(path.join(tmp,'data','ra-bot-db.json'),JSON.stringify(legacyDb),'utf8');
const db=require(path.join(srvDir,'db'));
const qr=db.listQuickReplies();
assert.strictEqual(qr.length,2,'banco legado precisa carregar as 2 respostas');
const migrated=qr.find(q=>q.id===1);
const intact=qr.find(q=>q.id===2);
assert.strictEqual(migrated.text,NEW_PH,'placeholder técnico antigo precisa ser migrado para o rótulo amigável');
assert.strictEqual(intact.text,'Atendemos de segunda a sexta, das 8h às 18h.','respostas com texto real não podem ser tocadas');

// ===== 2. Fonte do bootstrap segue gerando o rótulo amigável =====
const onb=fs.readFileSync(path.join(srvDir,'onboarding.js'),'utf8');
assert(!onb.includes(OLD_PH),'bootstrap não pode mais gerar o placeholder antigo');
assert(onb.includes(NEW_PH),'bootstrap gera o rótulo amigável');

// ===== 3. Frontend: detecção nos dois formatos + render =====
const app=fs.readFileSync(path.join(pubDir,'app.js'),'utf8');
assert(app.includes('isLearnedPlaceholderText'),'frontend detecta mensagem aprendida');
assert(app.includes(OLD_PH.slice(0,40)),'frontend mantém detecção do texto antigo');
assert(app.includes('Mensagem aprendida</b>'),'card exibe o rótulo Mensagem aprendida');
assert(app.includes('response-learned-side'),'metadados usam o espaço lateral do card');

// ===== 4. Follow-ups ilimitados, editáveis, na horizontal =====
assert(app.includes('proactive-attempt-add'),'botão de adicionar tentativa existe');
assert(app.includes('proactive-attempt-remove'),'botão de remover tentativa existe');
assert(app.includes('renumberProactiveAttempts'),'tentativas são renumeradas após adicionar/remover');
assert(app.includes('.proactive-attempt-text'),'coleta lê cada tentativa individual');
assert(app.includes('maxAttempts:Math.max(1,messages.length)'),'número de tentativas derivado da sequência editável');
assert(!app.includes('.proactive-messages'),'textarea único "uma por linha" foi substituído');
assert(!app.includes('max="5"'),'limite de 5 tentativas removido');
assert(app.includes('>=20'),'teto de sanidade de 20 tentativas por cenário');
const css=fs.readFileSync(path.join(pubDir,'style.css'),'utf8');
for(const cls of ['.proactive-attempts','.proactive-attempt{','.proactive-attempt-add','.proactive-attempt-remove'])assert(css.includes(cls),`CSS ausente: ${cls}`);
assert(css.includes('display:flex')&&css.includes('overflow-x:auto'),'fila de tentativas é horizontal com rolagem');

// ===== 5. Cache do navegador sempre revalida (fim do "preso" na UI antiga) =====
const idx=fs.readFileSync(path.join(srvDir,'index.js'),'utf8');
assert(idx.includes("express.static(publicDir,{setHeaders:res=>res.setHeader('Cache-Control','no-cache')}))"),'estáticos servidos com Cache-Control no-cache');

// ===== 6. Cenários salvos com muitas tentativas continuam válidos para o motor =====
const s=require(path.join(srvDir,'settings')).saveSettings({proactiveScenarios:{hot_silence:{enabled:true,label:'Lead quente',silenceHours:6,minScore:75,betweenAttemptsHours:24,messages:['M1 {nome}','M2 {nome}','M3 {nome}','M4 {nome}','M5 {nome}','M6 {nome}']}}});
const rule=s.proactiveScenarios.hot_silence;
assert.strictEqual(rule.messages.length,6,'motor aceita sequência longa de follow-ups');
// engine usa msgs[Math.min(attempt,...)]: tentativa 6 recupera a última mensagem
const attemptIdx=Math.min(5,rule.messages.length-1);
assert.strictEqual(rule.messages[attemptIdx],'M6 {nome}','tentativa 6 usa a sexta mensagem');

db.flush();
console.log('Smoke v7.5.2 OK',{migracaoBancoLegado:true,placeholderAmigavel:true,followupsIlimitados:true,layoutHorizontal:true,cacheRevalidado:true});
process.on('exit',()=>{try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){}});
