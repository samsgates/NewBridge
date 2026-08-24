import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from './index.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

describe('Gateway', () => {
  it('serves health without contacting ServiceNow', async () => {
    const gateway = await createGateway({
      connections: [{ name: 'dev', instance: 'https://example.service-now.com', auth: { type: 'bearer', token: 'x' } }],
      apiKeys: ['test-key']
    });
    close = gateway.close;
    const response = await gateway.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('requires configured API keys for protected routes', async () => {
    const gateway = await createGateway({
      connections: [{ name: 'dev', instance: 'https://example.service-now.com', auth: { type: 'bearer', token: 'x' } }],
      apiKeys: ['test-key']
    });
    close = gateway.close;
    const response = await gateway.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(401);
  });
});
