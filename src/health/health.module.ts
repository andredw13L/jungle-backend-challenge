import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { SqsModule } from '../messaging/sqs.module';
import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

@Module({
  imports: [TerminusModule, SqsModule],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator, SqsHealthIndicator],
})
export class HealthModule {}