import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import type { NewBridge } from '@newbridge/sdk';
import { PolicyEngine, type PolicyDocument, type Operation } from '@newbridge/policy';

export interface NewBridgeMcpOptions {
  name?: string;
  version?: string;
  connectionName?: string;
  policy?: PolicyDocument | unknown;
  actor?: string;
  allowWrite?: boolean;
  maxRecords?: number;
  maxOutputBytes?: number;
  allowedTables?: string[];
}

function textResult(value: unknown, maxBytes: number) {
  const raw = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(raw);
  const text = bytes <= maxBytes ? raw : `${raw.slice(0, Math.max(0, maxBytes - 120))}\n...[truncated by NewBridge MCP output limit]`;
  return { content: [{ type: 'text' as const, text }] };
}

export function createMcpServer(nb: NewBridge, options: NewBridgeMcpOptions = {}): McpServer {
  const server = new McpServer({ name: options.name ?? 'newbridge-servicenow', version: options.version ?? '0.1.0' });
  const connection = options.connectionName ?? 'default';
  const policy = new PolicyEngine(options.policy ?? {
    default: 'deny',
    allow: [{ tables: ['*'], operations: ['read'] }],
    deny: [], approvals: [], redaction: { fields: ['password','token','secret'], regex: [] }
  });
  const maxRecords = Math.min(Math.max(options.maxRecords ?? 50, 1), 500);
  const maxBytes = Math.min(Math.max(options.maxOutputBytes ?? 100_000, 1_000), 1_000_000);
  const tableAllowed = (table: string) => !options.allowedTables?.length || options.allowedTables.includes(table);
  const check = (table: string, operation: Operation, fields?: string[]) => {
    if (!tableAllowed(table)) throw new Error(`Table ${table} is not in the MCP table allowlist`);
    const decision = policy.evaluate({ actor: options.actor ?? 'mcp-agent', actorType: 'agent', connection, table, operation, fields });
    if (!decision.allowed) throw new Error(`Policy denied ${operation} on ${table}: ${decision.reason}`);
    if (decision.approvalRequired) throw new Error(`Operation requires approval and cannot execute directly through this MCP transport: ${decision.approvalReason}`);
    return decision;
  };

  server.registerTool('servicenow_list_tables', {
    description: 'List ServiceNow tables accessible to the configured integration identity.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(5000).default(500) })
  }, async ({ limit }) => {
    check('sys_db_object', 'read', ['name']);
    const tables = await nb.schemaDiscovery({ tableLimit: limit }).listTables();
    const filtered = options.allowedTables?.length ? tables.filter(t => options.allowedTables!.includes(t)) : tables;
    return textResult({ tables: filtered }, maxBytes);
  });

  server.registerTool('servicenow_schema', {
    description: 'Read schema metadata for one ServiceNow table. Returns fields, types, references and choice values.',
    inputSchema: z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/) })
  }, async ({ table }) => {
    check(table, 'read');
    const schema = await nb.schemaDiscovery({ includeTables: [table] }).describeTable(table);
    return textResult(policy.redact(schema), maxBytes);
  });

  server.registerTool('servicenow_query', {
    description: 'Query ServiceNow records using safe structured filters. Arbitrary encoded query strings are intentionally not exposed.',
    inputSchema: z.object({
      table: z.string().regex(/^[A-Za-z0-9_]+$/),
      filters: z.array(z.object({ field: z.string().regex(/^[A-Za-z0-9_.]+$/), op: z.enum(['=','!=','>','>=','<','<=','LIKE','STARTSWITH','ENDSWITH','IN']), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(),z.number(),z.boolean()]))]) })).default([]),
      fields: z.array(z.string().regex(/^[A-Za-z0-9_.]+$/)).max(100).optional(),
      limit: z.number().int().min(1).max(maxRecords).default(Math.min(20, maxRecords))
    })
  }, async ({ table, filters, fields, limit }) => {
    const decision = check(table, 'read', fields);
    const client = nb.table(table);
    for (const filter of filters) {
      if (filter.op === 'IN') client.whereIn(filter.field, Array.isArray(filter.value) ? filter.value : [filter.value]);
      else client.where(filter.field, filter.op as any, filter.value as any);
    }
    if (decision.filteredFields?.length) client.select(decision.filteredFields);
    else if (fields?.length) client.select(fields);
    const rows = await client.limit(limit).find();
    return textResult(policy.redact({ count: rows.length, records: rows }), maxBytes);
  });

  server.registerTool('servicenow_get_record', {
    description: 'Get one ServiceNow record by table and sys_id.',
    inputSchema: z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), sysId: z.string().min(1).max(64), fields: z.array(z.string().regex(/^[A-Za-z0-9_.]+$/)).max(100).optional() })
  }, async ({ table, sysId, fields }) => {
    const decision = check(table, 'read', fields); const client = nb.table(table);
    if (decision.filteredFields?.length) client.select(decision.filteredFields); else if (fields?.length) client.select(fields);
    return textResult(policy.redact(await client.get(sysId)), maxBytes);
  });

  if (options.allowWrite) {
    server.registerTool('servicenow_create_record', {
      description: 'Create a ServiceNow record. Availability is controlled by NewBridge policy.',
      inputSchema: z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), record: z.record(z.string(), z.unknown()) })
    }, async ({ table, record }) => { check(table, 'create', Object.keys(record)); return textResult(policy.redact(await nb.table(table).create(record)), maxBytes); });

    server.registerTool('servicenow_update_record', {
      description: 'Update a ServiceNow record. Availability is controlled by NewBridge policy.',
      inputSchema: z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), sysId: z.string().min(1).max(64), record: z.record(z.string(), z.unknown()) })
    }, async ({ table, sysId, record }) => { check(table, 'update', Object.keys(record)); return textResult(policy.redact(await nb.table(table).update(sysId, record)), maxBytes); });
  }

  return server;
}

export function serveMcpStdio(factory: () => McpServer) {
  return serveStdio(factory);
}
