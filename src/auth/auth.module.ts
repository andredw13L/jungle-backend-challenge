import { Global, Module } from '@nestjs/common';
import { PROVIDER_IDENTITY_PORT } from './provider-identity.port';
import { NoopIdentityService } from './noop-identity.service';
import { NoopIdentityGuard } from './noop-identity.guard';

/**
 * Bind the ProviderIdentityPort symbol to the no-op adapter. A real
 * Keycloak/Zitadel OIDC adapter replaces useExisting later without changing
 * downstream consumers — see ADR-0001.
 */
@Global()
@Module({
  providers: [
    NoopIdentityService,
    NoopIdentityGuard,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useExisting: NoopIdentityService,
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT, NoopIdentityGuard],
})
export class AuthModule {}
