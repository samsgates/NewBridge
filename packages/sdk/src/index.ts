import {
  FetchTransport,
  ValidationError,
  apiPath,
  type NewBridgeConnectionConfig,
  type Transport,
  type TransportRequest,
  type TransportResponse
} from '@newbridge/core';
import { QueryBuilder, type Operator, type Scalar } from '@newbridge/query';
import { AdaptiveLimiter, CircuitBreaker, withRetry } from '@newbridge/resilience';
import { CachedSchemaDiscovery, MemorySchemaCache, SchemaDiscovery, type SchemaDiscoveryOptions } from '@newbridge/schema';

export interface ResilienceConfig {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  concurrency?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  circuitBreaker?: boolean;
  circuitFailureThreshold?: number;
  circuitResetTimeoutMs?: number;
}

export interface NewBridgeConfig extends NewBridgeConnectionConfig {
  resilience?: ResilienceConfig;
  pageSize?: number;
}

class ResilientTransport implements Transport {
  private readonly limiter: AdaptiveLimiter;
  private readonly breaker: CircuitBreaker;
  constructor(private readonly inner: Transport, private readonly config: ResilienceConfig = {}) {
    this.limiter = new AdaptiveLimiter({
      initialConcurrency: config.concurrency ?? 10,
      minConcurrency: config.minConcurrency ?? 1,
      maxConcurrency: config.maxConcurrency ?? 20
    });
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold ?? 5,
      resetTimeoutMs: config.circuitResetTimeoutMs ?? 30_000,
      isFailure: error => Boolean((error as any)?.retryable) && (error as any)?.status !== 429
    });
  }
  async request<T>(request: TransportRequest): Promise<TransportResponse<T>> {
    return this.limiter.run(() => withRetry(
      () => this.config.circuitBreaker === false ? this.inner.request<T>(request) : this.breaker.execute(() => this.inner.request<T>(request)),
      {
        attempts: this.config.retries ?? 3,
        initialDelayMs: this.config.initialDelayMs ?? 250,
        maxDelayMs: this.config.maxDelayMs ?? 10_000,
        signal: request.signal,
        shouldRetry: error => Boolean((error as any)?.retryable),
        retryAfterMs: error => (error as any)?.retryAfterMs
      }
    ));
  }
}

export interface Page<T> {
  records: T[];
  offset: number;
  limit: number;
  hasMore: boolean;
  requestId: string;
}

export interface BulkRecordResult<T> {
  index: number;
  success: boolean;
  record?: T;
  error?: { message: string; code?: string };
}

export interface BulkResult<T> {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkRecordResult<T>[];
}

export interface BulkOptions {
  batchSize?: number;
  concurrency?: number;
  stopOnError?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface StreamOptions { pageSize?: number; signal?: AbortSignal; maxRecords?: number }

export interface Reference<T = unknown> {
  sys_id: string;
  display_value?: string;
  value?: T;
}

class ReferenceResolver {
  private schemaCache = new Map<string, Promise<any>>();
  private recordCache = new Map<string, Record<string, any>>();
  constructor(private readonly transport: Transport, private readonly apiVersion?: string, private readonly maxDepth = 2) {}

  private schema(table: string): Promise<any> {
    let pending = this.schemaCache.get(table);
    if (!pending) {
      pending = new SchemaDiscovery(this.transport, { apiVersion: this.apiVersion, includeTables: [table] }).describeTable(table);
      this.schemaCache.set(table, pending);
    }
    return pending;
  }

  async expand<T extends Record<string, any>>(table: string, records: T[], paths: string[]): Promise<T[]> {
    if (!paths.length || !records.length) return records;
    const copies = records.map(r => structuredClone(r));
    await this.expandLevel(table, copies, paths, 0);
    return copies;
  }

  private async expandLevel(table: string, records: Record<string, any>[], paths: string[], depth: number): Promise<void> {
    if (depth >= this.maxDepth) return;
    const schema = await this.schema(table);
    const grouped = new Map<string, string[]>();
    for (const path of paths) {
      const [head, ...rest] = path.split('.');
      if (!head) continue;
      const list = grouped.get(head) ?? [];
      if (rest.length) list.push(rest.join('.'));
      grouped.set(head, list);
    }

    for (const [fieldName, nested] of grouped) {
      const field = schema.fields.find((f: any) => f.name === fieldName);
      if (!field?.reference) throw new ValidationError(`Cannot include ${table}.${fieldName}: field is not a discovered reference`);
      const targetTable = String(field.reference);
      const ids = new Set<string>();
      for (const record of records) {
        const raw = record[fieldName];
        const id = typeof raw === 'string' ? raw : String(raw?.value ?? raw?.sys_id ?? '');
        if (id) ids.add(id);
      }
      const missing = [...ids].filter(id => !this.recordCache.has(`${targetTable}:${id}`));
      for (let start = 0; start < missing.length; start += 100) {
        const chunk = missing.slice(start, start + 100);
        const query = new QueryBuilder().whereIn('sys_id', chunk).limit(Math.max(1, chunk.length));
        const response = await this.transport.request<any>({ method: 'GET', path: apiPath(this.apiVersion, `table/${encodeURIComponent(targetTable)}`), query: query.toParams() });
        for (const row of response.data?.result ?? []) {
          const id = String(row.sys_id ?? '');
          if (id) this.recordCache.set(`${targetTable}:${id}`, row);
        }
      }

      const referenced: Record<string, any>[] = [];
      for (const record of records) {
        const raw = record[fieldName];
        const id = typeof raw === 'string' ? raw : String(raw?.value ?? raw?.sys_id ?? '');
        if (!id) continue;
        const value = this.recordCache.get(`${targetTable}:${id}`);
        const display = typeof raw === 'object' ? raw?.display_value : undefined;
        record[fieldName] = { sys_id: id, display_value: display, value } satisfies Reference;
        if (value) referenced.push(value);
      }
      if (nested.length && referenced.length) await this.expandLevel(targetTable, referenced, nested, depth + 1);
    }
  }
}

export class TableClient<T extends Record<string, any> = Record<string, any>> {
  private queryBuilder = new QueryBuilder();
  private rawEncodedQuery?: string;
  private includePaths: string[] = [];
  constructor(
    private readonly transport: Transport,
    private readonly apiVersion: string | undefined,
    readonly tableName: string,
    private readonly defaultPageSize = 500,
    private readonly referenceResolver?: ReferenceResolver
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw new ValidationError(`Invalid table name: ${tableName}`);
  }

  private path(sysId?: string): string {
    const suffix = `table/${encodeURIComponent(this.tableName)}${sysId ? `/${encodeURIComponent(sysId)}` : ''}`;
    return apiPath(this.apiVersion, suffix);
  }

  where(field: string, value: Scalar): this;
  where(field: string, operator: Operator, value?: any): this;
  where(field: string, operatorOrValue: Operator | Scalar, value?: any): this {
    (this.queryBuilder.where as any)(field, operatorOrValue, value);
    return this;
  }
  whereIn(field: string, values: Scalar[]): this { this.queryBuilder.whereIn(field, values); return this; }
  whereNotIn(field: string, values: Scalar[]): this { this.queryBuilder.whereNotIn(field, values); return this; }
  whereEmpty(field: string): this { this.queryBuilder.whereEmpty(field); return this; }
  whereNotEmpty(field: string): this { this.queryBuilder.whereNotEmpty(field); return this; }
  group(op: 'AND' | 'OR', callback: (qb: QueryBuilder) => void): this { this.queryBuilder.group(op, callback); return this; }
  orWhere(field: string, value: Scalar): this;
  orWhere(field: string, operator: Operator, value?: any): this;
  orWhere(field: string, operatorOrValue: Operator | Scalar, value?: any): this { (this.queryBuilder.orWhere as any)(field, operatorOrValue, value); return this; }
  select(fields: string[]): this { this.queryBuilder.select(fields); return this; }
  orderBy(field: string): this { this.queryBuilder.orderBy(field); return this; }
  orderByDesc(field: string): this { this.queryBuilder.orderByDesc(field); return this; }
  include(path: string): this { if (!/^[A-Za-z0-9_.]+$/.test(path)) throw new ValidationError(`Invalid include path: ${path}`); this.includePaths.push(path); return this; }
  limit(limit: number): this { this.queryBuilder.limit(limit); return this; }
  offset(offset: number): this { this.queryBuilder.offset(offset); return this; }

  rawQuery(encodedQuery: string): this {
    if (/javascript:/i.test(encodedQuery)) throw new ValidationError('javascript: encoded queries are disabled by default');
    this.rawEncodedQuery = encodedQuery;
    return this;
  }

  clone(): TableClient<T> {
    const next = new TableClient<T>(this.transport, this.apiVersion, this.tableName, this.defaultPageSize, this.referenceResolver);
    (next as any).queryBuilder = this.queryBuilder.clone();
    next.rawEncodedQuery = this.rawEncodedQuery;
    next.includePaths = [...this.includePaths];
    return next;
  }

  private params(): URLSearchParams {
    const params = this.queryBuilder.toParams();
    if (this.rawEncodedQuery) {
      const built = params.get('sysparm_query');
      params.set('sysparm_query', [this.rawEncodedQuery, built].filter(Boolean).join('^'));
    }
    return params;
  }

  async get(sysId?: string, options: { signal?: AbortSignal; displayValue?: 'true' | 'false' | 'all' } = {}): Promise<T | T[]> {
    if (sysId) {
      const response = await this.transport.request<any>({ method: 'GET', path: this.path(sysId), query: { sysparm_display_value: options.displayValue }, signal: options.signal });
      const record = response.data?.result as T;
      if (record && this.referenceResolver && this.includePaths.length) return (await this.referenceResolver.expand(this.tableName, [record], this.includePaths))[0]!;
      return record;
    }
    const response = await this.transport.request<any>({ method: 'GET', path: this.path(), query: this.params(), signal: options.signal });
    const records = (response.data?.result ?? []) as T[];
    return this.referenceResolver && this.includePaths.length ? this.referenceResolver.expand(this.tableName, records, this.includePaths) : records;
  }

  async find(options: { signal?: AbortSignal } = {}): Promise<T[]> { return await this.get(undefined, options) as T[]; }
  async first(options: { signal?: AbortSignal } = {}): Promise<T | undefined> { const rows = await this.clone().limit(1).find(options); return rows[0]; }
  async exists(options: { signal?: AbortSignal } = {}): Promise<boolean> { return Boolean(await this.first(options)); }

  async count(options: { signal?: AbortSignal } = {}): Promise<number> {
    const params = this.clone().select(['sys_id']).params();
    params.set('sysparm_limit', '1');
    params.set('sysparm_no_count', 'false');
    const response = await this.transport.request<any>({ method: 'GET', path: this.path(), query: params, signal: options.signal });
    const totalHeader = response.headers.get('x-total-count');
    if (totalHeader && /^\d+$/.test(totalHeader)) return Number(totalHeader);
    return Array.isArray(response.data?.result) ? response.data.result.length : 0;
  }

  async page(offset = 0, limit = this.defaultPageSize, signal?: AbortSignal): Promise<Page<T>> {
    const paged = this.clone(); paged.queryBuilder.limit(limit).offset(offset); const params = paged.params();
    const response = await this.transport.request<any>({ method: 'GET', path: this.path(), query: params, signal });
    let records = (response.data?.result ?? []) as T[];
    if (this.referenceResolver && this.includePaths.length) records = await this.referenceResolver.expand(this.tableName, records, this.includePaths);
    const link = response.headers.get('link') ?? '';
    const hasMore = /rel=\"?next\"?/i.test(link) || records.length === limit;
    return { records, offset, limit, hasMore, requestId: response.requestId };
  }

  async *stream(options: StreamOptions = {}): AsyncGenerator<T> {
    const pageSize = options.pageSize ?? this.defaultPageSize;
    let offset = 0;
    let yielded = 0;
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted');
      const page = await this.page(offset, pageSize, options.signal);
      for (const record of page.records) {
        yield record;
        yielded++;
        if (options.maxRecords && yielded >= options.maxRecords) return;
      }
      if (!page.hasMore || page.records.length === 0) return;
      offset += page.records.length;
    }
  }

  async create(record: Partial<T>, options: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const response = await this.transport.request<any>({ method: 'POST', path: this.path(), body: record, headers, signal: options.signal });
    return response.data?.result as T;
  }

  async update(sysId: string, record: Partial<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.transport.request<any>({ method: 'PATCH', path: this.path(sysId), body: record, signal: options.signal });
    return response.data?.result as T;
  }

  async delete(sysId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.transport.request({ method: 'DELETE', path: this.path(sysId), signal: options.signal });
  }

  async bulkCreate(records: Partial<T>[], options: BulkOptions = {}): Promise<BulkResult<T>> {
    if (options.dryRun) return { total: records.length, succeeded: 0, failed: 0, skipped: records.length, results: records.map((_, index) => ({ index, success: true })) };
    const concurrency = Math.max(1, options.concurrency ?? 5);
    const batchSize = Math.max(1, options.batchSize ?? 100);
    const results: BulkRecordResult<T>[] = new Array(records.length);
    let stopped = false;
    for (let start = 0; start < records.length && !stopped; start += batchSize) {
      const end = Math.min(records.length, start + batchSize);
      let cursor = start;
      const worker = async () => {
        while (!stopped) {
          const index = cursor++;
          if (index >= end) return;
          if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted');
          try { results[index] = { index, success: true, record: await this.create(records[index]!, { signal: options.signal }) }; }
          catch (error) {
            results[index] = { index, success: false, error: { message: error instanceof Error ? error.message : String(error), code: (error as any)?.code } };
            if (options.stopOnError) stopped = true;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, end - start) }, () => worker()));
    }
    for (let i = 0; i < records.length; i++) if (!results[i]) results[i] = { index: i, success: false, error: { message: 'Skipped because bulk processing stopped' } };
    const succeeded = results.filter(r => r.success).length;
    return { total: records.length, succeeded, failed: records.length - succeeded, skipped: results.filter(r => r.error?.message.includes('Skipped')).length, results };
  }
}

export interface AttachmentMetadata {
  sys_id: string;
  file_name: string;
  content_type?: string;
  size_bytes?: string;
  table_name?: string;
  table_sys_id?: string;
  [key: string]: unknown;
}

export class AttachmentClient {
  constructor(private readonly transport: Transport, private readonly apiVersion?: string) {}
  private path(suffix = ''): string { return apiPath(this.apiVersion, `attachment${suffix}`); }
  async list(filter: { table?: string; sysId?: string; limit?: number; offset?: number } = {}): Promise<AttachmentMetadata[]> {
    const terms: string[] = [];
    if (filter.table) terms.push(`table_name=${filter.table}`);
    if (filter.sysId) terms.push(`table_sys_id=${filter.sysId}`);
    const query = new URLSearchParams();
    if (terms.length) query.set('sysparm_query', terms.join('^'));
    query.set('sysparm_limit', String(filter.limit ?? 1000));
    query.set('sysparm_offset', String(filter.offset ?? 0));
    const response = await this.transport.request<any>({ method: 'GET', path: this.path(), query });
    return response.data?.result ?? [];
  }
  async get(sysId: string): Promise<AttachmentMetadata> {
    const response = await this.transport.request<any>({ method: 'GET', path: this.path(`/${encodeURIComponent(sysId)}`) });
    return response.data?.result;
  }
  async upload(input: { table: string; sysId: string; fileName: string; data: Blob | Uint8Array | ArrayBuffer; contentType?: string; signal?: AbortSignal }): Promise<AttachmentMetadata> {
    const body = input.data instanceof Uint8Array ? input.data : input.data;
    const response = await this.transport.request<any>({
      method: 'POST',
      path: this.path('/file'),
      query: { table_name: input.table, table_sys_id: input.sysId, file_name: input.fileName },
      headers: { 'content-type': input.contentType ?? 'application/octet-stream' },
      body: body as any,
      signal: input.signal
    });
    return response.data?.result;
  }
  async download(sysId: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.transport.request<Response>({ method: 'GET', path: this.path(`/${encodeURIComponent(sysId)}/file`), rawResponse: true, signal });
    return response.data;
  }
  async delete(sysId: string): Promise<void> { await this.transport.request({ method: 'DELETE', path: this.path(`/${encodeURIComponent(sysId)}`) }); }
}

export class ImportSetClient {
  constructor(private readonly transport: Transport, private readonly apiVersion?: string) {}
  async insert<T extends Record<string, string>>(stagingTable: string, record: T): Promise<unknown> {
    const response = await this.transport.request<any>({ method: 'POST', path: apiPath(this.apiVersion, `import/${encodeURIComponent(stagingTable)}`), body: record });
    return response.data?.result;
  }
  async insertMultiple<T extends Record<string, string>>(stagingTable: string, records: T[]): Promise<unknown> {
    const response = await this.transport.request<any>({ method: 'POST', path: apiPath(this.apiVersion, `import/${encodeURIComponent(stagingTable)}/insertMultiple`), body: { records } });
    return response.data?.result;
  }
  async get(stagingTable: string, sysId: string): Promise<unknown> {
    const response = await this.transport.request<any>({ method: 'GET', path: apiPath(this.apiVersion, `import/${encodeURIComponent(stagingTable)}/${encodeURIComponent(sysId)}`) });
    return response.data?.result;
  }
}

export class RestClient {
  constructor(private readonly transport: Transport) {}
  async call<T = unknown>(request: { method: string; path: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
    if (!request.path.startsWith('/api/')) throw new ValidationError('Generic REST path must begin with /api/');
    const response = await this.transport.request<T>({ ...request, body: request.body as any });
    return response.data;
  }
}

export class NewBridge {
  readonly transport: Transport;
  readonly attachments: AttachmentClient;
  readonly importSets: ImportSetClient;
  readonly rest: RestClient;
  readonly schema: SchemaDiscovery;
  private readonly apiVersion?: string;
  private readonly pageSize: number;
  private readonly referenceResolver: ReferenceResolver;
  private readonly schemaCache = new MemorySchemaCache();

  constructor(readonly config: NewBridgeConfig, transport?: Transport) {
    const base = transport ?? new FetchTransport(config);
    this.transport = transport ? transport : new ResilientTransport(base, config.resilience);
    this.apiVersion = config.apiVersion;
    this.pageSize = config.pageSize ?? 500;
    this.referenceResolver = new ReferenceResolver(this.transport, this.apiVersion, 2);
    this.attachments = new AttachmentClient(this.transport, this.apiVersion);
    this.importSets = new ImportSetClient(this.transport, this.apiVersion);
    this.rest = new RestClient(this.transport);
    this.schema = new CachedSchemaDiscovery(this.transport, this.schemaCache, { apiVersion: this.apiVersion });
  }

  table<T extends Record<string, any> = Record<string, any>>(name: string): TableClient<T> {
    return new TableClient<T>(this.transport, this.apiVersion, name, this.pageSize, this.referenceResolver);
  }

  schemaDiscovery(options: SchemaDiscoveryOptions = {}): SchemaDiscovery {
    return new CachedSchemaDiscovery(this.transport, this.schemaCache, { apiVersion: this.apiVersion, ...options });
  }

  get incidents(): TableClient { return this.table('incident'); }
  get problems(): TableClient { return this.table('problem'); }
  get changes(): TableClient { return this.table('change_request'); }
  get users(): TableClient { return this.table('sys_user'); }
  get groups(): TableClient { return this.table('sys_user_group'); }
  get cmdb(): TableClient { return this.table('cmdb_ci'); }

  async health(): Promise<{ ok: boolean; requestId?: string; error?: string }> {
    try {
      const response = await this.transport.request<any>({ method: 'GET', path: apiPath(this.apiVersion, 'table/sys_user'), query: { sysparm_limit: 1, sysparm_fields: 'sys_id' }, timeoutMs: Math.min(this.config.timeoutMs ?? 30_000, 10_000) });
      return { ok: true, requestId: response.requestId };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

export class NewBridgeManager {
  private readonly clients = new Map<string, NewBridge>();
  constructor(readonly connections: Record<string, NewBridgeConfig>) {
    if (!Object.keys(connections).length) throw new ValidationError('At least one NewBridge connection is required');
  }
  use(name: string): NewBridge {
    const config = this.connections[name];
    if (!config) throw new ValidationError(`Unknown NewBridge connection: ${name}`);
    let client = this.clients.get(name);
    if (!client) { client = new NewBridge(config); this.clients.set(name, client); }
    return client;
  }
  list(): string[] { return Object.keys(this.connections); }
}


export * from '@newbridge/core';
export * from '@newbridge/query';
export * from '@newbridge/schema';
