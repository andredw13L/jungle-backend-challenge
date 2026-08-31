import { describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { HealthCheckError, TerminusModule } from '@nestjs/terminus';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

/**
 * Slice 1 evidence: live always succeeds; ready degrades to 503 when a
 * dependency is unreachable. We exercise both code paths without spinning up
 * a real PostgreSQL or LocalStack — the indicators themselves are isolated
 * behind Nest's DI for the controller test.
 */
async function build(options: { pgFails?: boolean; sqsFails?: boolean } = {}) {
  const pg: Partial<PostgresHealthIndicator> = {
    check: async () => {
      if (options.pgFails) {
        throw new HealthCheckError('pg-down', { postgres: { status: 'down' } });
      }
      return { postgres: { status: 'up' } };
    },
  };
  const sqs: Partial<SqsHealthIndicator> = {
    check: async () => {
      if (options.sqsFails) {
        throw new HealthCheckError('sqs-down', { sqs: { status: 'down' } });
      }
      return { sqs: { status: 'up', queues: [] } };
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
      { provide: PostgresHealthIndicator, useValue: pg },
      { provide: SqsHealthIndicator, useValue: sqs },
    ],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  test('live always reports ok', async () => {
    const ctrl = await build();
    expect(ctrl.live()).toEqual({ status: 'ok' });
  });

  test('ready returns success when both dependencies are reachable', async () => {
    const ctrl = await build();
    const result = await ctrl.ready();
    expect(result.status).toBe('ok');
    expect(result.info).toBeDefined();
    expect(Object.keys(result.error ?? {}).length).toBe(0);
  });

  test('ready degrades when PostgreSQL is down', async () => {
    const ctrl = await build({ pgFails: true });
    let caught: unknown;
    try {
      await ctrl.ready();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    const response = (caught as ServiceUnavailableException).getResponse() as {
      status: string;
      error: Record<string, Record<string, unknown>>;
    };
    expect(response.status).toBe('error');
    expect(response.error.postgres?.status).toBe('down');
  });

  test('ready degrades when SQS is down', async () => {
    const ctrl = await build({ sqsFails: true });
    let caught: unknown;
    try {
      await ctrl.ready();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    const response = (caught as ServiceUnavailableException).getResponse() as {
      status: string;
      error: Record<string, Record<string, unknown>>;
    };
    expect(response.status).toBe('error');
    expect(response.error.sqs?.status).toBe('down');
  });

  test('PostgreSQL probe hides connection and query details', async () => {
    const orm = {
      em: {
        fork: () => ({
          getConnection: () => ({
            execute: async () => {
              throw new Error('postgres://u:p@db/wagering SELECT balance_amount');
            },
          }),
        }),
      },
    } as unknown as ConstructorParameters<typeof PostgresHealthIndicator>[0];
    let caught: unknown;
    try {
      await new PostgresHealthIndicator(orm).check('postgres');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HealthCheckError);
    expect((caught as HealthCheckError).causes).toEqual({
      postgres: { status: 'down' },
    });
  });
});
