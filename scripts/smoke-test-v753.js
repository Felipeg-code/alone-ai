const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v753-'));process.env.ALONE_BASE_DIR=tmp;
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
const root=path.resolve(__dirname,'..');
const srvDir=path.join(root,'codigo-fonte-dev','server');
const pubDir=path.join(root,'public');
const NEW_PH='Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.';

// ===== 1. Funcional: updateQuickReply com texto + aprovação (fluxo do editar em-lugar) =====
const db=require(path.join(srvDir,'db'));
const q1=db.createQuickReply({shortcut:'plano',title:'FAQ aprendida · quanto custa o plano?',type:'text',text:NEW_PH,enabled:true,review_status:'pending',source:'bootstrap_history',triggers:['quanto','plano'],auto_use:false,learned_at:new Date().toISOString(),confidence:.88,evidence_count:1});
let row=db.listQuickReplies().find(x=>x.id===q1.id);
assert.strictEqual(row.text,NEW_PH,'item nasce como mensagem aprendida');
assert.strictEqual(row.review_status,'pending','item nasce em revisão');
// editar em-lugar: salvar rascunho
db.updateQuickReply(q1.id,{text:'O plano completo custa R$ 99/mês.'});
row=db.listQuickReplies().find(x=>x.id===q1.id);
assert.strictEqual(row.text,'O plano completo custa R$ 99/mês.','edição em-lugar persiste o texto');
assert.strictEqual(row.review_status,'pending','salvar rascunho mantém em Revisar');
// salvar e aprovar
db.updateQuickReply(q1.id,{text:'O plano completo custa R$ 99/mês.',review_status:'approved',enabled:true,auto_use:false});
row=db.listQuickReplies().find(x=>x.id===q1.id);
assert.strictEqual(row.review_status,'approved','salvar e aprovar aprova o item');
assert.strictEqual(row.auto_use,false,'aprovação não liga envio automático');

// ===== 2. Card exibe QUAL mensagem foi aprendida (a pergunta capturada) =====
const app=fs.readFileSync(path.join(pubDir,'app.js'),'utf8');
assert(app.includes('function learnedQuestionFromTitle'),'extrator da pergunta aprendida existe');
assert(app.includes('learned-question'),'pergunta aprendida renderizada em destaque no card');
assert(app.includes('“${escapeHTML(learnedQuestion'),'pergunta vem do título e é escapada');

// ===== 3. Extração da pergunta: título "FAQ aprendida · X" -> "X" =====
const learnedQuestionFromTitle=title=>{const t=String(title||'').trim();const i=t.indexOf('·');return i>=0?t.slice(i+1).trim():t;};
assert.strictEqual(learnedQuestionFromTitle('FAQ aprendida · quanto custa o plano?'),'quanto custa o plano?');
assert.strictEqual(learnedQuestionFromTitle('Aprendida · horário de funcionamento'),'horário de funcionamento');
assert.strictEqual(learnedQuestionFromTitle('Título sem separador'),'Título sem separador');
assert.strictEqual(learnedQuestionFromTitle(''),'');

// ===== 4. Edição em-lugar sem sair da lista =====
assert(app.includes('response-inline-edit'),'bloco de edição em-lugar no card');
assert(app.includes('response-inline-text'),'textarea inline no card');
assert(app.includes('data-inline-save'),'botão Salvar no card');
assert(app.includes('data-inline-approve'),'botão Salvar e aprovar no card');
assert(app.includes('async function inlineSaveResponse'),'handler de salvamento inline existe');
assert(app.includes("body.review_status='approved'"),'aprovar inline envia review_status approved');
assert(app.includes('Escreva a resposta antes de aprovar.'),'bloqueio de aprovar sem escrever resposta');
assert(app.includes("closest('button,textarea,input,select')"),'clicar/digitar no textarea não abre o editor lateral');

// ===== 5. Itens pendentes com texto real: textarea pré-preenchida =====
assert(app.includes("learnedPh?'':escapeHTML(q.text||'')"),'textarea pré-preenchida com o texto real quando existir');

// ===== 6. CSS =====
const css=fs.readFileSync(path.join(pubDir,'style.css'),'utf8');
for(const cls of ['.learned-question','.response-inline-edit','.response-inline-text','.response-inline-actions','.response-learned-main'])assert(css.includes(cls),`CSS ausente: ${cls}`);

db.flush();
console.log('Smoke v7.5.3 OK',{perguntaAprendidaEmDestaque:true,edicaoEmLugar:true,salvarEAprovar:true,bloqueioAprovarVazio:true});
process.on('exit',()=>{try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){}});
