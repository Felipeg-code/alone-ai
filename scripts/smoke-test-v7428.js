const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7428-'));
process.env.ALONE_BASE_DIR=tmp;
fs.mkdirSync(path.join(tmp,'data'),{recursive:true});

const settings=require('../codigo-fonte-dev/server/settings');
const cfg=settings.loadSettings();
assert.strictEqual(cfg.businessType,'general');
assert.strictEqual(cfg.gymName,'Sua empresa');
const saved=settings.saveSettings({gymName:'Norte Consultoria',businessType:'professional',businessDescription:'Consultoria empresarial por reunião e proposta comercial'});
assert.strictEqual(saved.businessType,'professional');
assert(/Consultoria empresarial/.test(saved.businessDescription));

const crm=require('../codigo-fonte-dev/server/crm-config');
const labels=Object.fromEntries(crm.load().global.stages.map(x=>[x.id,x.label]));
assert.strictEqual(labels.apresentacao_plano,'Apresentação da oferta');
assert.strictEqual(labels.agendamento_avaliacao,'Agendamento');
assert.strictEqual(labels.pos_avaliacao,'Pós-atendimento');
assert.strictEqual(labels.primeiro_treino,'Início / onboarding');

const db=require('../codigo-fonte-dev/server/db');
const c=db.upsertContact('45999998888','Empresa Teste',{consentStatus:'opted_in'});
db.applyRealtimeMessageSignals(c.id,'Preciso de um orçamento para consultoria, quanto custa o serviço?','in');
let row=db.getContactById(c.id);
assert.strictEqual(row.last_intent,'oferta_e_valores');
assert.strictEqual(row.interest,'Oferta e valores');
assert.strictEqual(row.journey_stage,'apresentacao_plano');
assert(row.lead_score>=60);
db.applyRealtimeMessageSignals(c.id,'Gostei da proposta, quero contratar. Pode mandar o PIX?','in');
row=db.getContactById(c.id);
assert.strictEqual(row.last_intent,'fechamento');
assert.strictEqual(row.journey_stage,'fechamento');
assert(row.lead_score>=88);

const shippedFlows=fs.readFileSync(path.join(root,'data','flows.json'),'utf8');
for(const forbidden of ['Toledo/PR','Bora voltar a treinar','seu primeiro treino','rotina de treinos']) assert(!shippedFlows.includes(forbidden),`hardcode vertical encontrado: ${forbidden}`);
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
assert(html.includes('Segmento / perfil do negócio'));
assert(html.includes('Geral / qualquer empresa'));
assert(html.includes('Profissional / consultoria'));

// Migração de nomenclatura antiga deve preservar IDs internos e neutralizar a interface.
fs.writeFileSync(path.join(tmp,'data','crm-config.json'),JSON.stringify({global:{stages:[{id:'apresentacao_plano',label:'Apresentação do plano',enabled:true,order:1}]},users:{}},null,2));
const migrated=crm.load();
assert.strictEqual(migrated.global.stages[0].id,'apresentacao_plano');
assert.strictEqual(migrated.global.stages[0].label,'Apresentação da oferta');

db.flush();
fs.rmSync(tmp,{recursive:true,force:true});
console.log('Smoke v7.4.28 OK',{genericBusiness:true,legacyCompatible:true,realtimeGeneric:true});
