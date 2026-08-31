import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import {
  MikroORM,
  PostgreSqlDriver,
  type EntityManager as PostgreSqlEntityManager,
  type Options,
} from '@mikro-orm/postgresql';
import type { AppEnv } from '../../config/env';
import { SqsModule } from '../../messaging/sqs.module';
import { MIKRO_ORM, ORM_ENTITIES } from './entities';

export { MIKRO_ORM } from './entities';

type LazyPostgresOptions = Partial<Options<PostgreSqlEntityManager, typeof ORM_ENTITIES>> & {
  connect: false;
};

export function createOrm(
  env: AppEnv,
): Promise<MikroORM<PostgreSqlEntityManager, typeof ORM_ENTITIES>> {
  const options: LazyPostgresOptions = {
    driver: PostgreSqlDriver,
    clientUrl: env.DATABASE_URL,
    driverOptions: {
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    },
    // Three application instances plus the test process share one PostgreSQL.
    // Ten connections per process keeps that deployment below PostgreSQL's
    // default 100-connection limit; excess requests wait in the pool.
    pool: { max: 10 },
    entities: ORM_ENTITIES,
    connect: false,
    ensureDatabase: false,
  };
  return MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager, typeof ORM_ENTITIES>(options);
}

export type AppOrm = Awaited<ReturnType<typeof createOrm>>;

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: Awaited<ReturnType<typeof createOrm>>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Global()
@Module({
  imports: [SqsModule],
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: (env: AppEnv) => createOrm(env),
      inject: ['APP_ENV'],
    },
    OrmShutdown,
  ],
  exports: [MIKRO_ORM],
})
export class OrmModule {}
