# Arquitetura

Este documento consolida decisões, invariantes e riscos do processador de apostas distribuído. Complementa o README e referencia os registros de decisão em `docs/adr`.

## Visão geral

O serviço expõe uma API HTTP e consome SQS com o mesmo núcleo de processamento. Cada alteração financeira é transacional e envolve wallet, ledger, transação de aposta e outbox. Inbox garante deduplicação de mensagens. Três instâncias operam em paralelo sobre o mesmo banco e as mesmas filas.

```
HTTP ──┐
       ├─> validação ─> ProcessWager.execute ─> PostgreSQL READ COMMITTED ─> resposta ou ack SQS
SQS  ──┘                    │
                            ├─ disputa de idempotência por UNIQUE
                            ├─ bloqueio da wallet com FOR UPDATE quando afeta saldo
                            ├─ transição de domínio
                            └─ persistência de wallet, ledger, payload de resposta e outbox
```

## Módulos

* `domain` tipos compartilhados e entidades com construtor privado e factories de criação e de reidratação
* `wallets` ciclo de vida de carteira e ledger imutável
* `wagering` orquestração de aposta e reversões e worker de referência pendente
* `messaging` consumidor SQS, inbox, outbox e encerramento coordenado
* `health` liveness e readiness
* `auth` guard sem efeito e porta de identidade do provedor
* `observability` logs e métricas
* `infrastructure` persistência com MikroORM

O módulo profundo `ProcessWager` expõe uma única operação e oculta idempotência, transação, bloqueio, ledger, inbox e outbox. Não há portas de repositório com uma única implementação. O `EntityManager` transacional é usado diretamente e testado com banco real. A entidade `Money` permanece livre de dependência de framework conforme ADR 0004.

## Decisões principais

| Tema | Decisão | Registro |
| --- | --- | --- |
| Identificadores | PostgreSQL 18 com `uuidv7` nativo e tipo `uuid` com localidade temporal | ADR 0002 e `design.md` |
| Concorrência | `FOR UPDATE` por wallet com `NOWAIT` e retentativa limitada, sem lock global, `LOSS` sem bloqueio | ADR 0002 |
| Inbox e outbox | Transação única para inbox, efeito financeiro, ledger e outbox | ADR 0003 |
| Contas e eventos | Filas distintas para comandos e eventos | ADR 0005 |
| Dinheiro | `Money` puro com `NUMERIC 18 2` e strings decimais | ADR 0004 |
| HTTP | 200 para sucesso e rejeição de negócio, 201 para criação, 202 para pendente, 404 para ausente, 409 para duplicata de wallet, 422 para payload inválido e conflito de idempotência, 503 para falha transitória | ADR 0006 |
| Autenticação | Guard sem efeito e `ProviderIdentityPort` para OIDC externo, sem tabela local de credenciais | ADR 0001 |

## Garantias impostas pelo banco

| Garantia | Recurso no esquema | Evidência |
| --- | --- | --- |
| Valor exato | `NUMERIC 18 2` e strings decimais | testes de `Money` e integração |
| Saldo não negativo | `CHECK balance_amount >= 0` | teste de restrição e concorrência |
| Uma carteira por jogador e moeda | `UNIQUE player_id currency` | teste de criação concorrente |
| Aritmética do ledger | `CHECK` de débito e crédito entre saldo anterior, valor e saldo posterior | teste de inserção inválida e reconciliação |
| Uma entrada por transação e carteira | `UNIQUE transaction_id wallet_id` | teste de idempotência com 50 envios |
| Ledger imutável | gatilho que rejeita `UPDATE` e `DELETE` | teste de mutação |
| Idempotência e identidade do provedor | restrições únicas nomeadas | testes de replay e conflito |
| Uma reversão por referência e tipo | índices únicos parciais | testes de reversão concorrente |
| Deduplicação de inbox | chave primária `consumer_name message_id` | teste de reentrega |
| Publicação concorrente de outbox | índice parcial e `SKIP LOCKED` | teste com dois publicadores |

A versão da carteira inicia em 1 e avança somente quando o saldo muda. A tabela de aposta armazena hash do payload, payload de resposta, código de falha, contador de tentativas e próximo instante de tentativa.

## Processamento e mensageria

### Ingestão idempotente

Inserção sujeita a `UNIQUE` decide idempotência. Violação de `uq_wager_idempotency_key` é tratada fora da transação abortada. Hash com JSON canônico ordenado conforme RFC 8785 e SHA 256. Hash igual reproduz payload de resposta. Hash diferente retorna `IDEMPOTENCY_CONFLICT`.

### Concorrência por carteira

Operações que alteram saldo disputam a linha da carteira com `FOR UPDATE`. Carteiras distintas permanecem independentes. Nenhum lock em memória garante correção.

### Consumidor SQS

Lote de até dez mensagens, sondagem longa de vinte segundos e visibilidade de sessenta segundos configurável. Agrupamento por `walletId` com paralelismo entre grupos e ordem dentro do grupo. Resultado de negócio e duplicata idêntica recebem ack após commit. Entrada inválida permanece sem ack para DLQ após cinco recebimentos. Falha transitória permanece sem ack para retentativa.

### Outbox

Seleção de uma linha vencida por transação com `FOR UPDATE SKIP LOCKED`, publicação com lock mantido e marcação de sucesso ou reprogramação. `eventId` estável, deduplicação FIFO como otimização e ciclo imediato quando há trabalho com espera de um segundo quando vazio. Publicação com sucesso seguida de falha de confirmação pode duplicar evento, por isso `eventId`, inbox e idempotência permanecem obrigatórios.

### Referência pendente

Seleção com `SKIP LOCKED` e lock da carteira referenciada antes de reavaliar. Espera exponencial com oito tentativas, base de um segundo e teto de sessenta segundos. Esgotamento persiste `REJECTED REFERENCE_NOT_FOUND` e evento na outbox.

### Encerramento

`registerShutdownHandlers` interrompe sondagens, aguarda trabalho em curso dentro de `SHUTDOWN_TIMEOUT_MS`, redefine visibilidade quando necessário e fecha clientes SQS e MikroORM.

## Contratos HTTP

* Criar carteira `POST /wallets` com `playerId` e `initialBalance` com `amount` e `currency`. Resposta 201 com `id`, `playerId`, `balance` e `version`. Saldo inicial positivo gera `OPENING` e `CREDIT` na mesma transação. Duplicata retorna 409.
* Consultar carteira `GET /wallets/:walletId` retorna carteira ou 404.
* Ledger `GET /wallets/:walletId/ledger` com cursor opaco `Base64URL {createdAt id}` e paginação 50 até 100.
* Submeter aposta `POST /wagering/transactions` com cabeçalho obrigatório `Idempotency-Key` e corpo com `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind` e `money`. Resposta com `transactionId`, `status`, `balance` e `idempotentReplay`. Campo desconhecido retorna 422.
* Consultar transação `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
* Reconciliação `POST /wallets/:walletId/reconciliation` compara saldo armazenado e reconstruído com `NUMERIC` no banco, reporta diferença e quantidade de entradas, registra log e métrica em caso de divergência e nunca corrige.
* Health `GET /health/live` e `GET /health/ready` sem autenticação. Readiness valida banco e filas.
* Métricas `GET /metrics` em formato Prometheus.

Paginação de ledger usa cursor estável ordenado por chave. Reconciliação nunca corrige divergência.

## Observabilidade

Logs em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro completo, com `nestjs-pino` e whitelist de campos. Métricas obrigatórias em `prom-client`:

* `wallet_reconciliation_divergences_total`
* `consumer_inbox_received_total` com rótulo `outcome`
* `consumer_dlq_depth`
* `consumer_processing_seconds`
* `outbox_lag_seconds`
* `wallet_lock_conflicts_total`
* `outbox_publish_failures_total` com rótulo `reason`

## Verificação

### Comandos

```bash
cp .env.example .env
docker compose up -d
docker compose ps
curl -s http://localhost:3101/health/ready
bun run typecheck
bun run build
bun run test
bun run test:distributed
bun run migrate up
bun run migrate down
bun run migrate up
```

Stack validada em compose com `postgres:18-alpine` e `localstack:3.8.1`. Filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` com deduplicação por conteúdo. Verificação de `uuidv7` na prontidão.

### Evidência atual

* Build de imagem com `Dockerfile` multi estágio e `oven/bun:1.4.0`
* `migrate up` aplica 001 a 004, `down` reverte 004, `up` reaplica 004
* `typecheck` sem erro e `build` gera `dist`
* `bun run test` com 170 testes aprovados em 33 arquivos em 82 segundos, incluindo suíte distribuída com três instâncias em 3101 a 3103
* `health/ready` com 200 nas três portas e `queues` com criação confirmada

## Mapeamento de requisitos e provas

### Domínio financeiro

| Requisito | Prova |
| --- | --- |
| Dinheiro exato e imutável | `src/domain/money.spec.ts` e integração de ida e volta |
| Invariantes de carteira | `src/domain/wallet.spec.ts` e `tests/integration/wallets.spec.ts` |
| Entrada de ledger auditável | `src/domain/ledger-entry.spec.ts` e `tests/integration/ledger.spec.ts` |
| Máquina de estados de transação | `src/domain/wager-transaction.spec.ts` e `tests/integration/wagering.spec.ts` |
| Construção controlada do domínio | factories de criação e `rehydrate` nos testes de domínio |
| Eventos tipados | `src/domain/events/events.spec.ts` e `src/messaging/outbox-publisher.spec.ts` |

### Ciclo de vida da carteira

| Requisito | Prova |
| --- | --- |
| Criação atômica com `OPENING` | `tests/integration/wallets.spec.ts` e `src/wallets/wallet-http.spec.ts` |
| Consulta de carteira | `tests/integration/wallets.spec.ts` |
| Paginação de ledger com cursor estável | `src/wallets/ledger.repository.spec.ts` e `tests/integration/ledger.spec.ts` |
| Reconciliação sem correção | `tests/integration/wallets.spec.ts` com divergência preparada e métrica `wallet_reconciliation_divergences_total` |

### Processamento de aposta

| Requisito | Prova |
| --- | --- |
| Validação de contrato e `Idempotency-Key` | `src/config/env.spec.ts`, `src/domain/canonical-json.spec.ts`, `src/wagering/task3-contract.spec.ts` |
| Idempotência por `UNIQUE` e hash RFC 8785 | `src/domain/canonical-json.spec.ts` e `tests/integration/wagering.spec.ts` com replay e conflito |
| Serialização por carteira | `src/wagering/process-wager-lock.spec.ts` e cenário de duas apostas de 80 em saldo 100 |
| Regras de `BET WIN LOSS` | `tests/integration/wagering.spec.ts` e `tests/integration/reversals.spec.ts` |
| Reversões integrais com escopo e valor | `tests/integration/reversals.spec.ts` com `REFUND` e `ROLLBACK` |
| Reversão duplicada concorrente | índice parcial e `tests/integration/reversals.spec.ts` |
| Consulta de transação | `tests/integration/wagering.spec.ts` por id interno e por provedor |
| Distinção de resultados e erros | `src/auth/financial-guards.spec.ts` e `tests/integration/wagering.spec.ts` com 200, 202 e 503 |

### Mensageria confiável

| Requisito | Prova |
| --- | --- |
| Consumo SQS com processador compartilhado | `tests/integration/command-consumer.spec.ts` e `src/messaging/command-consumer.spec.ts` |
| Deduplicação por inbox transacional | `tests/integration/migration-004.spec.ts` e `src/messaging/command-message-handler.spec.ts` |
| Classificação para ack e DLQ | `tests/integration/command-consumer.spec.ts` com DLQ após cinco recebimentos |
| Referência fora de ordem com backoff | `tests/integration/reversals.spec.ts` com `PENDING_REFERENCE` e worker |
| Publicação de outbox com `SKIP LOCKED` | `tests/integration/outbox-publisher.spec.ts` e `src/messaging/outbox-publisher.spec.ts` |
| Encerramento com `SIGTERM` | `src/messaging/consumer-shutdown.spec.ts` e `src/main.spec.ts` |

### Prontidão operacional

| Requisito | Prova |
| --- | --- |
| Validação de ambiente | `src/config/env.spec.ts` e erro de inicialização sem segredo |
| Liveness e readiness separados | `src/health/health.controller.spec.ts` com live 200 e ready 503 quando dependência cai |
| Logs estruturados e seguros | `src/observability/logger.module.spec.ts` com whitelist |
| Métricas obrigatórias | `src/observability/metrics.service.spec.ts` e `GET /metrics` |
| Encerramento coordenado | `src/messaging/consumer-shutdown.spec.ts` com drenagem e `SIGTERM` |
| Autenticação externa com guard sem efeito | `src/auth/noop-identity.guard.spec.ts` e `src/auth/financial-guards.spec.ts` |
| Execução com Bun e Compose | `Dockerfile`, `docker-compose.yml`, `scripts/readiness.spec.ts` e `scripts/migrate.ts` |

### Verificação distribuída

| Requisito | Prova |
| --- | --- |
| Comportamento financeiro puro sem infra | `bun test` com suíte unitária pura |
| Integração com banco e SQS reais | `tests/integration/mikro-orm.spec.ts` e `tests/integration/wagering.spec.ts` com estado reiniciado |
| Idempotência com 50 envios paralelos | `tests/distributed/three-instance.spec.ts` cenário de 50 duplicatas por três portas |
| Disputa de saldo com 100 e duas apostas de 80 | `tests/distributed/scenarios.ts` cenário obrigatório |
| Progresso independente de carteiras | mesmo cenário com carteiras distintas em paralelo |
| Três instâncias com pid e porta distintos | harness `tests/distributed/process-harness.ts` em 3101 a 3103 |
| Recuperação após commit e antes de ack | cenário com falha determinística entre commit e `DeleteMessage` |
| Publicação concorrente de outbox | `tests/integration/outbox-publisher.spec.ts` com dois publicadores e `SKIP LOCKED` |
| Reversão fora de ordem | `tests/distributed/scenarios.ts` com `REFUND` antes de `BET` |
| Consistência após reinício | cenário de reinício completo com invariante final |
| Invariante final `saldo == ledger` | `tests/distributed/invariant-queries.ts` em todo cenário financeiro |

## Riscos e compensações

* Latência em carteira disputada é intencional para preservar correção. Métrica de conflito expõe contenção e carteiras distintas permanecem independentes.
* Chamada SQS com lock de outbox mantido por tempo curto. Transação curta, timeout controlado e reprogramação limitam impacto. Concessão longa adiada até medição de vazão indicar necessidade.
* Duplicação após sucesso no broker e falha de confirmação no banco permanece possível. `eventId` estável, inbox e idempotência obrigatória mitigam.
* Valores de retentativa são configuráveis e documentados, sem acordo de nível de serviço fixo. Ajuste em produção conforme comportamento do provedor.
* Suíte de integração mais lenta que mocks é compensada por determinismo e cobertura real. Testes unitários isolam domínio puro.
* LocalStack fixado em 3.8.1 e validado na prontidão reduz variação de compatibilidade.

## Limitações conhecidas

* Uma moeda por carteira e validação focada em `BRL` nos testes, modelo permanece multi moeda.
* Sem double entry contábil completo. Ledger por carteira com `CREDIT` e `DEBIT` e reconciliação por carteira.
* Sem OpenTelemetry distribuído. Logs e métricas cobrem diagnóstico exigido.
* SQS FIFO usado como otimização, não como garantia final. Banco arbitra correção.

## Fora de escopo

Ledger de partidas dobradas, OpenTelemetry, painel e teste de carga permanecem fora desta entrega. Teste de carga somente com aprovação separada após requisitos obrigatórios verdes, conforme 10.5 do plano.
