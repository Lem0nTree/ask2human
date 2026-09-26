import { ZodError } from 'zod';
import { HttpError, safeErrorResponse } from './errors';

export async function readJson(request: Request, maxBytes = 1024 * 1024): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required', 'Send a JSON request body.');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new HttpError(413, 'request_too_large', 'The request body is too large.');
  }
  if (!request.body) throw new HttpError(400, 'missing_body', 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'request_too_large', 'The request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
}

export async function apiRoute(handler: () => Promise<Response | unknown>): Promise<Response> {
  let response: Response;
  try {
    const result = await handler();
    response = result instanceof Response ? result : Response.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      response = Response.json({ error: { code: 'invalid_input', message: 'The request fields are invalid.' } }, { status: 400 });
    } else {
      response = safeErrorResponse(error);
    }
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
