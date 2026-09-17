import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { rememberToolCallExtra } from '../services/gemini.ts';

const SSE_BUFFER_MAX_LENGTH = 65_536;
const SSE_BUFFER_TAIL_LENGTH = 16_384;
type ChatInvoker = (body: Record<string, unknown>) => Promise<Response>;


type ChatToolCall = {
  index?: number;
  id?: string;
  type?: string;
  extra_content?: Record<string, unknown>;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

  return content
    .map((part: any) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        return part.text || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function responseToolsToChat(tools: any[] | undefined) {
  return (tools || [])
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
        ...(tool.strict === undefined ? {} : { strict: tool.strict })
      }
    }));
}

function responseToolChoiceToChat(toolChoice: any) {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}

function responsesInputToMessages(body: any) {
  const messages: any[] = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: contentToText(body.instructions) });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }

  for (const item of body.input || []) {
    if (item?.type === 'message' || item?.role) {
      messages.push({
        role: item.role === 'developer' ? 'system' : item.role,
        content: contentToText(item.content)
      });
      continue;
    }

    if (item?.type === 'function_call') {
      const toolCall = {
        id: item.call_id || item.id || `call_${uuidv4()}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments || {})
        }
      };
      // Chamadas paralelas chegam como itens separados; o Gemini espera todas no
      // MESMO turno do assistente (so a primeira leva thought signature).
      const previous: any = messages[messages.length - 1];
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    if (item?.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: contentToText(item.output)
      });
    }
  }

  return messages;
}

function anthropicToolsToChat(tools: any[] | undefined) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
}

function anthropicToolChoiceToChat(toolChoice: any) {
  if (!toolChoice) return 'auto';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.type === 'any') return 'required';
  return toolChoice.type === 'none' ? 'none' : 'auto';
}

function anthropicMessagesToChat(body: any) {
  const messages: any[] = [];
  if (body.system) {
    messages.push({ role: 'system', content: contentToText(body.system) });
  }

  for (const message of body.messages || []) {
    if (!Array.isArray(message.content)) {
      messages.push({ role: message.role, content: contentToText(message.content) });
      continue;
    }

    const text = message.content
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text || '')
      .join('\n');
    const toolUses = message.content.filter((part: any) => part?.type === 'tool_use');
    const toolResults = message.content.filter((part: any) => part?.type === 'tool_result');

    if (text || toolUses.length || !toolResults.length) {
      messages.push({
        role: message.role,
        content: text || null,
        ...(toolUses.length ? {
          tool_calls: toolUses.map((tool: any) => ({
            id: tool.id,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input || {})
            }
          }))
        } : {})
      });
    }

    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: contentToText(result.content)
      });
    }
  }

  return messages;
}

function sseDataFromRawEvent(raw: string) {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

async function* readChatEvents(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary < 0) {
          if (buffer.length > SSE_BUFFER_MAX_LENGTH) {
            buffer = buffer.slice(-SSE_BUFFER_TAIL_LENGTH);
          }
          break;
        }
        const raw = buffer.slice(0, boundary);
        const separatorLength = buffer[boundary] === '\r' ? 4 : 2;
        buffer = buffer.slice(boundary + separatorLength);
        const data = sseDataFromRawEvent(raw);
        if (!data) continue;
        if (data === '[DONE]') return;
        yield JSON.parse(data);
      }
    }

    buffer += decoder.decode();
    const data = sseDataFromRawEvent(buffer.trimEnd());
    if (data && data !== '[DONE]') yield JSON.parse(data);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function usageToResponses(usage: any) {
  return {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
    total_tokens: usage?.total_tokens || 0
  };
}

function usageToAnthropic(usage: any) {
  return {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0
  };
}

function createResponseEnvelope(id: string, model: string, status = 'in_progress'): any {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {}
  };
}

function chatMessageToResponseOutput(message: any) {
  const output: any[] = [];
  if (message?.content) {
    output.push({
      type: 'message',
      id: `msg_${uuidv4()}`,
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        annotations: [],
        logprobs: [],
        text: message.content
      }]
    });
  }

  for (const toolCall of message?.tool_calls || []) {
    const callId = toolCall.id || `call_${uuidv4()}`;
    rememberToolCallExtra(callId, toolCall.extra_content);
    output.push({
      type: 'function_call',
      id: `fc_${uuidv4()}`,
      call_id: callId,
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || '{}',
      status: 'completed'
    });
  }
  return output;
}

export async function responsesApi(c: Context, invokeChat: ChatInvoker) {
  const body = await c.req.json<any>();
  const chatBody = {
    model: body.model,
    messages: responsesInputToMessages(body),
    stream: Boolean(body.stream),
    tools: responseToolsToChat(body.tools),
    tool_choice: responseToolChoiceToChat(body.tool_choice)
  };

  const chatResponse = await invokeChat(chatBody);
  if (!chatResponse.ok) return chatResponse;

  const responseId = `resp_${uuidv4()}`;
  if (!body.stream) {
    const chat: any = await chatResponse.json();
    const output = chatMessageToResponseOutput(chat.choices?.[0]?.message);
    return c.json({
      ...createResponseEnvelope(responseId, body.model, 'completed'),
      output,
      output_text: output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text)
        .join(''),
      usage: usageToResponses(chat.usage)
    });
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return honoStream(c, async (writer) => {
    let sequenceNumber = 0;
    const envelope = createResponseEnvelope(responseId, body.model);
    const createTextItem = () => ({
      type: 'message',
      id: `msg_${uuidv4()}`,
      status: 'in_progress',
      role: 'assistant',
      content: [] as any[]
    });
    let textItem = createTextItem();
    const toolItems = new Map<number, any>();
    let textStarted = false;
    let textCompleted = false;
    let fullText = '';
    let finalUsage: any = null;

    const emit = (type: string, payload: Record<string, unknown>) => {
      const event = { type, sequence_number: sequenceNumber++, ...payload };
      return writer.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const completeTextItem = async () => {
      if (!textStarted || textCompleted) return;
      textCompleted = true;
      textItem.status = 'completed';
      await emit('response.output_text.done', {
        item_id: textItem.id,
        output_index: envelope.output.indexOf(textItem),
        content_index: 0,
        text: fullText,
        logprobs: []
      });
      await emit('response.content_part.done', {
        item_id: textItem.id,
        output_index: envelope.output.indexOf(textItem),
        content_index: 0,
        part: textItem.content[0]
      });
      await emit('response.output_item.done', {
        output_index: envelope.output.indexOf(textItem),
        item: textItem
      });
    };

    await emit('response.created', { response: envelope });
    await emit('response.in_progress', { response: envelope });

    for await (const chunk of readChatEvents(chatResponse)) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || {};
      if (chunk.usage) finalUsage = chunk.usage;

      if (delta.content) {
        if (textCompleted) {
          textItem = createTextItem();
          textStarted = false;
          textCompleted = false;
          fullText = '';
        }
        if (!textStarted) {
          textStarted = true;
          textItem.content = [{
            type: 'output_text',
            annotations: [],
            logprobs: [],
            text: ''
          }];
          envelope.output.push(textItem);
          await emit('response.output_item.added', {
            output_index: envelope.output.length - 1,
            item: textItem
          });
          await emit('response.content_part.added', {
            item_id: textItem.id,
            output_index: envelope.output.length - 1,
            content_index: 0,
            part: textItem.content[0]
          });
        }
        fullText += delta.content;
        textItem.content[0].text = fullText;
        await emit('response.output_text.delta', {
          item_id: textItem.id,
          output_index: envelope.output.indexOf(textItem),
          content_index: 0,
          delta: delta.content,
          logprobs: []
        });
      }

      for (const toolCall of delta.tool_calls || []) {
        await completeTextItem();
        const index = toolCall.index || 0;
        let item = toolItems.get(index);
        if (!item) {
          item = {
            type: 'function_call',
            id: `fc_${uuidv4()}`,
            call_id: toolCall.id || `call_${uuidv4()}`,
            name: toolCall.function?.name || '',
            arguments: '',
            status: 'in_progress'
          };
          toolItems.set(index, item);
          envelope.output.push(item);
          await emit('response.output_item.added', {
            output_index: envelope.output.length - 1,
            item
          });
        }
        if (toolCall.function?.name) item.name = toolCall.function.name;
        rememberToolCallExtra(item.call_id, toolCall.extra_content);
        if (toolCall.function?.arguments) {
          item.arguments += toolCall.function.arguments;
          await emit('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: envelope.output.indexOf(item),
            delta: toolCall.function.arguments
          });
        }
      }
    }

    await completeTextItem();

    for (const item of toolItems.values()) {
      item.status = 'completed';
      await emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: envelope.output.indexOf(item),
        arguments: item.arguments
      });
      await emit('response.output_item.done', {
        output_index: envelope.output.indexOf(item),
        item
      });
    }

    envelope.status = 'completed';
    envelope.usage = usageToResponses(finalUsage);
    await emit('response.completed', { response: envelope });
  });
}

function chatMessageToAnthropicContent(message: any) {
  const content: any[] = [];
  if (message?.content) content.push({ type: 'text', text: message.content });
  for (const toolCall of message?.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      input = { raw: toolCall.function?.arguments || '' };
    }
    const toolUseId = toolCall.id || `toolu_${uuidv4()}`;
    rememberToolCallExtra(toolUseId, toolCall.extra_content);
    content.push({
      type: 'tool_use',
      id: toolUseId,
      name: toolCall.function?.name || '',
      input
    });
  }
  return content;
}

export async function anthropicMessagesApi(c: Context, invokeChat: ChatInvoker) {
  const body = await c.req.json<any>();
  const chatBody = {
    model: body.model,
    messages: anthropicMessagesToChat(body),
    stream: Boolean(body.stream),
    tools: anthropicToolsToChat(body.tools),
    tool_choice: anthropicToolChoiceToChat(body.tool_choice)
  };

  const chatResponse = await invokeChat(chatBody);
  if (!chatResponse.ok) return chatResponse;

  const messageId = `msg_${uuidv4()}`;
  if (!body.stream) {
    const chat: any = await chatResponse.json();
    const message = chat.choices?.[0]?.message;
    const content = chatMessageToAnthropicContent(message);
    return c.json({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: message?.tool_calls?.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: usageToAnthropic(chat.usage)
    });
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return honoStream(c, async (writer) => {
    let contentIndex = 0;
    let textIndex: number | null = null;
    let text = '';
    let finalUsage: any = null;
    let hasTools = false;
    const toolBlocks = new Map<number, { contentIndex: number; toolCall: ChatToolCall }>();

    const emit = (event: string, data: Record<string, unknown>) =>
      writer.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

    const stopTextBlock = async () => {
      if (textIndex === null) return;
      await emit('content_block_stop', { index: textIndex });
      textIndex = null;
    };

    await emit('message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });

    for await (const chunk of readChatEvents(chatResponse)) {
      const delta = chunk.choices?.[0]?.delta || {};
      if (chunk.usage) finalUsage = chunk.usage;

      if (delta.content) {
        if (textIndex === null) {
          textIndex = contentIndex++;
          await emit('content_block_start', {
            index: textIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        text += delta.content;
        await emit('content_block_delta', {
          index: textIndex,
          delta: { type: 'text_delta', text: delta.content }
        });
      }

      for (const toolCall of delta.tool_calls || []) {
        hasTools = true;
        await stopTextBlock();
        const index = toolCall.index || 0;
        let block = toolBlocks.get(index);
        if (!block) {
          block = { contentIndex: contentIndex++, toolCall: { ...toolCall, id: toolCall.id || `toolu_${uuidv4()}` } };
          toolBlocks.set(index, block);
          await emit('content_block_start', {
            index: block.contentIndex,
            content_block: {
              type: 'tool_use',
              id: block.toolCall.id,
              name: toolCall.function?.name || '',
              input: {}
            }
          });
        }
        rememberToolCallExtra(block.toolCall.id, toolCall.extra_content);
        if (toolCall.function?.arguments) {
          await emit('content_block_delta', {
            index: block.contentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolCall.function.arguments
            }
          });
        }
      }
    }

    await stopTextBlock();
    for (const block of toolBlocks.values()) {
      await emit('content_block_stop', { index: block.contentIndex });
    }
    await emit('message_delta', {
      delta: {
        stop_reason: hasTools ? 'tool_use' : 'end_turn',
        stop_sequence: null
      },
      usage: usageToAnthropic(finalUsage)
    });
    await emit('message_stop', {});
  });
}
