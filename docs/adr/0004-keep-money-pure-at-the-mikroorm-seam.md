# Keep Money pure at the MikroORM seam

`Money` has no framework or ORM dependency and calculates with decimal strings, while domain entities may carry MikroORM persistence decorators over string fields mapped to PostgreSQL `NUMERIC(18,2)`. This explicit seam avoids duplicate persistence models without allowing NestJS decorators or ORM monetary types into the financial model.
