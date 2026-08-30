## Contexto

O repositório contém apenas o enunciado e a configuração inicial do OpenSpec. O serviço precisa ser construído com Bun, NestJS, MikroORM, PostgreSQL e SQS, mantendo correção financeira quando requisições e mensagens são duplicadas, concorrentes, entregues fora de ordem ou interrompidas por encerramento abrupto. O README é o contrato autoritativo; o glossário canônico está em `GLOSSARY.md` e as decisões aprovadas estão em `docs/adr`.

## Objetivos e itens fora do escopo principal

**Objetivos:**

- Implementar todos os comportamentos obrigatórios dos §§5–13 do README.
- Garantir dinheiro exato, saldo não negativo, Ledger auditável e reconciliação.
- Manter idempotência e concorrência corretas com pelo menos três processos.
- Tornar HTTP e SQS adaptadores da mesma interface profunda de processamento.
- Provar cada garantia por restrição PostgreSQL e/ou teste executável.
- Entregar configuração reproduzível, observabilidade e documentação suficiente para operação e entrevista.

**Fora do escopo principal:**

- Autenticação real, usuários locais ou emissão própria de JWT.
- Ledger de partidas dobradas, OpenTelemetry, painel e teste de carga.
- Suporte operacional a moedas além de BRL, embora o modelo preserve a moeda.
- Garantia de processamento exatamente uma vez no agente de mensagens; duplicatas são esperadas e tratadas.

## Decisões

### Módulos e interfaces

O código será organizado por funcionalidade (`wallets`, `wagering`, `messaging`, `health`, `auth`, `observability`) com tipos compartilhados em `domain` e persistência em `infrastructure`. O módulo profundo `ProcessWager` expõe uma única interface para HTTP e SQS e esconde idempotência, transação, bloqueio, Ledger, Inbox e Outbox. Não haverá portas de repositório com uma única implementação; os módulos de aplicação usam o `EntityManager` transacional e são testados com PostgreSQL real.

`Money` permanece sem importações de framework ou ORM. Entidades podem carregar apenas decoradores de persistência MikroORM sobre strings mapeadas para `NUMERIC(18,2)`, conforme [ADR-0004](../../../docs/adr/0004-keep-money-pure-at-the-mikroorm-seam.md).

### Fluxo da transação financeira

```text
Controlador HTTP ─┐
                  ├─ validação ─ ProcessWager.execute(command, context)
Consumidor SQS ───┘                    │
                                       ▼
                          PostgreSQL READ COMMITTED
                          1. disputar idempotência/Inbox
                          2. aplicar FOR UPDATE na Wallet quando o saldo puder mudar
                          3. aplicar a transição de domínio
                          4. persistir Wallet + Ledger + resposta + Outbox
                          5. marcar a Inbox como processada
                                       │
                                       ▼ confirmação
                          Resposta HTTP ou confirmação SQS
```

Uma inserção sujeita a `UNIQUE`, nunca uma consulta prévia, arbitra a idempotência. Uma violação nomeada de `uq_wager_idempotency_key` é tratada fora da transação abortada: hash JCS/SHA-256 igual reproduz `response_payload`; hash diferente produz `IDEMPOTENCY_CONFLICT`. Operações distintas que alteram a mesma Wallet são serializadas por `FOR UPDATE`; Wallets distintas continuam paralelas. `LOSS` não adquire bloqueio porque não altera saldo ou Ledger. A estratégia completa está em [ADR-0002](../../../docs/adr/0002-coordinate-wallet-writes-in-postgresql.md).

### Garantias impostas pelo PostgreSQL

| Garantia | Aplicação no esquema | Evidência executável |
|---|---|---|
| Dinheiro exato | `NUMERIC(18,2)` e strings decimais | Testes de Money e de ida e volta na integração |
| Saldo não negativo | `CHECK (balance_amount >= 0)` | Teste da restrição e de apostas concorrentes |
| Uma Wallet por jogador e moeda | `UNIQUE (player_id, currency)` | Teste de criação duplicada |
| Aritmética do Ledger | `CHECK` de débito/crédito sobre saldo anterior, valor e saldo posterior | Teste de inserção inválida e reconciliação |
| No máximo uma entrada por transação e Wallet | `UNIQUE (transaction_id, wallet_id)` | Teste de idempotência com 50 envios |
| Ledger imutável | Gatilho rejeita `UPDATE` e `DELETE` | Teste de mutação na integração |
| Identidade do provedor e idempotência | Restrições nomeadas de unicidade | Testes de reprodução e conflito de conteúdo |
| Uma reversão por referência e tipo | Índices únicos parciais | Testes de reversões concorrentes |
| Deduplicação da Inbox | Chave primária `(consumer_name, message_id)` | Teste de reentrega |
| Publicação concorrente da Outbox | Índice parcial de vencimento e `SKIP LOCKED` | Teste com dois publicadores |

`wager_transactions` também armazena `payload_hash`, `response_payload`, código de falha, contador de tentativas da referência e instante da próxima tentativa. A versão começa em 1 e incrementa somente quando o saldo da Wallet muda.

### Resultados HTTP

Processamento bem-sucedido, rejeição de negócio e reprodução usam `200`; a criação de Wallet usa `201`; referência pendente usa `202`; recursos ausentes usam `404`; Wallet duplicada usa `409`; entrada malformada e conflitos de idempotência usam `422` com códigos distintos legíveis por máquina; falhas transitórias de infraestrutura usam `503`. Isso segue a [ADR-0006](../../../docs/adr/0006-distinguish-business-outcomes-from-errors.md).

A paginação do Ledger usa um cursor Base64URL contendo `{createdAt,id}`, limite padrão 50 e máximo 100. A reconciliação calcula o total do Ledger com `NUMERIC` do PostgreSQL, informa qualquer diferença e nunca altera o estado financeiro.

### Mensageria confiável

A fila de comandos recebe no máximo dez mensagens por sondagem longa de 20 segundos, com tempo de visibilidade configurável cujo padrão é 60 segundos. As mensagens são agrupadas por `walletId`; os grupos executam concorrentemente, enquanto mensagens de um mesmo grupo permanecem sequenciais. Resultados de negócio e duplicatas idênticas são confirmados depois da confirmação da transação. Mensagens inválidas ou conflitantes permanecem sem confirmação para serem redirecionadas à DLQ, e falhas transitórias de infraestrutura permanecem sem confirmação para nova tentativa.

O publicador da Outbox bloqueia e publica uma linha vencida por transação com `FOR UPDATE SKIP LOCKED`, continuando imediatamente enquanto houver trabalho e aguardando um segundo quando não houver. A publicação no SQS ocorre enquanto a linha está bloqueada; um envio bem-sucedido seguido de falha na confirmação da transação pode duplicar um evento, portanto `eventId`, Inbox e idempotência do consumidor continuam obrigatórios. As filas de comandos e eventos são separadas conforme descrito na [ADR-0005](../../../docs/adr/0005-separate-command-and-event-queues.md).

Os processadores de referências pendentes também selecionam uma linha vencida com `FOR UPDATE SKIP LOCKED` e depois adquirem o bloqueio da Wallet referenciada antes da reavaliação. Eles usam espera exponencial configurável, com padrões de oito tentativas, base de um segundo e teto de sessenta segundos. O esgotamento persiste `REJECTED/REFERENCE_NOT_FOUND` e seu evento na Outbox. A consistência transacional segue a [ADR-0003](../../../docs/adr/0003-use-a-transactional-inbox-and-outbox.md).

### Execução e verificação

O Bun carrega variáveis de ambiente, e um único `env.ts` valida os valores obrigatórios antes de o NestJS iniciar. `enableShutdownHooks()` interrompe as sondagens, aguarda o trabalho em andamento e fecha os clientes. `nestjs-pino` emite JSON usando uma lista segura de campos permitidos; `prom-client` expõe as sete métricas obrigatórias.

Os testes distribuídos iniciam três processos do sistema operacional nas portas 3101–3103, com PIDs, contêineres Nest e conjuntos de conexões distintos, compartilhando apenas PostgreSQL e SQS. As requisições são liberadas juntas com `Promise.all`, distribuídas por todas as portas e verificadas pelo estado final persistido. Uma injeção determinística de falha encerra um processo dedicado de teste depois da confirmação no banco e antes da confirmação no SQS; nenhuma requisição de produção pode ativá-la.

A autenticação segue a [ADR-0001](../../../docs/adr/0001-defer-authentication-to-an-external-idp.md): um guard sem efeito e `ProviderIdentityPort` preservam o ponto de extensão para OIDC externo sem implementar credenciais.

## Riscos e contrapartidas

- **Latência em Wallet disputada** → as operações de uma Wallet são serializadas deliberadamente; as métricas expõem a contenção de bloqueio e Wallets diferentes permanecem independentes.
- **Chamada SQS mantendo o bloqueio de uma linha da Outbox** → transações de uma linha, tempo limite controlado do SDK e agendamento de novas tentativas limitam o impacto; concessões temporárias de posse ficam adiadas até que a vazão medida as exija.
- **Publicação duplicada após sucesso no agente de mensagens e falha no banco** → `eventId` estável, deduplicação FIFO como otimização e idempotência obrigatória no consumidor.
- **Valores padrão de novas tentativas não representam um acordo de nível de serviço do provedor** → os valores são configurações validadas e documentadas para calibração em produção.
- **Suíte de integração mais lenta que testes com simulações** → a infraestrutura permanece em execução, o estado é reiniciado deterministicamente e os testes unitários cobrem o comportamento puro do domínio.
- **Variação de compatibilidade do LocalStack** → fixar a versão 3.8.1 e validar as filas durante a prontidão.

## Plano de migração

1. Inicializar o ambiente de execução, a configuração, os serviços do Compose e as filas.
2. Aplicar e reverter `Migration001` em um banco PostgreSQL limpo.
3. Entregar, nessa ordem, as fatias de domínio, Wallet, apostas, reversões, Inbox/consumidor, Outbox e operação.
4. Executar todos os cenários unitários, de integração e com três processos depois de cada fatia afetada.
5. Construir a imagem da aplicação, iniciar o ambiente completo do Compose e executar o procedimento documentado para um clone limpo.

A reversão usa `migration:down` para o estado do esquema, além da reversão normal no Git da fatia verde atual. Migrations financeiras nunca são editadas depois de aplicadas; uma nova migration corrige alterações posteriores no esquema.

## Questões em aberto

Nenhuma. Todas as decisões que afetam a implementação foram aprovadas antes deste artefato.
