import { Module } from '@nestjs/common';
import { POOL } from '../infrastructure/database/pool';
import { makePool } from '../infrastructure/database/pool';
import { loadEnv } from '../config/env';
import { WalletRepository } from '../infrastructure/database/wallet.repository';
import { WalletCreationService } from './wallet-creation.service';
import { WalletsController } from './wallets.controller';
import { LedgerRepository } from './ledger.repository';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: POOL,
      useFactory: () => makePool(loadEnv()),
    },
    WalletRepository,
    LedgerRepository,
    WalletCreationService,
  ],
  exports: [POOL, WalletRepository, LedgerRepository, WalletCreationService],
})
export class WalletsModule {}