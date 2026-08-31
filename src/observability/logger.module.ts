import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv } from '../config/env';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * The validated env is captured at module load — process.env is no longer
 * touched after that point. Slices 3+ inject AppEnv into anything that
 * needs it; logger and metrics both depend on it.
 */
const env = loadEnv();

@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        autoLogging: true,
        genReqId: (req) =>
          (req.headers['x-correlation-id'] as string) ?? crypto.randomUUID(),
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
  ],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}