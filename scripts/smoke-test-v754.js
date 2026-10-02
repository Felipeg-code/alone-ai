const assert=require('assert');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');
const pubDir=path.join(root,'public');
function ok(c,m){if(!c)throw new Error(m);}

// ===== 1. Camada Obsidian Dark Orange 2.0 presente e final =====
const css=fs.readFileSync(path.join(pubDir,'style.css'),'utf8');
ok(css.includes('OBSIDIAN DARK ORANGE 2.0'),'camada 2.0 ausente');
ok(css.lastIndexOf('OBSIDIAN DARK ORANGE 2.0')>css.lastIndexOf('v7.4.26 — Premium Obsidian polish'),'camada 2.0 precisa vir depois das camadas antigas');
ok(css.includes('Obsidian Dark Orange'),'string histórica preservada (regressão v7.4.22)');

// ===== 2. Tokens: escala obsidian + laranja + semânticos =====
for(const token of ['--obs-0:#0A0A0B','--obs-1:#101013','--obs-2:#16161A','--obs-3:#1D1D22','--obs-4:#26262C','--accent:#FF6A00','--accent-2:#FF8A33','--accent-glow','--ok:#3DD68C','--warn:#F5B54A','--bad:#F06060'])ok(css.includes(token),`token ausente: ${token}`);
// tokens antigos remapeados para a escala nova (re-colore as camadas antigas)
ok(css.includes('--bg:#0A0A0B')&&css.includes('--border:#28282F'),'tokens antigos remapeados');

// ===== 3. Botões padronizados =====
ok(css.includes('button.primary-action')&&css.includes('linear-gradient(180deg,var(--accent-2),var(--accent))'),'botão primário com gradiente laranja');
ok(css.includes('button.danger-btn'),'botão de perigo padronizado');
ok(css.includes('.logout-btn'),'logout padronizado');
ok(css.includes(':focus-visible{outline:2px solid var(--accent-2)'),'anel de foco visível (acessibilidade)');

// ===== 4. Campos com anel laranja =====
ok(css.includes('input:focus,select:focus,textarea:focus'),'foco padronizado em todos os campos');
ok(css.includes('box-shadow:0 0 0 3px var(--accent-glow)'),'anel de foco laranja');

// ===== 5. Switch padronizado =====
ok(css.includes('.switch-row input[type="checkbox"]'),'checkbox de switch vira toggle padronizado');

// ===== 6. Sidebar: trilho ativo + contadores =====
const html=fs.readFileSync(path.join(pubDir,'index.html'),'utf8');
ok(html.includes('class="app-sidebar"'),'sidebar mantida (regressão v7.4.22)');
for(const id of ['sideCountInbox','sideCountReview','sideCountSafety'])ok(html.includes(`id="${id}"`),`contador da sidebar ausente: ${id}`);
ok(css.includes('.app-sidebar .tab-btn.active::before'),'trilho laranja no item ativo');
ok(css.includes('.nav-count{'),'chip de contador estilizado');
ok(css.includes('.nav-count.warn'),'contador de alerta âmbar');

// ===== 7. Contadores vivos no frontend =====
const app=fs.readFileSync(path.join(pubDir,'app.js'),'utf8');
ok(app.includes('async function updateSidebarCounters'),'função de contadores vivos existe');
ok(app.includes("api('/api/metrics')"),'contador Inbox usa métricas reais');
ok(app.includes("api('/api/quick-replies')"),'contador Revisar usa a fila real');
ok(app.includes("api('/api/safety/status')"),'contador Safety usa o risk state real');
ok(app.includes('sidebarCounterTimer=setInterval'),'contadores atualizam automaticamente');
ok(app.includes('if(sidebarCounterTimer)clearInterval(sidebarCounterTimer)'),'timer limpo ao relogar (sem duplicar)');

// ===== 8. Recolor obsidian dos componentes v7.5.x =====
ok(css.includes('.proactive-attempt{background:var(--obs-2)'),'follow-ups no obsidian novo');
ok(css.includes('.response-inline-edit textarea{background:var(--obs-1)'),'edição inline no obsidian novo');
ok(css.includes('.response-badge.pending{background:rgba(245,181,74,.13)'),'badge Revisar âmbar semântico');

console.log('Smoke v7.5.4 OK',{obsidian20:true,tokensRemapeados:true,botoesPadronizados:true,contadoresVivos:true,focoAcessivel:true});
