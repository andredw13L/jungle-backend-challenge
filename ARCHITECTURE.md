# Arquitetura

Este documento consolida decisões, invariantes e riscos do processador de apostas distribuído. Complementa o README e referencia os registros de decisão em `docs/adr`.

## Visão geral

O serviço expõe uma API HTTP e consome SQS com o mesmo núcleo de processamento. Cada alteração financeira é transacional e envolve wallet, ledger, transação de aposta e outbox. Inbox garante deduplicação de mensagens. Três instâncias operam em paralelo sobre o mesmo banco e as mesmas filas.

```
HTTP ──┐
       ├─> validação ─> ProcessWager.execute ─> PostgreSQL READ COMMITTED ─> resposta ou ack SQS
SQS  ──┘                    │
                            ├─ disputa de idempotência por UNIQUE
                            ├─ bloqueio da wallet com FOR UPDATE (bloqueante) quando afeta saldo
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

O módulo profundo `ProcessWager` expõe uma única operação e oculta idempotência, transação, bloqueio, ledger, inbox e outbox. Não há portas de repositório com uma única implementação. O `EntityManager` transacional é usado diretamente e testado com banco real. A entidade `Money` permanece livre de dependência de framework conforme ADR 0004. Para dinheiro: `amount` sempre como string decimal com escala fixa **2**, validação rejeita `NaN`/`Infinity`/notação científica/string vazia/>2 casas/negativo em contrato de entrada; operações entre moedas distintas lançam erro de domínio; toda operação retorna nova instância imutável.

## Decisões principais

| Tema | Decisão | Registro |
| --- | --- | --- |
| Identificadores | PostgreSQL 18 com `uuidv7` nativo e tipo `uuid` com localidade temporal | ADR 0002 e `design.md` |
| Concorrência | `FOR UPDATE` bloqueante por wallet (sem `NOWAIT`, sem lock global), serializa carteira disputada; `LOSS` sem bloqueio | ADR 0002 |
| Inbox e outbox | Transação única para inbox, efeito financeiro, ledger e outbox | ADR 0003 |
| Contas e eventos | Filas distintas para comandos e eventos | ADR 0005 |
| Dinheiro | `Money` puro com `NUMERIC 18 2` e strings decimais, escala 2, imutável, sem tipo monetário do ORM | ADR 0004 |
| HTTP | 200 para sucesso e rejeição de negócio, 201 para criação, 202 para pendente, 404 para ausente, 409 para duplicata de wallet, 422 para payload inválido e conflito de idempotência, 503 para falha transitória | ADR 0006 |
| Autenticação | Guard sem efeito (`src/auth/noop-identity.guard.ts`) e `ProviderIdentityPort` para OIDC externo, sem tabela local de credenciais; health aberto, fila é canal interno confiável | ADR 0001 |
| Pool PostgreSQL | máximo de 10 conexões por processo para três instâncias + runner de testes compartilharem o limite padrão de 100 | `src/infrastructure/database/orm.module.ts` |

### Estados e códigos de falha

`PENDING` é o estado inicial (incluindo `BET`/`WIN`/`LOSS`); `PENDING_REFERENCE` é exclusivo de `REFUND`/`ROLLBACK` sem referência disponível; os estados terminais são `PROCESSED`, `REJECTED` e `FAILED` (`FAILED` reservado para erro permanente de infraestrutura, hoje não exercitado por `ProcessWager` — tabela permite o estado). Apenas a transição `PENDING → PROCESSED|REJECTED|FAILED|PENDING_REFERENCE` e `PENDING_REFERENCE → PROCESSED|REJECTED` são permitidas; estados terminais nunca mudam (constraint `ck_wager_terminal_*` exige `processed_at`). `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `REVERSAL_WOULD_OVERDRAW` e `INSUFFICIENT_FUNDS` são códigos estáveis de rejeição de negócio. `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS`, `INVALID_PAYLOAD` cobrem contrato. Falhas transitórias de infraestrutura são redeliveradas (HTTP 503/SQS sem ack); payload inválido e conflitos permanentes seguem a política de DLQ (5 recebimentos).

## Garantias impostas pelo banco

| Garantia | Recurso no esquema | Evidência |
| --- | --- | --- |
| Valor exato | `NUMERIC 18 2` e strings decimais, `ck_wager_amount_currency` | testes de `Money` e integração |
| Saldo não negativo | `CHECK balance_amount >= 0` + validação de domínio `InsufficientFundsError` | teste de restrição e concorrência (duas apostas de 80 em saldo 100) |
| Uma carteira por jogador e moeda | `UNIQUE player_id currency` | teste de criação concorrente |
| Aritmética do ledger | `CHECK` de débito (`after = before - value`) e crédito (`after = before + value`) + `ck_ledger_value_positive/currency/nonneg` | teste de inserção inválida e reconciliação |
| Uma entrada por transação e carteira | `UNIQUE transaction_id wallet_id` | teste de idempotência com 50 envios paralelos |
| Ledger imutável | gatilho `reject_ledger_mutation` que rejeita `UPDATE`/`DELETE` | teste de mutação |
| Idempotência e identidade do provedor | `uq_wager_idempotency_key`, `uq_wager_provider_external` únicas nomeadas | testes de replay e conflito |
| Uma reversão por referência e tipo | índice único parcial `uq_wager_reversal_reference_type WHERE type IN (REFUND,ROLLBACK)` | testes de reversão concorrente |
| Deduplicação de inbox | chave primária `consumer_name message_id` | teste de reentrega + `migration-004.spec.ts` |
| Publicação concorrente de outbox | índice parcial `idx_outbox_pending WHERE status=PENDING` e `FOR UPDATE SKIP LOCKED` | teste com dois publicadores |

A versão da carteira inicia em 1 e avança somente quando o saldo muda (via `applyWalletMutation` que faz `version = version + 1`). Saldo inicial zero gera wallet com `version=1` e sem `OPENING`/`CREDIT`. A tabela de aposta armazena `payload_hash` (SHA-256 de JSON canônico ordenado conforme RFC 8785), `response_payload`, `failure_code`, `reference_attempts` e `next_retry_at`.

## Processamento e mensageria

### Ingestão idempotente

Inserção sujeita a `UNIQUE` decide idempotência — nunca `SELECT` prévio. Violação de `uq_wager_idempotency_key` (23505) é tratada **fora** da transação abortada: carrega a linha vencedora em nova transação, compara `payload_hash`; hash igual reproduz `response_payload` com `idempotentReplay: true`, hash diferente retorna `IDEMPOTENCY_CONFLICT` (422). `uq_wager_provider_external` distinta mapeia para `EXTERNAL_TRANSACTION_CONFLICT`. Hash canônico (`canonicalize` ordena chaves em toda profundidade) + SHA-256 hex. Entrada HTTP exige header `Idempotency-Key` obrigatório (default sugerido `{providerId}:{externalTransactionId}`); fila usa `messageId` do envelope + `data.idempotencyKey`. Metadados de transporte não entram no hash.

### Concorrência por carteira

Operações que alteram saldo (`BET`/`WIN`/`REFUND`/`ROLLBACK`) disputam a linha da carteira com `FOR UPDATE` bloqueante dentro de `READ COMMITTED`. `LOSS` não adquire lock (sem efeito em saldo/ledger). Carteiras distintas permanecem independentes. Nenhum lock em memória (`No global lock`) garante correção — vide restrições invioláveis §5.6/5.7 do README. Wallet disputada serializa por espera no lock, deliberadamente em vez de tempestade de retry otimista (ADR 0002).

### Consumidor SQS

Lote de até `SQS_MAX_MESSAGES=10`, sondagem longa `SQS_WAIT_SECONDS=20` e visibilidade `SQS_VISIBILITY_SECONDS=60` configuráveis. Agrupamento por `walletId` (`walletKey()` extrai `data.walletId`; corpos não-parseáveis viram grupo singleton `__singleton__${MessageId}`) com paralelismo entre grupos e ordem dentro do grupo (`processGroup` sequencial). Resultado de negócio (`PROCESSED`/`REJECTED`) e duplicata idêntica (`claim.processed` ou `payloadHash` igual no replay) recebem `ack` (`DeleteMessage`) **após commit**. Entrada inválida (`parseMessageBody` falha) e `IDEMPOTENCY_CONFLICT` permanecem sem ack — contam para `RedrivePolicy maxReceiveCount=5` e vão para DLQ. Falha transitória (`WagerInfrastructureError` ou `40001/08000...` ou `ECONNRESET`) permanece sem ack para retentativa via visibility timeout. `processWager.execute(submit, em)` é o mesmo use case do HTTP, compartilhando a transação do `inbox`.

### Outbox

Seleção de uma linha vencida (`next_attempt_at <= now()` e `status=PENDING`) por transação com `FOR UPDATE SKIP LOCKED`, publicação com lock mantido e marcação de sucesso ou reprogramação. `eventId` estável (UUID v7), `MessageDeduplicationId = eventId` e `MessageGroupId = walletId → wagerTransactionId → aggregateId` com `ContentBasedDeduplication=true`; ciclo imediato quando há trabalho, espera `OUTBOX_POLL_INTERVAL_MS=1000` quando vazio (slice 8.2). Publicação bem-sucedida no broker seguida de falha de commit (ex.: conexão cai antes de `markPublished`) pode duplicar evento no SQS — por isso `eventId`, inbox e idempotência do consumidor permanecem obrigatórios; FIFO descarta duplicata em janela de 5 min via dedup id.

### Referência pendente

Seleção com `FOR UPDATE SKIP LOCKED` (`findPendingReferences`) e lock da carteira referenciada (`lockWalletById`) antes de reavaliar. Espera exponencial configurável `RETRY_MAX_ATTEMPTS=8`, base `RETRY_BASE_SECONDS=1` e teto `RETRY_MAX_SECONDS=60` (`delay = min(base * 2^(attempt-1), max)`). Cada linha carrega `reference_attempts` e `next_retry_at`. Esgotamento persiste `REJECTED REFERENCE_NOT_FOUND` (ou `WALLET_NOT_FOUND`) e evento `WagerTransactionPendingReference`/`Rejected` na outbox na mesma transação. Loop de worker (`pending-reference.worker.ts`) usa cadência de 1 s ocioso e registra `beginWork`/`endWork` no `ConsumerShutdown`.

### Encerramento

`registerShutdownHandlers` (em `src/main.ts`) escuta `SIGTERM`/`SIGINT` uma única vez: sinaliza `ConsumerShutdown`, aguarda `OutboxPublisher.waitForStopped()` e `PendingReferenceLoop.waitForStopped()` com `OUTBOX_SHUTDOWN_TIMEOUT_MS`, depois `drainAll(SHUTDOWN_TIMEOUT_MS=15000)` (espera `inflight===0`). Mensagens já recebidas mas ainda não commitadas permanecem sem `DeleteMessage` — o visibility timeout redelivera para outra instância; mensagens recebidas após sinal são descartadas sem ack. Fecha `SQSClient` e MikroORM via `onApplicationShutdown`.

## Contratos HTTP

* Criar carteira `POST /wallets` com `playerId` (UUID) e `initialBalance` com `amount` (string decimal escala 2) e `currency`. Resposta 201 com `id`, `playerId`, `balance` e `version`, `createdAt`/`updatedAt`. Saldo inicial positivo gera `OPENING` e `CREDIT` na mesma transação; zero não gera `OPENING`. Duplicata `playerId+currency` retorna 409 `WALLET_ALREADY_EXISTS`. Payload malformado 422.
* Consultar carteira `GET /wallets/:walletId` retorna carteira ou 404 `WALLET_NOT_FOUND`.
* Ledger `GET /wallets/:walletId/ledger?cursor=...&limit=50` com cursor opaco `Base64URL {createdAt id}` (ordenado por `created_at DESC, id DESC`) e paginação 50 até 100; cursor malformado 422 `INVALID_CURSOR`; wallet inexistente 404 antes de ler ledger.
* Submeter aposta `POST /wagering/transactions` com cabeçalho obrigatório `Idempotency-Key` e corpo com `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind` e `money`. Resposta 200 com `transactionId`, `status` (`PROCESSED`/`REJECTED`), `balance` e `idempotentReplay`; `PENDING_REFERENCE` retorna 202; falta de header 422 `IDEMPOTENCY_KEY_REQUIRED`; corpo inválido 422 `INVALID_PAYLOAD`; conflito de idempotência com payload distinto 422 `IDEMPOTENCY_CONFLICT`; falha transitória 503 `TRANSIENT_INFRASTRUCTURE`. Campo desconhecido (`strict` zod) retorna 422.
* Consultar transação `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`; ambas 404 se ausente.
* Reconciliação `POST /wallets/:walletId/reconciliation` compara saldo armazenado e reconstruído **via `NUMERIC` no banco** (`SUM(CASE direction...)`), reporta `storedBalance`/`calculatedBalance`/`difference`/`consistent`/`checkedEntries`, registra log `warn` e métrica `wallet_reconciliation_divergences_total` em caso de divergência e nunca corrige.
* Health `GET /health/live` (200 sempre) e `GET /health/ready` (200 apenas com PostgreSQL e três filas `GetQueueAttributes` alcançáveis, senão 503) sem autenticação (guard não aplicado a `HealthController`).
* Métricas `GET /metrics` em formato Prometheus.

## Observabilidade

Logs em JSON com `correlationId` (de `X-Correlation-Id` ou `messageId`), `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro completo, com `nestjs-pino` e whitelist de campos (`eventContext` extrai apenas ids). Métricas obrigatórias em `prom-client`:

* `wallet_reconciliation_divergences_total` — incrementada em `reconcile()` quando `consistent=false`
* `consumer_inbox_received_total{outcome}` — `processed|rejected|duplicate|permanent|retried` via `recordInboxReceived`
* `consumer_dlq_depth` — gauge atualizado a cada `pollOnce` via `GetQueueAttributes` da DLQ
* `consumer_processing_seconds` — histogram observado em `CommandMessageHandler.process` (per-message)
* `outbox_lag_seconds` — gauge `COALESCE(EXTRACT(EPOCH FROM now()-min(next_attempt_at)))` dos `PENDING`
* `wallet_lock_conflicts_total` — contador de `recordWalletLockConflict()` em deadlocks/serialization failures (`40P01/40001/55P03`, timeout)
* `outbox_publish_failures_total{reason}` — `network|throttle|permanent` via `classifySendError`

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

Stack validada em compose com `postgres:18-alpine` e `localstack:3.8.1`. Filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` com `FifoQueue=true` e `ContentBasedDeduplication=true`; `wager-transactions.fifo` com `RedrivePolicy { deadLetterTargetArn: wager-transactions-dlq.fifo, maxReceiveCount: 5 }`. Verificação de `uuidv7()` na prontidão (`scripts/readiness.ts`).

### Evidência atual (2026-08-31, isolado)

* `migrate up` aplica 001 a 004, `down` reverte 004 (`DROP COLUMN` de `body_hash` etc), `up` reaplica 004 — todas reversíveis
* `bun run typecheck` — sem erro; `bun run build` — gera `dist` (multi-stage `oven/bun:1.4.0`)
* `bun test --parallel=1 --max-concurrency=1 src` — **97 testes em 23 arquivos** (Money/Wallet/Ledger/WagerTransaction, contratos, guards)
* `tests/integration/*.spec.ts` em processos Bun separados por arquivo (evita `PG/SQS` compartilhado) — **66 testes**: `command-consumer 9/9`, `ledger 8`, `migration-004 1`, `mikro-orm 2`, `outbox-publisher 6`, `reversals 19`, `wagering 13`, `wallets 8` — todos verdes com `docker compose stop app-1 app-2 app-3` (instâncias consomem a mesma `wager-transactions.fifo`; para isolar, parar apps ou rodar integração contra DB/SQS dedicado)
* `bun run test:distributed` (`three-instance.spec.ts` 6 cenários) — **6/6** verdes em portas 3101–3103 com pool 10/conexão por processo (3101–3103 livres)
* `bun test --parallel=1 --max-concurrency=1 scripts` — readiness helpers

## Mapeamento de requisitos e provas

### Domínio financeiro

| Requisito | Prova |
| --- | --- |
| Dinheiro exato e imutável (escala 2, rejeita NaN/Infinity/científica) | `src/domain/money.spec.ts` e integração de ida e volta |
| Invariantes de carteira (saldo não-negativo, 1 por player+moeda) | `src/domain/wallet.spec.ts` e `tests/integration/wallets.spec.ts` |
| Entrada de ledger auditável, imutável, aritmética `CHECK` | `src/domain/ledger-entry.spec.ts` e `tests/integration/ledger.spec.ts` |
| Máquina de estados de transação (terminais imutáveis) | `src/domain/wager-transaction.spec.ts` e `tests/integration/wagering.spec.ts` |
| Construção controlada do domínio | factories de criação e `rehydrate` nos testes de domínio |
| Eventos tipados (abstract `IntegrationEvent` + subclasse com `eventType/version`) | `src/domain/events/events.spec.ts` e `src/messaging/outbox-publisher.spec.ts` |

### Ciclo de vida da carteira

| Requisito | Prova |
| --- | --- |
| Criação atômica com `OPENING` (ou sem, se zero) | `tests/integration/wallets.spec.ts` e `src/wallets/wallet-http.spec.ts` |
| Consulta de carteira | `tests/integration/wallets.spec.ts` |
| Paginação de ledger com cursor estável `created_at DESC, id DESC` | `src/wallets/ledger.repository.spec.ts` e `tests/integration/ledger.spec.ts` |
| Reconciliação sem correção (`NUMERIC` no banco) | `tests/integration/wallets.spec.ts` com divergência preparada e métrica `wallet_reconciliation_divergences_total` |

### Processamento de aposta

| Requisito | Prova |
| --- | --- |
| Validação de contrato e `Idempotency-Key` obrigatório + hash canônico RFC 8785 | `src/config/env.spec.ts`, `src/domain/canonical-json.spec.ts`, `src/wagering/task3-contract.spec.ts` |
| Idempotência por `UNIQUE` e hash (`IDEMPOTENCY_CONFLICT` vs replay) | `src/domain/canonical-json.spec.ts` e `tests/integration/wagering.spec.ts` com replay e conflito |
| Serialização por carteira (`FOR UPDATE` bloqueante) | `src/wagering/process-wager-lock.spec.ts` e cenário de duas apostas de 80 em saldo 100 |
| Regras de `BET WIN LOSS` | `tests/integration/wagering.spec.ts` e `tests/integration/reversals.spec.ts` |
| Reversões integrais com escopo (mesmo provider/player/wallet/moeda/rodada/valor) e tipo | `tests/integration/reversals.spec.ts` com `REFUND`/`ROLLBACK` |
| Reversão duplicada concorrente (índice parcial) | índice parcial e `tests/integration/reversals.spec.ts` |
| Consulta de transação (por id interno e por `provider+external`) | `tests/integration/wagering.spec.ts` por id interno e por provedor |
| Distinção de resultados e erros (200/202/422/503) | `src/auth/financial-guards.spec.ts` e `tests/integration/wagering.spec.ts` |

### Mensageria confiável

| Requisito | Prova |
| --- | --- |
| Consumo SQS com processador compartilhado (`ProcessWager`) | `tests/integration/command-consumer.spec.ts` e `src/messaging/command-consumer.spec.ts` |
| Deduplicação por inbox transacional (`PK consumer_name,message_id`) | `tests/integration/migration-004.spec.ts` e `src/messaging/command-message-handler.spec.ts` |
| Classificação para ack e DLQ (5 recebimentos) | `tests/integration/command-consumer.spec.ts` com DLQ após cinco recebimentos |
| Referência fora de ordem com backoff (8/1s/60s) | `tests/integration/reversals.spec.ts` com `PENDING_REFERENCE` e worker |
| Publicação de outbox com `SKIP LOCKED` e `eventId` estável | `tests/integration/outbox-publisher.spec.ts` e `src/messaging/outbox-publisher.spec.ts` |
| Encerramento com `SIGTERM`/`SIGINT` (drain) | `src/messaging/consumer-shutdown.spec.ts` e `src/main.spec.ts` |

### Prontidão operacional

| Requisito | Prova |
| --- | --- |
| Validação de ambiente (segredos não ecoados) | `src/config/env.spec.ts` e erro de inicialização sem segredo |
| Liveness e readiness separados | `src/health/health.controller.spec.ts` com live 200 e ready 503 quando dependência cai |
| Logs estruturados e seguros (whitelist) | `src/observability/logger.module.spec.ts` com whitelist |
| Métricas obrigatórias | `src/observability/metrics.service.spec.ts` e `GET /metrics` |
| Encerramento coordenado (visibility deixa para redrive) | `src/messaging/consumer-shutdown.spec.ts` com drenagem e `SIGTERM` |
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
| Recuperação após commit e antes de ack (falha entre commit e `DeleteMessage`) | cenário com `maybeInjectPostCommitFault` e redelivery |
| Publicação concorrente de outbox (`SKIP LOCKED`) | `tests/integration/outbox-publisher.spec.ts` com dois publicadores |
| Reversão fora de ordem (`REFUND`/`ROLLBACK` antes de referência) | `tests/distributed/scenarios.ts` com `REFUND` antes de `BET` |
| Consistência após reinício (kill e re-`spawn`) | cenário de reinício completo com invariante final `saldo == ledger` |
| Invariante final `saldo == ledger` | `tests/distributed/invariant-queries.ts` em todo cenário financeiro |

## Riscos e compensações

* Latência em carteira disputada é intencional para preservar correção (bloqueio `FOR UPDATE` bloqueante). Métrica `wallet_lock_conflicts_total` expõe contenção apenas em deadlocks/serialização; carteiras distintas permanecem independentes.
* Chamada SQS com lock de outbox mantido por tempo curto. Transação curta, timeout controlado e reprogramação (`backoffSeconds`) limitam impacto. Concessão longa adiada até medição de vazão indicar necessidade.
* Duplicação após sucesso no broker e falha de commit no banco permanece possível (SQS aceitou mas `markPublished` não commitou). `eventId` estável, `MessageDeduplicationId` e idempotência/inbox no consumidor mitigam.
* Valores de retentativa são configuráveis (`RETRY_*`, `OUTBOX_*`, `SQS_*`, `SHUTDOWN_TIMEOUT_MS`) e documentados, sem SLA fixo. Ajuste em produção conforme comportamento do provedor.
* Suíte de integração mais lenta que mocks é compensada por determinismo e cobertura real; unitários isolam domínio puro sem infra.
* LocalStack fixado em 3.8.1 e validado na prontidão reduz variação de compatibilidade; pool 10 por processo evita `too many clients` no PostgreSQL 100.

## Limitações conhecidas

* Uma moeda por carteira e validação focada em `BRL` nos testes, modelo permanece multi moeda (conflito `CurrencyMismatchError` testado).
* Sem double entry contábil completo. Ledger por carteira com `CREDIT` e `DEBIT` e reconciliação por carteira (soma com `CASE`).
* Sem OpenTelemetry distribuído. Logs JSON estruturados e métricas `prom-client` cobrem diagnóstico exigido.
* SQS FIFO usado como otimização (`MessageGroupId=walletId`, `ContentBasedDeduplication`), não como garantia final. Banco arbitra correção via constraints.

## Fora de escopo

Ledger de partidas dobradas, OpenTelemetry, painel e teste de carga permanecem fora desta entrega. Teste de carga (`bun run test:load`) somente com aprovação separada após requisitos obrigatórios verdes, conforme 10.5 do plano. Autenticação OIDC externa permanece como extensão via `NoopIdentityGuard`/`ProviderIdentityPort` (ADR 0001).
