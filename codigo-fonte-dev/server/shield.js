// shield.js — Alone Shield v7.5.0: camada complementar de proteção da conta WhatsApp.
// Missão: reduzir as causas EVITÁVEIS de restrição — aquecimento de conta nova,
// higiene de conteúdo (anti-massa-idêntica), ritmo adaptativo, orçamento por
// contato, kill switch de emergência e detecção de anomalia de volume.
//
// Posicionamento honesto: o transporte atual (Baileys/WhatsApp Web) não é oficial
// e nenhuma camada local zera o risco. O Shield reduz a exposição operacional;
// a rota de menor risco estrutural permanece a WhatsApp Business Platform/Cloud API.
//
// Deliberadamente NÃO implementa: fingerprint spoofing, proxy residencial,
// rotação de dispositivo, mutação invisível de texto ou qualquer técnica de
// evasão de detecção. O foco é conformidade, qualidade e comportamento saudável.
const ops = require('./ops');
const db = require('./db');

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n || 0))); }

// ============================== KILL SWITCH ==============================
// Botão de pânico persistido em ops-state.json. Bloqueia TODO outbound
// automatizado (campanhas, proatividade, jornada, reativação, retries e
// aprovações pendentes). Envios manuais humanos continuam permitidos —
// a decisão de digitar para um cliente continua sendo do operador.
function killSwitch() {
  const st = ops.getShieldState();
  const ks = st.killSwitch || {};
  return { active: Boolean(ks.active), reason: String(ks.reason || ''), at: ks.at || null, by: ks.by ?? null };
}
function killSwitchActive() { return killSwitch().active === true; }
function setKillSwitch(active, { reason = '', agentId = null } = {}) {
  return ops.setShieldKillSwitch(Boolean(active), String(reason || '').slice(0, 300), agentId == null ? null : Number(agentId));
}

// ============================== WARMUP ==============================
// Contas/conexões recém-conectadas são o momento de maior risco: volume alto
// imediatamente após o QR é o padrão clássico de conta nova enviando spam.
// O Warmup limita a capacidade de iniciativas automáticas a um piso (10%) e
// libera linearmente até 100% ao fim do período (padrão 7 dias).
//
// Idade da conta = primeiro evento auditado de conexão aberta desta instalação.
// Sem nenhum histórico de conexão, o Warmup fica inativo (nada a aquecer e os
// motores já exigem conexão aberta para enviar).
function connectionOpenedAt() {
  const rows = ops.listAudit?.({ action: 'whatsapp_connection_open', limit: 2000 }) || [];
  const ts = rows.map(r => new Date(r.created_at).getTime()).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
}
function warmupStatus(settings = {}, overrideOpenedAt = undefined) {
  const enabled = settings.shieldWarmupEnabled !== false;
  const warmupDays = clamp(settings.shieldWarmupDays ?? 7, 1, 30);
  const floorPct = clamp(settings.shieldWarmupFloorPercent ?? 10, 5, 100);
  const openedAt = overrideOpenedAt !== undefined ? overrideOpenedAt : connectionOpenedAt();
  if (!enabled || !openedAt) {
    return { enabled, active: false, factor: 1, firstConnectedAt: openedAt || null, ageHours: null, warmupDays, floorPercent: floorPct, daysRemaining: 0 };
  }
  const ageHours = Math.max(0, (Date.now() - new Date(openedAt).getTime()) / 3600000);
  const totalHours = warmupDays * 24;
  if (ageHours >= totalHours) {
    return { enabled, active: false, factor: 1, firstConnectedAt: openedAt, ageHours: Number(ageHours.toFixed(2)), warmupDays, floorPercent: floorPct, daysRemaining: 0 };
  }
  const progress = totalHours > 0 ? clamp(ageHours / totalHours, 0, 1) : 0;
  const floor = floorPct / 100;
  const factor = floor + (1 - floor) * progress;
  return {
    enabled, active: true, factor: Number(factor.toFixed(3)), firstConnectedAt: openedAt,
    ageHours: Number(ageHours.toFixed(2)), warmupDays, floorPercent: floorPct,
    daysRemaining: Math.max(1, Math.ceil((totalHours - ageHours) / 24)),
  };
}

// ============================ CONTENT HYGIENE ============================
// Analisa o texto de uma iniciativa automática ANTES do envio. O maior gatilho
// de spam no WhatsApp é a mesma mensagem (ou quase) disparada para dezenas de
// contatos. Mensagens personalizadas passam; massa idêntica não.
function normalizeForCompare(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function shingles(t, n = 4) {
  const norm = normalizeForCompare(t);
  const words = norm.split(' ').filter(Boolean);
  if (words.length < n) return new Set(words.length ? [norm] : []);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}
function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const uni = aSet.size + bSet.size - inter;
  return uni ? inter / uni : 0;
}
function extractLinks(t) {
  return String(t || '').match(/https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9][a-z0-9-]*\.(?:com|br|net|org|io|app|link|xyz|co|me|info)(?:\.[a-z]{2})?(?:\/[^\s]*)?/gi) || [];
}
function analyzeContent(text, { settings = {}, ignoreContactId = null } = {}) {
  const issues = [];
  const warnings = [];
  const raw = String(text || '');
  const result = { ok: true, severity: 'ok', issues, warnings, links: 0, duplicateSimilarContacts: 0, maxSimilarity: 0 };
  const enabled = settings.shieldContentGuardEnabled !== false;
  if (!enabled || !raw.trim()) return result;

  // 1) Massa quase idêntica: mesmo texto (similaridade alta) para N contatos
  //    distintos na janela. Mensagens com {nome} personalizado ficam abaixo
  //    do limiar de similaridade por natureza.
  const windowHours = clamp(settings.shieldDuplicateWindowHours ?? 24, 1, 168);
  const threshold = clamp(settings.shieldDuplicateContactThreshold ?? 5, 2, 500);
  const minSim = clamp(settings.shieldDuplicateSimilarity ?? 0.85, 0.5, 1);
  const recent = db.listRecentAutomatedOutbound(windowHours, 500);
  const target = shingles(raw);
  const dupContacts = new Set();
  let maxSim = 0;
  for (const m of recent) {
    if (ignoreContactId != null && Number(m.contact_id) === Number(ignoreContactId)) continue;
    const sim = jaccard(target, shingles(m.body));
    if (sim > maxSim) maxSim = sim;
    if (sim >= minSim) dupContacts.add(Number(m.contact_id));
  }
  result.duplicateSimilarContacts = dupContacts.size;
  result.maxSimilarity = Number(maxSim.toFixed(3));
  if (dupContacts.size >= threshold) {
    issues.push(`Mensagem quase idêntica já enviada a ${dupContacts.size} contatos nas últimas ${windowHours}h (similaridade ${Math.round(maxSim * 100)}%). Massa idêntica é o principal gatilho de marcação de spam; personalise por contato.`);
    result.severity = 'block';
  }

  // 2) Excesso de links
  const links = extractLinks(raw);
  result.links = links.length;
  const linkLimit = clamp(settings.shieldLinkLimit ?? 2, 0, 10);
  if (links.length > linkLimit) {
    issues.push(`Mensagem com ${links.length} links (limite configurado: ${linkLimit}).`);
    result.severity = 'block';
  }

  // 3) Domínios/padrões bloqueados pela política local
  const patterns = Array.isArray(settings.shieldBlockedLinkPatterns) ? settings.shieldBlockedLinkPatterns.map(String).filter(Boolean) : [];
  const hit = patterns.filter(p => p && raw.toLowerCase().includes(p.toLowerCase()));
  if (hit.length) {
    issues.push(`Link/domínio bloqueado pela política interna: ${hit.join(', ')}.`);
    result.severity = 'block';
  }

  // 4) Avisos de estilo (não bloqueiam — apenas sinalizam)
  const letters = raw.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length >= 40) {
    const caps = raw.replace(/[^A-ZÀ-Þ]/g, '').length;
    if (caps / letters.length > 0.6) warnings.push('Excesso de MAIÚSCULAS (parece grito/spam).');
  }
  const emojiCount = (raw.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).length;
  if (emojiCount > 15 || (raw.length > 0 && emojiCount / raw.length > 0.3)) warnings.push('Excesso de emojis.');
  if (raw.length > 1500) warnings.push('Mensagem muito longa para uma iniciativa automática.');
  if (/(.)\1{6,}/.test(raw)) warnings.push('Repetição excessiva do mesmo caractere.');

  if (issues.length) result.ok = false;
  return result;
}

// ============================ ANOMALY SPIKE ============================
// Compara o volume das últimas 24h com a média diária dos últimos 7 dias.
// Pico repentino (padrão de conta invadida/comprometida) tem a capacidade
// diária reduzida para a banda histórica até o comportamento normalizar.
function anomalyClamp({ automatedInitiations24h = 0, automatedInitiations7d = 0, baseDaily = 40, settings = {} } = {}) {
  const spikeFactor = clamp(settings.shieldAnomalySpikeFactor ?? 3, 1.5, 10);
  const avgDaily = Math.max(0, Number(automatedInitiations7d) || 0) / 7;
  const base = Math.max(1, Number(baseDaily) || 1);
  if (avgDaily < 5) return { active: false, limit: base, avgDaily: Number(avgDaily.toFixed(2)), spikeFactor, reason: '' };
  const cap = Math.ceil(avgDaily * spikeFactor);
  if (Number(automatedInitiations24h) > cap) {
    return { active: true, limit: Math.max(1, Math.min(base, cap)), avgDaily: Number(avgDaily.toFixed(2)), spikeFactor, reason: `Pico de volume: ${automatedInitiations24h} iniciativas em 24h contra média de ${avgDaily.toFixed(1)}/dia nos últimos 7 dias. Limite diário temporariamente reduzido para ${Math.min(base, cap)}.` };
  }
  return { active: false, limit: base, avgDaily: Number(avgDaily.toFixed(2)), spikeFactor, reason: '' };
}

// =========================== ADAPTIVE PACING ============================
// Em estados de atenção, o intervalo mínimo global entre iniciativas
// automáticas cresce — em vez de apenas bloquear tudo de uma vez.
function adaptiveGapMultiplier(riskState) {
  if (riskState === 'caution') return 1.5;
  if (riskState === 'recovery') return 2;
  return 1;
}

// ============================== SNAPSHOT ==============================
function snapshot(settings = {}) {
  return {
    version: '7.5.0',
    killSwitch: killSwitch(),
    warmup: warmupStatus(settings),
    contentGuard: {
      enabled: settings.shieldContentGuardEnabled !== false,
      duplicateWindowHours: clamp(settings.shieldDuplicateWindowHours ?? 24, 1, 168),
      duplicateContactThreshold: clamp(settings.shieldDuplicateContactThreshold ?? 5, 2, 500),
      duplicateSimilarity: clamp(settings.shieldDuplicateSimilarity ?? 0.85, 0.5, 1),
      linkLimit: clamp(settings.shieldLinkLimit ?? 2, 0, 10),
      blockedLinkPatterns: Array.isArray(settings.shieldBlockedLinkPatterns) ? settings.shieldBlockedLinkPatterns.map(String) : [],
    },
    anomaly: { spikeFactor: clamp(settings.shieldAnomalySpikeFactor ?? 3, 1.5, 10) },
  };
}

module.exports = {
  killSwitch, killSwitchActive, setKillSwitch,
  warmupStatus, connectionOpenedAt,
  analyzeContent, anomalyClamp, adaptiveGapMultiplier,
  snapshot,
  _test: { normalizeForCompare, shingles, jaccard, extractLinks },
};
