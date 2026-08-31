import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { CommandConsumer } from './messaging/command-consumer';
import { ConsumerShutdown } from './messaging/consumer-shutdown';
import { OutboxPublisher } from './messaging/outbox-publisher';
import { PendingReferenceWorker } from './wagering/pending-reference.worker';

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
  await app.listen(env.PORT);

  // Start the SQS command consumer, the outbox publisher and the
  // pending-reference worker once the HTTP listener is up.
  const consumer = app.get(CommandConsumer);
  const publisher = app.get(OutboxPublisher);
  const pendingReference = app.get(PendingReferenceWorker);
  const shutdown = app.get(ConsumerShutdown);
  void consumer.start();
  void publisher.start();

  // Slice 9 wires the pending-reference worker into the process loop so the
  // distributed harness can prove out-of-order reversal recovery (spec:
  // "Processadores concorrentes de referências pendentes"). The loop is
  // registered against the shared shutdown coordinator like the other two.
  const pendingReferenceLoop = startPendingReferenceLoop(pendingReference, shutdown, 1000);

  // One controlled route: stop loops, drain in-flight work, close Nest (which
  // still invokes module teardown hooks) and
  // its SQS/ORM hooks), then apply the exit code.
  registerShutdownHandlers(app, consumer, publisher, pendingReferenceLoop, shutdown);

  // ponytail: don't print the host; only the port matters for the harness.
  // eslint-disable-next-line no-console
  console.log(`wagering-processor listening on :${env.PORT}`);
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal boot error:', err);
    process.exit(1);
  });
}

export function registerShutdownHandlers(
  app: NestExpressApplication,
  consumer: CommandConsumer,
  publisher: OutboxPublisher,
  pendingReference: { waitForStopped(): Promise<void> },
  shutdown: ConsumerShutdown,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let completion: Promise<number> | undefined;
  const onSignal = (): void => {
    completion ??= shutdown.run(app, consumer, publisher, pendingReference).then((code) => {
      exit(code);
      return code;
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM' as never, onSignal);
    process.off('SIGINT' as never, onSignal);
  };
}

/**
 * Pending-reference polling loop (slice 9). One due row per cycle, 1s idle
 * sleep — the same cadence the design specifies for out-of-order reversal
 * recovery. Registers each batch against the shared shutdown coordinator so
 * graceful SIGTERM drains in-flight work before exit.
 */
function startPendingReferenceLoop(
  worker: PendingReferenceWorker,
  shutdown: ConsumerShutdown,
  idleMs: number,
): { waitForStopped(): Promise<void> } {
  let running = true;
  const stopped = (async () => {
    while (running) {
      if (shutdown.isShuttingDown()) break;
      shutdown.beginWork();
      try {
        await worker.processBatch();
      } catch {
        // Transient DB failure — the next cycle retries.
      } finally {
        shutdown.endWork();
      }
      await sleep(idleMs);
    }
  })().catch(() => undefined);
  return {
    waitForStopped: async () => {
      running = false;
      await stopped;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
