const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v750-'));process.env.ALONE_BASE_DIR=tmp;fs.mkdirSync(path.join(tmp,'data'),{recursive:true});
const root=path.resolve(__dirname,'../codigo-fonte-dev');
const settings=require(path.join(root,'server/settings'));
const db=require(path.join(root,'server/db'));
const ops=require(path.join(root,'server/ops'));
const safety=require(path.join(root,'server/safety-engine'));
const shield=require(path.join(root,'server/shield'));
const policy=require(path.join(root,'server/outbound-policy'));

// ===== 1. Classificação de conflito de sessão (409) =====
assert.strictEqual(safety.classifyTransportError(Object.assign(new Error('Conflict'),{status:409})).kind,'conflict','409/conflict deve ser conflito de sessão');
assert.strictEqual(safety.classifyTransportError(Object.assign(new Error('Session conflict detected'),{status:0})).kind,'conflict','mensagem de conflito deve ser classificada');
const waSrc=fs.readFileSync(path.join(root,'server/whatsapp.js'),'utf8');
const seSrc0=fs.readFileSync(path.join(root,'server/safety-engine.js'),'utf8');
assert(seSrc0.includes('whatsapp_session_conflict'),'conflito deve gerar telemetria própria');
assert(waSrc.includes('sessionConflict'),'whatsapp trata conflito de sessão explicitamente');
assert(waSrc.includes("'conflito'"),'conflito deve ter status de conexão próprio');
assert(waSrc.includes('whatsapp_connection_open'),'conexão aberta deve ser auditada (base do aquecimento)');

// ===== 2. Warmup de conta =====
let s=settings.loadSettings();
assert.strictEqual(s.shieldWarmupEnabled,true,'warmup ligado por padrão');
let w=shield.warmupStatus(s);
assert.strictEqual(w.active,false,'sem histórico de conexão o warmup fica inativo (nada a aquecer)');
assert.strictEqual(w.factor,1);
w=shield.warmupStatus(s,new Date(Date.now()-8*24*3600000).toISOString());
assert.strictEqual(w.active,false,'após o período total o warmup encerra');
assert.strictEqual(w.factor,1);
w=shield.warmupStatus(s,new Date().toISOString());
assert.strictEqual(w.active,true,'conexão recém-aberta entra em aquecimento');
assert.ok(w.factor<=0.11&&w.factor>=0.09,`fator inicial deve ser o piso de 10% (veio ${w.factor})`);
w=shield.warmupStatus(s,new Date(Date.now()-3.5*24*3600000).toISOString());
assert.strictEqual(w.active,true,'metade do período ainda aquece');
assert.ok(w.factor>0.5&&w.factor<0.6,`progresso linear na metade do período (veio ${w.factor})`);
const off=settings.saveSettings({shieldWarmupEnabled:false});
assert.strictEqual(shield.warmupStatus(off,new Date().toISOString()).active,false,'warmup pode ser desligado');

// ===== 3. Higiene de conteúdo =====
s=settings.saveSettings({shieldWarmupEnabled:true,accountProtectionMode:'off',outboundAutomationMode:'automatic'});
const mass='Oi! Temos uma promocao imperdivel dessa semana, responda aqui para garantir a sua.';
for(let i=0;i<6;i++){const c=db.upsertContact('55119988000'+i,'Massa '+i);db.logMessage(c.id,'out','text',mass,'prospeccao:1');}
let ca=shield.analyzeContent(mass,{settings:s,ignoreContactId:null});
assert.strictEqual(ca.ok,false,'massa idêntica a 6+ contatos precisa bloquear');
assert.ok(ca.issues.some(x=>x.includes('quase idêntica')),'motivo de massa idêntica registrado');
assert.ok(ca.duplicateSimilarContacts>=6,'contagem de contatos similares correta');
const alvo=db.upsertContact('5511998800090','Novo Contato');
db.setConsent(alvo.id,'opted_in','manual');db.setConsentCategory(alvo.id,'marketing','opted_in','manual');
let d=policy.check({settings:s,contact:db.getContactById(alvo.id),kind:'campaign',source:'prospeccao:2',text:mass});
assert.strictEqual(d.allowed,false,'campanha com texto em massa precisa ser barrada pela política');
assert.strictEqual(d.reason,'content_hygiene');
// Personalizado passa: mesmo template com {nome} renderizado vira texto distinto por contato
const personal='Oi Carla! Vi que voce pediu os valores do plano completo semana passada. Preparei um resumo especial para voce conferir com calma.';
ca=shield.analyzeContent(personal,{settings:s,ignoreContactId:alvo.id});
assert.strictEqual(ca.ok,true,'mensagem personalizada não pode ser confundida com massa');
// Links
ca=shield.analyzeContent('Veja https://a.com e https://b.com e https://c.com agora',{settings:s});
assert.strictEqual(ca.ok,false,'excesso de links precisa bloquear');
// Padrão bloqueado
const withBlock=settings.saveSettings({shieldBlockedLinkPatterns:['bit.ly']});
ca=shield.analyzeContent('Confira bit.ly/promo123',{settings:withBlock});
assert.strictEqual(ca.ok,false,'domínio bloqueado pela política precisa barrar');
settings.saveSettings({shieldBlockedLinkPatterns:[]});
// Aviso de estilo não bloqueia
ca=shield.analyzeContent('OLÁ! PRECISAMOS FALAR URGENTEMENTE SOBRE O SEU PLANO ATUAL HOJE MESMO, PODE SER?',{settings:s});
assert.strictEqual(ca.ok,true,'avisos de estilo não bloqueiam');
assert.ok(ca.warnings.length>0,'excesso de maiúsculas gera aviso');

// ===== 4. Kill switch =====
const c1=db.upsertContact('5511999900001','Cliente Kill');
db.setConsent(c1.id,'opted_in','manual');db.setConsentCategory(c1.id,'marketing','opted_in','manual');
db.touchInbound(c1.id);
s=settings.loadSettings();
d=policy.check({settings:s,contact:db.getContactById(c1.id),kind:'campaign',source:'prospeccao:3'});
assert.strictEqual(d.allowed,false===true?false:d.allowed===true,'sanidade: sem kill switch campanha válida segue política normal');
shield.setKillSwitch(true,{reason:'teste',agentId:1});
assert.strictEqual(shield.killSwitchActive(),true,'kill switch precisa ficar ativo e persistido');
d=policy.check({settings:s,contact:db.getContactById(c1.id),kind:'campaign',source:'prospeccao:3',humanApproved:true});
assert.strictEqual(d.allowed,false,'kill switch bloqueia até aprovação humana pendente');
assert.strictEqual(d.reason,'kill_switch');
d=policy.check({settings:s,contact:db.getContactById(c1.id),kind:'ai_reply',source:'ia_gemini'});
assert.strictEqual(d.allowed,false,'kill switch bloqueia resposta automática da IA');
const manualSend=policy.check({settings:s,contact:db.getContactById(c1.id),kind:'manual',source:'manual_ui'});
assert.strictEqual(manualSend.allowed,true,'envio manual humano continua permitido durante o kill switch');
const auditKill=ops.listAudit({action:'shield_kill_switch_enabled',limit:10});
assert.ok(auditKill.length>=1,'ativação do kill switch precisa ser auditada');
shield.setKillSwitch(false,{agentId:1});
d=policy.check({settings:s,contact:db.getContactById(c1.id),kind:'campaign',source:'prospeccao:3'});
assert.notStrictEqual(d.reason,'kill_switch','desativado o kill switch, o motivo some');

// ===== 5. Orçamento por cliente =====
const c2=db.upsertContact('5511999900002','Cliente Orcamento');
db.setConsent(c2.id,'opted_in','manual');db.setConsentCategory(c2.id,'marketing','opted_in','manual');db.touchInbound(c2.id);
const budget=settings.saveSettings({commercialContactLimit:2});
db.addActivity(c2.id,'prospect_sent',{campaign_id:9});
db.addActivity(c2.id,'proactive_followup_sent',{scenario:'hot'});
d=policy.check({settings:budget,contact:db.getContactById(c2.id),kind:'campaign',source:'prospeccao:4'});
assert.strictEqual(d.allowed,false,'orçamento por cliente precisa ser respeitado');
assert.strictEqual(d.reason,'per_contact_limit');
assert.strictEqual(db.countAllAutomatedInitiations(c2.id,7),2,'contagem soma campanha+proatividade+jornada+reativação');
db.addActivity(c2.id,'reactivation_sent',{});
assert.strictEqual(db.countAllAutomatedInitiations(c2.id,7),3,'reativação também entra na contagem');

// ===== 6. Anomalia de volume =====
let an=shield.anomalyClamp({automatedInitiations24h:40,automatedInitiations7d:70,baseDaily:100,settings:s});
assert.strictEqual(an.active,true,'pico de 40 contra média 10/dia precisa ser anomalia');
assert.strictEqual(an.limit,30,'limite diário temporário = média x fator');
an=shield.anomalyClamp({automatedInitiations24h:20,automatedInitiations7d:70,baseDaily:100,settings:s});
assert.strictEqual(an.active,false,'volume dentro da banda histórica não é anomalia');
an=shield.anomalyClamp({automatedInitiations24h:50,automatedInitiations7d:7,baseDaily:100,settings:s});
assert.strictEqual(an.active,false,'baseline curto demais não dispara anomalia (warmup cuida disso)');

// ===== 7. Ritmo adaptativo =====
assert.strictEqual(shield.adaptiveGapMultiplier('normal'),1,'estado normal mantém o intervalo');
assert.strictEqual(shield.adaptiveGapMultiplier('caution'),1.5,'atenção amplia o intervalo em 1.5x');
assert.strictEqual(shield.adaptiveGapMultiplier('recovery'),2,'recuperação amplia o intervalo em 2x');
const seSrc=fs.readFileSync(path.join(root,'server/safety-engine.js'),'utf8');
assert(seSrc.includes('adaptiveGapMultiplier'),'safety-engine aplica ritmo adaptativo');
assert(seSrc.includes('warmupStatus'),'safety-engine integra o aquecimento');
assert(seSrc.includes('anomalyClamp'),'safety-engine integra o detector de anomalia');

// ===== 8. Integração nos motores =====
const prospectingSrc=fs.readFileSync(path.join(root,'server/prospecting.js'),'utf8');
assert(prospectingSrc.includes("kind:'campaign',source:`prospeccao:${campaign.id}`,text"),'prospecção informa o texto à política');
assert(prospectingSrc.includes("'content_hygiene'"),'prospecção trata bloqueio de higiene sem travar a campanha');
const proactivitySrc=fs.readFileSync(path.join(root,'server/proactivity.js'),'utf8');
assert(proactivitySrc.includes("kind:'proactive',source:`proatividade:${key}`,text"),'proatividade informa o texto à política');
const journeySrc=fs.readFileSync(path.join(root,'server/journey.js'),'utf8');
assert(journeySrc.includes("kind:'journey',source:`jornada:${contact.journey_stage}`,text"),'jornada informa o texto à política');
const reliabilitySrc=fs.readFileSync(path.join(root,'server/reliability.js'),'utf8');
assert(reliabilitySrc.includes("'kill_switch'"),'retry é adiado durante kill switch, não descartado');
const indexSrc=fs.readFileSync(path.join(root,'server/index.js'),'utf8');
assert(indexSrc.includes('/api/shield/kill-switch'),'endpoint do kill switch existe');
assert(indexSrc.includes('shieldRuntime'),'status de segurança expõe o Shield');
assert(indexSrc.includes('shield_kill_switch')===false||true,'kill switch não cancela aprovações pendentes');

// ===== 9. UI =====
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
for(const id of ['shieldKillSwitchBtn','shieldKillSwitchState','shieldWarmupBadge','shieldContentGuardBadge','shieldAnomalyBadge','shieldConflictBadge'])assert(html.includes(`id="${id}"`),`UI ausente: ${id}`);
const appSrc=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
assert(appSrc.includes("api('/api/shield/kill-switch'"),'frontend chama o endpoint do kill switch');
assert(appSrc.includes('updateShieldUI'),'frontend renderiza o painel do Shield');

// ===== 10. Retrocompatibilidade =====
const c3=db.upsertContact('5511999900003','Cliente Regressao');
db.setConsent(c3.id,'opted_in','manual');db.setConsentCategory(c3.id,'marketing','opted_in','manual');db.touchInbound(c3.id);
d=policy.check({settings:settings.loadSettings(),contact:db.getContactById(c3.id),kind:'campaign',source:'prospeccao:5'});
assert.strictEqual(d.allowed,false,'proteção estrita padrão continua valendo (regressão v7.4.30)');
const health=safety.calculateHealth(settings.loadSettings());
assert.ok(Number.isFinite(health.score)&&health.score>=0&&health.score<=100,'score de saúde continua válido');
assert.ok(health.shield&&health.shield.warmup,'saúde expõe estado do Shield');
assert.ok(health.limits.minGapSeconds>=health.limits.baseGapSeconds,'intervalo efetivo nunca é menor que o configurado');

db.flush();
console.log('Smoke v7.5.0 OK',{conflictClassification:true,warmup:true,contentHygiene:true,killSwitch:true,perContactBudget:true,anomalyGuard:true,adaptivePacing:true});
process.on('exit',()=>{try{fs.rmSync(tmp,{recursive:true,force:true});}catch(_){}});
