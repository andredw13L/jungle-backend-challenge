import { Module } from '@nestjs/common';
import { WalletRepository } from '../infrastructure/database/wallet.repository';
import { WalletCreationService } from './wallet-creation.service';
import { WalletsController } from './wallets.controller';
import { LedgerRepository } from './ledger.repository';

@Module({
  controllers: [WalletsController],
  providers: [
    WalletRepository,
    LedgerRepository,
    WalletCreationService,
  ],
  exports: [WalletRepository, LedgerRepository, WalletCreationService],
})
export class WalletsModule {}
