import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Optional,
  ParseUUIDPipe,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { NoopIdentityGuard } from '../auth/noop-identity.guard';
import { WagerInfrastructureError } from '../domain/errors';
import { IdempotencyKeySchema, normalizeHttpWager, SubmitWagerSchema } from './dto/submit-wager.dto';
import { ProcessWager } from './process-wager';
import type { SubmitWagerInput } from './process-wager.types';
import { WagerRepository } from './wager.repository';
import { MetricsService } from '../observability/metrics.service';

/**
 * WageringController — `POST /wagering/transactions` accepts commands
 * from HTTP (slice 7 wires the same `ProcessWager` to SQS). The GET
 * routes cover the lookup contract from the spec — both internal id
 * and `(providerId, externalTransactionId)` resolve to the same row.
 */
@Controller('wagering')
@UseGuards(NoopIdentityGuard)
export class WageringController {
  constructor(
    private readonly process: ProcessWager,
    private readonly repo: WagerRepository,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    if (idempotencyKey === undefined) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    const parsedIdempotencyKey = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedIdempotencyKey.success) {
      throw new UnprocessableEntityException({
        code: 'INVALID_PAYLOAD',
        issues: parsedIdempotencyKey.error.issues,
      });
    }
    const parsed = SubmitWagerSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        code: 'INVALID_PAYLOAD',
        issues: parsed.error.issues,
      });
    }
    const submit: SubmitWagerInput = normalizeHttpWager(parsed.data, parsedIdempotencyKey.data, correlationId);
    try {
      const result = await this.process.execute(submit);
      if (result.status === 'PENDING') response?.status(202);
      this.metrics?.recordInboxReceived(result.idempotentReplay ? 'duplicate' : result.status.toLowerCase());
      return result;
    } catch (err) {
      if (err instanceof WagerInfrastructureError || isTransientPostgresError(err)) {
        throw new ServiceUnavailableException({ code: 'TRANSIENT_INFRASTRUCTURE' });
      }
      throw err;
    }
  }

  @Get('transactions/:id')
  async findById(@Param('id', new ParseUUIDPipe()) id: string) {
    const found = await this.repo.findByIdPublic(id);
    if (!found) {
      throw new NotFoundException({ code: 'WAGER_NOT_FOUND' });
    }
    return toResponse(found);
  }

  @Get('transactions/by-external')
  async findByExternal(
    @Headers('x-provider-id') providerId: string | undefined,
    @Headers('x-external-id') externalTransactionId: string | undefined,
  ) {
    if (!providerId || !externalTransactionId) {
      throw new UnprocessableEntityException({
        code: 'INVALID_QUERY',
        message: 'X-Provider-Id and X-External-Id headers are required',
      });
    }
    const row = await this.repo.findByProviderAndExternal(providerId, externalTransactionId);
    if (!row) throw new NotFoundException({ code: 'WAGER_NOT_FOUND' });
    return toResponse(row);
  }
}

@Controller('providers')
@UseGuards(NoopIdentityGuard)
export class ProviderWageringController {
  constructor(private readonly repo: WagerRepository) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async findByProviderAndExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const row = await this.repo.findByProviderAndExternal(providerId, externalTransactionId);
    if (!row) throw new NotFoundException({ code: 'WAGER_NOT_FOUND' });
    return toResponse(row);
  }
}

function toResponse(row: {
  id: string;
  type: string;
  status: string;
  wallet_id: string;
  player_id: string | null;
  round_id: string | null;
  game_id: string | null;
  provider_id: string;
  external_transaction_id: string;
  amount_amount: string;
  amount_currency: string;
  reference_external_transaction_id: string | null;
  reference: string | null;
  response_payload: Record<string, unknown> | null;
  failure_code: string | null;
  processed_at: Date | null;
}) {
  return {
    transactionId: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.type,
    status: row.status,
    money: { amount: String(row.amount_amount), currency: row.amount_currency },
    ...(row.reference_external_transaction_id !== null
      ? { referenceExternalTransactionId: row.reference_external_transaction_id }
      : {}),
    ...(row.reference !== null ? { referenceTransactionId: row.reference } : {}),
    ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
    ...(row.response_payload !== null ? { response: row.response_payload } : {}),
    ...(row.processed_at instanceof Date ? { processedAt: row.processed_at.toISOString() } : {}),
  };
}

function isTransientPostgresError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; sqlState?: string; cause?: unknown; message?: string };
  const sqlState = e.code ?? e.sqlState;
  if (sqlState && ['40001', '08000', '08003', '08006', '57P01', '57P03'].includes(sqlState)) return true;
  if (e.cause && isTransientPostgresError(e.cause)) return true;
  return typeof e.message === 'string' && /ECONNRESET|ECONNREFUSED|connection terminated/i.test(e.message);
}
