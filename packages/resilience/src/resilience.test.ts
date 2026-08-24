import { describe, expect, it } from 'vitest';
import { CircuitBreaker, stableHash, withRetry } from './index.js';

describe('resilience', () => {
  it('retries retryable failures', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('temporary'), { retryable: true });
      return 'ok';
    }, { attempts: 3, initialDelayMs: 1, jitter: false });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
  it('opens a circuit', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10000 });
    for (let i = 0; i < 2; i++) await expect(cb.execute(async () => { throw Object.assign(new Error('x'), { retryable: true }); })).rejects.toThrow();
    expect(cb.state).toBe('OPEN');
  });
  it('hashes object keys deterministically', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
});
