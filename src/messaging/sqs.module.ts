import { Global, Module } from '@nestjs/common';
import { loadEnv, type AppEnv } from '../config/env';
import { buildSqsClient } from './sqs.client';

const env = loadEnv();

@Global()
@Module({
  providers: [
    { provide: 'SQS_CLIENT', useFactory: () => buildSqsClient(env) },
    { provide: 'APP_ENV', useValue: env as AppEnv },
  ],
  exports: ['SQS_CLIENT', 'APP_ENV'],
})
export class SqsModule {}