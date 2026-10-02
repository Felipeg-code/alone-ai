# AUDITORIA — Alone.AI v7.4.31

## Objetivo
Reforçar a prevenção de restrições por governança, qualidade e conformidade, sem mecanismos destinados a burlar detecção do WhatsApp.

## Problemas encontrados na v7.4.30
1. O Safety Engine limitava automações por hora, mas não havia teto global de 24h somando todos os módulos.
2. Aprovações humanas eram checadas quanto a expiração/opt-out, porém não reavaliavam integralmente cooldown, limites globais e circuit breaker no instante do envio.
3. Configuração persistida estava mais agressiva que os defaults do código: prospecção 150/dia e 60s; proatividade 80/dia e 45s.
4. Após falha de escrita do SQLite, o processo mantinha a instância problemática ativa e podia repetir o mesmo erro em gravações posteriores.
5. O painel não expunha limite global em 24h nem cooldown pós-restrição.

## Correções implementadas
- `safetyMaxAutomatedInitiationsPerDay` (default 40).
- `safetyRestrictionCooldownHours` (default 48h).
- Bloqueio explícito `restriction_cooldown` durante cooldown.
- Bloqueio `daily_automation_limit` quando o teto global de 24h é atingido.
- Aprovação humana passa por revalidação integral antes do transporte.
- Configuração atual ajustada para prospecção 30/dia + 180s e proatividade 30/dia + 120s.
- Falha de escrita SQLite fecha o handle e alterna para JSON fallback.
- UI atualizada com teto/hora, teto/24h, cooldown e indicadores.
- Teste `smoke-test-v7431.js` cobrindo teto diário, cooldown e aprovação revalidada.

## Resultado dos testes
A suíte `npm run smoke` concluiu com sucesso, incluindo o novo smoke da v7.4.31 e os testes de regressão anteriores. Avisos de `node:sqlite` experimental são do runtime Node 22 e não representam falha da suíte.

## Observação operacional importante
O transporte atual continua sendo WhatsApp Web via Baileys, identificado no sistema como não oficial. O Safety Engine reduz risco operacional, mas não oferece garantia contra restrições. Para operação em escala, o caminho mais robusto continua sendo migrar gradualmente o provider para a WhatsApp Business Platform/Cloud API, preservando o mesmo core de CRM, IA e filas.
