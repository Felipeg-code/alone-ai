# AUDITORIA Alone.AI v7.4.32

Data: 02/10/2026

## Objetivo
Reauditoria do Safety Engine da v7.4.31 com foco em restrição, bloqueio, consentimento, opt-out, concorrência entre filas, retry e métricas de saúde.

## Achados e correções

### 1. Reativação automática contornava o Safety Engine — CRÍTICO — CORRIGIDO
A rotina diária de reativação enviava diretamente pelo transporte. Ela não revalidava cooldown pós-restrição, circuit breaker, teto global ou categoria específica de consentimento.

Correção:
- reativação agora passa por `outboundPolicy`;
- categoria `reactivation` corrigida no classificador;
- reativação exige consentimento específico `reactivation=opted_in`;
- no modo de aprovação, a iniciativa é encaminhada para aprovação humana;
- envios de reativação agora entram nas métricas globais de automação.

### 2. Opt-out não era blindado em todas as rotas humanas — ALTO — CORRIGIDO
Texto manual, mídia, resposta rápida e sugestão aprovada podiam chegar diretamente ao transporte sem consultar a política central.

Correção:
- adicionada guarda comum de opt-out nas rotas manuais;
- retry de resposta rápida também revalida opt-out antes de enviar;
- um opt-out explícito só pode voltar a receber mensagens após atualização explícita de consentimento.

### 3. Erro de restrição podia ser tratado como falha comum — ALTO — CORRIGIDO
Uma falha 401/403/405/429 ou mensagem compatível com autorização recusada/rate limit podia acontecer durante o envio antes do evento de desconexão do socket.

Correção:
- classificação central de erros do transporte: `restriction`, `permanent`, `transient`;
- sinal de restrição gera imediatamente `whatsapp_restriction_suspected` e ativa o cooldown;
- retries permanentes/restritivos vão para dead-letter em vez de insistirem até cinco vezes;
- eventos repetidos de restrição são deduplicados por janela curta.

### 4. Concorrência entre motores de envio — ALTO — CORRIGIDO
Prospecção, proatividade, jornada e retry possuíam filas próprias, porém o transporte podia receber chamadas simultâneas de módulos diferentes.

Correção:
- transporte de outbound serializado por uma única fila em memória (`transportTail`);
- evita duas chamadas simultâneas ao socket;
- preserva as filas específicas existentes e seus controles.

### 5. Faltava intervalo global transversal — MÉDIO — CORRIGIDO
Havia intervalo por módulo, mas não uma janela que considerasse a última iniciativa automática de qualquer módulo.

Correção:
- novo `safetyMinAutomatedGapSeconds`;
- valor persistido da distribuição: 10 segundos;
- aparece no painel do Safety Engine;
- a checagem usa a última iniciativa automática persistida;
- retries não são tratados como nova iniciativa para essa regra e continuam regidos pelo backoff da fila.

### 6. Métrica de resposta podia ser inflada — MÉDIO — CORRIGIDO
Uma única resposta recente do cliente podia fazer várias iniciativas anteriores do mesmo contato serem contabilizadas como respondidas.

Correção:
- taxa de resposta passa a considerar a iniciativa automática mais recente por contato dentro da janela analisada;
- opt-outs passam a ser contados por contato único, evitando duplicação por várias alterações de categoria.

### 7. Reativação não aparecia no volume global — MÉDIO — CORRIGIDO
A rotina usava `markCampaignSent`, mas o Safety Engine só somava prospecting/proactivity/journey.

Correção:
- reativação gera `reactivation_sent`;
- evento incluído em 1h, 24h e 7d do Safety Engine.

## Novas proteções da v7.4.32
- serialização do transporte;
- detector de restrição no momento do send;
- dead-letter para falha permanente/restritiva;
- guarda de opt-out em texto, mídia, quick reply e sugestão;
- consentimento específico de reativação;
- intervalo global entre iniciativas automáticas;
- reativação integrada ao score e aos limites globais;
- métrica de resposta/opt-out menos inflável.

## Testes
Executado `npm run smoke` integral.

Resultado: PASSOU.

Inclui regressões v7.4.4 → v7.4.31 e novo `smoke-test-v7432.js`.

O aviso `node:sqlite ExperimentalWarning` é do Node.js 22. O teste de fallback também provoca deliberadamente uma escrita SQLite somente leitura para verificar a troca para JSON; a mensagem exibida durante a suíte é esperada.

## Limitação que permanece
O provider atual é Baileys/WhatsApp Web e não é a API oficial da Meta. Nenhuma camada local pode garantir ausência de restrição ou ban. A arquitetura mantém `messaging-provider.js` separado para permitir migração futura para a WhatsApp Business Platform/Cloud API sem reescrever CRM, IA, memória e jornadas.

## Referência operacional
A política do WhatsApp Business exige que empresas contatem usuários que forneceram o número e consentiram em receber mensagens, respeitem pedidos de opt-out e evitem spam. Na Plataforma oficial, iniciações fora da janela de 24h dependem de templates aprovados. Feedback negativo excessivo e envio em massa não autorizado podem resultar em restrições.
