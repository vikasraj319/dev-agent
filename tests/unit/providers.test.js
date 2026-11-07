import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceeded, ContextLimitError, ModelClient, ProviderError, UsageTracker, createAdapter } from '../../src/providers.js';
import { parseJsonResponse } from '../../src/prompts.js';

const pc = { type: 'openai-compatible', baseUrl: 'http://x/v1', model: 'm', apiKeyEnv: 'K', timeoutMs: 500, maxRetries: 3, backoffBaseMs: 10, pricing: { inPerMTok: 1, outPerMTok: 2 } };
const resp = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const okBody = { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } };
const req = { system: 's', messages: [{ role: 'user', content: 'u' }] };
const client = (adapter, extra = {}) => { const delays = []; const usage = new UsageTracker({ maxTokensPerTask: 1e6, ...extra.budget }, pc.pricing); return { c: new ModelClient({ adapter, providerConfig: { ...pc, ...extra.pc }, usage, sleepFn: async (d) => delays.push(d) }), usage, delays }; };

test('retries 429/5xx with exponential backoff then succeeds', async () => {
  const seq = [resp(429, { error: { message: 'slow' } }), resp(503, 'down'), resp(200, okBody)]; let calls = 0;
  const adapter = createAdapter(pc, { env: { K: 'key' }, fetchImpl: async () => seq[calls++] });
  const { c, delays, usage } = client(adapter); const r = await c.complete(req);
  assert.equal(r.text, 'hi'); assert.equal(calls, 3); assert.equal(delays.length, 2); assert.ok(delays[1] > delays[0] * 1.2);
  assert.equal(usage.snapshot().inputTokens, 1000);
});
test('Retry-After is honored', async () => {
  const seq = [resp(429, 'x', { 'retry-after': '2' }), resp(200, okBody)]; let i = 0;
  const { c, delays } = client(createAdapter(pc, { env: {}, fetchImpl: async () => seq[i++] })); await c.complete(req); assert.deepEqual(delays, [2000]);
});
test('invalid requests are never retried', async () => {
  let calls = 0; const { c } = client(createAdapter(pc, { env: {}, fetchImpl: async () => { calls++; return resp(401, { error: { message: 'bad key' } }); } }));
  await assert.rejects(c.complete(req), (e) => e instanceof ProviderError && !e.retryable && e.status === 401); assert.equal(calls, 1);
});
test('retries are bounded', async () => {
  let calls = 0; const { c } = client(createAdapter(pc, { env: {}, fetchImpl: async () => { calls++; return resp(500, 'boom'); } }));
  await assert.rejects(c.complete(req)); assert.equal(calls, 4);
});
test('network errors are retryable; context-limit errors are surfaced distinctly', async () => {
  let n = 0; const flaky = createAdapter(pc, { env: {}, fetchImpl: async () => { if (n++ < 1) throw new Error('ECONNRESET'); return resp(200, okBody); } });
  assert.equal((await client(flaky).c.complete(req)).text, 'hi');
  const ctx = createAdapter(pc, { env: {}, fetchImpl: async () => resp(400, { error: { message: "This model's maximum context length is 8192 tokens" } }) });
  await assert.rejects(client(ctx).c.complete(req), ContextLimitError);
});
test('anthropic adapter parses text blocks and usage', async () => {
  const a = createAdapter({ ...pc, type: 'anthropic', baseUrl: 'https://api.anthropic.com' }, { env: { K: 'k' }, fetchImpl: async (u, o) => { assert.match(u, /\/v1\/messages$/); assert.equal(o.headers['x-api-key'], 'k'); return resp(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 6 } }); } });
  const r = await a(req); assert.equal(r.text, 'ok'); assert.equal(r.usage.outputTokens, 6);
});
test('token and cost budgets stop spending; unknown pricing refuses a USD budget', async () => {
  const ok = async () => ({ text: 'x', usage: { inputTokens: 600, outputTokens: 600 } });
  const { c } = client(ok, { budget: { maxTokensPerTask: 1000 } }); await c.complete(req); await assert.rejects(c.complete(req), BudgetExceeded);
  const t = new UsageTracker({ maxUsdPerTask: 1 }, null); assert.throws(() => t.assertWithinBudget(), /no pricing/);
  const t2 = new UsageTracker({ maxUsdPerTask: 0.001 }, { inPerMTok: 1000, outPerMTok: 1000 }); t2.record({ inputTokens: 1000, outputTokens: 1000 }); assert.throws(() => t2.assertWithinBudget(), BudgetExceeded);
});
test('missing usage data marks cost as unknown instead of guessing', () => {
  const t = new UsageTracker({}, pc.pricing); t.record({ inputTokens: null, outputTokens: null }); assert.equal(t.snapshot().estimatedUsd, null); assert.equal(t.snapshot().costKnown, false);
});
test('JSON extraction from fenced, prefixed and nested model output', () => {
  assert.deepEqual(parseJsonResponse('Sure!\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
  assert.deepEqual(parseJsonResponse('prefix {"x":1} suffix'), { x: 1 });
  assert.throws(() => parseJsonResponse('no json here'), /valid JSON/);
});
