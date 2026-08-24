# Architecture

NewBridge has two supported runtime modes.

## Direct SDK mode

`Application -> @newbridge/sdk -> ServiceNow`

This mode contains authentication, safe query building, pagination, retry, adaptive concurrency, circuit breaking, error normalization, attachments, Import Sets and schema discovery. It requires no NewBridge server.

## Gateway mode

`Application / Agent -> NewBridge Gateway -> ServiceNow`

The Gateway adds centralized connections, API-key/OIDC-ready authentication hooks, policy enforcement, approvals, PostgreSQL state, Redis/BullMQ jobs, audit and telemetry.

## Design rules

- ServiceNow ACLs remain authoritative.
- Custom tables are first-class. The SDK does not require table-specific generated code.
- Generated types are optional developer ergonomics, not a runtime dependency.
- MCP uses the same SDK and policy engine as normal applications.
- Event delivery semantics are at-least-once style. Consumers should be idempotent.
- The emulator is a contract development environment, not a ServiceNow clone.
