# AUDITORIA Alone.AI v7.4.33 — terceira etapa de segurança

## Resultado

A v7.4.32 já tinha consentimento granular, opt-out, limites globais, circuit breaker, cooldown, transporte serializado e revalidação de aprovação. A terceira auditoria encontrou falhas residuais de classificação, concorrência e recuperação e adicionou um **Adaptive Risk Control**.

## Falhas encontradas e corrigidas

### 1. 405 tratado como possível ban
**Problema:** qualquer HTTP/status 405 entrava como `restriction`, gerando cooldown de 48h. Em clientes Baileys, `client_too_old` pode representar incompatibilidade de protocolo/versão.

**Correção:** nova classificação `compatibility`. 405/client_too_old não aciona cooldown de restrição. O conector tenta resolver a versão recente suportada pelo Baileys quando a função está disponível.

### 2. 429 tratado como restrição definitiva
**Problema:** rate-limit era agrupado com ban/restrição e o retry podia considerar qualquer classe diferente de transient como permanente.

**Correção:** nova classe `rate_limit`, cooldown próprio (6h por padrão), reconexão retardada (30 min por padrão) e retry adiado em vez de descartado.

### 3. Trava global existia, mas não protegia política + envio
**Problema:** `withAutomationLock` existia, porém os motores avaliavam a política fora dela. Módulos diferentes podiam aprovar o mesmo intervalo/limite antes de o primeiro registrar o envio.

**Correção:** prospecção, proatividade, jornada, reativação, retry e aprovação humana passaram a revalidar a política dentro da trava imediatamente antes do envio.

### 4. Duplo clique em aprovação podia duplicar envio
**Problema:** duas requisições de aprovação podiam ler `pending` antes de uma delas resolver o registro.

**Correção:** a aprovação é relida dentro da trava global; status e duplicidade são verificados novamente antes do envio.

### 5. Reconexões repetidas não pesavam no risco
**Problema:** quedas repetidas podiam gerar reconnect storm sem bloquear outbound automático.

**Correção:** cada fechamento gera `whatsapp_connection_closed`; 4 ou mais encerramentos em 15 min (configurável) marcam transporte como instável e suspendem novas iniciativas.

### 6. Retorno instantâneo a 100% após incidente
**Problema:** terminado o cooldown, o sistema voltava diretamente ao limite cheio.

**Correção:** Recovery Probation. Por padrão, após o cooldown de restrição, a conta opera 24h a 25% dos limites de hora/dia. Em saúde `warning`, os limites também caem adaptativamente para 50%.

### 7. Retry era consumido durante pausa de segurança
**Problema:** alguns bloqueios do Safety Engine terminavam o retry, perdendo uma entrega legítima que deveria apenas aguardar.

**Correção:** criado `deferRetry()`. Cooldown, rate-limit, instabilidade, limites, intervalo global e circuit breaker adiam o job sem consumir tentativa.

### 8. Resposta pendente pós-bootstrap usava envio interno sem política
**Problema:** uma resposta autônoma retomada após bootstrap chamava o transporte interno diretamente.

**Correção:** passa por `ai_reply` no outbound policy antes de sair; erros internos também alimentam a telemetria de transporte.

## Adaptive Risk Control

Estados operacionais:

- `normal`: operação dentro dos limites.
- `caution`: score em warning; capacidade automática reduzida.
- `recovery`: janela de recuperação gradual pós-incidente.
- `unstable`: tempestade de desconexões detectada.
- `rate_limited`: sinal recente de limitação de taxa.
- `halted`: cooldown de restrição ou circuit breaker crítico.

Sinais usados: taxa de resposta, opt-out, falhas de outbound, retries mortos/pendentes, volume 1h/24h, restrição recente, rate-limit, encerramentos de conexão e incompatibilidade recente de protocolo.

## O que deliberadamente NÃO foi implementado

Não foram adicionados jitter gaussiano para parecer humano, variação invisível de texto, fingerprint spoofing, proxy residencial ou outras técnicas de evasão. Além de não garantirem proteção, elas tentam contornar detecção em vez de melhorar conformidade e qualidade.

## Testes

- `node --check` nos módulos alterados: OK.
- Smoke/regressão v7.4.4 → v7.4.33: OK.
- Novo `smoke-test-v7433.js` verifica classificação 405/429/401/403, Recovery Probation, reconnect storm, trava global e defer do retry.
- O aviso `node:sqlite ExperimentalWarning` é emitido pelo Node 22 e não representa falha do Alone.AI.
- O teste que torna SQLite somente leitura de propósito continua validando fallback para JSON.

## Limite estrutural

O provider atual é `baileys-web`, portanto não é uma integração oficial do WhatsApp. O Safety Engine reduz exposição e impede vários padrões operacionais perigosos, mas não existe garantia técnica de “0% ban” nesse transporte. A rota de menor risco estrutural é migrar o provider para a WhatsApp Business Platform/Cloud API e manter CRM, IA, memória, filas e Risk Control acima dessa abstração.
