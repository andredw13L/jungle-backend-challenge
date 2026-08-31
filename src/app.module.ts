import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/logger.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [ObservabilityModule, HealthModule, AuthModule, WalletsModule],
})
export class AppModule {}