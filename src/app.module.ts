import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { OrmModule } from './infrastructure/database/orm.module';
import { SqsModule } from './messaging/sqs.module';
import { ObservabilityModule } from './observability/logger.module';
import { WalletsModule } from './wallets/wallets.module';
import { WageringModule } from './wagering/wagering.module';

@Module({
  imports: [OrmModule, ObservabilityModule, HealthModule, AuthModule, WalletsModule, WageringModule, SqsModule],
})
export class AppModule {}
