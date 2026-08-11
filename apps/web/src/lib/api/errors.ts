export interface ResponseLike {
  status?: number;
  statusText?: string;
}

export interface ApiErrorDetails {
  status: number;
  code: string;
  message: string;
}

export class WebApiError extends Error {
  status: number;
  code: string;
  payload: unknown;

  constructor(details: ApiErrorDetails, payload?: unknown) {
    super(details.message);
    this.name = 'WebApiError';
    this.status = details.status;
    this.code = details.code;
    this.payload = payload;
  }
}

export function normalizeApiErrorPayload(payload: unknown, response: ResponseLike = {}): ApiErrorDetails {
  const payloadRecord = isRecord(payload) ? payload : null;
  const source = isRecord(payloadRecord?.error) ? payloadRecord.error : (payloadRecord || payload);
  if (isRecord(source)) {
    return {
      status: numberValue(source.status) || numberValue(payloadRecord?.status) || response.status || 0,
      code: stringValue(source.code || payloadRecord?.code),
      message: stringValue(source.message) || stringValue(payloadRecord?.error) || response.statusText || '请求失败'
    };
  }
  return {
    status: numberValue(payloadRecord?.status) || response.status || 0,
    code: stringValue(payloadRecord?.code),
    message: String(source || response.statusText || '请求失败')
  };
}

export function normalizeApiError(error: unknown): ApiErrorDetails {
  if (error instanceof Error) {
    const details = normalizeApiErrorPayload(readUnknownProperty(error, 'payload'), {
      status: numberValue(readUnknownProperty(error, 'status')),
      statusText: ''
    });
    return {
      status: numberValue(readUnknownProperty(error, 'status')) || details.status || 0,
      code: stringValue(readUnknownProperty(error, 'code')) || details.code || '',
      message: error.message && error.message !== '[object Object]' ? error.message : details.message
    };
  }
  return normalizeApiErrorPayload(error, { status: 0, statusText: '' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readUnknownProperty(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
