# Alone.AI v7.5.1 — Central de Respostas mais clara

- Itens "Revisar" aprendidos do histórico exibem agora o rótulo **🧠 Mensagem aprendida** em vez do texto técnico antigo ("Resposta histórica disponível no corpus...").
- O espaço ao lado da mensagem no card passou a ser usado: data de aprendizado, confiança e número de evidências aparecem em chips compactos.
- Retrocompatível: itens já salvos com o placeholder antigo em instalações reais também são exibidos com o novo rótulo.
- O editor da resposta orienta "substitua pelo texto real da resposta" ao abrir uma mensagem aprendida.
- Novo `smoke-test-v751.js`; regressão completa v7.4.4 → v7.5.1 (25 testes).

# Alone.AI v7.5.0 — Alone Shield

Quarta etapa de segurança do WhatsApp: a camada **Alone Shield** fecha as brechas restantes de proteção anti-restrição com aquecimento de conta, higiene de conteúdo, orçamento real por cliente, detector de anomalia de volume, ritmo adaptativo, kill switch de emergência e classificação de conflito de sessão.

## Alone Shield — novo nesta versão

- **Aquecimento de conta (Warmup):** conexão recém-conectada opera com 10% da capacidade automática, liberando linearmente até 100% em 7 dias (configurável). Volume alto em conta nova é o gatilho clássico de restrição.
- **Higiene de conteúdo:** mensagem quase idêntica enviada a 5+ contatos em 24h é bloqueada antes do envio (similaridade por shingles — mensagens personalizadas com {nome} passam naturalmente). Excesso de links e domínios bloqueados pela política também barram; gritos/emoji flood geram aviso.
- **Orçamento por cliente (real):** soma campanha + proatividade + jornada + reativação na janela configurada (padrão 10 em 7 dias) — antes só duas categorias contavam.
- **Detector de anomalia:** pico de volume acima de 3x a média diária dos últimos 7 dias reduz temporariamente o limite diário para a banda histórica (padrão de conta invadida).
- **Ritmo adaptativo:** em estado `caution` o intervalo global mínimo cresce 1,5x; em `recovery`, 2x — desacelera antes de bloquear.
- **Kill switch:** botão de pânico persistido que bloqueia TODO outbound automatizado (inclusive aprovações pendentes, que ficam preservadas) até ser desativado. Envios manuais humanos continuam.
- **Conflito de sessão (409):** outra sessão usando o mesmo número suspende a reconexão automática em vez de iniciar disputa de sessões.
- **Robustez do score:** taxa de opt-out agora exige amostra mínima de 5 iniciativas (igual à taxa de resposta), evitando falso estado de atenção em instalações novas.
- **Painel:** card Shield no Safety Engine com status de aquecimento, higiene, anomalia, conflito e botão de kill switch.
- **Smoke v7.5.0** + regressão completa v7.4.4 → v7.5.0.

> Importante: o transporte atual continua sendo WhatsApp Web via Baileys. Nenhuma camada local garante risco zero em integração não oficial. O Shield reduz as causas evitáveis; para risco estrutural mínimo, migre para a WhatsApp Business Platform/Cloud API (a abstração `messaging-provider` já está pronta para isso). O Alone Shield não implementa técnicas de evasão de detecção (fingerprint, proxy, mutação de texto) — por princípio e porque não funcionam a longo prazo.

# Alone.AI v7.4.33 — Adaptive Risk Control

Terceira etapa de segurança do WhatsApp: controle de risco adaptativo, recuperação gradual, detecção de instabilidade, classificação fina de erros e trava atômica de outbound.

## Segurança nova nesta versão

- **Risk Control adaptativo:** estados `normal`, `caution`, `recovery`, `unstable`, `rate_limited` e `halted`.
- **Recuperação gradual pós-restrição:** depois do cooldown, o outbound retorna por padrão a 25% da capacidade durante 24h antes de normalizar.
- **Rate-limit separado de ban:** 429 entra em pausa própria; não vira falha permanente nem cooldown de ban.
- **405 `client_too_old` separado de restrição:** tratado como incompatibilidade de protocolo/cliente.
- **Resolução de versão Baileys quando suportada:** usa `fetchLatestBaileysVersion()` com fallback seguro para o comportamento padrão da biblioteca.
- **Reconnect Storm Guard:** muitos encerramentos de conexão numa janela curta bloqueiam novas iniciativas automáticas.
- **Trava atômica real:** prospecção, proatividade, jornadas, reativação, retries e aprovações revalidam a política dentro da mesma fila global antes do envio.
- **Aprovação anti-duplo-clique:** aprovação é relida dentro da trava e uma mensagem já resolvida/enviada não é reenviada.
- **Retry consciente de segurança:** jobs são adiados durante cooldown, rate-limit, instabilidade e circuit breaker; não são consumidos à toa.
- **Telemetria de transporte:** encerramentos, rate-limit, incompatibilidade, autenticação e suspeita de restrição entram em auditorias distintas.
- **Painel ampliado:** mostra estado do Risk Control, rate-limit, instabilidade, recuperação gradual e capacidade adaptativa.

> Importante: o transporte atual continua sendo WhatsApp Web via Baileys. Nenhuma camada local pode garantir risco zero de restrição em uma integração não oficial. Para o menor risco estrutural possível, a evolução recomendada é um provider oficial pela WhatsApp Business Platform/Cloud API.

# Alone.AI


## v7.4.31 — Safety Engine reforçado

- Teto global de iniciativas automáticas em 24h, somando campanhas, proatividade e jornadas.
- Cooldown configurável após suspeita de restrição/autorização recusada.
- Aprovações humanas são revalidadas no instante do envio contra consentimento, cooldown, limites e circuit breaker.
- Limites persistidos de prospecção/proatividade retornam para uma configuração mais conservadora.
- SQLite degrada automaticamente para o espelho JSON após falha de escrita, evitando loop de erro.
- Painel do Safety Engine exibe limites de 1h/24h e cooldown pós-restrição.
- Smoke v7.4.31 adicionado, mantendo a regressão das versões anteriores.

## v7.4.30 — WhatsApp Safety Engine

- Safety Engine central para Campanhas, Proatividade, Jornada e Retry.
- Score interno de saúde da conta (0–100), sem se passar por métrica oficial da Meta.
- Circuit breaker automático por qualidade operacional e sinal recente de possível restrição.
- Modos Manual, Aprovação e Automático para outbound iniciado pelo sistema.
- Fila humana de aprovação com expiração e proteção contra duplicidade/stale reply.
- Consentimento granular por categoria: Atendimento, Atualizações, Marketing e Reativação.
- Campanhas exigem consentimento de Marketing.
- Janela recente do cliente continua respeitada pelo Modo Proteção da Conta.
- Limite operacional de iniciativas automáticas por hora.
- Abstração `messaging-provider` prepara futura troca do Baileys por provedor oficial sem reescrever CRM/IA.
- Centro visual de saúde, motivos de bloqueio e fila de aprovações.
- Smoke v7.4.30 e regressão das versões anteriores.

## v7.4.28 — core multissetorial

- O Alone.AI deixa de assumir academia/fitness como negócio padrão.
- Novo Perfil do negócio em Configurações, com presets e descrição livre.
- CRM, jornadas, memória, agenda, proatividade e aprendizado usam linguagem neutra.
- Orçamento, proposta, produto, serviço, compra, contratação, entrega e suporte passam a ser sinais nativos.
- Fitness permanece como preset opcional.
- Instalações antigas continuam compatíveis: IDs legados são preservados e exibidos com rótulos genéricos.
- Fluxos padrão antigos de academia são migrados somente quando ainda forem exatamente os defaults originais; edições humanas são preservadas.
- Smoke multissetorial v7.4.28 protege essa arquitetura contra regressão.

## v7.4.27 — memória viva por cliente e segurança comercial configurável

- Memória persistente e estruturada por cliente, separada do histórico bruto.
- Preserva fatos fixados e notas manuais contra perfilamento automático.
- Registra marcos de jornada, cancelamento, pós-cancelamento e reativação.
- O prompt do agente recebe a memória resumida do cliente, reduzindo dependência de histórico longo.
- Nova edição da memória diretamente na conversa.
- Limite de iniciativas automáticas por cliente configurável (padrão: 10 em 7 dias). Respostas normais não contam.
- Proatividade passa a vir desligada por padrão em instalações novas.


- Corrigido bug em que campos vazios/invalidáveis podiam virar `00:00` após salvar.
- Frontend valida cada faixa antes de enviar e nunca converte campo vazio silenciosamente para zero.
- Backend rejeita agenda inválida de forma transacional, preservando a configuração anterior.
- Depois de salvar, a interface relê a configuração persistida e confirma que o horário salvo é o mesmo devolvido pelo servidor.
- `24:00` deixa de ser escrito em `<input type="time">`; o frontend trata o limite de fim de dia sem gerar campo inválido.
- Novo `smoke-test-v7425.js` valida salvar, recarregar e preservar a agenda anterior em caso de erro.

## v7.4.24 — CRM sincronizado quase em tempo real

- Adicionado canal SSE autenticado para atualizar CRM, Inbox, Gestão e lista de Conversas assim que o backend muda.
- Mensagens recebidas atualizam imediatamente sinais determinísticos do CRM: intenção, interesse, próxima ação, score, temperatura, status e jornada quando há evidência clara.
- Mensagens enviadas atualizam imediatamente a próxima ação para `Aguardar resposta do cliente`.
- Gemini continua refinando perfil, necessidades, objeções e resumo depois, sem bloquear o acompanhamento operacional.
- Frontend usa debounce de 180 ms para agrupar eventos consecutivos e evitar redesenhos excessivos.
- Polling de 3 s permanece apenas como fallback quando o stream em tempo real estiver indisponível.
- Novo `smoke-test-v7424.js` valida sinais instantâneos, eventos e refinamento posterior pela IA.

## v7.4.23 — Proatividade validada ponta a ponta

- Corrigido retry proativo para consumir a tentativa após entrega posterior.
- Adicionado E2E permanente da proatividade, segmentos de Gestão e filtros do Inbox.
- Mantido o Minimal Wide / Obsidian Dark Orange da v7.4.22.

## v7.4.22 — Minimal Wide / Obsidian Dark Orange

Reformulação visual desktop-first para operação diária em telas wide. A navegação foi reduzida a seis áreas principais, o conteúdo passou a usar melhor 1440–1920 px e a identidade do software foi padronizada em Obsidian Dark Orange.

### Destaques
- Sidebar fixa: Visão, Inbox, CRM, Respostas, Comercial e Configurações.
- Conversas, Inteligência, Equipe e Conexão permanecem acessíveis como subitens.
- Topbar compacta com busca, WhatsApp, usuário e saída.
- Central de Respostas master-detail mais ampla e densa.
- Botões, inputs, tabelas, cards e filtros padronizados.
- Conhecimento `learned` não alimenta mais fatos até revisão humana.
- Proatividade usa contexto recente e preserva intervalo global após reinício.
- Novo smoke test v7.4.22.

## v7.4.21 — Central de Respostas segura e campanhas estabilizadas

Nesta versão, respostas aprendidas do histórico não são mais tratadas como verdade pronta para envio. A aba Respostas foi reformulada em uma Central de Respostas com revisão, aprovação, arquivamento, validade, busca e edição completa. Campanhas também receberam correções para consentimento e ativação do processador ao iniciar.

### Destaques
- Aprendizado histórico entra como **Revisar**, nunca automático.
- Respostas aprovadas/editadas ficam protegidas como fonte humana.
- Fallback do Gemini não usa resposta histórica não aprovada.
- Validade temporal é aplicada no matching real.
- Central de Respostas com filtros, busca, estatísticas e editor simplificado.
- Botão **Auditar aprendizado antigo** para colocar históricos não revisados em pendência.
- Campanha iniciada ativa o processador global e sincroniza consentimento da lista confirmada.
- Teste v7.4.21 adicionado ao pipeline de build.

## v7.4.18 — Observabilidade, diagnóstico e proteção operacional

- Diagnóstico por conversa: mostra estado da IA, horário, regra reconhecida, retries, delay e conhecimentos relacionados.
- Observabilidade do aprendizado contínuo: execuções, falhas, duração, perfis atualizados, delta de conhecimento e histórico recente.
- Retry anti-duplicidade: se a mesma mensagem já foi enviada após a criação do retry, o job é encerrado sem repetir.
- Limpeza automática e manual de mídias órfãs da biblioteca de respostas.
- Mantém o Conhecimento Curado e validade temporal da v7.4.16.

## v7.4.16 — Conhecimento Curado e validade temporal

- A IA continua aprendendo com o WhatsApp, mas aprendizado automático não é mais tratado como verdade oficial.
- Base de Conhecimento ganhou status: Oficial, Revisado, Aprendido, Revisar e Expirado.
- Itens Revisar/Expirado não entram nas respostas.
- Edições humanas ficam protegidas contra reaprendizado automático.
- Campos de validade: válido desde, válido até e revisar após.
- Prioridade 0–100; Oficial > Revisado > Aprendido.
- Fatos operacionais no Gemini vêm exclusivamente da Base Curada; histórico bruto serve para estilo/contexto, evitando preço/plano antigo vazando.
- Ações rápidas: Oficializar, Expirar, Editar e Excluir.
- Aprendizado automático novo recebe revisão sugerida em 90 dias.

## v7.4.15 — respostas altamente editáveis + delay personalizável

A Biblioteca de Respostas agora permite editar matching, sensibilidade, prioridade, status, texto, mídia, PTT, cooldown e delay por resposta. A aba IA também possui delay geral mínimo/máximo para o agente. Edições humanas de respostas aprendidas permanecem protegidas contra reaprendizagem automática.


## v7.4.15 — respostas altamente editáveis + delay personalizável

- horário de atendimento calculado no fuso configurado da empresa, padrão `America/Sao_Paulo`;
- painel mostra hora operacional atual e se o agente considera dentro/fora do expediente;
- campo textual de horário virou resumo somente leitura para evitar salvar uma coisa e operar outra;
- campanhas usam o mesmo relógio operacional;
- Gemini 429 entra em cooldown por modelo e tenta fallback elegível sem esperar dezenas de segundos;
- Inteligência Comercial exibe diagnóstico local degradado quando a quota externa está esgotada;
- perfilamento de contato deixa de consumir uma chamada Gemini em toda mensagem comum;
- smoke específico valida timezone e fallback de quota.


## v7.4.6 — estabilidade operacional

- escolha manual de ligar/desligar a IA passa a prevalecer após reinício;
- classificação do contato termina antes de resposta autônoma;
- roteamento automático respeita função e setor;
- tarefas e agenda validam acesso ao contato;
- Inbox, CRM, busca, dashboard e alertas usam o mesmo escopo operacional;
- PIN padrão precisa ser trocado antes da operação;
- opt-out comercial exige intenção explícita;
- gravações locais são coalescidas para reduzir I/O redundante sem alterar o formato de dados existente.

# Alone.AI v7.2.6


## v7.2.6 — preparação bloqueada sem WhatsApp
- Sem WhatsApp conectado, preparação fica em 0% e não inicia worker.
- Botão manual fica bloqueado até a conexão estar realmente aberta.
- Histórico e Gemini só entram no fluxo depois da conexão WhatsApp.
- Corrigido worker fantasma (`runningPromise`) em saídas rápidas.
- Veja `AUDITORIA-V7.2.4.md`.


## v7.2.3 — equipe corrigida + preparação robusta

- **Equipe > Adicionar atendente** agora abre formulário completo com nome, função, PIN, cor e especialidades.
- A função é obrigatória e validada também no backend (`atendimento`, `comercial`, `financeiro` ou `gestor`).
- Preparação pós-QR passa a usar teto de **280 mensagens**, orçamento textual de ~62 mil caracteres e no máximo **10 contatos prioritários** no primeiro preparo.
- Chamadas do Gemini usadas no bootstrap operam em modo rápido, com timeout curto e uma tentativa por etapa; falha parcial não bloqueia todo o agente.
- Perfilamento inicial usa até 5 workers e no máximo 20 mensagens relevantes por contato.
- Existe orçamento global de ~95 s para o preparo inicial; ao atingir o limite, perfis restantes passam para aprendizado sob demanda.
- Consolidação da empresa possui fallback local caso a etapa final de agregação falhe depois de lotes válidos já terem sido analisados.
- Watchdog retoma automaticamente uma preparação interrompida se o WhatsApp estiver conectado e o processo tiver ficado sem worker ativo.
- A IA só entra em `pronto` após obter memória utilizável da empresa; perfis individuais podem continuar evoluindo depois.

Veja `AUDITORIA-V7.2.3.md`.

## v7.2.0 — Gemini atual, áudio/mídia e pós-QR mais rápido

- Modelo padrão atualizado para `gemini-3.8-flash`; configurações antigas em `gemini-2.5-flash` são migradas automaticamente.
- Fallback automático entre modelos Flash estáveis quando um modelo configurado retorna 404 por indisponibilidade.
- Geração de sugestão em streaming possui fallback para geração normal.
- Áudios recebidos são baixados e enviados ao Gemini para transcrição/entendimento; imagem, vídeo, PDF e documentos também entram no contexto quando suportados.
- Conversas agora permitem envio manual de imagem, áudio, vídeo e documento, com legenda e opção de áudio como mensagem de voz.
- Respostas rápidas permitem áudio pré-pronto como PTT/mensagem de voz.
- Mensagens multimodais recebidas durante a preparação pós-QR entram na fila de retomada após a IA ficar pronta.
- Preparação pós-QR otimizada com análise da empresa em até 2 workers e perfil de clientes em até 3 workers, priorizando contatos mais recentes.
- Debounce do histórico e fallback pós-conexão foram reduzidos para iniciar a preparação mais cedo, mantendo espera por lotes de sincronização.
- Painel de preparação usa progresso real informado pelo backend (fase, percentual e item atual).

## Inicializacao inteligente

O launcher agora detecta primeiro Node.js/npm e Git existentes no Windows. Se Node.js >= 18 e npm estiverem disponiveis, usa o runtime do sistema. Se Git estiver instalado, usa o Git do sistema. Somente componentes ausentes sao baixados em modo portatil.

# Alone.AI v7

Agente de IA operacional para WhatsApp com Gemini, CRM, memória empresarial, prospecção, equipe e automações.

## Abrir no Windows

1. Extraia o ZIP em uma pasta normal (não execute de dentro do ZIP).
2. Dê dois cliques em `INICIAR_ALONE.bat`.
3. No primeiro uso, o launcher conectado baixa um Node.js portátil e instala as dependências na própria pasta do Alone.
4. O navegador abre automaticamente em `http://127.0.0.1:3333`.
5. No primeiro acesso use **Gestor / PIN 123456** e troque esse PIN imediatamente na aba Equipe.
6. Configure uma chave Gemini nova em **Inteligência Artificial**, conecte o WhatsApp em **Configurações > Conexão** e acompanhe a preparação pós-QR.

Não é necessário instalar Node, npm, Git ou VS Code manualmente. Internet é necessária para a preparação inicial e para o funcionamento do WhatsApp/Gemini.

## Modos da IA

- **Observação:** lê, classifica e aprende, mas não envia respostas automáticas.
- **Assistido (padrão):** gera sugestões em streaming para o humano revisar e enviar.
- **Autônomo:** responde automaticamente dentro das regras, com intervenção humana quando necessário.

## Auditoria

Consulte `AUDITORIA-V7.md` para testes executados, recursos implementados e limites que dependem de WhatsApp/Gemini reais.

## Recuperação de acesso

Se o primeiro PIN não funcionar ou houver bloqueio por tentativas, feche o Alone e execute `RESETAR_ACESSO.bat`. O script preserva CRM, mensagens, configurações e WhatsApp; ele recria apenas o acesso local padrão `Gestor / 123456`.


## Conexão WhatsApp v7.0.8
- Sem sessão salva, o Alone inicia como **Desconectado**.
- O QR só é gerado ao clicar em **Conectar / Gerar QR**.
- **Desconectar WhatsApp** só aparece quando a conexão está realmente aberta.
- Depois de desconectar, a sessão é removida e não reconecta sozinha.


## v7.1.1 — Tutoriais guiados
- Popups contextuais na primeira entrada de cada área importante.
- Explicação curta de para que serve e como usar.
- Navegação Próximo/Voltar, Pular tutorial e checkbox “Não mostrar novamente este tutorial”.
- Preferência salva por instalação + usuário no navegador.
- Configurações > Ajuda e tutoriais permite rever o tutorial geral ou reativar todos.


## v7.1.1 — Respostas e automações

A área **Respostas** virou um construtor completo de regras. É possível personalizar gatilhos, condições, prioridade, comportamento com a IA, ações no CRM e uma sequência ordenada de mensagens/mídias com atrasos individuais. Há teste antes de salvar e importação/exportação JSON.

## CRM personalizável — v7.1.1

O CRM agora possui configuração global da equipe, editável somente pelo Gestor, e preferências individuais no Meu CRM. O Gestor pode criar/renomear/ordenar/desativar etapas, definir campos de card, campos personalizados e tags sugeridas. Cada atendente pode ajustar somente sua própria visualização.

Consulte `AUDITORIA-CRM-v7.1.1.md` para os testes executados.


## v7.2.0 — preparação pós-QR visível e retomada corrigida
- Painel vivo com estado ANALISANDO / PAUSADO / RETOMANDO / CONCLUÍDO / ERRO.
- Percentual numérico, barra de progresso, atividade atual e horário da última atualização.
- Mini histórico das mudanças recentes da preparação.
- Pausar preserva a etapa real em execução.
- Continuar restaura a etapa anterior e atualiza a tela imediatamente.
- Iniciar/refazer preparação agora é assíncrono: a API responde imediatamente e o painel acompanha o trabalho em tempo real.
- Botões mudam de disponibilidade conforme o estado para evitar comandos contraditórios.

## v7.2.1 — histórico e campanhas
A preparação pós-QR agora só conclui quando existe histórico utilizável para aprendizado. O painel separa contatos sincronizados de contatos com conversa e perfis concluídos. Em campanhas, clicar em Iniciar importa automaticamente números ainda digitados na caixa, preserva a fila e tenta o primeiro processamento imediatamente.

## v7.2.2 — preparação rápida + tutoriais persistentes
- Bootstrap pós-QR por amostragem inteligente, sem exigir 100% do histórico.
- Até 450 mensagens representativas para memória inicial da empresa.
- Até 24 contatos prioritários e 28 mensagens por contato no primeiro perfilamento.
- Restante dos contatos é aprendido sob demanda durante novas interações.
- Painel mostra amostra/disponíveis, perfis prioritários e contatos deferidos.
- “Não mostrar tutoriais automaticamente novamente” agora persiste por usuário mesmo entre versões/pastas.
- Veja `AUDITORIA-V7.2.2.md`.


## v7.2.6 — Conexão do WhatsApp
- Aba **Conexão** restaurada no menu lateral.
- Tela dedicada para status, QR Code, conectar/reconectar e desconectar.
- QR não depende mais de navegar até Configurações.
- Preparação continua bloqueada em 0% até o WhatsApp estar realmente conectado.

## v7.2.6 — Saúde + diagnóstico do bootstrap
- Saúde do sistema atualiza automaticamente na aba Gestão.
- Últimos erros do Gemini e preparação ficam visíveis no painel.
- Análise de lotes usa parser mais tolerante e fallback local se Gemini falhar parcialmente.
- Falha de um lote não derruba a preparação inteira.


## v7.2.9 — correção de runtime/build e auditoria Gemini
- Gemini principal mantido em `gemini-3.8-flash`; extração rápida em `gemini-3.5-flash-lite`.
- `gemini-2.5-flash` não é tratado como aposentado; permanece apenas como fallback legado quando a conta tiver acesso.
- Runtime local exige Node 22.13+; caso contrário o launcher usa Node portátil 22.16.0.
- Build EXE atualizado para target Node 22 e `@yao-pkg/pkg` 6.22.0.
- `node:sqlite` carregado dinamicamente para não quebrar o bundler, mantendo fallback JSON se SQLite não estiver disponível.

## v7.2.9 — estabilidade pós-preparação
- Agente não pode ficar `pronto` sem memória operacional persistida.
- Eventos assíncronos do WhatsApp são isolados para não derrubar o backend por rejection não tratada.
- Saúde detecta inconsistência de memória e mostra qualidade do bootstrap.
- Inteligência comercial usa amostra recente limitada.
- Em erro de rede, consulte `logs/server-error.log` e `logs/server-out.log`.


## v7.3.0 — Preparação operacional automática
A preparação pós-QR agora aprende o histórico e configura automaticamente regras de resposta (gatilhos + mensagens), respostas rápidas e roteamento/status quando houver evidência suficiente. Reexecuções não duplicam automações, e edições manuais feitas pelo gestor são preservadas. Consulte `AUDITORIA-V7.3.0.md`.


## v7.4.1 — agente generativo integrado

- O atendimento automático padrão é **generativo**: intenções aprendidas do histórico servem como contexto para o Gemini, não como scripts fixos.
- Respostas históricas são exemplos de linguagem e evidência operacional; o agente escreve cada resposta para a conversa atual.
- A preparação pós-QR materializa memória, Base de Conhecimento, lacunas, intenções, CRM inicial, Inbox e rascunhos seguros de prospecção antes de considerar o agente pronto.
- Queda/reconexão temporária do WhatsApp preserva o treinamento e a memória já consolidada.
- Conversas carregam apenas a janela recente na interface para evitar travamentos; o histórico completo permanece no banco.
- O modo padrão de fábrica é **Autônomo**. Observação e Assistido continuam disponíveis.
- Instalação usa `npm ci` com `package-lock.json` para dependências reproduzíveis.

## v7.4.6 — integração operacional pós-QR

A preparação automática agora materializa o aprendizado do WhatsApp nos módulos operacionais: Base de Conhecimento, lacunas, CRM, Inbox, Conversas, automações, respostas rápidas e rascunhos de prospecção. Automações aprendidas exibem contexto e exemplos reais no editor, mas continuam usando resposta generativa do Gemini. O treinamento é preservado durante quedas temporárias do WhatsApp.

## v7.4.9 — respostas mais humanas e precisas
As intenções aprendidas do WhatsApp agora usam matching inteligente com variações, sinônimos, abreviações e pequenos erros de escrita. O agente usa exemplos reais como referência de estilo, sem copiar scripts, e respostas humanas/correções passam a alimentar a memória adaptativa para melhorar as próximas respostas.


## v7.4.21 — Proatividade e segmentos operacionais
- Cards da Gestão agora são clicáveis e abrem os contatos daquele segmento.
- Cards do Inbox agora filtram a caixa correspondente e permitem voltar para todas.
- Proatividade comercial configurável por cenário: planos sem resposta, lead quente em silêncio, fechamento sem resposta e ação manual em “aguardando cliente”.
- Mensagens, silêncio mínimo, score, tentativas e intervalo entre tentativas são editáveis.
- O ciclo proativo é cancelado assim que o cliente responde.
- Respeita opt-out, horário comercial, handoff humano, limite diário e espaçamento global.
## v7.4.29 — Proteção da conta WhatsApp
Após relatos de restrição, o Alone.AI passou a ter um Modo Proteção da Conta em Campanhas/Prospecção. O padrão é **Estrita**: campanhas, proatividade e jornada automáticas ficam bloqueadas, preservando respostas a conversas recentes e atendimento manual. O modo **Equilibrado** permite follow-ups contextuais apenas dentro da janela recente configurada, mantendo campanhas bloqueadas. O modo **Desativado** remove essa camada adicional e mantém apenas as regras normais de consentimento, opt-out, horário e limites.
