## ADDED Requirements

### Requirement: Validate runtime configuration
The Bun process MUST validate required PostgreSQL, SQS, region, queue, port and retry configuration before NestJS begins listening, and MUST reject invalid numeric ranges or missing values with a clear startup error.

#### Scenario: Missing database URL
- **WHEN** the application starts without a database URL
- **THEN** startup fails before accepting traffic and identifies the missing variable without printing secrets

### Requirement: Separate liveness and readiness
`GET /health/live` MUST report only process liveness, while `GET /health/ready` MUST check PostgreSQL and required SQS queues and return `503` when a dependency is unavailable; neither route requires authentication.

#### Scenario: PostgreSQL unavailable
- **WHEN** PostgreSQL stops while the process remains alive
- **THEN** liveness stays successful and readiness becomes `503`

#### Scenario: Required queues available
- **WHEN** PostgreSQL, the command queue and event queue are reachable
- **THEN** readiness returns success with dependency details that contain no credentials

### Requirement: Emit structured safe logs
The service MUST emit JSON logs containing available correlation, message, transaction, Wallet and provider identifiers, and MUST NOT log access tokens, credentials or complete financial payloads.

#### Scenario: Wager request log
- **WHEN** a wagering request completes
- **THEN** its structured log contains correlation and entity identifiers plus outcome, but omits the request body and exact Money object

### Requirement: Expose required metrics
`GET /metrics` MUST expose transaction outcomes, duplicates, retries, DLQ messages, lock conflicts, Outbox lag and processing latency in Prometheus format.

#### Scenario: Duplicate request metric
- **WHEN** an identical wager is replayed
- **THEN** the duplicate counter increments without incrementing the financial-effect count

#### Scenario: Outbox lag metric
- **WHEN** an unpublished Outbox event ages
- **THEN** the lag gauge reflects elapsed seconds without exposing its payload

### Requirement: Support graceful application shutdown
The application MUST enable NestJS shutdown hooks and coordinate HTTP, worker, SQS, MikroORM and metrics resources without accepting new work after shutdown begins.

#### Scenario: SIGTERM
- **WHEN** the process receives SIGTERM
- **THEN** polling stops, in-flight work is settled safely and all clients close before process termination or timeout

### Requirement: Keep authentication external
Financial routes MUST expose a no-op guard and `ProviderIdentityPort` seam for a future external OIDC provider, MUST NOT implement local credentials or token issuance, and MUST leave health endpoints open.

#### Scenario: Challenge deployment without IdP
- **WHEN** the service starts in the documented challenge environment
- **THEN** financial routes remain usable through the explicit no-op adapter and no user credential table exists

### Requirement: Run through Bun and Docker Compose
Installation, execution, type checking, migration and tests MUST use documented Bun commands, and Docker Compose MUST provide PostgreSQL, pinned LocalStack 3.8.1, FIFO command/DLQ/event queue initialization with content-based deduplication, and the application with health-aware dependencies.

#### Scenario: Clean local startup
- **WHEN** a reviewer follows the documented commands from a clean clone
- **THEN** dependencies install, migrations apply, queues exist and the application becomes ready without manual database or broker setup
