// agents.js — equipe, autenticação local e especialidades usadas pelo roteamento automático do CRM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./paths');
const AGENTS_PATH = path.join(dataDir, 'agents.json');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPin(pin, encoded) {
  try {
    const [kind,salt,hash] = String(encoded || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const actual = crypto.scryptSync(String(pin || ''), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}
function rolePermissions(role) {
  const manager=role==='gestor';
  return {
    canViewAllCRM: manager,
    canManageProspecting: manager || role==='comercial',
    canManageKnowledge: manager,
    canManageQuickReplies: manager || role==='comercial' || role==='atendimento',
    canExportCRM: manager,
    canSeeDashboard: manager || role==='comercial',
    canRestoreBackup: manager,
    canDisconnectWhatsApp: manager,
    canManageTeam: manager,
    canViewAllTasks: manager,
    canViewAllCalendar: manager,
    canManageTasks: true,
    canManageCalendar: true,
  };
}
function normalize(a) {
  const legacyPin = a.pin != null ? String(a.pin) : null;
  const role=a.role || 'atendimento'; const defaults=rolePermissions(role);
  return {
    id: Number(a.id), name: a.name || `Atendente ${a.id}`,
    pin_hash: a.pin_hash || (legacyPin ? hashPin(legacyPin) : hashPin(crypto.randomBytes(12).toString('hex'))),
    color: a.color || '#FF6B00', active: a.active !== false, role,
    specialties: Array.isArray(a.specialties) ? a.specialties : ['geral'],
    ...Object.fromEntries(Object.keys(defaults).map(k=>[k,a[k]!==undefined?Boolean(a[k]):defaults[k]])),
    must_change_pin: a.must_change_pin === true || Boolean(legacyPin && ['000000','111111','222222','333333','123456'].includes(legacyPin)),
  };
}
function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}
function loadAgents() {
  const raw = readRaw();
  const list = raw.map(normalize);
  if (!raw.length) {
    const initial = normalize({id:1,name:'Gestor',pin:'123456',role:'gestor',specialties:['geral','gestao'],canViewAllCRM:true});
    saveAgents([initial]); return [initial];
  }
  if (raw.some(a => a.pin != null || !a.pin_hash)) saveAgents(list); // migra PIN em texto puro na primeira leitura
  return list;
}
function saveAgents(agents) {
  fs.mkdirSync(dataDir, {recursive:true});
  const normalized = agents.map(a => {
    const current = normalize(a);
    if (a.pin !== undefined && a.pin !== null && String(a.pin).trim()) { const rawPin=String(a.pin).trim(); current.pin_hash = hashPin(rawPin); current.must_change_pin=['000000','111111','222222','333333','123456'].includes(rawPin); }
    delete current.pin;
    return current;
  });
  const tmp = `${AGENTS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf-8');
  fs.renameSync(tmp, AGENTS_PATH);
}
function publicAgents() { return loadAgents().map(({ pin_hash, ...rest }) => rest); }
function activeAgents() { return loadAgents().filter((a) => a.active).map(({ pin_hash, ...rest }) => rest); }
function activeAgentIds() { return activeAgents().map((a) => a.id); }
function login(agentId, pin) {
  const agent = loadAgents().find((a) => a.id === Number(agentId));
  if (!agent || !verifyPin(pin, agent.pin_hash)) return null;
  const { pin_hash, ...safe } = agent; return safe;
}
function getAgent(agentId) { const a = loadAgents().find((x) => x.id === Number(agentId)); if (!a) return null; const { pin_hash, ...safe } = a; return safe; }
function resetDefaultAccess() {
  const initial = normalize({id:1,name:'Gestor',pin:'123456',role:'gestor',specialties:['geral','gestao'],canViewAllCRM:true,must_change_pin:true});
  saveAgents([initial]);
  return { id:1, name:'Gestor', pin:'123456' };
}
module.exports = { loadAgents, saveAgents, publicAgents, activeAgents, activeAgentIds, login, getAgent, hashPin, verifyPin, rolePermissions, resetDefaultAccess };
