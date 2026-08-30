## ADDED Requirements

### Requirement: Validar configuração do ambiente de execução
O processo Bun DEVE (`MUST`) validar as configurações obrigatórias de PostgreSQL, SQS, região, filas, porta e novas tentativas antes de o NestJS começar a escutar, e DEVE rejeitar intervalos numéricos inválidos ou valores ausentes com um erro claro de inicialização.

#### Scenario: URL do banco ausente
- **WHEN** a aplicação inicia sem a URL do banco
- **THEN** a inicialização falha antes de aceitar tráfego e identifica a variável ausente sem imprimir segredos

### Requirement: Separar disponibilidade do processo e prontidão
`GET /health/live` DEVE (`MUST`) informar somente se o processo está vivo, enquanto `GET /health/ready` DEVE verificar o PostgreSQL e as filas SQS obrigatórias e retornar `503` quando uma dependência estiver indisponível; nenhuma das rotas exige autenticação.

#### Scenario: PostgreSQL indisponível
- **WHEN** o PostgreSQL para enquanto o processo continua vivo
- **THEN** a disponibilidade do processo continua bem-sucedida e a prontidão passa a retornar `503`

#### Scenario: Filas obrigatórias disponíveis
- **WHEN** o PostgreSQL, a fila de comandos e a fila de eventos estão acessíveis
- **THEN** a prontidão retorna sucesso com detalhes das dependências que não contêm credenciais

### Requirement: Emitir logs estruturados e seguros
O serviço DEVE (`MUST`) emitir logs JSON contendo os identificadores disponíveis de correlação, mensagem, transação, Wallet e provedor, e NÃO DEVE registrar tokens de acesso, credenciais nem conteúdos financeiros completos.

#### Scenario: Log de requisição de aposta
- **WHEN** uma requisição de aposta termina
- **THEN** seu log estruturado contém identificadores de correlação e das entidades, além do resultado, mas omite o corpo da requisição e o objeto Money exato

### Requirement: Expor métricas obrigatórias
`GET /metrics` DEVE (`MUST`) expor, no formato Prometheus, resultados das transações, duplicatas, novas tentativas, mensagens na DLQ, conflitos de bloqueio, atraso da Outbox e latência de processamento.

#### Scenario: Métrica de requisição duplicada
- **WHEN** uma aposta idêntica é reproduzida
- **THEN** o contador de duplicatas aumenta sem incrementar a quantidade de efeitos financeiros

#### Scenario: Métrica de atraso da Outbox
- **WHEN** um evento não publicado da Outbox envelhece
- **THEN** o medidor de atraso reflete os segundos decorridos sem expor seu conteúdo

### Requirement: Encerrar a aplicação de forma controlada
A aplicação DEVE (`MUST`) habilitar os gatilhos de encerramento do NestJS e coordenar recursos HTTP, processadores, SQS, MikroORM e métricas sem aceitar novo trabalho depois do início do encerramento.

#### Scenario: SIGTERM
- **WHEN** o processo recebe SIGTERM
- **THEN** as sondagens param, o trabalho em andamento é concluído com segurança e todos os clientes são fechados antes do término do processo ou do tempo limite

### Requirement: Manter a autenticação externa
As rotas financeiras DEVEM (`MUST`) expor um guard sem efeito e um ponto de extensão `ProviderIdentityPort` para um futuro provedor OIDC externo, NÃO DEVEM implementar credenciais locais nem emissão de tokens e DEVEM deixar os endpoints de health abertos.

#### Scenario: Ambiente do desafio sem provedor de identidade
- **WHEN** o serviço inicia no ambiente documentado do desafio
- **THEN** as rotas financeiras permanecem utilizáveis pelo adaptador explícito sem efeito e não existe tabela de credenciais de usuários

### Requirement: Executar com Bun e Docker Compose
Instalação, execução, verificação de tipos, migrations e testes DEVEM (`MUST`) usar comandos Bun documentados, e o Docker Compose DEVE fornecer PostgreSQL, LocalStack 3.8.1 fixado, inicialização das filas FIFO de comandos, DLQ e eventos com deduplicação baseada em conteúdo e a aplicação com dependências condicionadas à saúde.

#### Scenario: Inicialização local limpa
- **WHEN** um avaliador segue os comandos documentados a partir de um clone limpo
- **THEN** as dependências são instaladas, as migrations são aplicadas, as filas existem e a aplicação fica pronta sem configuração manual do banco ou do agente de mensagens
