import { Module } from '@nestjs/common';
import { ProcessWager } from './process-wager';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WagerRepository } from './wager.repository';
import { ProviderWageringController, WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController, ProviderWageringController],
  providers: [
    WagerRepository,
    ProcessWager,
    PendingReferenceWorker,
  ],
  exports: [WagerRepository, ProcessWager, PendingReferenceWorker],
})
export class WageringModule {}
