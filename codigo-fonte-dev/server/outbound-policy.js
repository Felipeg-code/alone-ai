// outbound-policy.js — compatibilidade para a política central de segurança.
// Toda decisão de outbound automático passa pelo Safety Engine.
const safety=require('./safety-engine');
function mode(settings={}){const raw=String(settings.accountProtectionMode||'strict').toLowerCase();return ['strict','balanced','off'].includes(raw)?raw:'strict';}
function recentInbound(contact,hours=24){return safety.recentInbound(contact,hours);}
function check(args={}){const result=safety.evaluate(args);return {...result,mode:result.protection||mode(args.settings||{})};}
module.exports={check,mode,recentInbound};
