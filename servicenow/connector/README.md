# Optional NewBridge ServiceNow Connector

The base NewBridge SDK does not require anything to be installed inside ServiceNow. This optional connector is for organizations that want lower-latency outbound record-change notification than polling.

Create a scoped ServiceNow application, for example `x_newbridge_connector`, then add the supplied Script Include and asynchronous Business Rule using normal ServiceNow source-control/application-development practices.

## Properties

Create encrypted or protected system properties:

- `x_newbridge_connector.webhook_url`
- `x_newbridge_connector.webhook_secret` (base64-encoded random 32-byte secret)
- `x_newbridge_connector.enabled`

Do not put NewBridge Gateway API keys into client scripts.

## Business Rule

Create an asynchronous Business Rule only on explicitly approved tables. Do not create a wildcard global rule across every table in production.

Condition: `x_newbridge_connector.enabled == true`

Advanced script: `scripts/business-rule.js`

## Script Include

Create a server-side Script Include named `NewBridgeWebhook` and use `scripts/NewBridgeWebhook.js`.

## Security

The sample signs a compact event envelope. The receiving Gateway must validate timestamp, delivery ID and HMAC before accepting the event. Restrict outbound connectivity to the approved Gateway URL. Use TLS. Rotate the HMAC secret regularly.
