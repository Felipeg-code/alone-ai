# AUDITORIA — Alone.AI v7.4.30

## Objetivo
Implementar uma camada de proteção operacional para WhatsApp baseada em conformidade, saúde da conta, consentimento e governança de outbound. A implementação não tenta mascarar automação nem burlar sistemas anti-spam.

## Implementações

### 1. WhatsApp Safety Engine
- Score interno de saúde 0–100.
- Indicadores: respostas às iniciativas automáticas, opt-outs, falhas de outbound, retries, volume automático na última hora e possível restrição recente registrada pelo conector.
- O score é uma métrica interna do Alone.AI e não representa o Quality Rating oficial da Meta.

### 2. Circuit breaker
- Bloqueia novas iniciativas automáticas quando a saúde cai abaixo do limiar configurado.
- Possível restrição/forbidden/rate limit recente reduz fortemente o score.
- Atendimento manual e respostas a clientes não são tratados como campanha automática.

### 3. Modos de outbound
- **Manual:** identifica oportunidades e exige ação humana para iniciar contato.
- **Aprovação:** prepara a mensagem e coloca na fila de aprovação.
- **Automático:** envia somente quando todas as políticas, consentimentos, janelas e limites permitem.
- Padrão da v7.4.30: **Aprovação**.

### 4. Fila de aprovação humana
- Compartilhada entre Campanhas, Proatividade, Jornada e Retry.
- Deduplicação por chave operacional.
- Aprovações expiram.
- Aprovação antiga é cancelada se o cliente respondeu depois.
- Aprovação é cancelada se a mesma mensagem já foi enviada por outro fluxo.
- Aprovar uma campanha exige consentimento de Marketing ainda válido.

### 5. Consent Ledger por categoria
Categorias independentes:
- Atendimento
- Atualizações
- Marketing
- Reativação

Opt-out geral bloqueia todas as categorias. Autorização geral não vira autorização de marketing automaticamente. Campanhas exigem Marketing `opted_in`.

### 6. Safe Outbound Policy central
Campanhas, Proatividade, Jornada e Retry passam pela mesma decisão de segurança antes do envio.

### 7. Limite operacional por hora
Limite configurável de iniciativas automáticas por hora. Ao atingir o limite, novos envios automáticos são bloqueados.

### 8. Centro visual de proteção
Na área Comercial/Campanhas:
- score de saúde;
- nível saudável/atenção/crítico;
- taxa de resposta;
- opt-out;
- falhas de outbound;
- restrição recente;
- volume automático na última hora;
- transporte atual;
- modo de outbound;
- circuit breaker;
- fila de aprovação.

### 9. Abstração de transporte
Criado `messaging-provider.js`.
Hoje o provider é `baileys-web`. A abstração permite uma futura implementação oficial, como WhatsApp Cloud API, sem reescrever o CRM, Proatividade, Campanhas e Jornada.

## Correções adicionais encontradas durante a regressão
- `messaging-provider` alterado para carregamento lazy para manter testes e módulos desacoplados do Baileys.
- Importação de campanha com permissão confirmada grava consentimento de Marketing.
- Migração de contatos antigos preserva consentimento geral como Atendimento, mas não presume Marketing.
- Diagnóstico de Campanhas informa quando o modo de Aprovação está impedindo envio automático.
- Proatividade mostra o modo de outbound atual.
- Fila operacional inclui aprovações pendentes.

## Testes executados
`npm run smoke` passou integralmente, incluindo:
- v7.4.4
- v7.4.5
- v7.4.8
- v7.4.9
- Campanhas v7.4.9
- v7.4.10
- v7.4.15
- v7.4.16
- v7.4.17
- v7.4.19
- v7.4.20
- v7.4.22
- E2E Proatividade v7.4.23
- v7.4.24
- v7.4.25
- v7.4.27
- Campanha específica v7.4.27
- v7.4.28
- v7.4.29
- **v7.4.30**

Também passaram verificações de sintaxe dos arquivos alterados.

## Limitações conhecidas
- Baileys continua sendo um transporte não oficial. O Safety Engine reduz risco operacional, mas não garante ausência de restrição.
- O score é interno e não substitui métricas oficiais da Meta.
- A instalação limpa via `npm ci` não foi validada integralmente neste ambiente por indisponibilidade/timeout de acesso externo ao registry. O pacote não inclui `node_modules`; o instalador continua responsável por instalar dependências.
- O armazenamento principal ainda usa snapshot JSON persistido em SQLite; a migração relacional continua recomendada para v7.5.

## Recomendação de operação após uma restrição
1. Manter **Proteção Estrita** inicialmente.
2. Usar Atendimento/IA apenas para responder clientes.
3. Depois migrar para **Equilibrada + Aprovação**.
4. Revisar consentimento por categoria.
5. Só usar **Automático** após período de saúde estável.
6. Para campanhas em escala, priorizar futura migração para WhatsApp Business Platform/Cloud API.
