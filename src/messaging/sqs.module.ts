import { Global, Module } from '@nestjs/common';
import { loadEnv, type AppEnv } from '../config/env';
import { WageringModule } from '../wagering/wagering.module';
import { buildSqsClient } from './sqs.client';
import { InboxRepository } from './inbox.repository';
import { CommandMessageHandler } from './command-message-handler';
import { CommandConsumer } from './command-consumer';
import { ConsumerShutdown } from './consumer-shutdown';

const env = loadEnv();

@Global()
@Module({
  imports: [WageringModule],
  providers: [
    { provide: 'SQS_CLIENT', useFactory: () => buildSqsClient(env) },
    { provide: 'APP_ENV', useValue: env as AppEnv },
    InboxRepository,
    CommandMessageHandler,
    CommandConsumer,
    ConsumerShutdown,
  ],
  exports: [
    'SQS_CLIENT',
    'APP_ENV',
    InboxRepository,
    CommandMessageHandler,
    CommandConsumer,
    ConsumerShutdown,
  ],
})
export class SqsModule {}
