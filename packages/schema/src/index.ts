import { apiPath, SchemaError, type Transport } from '@newbridge/core';
import { z } from 'zod';

export const FieldSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  internalType: z.string().default('string'),
  reference: z.string().optional(),
  mandatory: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  maxLength: z.number().int().nonnegative().optional(),
  choices: z.array(z.object({ value: z.string(), label: z.string(), sequence: z.number().optional() })).default([]),
});

export const TableSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  superClass: z.string().optional(),
  displayField: z.string().optional(),
  fields: z.array(FieldSchema),
});

export type NewBridgeField = z.infer<typeof FieldSchema>;
export type NewBridgeTableSchema = z.infer<typeof TableSchema>;
export interface SchemaBundle {
  version: 1;
  generatedAt: string;
  tables: NewBridgeTableSchema[];
}

export interface SchemaDiscoveryOptions {
  apiVersion?: string;
  includeTables?: string[];
  includeSystemTables?: boolean;
  tableLimit?: number;
}

function bool(v: unknown): boolean { return v === true || v === 'true' || v === '1'; }
function num(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

export class SchemaDiscovery {
  constructor(private readonly transport: Transport, private readonly options: SchemaDiscoveryOptions = {}) {}

  async pull(): Promise<SchemaBundle> {
    const tables = this.options.includeTables?.length ? this.options.includeTables : await this.listTables();
    const result: NewBridgeTableSchema[] = [];
    for (const table of tables) result.push(await this.describeTable(table));
    return { version: 1, generatedAt: new Date().toISOString(), tables: result.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async listTables(): Promise<string[]> {
    const query = new URLSearchParams();
    const predicates = ['active=true'];
    if (!this.options.includeSystemTables) predicates.push('nameNOT LIKEsys_');
    query.set('sysparm_query', predicates.join('^'));
    query.set('sysparm_fields', 'name');
    query.set('sysparm_limit', String(this.options.tableLimit ?? 5000));
    const response = await this.transport.request<any>({ method: 'GET', path: apiPath(this.options.apiVersion, 'table/sys_db_object'), query });
    const rows = response.data?.result;
    if (!Array.isArray(rows)) throw new SchemaError('Unexpected sys_db_object response while listing tables');
    return rows.map((r: any) => String(r.name)).filter(Boolean);
  }

  async describeTable(table: string): Promise<NewBridgeTableSchema> {
    const tableMeta = await this.fetchTableMetaByName(table);
    if (!tableMeta) throw new SchemaError(`Table metadata not found for ${table}`);
    const hierarchy = await this.resolveHierarchy(tableMeta);
    const dictionarySets = await Promise.all(hierarchy.map(name => this.fetchDictionary(name)));
    const choiceSets = await Promise.all(hierarchy.map(name => this.fetchChoices(name)));

    const fieldMap = new Map<string, NewBridgeField>();
    for (let i = 0; i < hierarchy.length; i++) {
      const dictionary = dictionarySets[i]!;
      const choices = choiceSets[i]!;
      for (const row of dictionary) {
        const fieldName = String(row.element);
        const inherited = fieldMap.get(fieldName);
        const ownChoices = choices.get(fieldName);
        fieldMap.set(fieldName, {
          name: fieldName,
          label: row.column_label ? String(row.column_label) : inherited?.label,
          internalType: String(row.internal_type?.value ?? row.internal_type ?? inherited?.internalType ?? 'string'),
          reference: row.reference?.value ? String(row.reference.value) : row.reference ? String(row.reference) : inherited?.reference,
          mandatory: bool(row.mandatory),
          readOnly: bool(row.read_only),
          maxLength: num(row.max_length) ?? inherited?.maxLength,
          choices: ownChoices?.length ? ownChoices : (inherited?.choices ?? [])
        });
      }
    }

    for (const choices of choiceSets) {
      for (const [fieldName, values] of choices.entries()) {
        const field = fieldMap.get(fieldName);
        if (field && values.length) field.choices = values;
      }
    }

    const parentName = hierarchy.length > 1 ? hierarchy[hierarchy.length - 2] : undefined;
    return TableSchema.parse({
      name: table,
      label: tableMeta.label || table,
      superClass: parentName,
      displayField: tableMeta.display_field || undefined,
      fields: [...fieldMap.values()].sort((a, b) => a.name.localeCompare(b.name))
    });
  }

  private async fetchTableMetaByName(table: string): Promise<any | undefined> {
    const response = await this.transport.request<any>({
      method: 'GET',
      path: apiPath(this.options.apiVersion, 'table/sys_db_object'),
      query: new URLSearchParams({
        sysparm_query: `name=${table}`,
        sysparm_fields: 'sys_id,name,label,super_class,display_field',
        sysparm_display_value: 'all',
        sysparm_limit: '1'
      })
    });
    return response.data?.result?.[0];
  }

  private async fetchTableMetaBySysId(sysId: string): Promise<any | undefined> {
    const response = await this.transport.request<any>({
      method: 'GET',
      path: apiPath(this.options.apiVersion, `table/sys_db_object/${encodeURIComponent(sysId)}`),
      query: new URLSearchParams({
        sysparm_fields: 'sys_id,name,label,super_class,display_field',
        sysparm_display_value: 'all'
      })
    });
    return response.data?.result;
  }

  private async resolveHierarchy(leafMeta: any): Promise<string[]> {
    const names: string[] = [String(leafMeta.name?.value ?? leafMeta.name)];
    let current = leafMeta;
    const visited = new Set<string>();
    while (true) {
      const parentId = String(current.super_class?.value ?? current.super_class ?? '');
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      const parent = await this.fetchTableMetaBySysId(parentId);
      if (!parent) break;
      const parentName = String(parent.name?.value ?? parent.name ?? '');
      if (!parentName) break;
      names.unshift(parentName);
      current = parent;
      if (names.length > 32) throw new SchemaError(`Table hierarchy for ${names.at(-1)} exceeded 32 levels`);
    }
    return names;
  }

  private async fetchDictionary(table: string): Promise<any[]> {
    const response = await this.transport.request<any>({
      method: 'GET',
      path: apiPath(this.options.apiVersion, 'table/sys_dictionary'),
      query: new URLSearchParams({
        sysparm_query: `name=${table}^elementISNOTEMPTY`,
        sysparm_fields: 'element,column_label,internal_type,reference,mandatory,read_only,max_length',
        sysparm_limit: '10000',
        sysparm_display_value: 'all'
      })
    });
    const rows = response.data?.result;
    if (!Array.isArray(rows)) throw new SchemaError(`Unexpected sys_dictionary response for ${table}`);
    return rows;
  }

  private async fetchChoices(table: string): Promise<Map<string, Array<{ value: string; label: string; sequence?: number }>>> {
    const response = await this.transport.request<any>({
      method: 'GET',
      path: apiPath(this.options.apiVersion, 'table/sys_choice'),
      query: new URLSearchParams({ sysparm_query: `name=${table}^inactive=false`, sysparm_fields: 'element,value,label,sequence', sysparm_limit: '10000' })
    });
    const map = new Map<string, Array<{ value: string; label: string; sequence?: number }>>();
    for (const row of response.data?.result ?? []) {
      const key = String(row.element);
      const list = map.get(key) ?? [];
      list.push({ value: String(row.value), label: String(row.label), sequence: num(row.sequence) });
      map.set(key, list);
    }
    return map;
  }
}

function pascal(input: string): string {
  return input.split(/[^A-Za-z0-9]+/).filter(Boolean).map(v => v[0]!.toUpperCase() + v.slice(1)).join('');
}

function tsType(field: NewBridgeField): string {
  if (field.choices.length) return field.choices.map(c => JSON.stringify(c.value)).join(' | ');
  if (field.reference) return `Reference<${pascal(field.reference)}>`;
  switch (field.internalType) {
    case 'boolean': return 'boolean';
    case 'integer': case 'longint': case 'decimal': case 'float': return 'number';
    case 'glide_date_time': case 'glide_date': case 'glide_time': return 'string';
    case 'json': return 'unknown';
    default: return 'string';
  }
}

export function generateTypeScript(bundle: SchemaBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of bundle.tables) {
    const name = pascal(table.name);
    const lines = [
      `// Generated by NewBridge from ${table.name}. Do not edit manually.`,
      `export interface Reference<T = unknown> { sys_id: string; display_value?: string; value?: T }`,
      `export interface ${name} {`
    ];
    for (const field of table.fields) {
      const optional = field.mandatory ? '' : '?';
      lines.push(`  ${JSON.stringify(field.name)}${optional}: ${tsType(field)};`);
    }
    lines.push('}', '');
    out[`${table.name}.ts`] = lines.join('\n');
  }
  const exports = bundle.tables.map(t => `export * from './${t.name}.js';`).join('\n') + '\n';
  out['index.ts'] = exports;
  return out;
}

export type SchemaDiffSeverity = 'info' | 'breaking';
export interface SchemaDifference { table: string; field?: string; type: string; from?: unknown; to?: unknown; severity: SchemaDiffSeverity }

export function diffSchemas(from: SchemaBundle, to: SchemaBundle): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  const fromTables = new Map(from.tables.map(t => [t.name, t]));
  const toTables = new Map(to.tables.map(t => [t.name, t]));
  for (const [name, table] of fromTables) {
    const other = toTables.get(name);
    if (!other) { differences.push({ table: name, type: 'table_removed', severity: 'breaking' }); continue; }
    const aFields = new Map(table.fields.map(f => [f.name, f]));
    const bFields = new Map(other.fields.map(f => [f.name, f]));
    for (const [fieldName, field] of aFields) {
      const b = bFields.get(fieldName);
      if (!b) { differences.push({ table: name, field: fieldName, type: 'field_removed', severity: 'breaking' }); continue; }
      if (field.internalType !== b.internalType) differences.push({ table: name, field: fieldName, type: 'field_type_changed', from: field.internalType, to: b.internalType, severity: 'breaking' });
      if (field.mandatory !== b.mandatory) differences.push({ table: name, field: fieldName, type: 'mandatory_changed', from: field.mandatory, to: b.mandatory, severity: b.mandatory ? 'breaking' : 'info' });
      if (field.reference !== b.reference) differences.push({ table: name, field: fieldName, type: 'reference_changed', from: field.reference, to: b.reference, severity: 'breaking' });
      if (field.maxLength !== b.maxLength) differences.push({ table: name, field: fieldName, type: 'max_length_changed', from: field.maxLength, to: b.maxLength, severity: b.maxLength && field.maxLength && b.maxLength < field.maxLength ? 'breaking' : 'info' });
      const aChoices = new Set(field.choices.map(c => c.value));
      const bChoices = new Set(b.choices.map(c => c.value));
      for (const value of aChoices) if (!bChoices.has(value)) differences.push({ table: name, field: fieldName, type: 'choice_removed', from: value, severity: 'breaking' });
      for (const value of bChoices) if (!aChoices.has(value)) differences.push({ table: name, field: fieldName, type: 'choice_added', to: value, severity: 'info' });
    }
    for (const fieldName of bFields.keys()) if (!aFields.has(fieldName)) differences.push({ table: name, field: fieldName, type: 'field_added', severity: 'info' });
  }
  for (const name of toTables.keys()) if (!fromTables.has(name)) differences.push({ table: name, type: 'table_added', severity: 'info' });
  return differences;
}

export interface SchemaCache {
  get(table: string): Promise<NewBridgeTableSchema | undefined>;
  set(table: string, schema: NewBridgeTableSchema, ttlMs?: number): Promise<void>;
  clear?(table?: string): Promise<void>;
}

export class MemorySchemaCache implements SchemaCache {
  private entries = new Map<string, { value: NewBridgeTableSchema; expiresAt: number }>();
  constructor(private readonly defaultTtlMs = 5 * 60_000) {}
  async get(table: string): Promise<NewBridgeTableSchema | undefined> {
    const entry = this.entries.get(table);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.entries.delete(table); return undefined; }
    return structuredClone(entry.value);
  }
  async set(table: string, schema: NewBridgeTableSchema, ttlMs = this.defaultTtlMs): Promise<void> {
    this.entries.set(table, { value: structuredClone(schema), expiresAt: Date.now() + ttlMs });
  }
  async clear(table?: string): Promise<void> { if (table) this.entries.delete(table); else this.entries.clear(); }
}

export class CachedSchemaDiscovery extends SchemaDiscovery {
  constructor(transport: Transport, private readonly cache: SchemaCache, options: SchemaDiscoveryOptions = {}, private readonly ttlMs = 5 * 60_000) {
    super(transport, options);
  }
  override async describeTable(table: string): Promise<NewBridgeTableSchema> {
    const cached = await this.cache.get(table);
    if (cached) return cached;
    const schema = await super.describeTable(table);
    await this.cache.set(table, schema, this.ttlMs);
    return schema;
  }
}
