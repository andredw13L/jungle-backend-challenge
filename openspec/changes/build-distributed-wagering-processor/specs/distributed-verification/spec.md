## ADDED Requirements

### Requirement: Verificar o comportamento financeiro puro
A suíte unitária DEVE (`MUST`) cobrir validação e operações de Money, invariantes da Wallet, cada tipo e transição de aposta, regras de referência, conflito de moeda, aritmética do Ledger e conteúdos divergentes para a mesma idempotência.

#### Scenario: Execução da suíte unitária
- **WHEN** `bun test` executa sem filtros específicos de infraestrutura
- **THEN** cada requisito puro de domínio é exercitado sem simular a implementação do domínio

### Requirement: Verificar integração com PostgreSQL e SQS
Os testes de integração DEVEM (`MUST`) usar os serviços reais de PostgreSQL e LocalStack do Compose, DEVEM reiniciar o estado compartilhado deterministicamente e DEVEM cobrir migrations, restrições, atomicidade, Inbox e reentrega, publicadores da Outbox, novas tentativas, DLQ e recuperação após reinicialização.

#### Scenario: Ciclo de vida da migration
- **WHEN** as migrations executam subida, descida e nova subida em um banco limpo
- **THEN** o esquema esperado e as restrições nomeadas são recriados sem intervenção manual

#### Scenario: Reversão atômica
- **WHEN** uma falha forçada ocorre antes da confirmação da transação financeira
- **THEN** Wallet, aposta, Ledger, Inbox e Outbox mantêm seus estados anteriores

### Requirement: Provar idempotência sob entrega paralela
A suíte distribuída DEVE (`MUST`) enviar uma BET cinquenta vezes concorrentemente por pelo menos três processos do sistema operacional e DEVE provar um único efeito financeiro.

#### Scenario: Cinquenta submissões idênticas
- **WHEN** cinquenta requisições com uma chave de idempotência são liberadas juntas nas portas 3101–3103
- **THEN** um resultado original e quarenta e nove reproduções são retornados, o saldo final reflete um único débito, existe uma entrada no Ledger e existe um único conjunto de eventos financeiros

### Requirement: Provar correção na disputa por saldo
A suíte distribuída DEVE (`MUST`) executar, contra o PostgreSQL compartilhado, o cenário obrigatório de uma Wallet com `100.00 BRL` e duas BETs concorrentes de `80.00 BRL`.

#### Scenario: Duas apostas disputam
- **WHEN** processos diferentes submetem as duas BETs concorrentemente
- **THEN** uma fica PROCESSED, uma fica REJECTED, o saldo é `20.00`, existe exatamente uma entrada DEBIT e a reconstrução do Ledger é igual ao saldo

### Requirement: Provar o progresso independente de Wallets
A suíte distribuída DEVE (`MUST`) demonstrar que operações em Wallets distintas avançam sem um bloqueio global.

#### Scenario: Wallets diferentes em paralelo
- **WHEN** três processos operam em Wallets distintas a partir de uma liberação sincronizada
- **THEN** todos os resultados estão corretos e a contenção de bloqueio observada fica limitada aos identificadores individuais das Wallets

### Requirement: Provar três instâncias independentes da aplicação
A suíte distribuída DEVE (`MUST`) iniciar pelo menos três processos Bun do sistema operacional, com PIDs, portas, contêineres Nest e conjuntos de conexões distintos, compartilhando somente PostgreSQL e SQS.

#### Scenario: Todas as instâncias participam
- **WHEN** a suíte aguarda a prontidão e distribui requisições alternadamente
- **THEN** cada PID processa trabalho, pode ter sua saúde consultada independentemente e a correção não depende da memória dos processos

### Requirement: Provar recuperação depois da confirmação e antes da confirmação no SQS
A suíte DEVE (`MUST`) encerrar deterministicamente um processo consumidor depois da confirmação no PostgreSQL e antes da confirmação no SQS.

#### Scenario: Consumidor encerra antes da confirmação no SQS
- **WHEN** a injeção de falha encerra esse processo no intervalo posterior à confirmação no banco e anterior à confirmação no SQS
- **THEN** outro processo recebe a mensagem e Inbox e idempotência impedem outro efeito financeiro

### Requirement: Provar publicação concorrente da Outbox
A suíte DEVE (`MUST`) executar pelo menos dois publicadores sobre a mesma Outbox e verificar a publicação eventual sem perda de linhas.

#### Scenario: Dois publicadores
- **WHEN** os dois publicadores iniciam simultaneamente sobre um acúmulo de eventos
- **THEN** cada evento durável é publicado, cada linha chega ao estado publicado e uma entrega duplicada continua identificável pelo identificador do evento

### Requirement: Provar recuperação de reversão fora de ordem
A suíte DEVE (`MUST`) entregar REFUND ou ROLLBACK antes de sua referência e verificar tanto o sucesso posterior quanto a rejeição por esgotamento da referência.

#### Scenario: Reversão antecede a referência
- **WHEN** a reversão está PENDING_REFERENCE e sua referência válida chega depois
- **THEN** o processamento agendado a conclui exatamente uma vez com uma Wallet reconciliada

### Requirement: Provar consistência após reinicialização
A suíte DEVE (`MUST`) parar e reiniciar processos da aplicação enquanto existirem estado confirmado, mensagens sem confirmação ou linhas não publicadas na Outbox.

#### Scenario: Reinicialização completa do serviço
- **WHEN** todos os processos da aplicação reiniciam usando os mesmos PostgreSQL e SQS
- **THEN** o processamento continua e o saldo de cada Wallet é igual à sua reconstrução pelo Ledger depois que o sistema fica sem trabalho pendente

### Requirement: Afirmar a invariante financeira final
Cada teste de integração ou concorrência que possa alterar uma Wallet DEVE (`MUST`) terminar comparando o saldo armazenado com o saldo exato reconstruído de seu Ledger imutável.

#### Scenario: Finalização do teste financeiro
- **WHEN** um cenário financeiro chega ao estado observável terminal
- **THEN** `saldo da Wallet == saldo reconstruído pelo Ledger` é afirmado antes de o cenário passar
