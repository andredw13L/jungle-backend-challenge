import { Inject, Injectable } from '@nestjs/common';
import {
  PROVIDER_IDENTITY_PORT,
  type ProviderIdentityPort,
} from './provider-identity.port';

/**
 * Guard that always succeeds. Wires the ProviderIdentityPort (Symbol token)
 * into the request scope so a future real adapter can replace
 * NoopIdentityService without changing controller signatures — see ADR-0001.
 */
@Injectable()
export class NoopIdentityGuard {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identity: ProviderIdentityPort,
  ) {}

  canActivate(): boolean {
    // Touch the port to keep the seam warm: a real adapter will resolve a
    // token here. The no-op actor is a frozen, safe placeholder.
    this.identity.current();
    return true;
  }
}