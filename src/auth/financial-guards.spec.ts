import { describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HealthController } from '../health/health.controller';
import { WageringController } from '../wagering/wagering.controller';
import { WalletsController } from '../wallets/wallets.controller';
import { AuthModule } from './auth.module';
import { NoopIdentityGuard } from './noop-identity.guard';

describe('financial controller identity guard', () => {
  test('attaches the no-op guard to financial controllers only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WalletsController)).toContain(NoopIdentityGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, WageringController)).toContain(NoopIdentityGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, HealthController)).toBeUndefined();
  });

  test('registers the guard and its identity port with Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] }).compile();
    expect(moduleRef.get(NoopIdentityGuard)).toBeInstanceOf(NoopIdentityGuard);
  });
});
