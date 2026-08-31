import { Inject, Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from '../config/env';
import type { CommandConsumer } from './command-consumer';

/**
 * ConsumerShutdown — coordinates graceful shutdown for the command consumer.
 *
 * `signalShutdown()` stops the polling loop from starting new polls;
 * `waitForDrained(timeoutMs)` waits for in-flight messages to finish their
 * transaction (or returns false on the hard deadline). `run()` wires the
 * drain → app.close() → exit sequence for the SIGTERM/SIGINT handlers in
 * main.ts.
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

  /** Full drain → close → exit sequence used by the process signal handlers. */
  async run(app: INestApplication, consumer: CommandConsumer): Promise<void> {
    void consumer; // the consumer is signalled via signalShutdown(); the loop observes isShuttingDown()
    this.signalShutdown();
    const drained = await this.waitForDrained(this.env.SHUTDOWN_TIMEOUT_MS);
    try {
      await app.close();
    } catch {
      process.exit(1);
    }
    process.exit(drained ? 0 : 1);
  }
}
