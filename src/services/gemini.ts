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

import { RATE_LIMIT_MINUTE_PENALTY_MS, modelLimitsFor } from '../config.ts';

// Modelo com cota 0 no tier da chave: fora do rodizio por 24h.
export const UNAVAILABLE_MODEL_PENALTY_MS = 24 * 60 * 60_000;

// Ultimo motivo de 429 por modelo, para explicar ao cliente/UI quando todas as
// chaves estao de castigo (senao so aparece "tente mais tarde").
const lastRateLimitByModel = new Map<string, RateLimitInfo>();

export function rememberRateLimit(model: unknown, info: RateLimitInfo) {
  if (typeof model === 'string' && model) lastRateLimitByModel.set(model, info);
}

export function describeRestingModel(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const info = lastRateLimitByModel.get(model);
  if (!info) return undefined;
  const label = info.scope === 'unavailable'
    ? 'modelo sem cota neste tier (limit: 0)'
    : info.scope === 'daily'
      ? 'cota diaria esgotada (reinicia a meia-noite do Pacifico)'
      : info.scope === 'minute'
        ? 'limite por minuto'
        : 'limite de requisicoes';
  return info.message ? `${label} - ${info.message}` : label;
}

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
  // 'unavailable': a cota do modelo e 0 neste tier (ex.: modelos Pro preview no free tier).
  scope: 'unavailable' | 'daily' | 'minute' | 'unknown';
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

  // O endpoint OpenAI-compativel pode mandar so a mensagem, sem `details`. Ela traz
  // "Quota exceeded for metric: <metrica>, limit: <N>, model: <modelo>" e "Please
  // retry in 32.2s". Como a metrica de requests e a mesma para minuto e dia, o que
  // separa os dois e o NUMERO: comparamos N com os limites conhecidos do modelo
  // (Flash: 5 RPM / 20 RPD; Flash-Lite: 15 RPM / 500 RPD).
  let messageScope: 'daily' | 'minute' | undefined;
  for (const match of (message || '').matchAll(/metric:\s*([^,\s]+),\s*limit:\s*(\d+)(?:,\s*model:\s*([\w.\-\/]+))?/gi)) {
    const [, metric, limitText, model] = match;
    const limit = Number(limitText);
    if (limit === 0) continue;
    if (/token/i.test(metric)) { messageScope = messageScope || 'minute'; continue; }
    const known = model ? modelLimitsFor(model) : undefined;
    if (known && limit === known.rpd && known.rpd !== known.rpm) messageScope = 'daily';
    else if (known && limit === known.rpm) messageScope = messageScope || 'minute';
  }
  if (retryMs === undefined) {
    const hint = (message || '').match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
    if (hint) retryMs = Math.ceil(Number(hint[1]) * 1000);
  }
  const haystack = [...quotaIds, message || '', messageScope === 'daily' ? 'PerDay' : messageScope === 'minute' ? 'PerMinute' : ''].join(' ');
  // "Quota exceeded for metric: ..., limit: 0" => o modelo nao existe neste tier;
  // nao adianta tentar de novo em 1 minuto nem a meia-noite.
  const zeroLimit = /\blimit:\s*0\b/i.test(message || '')
    || details.some((d) => Array.isArray(d?.violations) && d.violations.some((v: any) => String(v?.quotaValue ?? '') === '0'));
  if (zeroLimit) {
    return { scope: 'unavailable', penaltyMs: UNAVAILABLE_MODEL_PENALTY_MS, quotaId: quotaIds[0], message };
  }
  if (/per[_\s-]?day|PerDay|daily/i.test(haystack)) {
    return { scope: 'daily', penaltyMs: msUntilNextPacificMidnight(now), quotaId: quotaIds[0], message };
  }
  if (/per[_\s-]?minute|PerMinute/i.test(haystack) || retryMs !== undefined) {
    return { scope: 'minute', penaltyMs: retryMs ?? RATE_LIMIT_MINUTE_PENALTY_MS, quotaId: quotaIds[0], message };
  }
  return { scope: 'unknown', penaltyMs: RATE_LIMIT_MINUTE_PENALTY_MS, quotaId: quotaIds[0], message };
}

const errorTextCache = new WeakMap<Response, Promise<string>>();

// Le (uma vez, via clone) o corpo de uma resposta de erro. Nunca lanca.
export function readErrorText(response: Response): Promise<string> {
  const cached = errorTextCache.get(response);
  if (cached) return cached;
  const promise = (async () => {
    try {
      if (!response.body || response.bodyUsed || response.body.locked) return '';
      return await Promise.race([
        response.clone().text(),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 2_000))
      ]);
    } catch {
      return '';
    }
  })();
  errorTextCache.set(response, promise);
  return promise;
}

export async function inspectRateLimit(response: Response): Promise<RateLimitInfo> {
  const headerMs = parseRetryAfterHeader(response);
  const info = classifyRateLimitBody(await readErrorText(response));
  if (info.scope === 'unknown' && headerMs !== undefined) {
    return { ...info, scope: 'minute', penaltyMs: headerMs };
  }
  return info;
}

// ---------------------------------------------------------------------------
// Falhas que nao sao do modelo (inspirado no GeminiClient do AliveNPCs)
// ---------------------------------------------------------------------------

export type KeyFailure = 'invalid_key' | 'billing' | 'high_demand';

// Chave invalida: o Gemini responde 400 INVALID_ARGUMENT tao frequentemente quanto
// 401, entao o corpo precisa ser consultado antes do status.
export function classifyKeyFailure(status: number, bodyText: string): KeyFailure | null {
  const body = bodyText || '';
  if (/API_KEY_INVALID|API key not valid|invalid authentication credentials|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|API_KEY_SERVICE_BLOCKED|unrestricted (api )?key|standard (api )?keys? (is|are) (no longer supported|not supported|rejected)|key (has been|is) blocked/i.test(body)
    || (status === 401 && !body.trim())) {
    return 'invalid_key';
  }
  // FAILED_PRECONDITION = free tier indisponivel no pais / billing necessario.
  if (status !== 429 && /FAILED_PRECONDITION|enable billing|billing account/i.test(body)) return 'billing';
  if (status >= 500 && /currently experiencing high demand|Spikes in demand are usually temporary|overloaded/i.test(body)) {
    return 'high_demand';
  }
  return null;
}

// Mensagem legivel do provedor para logs ("Bad Request" nao ajuda ninguem).
export function extractProviderMessage(bodyText: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    let payload: any = JSON.parse(bodyText);
    if (Array.isArray(payload)) payload = payload[0];
    const error = payload?.error ?? payload;
    const message = typeof error?.message === 'string' ? error.message : undefined;
    const status = typeof error?.status === 'string' ? error.status : undefined;
    if (message) return status ? `${status}: ${message}` : message;
  } catch {
    // corpo nao-JSON
  }
  const trimmed = bodyText.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

export async function describeUpstreamError(response: Response): Promise<string> {
  const text = await readErrorText(response);
  return extractProviderMessage(text) || response.statusText || `Gemini HTTP ${response.status}`;
}
