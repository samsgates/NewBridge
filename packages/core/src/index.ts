import { z } from 'zod';

export type AuthToken = {
  value: string;
  type?: string;
  expiresAt?: number;
};

export interface AuthProvider {
  getToken(): Promise<AuthToken>;
  refresh?(): Promise<AuthToken>;
  invalidate?(): Promise<void>;
}

export type AuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'oauth-client-credentials'; clientId: string; clientSecret: string; tokenUrl?: string; scope?: string }
  | { type: 'oauth-refresh-token'; clientId: string; clientSecret?: string; refreshToken: string; tokenUrl?: string; scope?: string }
  | { type: 'custom'; provider: AuthProvider };

export interface NewBridgeConnectionConfig {
  instance: string;
  auth: AuthConfig;
  apiVersion?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  userAgent?: string;
}

export const ConnectionConfigSchema = z.object({
  instance: z.string().url().refine(v => v.startsWith('https://') || v.startsWith('http://localhost') || v.startsWith('http://127.0.0.1'), {
    message: 'instance must use HTTPS except for localhost development'
  }),
  apiVersion: z.string().regex(/^v\d+$/).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export class NewBridgeError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(message: string, options: { code: string; status?: number; requestId?: string; retryable?: boolean; details?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class AuthenticationError extends NewBridgeError {
  constructor(message = 'Authentication failed', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_AUTHENTICATION', status: 401, retryable: false, ...options });
  }
}
export class AuthorizationError extends NewBridgeError {
  constructor(message = 'Authorization denied', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_AUTHORIZATION', status: 403, retryable: false, ...options });
  }
}
export class NotFoundError extends NewBridgeError {
  constructor(message = 'Resource not found', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_NOT_FOUND', status: 404, retryable: false, ...options });
  }
}
export class ValidationError extends NewBridgeError {
  constructor(message = 'Validation failed', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_VALIDATION', status: 400, retryable: false, ...options });
  }
}
export class RateLimitError extends NewBridgeError {
  readonly retryAfterMs?: number;
  constructor(message = 'ServiceNow request rate limited', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> & { retryAfterMs?: number } = {}) {
    super(message, { code: 'NB_RATE_LIMITED', status: 429, retryable: true, ...options });
    this.retryAfterMs = options.retryAfterMs;
  }
}
export class TimeoutError extends NewBridgeError {
  constructor(message = 'Request timed out', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_TIMEOUT', retryable: true, ...options });
  }
}
export class ConflictError extends NewBridgeError {
  constructor(message = 'Conflict', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_CONFLICT', status: 409, retryable: false, ...options });
  }
}
export class NetworkError extends NewBridgeError {
  constructor(message = 'Network error', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_NETWORK', retryable: true, ...options });
  }
}
export class ServiceNowError extends NewBridgeError {
  constructor(message = 'ServiceNow API error', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_SERVICENOW', retryable: false, ...options });
  }
}
export class SchemaError extends NewBridgeError {
  constructor(message = 'Schema operation failed', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_SCHEMA', retryable: false, ...options });
  }
}
export class PolicyDeniedError extends NewBridgeError {
  constructor(message = 'Operation denied by NewBridge policy', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_POLICY_DENIED', status: 403, retryable: false, ...options });
  }
}
export class CircuitOpenError extends NewBridgeError {
  constructor(message = 'Circuit breaker is open', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_CIRCUIT_OPEN', retryable: true, ...options });
  }
}
export class IdempotencyConflictError extends NewBridgeError {
  constructor(message = 'Idempotency key was reused with a different payload', options: Partial<ConstructorParameters<typeof NewBridgeError>[1]> = {}) {
    super(message, { code: 'NB_IDEMPOTENCY_CONFLICT', status: 409, retryable: false, ...options });
  }
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<AuthToken> { return { value: this.token, type: 'Bearer' }; }
}

export class BasicAuthProvider implements AuthProvider {
  constructor(private readonly username: string, private readonly password: string) {}
  async getToken(): Promise<AuthToken> {
    return { value: Buffer.from(`${this.username}:${this.password}`).toString('base64'), type: 'Basic' };
  }
}

abstract class OAuthBaseProvider implements AuthProvider {
  protected cache?: AuthToken;
  constructor(protected readonly instance: string) {}
  abstract acquire(): Promise<AuthToken>;
  async getToken(): Promise<AuthToken> {
    if (this.cache && (!this.cache.expiresAt || this.cache.expiresAt - Date.now() > 30_000)) return this.cache;
    return this.refresh();
  }
  async refresh(): Promise<AuthToken> { this.cache = await this.acquire(); return this.cache; }
  async invalidate(): Promise<void> { this.cache = undefined; }
  protected async tokenRequest(url: string, body: URLSearchParams): Promise<AuthToken> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    });
    const raw = await response.text();
    if (!response.ok) throw new AuthenticationError(`OAuth token request failed with HTTP ${response.status}`);
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new AuthenticationError('OAuth token response was not JSON'); }
    if (!data.access_token) throw new AuthenticationError('OAuth token response did not contain access_token');
    return {
      value: data.access_token,
      type: data.token_type || 'Bearer',
      expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined
    };
  }
}

export class OAuthClientCredentialsProvider extends OAuthBaseProvider {
  constructor(instance: string, private readonly config: Extract<AuthConfig, { type: 'oauth-client-credentials' }>) { super(instance); }
  async acquire(): Promise<AuthToken> {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret });
    if (this.config.scope) body.set('scope', this.config.scope);
    return this.tokenRequest(this.config.tokenUrl ?? `${this.instance}/oauth_token.do`, body);
  }
}

export class OAuthRefreshTokenProvider extends OAuthBaseProvider {
  constructor(instance: string, private readonly config: Extract<AuthConfig, { type: 'oauth-refresh-token' }>) { super(instance); }
  async acquire(): Promise<AuthToken> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: this.config.refreshToken });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    if (this.config.scope) body.set('scope', this.config.scope);
    return this.tokenRequest(this.config.tokenUrl ?? `${this.instance}/oauth_token.do`, body);
  }
}

export function createAuthProvider(instance: string, config: AuthConfig): AuthProvider {
  switch (config.type) {
    case 'bearer': return new BearerAuthProvider(config.token);
    case 'basic': return new BasicAuthProvider(config.username, config.password);
    case 'oauth-client-credentials': return new OAuthClientCredentialsProvider(instance, config);
    case 'oauth-refresh-token': return new OAuthRefreshTokenProvider(instance, config);
    case 'custom': return config.provider;
  }
}

export interface TransportRequest {
  method: string;
  path: string;
  query?: URLSearchParams | Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: BodyInit | object | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  rawResponse?: boolean;
}

export interface TransportResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  requestId: string;
}

export interface Transport {
  request<T = unknown>(request: TransportRequest): Promise<TransportResponse<T>>;
}

function createRequestId(): string {
  return `nb_req_${crypto.randomUUID().replaceAll('-', '')}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function safeErrorMessage(payload: any, fallback: string): string {
  return payload?.error?.message || payload?.error?.detail || payload?.message || fallback;
}

export class FetchTransport implements Transport {
  readonly instance: string;
  readonly auth: AuthProvider;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: NewBridgeConnectionConfig) {
    ConnectionConfigSchema.parse(config);
    this.instance = config.instance.replace(/\/$/, '');
    this.auth = createAuthProvider(this.instance, config.auth);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.defaultHeaders = {
      accept: 'application/json',
      'user-agent': config.userAgent ?? 'NewBridge/0.1',
      ...config.defaultHeaders
    };
  }

  async request<T = unknown>(request: TransportRequest): Promise<TransportResponse<T>> {
    const requestId = createRequestId();
    const token = await this.auth.getToken();
    const url = new URL(`${this.instance}${request.path.startsWith('/') ? request.path : `/${request.path}`}`);
    if (request.query instanceof URLSearchParams) url.search = request.query.toString();
    else if (request.query) Object.entries(request.query).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, String(value)); });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), request.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const headers = new Headers(this.defaultHeaders);
    headers.set('authorization', `${token.type ?? 'Bearer'} ${token.value}`);
    headers.set('x-newbridge-request-id', requestId);
    Object.entries(request.headers ?? {}).forEach(([k, v]) => headers.set(k, v));

    let body = request.body as BodyInit | null | undefined;
    if (request.body && typeof request.body === 'object' && !(request.body instanceof ArrayBuffer) && !(request.body instanceof Blob) && !(request.body instanceof FormData) && !(request.body instanceof URLSearchParams) && !ArrayBuffer.isView(request.body)) {
      headers.set('content-type', headers.get('content-type') ?? 'application/json');
      body = JSON.stringify(request.body);
    }

    try {
      const response = await fetch(url, { method: request.method, headers, body, signal: controller.signal });
      const contentType = response.headers.get('content-type') ?? '';
      let data: any;
      if (request.rawResponse) data = response;
      else if (response.status === 204) data = undefined;
      else if (contentType.includes('application/json')) data = await response.json();
      else data = await response.text();

      if (!response.ok) {
        const common = { status: response.status, requestId, details: request.rawResponse ? undefined : data };
        if (response.status === 401) { await this.auth.invalidate?.(); throw new AuthenticationError(safeErrorMessage(data, 'ServiceNow authentication failed'), common); }
        if (response.status === 403) throw new AuthorizationError(safeErrorMessage(data, 'ServiceNow authorization denied'), common);
        if (response.status === 404) throw new NotFoundError(safeErrorMessage(data, 'ServiceNow resource not found'), common);
        if (response.status === 409) throw new ConflictError(safeErrorMessage(data, 'ServiceNow conflict'), common);
        if (response.status === 429) throw new RateLimitError(safeErrorMessage(data, 'ServiceNow request rate limited'), { ...common, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) });
        if (response.status >= 500) throw new ServiceNowError(safeErrorMessage(data, `ServiceNow returned HTTP ${response.status}`), { ...common, retryable: true });
        throw new ServiceNowError(safeErrorMessage(data, `ServiceNow returned HTTP ${response.status}`), common);
      }

      return { status: response.status, headers: response.headers, data, requestId };
    } catch (error) {
      if (error instanceof NewBridgeError) throw error;
      if (controller.signal.aborted) throw new TimeoutError('ServiceNow request timed out', { requestId });
      throw new NetworkError(error instanceof Error ? error.message : 'Network request failed', { requestId, details: error });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function apiPath(apiVersion: string | undefined, suffix: string): string {
  const version = apiVersion ? `/${apiVersion}` : '';
  return `/api/now${version}/${suffix.replace(/^\//, '')}`;
}
