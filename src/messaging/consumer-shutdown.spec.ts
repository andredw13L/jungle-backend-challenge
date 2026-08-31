import { describe, expect, test } from 'bun:test';
import { ConsumerShutdown } from './consumer-shutdown';
import { makeEnv } from '../config/env';

describe('ConsumerShutdown', () => {
  test('waits for in-flight work and reports a timeout without exiting the runner', async () => {
    const shutdown = new ConsumerShutdown(makeEnv({ SHUTDOWN_TIMEOUT_MS: '1000' }));
    shutdown.beginWork();
    const app = { close: async () => undefined };
    const exitCode = await shutdown.run(app as never, {} as never);
    expect(exitCode).toBe(1);
    expect(shutdown.isShuttingDown()).toBe(true);
    shutdown.endWork();
  });

  test('closes a clean application with code zero', async () => {
    let closed = false;
    const shutdown = new ConsumerShutdown(makeEnv());
    const app = { close: async () => { closed = true; } };
    const exitCode = await shutdown.run(app as never, {} as never);
    expect(exitCode).toBe(0);
    expect(closed).toBe(true);
  });
});
