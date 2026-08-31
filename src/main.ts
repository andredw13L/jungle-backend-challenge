import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { CommandConsumer } from './messaging/command-consumer';
import { ConsumerShutdown } from './messaging/consumer-shutdown';

/**
 * Boot a single NestJS instance. The same codebase runs on PORT 3101, 3102
 * and 3103 per the design — see README §10 and the slice 1 task.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  await app.listen(env.PORT);

  // Start the SQS command consumer once the HTTP listener is up.
  const consumer = app.get(CommandConsumer);
  const shutdown = app.get(ConsumerShutdown);
  void consumer.start();

  // Manual signal handlers: NestJS shutdown hooks only fire on app.close(),
  // and the slice-9 harness sends SIGTERM to a dedicated test process.
  process.on('SIGTERM', () => void shutdown.run(app, consumer));
  process.on('SIGINT', () => void shutdown.run(app, consumer));

  // ponytail: don't print the host; only the port matters for the harness.
  // eslint-disable-next-line no-console
  console.log(`wagering-processor listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});