# API Overview

## SDK

### NewBridge

`new NewBridge(config)` creates a connection-scoped client.

- `table(name)` returns a generic `TableClient`.
- `attachments` exposes attachment metadata/upload/download/delete operations.
- `importSets` exposes Import Set insert operations.
- `rest` exposes an advanced `/api/*` request escape hatch.
- `schema` exposes schema discovery.
- `health()` checks basic Table API access.

### TableClient

Query methods are chainable:

- `where(field, value)`
- `where(field, operator, value)`
- `whereIn(field, values)`
- `whereNotIn(field, values)`
- `whereEmpty(field)`
- `whereNotEmpty(field)`
- `orWhere(...)`
- `group('AND' | 'OR', callback)`
- `select(fields)`
- `orderBy(field)`
- `orderByDesc(field)`
- `limit(n)`
- `offset(n)`
- `rawQuery(encodedQuery)` for advanced server-side code. `javascript:` expressions are rejected by default.

Execution methods:

- `get(sysId)`
- `find()`
- `first()`
- `exists()`
- `count()`
- `page(offset, limit)`
- `stream()`
- `create(record)`
- `update(sysId, patch)`
- `delete(sysId)`
- `bulkCreate(records, options)`

## Gateway

Base path: `/v1`.

- `GET /health`
- `GET /ready`
- `GET /metrics`
- `GET /v1/connections/:connection/health`
- `GET /v1/connections/:connection/schema`
- `GET /v1/connections/:connection/tables/:table/records`
- `GET /v1/connections/:connection/tables/:table/records/:sysId`
- `POST /v1/connections/:connection/tables/:table/records`
- `PATCH /v1/connections/:connection/tables/:table/records/:sysId`
- `DELETE /v1/connections/:connection/tables/:table/records/:sysId`
- `POST /v1/jobs/bulk-create`
- `GET /v1/jobs/:id`
- `GET /v1/approvals/:id`
- `POST /v1/approvals/:id/approve`
- `POST /v1/connector/events`

Gateway clients should send `Authorization: Bearer <NewBridge API key>`. Actor identity is bound by Gateway authentication configuration and is not trusted from caller-supplied identity headers. Custom OIDC/JWT or reverse-proxy authentication can be integrated through the `GatewayAuthenticator` interface.
