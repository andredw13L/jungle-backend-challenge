## Context

O repositório contém apenas o enunciado e a configuração inicial do OpenSpec. O serviço precisa ser construído com Bun, NestJS, MikroORM, PostgreSQL e SQS, mantendo correção financeira quando requisições e mensagens são duplicadas, concorrentes, entregues fora de ordem ou interrompidas por crash. O README é o contrato autoritativo; o glossário canônico está em `GLOSSARY.md` e as decisões aprovadas estão em `docs/adr`.

## Goals / Non-Goals

**Goals:**

- Implementar todos os comportamentos obrigatórios dos §§5–13 do README.
- Garantir dinheiro exato, saldo não negativo, Ledger auditável e reconciliação.
- Manter idempotência e concorrência corretas com pelo menos três processos.
- Tornar HTTP e SQS adapters da mesma interface profunda de processamento.
- Provar cada garantia por constraint PostgreSQL e/ou teste executável.
- Entregar setup reproduzível, observabilidade e documentação suficiente para operação e entrevista.

**Non-Goals:**

- Autenticação real, usuários locais ou emissão própria de JWT.
- Ledger de partidas dobradas, OpenTelemetry, dashboard e teste de carga.
- Suporte operacional a moedas além de BRL, embora o modelo preserve a moeda.
- Garantia de exactly-once no broker; duplicatas são esperadas e tratadas.

## Decisions

### Modules and interfaces

O código será organizado por funcionalidade (`wallets`, `wagering`, `messaging`, `health`, `auth`, `observability`) com tipos compartilhados em `domain` e persistência em `infrastructure`. O módulo profundo `ProcessWager` expõe uma única interface para HTTP e SQS e esconde idempotência, transação, lock, Ledger, Inbox e Outbox. Não haverá repository ports com uma única implementação; os módulos de aplicação usam o `EntityManager` transacional e são testados com PostgreSQL real.

`Money` permanece sem imports de framework ou ORM. Entidades podem carregar apenas decorators de persistência MikroORM sobre strings mapeadas para `NUMERIC(18,2)`, conforme [ADR-0004](../../../docs/adr/0004-keep-money-pure-at-the-mikroorm-seam.md).

### Financial transaction flow

```text
HTTP controller ─┐
                 ├─ validation ─ ProcessWager.execute(command, context)
SQS consumer ────┘                    │
                                      ▼
                         PostgreSQL READ COMMITTED
                         1. claim idempotency/inbox
                         2. FOR UPDATE on wallet when balance can change
                         3. apply domain transition
                         4. persist wallet + ledger + response + outbox
                         5. mark inbox processed
                                      │
                                      ▼ commit
                         HTTP response or SQS acknowledgement
```

A `UNIQUE` insert, nunca um pre-check, arbitra idempotência. Uma violação nomeada de `uq_wager_idempotency_key` é tratada fora da transação abortada: hash JCS/SHA-256 igual produz replay de `response_payload`; hash diferente produz `IDEMPOTENCY_CONFLICT`. Operações distintas que alteram a mesma Wallet são serializadas por `FOR UPDATE`; Wallets distintas continuam paralelas. `LOSS` não adquire lock porque não altera saldo ou Ledger. A estratégia completa está em [ADR-0002](../../../docs/adr/0002-coordinate-wallet-writes-in-postgresql.md).

### PostgreSQL enforcement

| Guarantee | Schema enforcement | Executable evidence |
|---|---|---|
| Exact money | `NUMERIC(18,2)` and decimal strings | Money tests and round-trip integration test |
| Non-negative balance | `CHECK (balance_amount >= 0)` | constraint test and competing-bets test |
| One Wallet per player/currency | `UNIQUE (player_id, currency)` | duplicate creation test |
| Ledger arithmetic | debit/credit `CHECK` over before/amount/after | invalid insert test and reconciliation |
| At most one entry per transaction/Wallet | `UNIQUE (transaction_id, wallet_id)` | 50-way idempotency test |
| Immutable Ledger | trigger rejects `UPDATE` and `DELETE` | mutation integration test |
| Provider identity and idempotency | named unique constraints | replay and conflicting-payload tests |
| One reversal per reference/type | partial unique indexes | concurrent reversal tests |
| Inbox deduplication | primary key `(consumer_name, message_id)` | redelivery test |
| Concurrent Outbox publication | partial due index plus `SKIP LOCKED` | two-publisher test |

`wager_transactions` also stores `payload_hash`, `response_payload`, failure code, reference retry count and next retry time. Version starts at 1 and increments only when the Wallet balance changes.

### HTTP outcomes

Successful processing, business rejection and replay use `200`; Wallet creation uses `201`; pending reference uses `202`; missing resources use `404`; duplicate Wallet uses `409`; malformed input and idempotency conflicts use `422` with distinct machine codes; transient infrastructure failures use `503`. This follows [ADR-0006](../../../docs/adr/0006-distinguish-business-outcomes-from-errors.md).

Ledger pagination uses a Base64URL cursor containing `{createdAt,id}`, default limit 50 and maximum 100. Reconciliation calculates the Ledger total with PostgreSQL `NUMERIC`, reports any difference and never mutates financial state.

### Reliable messaging

The command queue receives at most ten messages per 20-second long poll with a configurable 60-second visibility timeout. Messages are grouped by `walletId`; groups run concurrently while messages within one group remain sequential. Business outcomes and identical duplicates are acknowledged after commit. Invalid/conflicting messages are left for redrive to the DLQ, and transient infrastructure failures remain unacknowledged for retry.

The Outbox publisher locks and publishes one due row per transaction with `FOR UPDATE SKIP LOCKED`, immediately continuing while work exists and waiting one second when empty. SQS publication occurs while that row is locked; send success followed by commit failure can duplicate an event, so `eventId`, Inbox and consumer idempotency remain mandatory. Command and event queues are separated as described in [ADR-0005](../../../docs/adr/0005-separate-command-and-event-queues.md).

Pending-reference workers also select one due row with `FOR UPDATE SKIP LOCKED`, then acquire the referenced Wallet lock before re-evaluation. They use configurable exponential backoff with defaults of eight attempts, one-second base and sixty-second cap. Exhaustion persists `REJECTED/REFERENCE_NOT_FOUND` and its Outbox event. Transactional consistency follows [ADR-0003](../../../docs/adr/0003-use-a-transactional-inbox-and-outbox.md).

### Runtime and verification

Bun loads environment variables and a single `env.ts` validates required values before NestJS starts. `enableShutdownHooks()` stops polling, waits for in-flight work and closes clients. `nestjs-pino` emits JSON using a safe field allowlist; `prom-client` exposes the seven required metrics.

Distributed tests spawn three OS processes on ports 3101–3103 with distinct PIDs, Nest containers and connection pools sharing only PostgreSQL and SQS. Requests are released together with `Promise.all`, distributed across all ports, and verified through final persisted state. Deterministic fault injection kills a dedicated test process after commit and before SQS acknowledgement; no production request can activate it.

Authentication follows [ADR-0001](../../../docs/adr/0001-defer-authentication-to-an-external-idp.md): a no-op guard and `ProviderIdentityPort` preserve the external OIDC seam without implementing credentials.

## Risks / Trade-offs

- **Hot Wallet latency** → operations for one Wallet serialize deliberately; metrics expose lock contention and Wallets remain independent.
- **SQS call while holding one Outbox row lock** → one-row transactions, bounded SDK timeout and retry scheduling limit blast radius; claim leases are deferred until measured throughput requires them.
- **Duplicate publication after broker success and database failure** → stable `eventId`, FIFO deduplication as optimization and mandatory consumer idempotency.
- **Retry defaults do not encode a provider SLA** → values are validated configuration and documented for production calibration.
- **Integration suite is slower than mocked tests** → infrastructure remains running, state resets deterministically and unit tests cover pure domain feedback.
- **LocalStack compatibility drift** → pin version 3.8.1 and validate queues during readiness.

## Migration Plan

1. Bootstrap runtime, configuration, Compose services and queue initialization.
2. Apply and reverse Migration001 against a clean PostgreSQL database.
3. Deliver domain, Wallet, wagering, reversal, Inbox/consumer, Outbox and operational slices in that order.
4. Run all unit, integration and three-process scenarios after every affected slice.
5. Build the application image, start the complete Compose stack and execute the documented clean-clone workflow.

Rollback is `migration:down` for schema state plus normal Git reversion of the current green slice. Financial migrations are never edited after being applied; a follow-up migration corrects later schema changes.

## Open Questions

None. All implementation-affecting decisions were approved before this artifact.
