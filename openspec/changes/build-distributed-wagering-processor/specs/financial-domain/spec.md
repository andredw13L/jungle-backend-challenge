## ADDED Requirements

### Requirement: Money exato e imutável
O sistema DEVE (`MUST`) representar valores monetários como strings decimais com escala fixa de 2 casas nos contratos e nas fronteiras com o PostgreSQL, DEVE calcular com uma implementação decimal exata e NÃO DEVE usar `number` do JavaScript para estado ou aritmética monetária.

#### Scenario: Aritmética decimal exata
- **WHEN** `0.10 BRL` e `0.20 BRL` são somados
- **THEN** o resultado é um novo valor Money serializado como `{"amount":"0.30","currency":"BRL"}` e os dois operandos permanecem inalterados

#### Scenario: Valor externo inválido
- **WHEN** um contrato externo contém valor vazio, negativo, em notação científica, com zero à esquerda como `007` ou com mais de duas casas decimais
- **THEN** a validação o rejeita antes da criação do estado financeiro

#### Scenario: Normalizar escala aceita sem arredondamento silencioso
- **WHEN** um valor externo é `25` ou `25.0`
- **THEN** ele é serializado como `25.00`, enquanto `25.001` é rejeitado em vez de arredondado

#### Scenario: Conflito de moeda
- **WHEN** uma operação aritmética é tentada entre moedas diferentes
- **THEN** o domínio rejeita a operação com um resultado estável de incompatibilidade de moeda

### Requirement: Invariantes da Wallet
Uma Wallet DEVE (`MUST`) pertencer a um jogador e uma moeda, DEVE começar na versão 1, NUNCA DEVE expor saldo negativo e DEVE incrementar sua versão somente quando o saldo mudar.

#### Scenario: Débito bem-sucedido
- **WHEN** uma Wallet com `100.00 BRL` é debitada em `80.00 BRL`
- **THEN** ela retorna os valores anterior e posterior de `100.00` e `20.00` e incrementa a versão exatamente uma vez

#### Scenario: Saldo insuficiente
- **WHEN** um débito excede o saldo disponível
- **THEN** a Wallet permanece inalterada e produz a rejeição de negócio `INSUFFICIENT_FUNDS`

#### Scenario: Reidratação
- **WHEN** uma Wallet é reidratada a partir do estado persistido
- **THEN** seu estado confiável é reconstruído sem repetir validações de criação ou transição

### Requirement: Entrada de Ledger auditável
Cada alteração de saldo DEVE (`MUST`) ter exatamente uma entrada imutável no Ledger cuja direção e valor transformem `balanceBefore` em `balanceAfter`; operações sem efeito no saldo NÃO DEVEM criar uma entrada.

#### Scenario: Entrada balanceada
- **WHEN** uma entrada `DEBIT` descreve `100.00 - 80.00`
- **THEN** ela é válida somente com `balanceAfter` igual a `20.00`

#### Scenario: Nenhuma entrada para resultado sem efeito financeiro
- **WHEN** uma transação LOSS ou REJECTED é registrada
- **THEN** nenhuma entrada no Ledger é criada e a versão da Wallet permanece inalterada

### Requirement: Máquina de estados de WagerTransaction
WagerTransaction DEVE (`MUST`) aceitar OPENING, BET, WIN, LOSS, REFUND e ROLLBACK, DEVE exigir referências válidas para tipos de reversão e DEVE impedir novas transições a partir dos estados PROCESSED, REJECTED e FAILED.

#### Scenario: Abertura interna
- **WHEN** uma Wallet é criada com saldo inicial positivo
- **THEN** uma transação interna OPENING pode se tornar PROCESSED, mas o mesmo tipo não pode ser submetido por HTTP nem SQS

#### Scenario: Transação terminal
- **WHEN** o código tenta transicionar uma transação terminal
- **THEN** um erro de programação por estado inválido é lançado e nenhum novo efeito financeiro ocorre

#### Scenario: Referência obrigatória
- **WHEN** REFUND ou ROLLBACK é criado sem uma referência do provedor
- **THEN** a requisição é rejeitada como inválida antes da persistência

### Requirement: Construção controlada do domínio
As entidades de domínio DEVEM (`MUST`) usar construtores privados ou protegidos, DEVEM expor factories de criação que validem o novo estado e DEVEM expor factories de reidratação que confiem no estado já persistido sem repetir regras de transição.

#### Scenario: Criação e reidratação têm semânticas distintas
- **WHEN** valores brutos idênticos entram por uma factory de criação e por uma factory de reidratação
- **THEN** a criação aplica as invariantes de uma nova operação, enquanto a reidratação reconstrói o estado persistido confiável

### Requirement: Eventos de integração tipados
Os eventos de integração DEVEM (`MUST`) usar um envelope abstrato e versionado com tipos concretos de evento, DEVEM serializar datas em ISO-8601 e Money como propriedades de strings decimais e DEVEM permanecer imutáveis depois da criação.

#### Scenario: Evento de alteração de saldo da Wallet
- **WHEN** uma transação altera o saldo de uma Wallet
- **THEN** `WalletBalanceChanged` contém a identidade do evento, a correlação, a versão da Wallet, a direção e as propriedades Money exatas dos saldos anterior e posterior
