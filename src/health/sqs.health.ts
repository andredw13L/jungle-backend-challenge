import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, type HealthIndicatorResult } from '@nestjs/terminus';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AppEnv } from '../config/env';
import { queueUrl, sqsPing } from '../messaging/sqs.client';

/**
 * SQS readiness indicator. Pings the three mandatory FIFO queues — the two
 * command-queue siblings plus the events queue — in parallel. Any failure
 * degrades readiness to 503; the live route stays green.
 */
@Injectable()
export class SqsHealthIndicator {
  constructor(
    @Inject('SQS_CLIENT') private readonly client: SQSClient,
    @Inject('APP_ENV') private readonly env: AppEnv,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const urls = [
      queueUrl(this.env, this.env.QUEUE_COMMAND),
      queueUrl(this.env, this.env.QUEUE_COMMAND_DLQ),
      queueUrl(this.env, this.env.QUEUE_EVENTS),
    ];

    const probes = await Promise.all(
      urls.map(
        async (url): Promise<{ queue: string; ok: boolean; error?: string }> => {
          try {
            await sqsPing(this.client, url);
            return { queue: url.split('/').pop() ?? url, ok: true };
          } catch (err) {
            return {
              queue: url.split('/').pop() ?? url,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      ),
    );

    const failing = probes.filter((p) => !p.ok);
    const result: HealthIndicatorResult = {
      [key]: { status: failing.length === 0 ? 'up' : 'down', queues: probes },
    };
    if (failing.length > 0) {
      throw new HealthCheckError('SQS not ready', result);
    }
    return result;
  }
}