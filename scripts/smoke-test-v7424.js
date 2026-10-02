const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7424-'));
process.env.ALONE_BASE_DIR=tmp;
const db=require('../codigo-fonte-dev/server/db');

const events=[]; const unsub=db.subscribeRealtime(e=>events.push(e));
const c=db.upsertContact('45999993333','Realtime',{consentStatus:'opted_in'});
db.touchInbound(c.id);
db.applyRealtimeMessageSignals(c.id,'Quais os planos e quanto fica por mês?','in');
let now=db.getContactById(c.id);
assert.strictEqual(now.last_intent,'oferta_e_valores');
assert.strictEqual(now.interest,'Oferta e valores');
assert(now.lead_score>=60,'score comercial deve atualizar imediatamente');
assert.strictEqual(now.lead_temperature,'morno');
assert.strictEqual(now.status,'interessado');
assert.strictEqual(now.journey_stage,'apresentacao_plano');
assert(/opções|valores/i.test(now.next_action));
assert(events.some(e=>e.kind==='crm_instant_update'&&e.contactId===c.id),'evento realtime de CRM ausente');

db.applyRealtimeMessageSignals(c.id,'Quero fechar, pode mandar o pix','in');
now=db.getContactById(c.id);
assert.strictEqual(now.last_intent,'fechamento');
assert(now.lead_score>=88,'sinal forte de fechamento precisa aquecer o lead imediatamente');
assert.strictEqual(now.lead_temperature,'quente');
assert.strictEqual(now.journey_stage,'fechamento');
assert(/fechamento/i.test(now.next_action));

db.touchOutbound(c.id);
now=db.getContactById(c.id);
assert.strictEqual(now.next_action,'Aguardar resposta do cliente');

// IA pode refinar depois sem depender do ciclo local.
db.applyAIProfile(c.id,{profile_summary:'Cliente comparou planos e está pronto para matrícula',needs:'Pagamento via PIX',lead_score:94,last_intent:'pagamento',next_action:'Enviar instruções finais de pagamento',ai_confidence:.92});
now=db.getContactById(c.id);
assert.strictEqual(now.profile_summary,'Cliente comparou planos e está pronto para matrícula');
assert.strictEqual(now.lead_score,94);
assert.strictEqual(now.next_action,'Enviar instruções finais de pagamento');
assert(events.some(e=>e.kind==='ai_profile_updated'&&e.contactId===c.id),'evento realtime de refinamento IA ausente');

// Frontend precisa consumir stream e atualizar CRM imediatamente.
const app=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
for(const token of ['new EventSource(`/api/events?token=${encodeURIComponent(sessionToken)}`)','src.addEventListener(\'crm\'','if(active===\'crm\')await loadKanban()','},180);']) assert(app.includes(token),`frontend realtime sem ${token}`);
const index=fs.readFileSync(path.join(root,'codigo-fonte-dev/server/index.js'),'utf8');
for(const token of ["app.get('/api/events'","db.subscribeRealtime","text/event-stream","req.path==='/events'"]) assert(index.includes(token),`backend SSE sem ${token}`);

unsub(); db.flush(); fs.rmSync(tmp,{recursive:true,force:true});
console.log('Smoke v7.4.24 OK',{instantSignals:true,sse:true,aiRefinement:true});
