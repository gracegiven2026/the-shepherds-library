/**
 * The Shepherd's Library — AI Proxy (Vercel Edge Function)
 * ─────────────────────────────────────────────────────────────
 * Sits between the public HTML site and the Anthropic API.
 * The browser never sees your ANTHROPIC_API_KEY — it's stored as a
 * Vercel environment variable and only used here, server-side.
 *
 * Once deployed, this is reachable at:
 *   https://<your-project>.vercel.app/api/ai
 *
 * Point AI_API_ENDPOINT in shepherds-library-saas.html at that URL.
 */

export const config = { runtime: 'edge' };

// ── Configuration ────────────────────────────────────────────
// Only requests from these origins are allowed to call this proxy.
// Add your real domain(s) once you know them. Keep this tight —
// an open CORS policy lets anyone else burn your Anthropic credits.
const ALLOWED_ORIGINS = [
  'https://the-shepherds-library.vercel.app',  // production site
  'https://yourdomain.com',                     // add your custom domain here when ready
  'https://www.yourdomain.com',
  'null',  // allows local file:// testing — remove once live on a real domain
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// Optional simple per-IP daily request cap, backed by Vercel KV
// (Upstash Redis). Only activates if KV_REST_API_URL / KV_REST_API_TOKEN
// env vars are present — see README for setup. Without it, this is
// silently skipped and the proxy still works fine.
const DAILY_LIMIT_PER_IP = 50;

async function checkRateLimit(ip) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return true; // KV not configured — skip limiting

  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${ip}:${today}`;

  try {
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { result: count } = await incrRes.json();
    if (count === 1) {
      // First request today for this IP — set a 24h expiry on the key.
      await fetch(`${url}/expire/${encodeURIComponent(key)}/86400`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return count <= DAILY_LIMIT_PER_IP;
  } catch {
    return true; // fail open if KV is unreachable
  }
}

export default async function handler(request) {
  const origin = request.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Server misconfigured: ANTHROPIC_API_KEY env var not set.' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const withinLimit = await checkRateLimit(ip);
  if (!withinLimit) {
    return new Response(
      JSON.stringify({ error: 'Daily AI request limit reached. Please try again tomorrow.' }),
      { status: 429, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  // Only forward the fields we expect — never let the client dictate
  // the model or smuggle in extra params.
  const forwardBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: Math.min(Number(body.max_tokens) || 1000, 2000),
    system: typeof body.system === 'string' ? body.system : undefined,
    messages: Array.isArray(body.messages) ? body.messages : [],
  };

  if (!forwardBody.messages.length) {
    return new Response(JSON.stringify({ error: 'messages array is required' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(forwardBody),
    });

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Failed to reach Anthropic API', detail: String(err) }),
      { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
}
