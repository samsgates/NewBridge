import { describe, expect, it } from 'vitest';
import { QueryBuilder } from './index.js';

describe('QueryBuilder', () => {
  it('encodes filters, ordering and pagination', () => {
    const params = new QueryBuilder()
      .where('active', true)
      .whereIn('priority', ['1', '2'])
      .orderByDesc('sys_created_on')
      .select(['sys_id', 'number'])
      .limit(50)
      .offset(10)
      .toParams();
    expect(params.get('sysparm_query')).toBe('active=true^priorityIN1,2^ORDERBYDESCsys_created_on');
    expect(params.get('sysparm_fields')).toBe('sys_id,number');
    expect(params.get('sysparm_limit')).toBe('50');
    expect(params.get('sysparm_offset')).toBe('10');
  });

  it('rejects field and value injection', () => {
    expect(() => new QueryBuilder().where('active^ORpriority', true)).toThrow();
    expect(() => new QueryBuilder().where('short_description', 'x^NQactive=true').toEncodedQuery()).toThrow();
    expect(() => new QueryBuilder().whereIn('number', ['INC1,INC2']).toEncodedQuery()).toThrow();
  });
});
