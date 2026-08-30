# Plano de execução revisável

> Este arquivo descreve a execução futura. Ele **não** autoriza implementação, criação de worktrees, início de subagentes, commits ou pushes. A execução só começa após aprovação explícita do usuário.

## Grafos obrigatórios da futura execução

As duas opções abaixo executam a mesma lista de tarefas e aplicam os mesmos gates. Muda apenas o provedor e o nome de cada papel.

### Perfil A — Codex

Este perfil segue a configuração documentada pela OpenAI em [Custom subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): modelo, esforço de raciocínio, permissões e responsabilidade serão definidos por papel.

```text
APROVAÇÃO EXPLÍCITA DO USUÁRIO
              |
              v
Raiz — integra, verifica identidade Git, commita e publica
              |
              v
Terra supervisor — gpt-5.6-terra / xhigh / somente leitura
              |
       define contrato e arquivos
              |
      +-------+-------+
      |               |
      v               v
Luna executor A   Luna executor B
gpt-5.6-luna     gpt-5.6-luna
xhigh            xhigh
worktree isolada worktree isolada
      |               |
      +-------+-------+
              |
              v
Terra revisa requisito + diff + testes
         |                 |
      REFAZER           APROVADO
         |                 |
         +-> Luna           v
                    Raiz integra e verifica
```

### Perfil B — OpenCode Go

Este perfil usa o mapeamento publicado em [OpenCode Go Preset](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/opencode-go-preset.md) e espelha o caminho crítico do Codex.

```text
APROVAÇÃO EXPLÍCITA DO USUÁRIO
              |
              v
Orchestrator — minimax-m3 / thinking
integra, verifica identidade Git, commita e publica
              |
              v
Oracle supervisor — qwen3.7-max / max / somente leitura
              |
       define contrato e arquivos
              |
      +-------+-------+
      |               |
      v               v
Fixer executor A  Fixer executor B
deepseek-v4-flash / high
worktree isolada worktree isolada
      |               |
      +-------+-------+
              |
              v
Oracle revisa requisito + diff + testes
         |                 |
      REFAZER           APROVADO
         |                 |
         +-> Fixer          v
                    Orchestrator integra e verifica
```

Explorer e Librarian (`deepseek-v4-flash/high`) podem investigar em paralelo e somente em leitura. Designer (`kimi-k2.7-code`) participa apenas de decisões de design; Observer (`mimo-v2.5`) participa apenas quando houver material visual. Eles não substituem Oracle no gate nem Fixer na implementação.

### Início ou retomada — regra compartilhada

```text
Selecionar um perfil para a sessão
              |
              v
Ler Git + checkboxes + commits + testes
       |              |              |
       v              v              v
sem progresso    grupo concluído   diff parcial
       |          com evidência        |
       v              |                v
começar em 1.1        v          retomar a tarefa
                primeira tarefa   sem sobrescrever
                  incompleta
```

- Trocar de Codex para OpenCode Go, ou no sentido contrário, não reinicia o plano: o coordenador retoma a primeira tarefa cujas dependências estejam concluídas e cuja evidência ainda falte.
- A seleção do perfil, a autenticação e a resposta dos agentes são preflight de toda sessão; essa checagem não é pulada quando a tarefa 1.1 já estiver marcada.
- Checkbox sem commit/teste correspondente não comprova conclusão; a tarefa é reaberta. Diff parcial é preservado, revisado e continuado no mesmo grupo.
- No OpenCode Go, reutilizar uma configuração existente. Instalar com `--preset=opencode-go` somente quando ausente; para uma instalação já preparada, selecionar `/preset opencode-go`, garantir Observer habilitado quando necessário, autenticar, atualizar modelos e verificar os agentes antes de retomar. Nunca usar `--reset` automaticamente.
- Um único perfil coordena cada sessão. Os dois perfis nunca escrevem simultaneamente na mesma worktree.

Nomes compartilhados no restante deste arquivo:

- **Coordenador:** Raiz no Codex; Orchestrator no OpenCode Go.
- **Supervisor:** Terra no Codex; Oracle no OpenCode Go.
- **Executor:** Luna no Codex; Fixer no OpenCode Go.

### Regras compartilhadas dos grafos

- A raiz mantém uma Terra supervisora e, no máximo, duas Lunas executoras simultâneas; isso ocupa os quatro slots totais contando a raiz.
- O Orchestrator mantém um Oracle supervisor e, no máximo, dois trabalhos Fixer simultâneos.
- Cada Luna recebe uma tarefa pequena, critérios de aceite e propriedade exclusiva de arquivos em uma worktree isolada. Arquivos compartilhados, migrations, manifesto de dependências e configuração global nunca são editados em paralelo.
- Cada Fixer segue a mesma regra de propriedade exclusiva e worktree isolada.
- Terra não implementa: revisa o diff, executa ou confere as verificações e responde `APROVADO` ou `REFAZER` com evidência objetiva.
- Oracle não implementa: aplica o mesmo gate no OpenCode Go.
- A raiz só integra após `APROVADO`; antes de cada commit ou push confere `git config user.name`, `git config user.email` e `gh api user`, que devem identificar `andredw13L`.
- Orchestrator executa o mesmo preflight antes de integrar ou publicar.
- Cada grupo abaixo termina em comportamento executável, testes verdes e um commit. Nenhum executor publica diretamente.
- Se a propriedade de arquivos se sobrepuser ou o contrato precisar crescer, a tarefa deixa de ser paralela e volta à supervisão.

Dependências entre grupos:

```text
1 -> 2 -> 3 -> 5 -> 6 --+
          |    |     |   |
          +-> 4     +-> 7+-> 9 -> 10
                    +-> 8+
```

Os grupos 4 e 5, e depois 6, 7 e 8, só podem compartilhar uma rodada paralela quando o Supervisor confirmar que os arquivos são disjuntos; no máximo dois Executores trabalham ao mesmo tempo.

## 1. Grafo configurado e aplicação inicializável

**Depende de:** aprovação explícita do usuário.

- [ ] 1.1 [OpenAI Custom subagents; OpenCode Go Preset] Selecionar um único perfil para a sessão e preparar somente seus papéis: `terra-supervisor`/`luna-executor` em `xhigh` no Codex, ou Orchestrator/Oracle/Fixer do preset `opencode-go` sem `--reset`; evidência: perfil ativo e agentes esperados respondendo sem iniciar a implementação.
- [ ] 1.2 [Executar com Bun e Docker Compose] Inicializar o workspace Bun, TypeScript estrito e os três processos NestJS nas portas 3101–3103 com uma única base de código; evidência: build e três processos respondendo localmente.
- [ ] 1.3 [Validar configuração do ambiente de execução; Manter a autenticação externa] Validar variáveis na inicialização e fornecer somente o `ProviderIdentityPort` com guard sem autenticação real; evidência: teste de configuração válida e falha imediata para variável ausente ou inválida.
- [ ] 1.4 [Executar com Bun e Docker Compose] Subir PostgreSQL 16 e LocalStack 3.8.1 no Compose e criar `wager-transactions.fifo`, sua DLQ e `wager-events.fifo`; evidência: script de prontidão confirma as três filas e a conexão com o banco.
- [ ] 1.5 [Separar disponibilidade do processo e prontidão] Implementar liveness local e readiness de PostgreSQL + SQS; evidência: testes mostram liveness saudável com dependência indisponível e readiness degradada.
- [ ] 1.6 Executar instalação limpa, typecheck, build e testes da fatia; o Supervisor registra `APROVADO`, então o Coordenador confere a identidade `andredw13L` e cria o commit da fatia.

## 2. Domínio financeiro puro

**Depende de:** grupo 1.

- [ ] 2.1 [Money exato e imutável] Escrever primeiro testes para escala monetária, arredondamento proibido, moeda incompatível e serialização decimal sem `number`; evidência: testes falham antes da implementação e passam depois.
- [ ] 2.2 [Money exato e imutável; Construção controlada do domínio] Implementar o menor value object `Money` e os factories de criação/reconstituição necessários, reutilizando primitivas da plataforma e sem camada genérica adicional.
- [ ] 2.3 [Invariantes da Wallet; Entrada de Ledger auditável] Escrever testes das transições de saldo, proibição de saldo negativo, versão e imutabilidade/auditoria do Ledger.
- [ ] 2.4 [Máquina de estados de WagerTransaction; Eventos de integração tipados] Implementar Wallet, WagerTransaction, LedgerEntry e eventos tipados com as transições permitidas pelo spec.
- [ ] 2.5 [Verificar o comportamento financeiro puro] Executar a suíte unitária sem PostgreSQL, SQS ou mocks de infraestrutura; o Supervisor revisa as invariantes, aprova e o Coordenador faz o preflight Git e o commit.

## 3. Wallet persistida de ponta a ponta

**Depende de:** grupos 1 e 2.

- [ ] 3.1 [Criar Wallet atomicamente] Escrever testes de integração para migration `up/down`, nomes de constraints, precisão `NUMERIC(18,2)`, versão inicial e imutabilidade do Ledger.
- [ ] 3.2 [Criar Wallet atomicamente] Criar uma migration com as cinco tabelas, constraints, índices e triggers definidos no design; evidência: ciclo `up -> down -> up` em banco limpo.
- [ ] 3.3 [Money exato e imutável] Mapear entidades MikroORM preservando valores monetários como strings decimais na ida e na volta; evidência: teste de round-trip exato.
- [ ] 3.4 [Criar Wallet atomicamente] Implementar criação atômica de Wallet, Ledger de abertura e evento Outbox na mesma transação.
- [ ] 3.5 [Criar Wallet atomicamente; Consultar Wallet] Expor `POST /wallets` e `GET /wallets/:id` com os códigos 201, 404 e 409 definidos no design.
- [ ] 3.6 Executar testes de atomicidade, duplicidade, constraints e round-trip; o Supervisor aprova o diff e o Coordenador confere `andredw13L` antes do commit.

## 4. Ledger paginado e reconciliação

**Depende de:** grupo 3.

- [ ] 4.1 [Paginar o Ledger imutável] Escrever testes do cursor Base64URL `{createdAt,id}`, ordenação estável, limite padrão 50, máximo 100 e cursor inválido.
- [ ] 4.2 [Paginar o Ledger imutável] Implementar `GET /wallets/:id/ledger` com paginação por chave e sem alterar entradas históricas.
- [ ] 4.3 [Reconciliar Wallet e Ledger] Escrever testes para saldo reconciliado, divergência exata e ausência de autocorreção.
- [ ] 4.4 [Reconciliar Wallet e Ledger; Emitir logs estruturados e seguros] Implementar o endpoint de reconciliação, log estruturado e métrica da divergência sem dados sensíveis.
- [ ] 4.5 Executar os testes e consultar diretamente as tabelas para provar a invariante; o Supervisor aprova e o Coordenador faz o preflight Git e o commit.

## 5. BET, WIN, LOSS e idempotência compartilhada

**Depende de:** grupos 2 e 3.

- [ ] 5.1 [Validar contratos de apostas; Persistir idempotência e reprodução] Escrever testes de DTO, hash canônico do payload, repetição idêntica e conflito de chave com payload diferente.
- [ ] 5.2 [Persistir idempotência e reprodução] Implementar `ProcessWager.execute()` com isolamento `READ COMMITTED`, disputa insert-first da constraint e reprodução do resultado persistido.
- [ ] 5.3 [Serializar por Wallet as operações que alteram saldo; Aplicar as regras de BET, WIN e LOSS] Implementar BET e WIN com `FOR UPDATE`, LOSS sem lock de Wallet, e persistir Wallet, WagerTransaction, Ledger e Outbox atomicamente.
- [ ] 5.4 [Consultar transações de apostas; Distinguir resultados de erros de infraestrutura] Expor comandos e consultas HTTP com os mapeamentos 200, 202, 404, 409, 422 e 503 do design.
- [ ] 5.5 [Verificar integração com PostgreSQL e SQS; Provar correção na disputa por saldo] Executar testes reais de rollback, idempotência concorrente, disputa por saldo e independência entre Wallets.
- [ ] 5.6 O Supervisor confere regras financeiras, SQL/locks e evidências; somente após `APROVADO` o Coordenador verifica `andredw13L` e cria o commit.

## 6. Reversões e referências fora de ordem

**Depende de:** grupo 5.

- [ ] 6.1 [Aplicar reversões integrais uma única vez] Escrever testes para REFUND/ROLLBACK integral, direção correta, referência compatível, execução única e proibição de saldo negativo.
- [ ] 6.2 [Aplicar reversões integrais uma única vez] Implementar reversões travando a Wallet antes de ler a referência e persistindo resultado, Ledger e Outbox na mesma transação.
- [ ] 6.3 [Recuperar referências entregues fora de ordem] Implementar estado pendente e worker de nova tentativa com uma linha por transação, `FOR UPDATE SKIP LOCKED`, máximo 8, base 1 s e teto 60 s configuráveis.
- [ ] 6.4 [Provar recuperação de reversão fora de ordem] Testar referência posterior, concorrência entre workers, esgotamento e reinicialização com PostgreSQL real.
- [ ] 6.5 O Supervisor revisa ordem dos locks, limites e evidências; após aprovação, o Coordenador executa o preflight Git e cria o commit.

## 7. Consumo SQS com Inbox e DLQ

**Depende de:** grupo 5.

- [ ] 7.1 [Consumir comandos SQS pelo processador compartilhado] Implementar recepção FIFO com lote até 10, long polling de 20 s, visibility timeout de 60 s configurável e encaminhamento ao mesmo `ProcessWager.execute()` usado pelo HTTP.
- [ ] 7.2 [Consumir comandos SQS pelo processador compartilhado] Agrupar o lote por Wallet, processar sequencialmente dentro do grupo e permitir paralelismo somente entre Wallets diferentes.
- [ ] 7.3 [Deduplicar entregas com Inbox transacional] Persistir Inbox e efeito financeiro na mesma transação, confirmando a mensagem apenas depois do commit.
- [ ] 7.4 [Classificar falhas para confirmação e redirecionamento] Confirmar resultados de negócio, repetir falhas transitórias e deixar falhas inválidas/permanentes chegarem à DLQ após cinco recebimentos.
- [ ] 7.5 [Encerrar a mensageria com segurança] Parar novas leituras e aguardar o trabalho em curso dentro do limite configurado.
- [ ] 7.6 [Verificar integração com PostgreSQL e SQS] Executar no LocalStack testes de redelivery, novo messageId, conflito idempotente, DLQ e shutdown; o Supervisor aprova e o Coordenador faz preflight Git e commit.

## 8. Publicação Outbox e observabilidade

**Depende de:** grupos 3 e 5.

- [ ] 8.1 [Publicar eventos da Outbox transacional] Implementar publisher que busca uma linha vencida por transação com `FOR UPDATE SKIP LOCKED`, publica mantendo o lock e marca sucesso ou reagenda falha.
- [ ] 8.2 [Publicar eventos da Outbox transacional] Manter `eventId` estável, deduplicação FIFO como otimização e ciclo imediato quando há trabalho, com espera de 1 s quando vazio.
- [ ] 8.3 [Emitir logs estruturados e seguros; Expor métricas obrigatórias] Adicionar somente os logs e as sete métricas exigidas pelo spec, incluindo contexto de correlação sem payload financeiro sensível.
- [ ] 8.4 [Provar publicação concorrente da Outbox] Testar dois publishers, indisponibilidade do broker, falha após publicação antes da confirmação no banco e possível duplicata com o mesmo `eventId`.
- [ ] 8.5 O Supervisor revisa lock, repetição, métricas e evidências; após `APROVADO`, o Coordenador confere a identidade Git e cria o commit.

## 9. Provas distribuídas e de recuperação

**Depende de:** grupos 4, 6, 7 e 8.

- [ ] 9.1 [Provar três instâncias independentes da aplicação] Criar harness que inicia três processos do sistema operacional nas portas 3101–3103 contra o mesmo PostgreSQL e SQS.
- [ ] 9.2 [Provar idempotência sob entrega paralela] Enviar pelo menos 50 duplicatas HTTP/SQS da mesma operação entre as três instâncias e provar um único efeito financeiro.
- [ ] 9.3 [Provar correção na disputa por saldo; Provar o progresso independente de Wallets] Disputar saldo da mesma Wallet e, no mesmo teste, demonstrar progresso simultâneo de três Wallets distintas.
- [ ] 9.4 [Provar recuperação depois da confirmação e antes da confirmação no SQS] Encerrar um processo após commit e antes do ack, reiniciar e provar redelivery sem efeito duplicado.
- [ ] 9.5 [Provar publicação concorrente da Outbox; Provar recuperação de reversão fora de ordem; Provar consistência após reinicialização] Cobrir dois publishers, reversão antes da referência e reinicialização com estado persistido.
- [ ] 9.6 [Afirmar a invariante financeira final] Ao final de cada cenário, consultar Wallet, Ledger, WagerTransaction, Inbox e Outbox e afirmar saldo, cardinalidade e versões exatas.
- [ ] 9.7 Executar a suíte distribuída completa; o Supervisor só aprova com três PIDs/portas e consultas finais registradas, então o Coordenador faz preflight Git e commit.

## 10. Entrega reproduzível

**Depende de:** grupos 1–9.

- [ ] 10.1 [Executar com Bun e Docker Compose] Finalizar Dockerfile e Compose para construir e iniciar toda a solução a partir de clone limpo com os comandos documentados.
- [ ] 10.2 Atualizar README e ARCHITECTURE com setup, decisões, endpoints, filas, processos, invariantes, riscos e comandos reais de verificação, sem material de estudo pessoal.
- [ ] 10.3 Executar migration `up -> down -> up`, typecheck, build e todas as suítes unitárias, integração LocalStack/PostgreSQL e distribuídas em ambiente limpo.
- [ ] 10.4 Conferir requisito por requisito do README e dos seis specs, anexando a cada item o teste ou comando que o prova; qualquer lacuna volta ao grupo responsável.
- [ ] 10.5 Manter ledger de partidas dobradas, OpenTelemetry, dashboard e teste de carga fora desta mudança; incluir teste de carga somente mediante aprovação separada depois de todos os requisitos obrigatórios verdes.
- [ ] 10.6 O Supervisor realiza a revisão final de spec, diff e evidências; após `APROVADO`, o Coordenador confere `andredw13L`, cria o commit final e só publica se essa ação continuar autorizada.
