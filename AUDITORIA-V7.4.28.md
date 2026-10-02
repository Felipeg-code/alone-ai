# Auditoria Alone.AI v7.4.28 — core multissetorial

## Objetivo
Remover o acoplamento operacional do Alone.AI a academias/fitness sem quebrar instalações e dados existentes.

## Implementado
- Perfil de negócio configurável: Geral, Serviços, Varejo, Saúde/Clínica, Fitness, Educação, Profissional/Consultoria, Hospitalidade/Alimentação e Outro.
- Descrição livre da operação para orientar Gemini, CRM e aprendizado.
- CRM exibido com nomenclatura genérica: Apresentação da oferta, Fechamento/conversão, Agendamento, Pós-atendimento e Início/onboarding.
- IDs legados de jornada foram preservados internamente para compatibilidade com dados antigos.
- Tipos de cliente novos: lead, cliente, ex_cliente, responsável, fornecedor, parceiro e não identificado.
- Migração automática de `aluno` -> `cliente` e `ex_aluno` -> `ex_cliente`.
- CRM instantâneo ampliado para reconhecer orçamento, proposta, produto, serviço, contratação, compra, agendamento, entrega e suporte.
- Proatividade comercial deixa de depender de termos de academia e reconhece preço/oferta/serviço/proposta.
- Aprendizado histórico ampliado para sinais multissetoriais.
- Fluxos padrão do pacote foram reescritos de forma neutra, sem endereço fixo, academia, treino ou mensalidade como pressuposto.
- Migração conservadora dos antigos fluxos padrão: só textos/rótulos exatamente iguais aos defaults antigos são convertidos; edições humanas são preservadas.
- Jornadas e automações padrão receberam textos neutros para agendamento, onboarding, acompanhamento e reativação.
- Agenda passou a oferecer Consulta/atendimento, Demonstração/visita, Retorno, Reunião, Entrega/retirada e Geral.
- Memória do cliente usa “oferta/produto/serviço” na interface, mantendo campo interno legado por compatibilidade.

## Compatibilidade
Os IDs internos `apresentacao_plano`, `agendamento_avaliacao`, `pos_avaliacao` e `primeiro_treino` continuam existindo por compatibilidade. Na interface e no prompt eles são interpretados genericamente. Isso evita migração destrutiva do CRM.

## Testes
- Sintaxe de todos os arquivos JS: OK.
- HTML sem IDs duplicados: OK (247 IDs).
- Smoke v7.4.28 multissetorial: OK.
- Smoke v7.4.27 memória viva: OK.
- Smoke campanha específica v7.4.27: OK.
- E2E proatividade v7.4.23: OK.
- Smoke CRM tempo real v7.4.24: OK.
- Regressão completa das suítes históricas: OK.

## Limites conhecidos
- Alguns nomes de IDs internos continuam com nomenclatura histórica por compatibilidade; não aparecem como linguagem principal ao usuário.
- O banco continua usando snapshot de estado em SQLite/JSON; a migração relacional segue recomendada para v7.5.
