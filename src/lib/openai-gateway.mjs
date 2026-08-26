/**
 * Shared helpers for OpenAI-compatible provider passthrough (dad-proxy / Agent.chatCompletions).
 * inference() for Agent.run() stays provider-local; these return raw fetch Responses.
 */

export function openaiErrorResponse(status, message, code, type) {
  const errType =
    type ||
    (status >= 500 ? 'server_error' : 'invalid_request_error');
  return new Response(
    JSON.stringify({
      error: {
        message: String(message || 'error'),
        type: errType,
        code: code || null,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function openaiErrorFromResponse(res, provider) {
  let detail = '';
  let parsed = null;
  try {
    const text = await res.text();
    detail = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain */
    }
  } catch {
    /* ignore */
  }
  if (parsed?.error) {
    return new Response(JSON.stringify(parsed), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const message =
    parsed?.message ||
    detail?.slice(0, 800) ||
    res.statusText ||
    'Upstream error';
  return openaiErrorResponse(
    res.status >= 400 ? res.status : 502,
    `[${provider}] ${message}`,
    `upstream_${res.status}`,
    'upstream_error',
  );
}

/**
 * POST JSON; return the fetch Response as-is (including 4xx/5xx).
 * Callers that need throw-on-error (Agent.inference) check res.ok themselves.
 */
export async function openaiFetch({
  baseUrl,
  path,
  method = 'POST',
  headers = {},
  body,
  signal,
  fetchOpts = {},
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal,
    ...fetchOpts,
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts);
}
