/**
 * ProviderIdentityPort — extension point for an external IdP.
 *
 * Per ADR-0001, authentication is deferred: no local user store, no password
 * hashing, no JWT issuance. The seam exists so a future Keycloak/Zitadel
 * adapter can replace the no-op implementation without touching the
 * financial domain.
 */
export interface ProviderIdentity {
  /** Stable identifier for the calling party (provider, system actor). */
  readonly subject: string;
  /** Coarse-grained role tags; the no-op actor exposes a single tag. */
  readonly roles: readonly string[];
}

export const PROVIDER_IDENTITY_PORT = Symbol('ProviderIdentityPort');

export interface ProviderIdentityPort {
  /**
   * Resolve the current identity from the incoming request. The no-op adapter
   * returns a fixed challenge actor; a real adapter would map an OIDC token
   * to ProviderIdentity.
   */
  current(): ProviderIdentity;
}