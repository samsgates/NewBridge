import { describe, expect, it } from 'vitest';
import { diffSchemas, generateTypeScript, type SchemaBundle } from './index.js';

const base: SchemaBundle = { version: 1, generatedAt: '', tables: [{ name: 'incident', fields: [{ name: 'number', internalType: 'string', mandatory: true, readOnly: false, choices: [] }] }] };

describe('schema utilities', () => {
  it('generates TypeScript', () => {
    const files = generateTypeScript(base);
    expect(files['incident.ts']).toContain('interface Incident');
    expect(files['incident.ts']).toContain('"number": string');
  });
  it('detects breaking field removal', () => {
    const next: SchemaBundle = { version: 1, generatedAt: '', tables: [{ name: 'incident', fields: [] }] };
    expect(diffSchemas(base, next)).toContainEqual(expect.objectContaining({ type: 'field_removed', severity: 'breaking' }));
  });
});

import type { Transport, TransportRequest, TransportResponse } from '@newbridge/core';
import { SchemaDiscovery } from './index.js';

class SchemaTransport implements Transport {
  async request<T>(request: TransportRequest): Promise<TransportResponse<T>> {
    const path = request.path;
    const query = request.query instanceof URLSearchParams ? request.query : new URLSearchParams();
    let result: any = [];
    if (path.endsWith('/table/sys_db_object') && query.get('sysparm_query') === 'name=incident') {
      result = [{ sys_id: 'incident_id', name: 'incident', label: 'Incident', super_class: { value: 'task_id', display_value: 'Task' }, display_field: 'number' }];
    } else if (path.endsWith('/table/sys_db_object/task_id')) {
      result = { sys_id: 'task_id', name: 'task', label: 'Task', super_class: { value: '', display_value: '' }, display_field: 'number' };
    } else if (path.endsWith('/table/sys_dictionary') && query.get('sysparm_query')?.startsWith('name=task')) {
      result = [{ element: 'short_description', column_label: 'Short description', internal_type: 'string', mandatory: 'false', read_only: 'false', max_length: '160' }];
    } else if (path.endsWith('/table/sys_dictionary') && query.get('sysparm_query')?.startsWith('name=incident')) {
      result = [{ element: 'urgency', column_label: 'Urgency', internal_type: 'integer', mandatory: 'false', read_only: 'false' }];
    } else if (path.endsWith('/table/sys_choice')) result = [];
    return { status: 200, headers: new Headers(), data: { result } as T, requestId: 'schema-test' };
  }
}

describe('SchemaDiscovery inheritance', () => {
  it('includes inherited parent fields', async () => {
    const schema = await new SchemaDiscovery(new SchemaTransport()).describeTable('incident');
    expect(schema.fields.map(f => f.name)).toContain('short_description');
    expect(schema.fields.map(f => f.name)).toContain('urgency');
    expect(schema.superClass).toBe('task');
  });
});
