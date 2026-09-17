// Adaptacoes especificas do Gemini (endpoint OpenAI-compativel do AI Studio).
//
// 1) Thought signatures: modelos Gemini 3+ devolvem, em cada tool call,
//    `extra_content.google.thought_signature`. Na volta (proximo turno) essa
//    assinatura precisa ser reenviada, senao o Gemini responde 400
//    "Function call is missing a thought_signature". Clientes Anthropic
//    (Claude Code) e Responses (Codex) descartam campos desconhecidos, entao
//    guardamos as assinaturas em memoria por id da tool call e reinjetamos.
//    Se mesmo assim faltar, usamos o placeholder documentado pelo Google
//    `skip_thought_signature_validator`.
//
// 2) 429 RESOURCE_EXHAUSTED: o corpo traz QuotaFailure (qual cota estourou)
//    e RetryInfo (retryDelay). Limite diario => castigo ate meia-noite do
//    Pacifico; limite por minuto => retryDelay (ou 60s).

import { RATE_LIMIT_MINUTE_PENALTY_MS } from '../config.ts';

export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const SIGNATURE_CACHE_MAX = 5_000;
const signatureCache = new Map<string, unknown>();

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasSignature(toolCall: any) {
  return typeof toolCall?.extra_content?.google?.thought_signature === 'string';
}

export function rememberToolCallExtra(id: unknown, extraContent: unknown) {
  if (typeof id !== 'string' || !id || !isRecord(extraContent)) return;
  signatureCache.delete(id);
  signatureCache.set(id, extraContent);
  while (signatureCache.size > SIGNATURE_CACHE_MAX) {
    const oldest = signatureCache.keys().next().value;
    if (oldest === undefined) break;
    signatureCache.delete(oldest);
  }
}

export function recallToolCallExtra(id: unknown): unknown {
  return typeof id === 'string' ? signatureCache.get(id) : undefined;
}

export function clearToolCallExtras() {
  signatureCache.clear();
}

// Registra assinaturas vindas de um chunk/mensagem de chat completion.
export function rememberFromToolCalls(toolCalls: unknown) {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (call?.extra_content) rememberToolCallExtra(call.id, call.extra_content);
  }
}

// Modelos 2.x nao usam thought signature; nao mandamos placeholder para eles.
function modelNeedsSignature(model: unknown) {
  if (typeof model !== 'string') return true;
  return !/(^|\/)gemini-(1|2)(\.|-)/i.test(model);
}

// Reinjeta assinaturas nas mensagens do assistente antes de enviar ao Gemini.
// Retorna um novo array de mensagens (nao muta o original).
export function withThoughtSignatures(messages: unknown, model?: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const needsPlaceholder = modelNeedsSignature(model);
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      return message;
    }
    const toolCalls = message.tool_calls.map((call: any) => {
      if (!isRecord(call) || hasSignature(call)) return call;
      const cached = recallToolCallExtra(call.id);
      return cached ? { ...call, extra_content: cached } : call;
    });
    // Em chamadas paralelas so a primeira precisa estar assinada.
    if (needsPlaceholder && !toolCalls.some(hasSignature) && isRecord(toolCalls[0])) {
      toolCalls[0] = {
        ...toolCalls[0],
        extra_content: {
          ...(isRecord(toolCalls[0].extra_content) ? toolCalls[0].extra_content : {}),
          google: {
            ...(isRecord(toolCalls[0].extra_content?.google) ? toolCalls[0].extra_content.google : {}),
            thought_signature: SKIP_THOUGHT_SIGNATURE
          }
        }
      };
    }
    return { ...message, tool_calls: toolCalls };
  });
}

// ---------------------------------------------------------------------------
// 429
// ---------------------------------------------------------------------------

export type RateLimitInfo = {
  scope: 'daily' | 'minute' | 'unknown';
  penaltyMs: number;
  quotaId?: string;
  message?: string;
};

// Quantos ms faltam para a proxima meia-noite em America/Los_Angeles.
export function msUntilNextPacificMidnight(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const hour = get('hour') % 24;
  const elapsedMs = ((hour * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  // +5s de folga para nao bater exatamente na virada.
  return Math.max(1_000, 24 * 3_600_000 - elapsedMs + 5_000);
}

function parseDurationMs(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

function parseRetryAfterHeader(response: Response) {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function classifyRateLimitBody(raw: unknown, now = Date.now()): RateLimitInfo {
  let payload: any = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { payload = undefined; }
  }
  if (Array.isArray(payload)) payload = payload[0];
  const error = payload?.error ?? payload;
  const details: any[] = Array.isArray(error?.details) ? error.details : [];
  const message = typeof error?.message === 'string' ? error.message : undefined;

  const quotaIds: string[] = [];
  let retryMs: number | undefined;
  for (const detail of details) {
    const type = String(detail?.['@type'] || '');
    if (type.endsWith('QuotaFailure')) {
      for (const violation of detail.violations || []) {
        if (typeof violation?.quotaId === 'string') quotaIds.push(violation.quotaId);
        if (typeof violation?.quotaMetric === 'string') quotaIds.push(violation.quotaMetric);
      }
    }
    if (type.endsWith('RetryInfo')) retryMs = parseDurationMs(detail.retryDelay) ?? retryMs;
  }

  const haystack = [...quotaIds, message || ''].join(' ');
  if (/per[_\s-]?day|PerDay|daily/i.test(haystack)) {
    return { scope: 'daily', penaltyMs: msUntilNextPacificMidnight(now), quotaId: quotaIds[0], message };
  }
  if (/per[_\s-]?minute|PerMinute/i.test(haystack) || retryMs !== undefined) {
    return { scope: 'minute', penaltyMs: retryMs ?? RATE_LIMIT_MINUTE_PENALTY_MS, quotaId: quotaIds[0], message };
  }
  return { scope: 'unknown', penaltyMs: RATE_LIMIT_MINUTE_PENALTY_MS, quotaId: quotaIds[0], message };
}

const rateLimitCache = new WeakMap<Response, Promise<RateLimitInfo>>();

// Le (uma vez) o corpo do 429 e decide o castigo. Nunca lanca.
export function inspectRateLimit(response: Response): Promise<RateLimitInfo> {
  const cached = rateLimitCache.get(response);
  if (cached) return cached;
  const promise = (async (): Promise<RateLimitInfo> => {
    const headerMs = parseRetryAfterHeader(response);
    let text = '';
    try {
      if (response.body && !response.bodyUsed && !response.body.locked) {
        text = await Promise.race([
          response.clone().text(),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 2_000))
        ]);
      }
    } catch {
      text = '';
    }
    const info = classifyRateLimitBody(text);
    if (info.scope === 'unknown' && headerMs !== undefined) {
      return { ...info, scope: 'minute', penaltyMs: headerMs };
    }
    return info;
  })();
  rateLimitCache.set(response, promise);
  return promise;
}
