function normalize(text){return String(text||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();}
function isOptOutText(text, settings={}) {
  const normalized=normalize(text); if(!normalized)return false;
  const explicitPatterns=[
    /^(sair|parar|remover)$/,
    /^(nao quero)$/,
    /\bnao\s+(quero|desejo)\s+(mais\s+)?(mensagens|receber mensagens|promocoes|ofertas|contato comercial)\b/,
    /\b(parar|pare|cancelar|remover)\s+(de\s+)?(mandar|enviar|receber)?\s*(mensagens|promocoes|ofertas|contato comercial)\b/,
    /\bme\s+(remova|tire)\s+(da\s+)?(lista|prospeccao)\b/
  ];
  if(explicitPatterns.some(r=>r.test(normalized)))return true;
  return (settings.prospectingOptOutKeywords||[]).some(kw=>{
    const k=normalize(kw); if(!k)return false;
    if(/mensag|promo|ofert|prospec|contato comercial/.test(k))return normalized.includes(k);
    return normalized===k;
  });
}
module.exports={isOptOutText};
