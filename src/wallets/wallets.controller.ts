import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreateWalletSchema, type CreateWalletDto } from './dto/create-wallet.dto';
import { LedgerQuerySchema } from './dto/ledger-query.dto';
import { decodeLedgerCursor } from './ledger-cursor';
import { LedgerRepository } from './ledger.repository';
import { WalletCreationService } from './wallet-creation.service';

/**
 * WalletsController — POST creates a wallet atomically (201), GET reads
 * one by id (200/404), `GET /:id/ledger` paginates the immutable audit
 * trail (cursor + limit, 422 on bad cursor), `POST /:id/reconciliation`
 * reports divergence without mutating state (200, 404).
 */
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly service: WalletCreationService,
    private readonly ledgerRepo: LedgerRepository,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const parsed = CreateWalletSchema.safeParse(body);
    if (!parsed.success) {
      return { code: 'INVALID_PAYLOAD', issues: parsed.error.issues };
    }
    const wallet = await this.service.create(parsed.data as CreateWalletDto, correlationId);
    return toWalletResponse(wallet);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const wallet = await this.service.findById(id);
    return toWalletResponse(wallet);
  }

  @Get(':id/ledger')
  async ledger(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const parsed = LedgerQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        code: 'INVALID_QUERY',
        issues: parsed.error.issues,
      });
    }
    let cursor = null;
    if (parsed.data.cursor) {
      cursor = decodeLedgerCursor(parsed.data.cursor);
      if (!cursor) {
        throw new UnprocessableEntityException({
          code: 'INVALID_CURSOR',
          message: 'cursor is malformed',
        });
      }
    }
    await this.service.findById(id); // 404 if missing — surface before reading ledger
    const page = await this.ledgerRepo.pageLedger(id, { cursor, limit: parsed.data.limit });
    return page;
  }

  @Post(':id/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.findById(id); // 404 first
    return this.ledgerRepo.reconcile(id);
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