import { Global, Module } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { loadEnv, type AppEnv } from '../config/env';
import { WageringModule } from '../wagering/wagering.module';
import { buildSqsClient } from './sqs.client';
import { InboxRepository } from './inbox.repository';
import { CommandMessageHandler } from './command-message-handler';
import { CommandConsumer } from './command-consumer';
import { ConsumerShutdown } from './consumer-shutdown';
import { OutboxRepository } from './outbox.repository';
import { OutboxPublisher } from './outbox-publisher';
import { LockObserver } from './lock-observer';

const env = loadEnv();

@Global()
@Module({
  imports: [WageringModule],
  providers: [
    { provide: 'SQS_CLIENT', useFactory: () => buildSqsClient(env) },
    { provide: 'APP_ENV', useValue: env as AppEnv },
    // The consumer/handler/publisher type their logger as `LoggerLike` (an
    // interface), which emitDecoratorMetadata compiles to the `Object` token.
    // Alias that token to the nestjs-pino Logger (provided by the global
    // LoggerModule) so the app actually boots and both loops can start.
    { provide: Object, useExisting: Logger },
    InboxRepository,
    CommandMessageHandler,
    CommandConsumer,
    ConsumerShutdown,
    OutboxRepository,
    OutboxPublisher,
    LockObserver,
  ],
  exports: [
    'SQS_CLIENT',
    'APP_ENV',
    InboxRepository,
    CommandMessageHandler,
    CommandConsumer,
    ConsumerShutdown,
    OutboxRepository,
    OutboxPublisher,
    LockObserver,
  ],
})
export class SqsModule {}
