# Coordenar escritas da Wallet no PostgreSQL

As operações que alteram saldo usam transações `READ COMMITTED` e `SELECT ... FOR UPDATE` em uma Wallet, enquanto `version` registra cada alteração de saldo e os publicadores da Outbox usam `SKIP LOCKED`. Isso mantém a correção compartilhada entre instâncias sem um bloqueio global; uma Wallet disputada é serializada deliberadamente em vez de provocar uma tempestade de novas tentativas otimistas.
