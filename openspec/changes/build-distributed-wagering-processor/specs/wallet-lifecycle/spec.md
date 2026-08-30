## ADDED Requirements

### Requirement: Criar Wallet atomicamente
`POST /wallets` DEVE (`MUST`) criar no máximo uma Wallet por jogador e moeda e DEVE persistir atomicamente qualquer saldo inicial positivo, sua transação interna OPENING, uma entrada CREDIT no Ledger e os eventos relacionados na Outbox.

#### Scenario: Saldo inicial positivo
- **WHEN** um jogador válido cria uma Wallet com `1000.00 BRL`
- **THEN** a resposta é `201`, a versão é 1, o saldo é `1000.00` e o banco contém uma transação OPENING e uma entrada CREDIT correspondente na mesma confirmação

#### Scenario: Saldo inicial zero
- **WHEN** uma Wallet é criada com `0.00 BRL`
- **THEN** a versão é 1 e nenhuma transação OPENING nem entrada no Ledger é criada

#### Scenario: Wallet duplicada
- **WHEN** a mesma combinação de jogador e moeda é criada concorrentemente mais de uma vez
- **THEN** existe exatamente uma Wallet e todas as requisições perdedoras recebem conflito `409`

### Requirement: Consultar Wallet
`GET /wallets/:walletId` DEVE (`MUST`) retornar o identificador da Wallet, o jogador, o saldo exato e a versão, e DEVE retornar `404` para um identificador desconhecido.

#### Scenario: Wallet existente
- **WHEN** uma Wallet conhecida é consultada
- **THEN** seu saldo persistido atual e sua versão são retornados como strings decimais

#### Scenario: Wallet ausente
- **WHEN** um identificador desconhecido de Wallet é consultado
- **THEN** a resposta é `404` com um código estável e legível por máquina

### Requirement: Paginar o Ledger imutável
`GET /wallets/:walletId/ledger` DEVE (`MUST`) retornar entradas em ordem cronológica inversa usando um cursor opaco e estável, limite padrão de 50 e limite máximo de 100.

#### Scenario: Próxima página permanece estável
- **WHEN** um cliente solicita a próxima página usando o cursor Base64URL `{createdAt,id}` enquanto entradas mais novas são inseridas
- **THEN** a consulta usa ordenação por chave e não pula nem repete entradas mais antigas

#### Scenario: Paginação inválida
- **WHEN** o cursor está malformado ou o limite está fora do intervalo aceito
- **THEN** a resposta é `422` e nenhuma consulta é executada com valores não confiáveis do cursor

### Requirement: Reconciliar Wallet e Ledger
`POST /wallets/:walletId/reconciliation` DEVE (`MUST`) calcular o saldo do Ledger com aritmética exata no PostgreSQL, compará-lo com o saldo armazenado, informar a diferença e a quantidade de entradas e NÃO DEVE corrigir uma divergência.

#### Scenario: Wallet consistente
- **WHEN** o Ledger reconstrói o saldo armazenado
- **THEN** a resposta informa valores exatos iguais, diferença zero e `consistent: true`

#### Scenario: Wallet divergente
- **WHEN** um dado preparado para teste cria uma divergência entre o saldo armazenado e o Ledger
- **THEN** a resposta informa `consistent: false`, emite log estruturado e métrica e deixa todas as linhas financeiras inalteradas
