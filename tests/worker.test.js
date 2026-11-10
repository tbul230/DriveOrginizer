// Tests for the AI backend worker, with Google's tokeninfo endpoint and the
// Anthropic API replaced by local fakes (no network, no real keys).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const ORIGIN = 'https://student.github.io';
const env = {
  ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', ALLOWED_ORIGINS: ORIGIN,
};
let realFetch;
let anthropicCalls;
let anthropicReply;

beforeEach(() => {
  realFetch = globalThis.fetch;
  anthropicCalls = [];
  anthropicReply = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const tok = new URL(u).searchParams.get('access_token');
      if (tok === 'good') return Response.json({ aud: env.GOOGLE_CLIENT_ID, azp: env.GOOGLE_CLIENT_ID, email: 'student@example.com', expires_in: '3000' });
      if (tok === 'other-app') return Response.json({ aud: 'someone-else', email: 'x@example.com', expires_in: '3000' });
      return new Response('{"error":"invalid_token"}', { status: 400 });
    }
    if (u === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(init.body);
      anthropicCalls.push({ body, headers: init.headers });
      const r = typeof anthropicReply === 'function' ? anthropicReply(body, init.headers) : anthropicReply;
      return new Response(JSON.stringify(r.body), { status: r.status || 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const planReq = (token = 'good', body, origin = ORIGIN) => new Request('https://w.example.workers.dev/api/plan', {
  method: 'POST',
  headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {
    instruction: 'By subject', chunk: { index: 1, total: 1 }, options: {},
    existing_folders: ['School'], planned_folders: [],
    items: [{ ref: 1, name: 'Algebra hw', type: 'doc', location: 'My Drive' }, { ref: 2, name: 'Essay', type: 'doc', location: 'My Drive' }],
  }),
});

const okText = (obj) => ({ body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7 },
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] } });

test('health endpoint and CORS', async () => {
  const r = await worker.fetch(new Request('https://w/api/health', { headers: { Origin: ORIGIN } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal((await r.json()).configured, true);
  const bad = await worker.fetch(new Request('https://w/api/health', { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(bad.status, 403);
  const pre = await worker.fetch(new Request('https://w/api/plan', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(pre.status, 204);
});

test('rejects missing, invalid and foreign tokens without calling the AI', async () => {
  assert.equal((await worker.fetch(planReq(''), env)).status, 401);
  assert.equal((await worker.fetch(planReq('bad'), env)).status, 401);
  assert.equal((await worker.fetch(planReq('other-app'), env)).status, 403);
  const limited = await worker.fetch(planReq('good'), { ...env, ALLOWED_EMAILS: 'someone@school.org' });
  assert.equal(limited.status, 403);
  assert.equal(anthropicCalls.length, 0);
});

test('returns a sanitized structured plan; drops refs the batch did not contain', async () => {
  anthropicReply = okText({
    moves: [{ file: 1, destination: 'School/Math', reason: 'algebra', confidence: 'high' }, { file: 77, destination: 'X', reason: 'not in batch', confidence: 'high' }],
    renames: [], needs_review: [{ file: 2, reason: 'unclear' }], flagged: [], folders_to_create: ['School/Math'], notes: '',
  });
  const r = await worker.fetch(planReq(), env);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(data.result.moves.map((m) => m.file), [1]);
  assert.equal(data.result.needs_review[0].file, 2);
  const call = anthropicCalls[0];
  assert.equal(call.headers['x-api-key'], 'sk-test');
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.ok(!('temperature' in call.body));
  assert.ok(call.body.messages[0].content[1].text.includes('Algebra hw'));
});

test('retries once without server-side fallbacks if the API rejects them', async () => {
  anthropicReply = (body) => (body.fallbacks
    ? { status: 400, body: { error: { type: 'invalid_request_error', message: 'fallbacks: not supported' } } }
    : okText({ moves: [], renames: [], needs_review: [], flagged: [], folders_to_create: [], notes: '' }));
  const r = await worker.fetch(planReq(), env);
  assert.equal(r.status, 200);
  assert.equal(anthropicCalls.length, 2);
  assert.ok(!anthropicCalls[1].body.fallbacks);
});

test('handles refusals, truncation, bad JSON, upstream errors and bad input', async () => {
  anthropicReply = { body: { stop_reason: 'refusal', content: [] } };
  assert.equal((await worker.fetch(planReq(), env)).status, 422);
  anthropicReply = { body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"mo' }] } };
  assert.equal((await worker.fetch(planReq(), env)).status, 502);
  anthropicReply = { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } };
  assert.equal((await worker.fetch(planReq(), env)).status, 502);
  anthropicReply = { status: 529, body: { error: { type: 'overloaded_error', message: 'Overloaded' } } };
  const over = await worker.fetch(planReq(), env);
  assert.equal(over.status, 503);
  assert.ok(over.headers.get('Retry-After'));
  const before = anthropicCalls.length;
  assert.equal((await worker.fetch(planReq('good', { instruction: '', items: [] }), env)).status, 400);
  assert.equal((await worker.fetch(planReq('good', { instruction: 'x', items: Array.from({ length: 301 }, (_, i) => ({ ref: i, name: 'n' })) }), env)).status, 400);
  assert.equal(anthropicCalls.length, before);
  assert.equal((await worker.fetch(planReq(), { ...env, ANTHROPIC_API_KEY: '' })).status, 500);
});
