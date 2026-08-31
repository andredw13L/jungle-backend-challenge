import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { AppEnv } from '../config/env';

/**
 * Build a single SQSClient per process. LocalStack requires a static
 * endpoint URL; AWS_REGION still has to be a valid region name.
 */
export function buildSqsClient(env: AppEnv): SQSClient {
  const config: ConstructorParameters<typeof SQSClient>[0] = {
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  };
  if (env.AWS_ENDPOINT_URL) {
    config.endpoint = env.AWS_ENDPOINT_URL;
  }
  return new SQSClient(config);
}

/** Closes the shared SDK client when Nest tears down the application. */
@Injectable()
export class SqsClientShutdown implements OnApplicationShutdown {
  constructor(@Inject('SQS_CLIENT') private readonly client: SQSClient) {}

  onApplicationShutdown(_signal?: string): void {
    this.client.destroy();
  }
}

/**
 * Resolve the localstack queue URL for a queue name. LocalStack keeps the
 * region/account suffix as `000000000000`; we build the URL locally instead
 * of a ListQueues round-trip on every poll.
 */
export function queueUrl(env: AppEnv, name: string): string {
  const base = env.AWS_ENDPOINT_URL ?? `https://sqs.${env.AWS_REGION}.amazonaws.com`;
  return `${base}/000000000000/${name}`;
}

/**
 * Liveness ping used by the health indicator. We only fetch the queue's
 * ApproximateNumberOfMessages attribute — the cheapest read that proves the
 * broker is alive.
 */
export async function sqsPing(client: SQSClient, url: string): Promise<void> {
  await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }));
}
