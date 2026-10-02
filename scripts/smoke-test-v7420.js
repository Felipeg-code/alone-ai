const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const root=path.resolve(__dirname,'..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7420-'));process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');const settings=require('../codigo-fonte-dev/server/settings');
const c=db.upsertContact('45999990000','Teste Proativo',{consentStatus:'opted_in'});db.updateContact(c.id,{lead_score:82,status:'interessado',interest:'plano mensal',last_intent:'planos e valores'},{activity:false});
const now=Date.now();db.importHistoricalMessage(c.id,'in','text','Quais os planos e valores?',new Date(now-8*3600000).toISOString(),'t-in');db.importHistoricalMessage(c.id,'out','text','Temos opções de planos. Qual deles fez mais sentido?',new Date(now-4*3600000).toISOString(),'t-out');
assert(db.segmentContacts('hot').some(x=>x.id===c.id),'lead quente deveria aparecer no segmento hot');
assert(db.segmentContacts('waiting_customer').some(x=>x.id===c.id),'cliente sem responder última saída deveria aparecer em aguardando cliente');
const st=settings.loadSettings();const cand=db.getProactiveCandidates(st,{limit:50});assert(cand.some(x=>x.id===c.id),'lead quente/plano em silêncio deveria ser elegível para proatividade');
db.markProactiveSent(c.id,'plans_silence','follow-up');let updated=db.getContactById(c.id);assert.strictEqual(updated.proactive_attempts,1);assert.strictEqual(updated.proactive_scenario,'plans_silence');
db.touchInbound(c.id);updated=db.getContactById(c.id);assert.strictEqual(updated.proactive_attempts,0,'resposta do cliente deve zerar tentativas proativas');assert.strictEqual(updated.proactive_scenario,'');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');for(const id of ['managementSegmentPanel','proactiveStatus','proactiveEnabled','proactiveScenarios','saveProactiveSettingsBtn','processProactiveNowBtn'])assert(html.includes(`id="${id}"`),`faltou ${id}`);
const js=fs.readFileSync(path.join(root,'public','app.js'),'utf8');for(const token of ['data-management-segment','data-inbox-group','showManagementSegment','loadProactivitySettings','collectProactiveScenarios'])assert(js.includes(token),`faltou ${token}`);
console.log('Smoke v7.4.20 OK');try{db.flush();fs.rmSync(tmp,{recursive:true,force:true});}catch(_){}
