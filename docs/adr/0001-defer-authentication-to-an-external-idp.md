# Adiar a autenticação para um provedor externo de identidade

A autenticação não será implementada porque não vale pontos no desafio e, em produção, seria delegada a um provedor OIDC em vez de armazenar credenciais localmente. Um guard sem efeito e `ProviderIdentityPort` deixam explícito o ponto de integração; os endpoints de health permanecem públicos e o SQS continua sendo um canal interno confiável.
