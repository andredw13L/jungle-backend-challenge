import { describe, expect, test } from 'bun:test';
import { registerShutdownHandlers } from './main';

describe('main shutdown signals', () => {
  test('runs one controlled drain for repeated SIGTERM/SIGINT and exits after it', async () => {
    let runs = 0;
    const exits: number[] = [];
    const cleanup = registerShutdownHandlers(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        run: async () => {
          runs++;
          await Promise.resolve();
          return 0;
        },
      } as never,
      (code) => exits.push(code),
    );
    try {
      process.emit('SIGTERM');
      process.emit('SIGINT');
      await Promise.resolve();
      await Promise.resolve();

      expect(runs).toBe(1);
      expect(exits).toEqual([0]);
    } finally {
      cleanup();
    }
  });
});
