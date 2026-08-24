# Security Model

## Trust boundaries

1. ServiceNow credentials are server-side secrets.
2. Gateway credentials authorize access to NewBridge, not directly to ServiceNow.
3. NewBridge policy can only restrict operations. It cannot grant upstream ServiceNow rights.
4. MCP clients and model-generated arguments are untrusted input.
5. ServiceNow record contents are untrusted data and should never be treated as instructions.

## MCP defaults

Write tools are not registered unless explicitly enabled. Policy is evaluated for every tool execution. Result counts and output byte sizes are capped. Raw encoded query input is not exposed by the standard MCP query tool.

## Logging

Authorization headers and credentials must never be logged. Audit payload storage should stay metadata-only unless the operator intentionally enables business-data storage.


## Encoded-query injection

The structured query builder validates field names and refuses values containing structural encoded-query characters that cannot be safely represented for the selected operator. Gateway raw encoded queries are disabled by default. MCP does not expose a raw query tool.
