import { SpanStatusCode, trace, context, type Span, type Tracer } from '@opentelemetry/api';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export class JsonLogger implements Logger {
  constructor(private readonly minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {}
  private levels = { debug: 10, info: 20, warn: 30, error: 40 };
  private log(level: keyof JsonLogger['levels'], message: string, fields?: Record<string, unknown>): void {
    if (this.levels[level] < this.levels[this.minLevel]) return;
    const payload = { ts: new Date().toISOString(), level, message, ...(fields ?? {}) };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  debug(message: string, fields?: Record<string, unknown>): void { this.log('debug', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.log('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.log('warn', message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.log('error', message, fields); }
}

export class Telemetry {
  readonly tracer: Tracer;
  constructor(name = '@newbridge/runtime', version = '0.1.0') { this.tracer = trace.getTracer(name, version); }

  async span<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, context.active(), async span => {
      try {
        const value = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return value;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

export class InMemoryMetrics {
  private counters = new Map<string, number>();
  inc(name: string, by = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + by); }
  get(name: string): number { return this.counters.get(name) ?? 0; }
  snapshot(): Record<string, number> { return Object.fromEntries(this.counters.entries()); }
}
