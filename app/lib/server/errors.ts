export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}

export function safeErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  // Do not return database, identity-provider, signature, or S3 details to callers.
  return Response.json({ error: { code: 'internal_error', message: 'The request could not be completed.' } }, { status: 500 });
}
