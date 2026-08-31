import { Inject, Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from '../config/env';
import type { CommandConsumer } from './command-consumer';
import type { OutboxPublisher } from './outbox-publisher';

/**
 * ConsumerShutdown — coordinates graceful shutdown for the command consumer
 * and (slice 8) the outbox publisher.
 *
 * Both loops register their in-flight work against this single coordinator
 * (`beginWork`/`endWork`), so `signalShutdown()` stops new polls and
 * `waitForDrained`/`drainAll` waits for every in-flight transaction. `run()`
 * wires the drain → app.close() → exit sequence for the SIGTERM/SIGINT
 * handlers in main.ts.
 */
@Injectable()
export class ConsumerShutdown {
  private shuttingDown = false;
  private inflight = 0;
  private drainedResolvers: (() => void)[] = [];

  constructor(@Inject('APP_ENV') private readonly env: AppEnv) {}

  signalShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inflightCount(): number {
    return this.inflight;
  }

  beginWork(): void {
    this.inflight++;
  }

  endWork(): void {
    this.inflight--;
    if (this.inflight <= 0) {
      this.inflight = 0;
      const resolvers = this.drainedResolvers;
      this.drainedResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  async waitForDrained(timeoutMs: number): Promise<boolean> {
    if (this.inflight === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.drainedResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Generalised drain covering every worker that reports in-flight work
   * against this coordinator (command consumer + outbox publisher).
   */
  drainAll(timeoutMs: number): Promise<boolean> {
    return this.waitForDrained(timeoutMs);
  }

  /** Full drain → close → exit sequence used by the process signal handlers. */
  async run(
    app: INestApplication,
    consumer: CommandConsumer,
    publisher?: OutboxPublisher,
  ): Promise<void> {
    void consumer; // signalled via signalShutdown(); loops observe isShuttingDown()
    this.signalShutdown();
    // Let the publisher's loop observe shutdown and return (it may be
    // mid-sleep after draining its in-flight work); bounded by its own
    // timeout so process.exit always follows.
    if (publisher) {
      await Promise.race([
        publisher.waitForStopped(),
        sleep(this.env.OUTBOX_SHUTDOWN_TIMEOUT_MS),
      ]);
    }
    const drained = await this.drainAll(this.env.SHUTDOWN_TIMEOUT_MS);
    try {
      await app.close();
    } catch {
      process.exit(1);
    }
    process.exit(drained ? 0 : 1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
