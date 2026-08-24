# Operations

## Readiness

`GET /health` indicates the Gateway process is alive.

`GET /ready` verifies durable Gateway dependencies. An unavailable ServiceNow connection should be represented as a degraded connection rather than crashing the whole Gateway.

## Graceful shutdown

SIGTERM stops new work, closes workers, drains application resources, closes Postgres/Redis and then exits.

## Rate limits

Do not configure a hard-coded ServiceNow-wide limit. Tune NewBridge concurrency for each target instance and let 429 plus Retry-After feedback reduce pressure.

## Backups

PostgreSQL contains audit metadata, approvals and idempotency records. Use normal managed-database backup and restore procedures. Redis queues should be configured with persistence appropriate to the workload.
