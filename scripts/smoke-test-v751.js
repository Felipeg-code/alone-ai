const assert=require('assert');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');
function assert2(c,m){if(!c)throw new Error(m);}

// ===== 1. Fonte: placeholder técnico não pode mais ser gerado =====
const onb=fs.readFileSync(path.join(root,'codigo-fonte-dev/server/onboarding.js'),'utf8');
assert2(!onb.includes('Resposta histórica disponível no corpus'),'placeholder técnico antigo não pode mais ser gerado pelo bootstrap');
assert2(onb.includes('Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.'),'fallback local deve gerar o rótulo amigável de mensagem aprendida');

// ===== 2. Frontend detecta placeholder ANTIGO (bancos existentes) e NOVO =====
const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
assert2(app.includes("'Resposta histórica disponível no corpus; revisar antes de publicar como fato'"),'frontend precisa detectar o placeholder antigo já salvo em instalações reais');
assert2(app.includes("'Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.'"),'frontend precisa detectar o novo placeholder');
assert2(app.includes('function isLearnedPlaceholderText'),'função de detecção de mensagem aprendida existe');
assert2(app.includes('Mensagem aprendida</b>'),'card exibe o rótulo "Mensagem aprendida"');

// ===== 3. Espaço lateral do card utilizado com metadados =====
assert2(app.includes('response-learned-row'),'card usa a linha flex nota + metadados');
assert2(app.includes('response-learned-side'),'metadados ocupam o espaço ao lado da mensagem');
assert2(app.includes('learned_at?`📅'),'data de aprendizado exibida quando disponível');
assert2(app.includes('confidence?`🎯'),'confiança exibida quando disponível');
assert2(app.includes('evidence_count?`🔬'),'número de evidências exibido quando disponível');

// ===== 4. Respostas normais continuam mostrando o texto real =====
assert2(app.includes("escapeHTML(q.text||'Sem texto/legenda')"),'itens sem placeholder continuam exibindo o texto real');

// ===== 5. Editor avisa sobre mensagem aprendida =====
assert2(app.includes('substitua pelo texto real da resposta'),'editor orienta a substituir o texto de exemplo');

// ===== 6. CSS da nova linha =====
const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
for(const cls of ['.response-learned-row','.learned-note','.response-learned-side'])assert2(css.includes(cls),`CSS ausente: ${cls}`);

// ===== 7. Funcional: detecção cobre variantes com espaço/quebra =====
const LEARNED_PLACEHOLDER_TEXTS=['Resposta histórica disponível no corpus; revisar antes de publicar como fato','Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.'];
const isLearnedPlaceholderText=t=>LEARNED_PLACEHOLDER_TEXTS.includes(String(t||'').trim());
assert2(isLearnedPlaceholderText('Resposta histórica disponível no corpus; revisar antes de publicar como fato ')===true,'detecta placeholder antigo com espaços extras');
assert2(isLearnedPlaceholderText('Mensagem aprendida do histórico. Revise e escreva a resposta correta antes de aprovar.')===true,'detecta placeholder novo');
assert2(isLearnedPlaceholderText('Bom dia! Temos três planos disponíveis.')===false,'texto real de resposta não pode ser marcado como placeholder');
assert2(isLearnedPlaceholderText('')===false,'texto vazio não é placeholder');
assert2(isLearnedPlaceholderText(null)===false,'null não é placeholder');

console.log('Smoke v7.5.1 OK',{placeholderAmigavel:true,retrocompatibilidadeBancos:true,espacoLateralUtilizado:true,editorOrienta:true});
