# Glossário — Distributed Wagering Processor

Linguagem canônica do projeto, trazida do material de estudo e ampliada com as decisões do desenho.

## Domínio financeiro

**Money**:
Value object imutável que representa um valor monetário como string decimal de escala fixa 2 (ex.: `"25.00"`), nunca `number`/`float`.
_Avoid_: valor em centavos "soltos", float, double.

**Wallet**:
Agregado que mantém o saldo materializado de um jogador em uma moeda e controla suas transições financeiras.
_Avoid_: conta, carteira do usuário.

**Opening**:
Transação interna que registra o saldo inicial positivo de uma Wallet.
_Avoid_: depósito inicial externo.

**Ledger (WalletLedgerEntry)**:
Registro imutável e auditável de cada movimentação de saldo, com `balanceBefore`, `balanceAfter` e direção (`DEBIT`/`CREDIT`).
_Avoid_: extrato, log de transações.

**Reconciliation**:
Comparação entre o saldo materializado da Wallet e o saldo reconstruído pelo Ledger, sem correção automática de divergências.
_Avoid_: ajuste de saldo, autocorreção.

**Invariante**:
Condição que deve permanecer verdadeira em qualquer estado do sistema, como saldo não negativo e correspondência entre saldo e Ledger.
_Avoid_: regra de validação.

**Reidratação**:
Reconstrução em memória de um objeto a partir do estado persistido, sem revalidar transições já aceitas.
_Avoid_: desserialização, criação.

## Apostas e resultados

**WagerTransaction**:
Operação financeira identificada pelo provedor e associada a uma Wallet, jogador, rodada e jogo.
_Avoid_: lançamento, mensagem SQS.

**Reference**:
WagerTransaction anterior identificada pelo provedor e necessária para validar um REFUND ou ROLLBACK.
_Avoid_: id interno recebido do provedor.

**Reversal**:
REFUND ou ROLLBACK que desfaz integralmente uma Reference válida uma única vez por tipo.
_Avoid_: estorno parcial.

**Business rejection**:
Resultado terminal e auditável em que uma operação válida não pode ser aplicada, como saldo insuficiente.
_Avoid_: erro de infraestrutura, payload inválido.

**Failure code**:
Código estável e legível por máquina que explica uma Business rejection e orienta o provedor sobre retry ou correção.
_Avoid_: mensagem de erro textual.

**PENDING_REFERENCE**:
Estado de uma WagerTransaction cuja Reference ainda não chegou e será procurada novamente com backoff.
_Avoid_: falha, rejeição antecipada.

## Concorrência

**Unidade de concorrência**:
A `walletId`, escopo no qual operações disputam saldo enquanto Wallets distintas permanecem paralelas.
_Avoid_: lock global.

**Lost update**:
Atualização perdida quando duas operações leem o mesmo saldo e uma sobrescreve o efeito da outra.
_Avoid_: race genérica.

**Optimistic locking**:
Detecção de escrita concorrente por uma versão que muda junto com o saldo.
_Avoid_: lock em memória.

**Pessimistic locking**:
Serialização temporária das alterações financeiras de uma Wallet enquanto uma transação detém sua linha.
_Avoid_: lock global, mutex de processo.

## Idempotência e mensageria

**Idempotência persistente**:
Garantia compartilhada de que reprocessar a mesma operação produz um único efeito e um resultado reproduzível.
_Avoid_: cache em memória.

**Idempotency key**:
Identificador fornecido pelo chamador que representa uma única operação; reutilizá-lo com outro payload é conflito.

**Payload hash**:
Identidade criptográfica dos campos de negócio de uma operação em representação canônica.

**Idempotent replay**:
Resposta reconstruída do resultado persistido de uma operação já processada, sem repetir seus efeitos.
_Avoid_: executar novamente, resposta recalculada.

**At-least-once**:
Semântica de entrega em que a mesma mensagem pode chegar mais de uma vez.
_Avoid_: exactly-once.

**Inbox pattern**:
Registro persistente de uma mensagem recebida que participa da mesma transação de seu efeito.
_Avoid_: deduplicação apenas no broker.

**Transactional outbox**:
Registro persistente de um Integration event na mesma transação do efeito que o originou, para publicação posterior.
_Avoid_: publicar durante o processamento financeiro.

**Integration event**:
Fato versionado e imutável que comunica a outros sistemas um resultado confirmado.
_Avoid_: comando, entidade de domínio serializada.

**DLQ (Dead Letter Queue)**:
Fila que recebe mensagens que esgotaram tentativas após falhas permanentes.
_Avoid_: fila de erro.

**Visibility timeout**:
Intervalo durante o qual uma mensagem recebida fica invisível para outros consumers antes de ack ou redelivery.
_Avoid_: timeout HTTP.
