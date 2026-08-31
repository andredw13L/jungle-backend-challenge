ficar# Adiar a autenticação para um provedor externo de identidade

## Decisão

A autenticação não será implementada nesta entrega. O README a trata como opcional e orienta que ela não deve competir com correção financeira, concorrência e idempotência. Se fosse implementada, o próprio enunciado recomenda integrar um provedor OIDC externo: não criar tabela local de usuários, hash de senha ou emissão artesanal de tokens.

O código manterá um guard sem efeito e o `ProviderIdentityPort` como seam explícito para uma futura integração com Keycloak, Zitadel ou provedor equivalente. Os endpoints de health permanecem públicos, conforme o contrato, e o SQS é tratado como canal interno confiável; a identidade do provedor nas mensagens continua sujeita à validação de domínio.

## Consequências

Essa decisão mantém o foco nas garantias financeiras e evita uma autenticação incompleta. A integração OIDC poderá ser adicionada posteriormente substituindo o adaptador, sem alterar o domínio financeiro nem armazenar credenciais localmente.
