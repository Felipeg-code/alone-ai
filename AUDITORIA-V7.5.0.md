# AUDITORIA Alone.AI v7.5.0 — Alone Shield (quarta etapa de segurança)

## Contexto

A v7.4.33 já tinha consentimento granular, opt-out, limites globais, circuit breaker, cooldowns, Recovery Probation, reconnect storm guard, trava atômica e classificação fina de transporte. Esta auditoria perguntou: **ainda existem causas evitáveis de restrição não cobertas?** A resposta foi sim — seis delas.

## Brechas encontradas e corrigidas

### 1. Conta nova podia operar a 100% imediatamente
**Problema:** conexão recém-conectada herdava os limites cheios. Volume alto em conta/sessão nova é o gatilho clássico de bloqueio.
**Correção:** **Warmup** — a partir do primeiro evento auditado de conexão aberta (`whatsapp_connection_open`), a capacidade de iniciativas automáticas começa em 10% e libera linearmente até 100% em 7 dias (`shieldWarmupDays`, `shieldWarmupFloorPercent`). Sem histórico de conexão, o Warmup fica inativo (motores já exigem conexão aberta para enviar).

### 2. Massa idêntica não era detectada
**Problema:** a mesma mensagem (ou quase) disparada a dezenas de contatos é o principal padrão de spam — e passava por todas as políticas existentes.
**Correção:** **Higiene de conteúdo** — toda iniciativa automática (campanha, proatividade, jornada) informa o texto à política; o Shield compara com o outbound automatizado das últimas 24h por similaridade de shingles (Jaccard ≥ 0,85) e bloqueia quando ≥5 contatos distintos já receberam conteúdo quase idêntico. Mensagens personalizadas com `{nome}` ficam naturalmente abaixo do limiar. Excesso de links (>2) e domínios da lista bloqueada também barram; MAIÚSCULAS/emoji flood geram apenas aviso. Vale também na revalidação de aprovações humanas.

### 3. Orçamento por cliente contava só 2 de 4 categorias
**Problema:** `countAutomatedInitiations` somava apenas proatividade + jornada; campanha e reativação não consumiam o orçamento por cliente.
**Correção:** `countAllAutomatedInitiations` soma as quatro categorias; `evaluate()` bloqueia com `per_contact_limit` ao atingir o teto (`commercialContactLimit` em `commercialContactWindowDays`). A função antiga foi preservada para não alterar a elegibilidade de proatividade.

### 4. Pico repentino de volume não pesava no limite diário
**Problema:** 10 envios/dia durante uma semana e depois 80 num dia era permitido se os tetos diários fossem altos — padrão típico de conta comprometida.
**Correção:** **Detector de anomalia** — com média ≥5/dia nos últimos 7 dias, volume de 24h acima de 3x a média reduz temporariamente o limite diário efetivo para `ceil(média × fator)` (`shieldAnomalySpikeFactor`).

### 5. Não havia botão de pânico
**Problema:** diante de um incidente ativo, a única resposta era caçar configurações.
**Correção:** **Kill switch** persistido em `ops-state.json` (sobrevive reinício e restore de backup), auditado, exposto em `POST /api/shield/kill-switch` e no painel. Bloqueia TODO outbound automatizado — inclusive respostas da IA e aprovações pendentes (que ficam preservadas, não canceladas). Envio manual humano segue permitido. Retries são adiados (`kill_switch` entra na lista de defer), não consumidos.

### 6. Conflito de sessão (409) era tratado como erro genérico
**Problema:** 409/conflict significa outra sessão ativa no mesmo número; reconexão automática viraria disputa infinita de sessões — instabilidade clássica.
**Correção:** classe de transporte própria `conflict`, telemetria `whatsapp_session_conflict`, status de conexão `conflito` e reconexão automática suspensa até intervenção humana.

### Bônus: falso "caution" por amostra pequena
**Problema:** 1 opt-out manual com 1 iniciativa automática = taxa 100% → score -35 → estado `caution` → capacidade cortada pela metade em instalação nova.
**Correção:** a penalidade de opt-out agora exige `initiated >= 5`, o mesmo guard que a taxa de resposta já tinha. Detectado durante o E2E de proatividade (v7.4.23): o estado `caution` + o novo ritmo adaptativo (1,5x) ampliava o intervalo global de 10s para 15s e a segunda tentativa do teste não passava — a causa raiz era o ruído estatístico, não o tempo.

## Deliberadamente NÃO implementado

Fingerprint spoofing, rotação de proxy residencial, mutação invisível de texto, jitter gaussiano "para parecer humano" e afins. Essas técnicas tentam burlar detecção em vez de melhorar conformidade — são instáveis, violam os termos do WhatsApp e não eliminam o risco estrutural do transporte não oficial.

## Testes

- `node --check` em todos os módulos: OK.
- **24/24 testes aprovados**: regressão completa v7.4.4 → v7.4.33 + novo `smoke-test-v750.js` (classificação 409, warmup em 4 pontos da curva, massa idêntica, personalizado passando, links, domínio bloqueado, aviso sem bloqueio, kill switch incluindo IA/aprovação/manual, orçamento por cliente, anomalia com baseline curto/longo, ritmo adaptativo, integração nos 5 motores, UI e retrocompatibilidade).
- **Boot real**: servidor iniciado com Node 22.16.0, login + troca de PIN, `GET /api/safety/status` exibindo `shieldRuntime` completo, kill switch ON/OFF via API refletindo no status, painel HTML servido, zero erros no log.
- Teste de linha de base executado antes das mudanças (git stash) para confirmar que o E2E de proatividade passava no código original — a regressão foi introduzida pelas minhas mudanças e corrigida na causa raiz, não escondida no teste.

## Configurações novas (todas com validação/clamp)

`shieldWarmupEnabled` (true) · `shieldWarmupDays` (7, 1–30) · `shieldWarmupFloorPercent` (10, 5–100) · `shieldContentGuardEnabled` (true) · `shieldDuplicateWindowHours` (24, 1–168) · `shieldDuplicateContactThreshold` (5, 2–500) · `shieldDuplicateSimilarity` (0.85, 0.5–1) · `shieldLinkLimit` (2, 0–10) · `shieldBlockedLinkPatterns` ([] até 50 padrões) · `shieldAnomalySpikeFactor` (3, 1.5–10)

## Limite estrutural (inalterado e honesto)

O provider continua `baileys-web` — integração **não oficial**. O Shield reduz drasticamente as causas evitáveis (conta nova, massa idêntica, ritmo, orçamento, pico, sessão duplicada), mas "0% de ban" não existe nesse transporte. A rota de menor risco estrutural permanece a WhatsApp Business Platform/Cloud API via `messaging-provider` (a abstração já existe; CRM, IA, memória, filas, Safety Engine e Shield ficam acima dela).
