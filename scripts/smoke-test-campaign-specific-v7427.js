const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-campaign-specific-'));process.env.ALONE_BASE_DIR=tmp;fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
const settings=require('../codigo-fonte-dev/server/settings');settings.saveSettings({prospectingEnabled:true,accountProtectionMode:'off',outboundAutomationMode:'automatic',prospectingStartHour:0,prospectingEndHour:24,prospectingGlobalDailyLimit:200,prospectingMinIntervalSeconds:1});
const db=require('../codigo-fonte-dev/server/db');const sent=[];const waPath=require.resolve('../codigo-fonte-dev/server/whatsapp');require.cache[waPath]={id:waPath,filename:waPath,loaded:true,exports:{getStatus:()=>({status:'conectado'}),sendManualMessage:async(phone,text)=>{sent.push({phone,text});return {ok:true}}}};
const prospecting=require('../codigo-fonte-dev/server/prospecting');
(async()=>{
 const a=db.createProspectCampaign({name:'A',initial_message:'A {nome}',confirmed_permission:true,interval_seconds:1,daily_limit:20},1);db.addProspectsToCampaign(a.id,[{phone:'5511990000001',name:'Ana'}],{confirmedPermission:true,agentId:1});db.setProspectCampaignStatus(a.id,'running');
 const b=db.createProspectCampaign({name:'B',initial_message:'B {nome}',confirmed_permission:true,interval_seconds:1,daily_limit:20},1);db.addProspectsToCampaign(b.id,[{phone:'5511990000002',name:'Bia'}],{confirmedPermission:true,agentId:1});db.setProspectCampaignStatus(b.id,'running');
 const out=await prospecting.processProspectingCampaign(b.id);assert(out.ok,'campanha B não processou');assert.strictEqual(out.campaignId,b.id);assert.strictEqual(sent.length,1);assert(sent[0].text.startsWith('B '),'processou campanha errada');assert.strictEqual(db.getProspectCampaignMetrics(a.id).sent,0,'campanha A foi consumida indevidamente');assert.strictEqual(db.getProspectCampaignMetrics(b.id).sent,1,'campanha B não marcou envio');
 console.log('Smoke campanha específica v7.4.27 OK',{campaignId:b.id,text:sent[0].text});
})().catch(e=>{console.error(e);process.exit(1)});
