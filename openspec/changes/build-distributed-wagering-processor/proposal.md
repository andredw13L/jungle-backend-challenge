## Why

O desafio exige um processador financeiro distribuído que permaneça correto sob duplicação, concorrência, entrega fora de ordem e falhas parciais. A implementação precisa transformar as garantias do README em constraints PostgreSQL e provas executáveis antes do prazo de entrega.

## What Changes

- Inicializar a aplicação Bun/NestJS, PostgreSQL 16 e SQS/LocalStack com configuração validada, migrations reversíveis e health checks separados.
- Modelar Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox, Outbox e Integration events com invariantes encapsuladas.
- Expor criação, consulta, ledger e reconciliação de Wallets e submissão/consulta de BET, WIN, LOSS, REFUND e ROLLBACK.
- Garantir idempotência persistente, replay fiel, lock por Wallet e atomicidade entre saldo, Ledger, Inbox e Outbox.
- Consumir comandos SQS com validação, redelivery seguro, retry, DLQ e graceful shutdown; publicar eventos por Outbox concorrente.
- Entregar logs JSON, métricas, testes reais de integração e os oito cenários de concorrência com pelo menos três processos.
- Documentar operação, decisões, trade-offs e limitações; autenticação fica fora de escopo com seam explícito para IdP externo.

O trabalho cobre diretamente os §§5–13 do README e elimina os riscos de dinheiro em `number`, saldo negativo, efeito duplicado, idempotência em memória, correção single-instance, publicação antes do commit, Ledger não auditável e testes totalmente mockados.

## Capabilities

### New Capabilities

- `financial-domain`: Money exato, Wallet, transações, Ledger auditável, referências e eventos de domínio.
- `wallet-lifecycle`: criação, consulta, paginação do Ledger e reconciliação de Wallets.
- `wager-processing`: processamento HTTP idempotente de todas as operações com concorrência e respostas reproduzíveis.
- `reliable-messaging`: consumo SQS com Inbox, retry/DLQ, referências pendentes e publicação por Outbox.
- `operational-readiness`: configuração, health, logs estruturados, métricas e shutdown coordenado.
- `distributed-verification`: migrations, integração real, falhas e concorrência comprovadas com múltiplos processos.

### Modified Capabilities

Nenhuma. O repositório ainda não possui especificações de implementação.

## Impact

- Novo serviço NestJS executado, instalado e testado pelo Bun.
- Novo schema PostgreSQL com cinco tabelas, enums, constraints, índices e migration reversível.
- Novas filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no LocalStack.
- Novos endpoints HTTP financeiros, de health e métricas.
- Dependências principais: MikroORM 7, decimal.js, AWS SDK v3, class-validator, Terminus, nestjs-pino e prom-client.
- Docker Compose passa a executar PostgreSQL, LocalStack, inicialização das filas e múltiplas instâncias opcionais da aplicação.
