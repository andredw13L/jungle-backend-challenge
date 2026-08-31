import { DecimalType, EntitySchema } from '@mikro-orm/core';

export const MIKRO_ORM = Symbol('MIKRO_ORM');

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  balanceCurrency!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'uuidv7()' },
    playerId: { type: 'text', fieldName: 'player_id' },
    currency: { type: 'text', columnType: 'char(3)' },
    balanceAmount: {
      type: new DecimalType('string'),
      fieldName: 'balance_amount',
      columnType: 'numeric(18,2)',
      precision: 18,
      scale: 2,
    },
    balanceCurrency: {
      type: 'text',
      fieldName: 'balance_currency',
      columnType: 'char(3)',
    },
    version: { type: 'integer', default: 1 },
    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
    updatedAt: {
      type: Date,
      fieldName: 'updated_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
  },
});

export class WagerTransactionEntity {
  id!: string;
  type!: string;
  status!: string;
  walletId!: string;
  playerId!: string | null;
  roundId!: string | null;
  gameId!: string | null;
  providerId!: string;
  externalTransactionId!: string;
  amountAmount!: string;
  amountCurrency!: string;
  referenceExternalTransactionId!: string | null;
  reference!: string | null;
  payloadHash!: string;
  responsePayload!: Record<string, unknown> | null;
  failureCode!: string | null;
  referenceAttempts!: number;
  nextRetryAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  idempotencyKey!: string;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'uuidv7()' },
    type: { type: 'text' },
    status: { type: 'text' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'text', fieldName: 'player_id', nullable: true },
    roundId: { type: 'text', fieldName: 'round_id', nullable: true },
    gameId: { type: 'text', fieldName: 'game_id', nullable: true },
    providerId: { type: 'text', fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'text',
      fieldName: 'external_transaction_id',
    },
    amountAmount: {
      type: new DecimalType('string'),
      fieldName: 'amount_amount',
      columnType: 'numeric(18,2)',
      precision: 18,
      scale: 2,
    },
    amountCurrency: {
      type: 'text',
      fieldName: 'amount_currency',
      columnType: 'char(3)',
    },
    referenceExternalTransactionId: {
      type: 'text',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    reference: { type: 'uuid', nullable: true },
    payloadHash: { type: 'text', fieldName: 'payload_hash' },
    responsePayload: {
      type: 'json',
      fieldName: 'response_payload',
      columnType: 'jsonb',
      nullable: true,
    },
    failureCode: {
      type: 'text',
      fieldName: 'failure_code',
      nullable: true,
    },
    referenceAttempts: {
      type: 'integer',
      fieldName: 'reference_attempts',
      default: 0,
    },
    nextRetryAt: {
      type: Date,
      fieldName: 'next_retry_at',
      columnType: 'timestamptz',
      nullable: true,
    },
    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
    processedAt: {
      type: Date,
      fieldName: 'processed_at',
      columnType: 'timestamptz',
      nullable: true,
    },
    idempotencyKey: {
      type: 'text',
      fieldName: 'idempotency_key',
    },
  },
});

export class WalletLedgerEntryEntity {
  id!: string;
  direction!: string;
  valueAmount!: string;
  valueCurrency!: string;
  balanceBeforeAmount!: string;
  balanceBeforeCurrency!: string;
  balanceAfterAmount!: string;
  balanceAfterCurrency!: string;
  walletId!: string;
  transactionId!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'uuidv7()' },
    direction: { type: 'text' },
    valueAmount: {
      type: new DecimalType('string'),
      fieldName: 'value_amount',
      columnType: 'numeric(18,2)',
      precision: 18,
      scale: 2,
    },
    valueCurrency: {
      type: 'text',
      fieldName: 'value_currency',
      columnType: 'char(3)',
    },
    balanceBeforeAmount: {
      type: new DecimalType('string'),
      fieldName: 'balance_before_amount',
      columnType: 'numeric(18,2)',
      precision: 18,
      scale: 2,
    },
    balanceBeforeCurrency: {
      type: 'text',
      fieldName: 'balance_before_currency',
      columnType: 'char(3)',
    },
    balanceAfterAmount: {
      type: new DecimalType('string'),
      fieldName: 'balance_after_amount',
      columnType: 'numeric(18,2)',
      precision: 18,
      scale: 2,
    },
    balanceAfterCurrency: {
      type: 'text',
      fieldName: 'balance_after_currency',
      columnType: 'char(3)',
    },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
  },
});

export class InboxEntity {
  consumerName!: string;
  messageId!: string;
  payload!: Record<string, unknown>;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxSchema = new EntitySchema<InboxEntity>({
  class: InboxEntity,
  tableName: 'inbox',
  properties: {
    consumerName: { type: 'text', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'text', fieldName: 'message_id', primary: true },
    payload: { type: 'json', columnType: 'jsonb' },
    receivedAt: {
      type: Date,
      fieldName: 'received_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
    processedAt: {
      type: Date,
      fieldName: 'processed_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

export class OutboxEntity {
  id!: string;
  eventId!: string;
  eventType!: string;
  schemaVersion!: number;
  payload!: Record<string, unknown>;
  status!: string;
  attempts!: number;
  nextAttemptAt!: Date;
  lastError!: string | null;
  createdAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxEntity>({
  class: OutboxEntity,
  tableName: 'outbox',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'uuidv7()' },
    eventId: { type: 'uuid', fieldName: 'event_id' },
    eventType: { type: 'text', fieldName: 'event_type' },
    schemaVersion: {
      type: 'integer',
      fieldName: 'schema_version',
      default: 1,
    },
    payload: { type: 'json', columnType: 'jsonb' },
    status: { type: 'text', default: 'PENDING' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: {
      type: Date,
      fieldName: 'next_attempt_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
    lastError: {
      type: 'text',
      fieldName: 'last_error',
      nullable: true,
    },
    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
    publishedAt: {
      type: Date,
      fieldName: 'published_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

export const ORM_ENTITIES = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxSchema,
  OutboxSchema,
] as const;
