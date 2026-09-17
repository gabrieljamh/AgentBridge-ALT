import { createHash } from 'node:crypto';
import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  HEDGE_STICKY_REQUESTS,
  INTERNAL_API_KEY,
  UPSTREAM_RPM_LIMIT,
  RATE_LIMIT_PENALTY_MS,
  RATE_LIMIT_WINDOW_MS,
  REQUEST_DELAY_MS,
  modelLimitsFor,
  type ModelCatalogEntry
} from '../config.ts';
import { msUntilNextPacificMidnight } from './gemini.ts';

// Um castigo de 429 ATIVO para um modelo especifico. A mesma chave pode ter
// varios destes ao mesmo tempo (um por modelo que recebeu 429).
type ModelPenalty = {
  // Fim do castigo de 429 (epoch ms). Enquanto > agora, a chave fica fora do
  // rodizio PARA ESTE MODELO.
  penaltyUntil: number;
  // Quando o castigo comecou (epoch ms), so para exibir "entrou de castigo as ...".
  penaltyStartedAt: number;
  // Quantas respostas HTTP 200 esta (chave, modelo) acumulou ATE levar o 429.
  // Congelado no instante do 429 e exibido na tela de castigo.
  successesBefore429: number;
};

type ApiKeyState = {
  apiKey: string;
  requestTimestamps: number[];
  // Castigo de 429 POR MODELO. A chave pode estar de castigo no Kimi mas ainda
  // livre no Deepseek: cada 429 marca apenas o modelo que veio na request, entao
  // trocar de modelo nao paga cooldown desnecessario. A chave do Map e o nome do
  // modelo ('' quando a request nao informou modelo).
  penalties: Map<string, ModelPenalty>;
  // Contagem de HTTP 200 POR MODELO desde o ultimo reset. Vai subindo a cada 200
  // enquanto o modelo esta livre; quando a chave leva 429 nesse modelo, o valor e
  // copiado para o penalty (successesBefore429) e zera SO quando o castigo expira
  // (o modelo sai do castigo). A chave do Map e o nome do modelo ('' sem modelo).
  successCounts: Map<string, number>;
};

// Normaliza o nome do modelo usado como chave do castigo. Sem modelo cai para ''.
function modelKey(model?: string) {
  return typeof model === 'string' && model.trim() ? model.trim() : '';
}

export type AcquireApiKeyOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  // Modelo da request: o castigo e checado/aplicado por modelo.
  model?: string;
};

export type ApiKeyUsageEvent = {
  apiNumber: number;
  requestsThisMinute: number;
  totalRequestsThisMinute: number;
  timestamp: number;
};

export type ApiKeyPenaltyEvent = {
  apiNumber: number;
  // Modelo que levou o 429 ('' quando a request nao informou modelo).
  model: string;
  penaltyStartedAt: number;
  penaltyUntil: number;
  // Quantas 200 essa (chave, modelo) tinha acumulado ate dar o 429.
  successesBefore429: number;
};

export type ApiRequestLogEvent = {
  type:
    | 'received'
    | 'rejected'
    | 'completed_client'
    | 'failed_client'
    | 'called'
    | 'delay'
    | 'rate_limit_wait'
    | 'started'
    | 'completed'
    | 'upstream_error'
    | 'error'
    | 'cancelled'
    | 'model_switch';
  apiNumber?: number;
  timestamp: number;
  requestsThisMinute?: number;
  totalRequestsThisMinute?: number;
  delayMs?: number;
  elapsedMs?: number;
  method?: string;
  path?: string;
  protocol?: string;
  status?: number;
  model?: string;
  stream?: boolean;
  attempt?: number;
  maxAttempts?: number;
  waitMs?: number;
  message?: string;
  // Tokens consumidos na request (prompt + completion), quando a NVIDIA informa.
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export const API_REQUEST_LOG_RETENTION_MS = 3 * 60_000;

let apiKeyStates: ApiKeyState[] = [];
let currentPort = DEFAULT_PORT;
let requestDelayMs = REQUEST_DELAY_MS;
// Chave local que os clientes (Codex/Claude/etc.) precisam enviar como Bearer ou
// x-api-key para falar com o proxy. Comeca na chave padrao do config e pode ser
// trocada pelo usuario (persistida criptografada junto da config). Nunca e
// exposta na mensagem de erro de autenticacao.
let localApiKey = INTERNAL_API_KEY;
// Modelo NVIDIA para onde TODA chamada e redirecionada. Sempre ativo: o proxy
// ignora o modelo que o cliente mandou e usa este. Trocar de modelo e a unica
// forma de "desligar" o anterior. No modo manual e o modelo fixo escolhido pelo
// usuario; no modo automatico e apenas o fallback quando a lista de prioridades
// nao resolve nada.
let selectedModel = DEFAULT_MODEL;
// Alternancia automatica de modelo. Quando ligada, o proxy escolhe sozinho o
// modelo de cada request varrendo `modelPriority` do topo e usando o primeiro que
// ainda tenha alguma chave fora de castigo (429). Assim, assim que um modelo de
// prioridade mais alta libera uma chave, o proxy volta a usa-lo automaticamente.
let autoToggle = false;
// Ordem de prioridade do failover automatico (ids "provider/modelo").
let modelPriority: string[] = [];
// Ultimo modelo realmente colocado em uso (modo automatico): serve para exibir na
// UI. O rodizio de chaves agora e POR MODELO: cada modelo gruda na sua chave
// atual ate ela levar 429; trocar de modelo nao mexe no cursor do outro.
let activeModel = DEFAULT_MODEL;
// Cursor sticky POR MODELO: cada modelo lembra o indice da chave que estava
// usando. A primeira vez que um modelo aparece, sorteia uma chave elegivel
// aleatoriamente (para nao comecar sempre na chave 0 e cansa-la). Depois gruda
// nela ate receber 429 -- quando isso acontece, sorteia outra elegivel.
let modelCursors = new Map<string, number>();
let nextSendAt = 0;
// Estado sticky do hedge: quando o backup vence porque o primario foi lento,
// guardamos o modelo backup aqui e quantas requests ainda faltam para voltar
// ao comportamento normal de prioridade.
let hedgeStickyModel: string | undefined;
let hedgeStickyRemaining = 0;
// Modelos desativados pelo usuario: nao podem ser chamados nem listados em
// /v1/models, mas ainda contam na contabilidade de tokens e economia. Guardamos
// apenas os ids em um Set para checagem rapida O(1).
let deactivatedIds = new Set<string>();
const usageListeners = new Set<(event: ApiKeyUsageEvent) => void>();
const requestLogListeners = new Set<(event: ApiRequestLogEvent) => void>();
const penaltyListeners = new Set<(event: ApiKeyPenaltyEvent) => void>();

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function pruneApiRequestLogs<T extends { timestamp: number }>(
  logs: T[],
  now = Date.now(),
  maxEntries = 100
) {
  const cutoff = now - API_REQUEST_LOG_RETENTION_MS;
  return logs
    .filter((entry) => entry.timestamp >= cutoff)
    .slice(-maxEntries);
}

// ---------------------------------------------------------------------------
// Orcamento diario (RPD) por (chave, modelo)
// ---------------------------------------------------------------------------
// O Gemini conta requests por PROJETO (= chave) e por modelo, zerando a meia-noite
// do Pacifico. Guardamos a contagem local para (1) mostrar "usado hoje / limite" e
// (2) pular a chave naquele modelo quando o limite do dia acabou, sem gastar uma
// request so para receber 429. Tentativas que falham tambem contam (o Gemini conta).
// A chave e identificada por um hash curto (nunca a chave em si), entao a contagem
// sobrevive a reordenar/remover chaves e pode ir para disco.

type DailyCounter = { day: string; count: number };
const dailyUsage = new Map<string, Map<string, DailyCounter>>();
const dailyUsageListeners = new Set<() => void>();

export function keyFingerprint(apiKey: string) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

// Data (YYYY-MM-DD) no fuso do Pacifico, que e quando o Gemini zera o RPD.
export function pacificDay(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(timestamp));
}

function dailyCount(apiKey: string, model: string, timestamp: number) {
  const counter = dailyUsage.get(keyFingerprint(apiKey))?.get(model);
  return counter && counter.day === pacificDay(timestamp) ? counter.count : 0;
}

function setDailyCount(apiKey: string, model: string, count: number, timestamp: number) {
  const fp = keyFingerprint(apiKey);
  let perModel = dailyUsage.get(fp);
  if (!perModel) {
    perModel = new Map();
    dailyUsage.set(fp, perModel);
  }
  perModel.set(model, { day: pacificDay(timestamp), count });
  dailyUsageListeners.forEach((listener) => {
    try { listener(); } catch { /* UI nao derruba o proxy */ }
  });
}

function dailyBudgetExhausted(state: ApiKeyState, model: string, timestamp: number) {
  const limits = modelLimitsFor(model);
  return Boolean(limits && dailyCount(state.apiKey, model, timestamp) >= limits.rpd);
}

export function onDailyUsageChanged(listener: () => void) {
  dailyUsageListeners.add(listener);
  return () => dailyUsageListeners.delete(listener);
}

// O Gemini respondeu 429 de cota DIARIA: sincroniza a contagem local com o limite
// (a chave pode ter sido usada fora do app, ex.: AI Studio ou AliveNPCs).
export function markDailyBudgetExhausted(input: { apiNumber: number; model?: string; timestamp?: number }) {
  const state = apiKeyStates[input.apiNumber - 1];
  const model = modelKey(input.model);
  const limits = modelLimitsFor(model);
  if (!state || !limits) return;
  const timestamp = input.timestamp ?? Date.now();
  setDailyCount(state.apiKey, model, Math.max(limits.rpd, dailyCount(state.apiKey, model, timestamp)), timestamp);
}

export type PersistedDailyUsage = { keyFingerprint: string; model: string; day: string; count: number };

export function exportDailyUsage(timestamp = Date.now()): PersistedDailyUsage[] {
  const today = pacificDay(timestamp);
  const rows: PersistedDailyUsage[] = [];
  for (const [fp, perModel] of dailyUsage) {
    for (const [model, counter] of perModel) {
      if (counter.day === today && counter.count > 0) rows.push({ keyFingerprint: fp, model, day: counter.day, count: counter.count });
    }
  }
  return rows;
}

export function importDailyUsage(rows: unknown, timestamp = Date.now()) {
  if (!Array.isArray(rows)) return;
  const today = pacificDay(timestamp);
  for (const row of rows as PersistedDailyUsage[]) {
    if (!row || typeof row.keyFingerprint !== 'string' || typeof row.model !== 'string') continue;
    if (row.day !== today || !(Number(row.count) > 0)) continue;
    let perModel = dailyUsage.get(row.keyFingerprint);
    if (!perModel) {
      perModel = new Map();
      dailyUsage.set(row.keyFingerprint, perModel);
    }
    const current = perModel.get(row.model);
    const count = Math.max(Number(row.count), current && current.day === today ? current.count : 0);
    perModel.set(row.model, { day: today, count });
  }
}

export function clearDailyUsage() {
  dailyUsage.clear();
}

// Linhas "usado hoje / limite" por (chave, modelo) com uso > 0 hoje.
function dailyRows(state: ApiKeyState, timestamp: number) {
  const perModel = dailyUsage.get(keyFingerprint(state.apiKey));
  if (!perModel) return [];
  const today = pacificDay(timestamp);
  return [...perModel.entries()]
    .filter(([, counter]) => counter.day === today && counter.count > 0)
    .map(([model, counter]) => {
      const limits = modelLimitsFor(model);
      return { model, used: counter.count, limit: limits ? limits.rpd : null, exhausted: Boolean(limits && counter.count >= limits.rpd) };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

export function setRuntimeConfig(config: {
  apiKeys: string[];
  port?: number;
  requestDelayMs?: number;
  selectedModel?: string;
  autoToggle?: boolean;
  modelPriority?: string[];
  localApiKey?: string;
  deactivatedModels?: ModelCatalogEntry[];
}) {
  const previousStates = new Map(
    apiKeyStates.map((state) => [state.apiKey, state])
  );
  apiKeyStates = [...new Set(config.apiKeys.filter(Boolean))].map((apiKey) => {
    const previous = previousStates.get(apiKey);
    return previous || {
      apiKey,
      requestTimestamps: [],
      penalties: new Map<string, ModelPenalty>(),
      successCounts: new Map<string, number>()
    };
  });
  currentPort = config.port || DEFAULT_PORT;
  requestDelayMs = normalizeRequestDelayMs(config.requestDelayMs);
  if (typeof config.selectedModel === 'string' && config.selectedModel.trim()) {
    selectedModel = config.selectedModel.trim();
  }
  if (typeof config.autoToggle === 'boolean') {
    autoToggle = config.autoToggle;
  }
  if (Array.isArray(config.modelPriority)) {
    modelPriority = config.modelPriority
      .map((model) => String(model || '').trim())
      .filter(Boolean);
  }
  if (typeof config.localApiKey === 'string' && config.localApiKey.trim()) {
    localApiKey = config.localApiKey.trim();
  }
  if (Array.isArray(config.deactivatedModels)) {
    deactivatedIds = new Set(
      config.deactivatedModels
        .map((item) => String(item?.model || '').trim())
        .filter(Boolean)
    );
  }
  modelCursors = new Map();
}

export function clearRuntimeConfig() {
  apiKeyStates = [];
  modelCursors = new Map();
  nextSendAt = 0;
  requestDelayMs = REQUEST_DELAY_MS;
  selectedModel = DEFAULT_MODEL;
  autoToggle = false;
  modelPriority = [];
  activeModel = DEFAULT_MODEL;
  localApiKey = INTERNAL_API_KEY;
  deactivatedIds = new Set();
  clearHedgeSticky();
}

// Chave local exigida dos clientes. Sempre devolve algo nao vazio (cai para a
// chave padrao do config quando nada foi definido).
export function getLocalApiKey() {
  return localApiKey && localApiKey.trim() ? localApiKey.trim() : INTERNAL_API_KEY;
}

// Define a chave local que o proxy passa a exigir. Vazio volta para a padrao.
export function setLocalApiKey(key: unknown) {
  const normalized = String(key || '').trim();
  localApiKey = normalized || INTERNAL_API_KEY;
  return localApiKey;
}

// Define a lista de modelos desativados. Modelos desativados nao podem ser
// chamados nem listados, mas ainda contam na contabilidade de tokens e economia.
export function setDeactivatedModels(models: ModelCatalogEntry[]) {
  deactivatedIds = new Set(
    (Array.isArray(models) ? models : [])
      .map((item) => String(item?.model || '').trim())
      .filter(Boolean)
  );
  return deactivatedIds;
}

// Diz se um modelo esta desativado (nao pode ser chamado nem listado).
export function isModelDeactivated(model: string): boolean {
  const id = String(model || '').trim();
  return id !== '' && deactivatedIds.has(id);
}

// Liga/desliga a alternancia automatica de modelo.
export function setAutoToggle(value: unknown) {
  autoToggle = Boolean(value);
  return autoToggle;
}

export function isAutoToggleEnabled() {
  return autoToggle;
}

// Define a ordem de prioridade do failover automatico (ids "provider/modelo").
export function setModelPriority(list: unknown) {
  if (Array.isArray(list)) {
    modelPriority = list
      .map((model) => String(model || '').trim())
      .filter(Boolean);
  }
  return modelPriority.slice();
}

export function getModelPriority() {
  return modelPriority.slice();
}

// Modelo realmente em uso agora (no modo automatico pode diferir do manual).
export function getActiveModel() {
  return activeModel && activeModel.trim() ? activeModel.trim() : getSelectedModel();
}

// Varre a lista de prioridades (do topo) e devolve o primeiro modelo que ainda
// tenha PELO MENOS uma chave fora de castigo (429), ignorando os ids em `exhausted`.
// Devolve null quando nenhum modelo elegivel sobra -- ai nao ha para onde correr.
export function pickAvailableModel(exhausted: string[] = [], timestamp = Date.now()): string | null {
  if (!apiKeyStates.length) return null;
  const skip = new Set(exhausted.map((model) => modelKey(model)));
  for (const candidate of modelPriority) {
    const id = candidate.trim();
    if (!id || skip.has(modelKey(id))) continue;
    if (deactivatedIds.has(id)) continue;
    const hasFreeKey = apiKeyStates.some((state) => {
      resetExpiredWindow(state, timestamp);
      return !isResting(state, timestamp, id);
    });
    if (hasFreeKey) return id;
  }
  return null;
}

// Igual ao pickAvailableModel, mas e o ponto de entrada usado pelo failover de
// modelo dentro de uma request (nvidia.ts). Mantido separado para deixar a
// intencao explicita no call-site.
export function resolveAvailableModel(exhausted: string[] = [], timestamp = Date.now()): string | null {
  return pickAvailableModel(exhausted, timestamp);
}

// Este modelo especifico tem PELO MENOS uma chave fora de castigo (429) agora?
// Usado pelas rotas diretas (/v1/direct/*) e por GET /v1/models/available para
// dizer ao cliente quais modelos estao realmente prontos para receber request.
// Independe do modelo selecionado no app: o castigo e checado por (chave, modelo).
export function isModelAvailable(model: string, timestamp = Date.now()): boolean {
  if (!apiKeyStates.length) return false;
  const id = String(model || '').trim();
  if (!id) return false;
  if (deactivatedIds.has(id)) return false;
  return apiKeyStates.some((state) => {
    resetExpiredWindow(state, timestamp);
    return !isResting(state, timestamp, id);
  });
}

// Modelo efetivo de uma request. No modo manual, sempre o modelo fixo. No modo
// automatico, reavalia a lista de prioridades DO TOPO a cada chamada (por isso o
// proxy volta sozinho para o modelo de maior prioridade assim que ele libera uma
// chave). O rodizio de chaves e por modelo, entao trocar de modelo efetivo nao
// reseta mais o cursor -- cada modelo lembra a chave que estava usando.
export function getEffectiveModel(timestamp = Date.now()): string {
  let chosen: string;
  if (autoToggle && modelPriority.length) {
    // Sticky hedge: se um modelo backup venceu por lentidao, consumimos uma
    // das requests sticky e usamos ele diretamente sem reavaliar prioridade.
    const sticky = consumeHedgeStickyRequest();
    if (sticky) {
      chosen = sticky;
    } else {
      chosen = pickAvailableModel([], timestamp)
        || modelPriority[0]
        || getSelectedModel();
    }
  } else {
    chosen = getSelectedModel();
  }
  // Se o modelo escolhido (manual ou fallback) esta desativado, tenta achar
  // um modelo ativo da prioridade; senao cai para o DEFAULT_MODEL.
  if (deactivatedIds.has(chosen.trim())) {
    const fallback = modelPriority.find((id) => id && !deactivatedIds.has(id));
    chosen = fallback || DEFAULT_MODEL;
  }
  chosen = chosen.trim() || DEFAULT_MODEL;
  if (chosen !== activeModel) {
    activeModel = chosen;
  }
  return chosen;
}

// Ativa o sticky hedge: guarda o modelo backup que venceu e quantas requests
// ele deve ficar ativo antes de tentar a prioridade normal de novo.
export function setHedgeStickyModel(model: string) {
  hedgeStickyModel = model;
  hedgeStickyRemaining = HEDGE_STICKY_REQUESTS;
}

// Decrementa o contador sticky e retorna o modelo sticky se ainda ativo,
// ou null se o periodo sticky ja terminou.
export function consumeHedgeStickyRequest(): string | null {
  if (hedgeStickyRemaining <= 0 || !hedgeStickyModel) {
    hedgeStickyModel = undefined;
    hedgeStickyRemaining = 0;
    return null;
  }
  hedgeStickyRemaining--;
  if (hedgeStickyRemaining <= 0) {
    const model = hedgeStickyModel;
    hedgeStickyModel = undefined;
    return model;
  }
  return hedgeStickyModel;
}

export function getHedgeStickyRemaining(): number {
  return hedgeStickyRemaining;
}

// Limpa o sticky (usado em clearRuntimeConfig e quando o usuario mexe na config).
export function clearHedgeSticky() {
  hedgeStickyModel = undefined;
  hedgeStickyRemaining = 0;
}

// Modelo de redirecionamento atual (sempre devolve algo nao vazio).
export function getSelectedModel() {
  return selectedModel && selectedModel.trim() ? selectedModel.trim() : DEFAULT_MODEL;
}

// Define o modelo de redirecionamento. Qualquer chamada futura passa a ir para
// ele, independente do que o cliente mandar.
export function setSelectedModel(model: unknown) {
  const normalized = String(model || '').trim();
  selectedModel = normalized || DEFAULT_MODEL;
  return selectedModel;
}

export function onApiKeyUsed(listener: (event: ApiKeyUsageEvent) => void) {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

export function onApiKeyPenalized(listener: (event: ApiKeyPenaltyEvent) => void) {
  penaltyListeners.add(listener);
  return () => penaltyListeners.delete(listener);
}

// Restaura um castigo lido do disco (sem reemitir evento nem mexer no cursor).
// O castigo e por modelo: restaura apenas o par (chave, modelo) salvo.
export function setApiPenaltyUntil(
  apiNumber: number,
  penaltyUntil: number,
  penaltyStartedAt?: number,
  model?: string,
  successesBefore429?: number
) {
  const state = apiKeyStates[apiNumber - 1];
  if (!state) return;
  if (!Number.isFinite(penaltyUntil) || penaltyUntil <= Date.now()) return;
  const successes = Number.isFinite(successesBefore429) ? Number(successesBefore429) : 0;
  state.penalties.set(modelKey(model), {
    penaltyUntil,
    penaltyStartedAt: penaltyStartedAt ?? Date.now(),
    successesBefore429: successes
  });
  // Restaura a contagem congelada para a tela e o JSON seguirem batendo ate o
  // castigo expirar.
  state.successCounts.set(modelKey(model), successes);
}

export function onApiRequestLog(listener: (event: ApiRequestLogEvent) => void) {
  requestLogListeners.add(listener);
  return () => requestLogListeners.delete(listener);
}

export function getRequestDelayMs() {
  return requestDelayMs;
}

export function getApiKeyCount() {
  return apiKeyStates.length;
}

function normalizeRequestDelayMs(value: unknown) {
  if (value === undefined || value === null || value === '') return REQUEST_DELAY_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return REQUEST_DELAY_MS;
  return Math.round(parsed);
}

function resetExpiredWindow(state: ApiKeyState, timestamp: number) {
  const cutoff = timestamp - RATE_LIMIT_WINDOW_MS;
  state.requestTimestamps = state.requestTimestamps.filter((value) => value > cutoff);
  
  // Remove castigos por modelo ja expirados. Ao sair do castigo, a contagem de
  // 200 daquele modelo volta para 0 (comeca a contar de novo do zero).
  for (const [model, penalty] of state.penalties) {
    if (penalty.penaltyUntil <= timestamp) {
      state.penalties.delete(model);
      state.successCounts.delete(model);
    }
  }
}

// A chave esta de castigo PARA ESTE MODELO? Outros modelos seguem livres.
// Castigo de chave inteira (todos os modelos): chave invalida ou sem billing.
export const ALL_MODELS_PENALTY_KEY = '*';

function isResting(state: ApiKeyState, timestamp: number, model?: string) {
  const penalty = state.penalties.get(modelKey(model)) ?? state.penalties.get(ALL_MODELS_PENALTY_KEY);
  return penalty !== undefined && penalty.penaltyUntil > timestamp;
}

// Tira a chave do rodizio em TODOS os modelos (ex.: API_KEY_INVALID). Diferente do
// 429, nao adianta trocar de modelo: o problema e a chave.
export function markApiKeyDisabled(input: { apiNumber: number; durationMs: number; timestamp?: number }) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  if (!state || !(input.durationMs > 0)) return;
  const penaltyUntil = timestamp + input.durationMs;
  state.penalties.set(ALL_MODELS_PENALTY_KEY, { penaltyStartedAt: timestamp, penaltyUntil, successesBefore429: 0 });
  for (const [model, cursor] of modelCursors) {
    if (cursor === input.apiNumber - 1) modelCursors.delete(model);
  }
  const event: ApiKeyPenaltyEvent = { apiNumber: input.apiNumber, model: ALL_MODELS_PENALTY_KEY, penaltyStartedAt: timestamp, penaltyUntil, successesBefore429: 0 };
  penaltyListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Observadores de interface nao podem interromper o encaminhamento.
    }
  });
}

// Lista os castigos ativos da chave (um por modelo), do mais cedo ao mais tarde.
function activePenalties(state: ApiKeyState, timestamp: number) {
  return [...state.penalties.entries()]
    .filter(([, penalty]) => penalty.penaltyUntil > timestamp)
    .map(([model, penalty]) => ({
      model,
      penaltyStartedAt: penalty.penaltyStartedAt,
      penaltyUntil: penalty.penaltyUntil,
      successesBefore429: penalty.successesBefore429
    }))
    .sort((a, b) => a.penaltyUntil - b.penaltyUntil);
}

// Lista a contagem de 200 viva (uma entrada por modelo) da chave.
function successCountRows(state: ApiKeyState) {
  return [...state.successCounts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}

function activeRequests(state: ApiKeyState, timestamp: number) {
  resetExpiredWindow(state, timestamp);
  return state.requestTimestamps.length;
}

function nextResetAt(state: ApiKeyState, timestamp: number) {
  resetExpiredWindow(state, timestamp);
  return state.requestTimestamps.length ? state.requestTimestamps[0] + RATE_LIMIT_WINDOW_MS : null;
}

function totalRequests(timestamp: number) {
  return apiKeyStates.reduce((total, state) => total + activeRequests(state, timestamp), 0);
}

function emitRequestLog(event: ApiRequestLogEvent) {
  requestLogListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Observadores de interface nao podem interromper o encaminhamento.
    }
  });
}

// Registra no log que o failover automatico trocou o modelo da request (ex.: todas
// as chaves do v4 pro de castigo, ou o modelo respondeu 400/404). `from` e o modelo
// que saiu, `to` o que entrou. So aparece no modo de alternancia automatica.
export function markApiModelSwitch(input: {
  from?: string;
  to: string;
  apiNumber?: number;
  reason?: string;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'model_switch',
    apiNumber: input.apiNumber,
    model: input.to,
    message: input.from
      ? `de ${input.from}${input.reason ? ` (${input.reason})` : ''}`
      : input.reason,
    timestamp: input.timestamp ?? Date.now()
  });
}

export function markHedgedModelSwitch(input: {
  from: string;
  to: string;
  apiNumber?: number;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'model_switch',
    apiNumber: input.apiNumber,
    model: input.to,
    message: `de ${input.from} (hedge: primario muito lento)`,
    timestamp: input.timestamp ?? Date.now()
  });
  // Marca o modelo backup como sticky pelas proximas N requests.
  setHedgeStickyModel(input.to);
}

export function markHedgeStickyEnd(input: {
  from: string;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'model_switch',
    model: input.from,
    message: `sticky encerrado para ${input.from}, voltando a prioridade normal`,
    timestamp: input.timestamp ?? Date.now()
  });
}

export function markApiResponseStarted(input: {
  apiNumber: number;
  requestStartedAt: number;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'started',
    apiNumber: input.apiNumber,
    timestamp,
    model: input.model,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  });
}

// A chave respondeu HTTP 200 NESTE MODELO: soma 1 na contagem viva de 200 desse
// par (chave, modelo). A contagem so zera quando um eventual castigo expira.
export function markApiSuccess(input: {
  apiNumber: number;
  model?: string;
  timestamp?: number;
}) {
  const state = apiKeyStates[input.apiNumber - 1];
  if (!state) return;
  const model = modelKey(input.model);
  state.successCounts.set(model, (state.successCounts.get(model) || 0) + 1);
}

export function markApiRateLimited(input: {
  apiNumber: number;
  model?: string;
  retryAfterMs?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const index = input.apiNumber - 1;
  const state = apiKeyStates[index];
  if (!state) return;
  // A chave recebeu HTTP 429 (limite real da NVIDIA) NESTE MODELO. Coloca a chave
  // de castigo por RATE_LIMIT_PENALTY_MS (1 hora) -- ou pelo Retry-After informado,
  // se for maior -- apenas PARA ESTE MODELO, para nao gastar requests inuteis nele
  // enquanto ainda estiver no limite. Outros modelos da mesma chave continuam
  // elegiveis. O castigo e por (chave, modelo) e roda em paralelo.
  const model = modelKey(input.model);
  const retryAfterMs = input.retryAfterMs && input.retryAfterMs > 0 ? input.retryAfterMs : 0;
  // Gemini: o penalty vem classificado do corpo do 429 (diario => ate meia-noite
  // do Pacifico; por minuto => retryDelay). Sem informacao, usa o padrao.
  const penaltyUntil = timestamp + (retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_PENALTY_MS);
  // Congela quantas 200 essa (chave, modelo) acumulou ate aqui. O contador NAO
  // zera agora: zera so quando o castigo expirar (resetExpiredWindow).
  const successesBefore429 = state.successCounts.get(model) || 0;
  state.penalties.set(model, { penaltyStartedAt: timestamp, penaltyUntil, successesBefore429 });
  // A chave que levou 429 sai do rodizio deste modelo. Sorteia outra elegivel
  // (que nao esteja de castigo neste modelo) para ser a nova chave sticky. Se
  // nenhuma outra estiver livre para este modelo, o cursor fica no proximo
  // indice -- quando expirar o castigo ou outro modelo liberar, acquireApiKey
  // reavalia. O castigo e por (chave, modelo) e roda em paralelo.
  const current = modelCursors.get(model);
  if (apiKeyStates.length > 0) {
    // Coleta TODOS os indices elegiveis (excluindo a chave que acabou de levar
    // 429) e sorteia um aleatorio entre eles -- em vez de avancar linearmente
    // (round-robin) para a proxima livre. Assim, duas chaves adjacentes nao
    // ficam sempre preenchendo a mesma sequencia (17 -> 18 -> 19 ...): a cada
    // 429 a nova chave e escolhida com probabilidade uniforme entre as livres.
    const eligibleIdx: number[] = [];
    for (let probe = 0; probe < apiKeyStates.length; probe++) {
      if (probe === index) continue;
      if (!isResting(apiKeyStates[probe], timestamp, model)) {
        eligibleIdx.push(probe);
      }
    }
    const next = eligibleIdx.length > 0
      ? eligibleIdx.length === 1
        ? eligibleIdx[0]
        : eligibleIdx[Math.floor(Math.random() * eligibleIdx.length)]
      : (index + 1) % apiKeyStates.length;
    modelCursors.set(model, next);
  }
  const penaltyEvent: ApiKeyPenaltyEvent = {
    apiNumber: input.apiNumber,
    model,
    penaltyStartedAt: timestamp,
    penaltyUntil,
    successesBefore429
  };
  penaltyListeners.forEach((listener) => {
    try {
      listener(penaltyEvent);
    } catch {
      // Observadores de interface nao podem interromper o encaminhamento.
    }
  });
}

export function markApiDelayWaiting(input: {
  apiNumber?: number;
  delayMs: number;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = input.apiNumber ? apiKeyStates[input.apiNumber - 1] : undefined;
  emitRequestLog({
    type: 'delay',
    apiNumber: input.apiNumber,
    timestamp,
    requestsThisMinute: state ? activeRequests(state, timestamp) : undefined,
    totalRequestsThisMinute: totalRequests(timestamp),
    delayMs: input.delayMs,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  });
}

export function markApiResponseCompleted(input: {
  apiNumber: number;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'completed',
    apiNumber: input.apiNumber,
    timestamp,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    totalTokens: input.totalTokens,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    model: input.model
  });
}

export function markClientRequestReceived(input: {
  method: string;
  path: string;
  protocol?: string;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'received',
    method: input.method,
    path: input.path,
    protocol: input.protocol,
    timestamp: input.timestamp ?? Date.now()
  });
}

export function markClientRequestRejected(input: {
  method: string;
  path: string;
  protocol?: string;
  status: number;
  message: string;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'rejected',
    method: input.method,
    path: input.path,
    protocol: input.protocol,
    status: input.status,
    message: input.message,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markClientRequestCompleted(input: {
  method: string;
  path: string;
  protocol?: string;
  status: number;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'completed_client',
    method: input.method,
    path: input.path,
    protocol: input.protocol,
    status: input.status,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markClientRequestFailed(input: {
  method: string;
  path: string;
  protocol?: string;
  message: string;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'failed_client',
    method: input.method,
    path: input.path,
    protocol: input.protocol,
    message: input.message,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markRateLimitWaiting(input: {
  waitMs: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'rate_limit_wait',
    waitMs: input.waitMs,
    totalRequestsThisMinute: totalRequests(timestamp),
    timestamp
  });
}

export function markApiUpstreamError(input: {
  apiNumber: number;
  status?: number;
  message: string;
  requestStartedAt: number;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'upstream_error',
    apiNumber: input.apiNumber,
    status: input.status,
    message: input.message,
    model: input.model,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export function markApiRequestError(input: {
  apiNumber?: number;
  message: string;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = input.apiNumber ? apiKeyStates[input.apiNumber - 1] : undefined;
  emitRequestLog({
    type: 'error',
    apiNumber: input.apiNumber,
    message: input.message,
    requestsThisMinute: state ? activeRequests(state, timestamp) : undefined,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export function markApiRequestCancelled(input: {
  apiNumber: number;
  requestStartedAt: number;
  message?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'cancelled',
    apiNumber: input.apiNumber,
    message: input.message || 'Cliente cancelou a leitura do stream.',
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export async function reserveSendSlot(options: {
  delayMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const delayMs = options.delayMs;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const current = now();
  // Porteira serializada de envio: cada request espera no minimo delayMs e os
  // envios ficam espacados em delayMs entre si, mesmo com varias requests
  // concorrentes chegando juntas. Assim o delay realmente controla a TAXA que
  // chega na NVIDIA (e o consumo de RPM), em vez de so atrasar um lote inteiro
  // em paralelo. O teto de 35 RPM por chave continua valendo como protecao.
  const sendAt = Math.max(current, nextSendAt) + delayMs;
  nextSendAt = sendAt;
  const waitMs = sendAt - current;
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

export class AllKeysRestingError extends Error {
  readonly code = 'all_resting';
  readonly waitMs: number;
  // true quando TODAS as chaves pararam por orcamento diario local (nao por 429).
  dailyBudget = false;
  constructor(waitMs: number) {
    super('Todas as APIs Gemini estao em castigo apos HTTP 429. Tente novamente mais tarde.');
    this.name = 'AllKeysRestingError';
    this.waitMs = waitMs;
  }
}

export async function acquireApiKey(options: AcquireApiKeyOptions = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const model = options.model;

  while (true) {
    if (!apiKeyStates.length) {
      throw new Error('Nenhuma API Gemini foi desbloqueada.');
    }

    const timestamp = now();
    const key = modelKey(model);

    // Coleta todas as chaves elegiveis (nao em castigo para este modelo) e o
    // menor tempo de espera entre as de castigo (para a mensagem de erro).
    const eligibleIndices: number[] = [];
    let dailyExhaustedKeys = 0;
    let shortestPenaltyWaitMs = Number.POSITIVE_INFINITY;
    for (let index = 0; index < apiKeyStates.length; index++) {
      const state = apiKeyStates[index];
      resetExpiredWindow(state, timestamp);
      if (dailyBudgetExhausted(state, key, timestamp)) {
        dailyExhaustedKeys++;
        shortestPenaltyWaitMs = Math.min(shortestPenaltyWaitMs, msUntilNextPacificMidnight(timestamp));
        continue;
      }
      if (isResting(state, timestamp, model)) {
        const penalty = state.penalties.get(key) ?? state.penalties.get(ALL_MODELS_PENALTY_KEY);
        if (penalty) {
          shortestPenaltyWaitMs = Math.min(
            shortestPenaltyWaitMs,
            penalty.penaltyUntil - timestamp
          );
        }
        continue;
      }
      eligibleIndices.push(index);
    }

    if (eligibleIndices.length === 0) {
      // Todas as chaves estao de castigo. Em vez de segurar a request por ate 1 hora,
      // devolvemos um erro para o cliente reenviar mais tarde.
      const error = new AllKeysRestingError(Math.max(1, Math.ceil(shortestPenaltyWaitMs)));
      if (dailyExhaustedKeys === apiKeyStates.length) {
        const limits = modelLimitsFor(key);
        error.message = limits && limits.rpd === 0
          ? `O modelo ${key} nao tem cota no free tier (0 requests/dia). Use um modelo Flash/Flash-Lite ou uma chave com billing (AGENTBRIDGE_ALT_PAID_TIER=1).`
          : `Limite diario do modelo ${key} esgotado em todas as ${apiKeyStates.length} chave(s)`
            + (limits ? ` (${limits.rpd}/${limits.rpd} por chave)` : '')
            + '. Zera a meia-noite do Pacifico.';
        error.dailyBudget = true;
      }
      throw error;
    }

    // Sticky por modelo: gruda na chave salva para este modelo. Se ainda nao
    // existe cursor para o modelo, ou a salva nao esta mais elegivel (saiu do
    // castigo e voltou, mas markApiRateLimited ja deve ter trocado), sorteia
    // uma aleatoria entre as elegiveis. Enquanto a salva estiver elegivel, usa
    // ela sem mudar -- soh troca quando recebe 429 (markApiRateLimited).
    const saved = modelCursors.get(key);
    let chosenIndex = -1;
    if (saved !== undefined && eligibleIndices.includes(saved)) {
      chosenIndex = saved;
    } else {
      chosenIndex = eligibleIndices.length === 1
        ? eligibleIndices[0]
        : eligibleIndices[Math.floor(Math.random() * eligibleIndices.length)];
      modelCursors.set(key, chosenIndex);
    }

    const state = apiKeyStates[chosenIndex];

    // Sem throttle local de RPM: a janela fica apenas como telemetria para a UI.
    // Se a NVIDIA devolver 429, o fluxo de failover/castigo por modelo trata isso.

    state.requestTimestamps.push(timestamp);
    if (modelLimitsFor(key)) setDailyCount(state.apiKey, key, dailyCount(state.apiKey, key, timestamp) + 1, timestamp);
    const totalRequestsThisMinute = totalRequests(timestamp);
    const usageEvent = {
      apiNumber: chosenIndex + 1,
      requestsThisMinute: state.requestTimestamps.length,
      totalRequestsThisMinute,
      timestamp
    };
    usageListeners.forEach((listener) => {
      try {
        listener(usageEvent);
      } catch {
        // Observadores de interface nao podem interromper o encaminhamento.
      }
    });
    emitRequestLog({
      type: 'called',
      apiNumber: usageEvent.apiNumber,
      requestsThisMinute: usageEvent.requestsThisMinute,
      totalRequestsThisMinute,
      timestamp
    });
    return {
      apiKey: state.apiKey,
      apiNumber: usageEvent.apiNumber,
      requestsThisMinute: state.requestTimestamps.length,
      remainingThisMinute: Math.max(0, UPSTREAM_RPM_LIMIT - state.requestTimestamps.length)
    };
  }
}

export function getRuntimeStatus(timestamp = Date.now()) {
  const apiUsage = apiKeyStates.map((state, index) => {
    const requestsThisMinute = activeRequests(state, timestamp); // ja poda janela/castigos
    // Uma entrada por modelo de castigo ativo: a mesma API aparece varias vezes na
    // tela de castigo se estiver de castigo em mais de um modelo.
    const penalties = activePenalties(state, timestamp);
    const resting = penalties.length > 0;
    // Para o card resumido, usa o castigo que termina por ultimo.
    const latest = penalties[penalties.length - 1];
    // Contagem viva de 200 por modelo + total da chave (soma de todos os modelos).
    const successCounts = successCountRows(state);
    const successTotal = successCounts.reduce((sum, row) => sum + row.count, 0);
    return {
      apiNumber: index + 1,
      requestsThisMinute,
      limitPerMinute: UPSTREAM_RPM_LIMIT,
      windowStartedAt: state.requestTimestamps[0] || null,
      resetsAt: nextResetAt(state, timestamp),
      resting,
      penalties,
      penaltyUntil: resting ? latest.penaltyUntil : null,
      penaltyStartedAt: resting ? latest.penaltyStartedAt : null,
      successCounts,
      successTotal,
      daily: dailyRows(state, timestamp)
    };
  });
  // Soma por modelo em todas as chaves: "usado hoje / (limite x chaves)".
  const modelDaily: Record<string, { used: number; limit: number | null; exhaustedKeys: number }> = {};
  for (const row of apiUsage) {
    for (const d of row.daily) {
      const entry = modelDaily[d.model] || { used: 0, limit: d.limit === null ? null : d.limit * apiKeyStates.length, exhaustedKeys: 0 };
      entry.used += d.used;
      if (d.exhausted) entry.exhaustedKeys++;
      modelDaily[d.model] = entry;
    }
  }
  const requestsThisMinute = totalRequests(timestamp);
  return {
    keyCount: apiKeyStates.length,
    port: currentPort,
    unlocked: apiKeyStates.length > 0,
    requestDelayMs,
    selectedModel: getSelectedModel(),
    autoToggle,
    modelPriority: modelPriority.slice(),
    activeModel: getActiveModel(),
    deactivatedModelIds: [...deactivatedIds],
    requestsThisMinute,
    capacityPerMinute: apiKeyStates.length * UPSTREAM_RPM_LIMIT,
    limitPerKey: UPSTREAM_RPM_LIMIT,
    apiUsage,
    modelDaily,
    dailyResetsAt: timestamp + msUntilNextPacificMidnight(timestamp)
  };
}
