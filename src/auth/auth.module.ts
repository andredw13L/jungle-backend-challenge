import { Module } from '@nestjs/common';
import {
  PROVIDER_IDENTITY_PORT,
} from './provider-identity.port';
import { NoopIdentityService } from './noop-identity.service';

/**
 * Bind the ProviderIdentityPort symbol to the no-op adapter. A real
 * Keycloak/Zitadel OIDC adapter replaces useExisting later without changing
 * downstream consumers — see ADR-0001.
 */
@Module({
  providers: [
    NoopIdentityService,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useExisting: NoopIdentityService,
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT],
})
export class AuthModule {}