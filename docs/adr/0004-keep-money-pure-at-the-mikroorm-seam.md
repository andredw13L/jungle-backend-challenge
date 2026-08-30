# Manter Money puro na fronteira com o MikroORM

`Money` não depende de framework nem de ORM e calcula com strings decimais, enquanto as entidades de domínio podem usar decoradores de persistência do MikroORM em campos string mapeados para `NUMERIC(18,2)` no PostgreSQL. Essa fronteira explícita evita modelos duplicados de persistência sem permitir decoradores do NestJS nem tipos monetários do ORM no modelo financeiro.
