import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export interface EmulatorFaults {
  latency?: { probability: number; delayMs: number };
  errors?: Record<string, { probability: number }>;
  rateLimit?: { afterRequests: number; retryAfterSeconds?: number };
}

export interface EmulatorOptions {
  host?: string;
  port?: number;
  faults?: EmulatorFaults;
  schemas?: Record<string, { mandatory?: string[]; readOnly?: string[] }>;
}

export class EmulatorStore {
  private tables = new Map<string, Map<string, Record<string, any>>>();
  private attachments = new Map<string, { meta: Record<string, any>; bytes: Uint8Array }>();
  table(name: string): Map<string, Record<string, any>> {
    let table = this.tables.get(name);
    if (!table) { table = new Map(); this.tables.set(name, table); }
    return table;
  }
  seed(table: string, rows: Record<string, any>[]): void {
    const target = this.table(table);
    for (const row of rows) {
      const sysId = String(row.sys_id ?? randomUUID().replaceAll('-', ''));
      target.set(sysId, { ...row, sys_id: sysId, sys_created_on: row.sys_created_on ?? now(), sys_updated_on: row.sys_updated_on ?? now() });
    }
  }
  setAttachment(id: string, meta: Record<string, any>, bytes: Uint8Array): void { this.attachments.set(id, { meta, bytes }); }
  getAttachment(id: string) { return this.attachments.get(id); }
  deleteAttachment(id: string): boolean { return this.attachments.delete(id); }
  listAttachments(): Array<{ meta: Record<string, any>; bytes: Uint8Array }> { return [...this.attachments.values()]; }
}

function now(): string { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function truthy(v: unknown): boolean { return v === true || v === 'true' || v === '1'; }

function matchTerm(row: Record<string, any>, term: string): boolean {
  if (!term || term.startsWith('ORDERBY')) return true;
  const operators = ['ISNOTEMPTY', 'ISEMPTY', 'NOTIN', 'STARTSWITH', 'ENDSWITH', 'NOTLIKE', 'INSTANCEOF', 'BETWEEN', 'IN', 'LIKE', '>=', '<=', '!=', '>', '<', '='];
  const op = operators.find(o => term.includes(o));
  if (!op) return true;
  const index = term.indexOf(op);
  const field = term.slice(0, index);
  const raw = term.slice(index + op.length);
  const value = field.split('.').reduce((acc: any, key) => acc?.[key], row);
  const str = value == null ? '' : String(value);
  switch (op) {
    case 'ISNOTEMPTY': return value !== undefined && value !== null && str !== '';
    case 'ISEMPTY': return value === undefined || value === null || str === '';
    case 'IN': return raw.split(',').includes(str);
    case 'NOTIN': return !raw.split(',').includes(str);
    case 'LIKE': return str.toLowerCase().includes(raw.toLowerCase());
    case 'NOTLIKE': return !str.toLowerCase().includes(raw.toLowerCase());
    case 'STARTSWITH': return str.startsWith(raw);
    case 'ENDSWITH': return str.endsWith(raw);
    case 'BETWEEN': { const [a, b] = raw.split('@'); return str >= (a ?? '') && str <= (b ?? ''); }
    case '>=': return str >= raw;
    case '<=': return str <= raw;
    case '>': return str > raw;
    case '<': return str < raw;
    case '!=': return str !== raw;
    case '=': return str === raw || (typeof value === 'boolean' && truthy(raw) === value);
    default: return true;
  }
}

function applyEncodedQuery(rows: Record<string, any>[], query = ''): Record<string, any>[] {
  if (!query) return rows;
  const terms = query.split('^');
  const orderTerms = terms.filter(t => t.startsWith('ORDERBY'));
  const filterTerms = terms.filter(t => !t.startsWith('ORDERBY'));
  let result = rows.filter(row => {
    let ok = true;
    for (const term of filterTerms) {
      if (term.startsWith('OR')) ok = ok || matchTerm(row, term.slice(2));
      else ok = ok && matchTerm(row, term);
    }
    return ok;
  });
  for (const term of orderTerms.reverse()) {
    const desc = term.startsWith('ORDERBYDESC');
    const field = term.replace(/^ORDERBYDESC|^ORDERBY/, '');
    result = result.toSorted((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * (desc ? -1 : 1));
  }
  return result;
}

async function maybeFault(faults: EmulatorFaults | undefined, requestNumber: number): Promise<{ status: number; retryAfter?: number } | undefined> {
  if (!faults) return;
  if (faults.latency && Math.random() < faults.latency.probability) await new Promise(r => setTimeout(r, faults.latency!.delayMs));
  if (faults.rateLimit && requestNumber > faults.rateLimit.afterRequests) return { status: 429, retryAfter: faults.rateLimit.retryAfterSeconds ?? 1 };
  for (const [status, config] of Object.entries(faults.errors ?? {})) if (Math.random() < config.probability) return { status: Number(status) };
}

export function createEmulator(options: EmulatorOptions = {}): { app: FastifyInstance; store: EmulatorStore } {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  const store = new EmulatorStore();
  let requestNumber = 0;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (_req, reply) => {
    requestNumber++;
    const fault = await maybeFault(options.faults, requestNumber);
    if (fault) {
      if (fault.retryAfter) reply.header('retry-after', String(fault.retryAfter));
      return reply.code(fault.status).send({ error: { message: `Injected HTTP ${fault.status}` } });
    }
  });

  app.get('/health', async () => ({ status: 'ok', emulator: true }));

  app.get('/api/now/:version?/table/:table', async (req: any) => {
    const { table } = req.params;
    const q = req.query ?? {};
    let rows = applyEncodedQuery([...store.table(table).values()], String(q.sysparm_query ?? ''));
    const offset = Math.max(0, Number(q.sysparm_offset ?? 0));
    const limit = Math.max(1, Math.min(10000, Number(q.sysparm_limit ?? 1000)));
    rows = rows.slice(offset, offset + limit);
    if (q.sysparm_fields) {
      const fields = String(q.sysparm_fields).split(',');
      rows = rows.map(row => Object.fromEntries(fields.map(f => [f, row[f]])));
    }
    return { result: rows };
  });

  app.get('/api/now/:version?/table/:table/:sysId', async (req: any, reply) => {
    const row = store.table(req.params.table).get(req.params.sysId);
    if (!row) return reply.code(404).send({ error: { message: 'Record not found' } });
    return { result: row };
  });

  app.post('/api/now/:version?/table/:table', async (req: any, reply) => {
    const sysId = randomUUID().replaceAll('-', '');
    const schema = options.schemas?.[req.params.table];
    const body = { ...(req.body ?? {}) };
    for (const field of schema?.mandatory ?? []) if (body[field] === undefined || body[field] === '') return reply.code(400).send({ error: { message: `Mandatory field missing: ${field}` } });
    const created = { ...body, sys_id: sysId, sys_created_on: now(), sys_updated_on: now() };
    store.table(req.params.table).set(sysId, created);
    return reply.code(201).send({ result: created });
  });

  app.patch('/api/now/:version?/table/:table/:sysId', async (req: any, reply) => {
    const table = store.table(req.params.table);
    const current = table.get(req.params.sysId);
    if (!current) return reply.code(404).send({ error: { message: 'Record not found' } });
    const schema = options.schemas?.[req.params.table];
    for (const field of schema?.readOnly ?? []) if (Object.hasOwn(req.body ?? {}, field)) return reply.code(400).send({ error: { message: `Read-only field: ${field}` } });
    const updated = { ...current, ...(req.body ?? {}), sys_id: req.params.sysId, sys_updated_on: now() };
    table.set(req.params.sysId, updated);
    return { result: updated };
  });

  app.delete('/api/now/:version?/table/:table/:sysId', async (req: any, reply) => {
    if (!store.table(req.params.table).delete(req.params.sysId)) return reply.code(404).send({ error: { message: 'Record not found' } });
    return reply.code(204).send();
  });

  app.get('/api/now/:version?/attachment', async (req: any) => {
    const q = req.query ?? {};
    const all = store.listAttachments().map(x => x.meta);
    const filtered = all.filter(meta => (!q.table_name || meta.table_name === q.table_name) && (!q.table_sys_id || meta.table_sys_id === q.table_sys_id));
    return { result: filtered };
  });

  app.get('/api/now/:version?/attachment/:sysId', async (req: any, reply) => {
    const item = store.getAttachment(req.params.sysId);
    if (!item) return reply.code(404).send({ error: { message: 'Attachment not found' } });
    return { result: item.meta };
  });

  app.get('/api/now/:version?/attachment/:sysId/file', async (req: any, reply) => {
    const item = store.getAttachment(req.params.sysId);
    if (!item) return reply.code(404).send({ error: { message: 'Attachment not found' } });
    reply.type(item.meta.content_type ?? 'application/octet-stream');
    return reply.send(Buffer.from(item.bytes));
  });

  app.post('/api/now/:version?/attachment/file', async (req: any, reply) => {
    const q = req.query ?? {};
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(req.body)) chunks.push(req.body);
    else if (req.body instanceof Uint8Array) chunks.push(Buffer.from(req.body));
    else if (typeof req.body === 'string') chunks.push(Buffer.from(req.body));
    else if (req.raw.readable) for await (const chunk of req.raw) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const id = randomUUID().replaceAll('-', '');
    const meta = { sys_id: id, file_name: q.file_name ?? 'file.bin', content_type: req.headers['content-type'] ?? 'application/octet-stream', size_bytes: String(bytes.length), table_name: q.table_name, table_sys_id: q.table_sys_id };
    store.setAttachment(id, meta, bytes);
    return reply.code(201).send({ result: meta });
  });

  app.delete('/api/now/:version?/attachment/:sysId', async (req: any, reply) => {
    if (!store.deleteAttachment(req.params.sysId)) return reply.code(404).send({ error: { message: 'Attachment not found' } });
    return reply.code(204).send();
  });

  app.post('/api/now/:version?/import/:table', async (req: any) => ({ result: [{ status: 'inserted', sys_id: randomUUID().replaceAll('-', ''), source: req.body }] }));
  app.post('/api/now/:version?/import/:table/insertMultiple', async (req: any) => ({ result: { status: 'pending', batch_sys_id: randomUUID().replaceAll('-', ''), source: req.body } }));

  return { app, store };
}

export async function startEmulator(options: EmulatorOptions = {}): Promise<{ app: FastifyInstance; store: EmulatorStore; url: string }> {
  const { app, store } = createEmulator(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8181;
  await app.listen({ host, port });
  return { app, store, url: `http://${host}:${port}` };
}

export async function seedFromFile(store: EmulatorStore, file: string): Promise<void> {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const schema = z.record(z.array(z.record(z.unknown()))).parse(parsed);
  for (const [table, rows] of Object.entries(schema)) store.seed(table, rows as Record<string, any>[]);
}
