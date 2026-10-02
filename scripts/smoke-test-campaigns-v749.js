const assert=require('assert');
const fs=require('fs'); const path=require('path'); const os=require('os');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-campaign-v749-'));
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
for(const name of ['settings.json','flows.json','crm-config.json']){const src=path.join(root,'data',name);if(fs.existsSync(src))fs.copyFileSync(src,path.join(tmp,'data',name));}
process.env.ALONE_BASE_DIR=tmp;
const settingsStore=require('../codigo-fonte-dev/server/settings');
settingsStore.saveSettings({prospectingEnabled:true,accountProtectionMode:'off',outboundAutomationMode:'automatic',prospectingStartHour:0,prospectingEndHour:24,prospectingGlobalDailyLimit:150,prospectingMinIntervalSeconds:1});
const db=require('../codigo-fonte-dev/server/db');
let sent=[];
const waPath=require.resolve('../codigo-fonte-dev/server/whatsapp');
require.cache[waPath]={id:waPath,filename:waPath,loaded:true,exports:{
  getStatus:()=>({status:'conectado'}),
  sendManualMessage:async(phone,text)=>{sent.push({phone,text});return {ok:true};}
}};
const prospecting=require('../codigo-fonte-dev/server/prospecting');
(async()=>{
  const camp=db.createProspectCampaign({name:'Teste campanha',initial_message:'Oi {nome}, teste',confirmed_permission:true,interval_seconds:60,daily_limit:20},1);
  const imp=db.addProspectsToCampaign(camp.id,[{phone:'5511991111111',name:'Maria'},{phone:'5511992222222',name:'João'}],{confirmedPermission:true,source:'teste',agentId:1});
  assert.strictEqual(imp.added,2);
  db.setProspectCampaignStatus(camp.id,'running');
  const r1=await prospecting.processProspectingQueue();
  assert.strictEqual(r1.ok,true,'primeiro envio não saiu');
  assert.strictEqual(sent.length,1);
  assert(sent[0].text.includes('Maria'),'template não foi renderizado');
  let metrics=db.getProspectCampaignMetrics(camp.id);
  assert.strictEqual(metrics.sent,1);
  assert.strictEqual(metrics.pending,1);
  // Simula resposta do primeiro contato e valida métrica.
  const c1=db.getContactByPhone('5511991111111');
  db.markProspectReply(c1.id);
  metrics=db.getProspectCampaignMetrics(camp.id);
  assert.strictEqual(metrics.replied,1);
  const diag=prospecting.getProspectingDiagnostics();
  assert.strictEqual(diag.whatsappStatus,'conectado');
  assert.strictEqual(diag.runningCampaigns,1);
  // Campanha sem permissão não deve enviar.
  const c2=db.createProspectCampaign({name:'Sem permissão',initial_message:'Teste',confirmed_permission:false},1);
  db.addProspectsToCampaign(c2.id,[{phone:'5511993333333',name:'Pedro'}],{confirmedPermission:false,source:'teste',agentId:1});
  db.setProspectCampaignStatus(c2.id,'running');
  const before=sent.length;
  // a primeira campanha ainda está em cooldown; a sem permissão deve ser ignorada.
  const r2=await prospecting.processProspectingQueue();
  assert.strictEqual(sent.length,before,'campanha sem permissão enviou mensagem');
  assert(['nothing_due','global_daily_limit'].includes(r2.reason)||r2.ok===false);
  db.flush();
  console.log('Smoke campanhas v7.4.9 OK',{created:true,imported:true,consent:true,send:true,replyMetric:true,diagnostics:true});
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){ }
})().catch(e=>{console.error(e);process.exit(1)});
