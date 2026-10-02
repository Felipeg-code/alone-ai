// messaging-provider.js — abstração do transporte de mensagens.
// Hoje usa Baileys/WhatsApp Web. O require é lazy para manter o core testável
// e permitir trocar o transporte no futuro sem acoplar CRM/IA ao conector atual.
function wa(){return require('./whatsapp');}
function providerInfo(){return {id:'baileys-web',official:false,label:'WhatsApp Web (Baileys)'};}
let transportTail=Promise.resolve();
async function guarded(method,args,source){
  const run=transportTail.catch(()=>null).then(async()=>{try{return await wa()[method](...args);}catch(err){try{require('./safety-engine').recordTransportError(err,{source,phone:args?.[0]});}catch(_){}throw err;}});
  transportTail=run.catch(()=>null);
  return run;
}
module.exports={
  providerInfo,
  getStatus:(...args)=>wa().getStatus(...args),
  sendText:(...args)=>guarded('sendManualMessage',args,'sendText'),
  sendResponse:(...args)=>guarded('sendManualResponse',args,'sendResponse'),
  sendBuffer:(...args)=>guarded('sendManualBuffer',args,'sendBuffer'),
  disconnect:(...args)=>wa().disconnectWhatsApp(...args),
};
