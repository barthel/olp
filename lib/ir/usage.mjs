/**
 * Token usage for the OpenAI entry surface.
 *
 * `stream_options.include_usage` asks for a final chat.completion.chunk with an
 * empty `choices` array and a `usage` object, sent before `data: [DONE]`.
 * Authority: https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
 *
 * Providers that report counts (anthropic, codex) put them on the IR stop chunk
 * (ADR 0003 § IRResponseChunk.usage). For providers that do not, the counts are
 * estimated with the chars/4 rule of thumb the provider estimateCost() functions
 * already use; the result is marked `source: 'estimated'` so callers can say so.
 */

import { buildUsage } from '../providers/base.mjs';

/** @param {unknown} content */
function textLength(content) {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  return JSON.stringify(content).length;
}

/**
 * True when the request body asks for the usage chunk.
 * @param {object} openAIRequest parsed request body
 */
export function wantsUsageChunk(openAIRequest) {
  return openAIRequest?.stream === true && openAIRequest?.stream_options?.include_usage === true;
}

/**
 * Picks the provider-reported usage from the stop chunk, else estimates.
 *
 * @param {{messages?: Array<{content?: unknown}>}} ir IR request
 * @param {Array<object>} chunks IR response chunks streamed so far
 * @returns {{usage: {prompt_tokens:number, completion_tokens:number, total_tokens:number}, source: 'reported'|'estimated'}}
 */
export function resolveUsage(ir, chunks) {
  const stop = chunks.find(c => c?.type === 'stop' && c.usage);
  if (stop) return { usage: stop.usage, source: 'reported' };

  // Tool definitions and tool calls are part of what the model reads and writes.
  let promptChars = ir?.tools?.length ? textLength(ir.tools) : 0;
  for (const m of ir?.messages ?? []) {
    promptChars += textLength(m.content);
    if (m.tool_calls?.length) promptChars += textLength(m.tool_calls);
  }
  let completionChars = 0;
  for (const c of chunks) {
    if (c?.type !== 'delta') continue;
    if (typeof c.content === 'string') completionChars += c.content.length;
    if (c.tool_calls?.length) completionChars += textLength(c.tool_calls);
  }
  return {
    usage: buildUsage(Math.ceil(promptChars / 4), Math.ceil(completionChars / 4)),
    source: 'estimated',
  };
}
