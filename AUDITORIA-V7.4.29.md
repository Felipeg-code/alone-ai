# AUDITORIA — Alone.AI v7.4.29

## Incidente analisado
Conta WhatsApp reportada como restringida após uso do Alone.AI.

## Causas prováveis
1. Uso de Baileys/WhatsApp Web, integração não oficial.
2. Existência simultânea de campanhas, proatividade e jornadas automáticas iniciando mensagens.
3. Defaults antigos permissivos: prospecção habilitada, limites diários altos e intervalos curtos.
4. Retries automáticos podiam reenviar follow-ups mesmo após mudança de configuração.
5. Reconexão automática podia insistir após erros compatíveis com restrição/autorização recusada.

Não é possível atribuir a restrição a uma única causa sem o motivo exibido pelo próprio WhatsApp e seus registros internos.

## Correções implementadas
- Novo Modo Proteção da Conta: strict / balanced / off.
- Strict é padrão em instalações/migrações que ainda não possuíam essa configuração.
- Strict bloqueia Campanhas, Proatividade e Jornada automáticas; respostas a clientes recentes e atendimento manual continuam disponíveis.
- Balanced mantém Campanhas bloqueadas e libera Proatividade/Jornada apenas quando há inbound recente dentro da janela configurada (24h padrão).
- Off mantém as regras operacionais normais existentes.
- Retries revalidam a política antes de enviar.
- Campanhas mostram motivo account_protection_campaigns_blocked.
- Interface ganhou painel explícito de Proteção da Conta.
- Reconexão automática é suspensa quando o conector recebe erro compatível com logout/forbidden/rate-limit/restrição.
- Defaults de novas instalações ficaram mais conservadores: prospecção off, 30/dia, intervalo 180s; proatividade 30/dia e intervalo 120s.
- Configurações/campanhas existentes são preservadas; proteção bloqueia o envio sem apagar trabalho do usuário.

## Testes
- smoke-test-v7429.js: OK
- smoke-test-v7428.js: OK
- smoke-test-v7427.js: OK
- smoke-test-v7425.js: OK
- smoke-test-v7424.js: OK
- smoke-test-v7419.js: OK
- smoke-test-v7417.js: OK
- smoke-test-campaign-specific-v7427.js: OK (proteção explicitamente off no teste funcional)
- smoke-test-campaigns-v749.js: OK (proteção explicitamente off no teste funcional)
- e2e-proactivity-v7423.js: OK (proteção explicitamente off no teste funcional)
- node --check em backend/frontend/scripts: OK

## Limitação estrutural
O Alone.AI ainda usa Baileys para conexão ao WhatsApp Web. Mesmo com controles de segurança, essa não é a integração oficial do WhatsApp Business Platform. Para Campanhas e automações iniciadas pela empresa em produção, a evolução recomendada é suportar a WhatsApp Business Platform/Cloud API, respeitando opt-in, janela de atendimento e templates aprovados quando exigidos.
