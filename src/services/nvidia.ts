import {
  FIRST_RESPONSE_TIMEOUT_MS,
  HEDGE_SLOW_THRESHOLD_MS,
  HEDGE_PRIMARY_GRACE_MS,
  UPSTREAM_CHAT_URL
} from '../config.ts';
import {
  acquireApiKey,
  getApiKeyCount,
  getRequestDelayMs,
  markApiRateLimited,
  reserveSendSlot,
  markApiModelSwitch,
  markHedgedModelSwitch,
  markApiRequestCancelled,
  markApiRequestError,
  markApiDelayWaiting,
  markApiResponseCompleted,
  markApiResponseStarted,
  markApiSuccess,
  markApiUpstreamError,
  markApiKeyDisabled,
  getReasoningMode,
  markDailyBudgetExhausted,
  type AcquireApiKeyOptions
} from './runtime.ts';
import {
  classifyKeyFailure,
  describeUpstreamError,
  describeRestingModel,
  inspectRateLimit,
  rememberRateLimit,
  readErrorText,
  rememberFromToolCalls,
  rememberToolCallExtra,
  applyReasoningMode,
  isReasoningParamError,
  withContinuationTurn,
  withThoughtSignatures,
  type KeyFailure
} from './gemini.ts';

// import { saveLastError } from './lastErrors.ts';
// import { extractUserPrompt } from './lastPrompt.ts';

export type NvidiaFetch = typeof fetch;

// Chave invalida / sem billing: fora do rodizio (todos os modelos) por 24h ou ate
// reiniciar o app. Nao faz sentido trocar de modelo por causa disso.
const KEY_DISABLED_PENALTY_MS = 24 * 60 * 60_000;

async function rateLimitPenaltyMs(response: Response, model: string | undefined, apiNumber: number) {
  const info = await inspectRateLimit(response);
  rememberRateLimit(model, info);
  if (info.scope === 'daily') markDailyBudgetExhausted({ apiNumber, model });
  return info.penaltyMs;
}

async function noteKeyLevelFailure(response: Response, apiNumber: number): Promise<KeyFailure | null> {
  const kind = classifyKeyFailure(response.status, await readErrorText(response));
  if (kind === 'invalid_key' || kind === 'billing') {
    markApiKeyDisabled({ apiNumber, durationMs: KEY_DISABLED_PENALTY_MS });
  }
  return kind;
}

// [DESLIGADO] captureUpstreamErrorForLog comentado — last_errors.json nao sera salvo.
// Para reativar, descomente a funcao e o import de saveLastError acima.
/*
async function captureUpstreamErrorForLog(
  response: Response,
  body: Record<string, unknown>,
  model?: string
) {
  try {
    const cloned = response.clone();
    let errorBody = '';
    try {
      errorBody = await cloned.text();
    } catch {
      errorBody = '';
    }
    void saveLastError({
      savedAt: '',
      model: model || (typeof body.model === 'string' ? body.model : ''),
      prompt: extractUserPrompt(body),
      errorMessage: response.statusText || `HTTP ${response.status}`,
      errorStatus: response.status,
      errorBody
    });
  } catch {
    // Ignora — nao pode derrubar a request
  }
}
*/

type ForwardOptions = {
  firstResponseTimeoutMs?: number;
  resolveModel?: (exhausted: string[]) => string | null;
  enableHedge?: boolean;
  onResponseText?: (text: string, model?: string) => void;
  streamKeepAliveMs?: number;
  // Sinal do cliente: quando o cliente cancela a request, este signal
  // e abortado e o proxy cancela todas as requests ativas (primario + backup).
  abortSignal?: AbortSignal;
};

type SseUpstreamError = {
  status: number;
  message: string;
  type?: string;
  code?: unknown;
  event: Record<string, unknown>;
};

type ToolCallDraft = {
  id?: string;
  type: 'function';
  // Gemini: { google: { thought_signature } }. Precisa voltar no proximo turno.
  extra_content?: Record<string, unknown>;
  function: {
    name?: string;
    arguments: string;
  };
};

const EMPTY_RESPONSE_MAX_RETRIES = 3;
const MAX_500_RETRIES = 3;
// Gemini "high demand" (503 UNAVAILABLE): e do modelo, nao da chave. Tenta de novo
// no MESMO modelo com backoff (mesmo com uma chave so) antes de trocar de modelo.
const HIGH_DEMAND_BACKOFF_MS = [2_000];
// Tentativas falhas CONTAM no RPM do Gemini (confirmado: free tier Flash = 5 RPM).
// Por isso so 2 tentativas por modelo em alta demanda antes de trocar de modelo.
const HIGH_DEMAND_MAX_TRIES = 2;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_STREAM_KEEP_ALIVE_MS = 5_000;
const SSE_BUFFER_MAX_LENGTH = 65_536;
const SSE_BUFFER_TAIL_LENGTH = 16_384;
const SSE_KEEP_ALIVE_CHUNK = new TextEncoder().encode(': keep-alive\n\n');
const SSE_DONE_CHUNK = new TextEncoder().encode('data: [DONE]\n\n');

type SseCompletionReason = false | 'done' | 'finish_reason';
type SseInspectionState = {
  buffer: string;
  responseText: string;
  hasOutput: boolean;
  hasUpstreamError: boolean;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

function timeoutError(milliseconds: number) {
  return new Error(`A API NVIDIA nao respondeu em ${Math.round(milliseconds / 1000)}s.`);
}

async function withTimeout<T>(
  action: Promise<T>,
  milliseconds: number,
  onTimeout?: () => void
) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(timeoutError(milliseconds));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cloneHeaders(response: Response) {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  return headers;
}

function responseFromUpstream(response: Response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response)
  });
}

function extractUsage(data: string): { totalTokens?: number; promptTokens?: number; completionTokens?: number } | undefined {
  if (!data.includes('"usage"')) return undefined;
  try {
    const parsed = JSON.parse(data);
    const usage = parsed?.usage;
    if (!usage) return undefined;
    return {
      totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
    };
  } catch {
    return undefined;
  }
}

function appendSseTextAndCompletionReason(state: SseInspectionState, text: string): SseCompletionReason {
  let completionReason: SseCompletionReason = false;
  state.buffer += text;
  while (true) {
    const boundary = state.buffer.search(/\r?\n\r?\n/);
    if (boundary < 0) {
      if (state.buffer.length > SSE_BUFFER_MAX_LENGTH) {
        state.buffer = state.buffer.slice(-SSE_BUFFER_TAIL_LENGTH);
      }
      return completionReason;
    }
    const raw = state.buffer.slice(0, boundary);
    const separatorLength = state.buffer[boundary] === '\r' ? 4 : 2;
    state.buffer = state.buffer.slice(boundary + separatorLength);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '[DONE]') return 'done';
    if (data) {
      const usage = extractUsage(data);
      if (usage) {
        if (usage.totalTokens !== undefined) state.totalTokens = usage.totalTokens;
        if (usage.promptTokens !== undefined) state.promptTokens = usage.promptTokens;
        if (usage.completionTokens !== undefined) state.completionTokens = usage.completionTokens;
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed?.error && typeof parsed.error === 'object') {
          state.hasUpstreamError = true;
        }
        const choice = parsed?.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === 'string') {
          state.responseText += content;
          if (state.responseText.trim().length > 0) state.hasOutput = true;
        }
        if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
          state.hasOutput = true;
          rememberFromToolCalls(choice.delta.tool_calls);
        }
        if (choice?.finish_reason) completionReason = 'finish_reason';
      } catch {
        // Ignora eventos SSE que nao sejam JSON de chat completion.
      }
    }
  }
}

function streamWithLogs(input: {
  firstChunk: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  apiNumber: number;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  model?: string;
  onResponseText?: (text: string, model?: string) => void;
  keepAliveMs?: number;
  abortSignal?: AbortSignal;
}) {
  let firstEnqueued = false;
  let completed = false;
  let responseTextReported = false;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const decoder = new TextDecoder();
  const sseState: SseInspectionState = {
    buffer: '',
    responseText: '',
    hasOutput: false,
    hasUpstreamError: false
  };
  const keepAliveMs = Math.max(1, input.keepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS);
  const getPendingRead = () => {
    pendingRead ??= input.reader.read();
    return pendingRead;
  };
  const reportResponseText = () => {
    if (responseTextReported) return;
    responseTextReported = true;
    input.onResponseText?.(sseState.responseText, input.model);
  };
  const markCompletedAndClose = async (controller: ReadableStreamDefaultController<Uint8Array>, appendDone = false) => {
    if (completed) return;
    completed = true;
    if (appendDone) controller.enqueue(SSE_DONE_CHUNK);
    reportResponseText();
    markApiResponseCompleted({
      apiNumber: input.apiNumber,
      requestStartedAt: input.requestStartedAt,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      totalTokens: sseState.totalTokens,
      promptTokens: sseState.promptTokens,
      completionTokens: sseState.completionTokens,
      model: input.model
    });
    await input.reader.cancel().catch(() => {});
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!firstEnqueued) {
          firstEnqueued = true;
          if (input.firstChunk.length) {
            controller.enqueue(input.firstChunk);
            const completionReason = appendSseTextAndCompletionReason(
              sseState,
              decoder.decode(input.firstChunk, { stream: true })
            );
            if (completionReason) await markCompletedAndClose(controller, completionReason === 'finish_reason');
          }
          return;
        }
        let keepAliveTimer: NodeJS.Timeout | undefined;
        let readResult: { type: 'read'; result: ReadableStreamReadResult<Uint8Array> } | { type: 'keep_alive' };
        try {
          readResult = await Promise.race([
            getPendingRead().then((result) => ({ type: 'read' as const, result })),
            new Promise<{ type: 'keep_alive' }>((resolve) => {
              keepAliveTimer = setTimeout(() => resolve({ type: 'keep_alive' }), keepAliveMs);
            })
          ]);
        } finally {
          if (keepAliveTimer) clearTimeout(keepAliveTimer);
        }
        if (readResult.type === 'keep_alive') {
          controller.enqueue(SSE_KEEP_ALIVE_CHUNK);
          return;
        }

        pendingRead = null;
        const { done, value } = readResult.result;
        if (done) {
          await markCompletedAndClose(controller);
          return;
        }
        if (value) {
          controller.enqueue(value);
          const completionReason = appendSseTextAndCompletionReason(
            sseState,
            decoder.decode(value, { stream: true })
          );
          if (completionReason) await markCompletedAndClose(controller, completionReason === 'finish_reason');
        }
      } catch (error) {
        if (completed) return;
        markApiRequestError({
          apiNumber: input.apiNumber,
          requestStartedAt: input.requestStartedAt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts,
          message: error instanceof Error ? error.message : String(error)
        });
        reportResponseText();
        controller.error(error);
      }
    },
    cancel() {
      if (completed) return;
      completed = true;
      reportResponseText();
      if (input.abortSignal?.aborted) {
        markApiRequestCancelled({
          apiNumber: input.apiNumber,
          requestStartedAt: input.requestStartedAt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts
        });
      }
      input.reader.cancel().catch(() => {});
    }
  });
}

function parseSseEvents(text: string) {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) => event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n'))
    .filter((data) => data && data !== '[DONE]')
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return undefined;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== undefined);
}


function extractSseUpstreamError(events: Record<string, unknown>[]): SseUpstreamError | undefined {
  for (const event of events) {
    const error = event.error;
    if (!error || typeof error !== 'object') continue;
    const payload = error as Record<string, unknown>;
    const code = payload.code;
    const numericCode = typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : undefined;
    const status = Number.isFinite(numericCode) && numericCode && numericCode >= 400
      ? numericCode
      : 500;
    return {
      status,
      message: typeof payload.message === 'string' ? payload.message : JSON.stringify(payload),
      type: typeof payload.type === 'string' ? payload.type : undefined,
      code,
      event
    };
  }
  return undefined;
}
function mergeToolCall(
  drafts: Map<number, ToolCallDraft>,
  toolCall: any
) {
  const index = toolCall.index || 0;
  let draft = drafts.get(index);
  if (!draft) {
    draft = {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function?.name,
        arguments: ''
      }
    };
    drafts.set(index, draft);
  }
  if (toolCall.id) draft.id = toolCall.id;
  if (toolCall.extra_content && typeof toolCall.extra_content === 'object') draft.extra_content = toolCall.extra_content;
  if (toolCall.function?.name) draft.function.name = toolCall.function.name;
  if (toolCall.function?.arguments) draft.function.arguments += toolCall.function.arguments;
  if (draft.extra_content) rememberToolCallExtra(draft.id, draft.extra_content);
}

function aggregateChatCompletion(events: any[]) {
  let id = 'chatcmpl-agentbridge';
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let role = 'assistant';
  let content = '';
  let finishReason: string | null = null;
  let usage: any = null;
  const toolCalls = new Map<number, ToolCallDraft>();

  for (const event of events) {
    if (event.id) id = event.id;
    if (event.created) created = event.created;
    if (event.model) model = event.model;
    if (event.usage) usage = event.usage;
    if (finishReason) continue; // apos a primeira finish_reason, descarta chunks extra
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (delta.content) content += delta.content;
    for (const toolCall of delta.tool_calls || []) mergeToolCall(toolCalls, toolCall);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role,
        content: toolCalls.size ? (content || null) : content,
        ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {})
      },
      finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop')
    }],
    ...(usage ? { usage } : {})
  };
}

function completionHasOutput(completion: any) {
  const message = completion?.choices?.[0]?.message;
  const content = message?.content;
  const hasText = typeof content === 'string' && content.trim().length > 0;
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  return hasText || hasToolCalls;
}

function emptyResponseMessage(model?: string) {
  return `A NVIDIA retornou uma resposta vazia${model ? ` para o modelo ${model}` : ''}.`;
}

function pickDebugHeaders(headers: Headers) {
  const useful = [
    'content-type',
    'date',
    'server',
    'x-request-id',
    'x-trace-id',
    'x-correlation-id',
    'x-nvidia-request-id',
    'nvcf-reqid',
    'nvcf-request-id'
  ];
  const picked: Record<string, string> = {};
  for (const name of useful) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  return picked;
}

function summarizeSseEvent(event: any, index: number) {
  const choice = event?.choices?.[0];
  const delta = choice?.delta || {};
  return {
    index,
    id: typeof event?.id === 'string' ? event.id : undefined,
    model: typeof event?.model === 'string' ? event.model : undefined,
    created: typeof event?.created === 'number' ? event.created : undefined,
    finish_reason: choice?.finish_reason ?? null,
    delta_keys: Object.keys(delta),
    role: typeof delta.role === 'string' ? delta.role : undefined,
    content_length: typeof delta.content === 'string' ? delta.content.length : undefined,
    content_preview: typeof delta.content === 'string' ? delta.content.slice(0, 120) : undefined,
    tool_call_count: Array.isArray(delta.tool_calls) ? delta.tool_calls.length : 0,
    usage: event?.usage || undefined
  };
}

function buildEmptyResponseDebug(input: {
  response: Response;
  text: string;
  completion: any;
  apiNumber: number;
  model?: string;
  emptyAttempt: number;
  maxEmptyRetries: number;
  requestStartedAt: number;
}) {
  const events = parseSseEvents(input.text);
  return JSON.stringify({
    reason: 'empty_completion',
    api_number: input.apiNumber,
    model: input.model || '',
    empty_attempt: input.emptyAttempt,
    max_empty_retries: input.maxEmptyRetries,
    elapsed_ms: Date.now() - input.requestStartedAt,
    upstream: {
      status: input.response.status,
      status_text: input.response.statusText,
      headers: pickDebugHeaders(input.response.headers)
    },
    aggregate: {
      finish_reason: input.completion?.choices?.[0]?.finish_reason ?? null,
      message_role: input.completion?.choices?.[0]?.message?.role,
      message_content_length: typeof input.completion?.choices?.[0]?.message?.content === 'string'
        ? input.completion.choices[0].message.content.length
        : undefined,
      tool_call_count: Array.isArray(input.completion?.choices?.[0]?.message?.tool_calls)
        ? input.completion.choices[0].message.tool_calls.length
        : 0,
      usage: input.completion?.usage || undefined
    },
    sse: {
      event_count: events.length,
      events: events.slice(0, 8).map((event, index) => summarizeSseEvent(event, index)),
      truncated_events: Math.max(0, events.length - 8)
    },
    raw: {
      byte_length: new TextEncoder().encode(input.text).length,
      char_length: input.text.length,
      preview: input.text.slice(0, 2000)
    }
  }, null, 2);
}


function buildSseUpstreamErrorDebug(input: {
  response: Response;
  text: string;
  events: Record<string, unknown>[];
  apiNumber: number;
  model?: string;
  sseError: SseUpstreamError;
  requestStartedAt: number;
}) {
  return JSON.stringify({
    reason: 'sse_upstream_error',
    api_number: input.apiNumber,
    model: input.model || '',
    elapsed_ms: Date.now() - input.requestStartedAt,
    upstream: {
      status: input.response.status,
      status_text: input.response.statusText,
      headers: pickDebugHeaders(input.response.headers)
    },
    sse_error: {
      status: input.sseError.status,
      message: input.sseError.message,
      type: input.sseError.type,
      code: input.sseError.code,
      event: input.sseError.event
    },
    sse: {
      event_count: input.events.length,
      events: input.events.slice(0, 8).map((event, index) => summarizeSseEvent(event, index)),
      truncated_events: Math.max(0, input.events.length - 8)
    },
    raw: {
      byte_length: new TextEncoder().encode(input.text).length,
      char_length: input.text.length,
      preview: input.text.slice(0, 2000)
    }
  }, null, 2);
}

// [DESLIGADO] logSseUpstreamError e logEmptyNvidiaResponse comentados — last_errors.json nao sera salvo.
// Para reativar, descomente as funcoes e o import de saveLastError acima.
/*
function logSseUpstreamError(input: {
  body: Record<string, unknown>;
  response: Response;
  text: string;
  events: Record<string, unknown>[];
  apiNumber: number;
  model?: string;
  sseError: SseUpstreamError;
  requestStartedAt: number;
}) {
  void saveLastError({
    savedAt: '',
    model: input.model || '',
    prompt: extractUserPrompt(input.body),
    errorMessage: `A NVIDIA retornou erro SSE HTTP ${input.sseError.status}${input.model ? ` para o modelo ${input.model}` : ''}: ${input.sseError.message}`,
    errorStatus: input.sseError.status,
    errorBody: buildSseUpstreamErrorDebug(input)
  });
}
function logEmptyNvidiaResponse(input: {
  body: Record<string, unknown>;
  response: Response;
  text: string;
  completion: any;
  apiNumber: number;
  model?: string;
  emptyAttempt: number;
  maxEmptyRetries: number;
  requestStartedAt: number;
}) {
  void saveLastError({
    savedAt: '',
    model: input.model || '',
    prompt: extractUserPrompt(input.body),
    errorMessage: `${emptyResponseMessage(input.model)} Tentativa vazia ${input.emptyAttempt}/${input.maxEmptyRetries}.`,
    errorStatus: 204,
    errorBody: buildEmptyResponseDebug(input)
  });
}
*/
function ensureSseDone(text: string) {
  if (/(^|\n)data:\s*\[DONE\]\s*$/m.test(text.trimEnd())) return text;
  const separator = text.endsWith('\n\n') || text.endsWith('\r\n\r\n') ? '' : '\n\n';
  return `${text}${separator}data: [DONE]\n\n`;
}

function concatChunks(chunks: Uint8Array[], totalLength: number) {
  if (chunks.length === 1) return chunks[0];
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

type StreamPreludeResult =
  | { kind: 'output'; firstChunk: Uint8Array }
  | { kind: 'complete'; text: string };

async function readUntilOutputOrCompletion(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<StreamPreludeResult> {
  const decoder = new TextDecoder();
  const state: SseInspectionState = {
    buffer: '',
    responseText: '',
    hasOutput: false,
    hasUpstreamError: false
  };
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let text = '';

  const inspect = (chunk: Uint8Array) => {
    chunks.push(chunk);
    totalLength += chunk.length;
    const chunkText = decoder.decode(chunk, { stream: true });
    text += chunkText;
    return appendSseTextAndCompletionReason(state, chunkText);
  };
  const complete = async (): Promise<StreamPreludeResult> => {
    await reader.cancel().catch(() => {});
    text += decoder.decode();
    return { kind: 'complete', text };
  };

  if (firstChunk.length) {
    const completionReason = inspect(firstChunk);
    if (!state.hasUpstreamError && state.hasOutput) {
      return { kind: 'output', firstChunk: concatChunks(chunks, totalLength) };
    }
    if (completionReason) return complete();
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      return { kind: 'complete', text };
    }
    if (!value) continue;
    const completionReason = inspect(value);
    if (!state.hasUpstreamError && state.hasOutput) {
      return { kind: 'output', firstChunk: concatChunks(chunks, totalLength) };
    }
    if (completionReason) return complete();
  }
}

async function readRemainingText(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  const decoder = new TextDecoder();
  const sseState: SseInspectionState = {
    buffer: '',
    responseText: '',
    hasOutput: false,
    hasUpstreamError: false
  };
  let text = firstChunk.length ? decoder.decode(firstChunk, { stream: true }) : '';
  if (firstChunk.length && appendSseTextAndCompletionReason(sseState, text)) {
    await reader.cancel().catch(() => {});
    text += decoder.decode();
    return text;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    text += chunkText;
    if (appendSseTextAndCompletionReason(sseState, chunkText)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return text;
}

function buildUpstreamBody(body: Record<string, unknown>, options: { skipReasoning?: boolean } = {}) {
  const withReasoning = options.skipReasoning ? body : applyReasoningMode(body, getReasoningMode());
  return {
    ...withReasoning,
    ...(Array.isArray(body.messages) ? { messages: withContinuationTurn(withThoughtSignatures(body.messages, body.model)) } : {}),
    stream: true,
    stream_options: {
      ...(body.stream_options && typeof body.stream_options === 'object'
        ? body.stream_options as Record<string, unknown>
        : {}),
      include_usage: true
    }
  };
}

// ---------------------------------------------------------------------------
// ModelAttempt: estado de uma tentativa de fetch bem-sucedida (HTTP 200)
// ---------------------------------------------------------------------------
type ModelAttempt = {
  model: string;
  apiNumber: number;
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
  abortController: AbortController;
};

// ---------------------------------------------------------------------------
// makeSuccessResponse: monta a Response final (stream ou JSON)
// ---------------------------------------------------------------------------
async function makeSuccessResponse(
  attempt: ModelAttempt,
  sourceBody: Record<string, unknown>,
  requestStartedAt: number,
  maxAttempts: number,
  clientWantsStream: boolean,
  onResponseText?: (text: string, model?: string) => void,
  keepAliveMs?: number,
  abortSignal?: AbortSignal,
  emptyRetryState?: { count: number },
  http500State?: { count: number }
): Promise<Response | undefined> {
  let text: string;
  if (clientWantsStream) {
    const prelude = await readUntilOutputOrCompletion(attempt.firstChunk, attempt.reader);
    if (prelude.kind === 'output') {
      const headers = cloneHeaders(attempt.response);
      headers.set('content-type', 'text/event-stream');
      return new Response(streamWithLogs({
        firstChunk: prelude.firstChunk,
        reader: attempt.reader,
        apiNumber: attempt.apiNumber,
        requestStartedAt,
        attempt: 1,
        maxAttempts,
        model: attempt.model,
        onResponseText,
        keepAliveMs,
        abortSignal
      }), { status: attempt.response.status, statusText: attempt.response.statusText, headers });
    }
    text = prelude.text;
  } else {
    text = await readRemainingText(attempt.firstChunk, attempt.reader);
  }
  const events = parseSseEvents(text);
  const sseError = extractSseUpstreamError(events);
  const completion = aggregateChatCompletion(events);
  const usageInfo = (completion as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;

  if (sseError) {
    markApiUpstreamError({
      apiNumber: attempt.apiNumber,
      status: sseError.status,
      message: sseError.message,
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      model: attempt.model
    });
    markApiResponseCompleted({
      apiNumber: attempt.apiNumber,
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      totalTokens: usageInfo?.total_tokens,
      promptTokens: usageInfo?.prompt_tokens,
      completionTokens: usageInfo?.completion_tokens,
      model: attempt.model,
      timestamp: Date.now()
    });
    // [DESLIGADO] logSseUpstreamError comentado — last_errors.json nao sera salvo.
    /*
    logSseUpstreamError({
      body: sourceBody,
      response: attempt.response,
      text,
      events,
      apiNumber: attempt.apiNumber,
      model: attempt.model,
      sseError,
      requestStartedAt
    });
    */
    if (sseError.status === 500 && http500State) http500State.count++;
    return undefined;
  }

  if (!completionHasOutput(completion)) {
    markApiUpstreamError({
      apiNumber: attempt.apiNumber,
      status: 204,
      message: emptyResponseMessage(attempt.model),
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      model: attempt.model
    });
    markApiResponseCompleted({
      apiNumber: attempt.apiNumber,
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      totalTokens: usageInfo?.total_tokens,
      promptTokens: usageInfo?.prompt_tokens,
      completionTokens: usageInfo?.completion_tokens,
      model: attempt.model,
      timestamp: Date.now()
    });
    const emptyAttempt = (emptyRetryState?.count || 0) + 1;
    // [DESLIGADO] logEmptyNvidiaResponse comentado — last_errors.json nao sera salvo.
    /*
    logEmptyNvidiaResponse({
      body: sourceBody,
      response: attempt.response,
      text,
      completion,
      apiNumber: attempt.apiNumber,
      model: attempt.model,
      emptyAttempt,
      maxEmptyRetries: EMPTY_RESPONSE_MAX_RETRIES,
      requestStartedAt
    });
    */
    if (emptyRetryState) {
      emptyRetryState.count++;
      if (emptyRetryState.count < EMPTY_RESPONSE_MAX_RETRIES) {
        return undefined;
      }
    }
    if (http500State) http500State.count++;
    if (clientWantsStream) {
      const headers = cloneHeaders(attempt.response);
      headers.set('content-type', 'text/event-stream');
      return new Response(ensureSseDone(text), { status: 200, headers });
    }
    return Response.json(completion, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  onResponseText?.(String(completion.choices?.[0]?.message?.content || ''), attempt.model);
  markApiResponseCompleted({
    apiNumber: attempt.apiNumber,
    requestStartedAt,
    attempt: 1,
    maxAttempts,
    totalTokens: usageInfo?.total_tokens,
    promptTokens: usageInfo?.prompt_tokens,
    completionTokens: usageInfo?.completion_tokens,
    model: attempt.model,
    timestamp: Date.now()
  });

  if (clientWantsStream) {
    const headers = cloneHeaders(attempt.response);
    headers.set('content-type', 'text/event-stream');
    return new Response(ensureSseDone(text), {
      status: attempt.response.status,
      statusText: attempt.response.statusText,
      headers
    });
  }

  return Response.json(completion, {
    status: attempt.response.status,
    statusText: attempt.response.statusText,
    headers: { 'cache-control': 'no-store' }
  });
}
// ---------------------------------------------------------------------------
// Lê o primeiro chunk de um ReadableStream com timeout
// ---------------------------------------------------------------------------
async function readFirstChunk(
  fetchImpl: NvidiaFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array>; value: Uint8Array }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const response = await withTimeout(fetchImpl(input, {
    ...init,
    signal: controller.signal
  }), timeoutMs, () => controller.abort());

  if (!response.ok || !response.body) {
    return {
      response,
      reader: new ReadableStream<Uint8Array>().getReader(),
      value: new Uint8Array()
    };
  }

  const reader = response.body.getReader();
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const firstRead = await withTimeout(reader.read(), remainingMs, () => controller.abort());
  if (firstRead.done || !firstRead.value) {
    return { response, reader, value: new Uint8Array() };
  }
  return { response, reader, value: firstRead.value };
}

// ---------------------------------------------------------------------------
// forwardToNvidia — ponto de entrada principal
// ---------------------------------------------------------------------------
export async function forwardToNvidia(
  body: Record<string, unknown>,
  fetchImpl: NvidiaFetch = fetch,
  delayMs = getRequestDelayMs(),
  rateLimitOptions: AcquireApiKeyOptions = {},
  options: ForwardOptions = {}
) {
  const clientWantsStream = Boolean(body.stream);
  const timeoutMs = options.firstResponseTimeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  const now = rateLimitOptions.now || Date.now;
  const onResponseText = options.onResponseText;
  const requestStartedAt = now();
  const maxAttempts = Math.max(1, getApiKeyCount());
  let activeModel = typeof body.model === 'string' ? body.model : undefined;
  const exhaustedModels: string[] = [];
  let apiNumber: number | undefined;
  const emptyRetryState = { count: 0 };
  const http500State = { count: 0 };

  markApiDelayWaiting({ delayMs, timestamp: now() });
  await reserveSendSlot({ delayMs, now, sleep: rateLimitOptions.sleep });

  let attempt = 0;
  // true depois que o Gemini recusou o reasoning_effort escolhido no app.
  let skipReasoning = false;
  while (true) {
    attempt++;
    let acquired;
    try {
      acquired = await acquireApiKey({ ...rateLimitOptions, model: activeModel });
    } catch (error: any) {
      const resting = error?.code === 'all_resting';
      if (resting && options.resolveModel) {
        const previousModel = activeModel;
        if (activeModel) exhaustedModels.push(activeModel);
        const nextModel = options.resolveModel(exhaustedModels.slice());
        if (nextModel && !exhaustedModels.includes(nextModel)) {
          markApiModelSwitch({ from: previousModel, to: nextModel, reason: error?.dailyBudget ? 'limite diario esgotado em todas as APIs' : 'todas as APIs em castigo 429', timestamp: now() });
          activeModel = nextModel;
          body = { ...body, model: nextModel };
          attempt = 0;
          emptyRetryState.count = 0;
          continue;
        }
      }
      const reason = resting && !error?.dailyBudget ? describeRestingModel(activeModel) : undefined;
      const errorMessage = (error?.message || 'Nenhuma API Gemini disponivel.') + (reason ? ` Ultimo motivo (${activeModel}): ${reason}` : '');
      markApiRequestError({ apiNumber, message: errorMessage, requestStartedAt, attempt, maxAttempts, timestamp: now() });
      return Response.json({
        error: { type: resting ? 'rate_limited' : 'upstream_timeout', message: errorMessage }
      }, { status: resting ? 429 : 504 });
    }
    apiNumber = acquired.apiNumber;

    const upstreamBody = buildUpstreamBody(body, { skipReasoning });

    // ======================================================================
    // Com hedge: usa race entre readFirstChunk e timer
    // ======================================================================
    if (options.enableHedge && options.resolveModel) {
      // Se o cliente ja cancelou, nem comeca
      if (options.abortSignal?.aborted) {
        markApiRequestCancelled({ apiNumber, requestStartedAt, message: 'Cliente cancelou a request.', attempt, maxAttempts, timestamp: now() });
        return new Response(null, { status: 499 });
      }
      const result = await hedgeForward(
        body, activeModel!, fetchImpl, timeoutMs, rateLimitOptions,
        attempt, maxAttempts, requestStartedAt, options.resolveModel,
        upstreamBody, acquired, clientWantsStream, now, options.abortSignal, onResponseText, emptyRetryState, http500State, exhaustedModels
      );
      if (result) return result;
      // undefined: erro 429 ou HTTP error que o loop externo pode tentar de novo
      // Se acumulou MAX_500_RETRIES erros 500, troca de modelo
      if (http500State.count >= MAX_500_RETRIES && options.resolveModel) {
        const previousModel = activeModel;
        if (activeModel) exhaustedModels.push(activeModel);
        const nextModel = options.resolveModel(exhaustedModels.slice());
        if (nextModel && !exhaustedModels.includes(nextModel)) {
          markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber, reason: `modelo em erro HTTP 500 apos ${MAX_500_RETRIES} tentativas`, timestamp: now() });
          activeModel = nextModel;
          body = { ...body, model: nextModel };
          attempt = 0;
          emptyRetryState.count = 0;
          http500State.count = 0;
        }
      }
      continue;
    }

    // ======================================================================
    // Sem hedge: comportamento original
    // ======================================================================
    try {
      const { response, reader, value } = await readFirstChunk(fetchImpl, UPSTREAM_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${acquired.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify(upstreamBody)
      }, timeoutMs);

      markApiResponseStarted({ apiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

      if (response.status === 429 && attempt < maxAttempts) {
        markApiUpstreamError({ apiNumber, status: 429, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        markApiRateLimited({ apiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, apiNumber), timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
        await reader.cancel().catch(() => {});
        continue;
      }

      if (!response.ok) {
        markApiUpstreamError({ apiNumber, status: response.status, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        if (response.status === 429) markApiRateLimited({ apiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, apiNumber), timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
        await reader.cancel().catch(() => {});

        if (!skipReasoning && (upstreamBody as Record<string, unknown>).reasoning_effort !== body.reasoning_effort
          && isReasoningParamError(response.status, await readErrorText(response))) {
          // O modelo nao aceita o nivel de raciocinio do app: repete sem o override.
          skipReasoning = true;
          attempt--;
          continue;
        }
        const keyFailure = await noteKeyLevelFailure(response, apiNumber);
        if ((keyFailure === 'invalid_key' || keyFailure === 'billing') && attempt < maxAttempts) {
          // Problema da chave, nao do modelo: tenta a proxima chave no mesmo modelo.
          continue;
        }
        const retryableServerError = response.status === 500 || keyFailure === 'high_demand';
        if (retryableServerError) http500State.count++;

        const shouldFailover =
          response.status === 429 || response.status === 404 ||
          (response.status === 400 && !keyFailure) ||
          (retryableServerError && http500State.count >= (keyFailure === 'high_demand' ? HIGH_DEMAND_MAX_TRIES : MAX_500_RETRIES));

        if (shouldFailover && options.resolveModel) {
          const previousModel = activeModel;
          if (activeModel) exhaustedModels.push(activeModel);
          const nextModel = options.resolveModel(exhaustedModels.slice());
          if (nextModel && !exhaustedModels.includes(nextModel)) {
            if (response.status !== 429) {
              // [DESLIGADO] captureUpstreamErrorForLog comentado — last_errors.json nao sera salvo.
              // void captureUpstreamErrorForLog(response, body, activeModel);
            }
            const reason = response.status === 429
              ? 'todas as APIs em castigo 429'
              : retryableServerError
                ? `modelo em erro HTTP ${response.status}${keyFailure === 'high_demand' ? ' (alta demanda)' : ''} apos ${keyFailure === 'high_demand' ? HIGH_DEMAND_MAX_TRIES : MAX_500_RETRIES} tentativas`
                : `modelo recusado (HTTP ${response.status})`;
            markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber, reason, timestamp: now() });
            activeModel = nextModel;
            body = { ...body, model: nextModel };
            attempt = 0;
            emptyRetryState.count = 0;
            http500State.count = 0;
            continue;
          }
        }
        if (keyFailure === 'high_demand' && http500State.count < HIGH_DEMAND_MAX_TRIES) {
          const waitMs = HIGH_DEMAND_BACKOFF_MS[Math.min(http500State.count - 1, HIGH_DEMAND_BACKOFF_MS.length - 1)];
          markApiDelayWaiting({ apiNumber, delayMs: waitMs, attempt, timestamp: now() });
          await (rateLimitOptions.sleep || defaultSleep)(waitMs);
          attempt = 0; // nao consome tentativas de chave: o problema nao e a chave
          continue;
        }
        if (response.status === 500 && keyFailure !== 'high_demand' && http500State.count < MAX_500_RETRIES && attempt < maxAttempts) {
          continue;
        }
        return responseFromUpstream(response);
      }

      markApiSuccess({ apiNumber, model: activeModel, timestamp: now() });

      let text: string;
      if (clientWantsStream) {
        const prelude = await readUntilOutputOrCompletion(value, reader);
        if (prelude.kind === 'output') {
          const headers = cloneHeaders(response);
          headers.set('content-type', 'text/event-stream');
          return new Response(streamWithLogs({
            firstChunk: prelude.firstChunk,
            reader,
            apiNumber,
            requestStartedAt,
            attempt,
            maxAttempts,
            model: activeModel,
            onResponseText,
            keepAliveMs: options.streamKeepAliveMs,
            abortSignal: options.abortSignal
          }), { status: response.status, statusText: response.statusText, headers });
        }
        text = prelude.text;
      } else {
        text = await readRemainingText(value, reader);
      }
      const events = parseSseEvents(text);
      const sseError = extractSseUpstreamError(events);
      const completion = aggregateChatCompletion(events);
      const usageInfo = (completion as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
      if (sseError) {
        markApiUpstreamError({ apiNumber, status: sseError.status, message: sseError.message, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, totalTokens: usageInfo?.total_tokens, promptTokens: usageInfo?.prompt_tokens, completionTokens: usageInfo?.completion_tokens, model: activeModel, timestamp: now() });
        // [DESLIGADO] logSseUpstreamError comentado — last_errors.json nao sera salvo.
        /*
        logSseUpstreamError({
          body,
          response,
          text,
          events,
          apiNumber,
          model: activeModel,
          sseError,
          requestStartedAt
        });
        */
        if (sseError.status === 500 && http500State) http500State.count++;

        const sse500Failover = sseError.status === 500 && http500State && http500State.count >= MAX_500_RETRIES && options.resolveModel;

        if (sse500Failover && options.resolveModel) {
          const previousModel = activeModel;
          if (activeModel) exhaustedModels.push(activeModel);
          const nextModel = options.resolveModel(exhaustedModels.slice());
          if (nextModel && !exhaustedModels.includes(nextModel)) {
            markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber, reason: `modelo em erro SSE HTTP 500 apos ${MAX_500_RETRIES} tentativas`, timestamp: now() });
            activeModel = nextModel;
            body = { ...body, model: nextModel };
            attempt = 0;
            emptyRetryState.count = 0;
            http500State.count = 0;
            continue;
          }
        }

        if (attempt < maxAttempts) {
          continue;
        }
        if (clientWantsStream) {
          const headers = cloneHeaders(response);
          headers.set('content-type', 'text/event-stream');
          return new Response(SSE_DONE_CHUNK, { status: 200, headers });
        }
        return Response.json(completion, { status: 200, headers: { 'cache-control': 'no-store' } });
      }

      if (!completionHasOutput(completion)) {
        markApiUpstreamError({ apiNumber, status: 204, message: emptyResponseMessage(activeModel), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, totalTokens: usageInfo?.total_tokens, promptTokens: usageInfo?.prompt_tokens, completionTokens: usageInfo?.completion_tokens, model: activeModel, timestamp: now() });

        const emptyAttempt = emptyRetryState.count + 1;
        // [DESLIGADO] logEmptyNvidiaResponse comentado — last_errors.json nao sera salvo.
        /*
        logEmptyNvidiaResponse({
          body,
          response,
          text,
          completion,
          apiNumber,
          model: activeModel,
          emptyAttempt,
          maxEmptyRetries: EMPTY_RESPONSE_MAX_RETRIES,
          requestStartedAt
        });
        */
        emptyRetryState.count++;
        if (emptyRetryState.count < EMPTY_RESPONSE_MAX_RETRIES) {
          continue;
        }

        if (http500State) http500State.count++;
        const emptyFailover = http500State && http500State.count >= MAX_500_RETRIES && options.resolveModel;
        if (emptyFailover && options.resolveModel) {
          const previousModel = activeModel;
          if (activeModel) exhaustedModels.push(activeModel);
          const nextModel = options.resolveModel(exhaustedModels.slice());
          if (nextModel && !exhaustedModels.includes(nextModel)) {
            markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber, reason: `modelo em resposta vazia apos ${MAX_500_RETRIES} tentativas`, timestamp: now() });
            activeModel = nextModel;
            body = { ...body, model: nextModel };
            attempt = 0;
            emptyRetryState.count = 0;
            http500State.count = 0;
            continue;
          }
        }

        if (clientWantsStream) {
          const headers = cloneHeaders(response);
          headers.set('content-type', 'text/event-stream');
          return new Response(ensureSseDone(text), { status: 200, headers });
        }
        return Response.json(completion, { status: 200, headers: { 'cache-control': 'no-store' } });
      }
      onResponseText?.(String(completion.choices?.[0]?.message?.content || ''), activeModel);
      markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, totalTokens: usageInfo?.total_tokens, promptTokens: usageInfo?.prompt_tokens, completionTokens: usageInfo?.completion_tokens, model: activeModel, timestamp: now() });
      if (clientWantsStream) {
        const headers = cloneHeaders(response);
        headers.set('content-type', 'text/event-stream');
        return new Response(ensureSseDone(text), { status: response.status, statusText: response.statusText, headers });
      }
      return Response.json(completion, { status: response.status, statusText: response.statusText, headers: { 'cache-control': 'no-store' } });

    } catch (error: any) {
      markApiRequestError({ apiNumber, message: error?.message || String(error), requestStartedAt, attempt, maxAttempts, timestamp: now() });
      return Response.json({
        error: { type: 'upstream_timeout', message: error?.message || 'A API NVIDIA nao iniciou resposta a tempo.' }
      }, { status: 504 });
    }
  }

  return Response.json({
    error: { type: 'rate_limited', message: 'Todas as APIs Gemini retornaram 429.' }
  }, { status: 429 });
}

// ===========================================================================
// hedgeForward: fluxo completo com hedge.
//
// 1. Dispara fetch HTTP do primario com timeout de 600s
// 2. Timer de 60s corre em paralelo esperando o HTTP 200
// 3. Se timer vencer → faz doFetch completo do backup
// 4. Quando o backup responder (HTTP 200 + primeiro chunk) → grace period de 10s
// 5. Se primario responder no grace → primario vence
// 6. Se nao → backup vence, primario cancelado, sticky ativado
// ===========================================================================
async function hedgeForward(
  body: Record<string, unknown>,
  activeModel: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  attempt: number,
  maxAttempts: number,
  requestStartedAt: number,
  resolveModelFn: (exhausted: string[]) => string | null,
  upstreamBody: Record<string, unknown>,
  acquired: { apiKey: string; apiNumber: number },
  clientWantsStream: boolean,
  now: () => number,
  clientAbortSignal?: AbortSignal,
  onResponseText?: (text: string) => void,
  emptyRetryState?: { count: number },
  http500State?: { count: number },
  exhaustedModels?: string[]
): Promise<Response | undefined> {
  const primaryApiNumber = acquired.apiNumber;
  const primaryAbort = new AbortController();

  // Helper: trata abort do cliente — aborta primario e/ou backup
  let backupAbortForCleanup: AbortController | null = null;
  const onClientAbort = () => {
    primaryAbort.abort();
    if (backupAbortForCleanup) backupAbortForCleanup.abort();
  };
  const abortListener = clientAbortSignal
    ? () => { clientAbortSignal.addEventListener('abort', onClientAbort, { once: true }); }
    : () => {};
  abortListener();
  const cleanup = () => {
    if (clientAbortSignal) clientAbortSignal.removeEventListener('abort', onClientAbort);
  };

  // Se o cliente ja cancelou, aborta tudo
  if (clientAbortSignal?.aborted) {
    primaryAbort.abort();
    cleanup();
    return undefined;
  }
  // Retorna {response, reader} ou null em caso de abort/timeout/erro
  const primaryHttp = (async (): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> } | null> => {
    try {
      const response = await withTimeout(fetchImpl(UPSTREAM_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${acquired.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        signal: primaryAbort.signal,
        body: JSON.stringify(upstreamBody)
      }), timeoutMs);
      if (primaryAbort.signal.aborted) return null;
      // Nao trava o body em erro: o 429 precisa ser lido para classificar a cota.
      if (!response.body || !response.ok) return { response, reader: new ReadableStream<Uint8Array>().getReader() };
      return { response, reader: response.body.getReader() };
    } catch (error: any) {
      if (error?.name === 'AbortError') return null;
      return null;
    }
  })();

  // Timer do hedge
  let hedgeTimerHandle: NodeJS.Timeout | undefined;
  const hedgeTimer = new Promise<'timeout'>((resolve) => {
    hedgeTimerHandle = setTimeout(() => resolve('timeout'), HEDGE_SLOW_THRESHOLD_MS);
  });

  // Race: HTTP do primario vs timer
  const first = await Promise.race([
    primaryHttp.then((r) => ({ type: 'primary' as const, result: r })),
    hedgeTimer.then(() => ({ type: 'hedge' as const }))
  ]);
  if (first.type === 'primary' && hedgeTimerHandle) clearTimeout(hedgeTimerHandle);

  // ---- Caso A: Primario respondeu HTTP (qualquer status) antes do timer ----
  if (first.type === 'primary') {
    const httpResult = first.result;
    if (!httpResult) return undefined;

    const { response, reader } = httpResult;

    markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

    // 429: coloca em castigo e retorna undefined pro loop tentar de novo
    if (response.status === 429) {
      markApiUpstreamError({ apiNumber: primaryApiNumber, status: 429, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, primaryApiNumber), timestamp: now() });
      markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
      await reader.cancel().catch(() => {});
      cleanup();
      return undefined;
    }

    // Outro HTTP erro
    if (!response.ok) {
      markApiUpstreamError({ apiNumber: primaryApiNumber, status: response.status, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      await noteKeyLevelFailure(response, primaryApiNumber);
      if (response.status === 429) markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, primaryApiNumber), timestamp: now() });
      if (response.status !== 429) {
        // [DESLIGADO] captureUpstreamErrorForLog comentado — last_errors.json nao sera salvo.
        // void captureUpstreamErrorForLog(response, body, activeModel);
      }
      markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
      await reader.cancel().catch(() => {});
      cleanup();
      if (response.status === 500 && http500State) {
        http500State.count++;
        if (http500State.count >= MAX_500_RETRIES && resolveModelFn) {
          const previousModel = activeModel;
          const exhausted = exhaustedModels ? exhaustedModels.slice() : [];
          if (previousModel) exhausted.push(previousModel);
          const nextModel = resolveModelFn(exhausted);
          if (nextModel && !exhausted.includes(nextModel)) {
            markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber: primaryApiNumber, reason: `modelo em erro HTTP 500 apos ${MAX_500_RETRIES} tentativas`, timestamp: now() });
            if (exhaustedModels) exhaustedModels.push(previousModel!);
            http500State.count = 0;
          }
        }
      }
      return undefined; // loop externo tenta de novo ou faz failover
    }

    // HTTP 200! Le o primeiro chunk
    markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

    let firstChunk: Uint8Array;
    try {
      const readResult = await withTimeout(reader.read(), Math.max(1, Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt))));
      firstChunk = readResult.done ? new Uint8Array() : (readResult.value || new Uint8Array());
    } catch {
      firstChunk = new Uint8Array();
    }

    const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk, abortController: primaryAbort };
    cleanup();
    return makeSuccessResponse(ma, body, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState, http500State);
  }

  // ---- Caso B: Hedge timeout! Primario nao respondeu HTTP em 60s ----
  console.log(`[HEDGE] Primario (${activeModel}) sem HTTP 200 em ${HEDGE_SLOW_THRESHOLD_MS}ms. Disparando backup.`);

  const backupModel = resolveModelFn([activeModel]);
  if (!backupModel) {
    console.log(`[HEDGE] Nenhum modelo backup. Aguardando primario.`);
    cleanup();
    const httpResult = await primaryHttp;
    if (!httpResult) { cleanup(); return undefined; }
    return processPrimaryHttp(httpResult, body, activeModel, fetchImpl, timeoutMs, rateLimitOptions, attempt, maxAttempts, requestStartedAt, resolveModelFn, upstreamBody, acquired, clientWantsStream, now, onResponseText, clientAbortSignal, emptyRetryState, http500State);
  }
  console.log(`[HEDGE] Backup modelo: ${backupModel}`);

  // Se o cliente cancelou, aborta tudo
  if (clientAbortSignal?.aborted) {
    primaryAbort.abort();
    if (clientAbortSignal) clientAbortSignal.removeEventListener('abort', onClientAbort);
    return undefined;
  }

  // Dispara backup (doFetch completo: acquireApiKey + fetch + primeiro chunk)
  const backupAbort = new AbortController();
  backupAbortForCleanup = backupAbort;

  const backupAttempt = await doFetchWithModel(
    { ...body, model: backupModel }, backupModel,
    fetchImpl, timeoutMs, rateLimitOptions, requestStartedAt, backupAbort
  );

  if (!backupAttempt) {
    console.log(`[HEDGE] Backup falhou. Aguardando primario.`);
    cleanup();
    const httpResult = await primaryHttp;
    if (!httpResult) { cleanup(); return undefined; }
    return processPrimaryHttp(httpResult, body, activeModel, fetchImpl, timeoutMs, rateLimitOptions, attempt, maxAttempts, requestStartedAt, resolveModelFn, upstreamBody, acquired, clientWantsStream, now, onResponseText, clientAbortSignal, emptyRetryState, http500State);
  }

  // ---- Backup respondeu (HTTP 200 + primeiro chunk). Grace period. ----
  console.log(`[HEDGE] Backup respondeu. Grace period de ${HEDGE_PRIMARY_GRACE_MS}ms...`);
  const primaryLate = await Promise.race([
    primaryHttp.then((r) => r),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HEDGE_PRIMARY_GRACE_MS))
  ]);

  if (primaryLate) {
    // Primario respondeu HTTP no grace period!
    const { response, reader } = primaryLate;

    // Se o primario deu erro, continua com backup!
    if (!response.ok) {
      console.log(`[HEDGE] Primario respondeu com HTTP ${response.status} no grace. Backup mantido.`);
    } else {
      // Primario deu HTTP 200. Le o primeiro chunk e ve se tem dados
      console.log(`[HEDGE] Primario respondeu HTTP 200 no grace period.`);
      markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

      let primaryChunk: Uint8Array;
      try {
        const rr = await withTimeout(reader.read(), Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt)));
        primaryChunk = rr.done ? new Uint8Array() : (rr.value || new Uint8Array());
      } catch {
        primaryChunk = new Uint8Array();
      }

      // Primario tem dados: ele vence!
      if (primaryChunk.length) {
        console.log(`[HEDGE] Primario tem dados. Primario vence, backup cancelado.`);
        backupAbort.abort();
        await backupAttempt.reader.cancel().catch(() => {});
        const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk: primaryChunk, abortController: primaryAbort };
        cleanup();
        return makeSuccessResponse(ma, body, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState, http500State);
      }

      // Primario respondeu HTTP 200 mas chunk vazio — continua com backup
      console.log(`[HEDGE] Primario HTTP 200 mas chunk vazio. Backup mantido.`);
      await reader.cancel().catch(() => {});
    }
  }

  // ---- Backup wins! ----
  console.log(`[HEDGE] Backup venceu! Modelo ${backupAttempt.model} assumiu. Cancelando primario.`);
  primaryAbort.abort();
  try { await primaryHttp; } catch {}
  cleanup();
  markHedgedModelSwitch({ from: activeModel, to: backupAttempt.model, apiNumber: primaryApiNumber, timestamp: Date.now() });
  if (emptyRetryState) emptyRetryState.count = 0;
  return makeSuccessResponse(backupAttempt, body, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState, http500State);
}

// Processa o HTTP response do primario depois que ele respondeu
async function processPrimaryHttp(
  httpResult: { response: Response; reader: ReadableStreamDefaultReader<Uint8Array> },
  body: Record<string, unknown>,
  activeModel: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  attempt: number,
  maxAttempts: number,
  requestStartedAt: number,
  resolveModelFn: (exhausted: string[]) => string | null,
  upstreamBody: Record<string, unknown>,
  acquired: { apiKey: string; apiNumber: number },
  clientWantsStream: boolean,
  now: () => number,
  onResponseText?: (text: string, model?: string) => void,
  clientAbortSignal?: AbortSignal,
  emptyRetryState?: { count: number },
  http500State?: { count: number }
): Promise<Response | undefined> {
  const primaryApiNumber = acquired.apiNumber;
  const { response, reader } = httpResult;

  markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

  if (response.status === 429 && attempt < maxAttempts) {
    markApiUpstreamError({ apiNumber: primaryApiNumber, status: 429, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
    markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, primaryApiNumber), timestamp: now() });
    markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
    await reader.cancel().catch(() => {});
    return undefined;
  }

  if (!response.ok) {
    markApiUpstreamError({ apiNumber: primaryApiNumber, status: response.status, message: await describeUpstreamError(response), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
    await noteKeyLevelFailure(response, primaryApiNumber);
    if (response.status === 429) markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: await rateLimitPenaltyMs(response, activeModel, primaryApiNumber), timestamp: now() });
    markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
    await reader.cancel().catch(() => {});
    return undefined;
  }

  markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

  let firstChunk: Uint8Array;
  try {
    const rr = await withTimeout(reader.read(), Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt)));
    firstChunk = rr.done ? new Uint8Array() : (rr.value || new Uint8Array());
  } catch {
    firstChunk = new Uint8Array();
  }

  const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk, abortController: new AbortController() };
  return makeSuccessResponse(ma, body, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState, http500State);
}

// doFetchWithModel: acquireApiKey + fetch + primeiro chunk, retorna null em erro
async function doFetchWithModel(
  body: Record<string, unknown>,
  model: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  requestStartedAt: number,
  abortController: AbortController
): Promise<ModelAttempt | null> {
  let acquired;
  try {
    acquired = await acquireApiKey({ ...rateLimitOptions, model });
  } catch {
    return null;
  }

  const apiNumber = acquired.apiNumber;
  const upstreamBody = buildUpstreamBody(body);

  try {
    const { response, reader, value } = await readFirstChunk(fetchImpl, UPSTREAM_CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${acquired.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      signal: abortController.signal,
      body: JSON.stringify(upstreamBody)
    }, timeoutMs);

    if (abortController.signal.aborted) {
      await reader.cancel().catch(() => {});
      return null;
    }

    markApiResponseStarted({ apiNumber, requestStartedAt, model, attempt: 1, maxAttempts: 1, timestamp: Date.now() });

    if (!response.ok) {
      markApiUpstreamError({ apiNumber, status: response.status, message: await describeUpstreamError(response), requestStartedAt, model, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
      await noteKeyLevelFailure(response, apiNumber);
      if (response.status === 429) markApiRateLimited({ apiNumber, model, retryAfterMs: (await inspectRateLimit(response)).penaltyMs, timestamp: Date.now() });
      if (response.status !== 429) {
        // [DESLIGADO] captureUpstreamErrorForLog comentado — last_errors.json nao sera salvo.
        // void captureUpstreamErrorForLog(response, body, model);
      }
      markApiResponseCompleted({ apiNumber, requestStartedAt, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
      await reader.cancel().catch(() => {});
      return null;
    }

    markApiSuccess({ apiNumber, model, timestamp: Date.now() });

    return { model, apiNumber, response, reader, firstChunk: value, abortController };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      markApiRequestCancelled({ apiNumber, requestStartedAt, message: 'Request abortada (hedge)', attempt: 1, maxAttempts: 1, timestamp: Date.now() });
    } else {
      markApiRequestError({ apiNumber, message: error?.message || String(error), requestStartedAt, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
    }
    return null;
  }
}