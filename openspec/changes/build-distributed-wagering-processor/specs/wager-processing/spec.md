## ADDED Requirements

### Requirement: Validar contratos de apostas
`POST /wagering/transactions` DEVE (`MUST`) exigir `Idempotency-Key`, DEVE rejeitar campos desconhecidos e identificadores, tipos ou Money malformados com `422` e DEVE rejeitar operações OPENING externas.

#### Scenario: Comando válido
- **WHEN** um comando BET completo e o cabeçalho de idempotência passam pela validação
- **THEN** o controlador chama `ProcessWager` com os campos de negócio normalizados e sem metadados de transporte no hash do conteúdo

#### Scenario: Campo desconhecido no contrato
- **WHEN** uma requisição contém uma propriedade não declarada
- **THEN** a validação por lista permitida a rejeita com `422/INVALID_PAYLOAD`

### Requirement: Persistir idempotência e reprodução
O sistema DEVE (`MUST`) arbitrar a idempotência por restrições nomeadas de unicidade no PostgreSQL, DEVE gerar o hash do JSON canônico de negócio conforme RFC 8785 com SHA-256 e DEVE reproduzir a resposta persistida sem repetir efeitos.

#### Scenario: Reprodução idêntica
- **WHEN** a mesma chave de idempotência e o mesmo conteúdo lógico são submetidos novamente com outra ordem de propriedades JSON
- **THEN** os hashes canônicos coincidem, o identificador, o estado e o saldo da transação original são retornados com `idempotentReplay: true`, e nenhum efeito na Wallet, no Ledger ou na Outbox é duplicado

#### Scenario: Reprodução conflitante
- **WHEN** uma chave de idempotência existente é reutilizada com campos de negócio diferentes
- **THEN** a resposta é `422/IDEMPOTENCY_CONFLICT` e o resultado original permanece inalterado

#### Scenario: Transação do provedor reutilizada com outra chave
- **WHEN** o mesmo provedor e identificador externo de transação são submetidos com outra chave de idempotência
- **THEN** a requisição é rejeitada com um conflito estável de transação externa e sem efeito duplicado

### Requirement: Serializar por Wallet as operações que alteram saldo
BET, WIN, REFUND e ROLLBACK DEVEM (`MUST`) bloquear uma linha de Wallet dentro de `READ COMMITTED` antes de avaliar ou alterar o saldo; Wallets diferentes DEVEM permanecer independentes e nenhum bloqueio local ao processo pode garantir a correção.

#### Scenario: Apostas concorrentes
- **WHEN** duas BETs de `80.00 BRL` disputam concorrentemente uma Wallet com `100.00 BRL`
- **THEN** exatamente uma fica PROCESSED, uma fica REJECTED/INSUFFICIENT_FUNDS, o saldo final é `20.00`, a versão muda uma vez e existe exatamente uma entrada DEBIT

#### Scenario: Wallets diferentes
- **WHEN** operações atingem concorrentemente identificadores diferentes de Wallet
- **THEN** nenhuma aguarda um bloqueio global da aplicação e os dois resultados permanecem corretos

### Requirement: Aplicar as regras de BET, WIN e LOSS
BET DEVE (`MUST`) debitar um saldo suficiente, WIN DEVE creditar o saldo e LOSS DEVE registrar um resultado processado sem alterar o saldo nem produzir uma entrada no Ledger.

#### Scenario: Processar BET
- **WHEN** uma BET válida tem saldo suficiente
- **THEN** ela fica PROCESSED com uma entrada DEBIT e eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na Outbox

#### Scenario: Processar WIN
- **WHEN** uma WIN válida é submetida
- **THEN** ela fica PROCESSED com uma entrada CREDIT e o novo saldo exato

#### Scenario: WIN com referência opcional a BET
- **WHEN** uma WIN identifica uma referência BET
- **THEN** a referência deve ser uma BET PROCESSED correspondente, do mesmo provedor, jogador, Wallet, moeda e rodada, antes de a WIN ser creditada

#### Scenario: Processar LOSS
- **WHEN** uma LOSS válida é submetida
- **THEN** ela fica PROCESSED, o saldo e a versão permanecem inalterados e somente `WagerTransactionProcessed` é enfileirado

### Requirement: Aplicar reversões integrais uma única vez
REFUND DEVE (`MUST`) reverter somente uma BET PROCESSED; ROLLBACK DEVE reverter uma BET, WIN ou REFUND PROCESSED; a referência DEVE corresponder ao provedor, jogador, Wallet, moeda e rodada; o valor DEVE ser igual; e cada par de referência e tipo DEVE ser revertido no máximo uma vez.

#### Scenario: REFUND válido
- **WHEN** um REFUND referencia exatamente uma BET PROCESSED correspondente
- **THEN** ele credita o valor original uma única vez e vincula a transação interna de referência

#### Scenario: ROLLBACK válido
- **WHEN** um ROLLBACK referencia exatamente uma WIN PROCESSED correspondente
- **THEN** ele cria uma entrada DEBIT inversa e fica PROCESSED

#### Scenario: Direção do ROLLBACK acompanha sua referência
- **WHEN** um ROLLBACK referencia uma BET, WIN ou REFUND PROCESSED
- **THEN** BET produz um CREDIT inverso, enquanto WIN e REFUND produzem um DEBIT inverso do valor integral referenciado

#### Scenario: Escopo ou valor da referência inválido
- **WHEN** a identidade, o escopo, o tipo ou o valor da referência não satisfaz as regras de reversão
- **THEN** a transação fica REJECTED com o código de falha estável correspondente e sem entrada no Ledger

#### Scenario: Reversão produziria saldo negativo
- **WHEN** reverter um crédito anterior tornaria o saldo da Wallet negativo
- **THEN** a transação fica REJECTED/REVERSAL_WOULD_OVERDRAW e permanece persistida para auditoria

#### Scenario: Reversão duplicada concorrente
- **WHEN** duas reversões do mesmo tipo disputam a mesma referência
- **THEN** um índice único parcial permite no máximo um efeito e a outra retorna `REFERENCE_ALREADY_REVERSED`

### Requirement: Consultar transações de apostas
O sistema DEVE (`MUST`) expor a consulta de transações pelo identificador interno e por `(providerId, externalTransactionId)`, retornando estado, falha, referência e Money exato persistidos, ou `404` quando ausentes.

#### Scenario: Consultar transação processada
- **WHEN** uma transação conhecida é consultada por qualquer uma das rotas
- **THEN** ambas identificam a mesma operação imutável e o resultado persistido atual

### Requirement: Distinguir resultados de erros de infraestrutura
Rejeições de negócio DEVEM (`MUST`) retornar `200` com código de falha estável, referências pendentes DEVEM retornar `202` e falhas transitórias de infraestrutura DEVEM retornar `503`, permitindo que o provedor repita com segurança a mesma chave de idempotência.

#### Scenario: Saldo insuficiente é um resultado
- **WHEN** uma BET sintaticamente válida não tem saldo suficiente
- **THEN** a resposta é `200` com estado REJECTED e código de falha INSUFFICIENT_FUNDS, e não um erro de validação

#### Scenario: PostgreSQL temporariamente indisponível
- **WHEN** o processamento não consegue acessar o PostgreSQL
- **THEN** a resposta é `503` e nenhum resultado financeiro bem-sucedido é inventado

#### Scenario: Classes de erro do PostgreSQL permanecem distintas
- **WHEN** o PostgreSQL informa uma violação nomeada `23505`, uma violação de invariante `23514` ou uma falha transitória `40001`
- **THEN** o sistema, respectivamente, trata o conflito nomeado, emite um alerta de invariante sem ocultar o erro ou retorna um resultado de infraestrutura que permite nova tentativa
