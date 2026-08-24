import { describe, expect, it } from 'vitest';
import { PolicyEngine } from './index.js';

describe('PolicyEngine', () => {
  const engine = new PolicyEngine({
    default: 'deny',
    allow: [{ tables: ['incident'], operations: ['read', 'update'], fields: ['number', 'work_notes'] }],
    deny: [{ tables: ['sys_user'], operations: ['update'] }],
    approvals: [{ tables: ['incident'], operations: ['update'], reason: 'human review' }],
    redaction: { fields: ['token'], regex: [] }
  });
  it('allows filtered reads', () => {
    const d = engine.evaluate({ connection: 'prod', table: 'incident', operation: 'read', fields: ['number', 'description'] });
    expect(d.allowed).toBe(true);
    expect(d.filteredFields).toEqual(['number']);
  });
  it('rejects disallowed write fields', () => {
    expect(engine.evaluate({ connection: 'prod', table: 'incident', operation: 'update', fields: ['state'] }).allowed).toBe(false);
  });
  it('marks configured approvals', () => {
    expect(engine.evaluate({ connection: 'prod', table: 'incident', operation: 'update', fields: ['work_notes'] }).approvalRequired).toBe(true);
  });
  it('redacts fields', () => {
    expect(engine.redact({ token: 'abc', ok: 'x' })).toEqual({ token: '[REDACTED]', ok: 'x' });
  });
});
