/**
 * Slice 9 process harness — spawns three independent OS processes (ports
 * 3101–3103) running the same `src/main.ts` against the SAME PostgreSQL and
 * SQS. Each instance has its own PID, its own Nest container and its own
 * connection pool; they share only the database and the broker.
 *
 * Fault injection (test-only): FAULT_INJECTION_ENABLED=true is set on every
 * instance; FAULT_INJECT_AFTER_MESSAGE_ID / FAULT_INJECT_PRE_PUBLISH_EVENT_ID
 * are armed per-instance for the crash-after-commit and pre-publish scenarios.
 */
import type { Subprocess } from 'bun';

export interface InstanceFaultConfig {
  /** Crash after commit, before the SQS DeleteMessage, for this SQS message id. */
  afterMessageId?: string;
  /** Fail the outbox claim (rollback) before SendMessage for this event id. */
  prePublishEventId?: string;
}

export interface InstanceHandle {
  port: number;
  instanceId: string;
  pid: number;
  process: Subprocess<'pipe', 'pipe', 'pipe'>;
  /** Incremented on every (re)spawn so the harness can prove a fresh PID. */
  spawnCount: number;
  /** Fault config this handle was (re)spawned with. */
  fault: InstanceFaultConfig;
}

export interface Harness {
  instances: InstanceHandle[];
  /** Spawn all three instances (fresh env each) and wait until each is ready. */
  spawnAll(): Promise<void>;
  /** Wait until every live instance answers /health/ready. */
  waitAllReady(timeoutMs?: number): Promise<void>;
  waitReady(handle: InstanceHandle, timeoutMs?: number): Promise<void>;
  /** Kill an instance, optionally re-arming its fault config on restart. */
  restart(handle: InstanceHandle, fault?: InstanceFaultConfig): Promise<InstanceHandle>;
  sendSignal(handle: InstanceHandle, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /** Resolve once the process has exited (killed or crashed). */
  awaitExit(handle: InstanceHandle, timeoutMs?: number): Promise<void>;
  /** Graceful SIGTERM to every live instance, then SIGKILL stragglers. */
  terminateAll(timeoutMs?: number): Promise<void>;
}

const PORTS = [3101, 3102, 3103] as const;

export function createHarness(baseEnv: NodeJS.ProcessEnv = process.env): Harness {
  const instances: InstanceHandle[] = [];

  const spawnOne = (port: number, index: number, fault: InstanceFaultConfig = {}): InstanceHandle => {
    const instanceId = `instance-${index + 1}`;
    // Short visibility → redeliveries land in ~2s instead of the 60s default.
    // 250ms outbox idle poll keeps publishers responsive without spinning.
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(port),
      INSTANCE_ID: instanceId,
      // Instant polling (no 20s long-poll idle) so bursts drain fast, and a
      // short visibility window so redeliveries land in ~2s.
      SQS_WAIT_SECONDS: '0',
      SQS_VISIBILITY_SECONDS: '2',
      OUTBOX_POLL_INTERVAL_MS: '250',
      FAULT_INJECTION_ENABLED: 'true',
      FAULT_INJECT_AFTER_MESSAGE_ID: fault.afterMessageId ?? '',
      FAULT_INJECT_PRE_PUBLISH_EVENT_ID: fault.prePublishEventId ?? '',
    };
    const process = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      env,
      stdout: 'pipe',
      stdin: 'pipe',
      stderr: 'pipe',
    });
    const handle: InstanceHandle = {
      port,
      instanceId,
      pid: process.pid,
      process,
      spawnCount: 1,
      fault,
    };
    pipeLogs(handle);
    // eslint-disable-next-line no-console
    console.log(`[harness] ${instanceId} spawned pid=${process.pid} port=${port}`);
    instances.push(handle);
    return handle;
  };

  /** Kill any process (not tracked by this harness) that still holds the port. */
  const freePort = async (port: number): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(800) });
        void res;
        // Something answers on this port. If it is one of OUR handles, leave
        // it alone (a fresh boot) — otherwise it is a stale orphan: SIGKILL.
        const tracked = instances.find((h) => h.port === port);
        if (!tracked || tracked.process.exitCode !== null) {
          if (tracked) await sendSignalTo(tracked, 'SIGKILL');
          await sleep(300);
        }
      } catch {
        return; // port is free
      }
    }
  };

  /** Poll until nothing answers on the port (listening socket released). */
  const waitPortFree = async (port: number, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(400) });
      } catch {
        return; // nothing listening — port is free
      }
      await sleep(200);
    }
    throw new Error(`port ${port} never became free within ${timeoutMs}ms`);
  };

  const pipeLogs = (handle: InstanceHandle): void => {
    const tag = `[${handle.instanceId}:${handle.pid}]`;
    for (const stream of [handle.process.stdout, handle.process.stderr]) {
      if (!stream) continue;
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // eslint-disable-next-line no-console
          console.log(tag, decoder.decode(value).trimEnd());
        }
      })().catch(() => undefined);
    }
  };

  const replaceInstance = async (handle: InstanceHandle, fault: InstanceFaultConfig): Promise<InstanceHandle> => {
    await sendSignalTo(handle, 'SIGKILL');
    await awaitExitOf(handle, 5000).catch(() => undefined);
    await waitPortFree(handle.port);
    const idx = instances.indexOf(handle);
    const fresh = spawnOne(handle.port, idx, fault);
    // spawnOne pushes to instances; replace should not grow the array
    instances.pop();
    fresh.spawnCount = handle.spawnCount + 1;
    if (idx !== -1) instances[idx] = fresh;
    else instances.push(fresh);
    await waitReadyOf(fresh);
    return fresh;
  };

  const waitReadyOf = async (handle: InstanceHandle, timeoutMs = 15000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      if (handle.process.exitCode !== null) {
        // Boot failure (e.g. stale port from a previous run) — recover by
        // freeing the port and respawning fresh on the same slot.
        lastErr = new Error(`exited early with code ${handle.process.exitCode}`);
        // eslint-disable-next-line no-console
        console.log(`[harness] ${handle.instanceId} exited early (code ${handle.process.exitCode}); respawning`);
        await freePort(handle.port);
        await sleep(500); // let the listening socket fully release
        const idx = instances.indexOf(handle);
        const fresh = spawnOne(handle.port, idx, currentFaultOf(handle));
        instances.pop();
        fresh.spawnCount = handle.spawnCount + 1;
        if (idx !== -1) instances[idx] = fresh;
        else instances.push(fresh);
        handle = fresh;
        continue;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/health/ready`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.status === 200) return;
        lastErr = new Error(`readiness ${res.status}`);
        // eslint-disable-next-line no-console
        console.log(`[harness] ${handle.instanceId} health/ready → ${res.status}: ${(await res.text()).slice(0, 160)}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(200);
    }
    throw new Error(
      `${handle.instanceId} (pid ${handle.pid}) not ready within ${timeoutMs}ms: ${String(lastErr)}`,
    );
  };

  const currentFaultOf = (handle: InstanceHandle): InstanceFaultConfig => handle.fault;

  const sendSignalTo = async (handle: InstanceHandle, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    if (handle.process.exitCode === null) handle.process.kill(signal);
  };

  const awaitExitOf = async (handle: InstanceHandle, timeoutMs = 10000): Promise<void> => {
    if (handle.process.exitCode !== null) return;
    await Promise.race([
      handle.process.exited,
      sleep(timeoutMs).then(() => {
        throw new Error(`${handle.instanceId} (pid ${handle.pid}) did not exit within ${timeoutMs}ms`);
      }),
    ]);
  };

  return {
    instances,
    spawnAll: async () => {
      // Fresh run — drop any handles left from a previous harness instance
      // (can happen when vitest/bun reuses the worker).
      instances.length = 0;
      // Clear any stale instance from a previous (possibly killed) run so a
      // port collision can never fail the boot.
      for (const port of PORTS) {
        // eslint-disable-next-line no-console
        console.log(`[harness] freeing port ${port}...`);
        await freePort(port);
      }
      // eslint-disable-next-line no-console
      console.log('[harness] ports free, spawning...');
      for (let i = 0; i < PORTS.length; i++) {
        spawnOne(PORTS[i]!, i);
      }
      await Promise.all(instances.map((h) => waitReadyOf(h)));
      // eslint-disable-next-line no-console
      console.log('[harness] all instances ready');
    },
    waitAllReady: async (timeoutMs = 15000) => {
      await Promise.all(instances.map((h) => waitReadyOf(h, timeoutMs)));
    },
    waitReady: (handle, timeoutMs) => waitReadyOf(handle, timeoutMs),
    restart: (handle, fault = {}) => replaceInstance(handle, fault),
    sendSignal: (handle, signal) => sendSignalTo(handle, signal),
    awaitExit: (handle, timeoutMs) => awaitExitOf(handle, timeoutMs),
    terminateAll: async (timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      await Promise.all(instances.map((h) => sendSignalTo(h, 'SIGTERM')));
      for (const h of instances) {
        if (h.process.exitCode === null) {
          try {
            await awaitExitOf(h, deadline - Date.now());
          } catch {
            await sendSignalTo(h, 'SIGKILL');
            await awaitExitOf(h, 5000);
          }
        }
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}