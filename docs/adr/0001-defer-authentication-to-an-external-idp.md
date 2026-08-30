# Defer authentication to an external identity provider

Authentication is intentionally not implemented because it has no score in the challenge and a production design would delegate it to an OIDC provider rather than store credentials locally. A no-op guard and `ProviderIdentityPort` keep the integration point explicit; health endpoints remain public and SQS remains a trusted internal channel.
