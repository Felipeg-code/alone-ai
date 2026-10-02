// whatsapp.js — conexão, ingestão de histórico, roteamento CRM e respostas automáticas.
const baileys = require('@whiskeysockets/baileys');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers, downloadContentFromMessage } = baileys;
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const db = require('./db');
const { loadFlows, matchFlow, isWithinBusinessHours, renderResponse } = require('./flows');
const { isOptOutText } = require('./optout');
const { loadSettings, saveSettings } = require('./settings');
const { activeAgents } = require('./agents');
const gemini = require('./gemini');
const onboarding = require('./onboarding');
const ops = require('./ops');
const { dataDir, baseDir } = require('./paths');

const AUTH_DIR = path.join(dataDir, 'auth');
const AUDIO_DIR = path.resolve(baseDir, 'audio');
let sock = null, lastQR = null, connectionStatus = 'desconectado', connectionError = null, connectedAt = null;
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let socketGeneration = 0;
let manualDisconnect = false;
let statusCallback = null;
let historyBootstrapTimer = null;
let pendingBootstrapRetryTimer = null;
let connectionBootstrapTimer = null;
let lastHistoryBatchAt = 0;
let historySyncCompleted = false;
let historyImportQueue = [];
let historyImportRunning = false;
let historyImportIdleTimer = null;
// Fila por conversa: evita que duas mensagens do mesmo contato sejam processadas em paralelo.
// Contatos diferentes continuam sendo atendidos em paralelo.
const contactProcessingQueues = new Map();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomBetween(min,max){min=Math.max(0,Number(min||0));max=Math.max(min,Number(max||min));return Math.round(min+Math.random()*(max-min));}
function humanDelay(settings={}) { return randomBetween(settings.agentDelayMinMs??1200,settings.agentDelayMaxMs??3400); }
function responseDelay(response={}){const min=Number(response.delayMinMs||0),max=Number(response.delayMaxMs||0);return max||min?randomBetween(min,max):Math.max(0,Number(response.delayMs||0));}
function externalId(msg) { return msg?.key?.id ? `${msg.key.remoteJid}:${msg.key.id}` : null; }
function enqueueContactTask(key, task) {
  const queueKey=String(key||'global');
  const previous=contactProcessingQueues.get(queueKey)||Promise.resolve();
  const current=previous.catch(()=>null).then(()=>task());
  contactProcessingQueues.set(queueKey,current);
  current.finally(()=>{ if(contactProcessingQueues.get(queueKey)===current) contactProcessingQueues.delete(queueKey); }).catch(()=>null);
  return current;
}
function enqueueIncomingMessage(msg) {
  const key=String(msg?.key?.remoteJid||msg?.key?.participant||'global');
  return enqueueContactTask(key,()=>handleIncomingMessage(msg));
}
function isTransientLowConfidencePause(contact) {
  if(!contact?.requires_human && !contact?.ai_paused) return false;
  const reason=String(contact?.human_reason||'').toLowerCase();
  const confidence=Number(contact?.ai_confidence ?? 1);
  // Compatibilidade com estados criados pela v7.4.8: baixa confiança genérica não deve
  // congelar definitivamente o agente. Handoffs explícitos/sensíveis continuam preservados.
  return confidence < 0.55 && (!reason || /confian|ia solicitou interven|informacao insuficiente|informa[cç][aã]o insuficiente/.test(reason));
}

function unwrapMessage(raw) {
  let msg = raw || {};
  // WhatsApp frequentemente encapsula conteúdo em mensagens efêmeras/view-once.
  for (let i=0;i<5;i++) {
    const nested = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message || msg.documentWithCaptionMessage?.message;
    if (!nested) break;
    msg = nested;
  }
  return msg;
}
function extractContent(m) {
  const msg = unwrapMessage(m.message || {});
  const directText = msg.conversation || msg.extendedTextMessage?.text || msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title || msg.listResponseMessage?.singleSelectReply?.selectedRowId || msg.templateButtonReplyMessage?.selectedDisplayText || '';
  if (directText) return { type: 'text', body: directText, text: directText };
  if (msg.imageMessage) { const c=msg.imageMessage.caption||''; return { type:'image', body:c?`[imagem recebida] ${c}`:'[imagem recebida]', text:c }; }
  if (msg.videoMessage) { const c=msg.videoMessage.caption||''; return { type:'video', body:c?`[vídeo recebido] ${c}`:'[vídeo recebido]', text:c }; }
  if (msg.audioMessage) return { type: 'audio', body: '[áudio recebido]', text:'' };
  if (msg.documentMessage) { const c=msg.documentMessage.caption||''; const b=`[documento recebido${msg.documentMessage.fileName ? ': ' + msg.documentMessage.fileName : ''}]${c?' '+c:''}`; return { type:'document', body:b, text:c }; }
  if (msg.stickerMessage) return { type: 'sticker', body: '[figurinha recebida]', text:'' };
  if (msg.locationMessage) return { type: 'location', body: '[localização recebida]', text:'' };
  if (msg.contactMessage || msg.contactsArrayMessage) return { type: 'contact', body: '[contato recebido]', text:'' };
  if (msg.reactionMessage) return { type:'reaction', body:`[reação recebida: ${msg.reactionMessage.text||''}]`, text:'' };
  return { type: 'unknown', body: '[mensagem não textual]', text:'' };
}

function mediaDescriptor(m) {
  const msg=unwrapMessage(m.message||{});
  if(msg.audioMessage)return {node:msg.audioMessage,kind:'audio',mime:msg.audioMessage.mimetype||'audio/ogg',label:'áudio recebido'};
  if(msg.imageMessage)return {node:msg.imageMessage,kind:'image',mime:msg.imageMessage.mimetype||'image/jpeg',label:'imagem recebida',caption:msg.imageMessage.caption||''};
  if(msg.videoMessage)return {node:msg.videoMessage,kind:'video',mime:msg.videoMessage.mimetype||'video/mp4',label:'vídeo recebido',caption:msg.videoMessage.caption||''};
  if(msg.documentMessage)return {node:msg.documentMessage,kind:'document',mime:msg.documentMessage.mimetype||'application/octet-stream',label:`documento recebido${msg.documentMessage.fileName?': '+msg.documentMessage.fileName:''}`,caption:msg.documentMessage.caption||''};
  return null;
}
async function bufferMedia(desc){
  const stream=await downloadContentFromMessage(desc.node,desc.kind); const chunks=[]; let size=0;
  for await (const chunk of stream){size+=chunk.length;if(size>10*1024*1024)throw new Error('Mídia acima de 10 MB');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function enrichMediaWithAI(msg, content, settings) {
  if(!settings.geminiApiKey || !['audio','image','video','document'].includes(content.type)) return content;
  try{const desc=mediaDescriptor(msg);if(!desc)return content;const buf=await bufferMedia(desc);const analysis=await gemini.analyzeMedia({settings,buffer:buf,mimeType:desc.mime,label:desc.label,caption:desc.caption||content.text||''});if(!analysis)return content;return {...content,body:`[${desc.label}] ${analysis}`.slice(0,5000),text:analysis};}
  catch(err){ops.audit('media_analysis_failed',{resource:'message',resourceId:externalId(msg),details:{type:content.type,error:String(err.message||err).slice(0,300)}});return content;}
}

async function sendReply(jid, response) {
  try {
    if (!sock || connectionStatus !== 'conectado') throw new Error('WhatsApp não conectado');
    if (response.type === 'text') return sock.sendMessage(jid, { text: response.text });
    const mediaDir=path.join(dataDir,'media');
    const name=path.basename(String(response.file||''));
    const candidates=[path.resolve(mediaDir,name),path.resolve(AUDIO_DIR,name)];
    const mediaPath=candidates.find(x=>fs.existsSync(x));
    if(['audio','image','video','document'].includes(response.type)){
      if(!mediaPath) throw new Error(`Mídia não encontrada: ${name}`);
      const buffer=fs.readFileSync(mediaPath); const caption=String(response.text||'');
      if(response.type==='audio') return sock.sendMessage(jid,{audio:buffer,mimetype:response.mimetype||'audio/ogg; codecs=opus',ptt:response.ptt!==false});
      if(response.type==='image') return sock.sendMessage(jid,{image:buffer,caption,mimetype:response.mimetype||undefined});
      if(response.type==='video') return sock.sendMessage(jid,{video:buffer,caption,mimetype:response.mimetype||undefined});
      if(response.type==='document') return sock.sendMessage(jid,{document:buffer,fileName:name,mimetype:response.mimetype||'application/octet-stream',caption});
    }
    throw new Error(`Tipo de resposta não suportado: ${response?.type || 'desconhecido'}`);
  } catch(err) { try{require('./safety-engine').recordTransportError(err,{source:'internal_reply',phone:String(jid||'').split('@')[0]});}catch(_){} throw err; }
}

function recentlySentFlow(contactId, flowName, hours = 6) {
  const cutoff = Date.now() - hours * 3600000;
  return db.getContactMessages(contactId, true).some((m) => m.direction === 'out' && m.flow_matched === flowName && new Date(m.created_at).getTime() >= cutoff);
}

function shouldRefreshProfile(contact, settings, {force=false}={}) {
  if(force)return true;
  if(!settings.autoCustomerProfiling)return false;
  const current=db.getContactById(contact.id)||contact;
  const history=db.getRecentConversation(contact.id,8);
  const inbound=history.filter(m=>m.direction==='in'&&String(m.body||'').trim()).length;
  // Não gaste uma segunda chamada Gemini em cada mensagem. Para contatos novos,
  // espere algum contexto; depois atualize no máximo a cada 24h.
  if(inbound<3)return false;
  if(!current.profile_updated_at)return true;
  const age=Date.now()-new Date(current.profile_updated_at).getTime();
  return !Number.isFinite(age)||age>=24*60*60*1000;
}

async function routeAndProfile(contact, settings) {
  // O perfilamento não depende do bootstrap completo. Se a IA está configurada,
  // ela pode classificar o contato enquanto o aprendizado histórico continua em segundo plano.
  if (!settings.aiEnabled || !settings.geminiApiKey || !settings.autoCustomerProfiling) return contact;
  try {
    const history = db.getRecentConversation(contact.id, Number(settings.aiContextMessages || 30));
    const profile = await gemini.analyzeCustomerContext({ settings, conversationHistory: history, contact: db.getContactById(contact.id) });
    db.applyAIProfile(contact.id, profile);
    const updated = db.getContactById(contact.id);
    if (settings.autoRoutingEnabled && profile.department) {
      const team=activeAgents();
      const currentAgent = team.find((a) => a.id === updated.assigned_agent_id);
      const hasExactSpecialist=team.some(a=>Array.isArray(a.specialties)&&a.specialties.includes(profile.department));
      const currentFits = currentAgent && (currentAgent.specialties.includes(profile.department) || (!hasExactSpecialist && currentAgent.specialties.includes('geral')));
      if (!currentFits) db.assignAgentAutomatically(contact.id, team, profile.department, 'roteamento_ia');
    }
    return db.getContactById(contact.id);
  } catch (err) {
    console.error('Falha ao atualizar perfil/roteamento com Gemini:', err.message);
    return db.getContactById(contact.id);
  }
}

async function handleIncomingMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  const phone = jid.split('@')[0];
  const pushName = msg.pushName || null;
  let content = extractContent(msg);
  const settings = loadSettings();
  content = await enrichMediaWithAI(msg, content, settings);
  const wasNewContact = !db.getContactByPhone(phone);
  const contact = db.upsertContact(phone, pushName);
  const logged = db.logMessage(contact.id, 'in', content.type, content.body, null, null, false, null, externalId(msg));
  if (!logged) return; // evento repetido do WhatsApp
  db.touchInbound(contact.id);
  onboarding.scheduleContinuousLearning({delayMs:45000});

  if (wasNewContact || !contact.assigned_agent_id) db.assignAgentAutomatically(contact.id, activeAgents(), 'atendimento', 'novo_contato');
  const flows = loadFlows();
  const textBody = content.text || (content.type === 'text' ? content.body : '');
  // Atualização local imediata do CRM: fatos determinísticos entram antes do perfilamento remoto.
  db.applyRealtimeMessageSignals(contact.id,textBody||content.body||'', 'in');
  const prospectReply = db.markProspectReply(contact.id);
  if (prospectReply) db.updateContact(contact.id, { next_action:'Qualificar resposta da prospecção' }, { activity:false });

  if (textBody && isOptOutText(textBody, settings)) {
    db.setConsent(contact.id, 'opted_out', 'pedido_no_whatsapp');
    db.updateContact(contact.id, { next_action:'Não realizar novos contatos comerciais' }, { activity:false });
    const confirmation = 'Tudo certo. Não enviaremos novas mensagens de prospecção para este número.';
    try {
      await sendReply(jid, { type:'text', text:confirmation });
      db.logMessage(contact.id, 'out', 'text', confirmation, 'opt_out_confirmacao');
      db.touchOutbound(contact.id);
    } catch (_) {}
    return;
  }

  const outOfHours = !isWithinBusinessHours(new Date(), settings);
  const keywordMatch = textBody ? matchFlow(flows, textBody, wasNewContact, {contact,settings,withinBusinessHours:!outOfHours}) : null;

  const flowActions=keywordMatch?.flow?.actions||{};
  if (flowActions.setStatus) db.setStatus(contact.id, flowActions.setStatus, { reason:`fluxo:${keywordMatch.key}` });
  if (flowActions.nextAction) db.updateContact(contact.id,{next_action:flowActions.nextAction},{activity:false});
  if (flowActions.addTags?.length) db.mergeContactTags(contact.id,flowActions.addTags);
  if (flowActions.humanReview) db.setHumanReview(contact.id,true,`fluxo:${keywordMatch.key}`);
  if (flowActions.pauseAI) db.setAIPaused(contact.id,true,{reason:`fluxo:${keywordMatch.key}`});
  if (settings.autoRoutingEnabled && flowActions.routeDepartment) {
    db.assignAgentAutomatically(contact.id, activeAgents(), flowActions.routeDepartment, `fluxo:${keywordMatch.key}`);
    db.updateContact(contact.id, { department: flowActions.routeDepartment }, { activity:false });
  }
  // Durante o bootstrap o agente continua atendendo. Só intenções sensíveis esperam
  // classificação completa; os demais perfis são refinados em segundo plano.
  const bootstrapReady=onboarding.canAutoRespond();
  const sensitiveIntent=/\b(cancel|trancar|cobran[cç]a|pagamento|estorno|reembolso|reclama[cç][aã]o|processo|advogad|procon|acidente|les[aã]o grave|amea[cç]a)\b/i.test(String(textBody||''));
  const mustProfileBeforeReply=sensitiveIntent;
  if(mustProfileBeforeReply){
    const profiledContact=await routeAndProfile(contact,settings);
    if(profiledContact?.ai_paused || profiledContact?.requires_human) return;
  }else{
    let currentContact=db.getContactById(contact.id);
    if(isTransientLowConfidencePause(currentContact)){
      db.setHumanReview(contact.id,false,'baixa_confianca_transitoria_recuperada');
      db.setAIPaused(contact.id,false,{reason:'baixa_confianca_transitoria_recuperada'});
      currentContact=db.getContactById(contact.id);
      ops.audit('ai_transient_pause_recovered',{contactId:contact.id,resource:'contact',resourceId:contact.id,details:{confidence:currentContact?.ai_confidence}});
    }
    if(currentContact?.ai_paused || currentContact?.requires_human)return;
    if(shouldRefreshProfile(contact,settings)) routeAndProfile(contact,settings).catch(err=>ops.audit('background_profile_failed',{contactId:contact.id,resource:'gemini',details:{error:String(err.message||err).slice(0,500)}}));
  }
  // O bootstrap pós-QR não pode deixar o agente mudo.
  // Se WhatsApp + Gemini + modo autônomo estão ativos, a mensagem é atendida imediatamente
  // com o contexto já disponível; o aprendizado profundo continua em segundo plano.
  if (settings.aiBootstrapAutoStart && !bootstrapReady && content.body) {
    const canServeNow=Boolean(settings.aiEnabled && settings.geminiApiKey && (settings.aiMode||'assistido')==='autonomo');
    // Só fica pendente quando não há agente autônomo operacional agora. Se respondermos já,
    // não marcamos pendência para evitar resposta duplicada ao fim do bootstrap.
    if(!canServeNow) db.markBootstrapPending(contact.id, externalId(msg));
    ops.audit(canServeNow?'ai_serving_during_bootstrap':'ai_message_deferred_during_bootstrap',{contactId:contact.id,resource:'message',resourceId:externalId(msg),details:{mode:settings.aiMode||'assistido'}});
    if(!canServeNow && (settings.aiMode||'assistido')!=='assistido') return;
  }
  // Modo Observação: aprende, classifica e roteia, mas não envia nenhuma resposta automática.
  if ((settings.aiMode||'assistido') === 'observacao') return;

  try { await sock.readMessages([msg.key]); await sock.sendPresenceUpdate('composing', jid); } catch (_) {}

  if (outOfHours && (settings.aiMode||'assistido')==='autonomo') {
    const flow = require('./flows').findSystemFlow(flows,'out_of_hours',{contact,settings,withinBusinessHours:false});
    let sentOutOfHoursNotice=false;
    if (flow && !recentlySentFlow(contact.id, flow[0], 6)) {
      for (const response of (flow[1].responses || []).filter(r=>r.enabled!==false)) {
        {const d=responseDelay(response);if(d)await sleep(d);}
        if(response.type==='wait') continue;
        const rendered=renderResponse(response,settings);
        await sendReply(jid, rendered);
        db.logMessage(contact.id, 'out', rendered.type, rendered.text || rendered.file, flow[0]);
        sentOutOfHoursNotice=true;
      }
      if(sentOutOfHoursNotice) db.touchOutbound(contact.id);
    }
    // O primeiro contato fora do horário recebe o aviso. Nas mensagens seguintes,
    // não repetimos o template, mas deixamos o agente continuar a conversa.
    if(sentOutOfHoursNotice){ try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} return; }
  }

  const flowExecution=keywordMatch?.flow?.execution||'ai_first';
  const learnedGenerative=Boolean(keywordMatch?.flow?.source==='bootstrap_history'||keywordMatch?.flow?.source==='bootstrap_history_adapted');
  const flowResponses=(keywordMatch?.flow?.responses||[]).filter(r=>r.enabled!==false);
  // Em modo assistido, uma regra fixa vira sugestão previsível em vez de ser enviada automaticamente.
  if ((settings.aiMode||'autonomo')==='assistido' && flowExecution==='fixed' && flowResponses.length && !learnedGenerative) {
    const suggested=flowResponses.filter(r=>r.type==='text').map(r=>renderResponse(r,settings).text).filter(Boolean).join('\n');
    if(suggested){ db.setAISuggestion(contact.id,suggested,`fluxo:${keywordMatch.key}`); ops.audit('flow_suggestion_ready',{contactId:contact.id,resource:'flow',resourceId:keywordMatch.key}); }
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
    return;
  }

  let sent = false;
  const fixedCooldownHours=Number(keywordMatch?.flow?.cooldownHours||0);
  const fixedOnCooldown=Boolean(keywordMatch?.key && fixedCooldownHours>0 && recentlySentFlow(contact.id,keywordMatch.key,fixedCooldownHours));
  if ((settings.aiMode||'autonomo')==='autonomo' && flowExecution==='fixed' && flowResponses.length && !learnedGenerative && keywordMatch?.flow?.allowFixedSend===true && !fixedOnCooldown) {
    for (const response of flowResponses) {
      {const d=responseDelay(response);if(d)await sleep(d);}
      if(response.type==='wait') continue;
      try {
        const rendered=renderResponse(response,settings);
        await sendReply(jid, rendered);
        db.logMessage(contact.id,'out',rendered.type,rendered.text||rendered.file,keywordMatch.key); sent=true;
      } catch(err){ ops.audit('flow_media_missing_or_failed',{contactId:contact.id,resource:'flow',resourceId:keywordMatch.key,details:{file:response.file,error:err.message}}); }
    }
    if(sent) db.touchOutbound(contact.id);
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
    return;
  }

  if (settings.aiEnabled && settings.geminiApiKey && textBody && (settings.aiMode||'assistido') !== 'observacao') {
    try {
      const history = db.getRecentConversation(contact.id, Number(settings.aiContextMessages || 30));
      const withoutCurrent = history.length && history[history.length-1].direction === 'in' ? history.slice(0,-1) : history;
      const reply = await gemini.generateReply({ settings, conversationHistory: withoutCurrent, incomingText: textBody, contact: db.getContactById(contact.id), intentContext: keywordMatch?.flow ? {label:keywordMatch.flow.label,actions:keywordMatch.flow.actions||{},ai_context:keywordMatch.flow.ai_context||null} : null });
      if (reply && (settings.aiMode||'assistido') === 'assistido') {
        db.setAISuggestion(contact.id,reply,'gemini_assistido');
        ops.audit('ai_suggestion_ready',{contactId:contact.id,resource:'message',resourceId:externalId(msg),details:{mode:'assistido'}});
      } else if (reply) {
        try {
          const d=humanDelay(settings); if(d) await sleep(d);
          await sendReply(jid, { type:'text', text:reply });
          db.logMessage(contact.id, 'out', 'text', reply, 'ia_gemini'); db.setAISuggestion(contact.id,'','gemini_autonomo'); sent = true;
        } catch (sendErr) {
          ops.enqueueRetry({kind:'text_message',uniqueKey:`ai:${contact.id}:${externalId(msg)||Date.now()}`,payload:{contactId:contact.id,text:reply,source:'ia_gemini_retry'}});
          ops.audit('ai_reply_queued_retry',{contactId:contact.id,resource:'message',resourceId:externalId(msg),details:{error:sendErr.message}});
          throw sendErr;
        }
      }
    } catch (err) {
      // Falha transitória do provedor não deve condenar o contato a handoff permanente.
      console.error('Erro no Gemini generativo:', err.message);
      ops.audit('ai_reply_failed_transient',{contactId:contact.id,resource:'gemini',details:{error:String(err.message||err).slice(0,500)}});
      const fallbackText=(!learnedGenerative && keywordMatch?.flow?.allowFixedSend===true)?(flowResponses.filter(r=>r.enabled!==false&&r.type==='text').map(r=>renderResponse(r,settings).text).filter(Boolean)[0]||''):'';
      if((settings.aiMode||'assistido')==='autonomo' && fallbackText){
        try { await sendReply(jid,{type:'text',text:fallbackText}); db.logMessage(contact.id,'out','text',fallbackText,keywordMatch?.key||'fallback_fluxo'); sent=true; }
        catch(sendErr){ ops.audit('ai_transient_fallback_failed',{contactId:contact.id,resource:'message',details:{error:String(sendErr.message||sendErr).slice(0,500)}}); }
      }
    }
  }

  if (!sent && (settings.aiMode||'assistido')==='assistido') { try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} return; }

  if (!sent && flowExecution!=='actions_only' && flowResponses.length && keywordMatch?.flow?.allowFixedSend===true && !fixedOnCooldown) {
    for (const response of flowResponses) {
      {const d=responseDelay(response);if(d)await sleep(d);}
      if(response.type==='wait') continue;
      const rendered=renderResponse(response,settings);
      try { await sendReply(jid, rendered); db.logMessage(contact.id,'out',rendered.type,rendered.text||rendered.file,keywordMatch.key); sent=true; }
      catch(err){ ops.audit('flow_response_failed',{contactId:contact.id,resource:'flow',resourceId:keywordMatch.key,details:{type:response.type,file:response.file,error:err.message}}); }
    }
  }

  if (!sent && content.type !== 'text') {
    const fallback = 'Recebi aqui. Um atendente da equipe vai conferir essa mensagem e continuar com você por aqui.';
    await sendReply(jid, { type:'text', text:fallback });
    db.logMessage(contact.id, 'out', 'text', fallback, 'midia_fallback');
  }
  if (sent) db.touchOutbound(contact.id);
  try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
}


async function processHistoryImportQueue() {
  if(historyImportRunning) return;
  historyImportRunning=true;
  db.beginBatch();
  try {
    while(historyImportQueue.length) {
      const job=historyImportQueue.shift();
      const rows=Array.isArray(job.messages)?job.messages:[];
      let imported=0;
      // Fatias pequenas devolvem o event loop ao socket entre blocos.
      for(let i=0;i<rows.length;i+=180) {
        imported += await importHistoryBatch(rows.slice(i,i+180), {manageBatch:false});
        if(i+180<rows.length) await new Promise(resolve=>setImmediate(resolve));
      }
      onboarding.markHistoryImported(imported);
      console.log(`📥 Histórico: ${imported} novas mensagens, ${job.contactCount||0} contatos (${rows.length} mensagens no lote; progresso ${job.progress ?? '?'}).`);
      await new Promise(resolve=>setImmediate(resolve));
    }
  } finally {
    db.endBatch();
    historyImportRunning=false;
    // Uma única persistência consolidada após drenar a rajada de histórico.
    if(historyImportIdleTimer)clearTimeout(historyImportIdleTimer);
    historyImportIdleTimer=setTimeout(()=>{try{db.flush();}catch(_){}},700);
    if(historyImportQueue.length) setImmediate(()=>processHistoryImportQueue().catch(err=>console.error('Erro ao importar fila histórica:',err.message)));
    else scheduleBootstrap(historySyncCompleted ? 900 : 5000, false);
  }
}
function enqueueHistoryImport(job){
  historyImportQueue.push(job);
  if(!historyImportRunning) setImmediate(()=>processHistoryImportQueue().catch(err=>console.error('Erro ao importar fila histórica:',err.message)));
}
async function importHistoryBatch(messages, {manageBatch=true}={}) {
  let imported = 0;
  if(manageBatch) db.beginBatch();
  try {
    for (const m of messages || []) {
      try {
        const jid = m.key?.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const content = extractContent(m);
        const phone = jid.split('@')[0];
        const contact = db.upsertContact(phone, m.pushName || null);
        const tsRaw = m.messageTimestamp;
        const tsNum = typeof tsRaw === 'object' && tsRaw?.toNumber ? tsRaw.toNumber() : Number(tsRaw || 0);
        const ts = tsNum ? new Date(tsNum * 1000).toISOString() : new Date().toISOString();
        const row = db.importHistoricalMessage(contact.id, m.key.fromMe ? 'out' : 'in', content.type, content.body, ts, externalId(m));
        if (row) imported++;
      } catch (err) { console.warn('Histórico ignorado:', err.message); }
    }
  } finally { if(manageBatch) db.endBatch(); }
  return imported;
}

async function processPendingBootstrapMessages() {
  const settings=loadSettings();
  if(!settings.aiEnabled || !settings.geminiApiKey || !onboarding.canAutoRespond()) return {processed:0};
  if(!isWithinBusinessHours(new Date(), settings)) {
    if(!pendingBootstrapRetryTimer) pendingBootstrapRetryTimer=setTimeout(()=>{pendingBootstrapRetryTimer=null;processPendingBootstrapMessages().catch(err=>ops.audit('bootstrap_pending_retry_failed',{details:{error:String(err.message||err).slice(0,500)}}));},15*60*1000);
    return {processed:0,deferredOutsideHours:true};
  }
  if(pendingBootstrapRetryTimer){clearTimeout(pendingBootstrapRetryTimer);pendingBootstrapRetryTimer=null;}
  let processed=0;
  for(const contact of db.listBootstrapPendingContacts(6,100)) {
    if(contact.ai_paused || contact.requires_human || contact.opted_out) { db.clearBootstrapPending(contact.id); continue; }
    const history=db.getRecentConversation(contact.id,Number(settings.aiContextMessages||30));
    const lastInbound=[...history].reverse().find(m=>m.direction==='in' && m.body);
    if(!lastInbound){db.clearBootstrapPending(contact.id);continue;}
    const withoutCurrent=history.filter(m=>m.id!==lastInbound.id);
    try{
      const reply=await gemini.generateReply({settings,conversationHistory:withoutCurrent,incomingText:lastInbound.body,contact:db.getContactById(contact.id)});
      if(reply){
        if((settings.aiMode||'assistido')==='assistido'){db.setAISuggestion(contact.id,reply,'gemini_pos_bootstrap_assistido');}
        else if((settings.aiMode||'assistido')==='autonomo'){
          const policy=require('./outbound-policy').check({settings,contact:db.getContactById(contact.id),kind:'ai_reply',source:'ia_pos_bootstrap'});
          if(policy.allowed){
            try{await sendManualMessage(contact.phone,reply);db.logMessage(contact.id,'out','text',reply,'ia_pos_bootstrap');db.touchOutbound(contact.id);}
            catch(sendErr){try{require('./safety-engine').recordTransportError(sendErr,{source:'ia_pos_bootstrap',phone:contact.phone});}catch(_){} ops.enqueueRetry({kind:'text_message',uniqueKey:`bootstrap:${contact.id}:${contact.bootstrap_pending_external_id||lastInbound.id}`,payload:{contactId:contact.id,text:reply,source:'ia_pos_bootstrap_retry'}});}
          } else { ops.audit('bootstrap_reply_blocked_by_safety',{contactId:contact.id,resource:'message',details:{reason:policy.reason}}); }
        }
      }
    }catch(err){ops.audit('bootstrap_pending_reply_failed',{contactId:contact.id,resource:'message',details:{error:err.message}});}
    db.clearBootstrapPending(contact.id); processed++;
    await sleep(500);
  }
  if(processed)ops.audit('bootstrap_pending_replies_processed',{details:{processed}});
  return {processed};
}

function scheduleBootstrap(delayMs = 8000, force = false) {
  if (historyBootstrapTimer) clearTimeout(historyBootstrapTimer);
  historyBootstrapTimer = setTimeout(async () => {
    const quietFor = Date.now() - Number(lastHistoryBatchAt || 0);
    if (!force && lastHistoryBatchAt && quietFor < 6000) return scheduleBootstrap(6000 - quietFor + 350, false);
    try { const result=await onboarding.runBootstrap({ force }); if(result?.ok) await processPendingBootstrapMessages(); }
    catch(err){ console.error('Erro no onboarding da IA:', err.message); }
  }, delayMs);
}

function importHistoryContacts(contacts = []) {
  let count = 0;
  for (const c of contacts || []) {
    try {
      const jid = c.id || c.jid;
      if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;
      const phone = jid.split('@')[0];
      const name = c.name || c.notify || c.verifiedName || c.pushName || null;
      db.upsertContact(phone, name); count++;
    } catch (_) {}
  }
  return count;
}

function safeAsyncEvent(label, handler) {
  return async (...args) => {
    try { return await handler(...args); }
    catch (err) {
      const detail=String(err?.stack||err?.message||err).slice(0,4000);
      console.error(`[whatsapp:${label}]`, detail);
      try { ops.audit('whatsapp_async_event_failed',{resource:'whatsapp',details:{event:label,error:String(err?.message||err).slice(0,800)}}); } catch (_) {}
      connectionError={code:null,message:`Falha interna no evento ${label}: ${String(err?.message||err).slice(0,300)}`,at:new Date().toISOString()};
      return null;
    }
  };
}

async function startWhatsApp(onStatusChange) {
  statusCallback = onStatusChange || statusCallback;
  if (sock && (connectionStatus === 'conectado' || connectionStatus === 'aguardando_qr' || connectionStatus === 'conectando')) return sock;
  const myGeneration=++socketGeneration;
  manualDisconnect = false;
  connectionStatus='conectando';
  connectionError=null;
  lastQR=null;
  statusCallback?.(connectionStatus,null);
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive:true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let resolvedVersion=null;
  try {
    if(typeof baileys.fetchLatestBaileysVersion==='function'){
      const v=await baileys.fetchLatestBaileysVersion();
      if(Array.isArray(v?.version))resolvedVersion=v.version;
    }
  } catch (err) { try{ops.audit('whatsapp_version_resolution_failed',{resource:'whatsapp',details:{error:String(err.message||err).slice(0,500)}});}catch(_){} }
  const socketOptions = {
    auth:state,
    logger:pino({level:'silent'}),
    ...(resolvedVersion?{version:resolvedVersion}:{}),
    printQRInTerminal:false,
    syncFullHistory:true,
    shouldSyncHistoryMessage:()=>true,
    // IMPORTANTE: WEB_BROWSER gera QR com muito mais confiabilidade que WIN32/DARWIN em sessões novas.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect:false,
    generateHighQualityLinkPreview:false,
    qrTimeout:60000,
    connectTimeoutMs:30000,
    keepAliveIntervalMs:20000,
    defaultQueryTimeoutMs:60000,
    retryRequestDelayMs:500,
    maxMsgRetryCount:5,
    enableAutoSessionRecreation:true,
  };
  const currentSock = makeWASocket(socketOptions);
  sock = currentSock;
  currentSock.ev.on('creds.update', saveCreds);
  currentSock.ev.on('connection.update', safeAsyncEvent('connection.update', async (update) => {
    if(myGeneration!==socketGeneration || sock!==currentSock) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) { historySyncCompleted=false; lastHistoryBatchAt=0; onboarding.resetForNewConnection(); connectionError=null; lastQR = await QRCode.toDataURL(qr); connectionStatus='aguardando_qr'; statusCallback?.(connectionStatus,lastQR); console.log('📲 QR Code do WhatsApp gerado.'); }
    if (connection === 'open') { connectionStatus='conectado'; connectionError=null; connectedAt=new Date().toISOString(); lastQR=null; reconnecting=false; reconnectAttempts=0; if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;} statusCallback?.(connectionStatus,null); console.log('✅ WhatsApp conectado! Preparando histórico e IA...');
      if (connectionBootstrapTimer) clearTimeout(connectionBootstrapTimer);
      // Fallback: algumas contas não emitem um marcador final confiável de histórico.
      connectionBootstrapTimer=setTimeout(()=>scheduleBootstrap(800,false),15000);
    }
    if (connection === 'close') {
      if(myGeneration!==socketGeneration || sock!==currentSock) return;
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || null;
      const message = lastDisconnect?.error?.message || `Conexão encerrada${code ? ' (código '+code+')' : ''}`;
      const safetyEngine=require('./safety-engine');
      const cls=safetyEngine.classifyTransportError(lastDisconnect?.error||Object.assign(new Error(message),{statusCode:code}));
      try{ops.audit('whatsapp_connection_closed',{resource:'whatsapp',details:{code,message:String(message).slice(0,500),classification:cls.kind,reconnectAttempts,connectedAt}});}catch(_){}
      safetyEngine.recordTransportError(lastDisconnect?.error||Object.assign(new Error(message),{statusCode:code}),{source:'connection.close'});
      const restrictionSuspected=cls.kind==='restriction';
      const authFailure=cls.kind==='auth'||Number(code)===Number(DisconnectReason.loggedOut);
      const rateLimited=cls.kind==='rate_limit';
      const shouldReconnect = !manualDisconnect && !restrictionSuspected && !authFailure && !rateLimited;
      connectionError={code,message,at:new Date().toISOString(),classification:cls.kind,restrictionSuspected};
      sock=null; connectedAt=null;
      if (shouldReconnect) {
        connectionStatus='conectando'; statusCallback?.(connectionStatus,null);
        reconnectAttempts++;
        const delay = code===DisconnectReason.restartRequired ? 350 : Math.min(30000, 1000*Math.pow(1.8,Math.min(reconnectAttempts,7)));
        console.log('↻ WhatsApp reiniciando conexão.', code || '', message, `tentativa ${reconnectAttempts}`, `classe ${cls.kind}`);
        if(reconnectTimer)clearTimeout(reconnectTimer);
        reconnecting=true;
        reconnectTimer=setTimeout(() => { reconnectTimer=null; reconnecting=false; startWhatsApp(statusCallback).catch((err)=>{connectionError={code:null,message:err.message,at:new Date().toISOString()};connectionStatus='desconectado';statusCallback?.(connectionStatus,null);onboarding.markWaitingForWhatsApp({preserveReady:true});console.error(err);}); }, delay);
      } else if(rateLimited && !manualDisconnect) {
        const mins=Math.max(5,Math.min(120,Number(loadSettings().safetyRateLimitReconnectMinutes||30)));
        connectionStatus='limitado'; statusCallback?.(connectionStatus,null); onboarding.markWaitingForWhatsApp({preserveReady:true});
        if(reconnectTimer)clearTimeout(reconnectTimer);
        reconnecting=true;
        reconnectTimer=setTimeout(()=>{reconnectTimer=null;reconnecting=false;startWhatsApp(statusCallback).catch(()=>{});},mins*60000);
        console.error(`⏸️ Rate limit detectado. Reconexão adiada por ${mins} min.`);
      } else {
        connectionStatus=restrictionSuspected?'restrito':'desconectado'; statusCallback?.(connectionStatus,null); onboarding.markWaitingForWhatsApp({preserveReady:true});
        if(restrictionSuspected) console.error('⛔ Possível restrição do WhatsApp. Reconexão automática suspensa.',code||'',message);
        else if(authFailure) console.log('❌ Sessão/autenticação do WhatsApp encerrada.', code || '', message);
        else console.log('❌ Sessão do WhatsApp encerrada.', code || '', message);
      }
    }
  }));
  currentSock.ev.on('messaging-history.set', safeAsyncEvent('messaging-history.set', async ({ messages, contacts, isLatest, progress, syncType }) => {
    // O callback do socket precisa devolver o controle rapidamente. Importação pesada aqui
    // bloqueia heartbeat/reconexão e pode derrubar uma sessão recém-aberta.
    lastHistoryBatchAt=Date.now(); if(isLatest) historySyncCompleted=true;
    const contactCount = importHistoryContacts(contacts);
    enqueueHistoryImport({messages:messages||[],contactCount,isLatest:Boolean(isLatest),progress,syncType});
    saveSettings({ historyScanStatus:'importando_historico' });
  }));
  // Versões recentes do Baileys também sinalizam a conclusão/pausa de cada fase de sincronização.
  currentSock.ev.on('messaging-history.status', safeAsyncEvent('messaging-history.status', async ({ status, progress }) => {
    if (status === 'complete' || Number(progress) >= 100) { historySyncCompleted=true; scheduleBootstrap(800, false); }
  }));
  currentSock.ev.on('messages.upsert', safeAsyncEvent('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) enqueueIncomingMessage(msg).catch((err)=>console.error('Erro ao processar mensagem:',err));
  }));
  return currentSock;
}

function getStatus() { const stableSeconds=connectedAt&&connectionStatus==='conectado'?Math.max(0,Math.floor((Date.now()-new Date(connectedAt).getTime())/1000)):0; return { status:connectionStatus, qr:lastQR, error:connectionError, connectedAt, stableSeconds, reconnectAttempts }; }
async function disconnectWhatsApp() {
  manualDisconnect = true;
  socketGeneration++;
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  reconnectAttempts=0;
  reconnecting = false;
  if (historyBootstrapTimer) clearTimeout(historyBootstrapTimer);
  historyImportQueue=[];
  contactProcessingQueues.clear();
  if(historyImportIdleTimer){clearTimeout(historyImportIdleTimer);historyImportIdleTimer=null;}
  if (connectionBootstrapTimer) clearTimeout(connectionBootstrapTimer);
  lastQR = null;
  connectionError = null;
  const current = sock;
  sock = null;
  connectionStatus = 'desconectado';
  connectedAt = null;
  statusCallback?.(connectionStatus, null);
  if (current) {
    try { await current.logout(); } catch (err) {
      try { current.end?.(new Error('Desconectado pelo painel')); } catch (_) {}
      console.warn('Aviso ao encerrar sessão WhatsApp:', err.message);
    }
  }
  try { fs.rmSync(AUTH_DIR, { recursive:true, force:true }); } catch (err) { console.warn('Não foi possível limpar autenticação:', err.message); }
  return { ok:true, status:'desconectado' };
}
async function sendCampaignMessage(phone, response) { return sendReply(`${phone}@s.whatsapp.net`, response); }
async function sendManualMessage(phone, text) {
  if (!sock || connectionStatus !== 'conectado') throw new Error('WhatsApp não conectado');
  return sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
}

async function sendManualBuffer(phone,{type,buffer,mimetype,fileName,caption='',ptt=false}) {
  if (!sock || connectionStatus !== 'conectado') throw new Error('WhatsApp não conectado');
  if(!buffer?.length) throw new Error('Arquivo vazio');
  const jid=`${phone}@s.whatsapp.net`;
  if(type==='audio') return sock.sendMessage(jid,{audio:buffer,mimetype:mimetype||'audio/ogg; codecs=opus',ptt:Boolean(ptt)});
  if(type==='image') return sock.sendMessage(jid,{image:buffer,mimetype:mimetype||undefined,caption:String(caption||'')});
  if(type==='video') return sock.sendMessage(jid,{video:buffer,mimetype:mimetype||undefined,caption:String(caption||'')});
  if(type==='document') return sock.sendMessage(jid,{document:buffer,mimetype:mimetype||'application/octet-stream',fileName:fileName||'arquivo',caption:String(caption||'')});
  throw new Error('Tipo de mídia não suportado');
}
async function sendManualResponse(phone, response) {
  if (!sock || connectionStatus !== 'conectado') throw new Error('WhatsApp não conectado');
  const jid=`${phone}@s.whatsapp.net`;
  if (!response || response.type==='text') return sock.sendMessage(jid,{text:String(response?.text||'')});
  const filePath=response.path || response.file;
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Arquivo da resposta rápida não encontrado');
  const data=fs.readFileSync(filePath); const mimetype=response.mimetype||'application/octet-stream';
  if(response.type==='audio') return sock.sendMessage(jid,{audio:data,mimetype,ptt:Boolean(response.ptt)});
  if(response.type==='image') return sock.sendMessage(jid,{image:data,mimetype,caption:response.text||''});
  if(response.type==='video') return sock.sendMessage(jid,{video:data,mimetype,caption:response.text||''});
  if(response.type==='document') return sock.sendMessage(jid,{document:data,mimetype,fileName:response.fileName||path.basename(filePath),caption:response.text||''});
  throw new Error('Tipo de mídia não suportado');
}
module.exports = { startWhatsApp, getStatus, disconnectWhatsApp, sendCampaignMessage, sendManualMessage, sendManualResponse, sendManualBuffer, importHistoryBatch, _test:{enqueueIncomingMessage,enqueueContactTask,isTransientLowConfidencePause} };
