const fs=require('fs');const path=require('path');const os=require('os');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7427-'));process.env.ALONE_BASE_DIR=tmp;fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
const db=require('../codigo-fonte-dev/server/db');
(async()=>{
  const c=db.upsertContact('5545999988776','Memória Teste');
  db.updateCustomerMemory(c.id,{summary:'Cliente interessado em retorno',preferences:['manhã'],pinned_facts:['Prefere contato por WhatsApp'],manual_notes:'Não usar plano antigo.'},{source:'manual',agentId:1});
  db.applyAIProfile(c.id,{interest:'Plano atual',profile_summary:'Quer voltar a treinar',objections:'valor',goals:'retomar rotina',journey_stage:'fechamento',memory_update:{decision_factors:['preço','horário'],important_facts:['Quer voltar em breve']}});
  let m=db.getCustomerMemory(c.id);
  if(!m.pinned_facts.includes('Prefere contato por WhatsApp'))throw new Error('Fato fixado foi perdido');
  if(m.manual_notes!=='Não usar plano antigo.')throw new Error('Nota manual foi sobrescrita');
  db.setJourneyStage(c.id,'cancelamento',{reason:'teste'});m=db.getCustomerMemory(c.id);if(m.relationship_status!=='cancelamento'||!m.cancellation.cancelled_at)throw new Error('Cancelamento não registrado');
  db.setJourneyStage(c.id,'pos_cancelamento',{reason:'teste'});db.setJourneyStage(c.id,'reativacao',{reason:'retorno'});m=db.getCustomerMemory(c.id);if(m.relationship_status!=='reativacao'||m.reactivation.score<60)throw new Error('Reativação não preservada');
  // Limite comercial tolerante e configurável: conta somente iniciativas automáticas.
  const c2=db.upsertContact('5545888877665','Lead Teste');db.updateContact(c2.id,{lead_score:90,interest:'Planos',last_intent:'planos_e_valores'},{activity:false});db.logMessage(c2.id,'in','text','quais os planos?',null,null,false,null,'in1');db.touchInbound(c2.id);await new Promise(r=>setTimeout(r,12));db.logMessage(c2.id,'out','text','Temos opções',null,null,false,null,'out1');db.touchOutbound(c2.id);for(let i=0;i<10;i++)db.markProactiveSent(c2.id,'plans_silence','teste');
  const base={commercialContactWindowDays:7,proactiveScenarios:{plans_silence:{enabled:true,silenceHours:0,minScore:0,maxAttempts:99,betweenAttemptsHours:0},hot_silence:{enabled:false},closing_silence:{enabled:false}}};
  if(db.getProactiveCandidates({...base,commercialContactLimit:10},{limit:20}).some(x=>x.id===c2.id))throw new Error('Limite por cliente não bloqueou');
  if(!db.getProactiveCandidates({...base,commercialContactLimit:12},{limit:20}).some(x=>x.id===c2.id))throw new Error('Limite configurável não foi respeitado');
  db.flush();
  console.log('Smoke v7.4.27 OK',{memoryTimeline:m.timeline.length,pinnedProtected:true,cancellation:true,reactivation:true,commercialLimit:true});
})().catch(e=>{console.error(e);process.exit(1)});
