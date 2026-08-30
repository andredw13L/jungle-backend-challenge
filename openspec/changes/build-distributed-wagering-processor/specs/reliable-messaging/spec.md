## ADDED Requirements

### Requirement: Consumir comandos SQS pelo processador compartilhado
O consumidor SQS DEVE (`MUST`) validar o mesmo contrato de negócio do HTTP, DEVE chamar `ProcessWager`, DEVE fazer sondagem longa de até dez mensagens por 20 segundos com visibilidade configurável e DEVE processar grupos de Wallet concorrentemente, preservando a ordem dentro de cada grupo.

#### Scenario: Comando válido na fila
- **WHEN** uma mensagem `WagerTransactionRequested` válida é recebida
- **THEN** o processador compartilhado produz o mesmo resultado persistido do comando HTTP equivalente, e a confirmação ocorre somente depois da confirmação no banco

#### Scenario: Grupos de Wallet concorrentes
- **WHEN** um lote recebido contém mensagens para grupos diferentes de Wallet
- **THEN** os grupos podem avançar concorrentemente, enquanto mensagens com a mesma `walletId` permanecem sequenciais

### Requirement: Deduplicar entregas com Inbox transacional
O consumidor DEVE (`MUST`) disputar `(consumerName,messageId)` no PostgreSQL dentro da mesma transação do efeito de negócio, DEVE comparar hashes de conteúdo para uma mensagem existente e DEVE permanecer seguro quando uma duplicata usa um novo identificador de recebimento do SQS.

#### Scenario: Reentrega idêntica
- **WHEN** uma mensagem processada é entregue novamente com o mesmo identificador e hash de conteúdo
- **THEN** nenhum efeito de negócio se repete e o identificador de recebimento atual é confirmado

#### Scenario: Identidade de mensagem conflitante
- **WHEN** um identificador de mensagem existente é reutilizado com outro hash de conteúdo
- **THEN** nenhum estado financeiro muda e o conflito permanente só é repetido para redirecionamento à DLQ

#### Scenario: Nova identidade de mensagem com chave de aposta existente
- **WHEN** uma reentrega contém um novo identificador de mensagem, mas uma chave de idempotência de aposta já processada
- **THEN** a Inbox registra a nova entrega, a reprodução da aposta impede um segundo efeito e a mensagem é confirmada depois da confirmação no banco

### Requirement: Classificar falhas para confirmação e redirecionamento
Resultados de negócio e duplicatas idênticas DEVEM (`MUST`) ser confirmados; mensagens inválidas ou permanentemente conflitantes DEVEM permanecer sem confirmação para a política de DLQ após cinco recebimentos; falhas transitórias de infraestrutura DEVEM permanecer sem confirmação para nova tentativa.

#### Scenario: Mensagem inválida chega à DLQ
- **WHEN** uma mensagem malformada é recebida cinco vezes sem confirmação
- **THEN** o LocalStack a redireciona para `wager-transactions-dlq.fifo`, a métrica da DLQ reflete a mensagem enfileirada e nenhuma linha financeira é criada

#### Scenario: Rejeição de negócio é confirmada
- **WHEN** uma BET válida recebida pela fila é rejeitada por saldo insuficiente
- **THEN** a transação REJECTED e o evento da Outbox são confirmados no banco e a mensagem é excluída

### Requirement: Recuperar referências entregues fora de ordem
Uma referência válida ausente DEVE (`MUST`) persistir a transação como PENDING_REFERENCE, DEVE enfileirar `WagerTransactionPendingReference` e DEVE ser reconsiderada com espera exponencial configurável até o sucesso ou esgotamento.

#### Scenario: Referência chega depois
- **WHEN** um REFUND chega antes de sua BET e a BET é confirmada antes de uma nova tentativa agendada
- **THEN** a nova tentativa resolve a referência e aplica o REFUND exatamente uma vez

#### Scenario: Referência nunca chega
- **WHEN** o limite configurado de tentativas é esgotado
- **THEN** a transação fica REJECTED/REFERENCE_NOT_FOUND e `WagerTransactionRejected` é enfileirado

#### Scenario: Processadores concorrentes de referências pendentes
- **WHEN** múltiplos processos consultam as mesmas referências pendentes vencidas
- **THEN** `SKIP LOCKED` atribui cada linha disponível a no máximo um processador ativo e as garantias do banco impedem efeitos duplicados de reversão

### Requirement: Publicar eventos da Outbox transacional
O processamento financeiro DEVE (`MUST`) persistir os eventos obrigatórios na mesma transação PostgreSQL, e os publicadores DEVEM selecionar um evento vencido com `FOR UPDATE SKIP LOCKED`, publicá-lo em `wager-events.fifo` e marcá-lo como publicado somente depois do sucesso no agente de mensagens.

#### Scenario: Conjunto obrigatório de eventos
- **WHEN** transações são processadas, rejeitadas, ficam com referência pendente ou alteram saldo
- **THEN** a Outbox contém os eventos mínimos correspondentes do README §11 e `WalletBalanceChanged` existe somente quando o saldo muda

#### Scenario: Publicadores concorrentes
- **WHEN** dois processos publicadores consultam as mesmas linhas pendentes da Outbox
- **THEN** `SKIP LOCKED` atribui linhas disponíveis diferentes e cada evento acaba marcado como publicado

#### Scenario: Encerramento abrupto depois da confirmação financeira
- **WHEN** o processo de origem encerra depois da confirmação financeira e antes da publicação
- **THEN** outro publicador encontra e publica a linha durável da Outbox

#### Scenario: Encerramento abrupto depois do envio ao agente de mensagens
- **WHEN** um publicador encerra depois que o SQS aceita um evento, mas antes de o PostgreSQL registrar sua publicação
- **THEN** uma tentativa posterior pode entregar novamente o mesmo identificador de evento sem alterar o estado financeiro original

#### Scenario: Falha no agente de mensagens agenda nova tentativa
- **WHEN** o SQS rejeita ou excede o tempo limite de uma publicação da Outbox
- **THEN** o número de tentativas aumenta, a próxima tentativa usa espera limitada, a linha permanece não publicada e sua transação financeira continua confirmada

### Requirement: Encerrar a mensageria com segurança
Ao receber SIGTERM, a aplicação DEVE (`MUST`) interromper novas sondagens, aguardar os processamentos em andamento dentro de um prazo limitado, deixar mensagens inacabadas sem confirmação ou redefinir sua visibilidade e fechar os clientes SQS e do banco.

#### Scenario: Encerramento com mensagem em processamento
- **WHEN** SIGTERM chega durante o processamento de uma mensagem
- **THEN** o processo confirma no banco e depois no SQS, ou encerra sem confirmação para que outra instância possa fazer uma reentrega segura
