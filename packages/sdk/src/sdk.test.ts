import { describe, expect, it } from 'vitest';
import { NewBridge, NewBridgeManager, type Transport, type TransportRequest, type TransportResponse } from './index.js';

class FakeTransport implements Transport {
  calls: TransportRequest[] = [];
  async request<T>(request: TransportRequest): Promise<TransportResponse<T>> {
    this.calls.push(request);
    const result = request.method === 'POST' ? { sys_id: '1', ...(request.body as object) } : [{ sys_id: '1', number: 'INC1' }];
    return { status: 200, headers: new Headers(), data: { result } as T, requestId: 'test' };
  }
}

describe('NewBridge SDK', () => {
  it('queries tables with encoded params', async () => {
    const transport = new FakeTransport();
    const nb = new NewBridge({ instance: 'https://example.service-now.com', auth: { type: 'bearer', token: 'x' } }, transport);
    const rows = await nb.table('incident').where('active', true).limit(10).find();
    expect(rows).toHaveLength(1);
    expect((transport.calls[0]!.query as URLSearchParams).get('sysparm_query')).toBe('active=true');
  });
  it('creates records', async () => {
    const transport = new FakeTransport();
    const nb = new NewBridge({ instance: 'https://example.service-now.com', auth: { type: 'bearer', token: 'x' } }, transport);
    const row = await nb.incidents.create({ short_description: 'test' });
    expect(row.sys_id).toBe('1');
  });
});


describe('NewBridgeManager', () => {
  it('manages multiple named connections', () => {
    const manager = new NewBridgeManager({ dev: { instance: 'https://dev.example.com', auth: { type: 'bearer', token: 'x' } } });
    expect(manager.list()).toEqual(['dev']);
    expect(manager.use('dev')).toBeInstanceOf(NewBridge);
  });
});
