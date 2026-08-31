import { Injectable } from '@nestjs/common';
import {
  type ProviderIdentity,
  type ProviderIdentityPort,
} from './provider-identity.port';

/**
 * No-op identity adapter. Keeps the seam alive without implementing any
 * authentication flow — see ADR-0001.
 */
@Injectable()
export class NoopIdentityService implements ProviderIdentityPort {
  private readonly actor: ProviderIdentity = Object.freeze({
    subject: 'challenge-anonymous',
    roles: Object.freeze(['challenge']),
  });

  current(): ProviderIdentity {
    return this.actor;
  }
}