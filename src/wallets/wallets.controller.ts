import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CreateWalletSchema, type CreateWalletDto } from './dto/create-wallet.dto';
import { WalletCreationService } from './wallet-creation.service';

/**
 * WalletsController — POST creates a wallet atomically (201), GET reads
 * one by id (200/404). Validation is enforced by zod (`CreateWalletSchema`)
 * before the service runs, so no bad payload ever reaches the database.
 */
@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WalletCreationService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const parsed = CreateWalletSchema.safeParse(body);
    if (!parsed.success) {
      return {
        code: 'INVALID_PAYLOAD',
        issues: parsed.error.issues,
      };
    }
    const wallet = await this.service.create(parsed.data as CreateWalletDto, correlationId);
    return toWalletResponse(wallet);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const wallet = await this.service.findById(id);
    return toWalletResponse(wallet);
  }
}

function toWalletResponse(w: {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  balanceCurrency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: { amount: w.balanceAmount, currency: w.balanceCurrency },
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}