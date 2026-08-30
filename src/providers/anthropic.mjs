/**
 * Anthropic Messages API ↔ OpenAI chat.completions adapter.
 * Model ids: anthropic:claude-sonnet-4-5
 */
import * as config from '../lib/config.mjs';
import { openaiErrorFromResponse } from '../lib/openai-gateway.mjs';

let _key = '';
const _baseUrl = 'https://api.anthropic.com';
const _defaultModel = 'claude-sonnet-4-5';

export async function init() {
  _key = await config.read('ANTHROPIC_API_KEY');
  if (!_key) {
    const err = new Error('ANTHROPIC_API_KEY is missing.');
    err.code = 'MISSING_ANTHROPIC_API_KEY';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

function openaiMessagesToAnthropic(messages) {
  let system = '';
  const out = [];

  for (const m of messages || []) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p?.text || '').join('')
          : String(m.content ?? '');
      system = system ? `${system}\n${text}` : text;
      continue;
    }

    if (m.role === 'tool') {
      let toolContent;
      if (typeof m.content === 'string') {
        toolContent = m.content;
      } else if (Array.isArray(m.content)) {
        toolContent = m.content.map((p) => {
          if (p?.type === 'image_url') {
            const url = p.image_url?.url || '';
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              };
            }
          }
          if (p?.type === 'image' && p.data) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: p.mimeType || 'image/png', data: p.data },
            };
          }
          return { type: 'text', text: String(p?.text ?? '') };
        });
      } else {
        toolContent = JSON.stringify(m.content);
      }
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: toolContent,
          },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input =
            typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : tc.function?.arguments || {};
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input,
        });
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    if (Array.isArray(m.content)) {
      const content = m.content.map((p) => {
        if (p?.type === 'image_url') {
          const url = p.image_url?.url || '';
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              };
            }
          }
          return { type: 'image', source: { type: 'url', url } };
        }
        return { type: 'text', text: String(p?.text ?? p?.content ?? '') };
      });
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
    } else {
      out.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? ''),
      });
    }
  }

  const merged = [];
  for (const msg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      const a = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text', text: String(prev.content) }];
      const b = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content) }];
      prev.content = [...a, ...b];
    } else {
      merged.push({ ...msg });
    }
  }

  return { system, messages: merged };
}

function toolsToAnthropic(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
  }));
}

function anthropicToOpenAI(data, model) {
  const toolCalls = [];
  const texts = [];
  for (const block of data.content || []) {
    if (block.type === 'text' && block.text) texts.push(block.text);
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  let finish = 'stop';
  if (data.stop_reason === 'tool_use') finish = 'tool_calls';
  else if (data.stop_reason === 'max_tokens') finish = 'length';
  else if (data.stop_reason === 'end_turn') finish = 'stop';

  return {
    id: data.id || 'chatcmpl-anthropic',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: texts.join('') || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens ?? 0,
          completion_tokens: data.usage.output_tokens ?? 0,
          total_tokens:
            (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        }
      : undefined,
  };
}

async function streamAnthropicToOpenAI(res, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  let toolIndex = -1;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      let buf = '';
      const reader = res.body.getReader();
      let finishReason = 'stop';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, sep).trim();
            buf = buf.slice(sep + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let evt;
            try {
              evt = JSON.parse(raw);
            } catch {
              continue;
            }
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
              toolIndex += 1;
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: toolIndex,
                      id: evt.content_block.id,
                      type: 'function',
                      function: { name: evt.content_block.name, arguments: '' },
                    }],
                  },
                  finish_reason: null,
                }],
              });
            } else if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                send({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
                });
              } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
                send({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: evt.index ?? toolIndex,
                        function: { arguments: evt.delta.partial_json },
                      }],
                    },
                    finish_reason: null,
                  }],
                });
              }
            } else if (evt.type === 'message_delta') {
              if (evt.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls';
              else if (evt.delta?.stop_reason === 'max_tokens') finishReason = 'length';
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function buildAnthropicPayload(model, body) {
  const { system, messages } = openaiMessagesToAnthropic(body.messages);
  const stream = Boolean(body.stream);
  const payload = {
    model,
    messages,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
    stream,
  };
  if (system) payload.system = system;
  const tools = toolsToAnthropic(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) {
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') {
      payload.tool_choice = body.tool_choice === 'required' ? { type: 'any' } : { type: body.tool_choice };
    } else if (body.tool_choice?.function?.name || body.tool_choice?.name) {
      payload.tool_choice = {
        type: 'tool',
        name: body.tool_choice.function?.name || body.tool_choice.name,
      };
    }
  }
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  return payload;
}

export async function chatCompletionsRequest({ model, body, signal } = {}) {
  if (!_key) await init();
  const resolved = model || body?.model || _defaultModel;
  const payload = buildAnthropicPayload(resolved, body || {});
  const res = await fetch(`${_baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': _key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) return openaiErrorFromResponse(res, 'anthropic');
  if (payload.stream) return streamAnthropicToOpenAI(res, resolved);
  const data = await res.json();
  return new Response(JSON.stringify(anthropicToOpenAI(data, resolved)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  max_tokens,
  temperature,
} = {}) {
  const res = await chatCompletionsRequest({
    model,
    body: {
      model,
      messages,
      tools,
      tool_choice,
      max_tokens,
      temperature,
      stream: false,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Anthropic request error: ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return await res.json();
}


