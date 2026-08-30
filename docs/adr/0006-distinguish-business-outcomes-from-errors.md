# Distinguir resultados de negócio de erros

Operações processadas, reproduções idempotentes e rejeições de negócio retornam resultados HTTP bem-sucedidos; referências pendentes retornam `202`; violações de contrato usam respostas `4xx` estáveis; e falhas transitórias de infraestrutura usam `503`. Códigos de falha estáveis e legíveis por máquina permitem que os provedores decidam se devem tentar novamente sem interpretar mensagens destinadas a pessoas.
