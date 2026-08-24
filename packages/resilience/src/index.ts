export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  retryAfterMs?: (error: unknown) => number | undefined;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const initial = options.initialDelayMs ?? 250;
  const max = options.maxDelayMs ?? 10_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts + 1; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted');
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      const canRetry = attempt <= attempts && (options.shouldRetry?.(error, attempt) ?? Boolean((error as any)?.retryable));
      if (!canRetry) throw error;
      const serverDelay = options.retryAfterMs?.(error) ?? (error as any)?.retryAfterMs;
      let delay = serverDelay ?? Math.min(max, initial * 2 ** (attempt - 1));
      if (options.jitter ?? true) delay = Math.max(0, Math.round(delay * (0.5 + Math.random() * 0.5)));
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
  isFailure?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenCalls = 0;
  private _state: CircuitState = 'CLOSED';
  constructor(private readonly options: CircuitBreakerOptions = {}) {}
  get state(): CircuitState {
    if (this._state === 'OPEN' && Date.now() - this.openedAt >= (this.options.resetTimeoutMs ?? 30_000)) {
      this._state = 'HALF_OPEN';
      this.halfOpenCalls = 0;
    }
    return this._state;
  }
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'OPEN') throw Object.assign(new Error('Circuit breaker is open'), { code: 'NB_CIRCUIT_OPEN', retryable: true });
    if (state === 'HALF_OPEN' && this.halfOpenCalls >= (this.options.halfOpenMaxCalls ?? 1)) throw Object.assign(new Error('Circuit breaker half-open probe limit reached'), { code: 'NB_CIRCUIT_OPEN', retryable: true });
    if (state === 'HALF_OPEN') this.halfOpenCalls++;
    try {
      const result = await fn();
      this.failures = 0;
      this._state = 'CLOSED';
      return result;
    } catch (error) {
      const counts = this.options.isFailure?.(error) ?? Boolean((error as any)?.retryable);
      if (counts) {
        this.failures++;
        if (this.failures >= (this.options.failureThreshold ?? 5)) {
          this._state = 'OPEN';
          this.openedAt = Date.now();
        }
      }
      throw error;
    }
  }
}

export interface AdaptiveLimiterOptions {
  minConcurrency?: number;
  maxConcurrency?: number;
  initialConcurrency?: number;
  recoveryEverySuccesses?: number;
}

export class AdaptiveLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private successes = 0;
  private limit: number;
  constructor(private readonly options: AdaptiveLimiterOptions = {}) {
    this.limit = options.initialConcurrency ?? Math.min(10, options.maxConcurrency ?? 20);
  }
  get concurrency(): number { return this.limit; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const value = await fn();
      this.successes++;
      if (this.successes >= (this.options.recoveryEverySuccesses ?? 50)) {
        this.successes = 0;
        this.limit = Math.min(this.options.maxConcurrency ?? 20, this.limit + 1);
        this.drain();
      }
      return value;
    } catch (error) {
      if ((error as any)?.status === 429) this.limit = Math.max(this.options.minConcurrency ?? 1, Math.floor(this.limit / 2));
      throw error;
    } finally {
      this.active--;
      this.drain();
    }
  }
  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()?.();
  }
}

export function stableHash(input: unknown): string {
  const normalized = JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().reduce((acc, key) => { acc[key] = value[key]; return acc; }, {} as Record<string, unknown>)
    : value);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) { hash ^= normalized.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
