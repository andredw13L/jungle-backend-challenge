import { Module } from '@nestjs/common';
import { POOL } from '../infrastructure/database/pool';
import { makePool } from '../infrastructure/database/pool';
import { loadEnv } from '../config/env';
import { ProcessWager } from './process-wager';
import { WagerRepository } from './wager.repository';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: POOL,
      useFactory: () => makePool(loadEnv()),
    },
    WagerRepository,
    ProcessWager,
  ],
  exports: [POOL, WagerRepository, ProcessWager],
})
export class WageringModule {}