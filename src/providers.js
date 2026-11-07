import { sleep } from './util.js';

export class ProviderError extends Error {
  constructor(msg, { status, retryable = false, kind = 'error' } = {}) { super(msg); this.status = status; this.retryable = retryable; this.kind = kind; }
}
export class BudgetExceeded extends Error { constructor(msg) { super(msg); this.kind = 'budget'; } }
export class ContextLimitError extends ProviderError { constructor(msg) { super(msg, { kind: 'context', retryable: false }); } }

const trimSlash = (u) => u.replace(/\/+$/, '');

async function http(fetchImpl, url, { headers, body, timeoutMs, signal }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 300);
      if (res.status === 400 && /context|too many tokens|maximum.*length|prompt is too long/i.test(msg)) throw new ContextLimitError(msg);
      const err = new ProviderError(`HTTP ${res.status}: ${msg}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 || res.status === 408 });
      err.retryAfterMs = Number(res.headers?.get?.('retry-after')) * 1000 || undefined;
      throw err;
    }
    return json;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (signal?.aborted) throw new ProviderError('cancelled', { kind: 'cancelled' });
    throw new ProviderError(`network error: ${e.message}`, { retryable: true, kind: 'network' });
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

/** Raw provider adapters. Each returns { text, usage:{inputTokens,outputTokens} }. */
export function createAdapter(pc, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = () => (pc.apiKeyEnv ? env[pc.apiKeyEnv] : undefined);
  if (pc.type === 'openai-compatible') {
    return async ({ system, messages, maxTokens, signal }) => {
      const j = await http(fetchImpl, `${trimSlash(pc.baseUrl)}/chat/completions`, {
        headers: key() ? { authorization: `Bearer ${key()}` } : {}, timeoutMs: pc.timeoutMs, signal,
        body: { model: pc.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens, temperature: 0.1 },
      });
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new ProviderError('malformed response from provider');
      return { text, usage: { inputTokens: j.usage?.prompt_tokens ?? null, outputTokens: j.usage?.completion_tokens ?? null } };
    };
  }
  if (pc.type === 'anthropic') {
    return async ({ system, messages, maxTokens, signal }) => {
      const j = await http(fetchImpl, `${trimSlash(pc.baseUrl || 'https://api.anthropic.com')}/v1/messages`, {
        headers: { 'x-api-key': key() ?? '', 'anthropic-version': '2023-06-01' }, timeoutMs: pc.timeoutMs, signal,
        body: { model: pc.model, system, messages, max_tokens: maxTokens, temperature: 0.1 },
      });
      const text = (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text) throw new ProviderError('malformed response from provider');
      return { text, usage: { inputTokens: j.usage?.input_tokens ?? null, outputTokens: j.usage?.output_tokens ?? null } };
    };
  }
  throw new Error(`unknown provider type ${pc.type}`);
}

export class UsageTracker {
  constructor(budget, pricing) { this.budget = budget || {}; this.pricing = pricing; this.inputTokens = 0; this.outputTokens = 0; this.calls = 0; this.usd = 0; this.costKnown = true; this.unknownUsageCalls = 0; this.byRole = {}; }
  assertWithinBudget() {
    const { maxTokensPerTask: mt, maxUsdPerTask: mu } = this.budget;
    if (mt != null && this.inputTokens + this.outputTokens >= mt) throw new BudgetExceeded(`token budget exhausted (${this.inputTokens + this.outputTokens} >= ${mt})`);
    if (mu != null && this.usd >= mu) throw new BudgetExceeded(`cost budget exhausted ($${this.usd.toFixed(4)} >= $${mu})`);
    if (mu != null && !this.pricing) throw new BudgetExceeded('a USD budget is set but no pricing is configured for this provider; refusing to spend blindly');
  }
  record(usage, pricing = this.pricing, role = null) {
    this.calls++;
    const r = role ? (this.byRole[role] ||= { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }) : null; if (r) r.calls++;
    if (usage.inputTokens == null || usage.outputTokens == null) { this.unknownUsageCalls++; this.costKnown = false; if (r) r.usd = null; return; }
    this.inputTokens += usage.inputTokens; this.outputTokens += usage.outputTokens;
    if (r) { r.inputTokens += usage.inputTokens; r.outputTokens += usage.outputTokens; }
    if (pricing) { const c = (usage.inputTokens * pricing.inPerMTok + usage.outputTokens * pricing.outPerMTok) / 1e6; this.usd += c; if (r && r.usd != null) r.usd += c; } else { this.costKnown = false; if (r) r.usd = null; }
  }
  snapshot() { return { byRole: JSON.parse(JSON.stringify(this.byRole)), calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, estimatedUsd: this.costKnown ? Number(this.usd.toFixed(6)) : null, costKnown: this.costKnown, unknownUsageCalls: this.unknownUsageCalls }; }
}

/**
 * Wraps an adapter with retries (exponential backoff + jitter, honoring Retry-After), a budget gate and usage
 * accounting. Never retries non-retryable errors and never swaps to another model on its own.
 */
export class ModelClient {
  constructor({ adapter, providerConfig, usage, sleepFn = sleep, onEvent, role = null }) { this.role = role; this.adapter = adapter; this.pc = providerConfig; this.usage = usage; this.sleep = sleepFn; this.onEvent = onEvent; }
  async complete(req) {
    const max = this.pc.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      this.usage.assertWithinBudget();
      try {
        const r = await this.adapter({ ...req, maxTokens: req.maxTokens ?? 8000 });
        this.usage.record(r.usage, this.pc.pricing, this.role);
        return r;
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || attempt >= max) throw e;
        const delay = e.retryAfterMs ?? Math.min(60_000, (this.pc.backoffBaseMs ?? 1000) * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        this.onEvent?.({ type: 'provider_retry', attempt: attempt + 1, delayMs: Math.round(delay), reason: e.message });
        await this.sleep(delay);
      }
    }
  }
}

/** Test/offline provider: `script(request, callIndex)` returns a string or {text,usage}. */
export function scriptedAdapter(script) {
  let i = 0;
  return async (req) => { const r = await script(req, i++); const text = typeof r === 'string' ? r : r.text; return { text, usage: r.usage ?? { inputTokens: Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4), outputTokens: Math.ceil(text.length / 4) } }; };
}

/** Builds role -> ModelClient map from config. `overrideAdapter` is used by tests. */
export function buildModels(cfg, { env = process.env, fetchImpl, overrideAdapter, sleepFn, onEvent } = {}) {
  const usage = new UsageTracker(cfg.budget, null);
  const clients = {};
  for (const role of ['planning', 'implementation', 'debugging']) {
    const pc = cfg.providers[cfg.models[role]];
    const adapter = overrideAdapter ?? createAdapter(pc, { env, fetchImpl });
    clients[role] = new ModelClient({ adapter, providerConfig: pc, usage, sleepFn, onEvent, role });
  }
  usage.pricing = cfg.providers[cfg.models.implementation].pricing;
  return { clients, usage };
}
