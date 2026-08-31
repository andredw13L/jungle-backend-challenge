import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

/**
 * Two endpoints per the operational-readiness spec:
 *
 * - `/health/live` returns 200 as long as the process is alive.
 * - `/health/ready` returns 200 only when PostgreSQL and the three SQS FIFO
 *   queues are reachable. Otherwise it returns 503 — see the spec's degraded
 *   readiness scenario.
 *
 * Neither endpoint is protected by the no-op identity guard.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly pg: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.pg.check('postgres'),
      () => this.sqs.check('sqs'),
    ]);
  }
}