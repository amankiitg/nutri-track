/**
 * One error type for everything the HTTP layer returns. Anything else that escapes
 * a handler is a bug and becomes an opaque 500, so internal detail never reaches a
 * client.
 */
export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "upstream_error"
  | "unparseable_response"
  | "internal_error";

export interface ApiErrorOptions {
  /** Extra context for the client. Must never contain a secret. */
  details?: unknown;
  /** Extra response headers, e.g. Retry-After. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
