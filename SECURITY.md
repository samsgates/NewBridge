# Security Policy

## Supported versions

Security fixes are applied to the latest minor release and the most recent previous minor release when practical.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use GitHub private vulnerability reporting for this repository, or contact the security address published by the repository owner.

Include affected version, reproduction steps, impact, and any proposed mitigation. Do not include real ServiceNow credentials or customer records.

## Security boundaries

NewBridge does not bypass ServiceNow ACLs. The ServiceNow identity configured for a connection remains the upstream authorization boundary. NewBridge policy can only add restrictions.

Production deployments should use OAuth, TLS, least-privilege ServiceNow roles, explicit Gateway policies, managed secret storage, network controls, dependency scanning and centralized audit collection.
