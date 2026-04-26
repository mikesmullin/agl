import { debug } from './lib/debug.mjs';
import * as xai from './providers/xai.mjs';
import * as copilot from './providers/copilot.mjs';
import * as ollama from './providers/ollama.mjs';
import * as lmstudio from './providers/lm-studio.mjs';

export default class Agent {
  static default = {
    model: null,
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

  static async factory({ model, system_prompt, output_tool, tool_choice }) {
    const inst = new Agent();
    const resolvedModel = model || Agent.default.model;
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

    if (output_tool) {
      inst.last_output = null;
      inst.output_tool_name = output_tool?.name || 'final_result';
      inst.Tool(
        inst.output_tool_name,
        output_tool?.description || '',
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

  async run({ prompt, ...ctx }) {
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

      const req = { model: this.model, messages };
      if (hasTools) req.tools = this._renderTools();
      if (this.tool_choice) req.tool_choice = this.tool_choice;

      const result = await this.client.inference(req);
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
            content: `Please call the \`${this.output_tool_name}\` tool now to end the session.`,
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
      for (const choice of toolCallChoices) {
        for (const call of choice.message.tool_calls) {
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

  // Extract the last assistant response content from a result object
  static lastAssistantResponse(result) {
    const choices = result?.choices || [];
    for (let i = choices.length - 1; i >= 0; i--) {
      const msg = choices[i]?.message;
      if (msg?.role === 'assistant' && msg?.content) {
        return msg.content;
      }
    }
    return null;
  }
}
