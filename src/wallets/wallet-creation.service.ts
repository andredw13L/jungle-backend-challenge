import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Money } from '../domain/money';
import {
  WalletRepository,
  type WalletRow,
} from '../infrastructure/database/wallet.repository';
import type { CreateWalletDto } from './dto/create-wallet.dto';

/**
 * WalletCreationService — application-layer wrapper around the
 * WalletRepository. Slice 3 wires HTTP to the repository; later slices
 * add `FOR UPDATE` lock, idempotency arbitration, and command-queue
 * delivery without changing this service's public shape.
 */
@Injectable()
export class WalletCreationService {
  constructor(private readonly repo: WalletRepository) {}

  async create(input: CreateWalletDto, correlationId?: string): Promise<WalletRow> {
    const id = uuidv7();
    const initialBalance = Money.create(input.initialBalance);
    try {
      const result = await this.repo.createAtomic({
        id,
        playerId: input.playerId,
        initialBalance,
        ...(correlationId ? { correlationId } : {}),
      });
      return result.wallet;
    } catch (err) {
      if (isUniqueViolation(err, 'uq_wallet_player_currency')) {
        throw new ConflictException({
          code: 'WALLET_ALREADY_EXISTS',
          message: `wallet already exists for player ${input.playerId} in ${input.initialBalance.currency}`,
        });
      }
      if (isUniqueViolation(err, 'uq_wager_idempotency_key')) {
        throw new UnprocessableEntityException({
          code: 'OPENING_IDEMPOTENCY_CONFLICT',
        });
      }
      throw err;
    }
  }

  async findById(id: string): Promise<WalletRow> {
    const wallet = await this.repo.findById(id);
    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: `wallet ${id} not found`,
      });
    }
    return wallet;
  }
}

/**
 * Detect PostgreSQL unique-violation by SQLSTATE 23505.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== '23505') return false;
  return (
    e.constraint === constraint ||
    (typeof e.message === 'string' && e.message.includes(constraint))
  );
}
