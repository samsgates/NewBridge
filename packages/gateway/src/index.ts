import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { NewBridge, type NewBridgeConfig } from '@newbridge/sdk';
import { PolicyEngine, type PolicyDocument, type Operation } from '@newbridge/policy';
import { JsonLogger, InMemoryMetrics, Telemetry, type Logger } from '@newbridge/telemetry';

export interface GatewayConnection extends NewBridgeConfig { name: string }
export interface GatewayActor { id: string; type: 'service' | 'user' | 'agent' }
export interface GatewayAuthenticator { authenticate(request: FastifyRequest): Promise<GatewayActor | undefined> }
export interface GatewayOptions {
  host?: string;
  port?: number;
  connections: GatewayConnection[];
  apiKeys?: Array<string | { key: string; actor: GatewayActor }>;
  policy?: PolicyDocument | unknown;
  databaseUrl?: string;
  redisUrl?: string;
  logger?: Logger;
  maxBodyBytes?: number;
  connectorSecret?: string;
  onConnectorEvent?: (event: Record<string, unknown>) => Promise<void> | void;
  allowRawQuery?: boolean;
  authenticator?: GatewayAuthenticator;
}

type Actor = GatewayActor
interface StoredApproval { id: string; actor: string; connection: string; table: string; operation: string; payload: unknown; status: string; expiresAt: string }
interface IdempotentValue { requestHash: string; status: number; response: unknown; expiresAt: number }

interface Store {
  init(): Promise<void>;
  audit(event: Record<string, unknown>): Promise<void>;
  getIdempotency(key: string): Promise<IdempotentValue | undefined>;
  putIdempotency(key: string, value: IdempotentValue): Promise<void>;
  createApproval(value: Omit<StoredApproval, 'id' | 'status'>): Promise<StoredApproval>;
  getApproval(id: string): Promise<StoredApproval | undefined>;
  setApprovalStatus(id: string, status: string): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

class MemoryStore implements Store {
  private idempotency = new Map<string, IdempotentValue>();
  private approvals = new Map<string, StoredApproval>();
  async init() {}
  async audit(_event: Record<string, unknown>) {}
  async getIdempotency(key: string) { const v = this.idempotency.get(key); if (v && v.expiresAt > Date.now()) return v; this.idempotency.delete(key); return undefined; }
  async putIdempotency(key: string, value: IdempotentValue) { this.idempotency.set(key, value); }
  async createApproval(value: Omit<StoredApproval, 'id' | 'status'>) { const a = { ...value, id: `approval_${randomUUID()}`, status: 'pending' }; this.approvals.set(a.id, a); return a; }
  async getApproval(id: string) { return this.approvals.get(id); }
  async setApprovalStatus(id: string, status: string) { const a = this.approvals.get(id); if (a) a.status = status; }
  async ready() { return true; }
  async close() {}
}

class PgStore implements Store {
  readonly pool: Pool;
  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 }); }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS nb_audit_events (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nb_idempotency (
        key text PRIMARY KEY, request_hash text NOT NULL, status integer NOT NULL, response jsonb, expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nb_approvals (
        id text PRIMARY KEY, actor text NOT NULL, connection text NOT NULL, table_name text NOT NULL, operation text NOT NULL,
        payload jsonb, status text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS nb_audit_created_at_idx ON nb_audit_events(created_at);
      CREATE INDEX IF NOT EXISTS nb_approvals_status_idx ON nb_approvals(status);
    `);
  }
  async audit(event: Record<string, unknown>) { await this.pool.query('INSERT INTO nb_audit_events(id,payload) VALUES($1,$2)', [randomUUID(), JSON.stringify(event)]); }
  async getIdempotency(key: string): Promise<IdempotentValue | undefined> {
    const r = await this.pool.query('SELECT request_hash,status,response,expires_at FROM nb_idempotency WHERE key=$1 AND expires_at > now()', [key]);
    if (!r.rows[0]) return undefined;
    return { requestHash: r.rows[0].request_hash, status: r.rows[0].status, response: r.rows[0].response, expiresAt: new Date(r.rows[0].expires_at).getTime() };
  }
  async putIdempotency(key: string, value: IdempotentValue) {
    await this.pool.query(`INSERT INTO nb_idempotency(key,request_hash,status,response,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))
      ON CONFLICT(key) DO UPDATE SET request_hash=excluded.request_hash,status=excluded.status,response=excluded.response,expires_at=excluded.expires_at`,
      [key, value.requestHash, value.status, JSON.stringify(value.response), value.expiresAt]);
  }
  async createApproval(value: Omit<StoredApproval, 'id' | 'status'>): Promise<StoredApproval> {
    const a: StoredApproval = { ...value, id: `approval_${randomUUID()}`, status: 'pending' };
    await this.pool.query('INSERT INTO nb_approvals(id,actor,connection,table_name,operation,payload,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [a.id,a.actor,a.connection,a.table,a.operation,JSON.stringify(a.payload),a.status,a.expiresAt]);
    return a;
  }
  async getApproval(id: string): Promise<StoredApproval | undefined> {
    const r = await this.pool.query('SELECT * FROM nb_approvals WHERE id=$1', [id]); const x = r.rows[0]; if (!x) return undefined;
    return { id:x.id, actor:x.actor, connection:x.connection, table:x.table_name, operation:x.operation, payload:x.payload, status:x.status, expiresAt:new Date(x.expires_at).toISOString() };
  }
  async setApprovalStatus(id: string, status: string) { await this.pool.query('UPDATE nb_approvals SET status=$2 WHERE id=$1', [id,status]); }
  async ready() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async close() { await this.pool.end(); }
}

function hash(input: string): string { return createHash('sha256').update(input).digest('hex'); }
function secureEqual(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function actorFrom(request: FastifyRequest): Actor { return (request as any).newbridgeActor ?? { id: 'unauthenticated', type: 'service' }; }

class JobEngine {
  readonly queue?: Queue;
  readonly worker?: Worker;
  private local = new Map<string, any>();
  constructor(redisUrl: string | undefined, handler: (payload: any) => Promise<any>) {
    if (redisUrl) {
      const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue('newbridge-jobs', { connection });
      this.worker = new Worker('newbridge-jobs', async (job: Job) => handler(job.data), { connection, concurrency: 5 });
    } else this.handler = handler;
  }
  private handler?: (payload: any) => Promise<any>;
  async add(payload: any): Promise<string> {
    if (this.queue) { const job = await this.queue.add(payload.type ?? 'job', payload, { attempts: 3, backoff: { type: 'exponential', delay: 500 }, removeOnComplete: 1000, removeOnFail: 1000 }); return String(job.id); }
    const id = randomUUID(); this.local.set(id, { id, status: 'running' });
    void this.handler!(payload).then(result => this.local.set(id, { id, status: 'completed', result })).catch(error => this.local.set(id, { id, status: 'failed', error: error.message }));
    return id;
  }
  async get(id: string): Promise<any> {
    if (this.queue) { const job = await this.queue.getJob(id); if (!job) return; return { id, status: await job.getState(), progress: job.progress, result: job.returnvalue, error: job.failedReason }; }
    return this.local.get(id);
  }
  async close() { await this.worker?.close(); await this.queue?.close(); }
}

export async function createGateway(options: GatewayOptions): Promise<{ app: FastifyInstance; close(): Promise<void> }> {
  const logger = options.logger ?? new JsonLogger((process.env.LOG_LEVEL as any) ?? 'info');
  const metrics = new InMemoryMetrics();
  const telemetry = new Telemetry('@newbridge/gateway');
  const app = Fastify({ logger: false, bodyLimit: options.maxBodyBytes ?? 5 * 1024 * 1024 });
  const clients = new Map(options.connections.map(c => [c.name, new NewBridge(c)]));
  const policy = new PolicyEngine(options.policy ?? { default: 'deny', allow: [{ tables: ['*'], operations: ['read'] }], deny: [], approvals: [], redaction: { fields: ['password','token','secret'], regex: [] } });
  const store: Store = options.databaseUrl ? new PgStore(options.databaseUrl) : new MemoryStore();
  await store.init();
  logger.info('NewBridge Gateway initialized', { connections: options.connections.map(c => c.name), database: Boolean(options.databaseUrl), redis: Boolean(options.redisUrl) });
  const keyEntries = (options.apiKeys ?? []).map(entry => typeof entry === 'string' ? { hash: hash(entry), actor: { id: 'api-key', type: 'service' as const } } : { hash: hash(entry.key), actor: entry.actor });

  const jobs = new JobEngine(options.redisUrl, async payload => {
    const nb = clients.get(payload.connection); if (!nb) throw new Error('Unknown connection');
    if (payload.type === 'bulkCreate') return nb.table(payload.table).bulkCreate(payload.records, payload.options);
    if (payload.type === 'schemaPull') return nb.schema.pull();
    throw new Error(`Unknown job type ${payload.type}`);
  });

  app.setErrorHandler((error: any, request, reply) => {
    const isZod = error?.name === 'ZodError';
    const status = Number(error?.status ?? error?.statusCode ?? (isZod ? 400 : 500));
    const safeStatus = status >= 400 && status <= 599 ? status : 500;
    const code = error?.code ?? (isZod ? 'NB_VALIDATION' : 'NB_INTERNAL');
    if (safeStatus >= 500) logger.error('Gateway request failed', { request_id: request.id, code, status: safeStatus, message: error instanceof Error ? error.message : String(error) });
    else logger.warn('Gateway request rejected', { request_id: request.id, code, status: safeStatus });
    reply.code(safeStatus).send({ error: { code, message: safeStatus >= 500 ? 'NewBridge Gateway request failed' : (error instanceof Error ? error.message : String(error)), request_id: request.id } });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.inc('newbridge_requests_total');
    if (reply.statusCode >= 500) metrics.inc('newbridge_requests_5xx_total');
    logger.debug('Gateway request completed', { request_id: request.id, method: request.method, url: request.url, status: reply.statusCode });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' || request.url === '/ready' || request.url.startsWith('/v1/connector/events')) return;
    if (options.authenticator) {
      const actor = await options.authenticator.authenticate(request);
      if (!actor) return reply.code(401).send({ error: { code: 'NB_GATEWAY_AUTH', message: 'Gateway authentication failed' } });
      (request as any).newbridgeActor = actor;
      return;
    }
    if (!keyEntries.length) return;
    const presented = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const presentedHash = hash(presented);
    const matched = keyEntries.find(entry => secureEqual(entry.hash, presentedHash));
    if (!matched) return reply.code(401).send({ error: { code: 'NB_GATEWAY_AUTH', message: 'Invalid NewBridge Gateway API key' } });
    (request as any).newbridgeActor = matched.actor;
  });

  const getClient = (connection: string, reply: FastifyReply) => {
    const nb = clients.get(connection);
    if (!nb) { void reply.code(404).send({ error: { code: 'NB_CONNECTION_NOT_FOUND', message: `Unknown connection ${connection}` } }); return; }
    return nb;
  };

  const authorize = async (request: FastifyRequest, reply: FastifyReply, connection: string, table: string, operation: Operation, fields?: string[], payload?: any) => {
    const actor = actorFrom(request);
    const decision = policy.evaluate({ actor: actor.id, actorType: actor.type, connection, table, operation, fields, payload });
    if (!decision.allowed) { await audit(request, actor, connection, table, operation, 'denied'); void reply.code(403).send({ error: { code: 'NB_POLICY_DENIED', message: decision.reason } }); return; }
    if (decision.approvalRequired) {
      const approval = await store.createApproval({ actor: actor.id, connection, table, operation, payload, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
      await audit(request, actor, connection, table, operation, 'approval_required', approval.id);
      void reply.code(202).send({ status: 'approval_required', approval_id: approval.id, reason: decision.approvalReason }); return;
    }
    return { actor, decision };
  };

  const audit = async (request: FastifyRequest, actor: Actor, connection: string, table: string, operation: string, result: string, approvalId?: string) => {
    const event = policy.redact({ timestamp: new Date().toISOString(), actor: actor.id, actor_type: actor.type, connection, table, operation, result, approval_id: approvalId, request_id: request.id, source_ip: request.ip });
    await store.audit(event);
  };

  app.get('/health', async () => ({ status: 'ok', service: 'newbridge-gateway', version: '0.1.0' }));
  app.get('/ready', async (_req, reply) => {
    const db = await store.ready(); if (!db) return reply.code(503).send({ status: 'not_ready', database: false });
    return { status: 'ready', database: true, connections: [...clients.keys()] };
  });
  app.get('/metrics', async () => metrics.snapshot());

  app.post('/v1/connector/events', async (req: any, reply) => {
    if (!options.connectorSecret) return reply.code(404).send({ error: { code: 'NB_CONNECTOR_DISABLED', message: 'Connector ingestion is not configured' } });
    const delivery = String(req.headers['x-newbridge-delivery'] ?? '');
    const timestamp = String(req.headers['x-newbridge-timestamp'] ?? '');
    const signature = String(req.headers['x-newbridge-signature'] ?? '');
    const event = z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), sys_id: z.string().min(1).max(64), operation: z.enum(['insert','update','delete']), sys_updated_on: z.string().optional(), delivery_id: z.string().optional(), timestamp: z.string().optional() }).passthrough().parse(req.body ?? {});
    if (!delivery || !timestamp || !signature) return reply.code(401).send({ error: { code: 'NB_CONNECTOR_SIGNATURE', message: 'Missing connector signature headers' } });
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) return reply.code(401).send({ error: { code: 'NB_CONNECTOR_REPLAY', message: 'Connector timestamp is outside the accepted replay window' } });
    const canonical = [timestamp, delivery, event.table, event.sys_id, event.operation, event.sys_updated_on ?? ''].join('\n');
    const expected = createHmac('sha256', Buffer.from(options.connectorSecret, 'base64')).update(canonical).digest('base64');
    if (!secureEqual(expected, signature)) return reply.code(401).send({ error: { code: 'NB_CONNECTOR_SIGNATURE', message: 'Invalid connector signature' } });
    await store.audit({ timestamp: new Date().toISOString(), actor: 'servicenow-connector', actor_type: 'service', connection: 'connector', table: event.table, operation: event.operation, result: 'accepted', request_id: req.id, delivery_id: delivery, record_sys_id: event.sys_id });
    await options.onConnectorEvent?.({ ...event, delivery_id: delivery, received_at: new Date().toISOString(), source: 'connector' });
    return reply.code(202).send({ accepted: true, delivery_id: delivery });
  });

  app.get('/v1/connections/:connection/health', async (req: any, reply) => { const nb = getClient(req.params.connection, reply); return nb ? nb.health() : undefined; });
  app.get('/v1/connections/:connection/schema', async (req: any, reply) => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const auth = await authorize(req, reply, req.params.connection, 'sys_dictionary', 'read'); if (!auth) return;
    return nb.schema.pull();
  });

  app.get('/v1/connections/:connection/tables/:table/records', async (req: any, reply) => telemetry.span('gateway.table.list', { connection: req.params.connection, table: req.params.table }, async () => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const q = req.query ?? {}; const fields = q.fields ? String(q.fields).split(',') : undefined;
    const auth = await authorize(req, reply, req.params.connection, req.params.table, 'read', fields); if (!auth) return;
    const client = nb.table(req.params.table);
    if (q.query) {
      if (!options.allowRawQuery) return reply.code(400).send({ error: { code: 'NB_RAW_QUERY_DISABLED', message: 'Raw encoded queries are disabled on this Gateway. Use structured SDK queries or explicitly enable the operator-controlled escape hatch.' } });
      const raw = String(q.query);
      if (raw.includes('javascript:')) return reply.code(400).send({ error: { code: 'NB_UNSAFE_QUERY', message: 'javascript: queries are disabled' } });
      return nb.rest.call({ method: 'GET', path: `/api/now/table/${encodeURIComponent(req.params.table)}`, query: { sysparm_query: raw, sysparm_fields: auth.decision.filteredFields?.join(','), sysparm_limit: Math.min(Number(q.limit ?? 100), 1000), sysparm_offset: Number(q.offset ?? 0) } });
    }
    if (auth.decision.filteredFields?.length) client.select(auth.decision.filteredFields);
    client.limit(Math.min(Number(q.limit ?? 100), 1000)).offset(Math.max(0, Number(q.offset ?? 0)));
    return { result: await client.find() };
  }));

  app.get('/v1/connections/:connection/tables/:table/records/:sysId', async (req: any, reply) => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const q = req.query ?? {}; const fields = q.fields ? String(q.fields).split(',') : undefined;
    const auth = await authorize(req, reply, req.params.connection, req.params.table, 'read', fields); if (!auth) return;
    const client = nb.table(req.params.table); if (auth.decision.filteredFields?.length) client.select(auth.decision.filteredFields);
    const result = await client.get(req.params.sysId); await audit(req, auth.actor, req.params.connection, req.params.table, 'read', 'success'); return { result };
  });

  app.post('/v1/connections/:connection/tables/:table/records', async (req: any, reply) => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const payload = z.record(z.unknown()).parse(req.body ?? {}); const fields = Object.keys(payload);
    const auth = await authorize(req, reply, req.params.connection, req.params.table, 'create', fields, payload); if (!auth) return;
    const idem = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined;
    const requestHash = hash(JSON.stringify(payload));
    if (idem) {
      const existing = await store.getIdempotency(idem);
      if (existing) {
        if (existing.requestHash !== requestHash) return reply.code(409).send({ error: { code: 'NB_IDEMPOTENCY_CONFLICT', message: 'Idempotency key reused with different payload' } });
        return reply.code(existing.status).send(existing.response);
      }
    }
    const response = { result: await nb.table(req.params.table).create(payload) };
    if (idem) await store.putIdempotency(idem, { requestHash, status: 201, response, expiresAt: Date.now() + 24 * 60 * 60_000 });
    await audit(req, auth.actor, req.params.connection, req.params.table, 'create', 'success'); return reply.code(201).send(response);
  });

  app.patch('/v1/connections/:connection/tables/:table/records/:sysId', async (req: any, reply) => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const payload = z.record(z.unknown()).parse(req.body ?? {}); const auth = await authorize(req, reply, req.params.connection, req.params.table, 'update', Object.keys(payload), { sysId: req.params.sysId, record: payload }); if (!auth) return;
    const result = await nb.table(req.params.table).update(req.params.sysId, payload); await audit(req, auth.actor, req.params.connection, req.params.table, 'update', 'success'); return { result };
  });

  app.delete('/v1/connections/:connection/tables/:table/records/:sysId', async (req: any, reply) => {
    const nb = getClient(req.params.connection, reply); if (!nb) return;
    const auth = await authorize(req, reply, req.params.connection, req.params.table, 'delete', undefined, { sysId: req.params.sysId }); if (!auth) return;
    await nb.table(req.params.table).delete(req.params.sysId); await audit(req, auth.actor, req.params.connection, req.params.table, 'delete', 'success'); return reply.code(204).send();
  });

  app.post('/v1/jobs/bulk-create', async (req: any, reply) => {
    const body = z.object({ connection: z.string(), table: z.string(), records: z.array(z.record(z.unknown())).max(100000), options: z.record(z.unknown()).optional() }).parse(req.body);
    const auth = await authorize(req, reply, body.connection, body.table, 'create', body.records.flatMap(x => Object.keys(x))); if (!auth) return;
    const id = await jobs.add({ type: 'bulkCreate', ...body }); return reply.code(202).send({ id, status: 'queued' });
  });
  app.get('/v1/jobs/:id', async (req: any, reply) => { const job = await jobs.get(req.params.id); return job ?? reply.code(404).send({ error: { message: 'Job not found' } }); });

  app.get('/v1/approvals/:id', async (req: any, reply) => { const a = await store.getApproval(req.params.id); return a ?? reply.code(404).send({ error: { message: 'Approval not found' } }); });
  app.post('/v1/approvals/:id/approve', async (req: any, reply) => {
    const approval = await store.getApproval(req.params.id); if (!approval) return reply.code(404).send({ error: { message: 'Approval not found' } });
    if (approval.status !== 'pending' || new Date(approval.expiresAt).getTime() < Date.now()) return reply.code(409).send({ error: { message: 'Approval is not active' } });
    const nb = clients.get(approval.connection); if (!nb) return reply.code(404).send({ error: { message: 'Connection not found' } });
    let result: unknown;
    const payload = approval.payload as any;
    if (approval.operation === 'create') result = await nb.table(approval.table).create(payload);
    else if (approval.operation === 'update' && payload?.sysId) result = await nb.table(approval.table).update(payload.sysId, payload.record ?? {});
    else if (approval.operation === 'delete' && payload?.sysId) result = await nb.table(approval.table).delete(payload.sysId);
    else return reply.code(400).send({ error: { message: 'Approval payload cannot be executed automatically' } });
    await store.setApprovalStatus(approval.id, 'approved'); return { status: 'approved', result };
  });

  return {
    app,
    async close() { await jobs.close(); await store.close(); await app.close(); }
  };
}

export async function startGatewayFromEnv(): Promise<void> {
  const parsed = z.array(z.object({ name: z.string(), instance: z.string(), auth: z.any(), apiVersion: z.string().optional(), timeoutMs: z.number().optional(), resilience: z.any().optional() })).parse(JSON.parse(process.env.NEWBRIDGE_CONNECTIONS_JSON ?? '[]'));
  if (!parsed.length) throw new Error('NEWBRIDGE_CONNECTIONS_JSON must contain at least one connection');
  const policy = process.env.NEWBRIDGE_POLICY_JSON ? JSON.parse(process.env.NEWBRIDGE_POLICY_JSON) : undefined;
  const gateway = await createGateway({ connections: parsed as GatewayConnection[], apiKeys: process.env.NEWBRIDGE_GATEWAY_API_KEY ? [process.env.NEWBRIDGE_GATEWAY_API_KEY] : [], policy, databaseUrl: process.env.DATABASE_URL, redisUrl: process.env.REDIS_URL, connectorSecret: process.env.NEWBRIDGE_CONNECTOR_SECRET, allowRawQuery: process.env.NEWBRIDGE_ALLOW_RAW_QUERY === 'true', port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });
  const port = Number(process.env.PORT ?? 8080); const host = process.env.HOST ?? '0.0.0.0';
  await gateway.app.listen({ host, port });
  const shutdown = async () => { await gateway.close(); process.exit(0); };
  process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
}

if (import.meta.url === `file://${process.argv[1]}`) startGatewayFromEnv().catch(error => { console.error(error); process.exit(1); });
