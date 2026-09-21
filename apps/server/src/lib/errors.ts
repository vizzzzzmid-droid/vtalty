/** Typed HTTP error mapped to `{ error: { code, message } }` by the handler. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

export function unauthorized(message = "Authentication required"): HttpError {
  return new HttpError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Insufficient permissions"): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}
