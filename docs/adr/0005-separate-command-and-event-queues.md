# Separar filas de comandos e eventos

Os comandos dos provedores chegam pela `wager-transactions.fifo`, acompanhada de sua DLQ, enquanto os eventos da Outbox são publicados na `wager-events.fifo`; ambas agrupam mensagens por Wallet. A ordenação FIFO e a deduplicação de curta duração são apenas otimizações de entrega; as restrições do PostgreSQL, a Inbox e a idempotência continuam sendo os mecanismos de correção.
