import { scopeCoursePackPath } from './course-pack-scope';
import { normalizeApiErrorPayload, WebApiError } from './errors';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type MaybeProvider<T> = T | (() => T);

export interface ApiClientOptions {
  baseUrl?: MaybeProvider<string>;
  activeCoursePackId?: MaybeProvider<string | null | undefined>;
  fetchImpl?: FetchLike;
  onUnauthorized?: (error: WebApiError) => void | Promise<void>;
}

export interface ApiRequestOptions<TBody = unknown> {
  method?: string;
  body?: TBody;
  headers?: HeadersInit;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
}

export interface ApiStreamOptions<TBody = unknown, TEvent = unknown> extends ApiRequestOptions<TBody> {
  onEvent?: (event: TEvent) => void;
}

export interface WebApiClient {
  request<TResponse = unknown, TBody = unknown>(path: string, options?: ApiRequestOptions<TBody>): Promise<TResponse>;
  stream<TEvent = unknown, TBody = unknown>(path: string, options?: ApiStreamOptions<TBody, TEvent>): Promise<void>;
}

export function createApiClient(options: ApiClientOptions = {}): WebApiClient {
  const fetcher = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetcher) throw new Error('fetch is not available in this runtime.');

  const request = async <TResponse = unknown, TBody = unknown>(
    path: string,
    requestOptions: ApiRequestOptions<TBody> = {}
  ): Promise<TResponse> => {
    const response = await fetcher(resolveUrl(path), buildRequestInit(requestOptions, options));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new WebApiError(normalizeApiErrorPayload(payload, response), payload);
      if (error.status === 401 && path !== '/api/auth/me') await options.onUnauthorized?.(error);
      throw error;
    }
    return payload as TResponse;
  };

  const stream = async <TEvent = unknown, TBody = unknown>(
    path: string,
    requestOptions: ApiStreamOptions<TBody, TEvent> = {}
  ): Promise<void> => {
    const headers = new Headers(requestOptions.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/x-ndjson');
    const response = await fetcher(resolveUrl(path), buildRequestInit({ ...requestOptions, headers }, options));
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      const error = new WebApiError(normalizeApiErrorPayload(payload, response), payload);
      if (error.status === 401 && path !== '/api/auth/me') await options.onUnauthorized?.(error);
      throw error;
    }
    await readNdjsonStream<TEvent>(response.body, requestOptions.onEvent);
  };

  function resolveUrl(path: string): string {
    const baseUrl = providerValue(options.baseUrl || '').replace(/\/$/, '');
    const scopedPath = scopeCoursePackPath(path, providerValue(options.activeCoursePackId || ''));
    return `${baseUrl}${scopedPath}`;
  }

  return { request, stream };
}

function buildRequestInit<TBody>(
  requestOptions: ApiRequestOptions<TBody>,
  _clientOptions: ApiClientOptions
): RequestInit {
  const headers = new Headers(requestOptions.headers);
  const init: RequestInit = {
    method: requestOptions.method || 'GET',
    headers,
    credentials: requestOptions.credentials || 'include'
  };
  if (requestOptions.signal) init.signal = requestOptions.signal;
  if (requestOptions.body !== undefined) {
    if (isRawBody(requestOptions.body)) {
      init.body = requestOptions.body;
    } else {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      init.body = JSON.stringify(requestOptions.body);
    }
  }
  return init;
}

async function readNdjsonStream<TEvent>(
  body: ReadableStream<Uint8Array>,
  onEvent?: (event: TEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) emitNdjsonLine(line, onEvent);
  }
  const tail = buffer.trim();
  if (tail) emitNdjsonLine(tail, onEvent);
}

function emitNdjsonLine<TEvent>(line: string, onEvent?: (event: TEvent) => void): void {
  const text = line.trim();
  if (!text) return;
  onEvent?.(JSON.parse(text) as TEvent);
}

function providerValue<T>(value: MaybeProvider<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

function isRawBody(value: unknown): value is BodyInit {
  return (
    typeof value === 'string'
    || value instanceof Blob
    || value instanceof FormData
    || value instanceof URLSearchParams
    || value instanceof ArrayBuffer
  );
}
