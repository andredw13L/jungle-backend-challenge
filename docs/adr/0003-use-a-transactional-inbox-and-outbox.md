# Usar Inbox e Outbox transacionais

HTTP e SQS chamam a mesma interface `ProcessWager`, e o PostgreSQL persiste atomicamente a transação, a alteração da Wallet, a entrada do Ledger, o registro opcional da Inbox e os eventos da Outbox. A confirmação no SQS e a publicação dos eventos acontecem somente depois da confirmação no banco; assim, a entrega pelo menos uma vez pode duplicar mensagens, mas não os efeitos financeiros.
