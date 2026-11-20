// public/js/services/llm-client.js
// Optional morning-briefing agent. Calls the Cloudflare Worker proxy (worker/llm-proxy.js)
// so the API key never reaches the browser. Records estimated and actual token usage,
// including prompt-cache reads and writes, in the shared UsageTracker.

import { estimateTokens } from '../prompt-manager.js';

export class LlmClient {
  constructor(env, promptManager) {
    this.url = env?.llmProxyUrl || '';
    this.pm = promptManager;
  }

  get enabled() {
    return !!this.url;
  }

  async briefing(recap, logTail) {
    if (!this.enabled) throw new Error('LLM proxy is not configured');
    const task = `Write the 07:00 morning briefing in under 180 words. Facts only, no hype, state that results are paper-traded.\nRecap: ${JSON.stringify(recap)}\nLast log lines:\n${logTail.join('\n')}`;
    const body = this.pm.buildRequest('LOGGER', task, { maxTokens: 400 });
    const estIn = estimateTokens(body.system.map((s) => s.text).join('\n') + task);
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`LLM proxy HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const u = data.usage || {};
    this.pm.usage.record({
      role: 'BRIEFING',
      estIn,
      estOut: estimateTokens(text),
      actualIn: u.input_tokens || 0,
      actualOut: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
    });
    return text;
  }
}
