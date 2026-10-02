const assert=require('assert');
const fs=require('fs'); const path=require('path'); const os=require('os'); const Module=require('module');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v749-'));
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
for(const name of ['settings.json','flows.json','crm-config.json']){const src=path.join(root,'data',name);if(fs.existsSync(src))fs.copyFileSync(src,path.join(tmp,'data',name));}
process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');
const c=db.upsertContact('5511990000749','Teste sequência');
db.applyAIProfile(c.id,{ai_confidence:0.31,ai_confidence_reason:'pouco contexto',handoff_required:false,last_intent:'duvida'});
let cur=db.getContactById(c.id);
assert.strictEqual(Number(cur.requires_human||0),0,'baixa confiança marcou revisão humana');
assert.strictEqual(Number(cur.ai_paused||0),0,'baixa confiança pausou IA');
db.applyAIProfile(c.id,{ai_confidence:0.91,handoff_required:true,handoff_reason:'ameaça/processo'});
cur=db.getContactById(c.id);
assert.strictEqual(Number(cur.requires_human||0),1,'handoff explícito não marcou revisão');
assert.strictEqual(Number(cur.ai_paused||0),1,'handoff explícito não pausou IA');

// Stubs mínimos para carregar whatsapp.js sem instalar Baileys no ambiente de auditoria.
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(request==='@whiskeysockets/baileys') return {default:()=>({ev:{on(){}},sendMessage:async()=>{},sendPresenceUpdate:async()=>{},readMessages:async()=>{}}),DisconnectReason:{loggedOut:401,restartRequired:515},useMultiFileAuthState:async()=>({state:{},saveCreds:()=>{}}),Browsers:{ubuntu:()=>['Ubuntu','Chrome','1']},downloadContentFromMessage:async function*(){}};
  if(request==='pino') return ()=>({});
  if(request==='qrcode') return {toDataURL:async()=>''};
  return originalLoad.apply(this,arguments);
};
const wa=require('../codigo-fonte-dev/server/whatsapp');
Module._load=originalLoad;

db.updateContact(c.id,{ai_confidence:0.20,human_reason:'IA solicitou intervenção humana',requires_human:1},{activity:false});
assert.strictEqual(wa._test.isTransientLowConfidencePause(db.getContactById(c.id)),true,'não reconheceu pausa transitória antiga');

(async()=>{
  const order=[];
  const a=wa._test.enqueueContactTask('contato-1',async()=>{order.push('1-start');await new Promise(r=>setTimeout(r,30));order.push('1-end');});
  const b=wa._test.enqueueContactTask('contato-1',async()=>{order.push('2-start');order.push('2-end');});
  const c2=wa._test.enqueueContactTask('contato-2',async()=>{order.push('other');});
  await Promise.all([a,b,c2]);
  assert(order.indexOf('2-start')>order.indexOf('1-end'),'segunda mensagem começou antes da primeira terminar');
  assert(order.includes('other'),'contatos diferentes não executaram em paralelo');
  db.flush();
  console.log('Smoke v7.4.9 OK',{lowConfidenceDoesNotPause:true,explicitHandoffPreserved:true,legacyPauseRecoverable:true,perContactQueue:true});
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){ }
})().catch(e=>{console.error(e);process.exit(1)});
