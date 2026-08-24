#!/usr/bin/env bash
set -euo pipefail
curl -fsS \
  -H "Authorization: Bearer ${NEWBRIDGE_GATEWAY_API_KEY}" \
  "http://localhost:8080/v1/connections/dev/tables/incident/records?limit=20"
