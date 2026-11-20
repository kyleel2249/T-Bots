// worker/llm-proxy.js
// Cloudflare Worker: forwards briefing requests to the Anthropic Messages API.
// Secrets/vars (wrangler.toml / `wrangler secret put ANTHROPIC_API_KEY`):
//   ANTHROPIC_API_KEY (secret), ALLOWED_ORIGIN, ANTHROPIC_MODEL

const MAX_BODY = 20000;
const MAX_TOKENS = 600;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const cors = {
      'access-control-allow-origin': allowed && origin === allowed ? origin : 'null',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!allowed || origin !== allowed) return new Response('Forbidden', { status: 403, headers: cors });
    if (!env.ANTHROPIC_API_KEY) return new Response('Server not configured', { status: 500, headers: cors });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return new Response('Payload too large', { status: 413, headers: cors });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response('Bad JSON', { status: 400, headers: cors });
    }
    const payload = {
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: Math.min(Number(body.max_tokens) || 400, MAX_TOKENS),
      system: body.system,
      messages: body.messages,
    };
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
    });
    return new Response(upstream.body, { status: upstream.status, headers: { ...cors, 'content-type': 'application/json' } });
  },
};
