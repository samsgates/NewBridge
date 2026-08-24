import { afterEach, describe, expect, it } from 'vitest';
import { createEmulator } from './index.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

describe('emulator', () => {
  it('supports CRUD', async () => {
    const { app } = createEmulator(); close = () => app.close();
    const created = await app.inject({ method: 'POST', url: '/api/now/table/incident', payload: { short_description: 'hello' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().result.sys_id;
    const fetched = await app.inject({ method: 'GET', url: `/api/now/table/incident/${id}` });
    expect(fetched.json().result.short_description).toBe('hello');
  });
});
