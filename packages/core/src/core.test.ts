import { describe, expect, it } from 'vitest';
import { apiPath, createAuthProvider } from './index.js';

describe('core helpers', () => {
  it('builds versioned and default API paths', () => {
    expect(apiPath(undefined, 'table/incident')).toBe('/api/now/table/incident');
    expect(apiPath('v2', 'table/incident')).toBe('/api/now/v2/table/incident');
  });
  it('creates bearer provider', async () => {
    const token = await createAuthProvider('https://x.service-now.com', { type: 'bearer', token: 'abc' }).getToken();
    expect(token.value).toBe('abc');
  });
});
