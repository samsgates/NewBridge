import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NewBridge } from '@newbridge/sdk';

export type EventType = 'created' | 'updated' | 'deleted';
export interface NewBridgeEvent<T = Record<string, unknown>> {
  id: string;
  connection: string;
  table: string;
  sysId: string;
  type: EventType;
  occurredAt: string;
  receivedAt: string;
  before?: Partial<T>;
  after?: Partial<T>;
  changedFields?: string[];
  source: 'poll' | 'connector' | 'custom';
}

export interface EventCursor {
  timestamp: string;
  sysId: string;
}

export interface CursorStore {
  get(subscriptionId: string): Promise<EventCursor | undefined>;
  set(subscriptionId: string, cursor: EventCursor): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private data = new Map<string, EventCursor>();
  async get(id: string): Promise<EventCursor | undefined> { return this.data.get(id); }
  async set(id: string, cursor: EventCursor): Promise<void> { this.data.set(id, cursor); }
}

export class FileCursorStore implements CursorStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async readAll(): Promise<Record<string, EventCursor>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error; }
  }
  async get(id: string): Promise<EventCursor | undefined> { return (await this.readAll())[id]; }
  async set(id: string, cursor: EventCursor): Promise<void> {
    this.chain = this.chain.then(async () => {
      const all = await this.readAll(); all[id] = cursor;
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(all, null, 2));
      await rename(temp, this.path);
    });
    return this.chain;
  }
}

export interface WatchOptions {
  id?: string;
  connection?: string;
  table: string;
  encodedQuery?: string;
  intervalMs?: number;
  pageSize?: number;
  overlapMs?: number;
  initialCursor?: EventCursor;
  includeSnapshot?: boolean;
}

function eventId(connection: string, table: string, sysId: string, timestamp: string, type: EventType): string {
  return createHash('sha256').update(`${connection}\0${table}\0${sysId}\0${timestamp}\0${type}`).digest('hex');
}

function snDate(date: Date): string { return date.toISOString().replace('T', ' ').replace('Z', ''); }

export class PollWatcher<T extends Record<string, any> = Record<string, any>> extends EventEmitter {
  private running = false;
  private timer?: NodeJS.Timeout;
  private snapshots = new Map<string, T>();
  readonly subscriptionId: string;

  constructor(private readonly nb: NewBridge, private readonly store: CursorStore, private readonly options: WatchOptions) {
    super();
    this.subscriptionId = options.id ?? `watch_${createHash('sha1').update(`${options.connection ?? 'default'}:${options.table}:${options.encodedQuery ?? ''}`).digest('hex').slice(0, 16)}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.options.initialCursor && !(await this.store.get(this.subscriptionId))) await this.store.set(this.subscriptionId, this.options.initialCursor);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.options.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const cursor = await this.store.get(this.subscriptionId);
      const overlapMs = this.options.overlapMs ?? 1000;
      const from = cursor ? snDate(new Date(new Date(cursor.timestamp.replace(' ', 'T') + (cursor.timestamp.endsWith('Z') ? '' : 'Z')).getTime() - overlapMs)) : snDate(new Date(Date.now() - 60_000));
      const base = this.nb.table<T>(this.options.table)
        .where('sys_updated_on', '>=', from)
        .orderBy('sys_updated_on')
        .orderBy('sys_id');
      if (this.options.encodedQuery) base.rawQuery(this.options.encodedQuery);
      let newest = cursor;
      const seen = new Set<string>();
      for await (const record of base.stream({ pageSize: this.options.pageSize ?? 500 })) {
        const sysId = String(record.sys_id ?? '');
        const updated = String(record.sys_updated_on ?? '');
        const created = String(record.sys_created_on ?? updated);
        if (!sysId || !updated) continue;
        const dedupeKey = `${sysId}:${updated}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        if (cursor && updated < cursor.timestamp) continue;
        if (cursor && updated === cursor.timestamp && sysId <= cursor.sysId) continue;

        const before = this.snapshots.get(sysId);
        const type: EventType = created === updated && !before ? 'created' : 'updated';
        const changedFields = before ? Object.keys(record).filter(k => JSON.stringify(before[k]) !== JSON.stringify(record[k])) : undefined;
        const event: NewBridgeEvent<T> = {
          id: eventId(this.options.connection ?? 'default', this.options.table, sysId, updated, type),
          connection: this.options.connection ?? 'default',
          table: this.options.table,
          sysId,
          type,
          occurredAt: updated,
          receivedAt: new Date().toISOString(),
          before: before ? structuredClone(before) : undefined,
          after: structuredClone(record),
          changedFields,
          source: 'poll'
        };
        if (this.options.includeSnapshot !== false) this.snapshots.set(sysId, structuredClone(record));
        this.emit(type, event);
        this.emit('event', event);
        newest = { timestamp: updated, sysId };
      }
      if (newest) await this.store.set(this.subscriptionId, newest);
      this.emit('cycle', { subscriptionId: this.subscriptionId, cursor: newest });
    } catch (error) {
      this.emit('error', error);
    } finally {
      this.schedule();
    }
  }
}

export class EventClient {
  constructor(private readonly nb: NewBridge, private readonly store: CursorStore = new MemoryCursorStore()) {}
  watch<T extends Record<string, any> = Record<string, any>>(options: WatchOptions): PollWatcher<T> {
    return new PollWatcher<T>(this.nb, this.store, options);
  }
}

import { createHmac, randomUUID } from 'node:crypto';
import { withRetry } from '@newbridge/resilience';

export interface WebhookEndpoint {
  url: string;
  secret: string;
  timeoutMs?: number;
  maxAttempts?: number;
  headers?: Record<string, string>;
}

export interface WebhookDeliveryResult {
  deliveryId: string;
  status: number;
  attempts: number;
}

export class WebhookDispatcher {
  async deliver(event: NewBridgeEvent | Record<string, unknown>, endpoint: WebhookEndpoint): Promise<WebhookDeliveryResult> {
    const deliveryId = randomUUID();
    const timestamp = Date.now().toString();
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', endpoint.secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
    let attempts = 0;
    const response = await withRetry(async () => {
      attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs ?? 10_000);
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-newbridge-event': String((event as any).type ?? 'event'),
            'x-newbridge-delivery': deliveryId,
            'x-newbridge-timestamp': timestamp,
            'x-newbridge-signature': `sha256=${signature}`,
            ...(endpoint.headers ?? {})
          },
          body,
          signal: controller.signal
        });
        if (!res.ok) {
          const error = Object.assign(new Error(`Webhook endpoint returned HTTP ${res.status}`), {
            retryable: res.status === 408 || res.status === 429 || res.status >= 500,
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers.get('retry-after'))
          });
          throw error;
        }
        return res;
      } finally { clearTimeout(timer); }
    }, { attempts: endpoint.maxAttempts ?? 5, initialDelayMs: 500, maxDelayMs: 30_000 });
    return { deliveryId, status: response.status, attempts };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
