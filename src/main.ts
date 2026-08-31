import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

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
  // ponytail: don't print the host; only the port matters for the harness.
  // eslint-disable-next-line no-console
  console.log(`wagering-processor listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});