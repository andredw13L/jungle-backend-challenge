import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SubmitWagerSchema, type SubmitWagerDto } from './dto/submit-wager.dto';
import { ProcessWager } from './process-wager';
import { WagerRepository } from './wager.repository';

/**
 * WageringController — `POST /wagering/transactions` accepts commands
 * from HTTP (slice 7 wires the same `ProcessWager` to SQS). The GET
 * routes cover the lookup contract from the spec — both internal id
 * and `(providerId, externalTransactionId)` resolve to the same row.
 */
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly process: ProcessWager,
    private readonly repo: WagerRepository,
  ) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!idempotencyKey) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    const parsed = SubmitWagerSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        code: 'INVALID_PAYLOAD',
        issues: parsed.error.issues,
      });
    }
    return this.process.execute({
      ...(parsed.data as SubmitWagerDto),
      idempotencyKey,
      ...(correlationId ? { correlationId } : {}),
    });
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

function toResponse(row: {
  id: string;
  type: string;
  status: string;
  wallet_id: string;
  provider_id: string;
  external_transaction_id: string;
  amount_amount: string;
  amount_currency: string;
  response_payload: Record<string, unknown> | null;
  failure_code: string | null;
  processed_at: Date | null;
}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    walletId: row.wallet_id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    amount: { amount: String(row.amount_amount), currency: row.amount_currency },
    failureCode: row.failure_code,
    response: row.response_payload,
    processedAt: row.processed_at instanceof Date ? row.processed_at.toISOString() : null,
  };
}