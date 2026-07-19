import { debug } from './lib/debug.mjs';
import * as xai from './providers/xai.mjs';
import * as copilot from './providers/copilot.mjs';
import * as ollama from './providers/ollama.mjs';
import * as lmstudio from './providers/lm-studio.mjs';

// ---------------------------------------------------------------------------
// Generic provider-call resilience (applies to ALL providers).
// Retries transient errors with exponential backoff + jitter, and enforces a
// per-attempt timeout. Tunable via env:
//   AGL_RETRY_ATTEMPTS (default 5)   AGL_RETRY_BASE_MS (default 1000)
//   AGL_RETRY_MAX_MS  (default 30000) AGL_TIMEOUT_MS   (default 180000, 0=off)
// ---------------------------------------------------------------------------

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _retryConfig() {
  return {
    attempts: Math.max(1, Number(process.env.AGL_RETRY_ATTEMPTS || 5)),
    baseMs: Number(process.env.AGL_RETRY_BASE_MS || 1000),
    maxMs: Number(process.env.AGL_RETRY_MAX_MS || 30000),
    timeoutMs: Number(process.env.AGL_TIMEOUT_MS ?? 180000),
  };
}

// Race a promise against a timeout. The losing promise keeps a no-op handler
// so a late rejection never surfaces as an unhandled rejection.
function _withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`agl: provider call timed out after ${ms}ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// HTTP 4xx request/capability errors are deterministic except for timeout,
// conflict, early-data, and rate-limit responses. Retrying those bad requests
// only occupies a concurrency slot and repeats the same provider rejection.
export function isRetryableProviderError(err) {
  const status = Number(err?.status);
  if (Number.isFinite(status)) {
    if (status === 400 && err?.model) {
      const message = String(err?.message || '');
      const contradictoryModelRoute = message.includes('requested model is not available')
        && message.includes('Available models:')
        && message.includes(String(err.model));
      if (contradictoryModelRoute) return true;
    }
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const message = String(err?.message || err || '').toLowerCase();
  if (name === 'AbortError' || message.includes('timed out') || message.includes('timeout')) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) return true;
  return err?.retryable !== false;
}

// Run an async provider call with timeout + retry/backoff on transient errors.
// opts.timeoutMs overrides the default; pass 0 to disable the wall-clock
// timeout (e.g. for streaming calls that govern themselves via an idle timer).
export async function withProviderRetry(fn, opts = {}) {
  const cfg = _retryConfig();
  const { attempts, baseMs, maxMs } = cfg;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await _withTimeout(Promise.resolve().then(fn), timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryableProviderError(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = backoff + Math.floor(Math.random() * 250);
      console.warn(
        `agl: provider call failed (${err?.name || 'Error'}: ${err?.message || err}); ` +
        `retry ${attempt}/${attempts - 1} in ${wait}ms`,
      );
      debug('agl provider retry.', { attempt, wait, error: String(err?.message || err) });
      await _sleep(wait);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Global concurrency gate for Agent.run().
// Every call to run() must acquire a slot before issuing provider inference and
// release it when finished (success OR error). The number of slots is read live
// from Agent.default.concurrency on each acquire, so callers can tune it at
// runtime (e.g. Agent.default.concurrency = 6). Default is 1 to avoid
// overwhelming the remote AI provider API. Anything beyond the limit waits
// asynchronously for the next free slot, FIFO. This naturally throttles retries
// too: each retry re-enters run() and must re-acquire a slot through the queue.
// ---------------------------------------------------------------------------
let _runActive = 0;
const _runWaiters = [];

function _concurrencyLimit() {
  const n = Number(Agent.default.concurrency);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function _drainWaiters() {
  while (_runWaiters.length && _runActive < _concurrencyLimit()) {
    _runActive++;
    const next = _runWaiters.shift();
    next();
  }
}

function _acquireRunSlot() {
  if (_runActive < _concurrencyLimit()) {
    _runActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _runWaiters.push(resolve));
}

function _releaseRunSlot() {
  _runActive = Math.max(0, _runActive - 1);
  // A slot just freed — wake the next waiter(s) up to the current limit.
  _drainWaiters();
}

export default class Agent {
  static default = {
    model: 'copilot:gpt-5.6-luna',
    context_window: null,
    MAX_CTX_LEN: null,
    WIDE_MODEL: null,
    reasoning_effort: null,
    // Default "provider:model" spec for Agent.embed() when none is passed.
    embed_model: null,
    // Max simultaneous in-flight Agent.run() calls (provider inference loops).
    // Default 1 (serial). Set higher (e.g. 6) to parallelize.
    concurrency: 1,
  };

  // tool registry
  tools = {};
  // register a tool call
  Tool(name, description, properties, required, fn) {
    if (Object.keys(this.tools).length >= 128) throw new Error('Tool limit exceeded: maximum 128 tools allowed');
    fn._name = name;
    fn._description = description || '';
    fn._properties = properties || {};
    fn._required = required || [];
    this.tools[name] = fn;
  }

  _renderTools() {
    const tools = [];
    for (const name in this.tools) {
      const tool = this.tools[name];
      tools.push({
        type: 'function',
        function: {
          name: tool._name,
          description: tool._description,
          parameters: {
            type: 'object',
            properties: tool._properties,
            required: tool._required,
          }
        }
      });
    }
    return tools;
  }

  static async factory({ model, system_prompt, output_tool, tool_choice, context_window, parallel_tools, reasoning_effort, max_tokens, stream, on_delta } = {}) {
    const inst = new Agent();
    const resolvedModel = model || Agent.default.model;
    inst.context_window = context_window ?? Agent.default.context_window ?? null;
    inst.parallel_tools = parallel_tools ?? false;
    inst.reasoning_effort = reasoning_effort ?? Agent.default.reasoning_effort ?? null;
    inst.max_tokens = max_tokens ?? null;
    inst.stream = stream ?? false;
    inst.on_delta = on_delta ?? null;
    if (!resolvedModel) {
      throw new Error('Agent.factory requires model or Agent.default.model');
    }
    {
      const idx = resolvedModel.indexOf(':');
      if (idx <= 0 || idx >= resolvedModel.length - 1) {
        throw new Error(`Invalid model format: ${resolvedModel}. Expected "provider:model".`);
      }
      inst.provider = resolvedModel.slice(0, idx);
      inst.model = resolvedModel.slice(idx + 1);
    }
    inst.client = { xai, copilot, ollama, 'lm-studio': lmstudio }[inst.provider];
    inst.system_prompt = system_prompt;
    inst.tool_choice = tool_choice;
    await inst.client.init();

    const wideModelSpec = Agent.default.WIDE_MODEL;
    if (wideModelSpec) {
      const widx = wideModelSpec.indexOf(':');
      const wideProvider = widx > 0 && widx < wideModelSpec.length - 1 ? wideModelSpec.slice(0, widx) : null;
      inst._wideModel = wideProvider ? wideModelSpec.slice(widx + 1) : wideModelSpec;
      inst._wideClient = wideProvider ? { xai, copilot, ollama, 'lm-studio': lmstudio }[wideProvider] : inst.client;
      if (inst._wideClient && inst._wideClient !== inst.client) {
        await inst._wideClient.init();
      }
    }

    if (output_tool) {
      inst.last_output = null;
      inst.output_tool_name = output_tool?.name || 'final_result';
      inst.Tool(
        inst.output_tool_name,
        // NOTE: must never be empty — the Copilot endpoint rejects requests
        // (400 Bad Request) when a tool has an empty description and the
        // messages contain image content.
        output_tool?.description || 'Report the final result.',
        output_tool?.parameters || { output: { type: output_tool?.type } },
        output_tool?.required || ['output'],
        output_tool?.fn || ((ctx, args) => {
          inst.last_output = Object.prototype.hasOwnProperty.call(args, 'output') ? args.output : args;
        }));
      if (!inst.tool_choice) {
        inst.tool_choice = 'required';
      }
    }

    return inst;
  }

  // Public entry point — enforces the global concurrency gate. Acquires a slot
  // before running the provider inference loop and always releases it, even on
  // error, so a thrown run() never leaks a slot.
  async run(args) {
    await _acquireRunSlot();
    try {
      return await this._runGated(args);
    } finally {
      _releaseRunSlot();
    }
  }

  async _runGated({ prompt, ...ctx }) {
    const messages = [
      { role: 'system', content: this.system_prompt },
      { role: 'user', content: prompt },
    ];
    const hasTools = Object.keys(this.tools).length > 0;

    let done = false;
    while (true) {
      if (done) {
        return this.last_output;
      }

      let activeModel = this.model;
      let activeClient = this.client;
      if (Agent.default.MAX_CTX_LEN && this._wideModel) {
        let chars = 0;
        for (const m of messages) {
          chars += String(m.content || '').length;
          if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        }
        if (chars > Agent.default.MAX_CTX_LEN) {
          activeModel = this._wideModel;
          activeClient = this._wideClient;
        }
      }

      const req = { model: activeModel, messages };
      if (hasTools) req.tools = this._renderTools();
      if (this.tool_choice) req.tool_choice = this.tool_choice;
      if (this.reasoning_effort) req.reasoning_effort = this.reasoning_effort;
      if (this.context_window) req.context_window = this.context_window;
      if (this.max_tokens) req.max_tokens = this.max_tokens;
      if (this.stream) req.stream = this.stream;
      if (this.stream && this.on_delta) req.on_delta = this.on_delta;

      if (this.context_window) {
        let chars = 0;
        for (const m of messages) {
          chars += String(m.content || '').length;
          if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        }
        const estimatedTokens = Math.ceil(chars / 4);
        if (estimatedTokens > this.context_window) {
          throw new Error(
            `Prompt too large: ~${estimatedTokens.toLocaleString()} estimated tokens exceeds context_window of ${this.context_window.toLocaleString()}`,
          );
        }
      }

      // Streaming calls self-govern via the provider's idle timeout, so disable
      // the agent-level wall-clock timeout (a long-but-progressing generation
      // must not be killed mid-stream).
      const result = await withProviderRetry(
        () => activeClient.inference(req),
        this.stream ? { timeoutMs: 0 } : {},
      );
      debug('Agent.run result.', result);

      // common response shape:
      // result.id
      // result.created
      // result.model
      // result.choices[].message.role
      // result.choices[].message.content
      // result.choices[].finish_reason
      // result.usage.prompt_tokens
      // result.usage.completion_tokens
      // result.usage.prompt_tokens_details.cached_tokens
      // result.usage.total_tokens

      // Collect all choices that have tool calls (supports providers returning multiple choices)
      const toolCallChoices = (result.choices || []).filter(
        choice => choice?.finish_reason === 'tool_calls' && choice.message.tool_calls?.length
      );

      if (toolCallChoices.length === 0) {
        if (this.output_tool_name && !done) {
          // model stopped without calling the output tool — nudge it
          const assistantMsg = result.choices?.[0]?.message;
          if (assistantMsg) messages.push(assistantMsg);
          messages.push({
            role: 'user',
            content: `(To encourage structured output), we expect your final response to be given via tool call; Please use \`${this.output_tool_name}\` tool.`,
          });
          debug('Agent nudging model to call output tool.', this.output_tool_name);
          continue;
        }
        return result;
      }

      // append assistant messages (with tool_calls) to conversation
      for (const choice of toolCallChoices) {
        messages.push(choice.message);
      }

      // execute each tool call from all choices and append results
      const allCalls = toolCallChoices.flatMap(choice => choice.message.tool_calls);
      if (this.parallel_tools) {
        const pending = allCalls.map(call => {
          const fn = this.tools[call.function.name];
          const args = JSON.parse(call.function.arguments);
          debug('Agent tool call.', { name: call.function.name, args });
          if (fn) {
            return Promise.resolve(fn(ctx, args)).then(result => ({
              call, args,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            }));
          }
          return Promise.resolve({ call, args, content: JSON.stringify({ error: `unknown tool: ${call.function.name}` }) });
        });
        const settled = await Promise.all(pending);
        for (const { call, args, content } of settled) {
          debug('Agent tool response.', { name: call.function.name, args, content });
          if (this.output_tool_name && this.output_tool_name == call.function.name) {
            done = true;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      } else {
        for (const call of allCalls) {
          const fn = this.tools[call.function.name];
          const args = JSON.parse(call.function.arguments);
          debug('Agent tool call.', { name: call.function.name, args });

          let content;
          if (fn) {
            const result = await fn(ctx, args);
            content = typeof result === 'string' ? result : JSON.stringify(result);
          } else {
            content = JSON.stringify({ error: `unknown tool: ${call.function.name}` });
          }
          debug('Agent tool response.', { name: call.function.name, args, content });

          if (this.output_tool_name && this.output_tool_name == call.function.name) {
            done = true;
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content,
          });
        }
      }
      // loop back to send tool results to the AI
    }
  }

  // Compute embeddings for text via a provider, resolved from a "provider:model"
  // spec (e.g. "copilot:text-embedding-3-small", "lm-studio:text-embedding-nomic-embed-text-v1.5").
  // `input` may be a string or an array of strings. Returns the OpenAI-compat
  // shape { model, data:[{ index, embedding }], usage }. Wrapped in the same
  // retry/backoff resilience as inference.
  static async embed({ model, input } = {}) {
    const resolved = model || Agent.default.embed_model;
    if (!resolved) {
      throw new Error('Agent.embed requires model or Agent.default.embed_model');
    }
    const idx = resolved.indexOf(':');
    if (idx <= 0 || idx >= resolved.length - 1) {
      throw new Error(`Invalid model format: ${resolved}. Expected "provider:model".`);
    }
    const provider = resolved.slice(0, idx);
    const modelId = resolved.slice(idx + 1);
    const client = { xai, copilot, ollama, 'lm-studio': lmstudio }[provider];
    if (!client) throw new Error(`Unknown provider: ${provider}`);
    if (typeof client.embeddings !== 'function') {
      throw new Error(`Provider ${provider} does not support embeddings`);
    }
    await client.init();
    return await withProviderRetry(() => client.embeddings({ model: modelId, input }));
  }

  // Extract the last assistant response content from a result object
  static lastAssistantResponse(result) {    const choices = result?.choices || [];
    for (let i = choices.length - 1; i >= 0; i--) {
      const msg = choices[i]?.message;
      if (msg?.role === 'assistant' && msg?.content) {
        return msg.content;
      }
    }
    return null;
  }
}
