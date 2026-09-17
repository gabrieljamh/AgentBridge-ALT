import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { app as electronApp, BrowserWindow, clipboard, ipcMain } from 'electron';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app as honoApp } from '../index.ts';
import { runModelQuiz } from '../services/modelQuiz.ts';
import { autoSaveDailyUsage, loadDailyUsage } from '../services/dailyUsageStore.ts';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_AUTO_TOGGLE,
  DEFAULT_DEACTIVATED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MODEL_PRIORITY,
  DEFAULT_PORT,
  INTERNAL_API_KEY,
  REQUEST_DELAY_MS,
  type ModelCatalogEntry,
  DATA_DIR_NAME
} from '../config.ts';
import {
  configExists,
  localKeyStored,
  saveConfig,
  unlockConfig,
  type UnlockedConfig
} from '../services/vault.ts';
import { flushTokenUsage } from '../services/token-tracking.ts';
import {
  clearRuntimeConfig,
  type ApiRequestLogEvent,
  getActiveModel,
  getLocalApiKey,
  getRuntimeStatus,
  getSelectedModel,
  isAutoToggleEnabled,
  getReasoningMode,
  setReasoningMode,
  isModelDeactivated,
  onApiRequestLog,
  onApiKeyPenalized,
  pruneApiRequestLogs,
  setApiPenaltyUntil,
  setAutoToggle,
  setDeactivatedModels,
  setLocalApiKey,
  setModelPriority,
  setRuntimeConfig,
  setSelectedModel
} from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';
import { extractProviderMessage } from '../services/gemini.ts';
import { getLocale, getMessages, initLocale, setLocale, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let proxyServer: ServerType | null = null;
let statusRefreshTimer: NodeJS.Timeout | null = null;
let proxyState: 'locked' | 'starting' | 'running' | 'stopped' | 'error' = 'locked';
let proxyError = '';
let sessionPassword = '';
let usageLog: ApiRequestLogEvent[] = [];
// false => ainda precisamos pedir ao usuario que defina a chave local (config
// sem chave salva ou cofre recem-criado). true enquanto bloqueado para nao
// piscar o modal antes do desbloqueio.
let localKeyResolved = true;
let unlockedConfig: UnlockedConfig = {
  apiKeys: [],
  port: DEFAULT_PORT,
  requestDelayMs: REQUEST_DELAY_MS,
  selectedModel: DEFAULT_MODEL,
  autoToggle: DEFAULT_AUTO_TOGGLE,
  modelPriority: [...DEFAULT_MODEL_PRIORITY],
  modelCatalog: DEFAULT_MODEL_CATALOG.map((item) => ({ ...item })),
  deactivatedModels: DEFAULT_DEACTIVATED_MODELS.map((item) => ({ ...item })),
  localApiKey: INTERNAL_API_KEY,
  locale: null
};

function configPath() {
  return path.join(electronApp.getPath('documents'), DATA_DIR_NAME, 'config.json');
}

function dailyUsagePath() {
  return path.join(electronApp.getPath('documents'), DATA_DIR_NAME, 'daily_usage.json');
}

function penaltiesPath() {
  return path.join(electronApp.getPath('documents'), DATA_DIR_NAME, 'penalties.json');
}

function localePath() {
  return path.join(electronApp.getPath('documents'), DATA_DIR_NAME, 'locale.txt');
}

// Impressao digital curta da chave (NAO o segredo) para casar o castigo salvo com
// a chave certa mesmo que a ordem das APIs mude entre reinicios.
function keyFingerprint(apiKey: string) {
  return apiKey ? apiKey.slice(-6) : '';
}

type PersistedPenalty = {
  apiNumber: number;
  keyFingerprint: string;
  // Modelo que levou o 429 ('' quando a request nao informou modelo). A mesma
  // chave pode ter varias entradas, uma por modelo de castigo.
  model: string;
  // Quantas respostas HTTP 200 essa (chave, modelo) acumulou ate levar o 429.
  successesBefore429: number;
  enteredAt: string;
  penaltyUntil: string;
};

function savePenalties() {
  try {
    const usage = getRuntimeStatus().apiUsage as Array<{
      apiNumber: number;
      resting?: boolean;
      penalties?: Array<{ model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number }>;
    }>;
    const penalties: PersistedPenalty[] = [];
    for (const item of usage) {
      for (const penalty of item.penalties || []) {
        penalties.push({
          apiNumber: item.apiNumber,
          keyFingerprint: keyFingerprint(unlockedConfig.apiKeys[item.apiNumber - 1] || ''),
          model: penalty.model,
          successesBefore429: Number(penalty.successesBefore429) || 0,
          enteredAt: new Date(penalty.penaltyStartedAt || Date.now()).toISOString(),
          penaltyUntil: new Date(penalty.penaltyUntil).toISOString()
        });
      }
    }
    const filePath = penaltiesPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), penalties }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // Persistir o castigo nao pode derrubar o proxy.
  }
}

// Le penalties.json no arranque: restaura quem ainda esta dentro da 1 hora e
// descarta quem ja passou (hora atual > penaltyUntil).
function loadPenalties() {
  try {
    const filePath = penaltiesPath();
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { penalties?: PersistedPenalty[] };
    const now = Date.now();
    for (const entry of raw.penalties || []) {
      const penaltyUntil = Date.parse(entry.penaltyUntil);
      if (!Number.isFinite(penaltyUntil) || penaltyUntil <= now) continue;
      const enteredAt = Date.parse(entry.enteredAt);
      let apiNumber = unlockedConfig.apiKeys.findIndex(
        (apiKey) => keyFingerprint(apiKey) === entry.keyFingerprint
      ) + 1;
      // Sem impressao digital correspondente, cai para o numero salvo se existir.
      if (apiNumber === 0 && entry.apiNumber >= 1 && entry.apiNumber <= unlockedConfig.apiKeys.length) {
        apiNumber = entry.apiNumber;
      }
      if (apiNumber >= 1) {
        setApiPenaltyUntil(
          apiNumber,
          penaltyUntil,
          Number.isFinite(enteredAt) ? enteredAt : undefined,
          typeof entry.model === 'string' ? entry.model : '',
          Number(entry.successesBefore429) || 0
        );
      }
    }
    // Normaliza o arquivo (remove expirados, atualiza numeros das APIs).
    savePenalties();
  } catch {
    // Arquivo corrompido nao pode travar o desbloqueio.
  }
}

function normalizePort(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(t('error.invalidPort'));
  }
  return parsed;
}

function normalizeDelayMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 600_000) {
    throw new Error(t('error.invalidDelay'));
  }
  return Math.round(parsed);
}

function endpointBase(port = unlockedConfig.port) {
  return `http://localhost:${port}`;
}

function getStatus() {
  usageLog = pruneApiRequestLogs(usageLog);
  const runtime = getRuntimeStatus();
  const baseUrl = endpointBase();
  return {
    proxyState,
    proxyError,
    unlocked: Boolean(sessionPassword),
    hasConfig: configExists(configPath()),
    keyCount: runtime.keyCount,
    requestsThisMinute: runtime.requestsThisMinute,
    capacityPerMinute: runtime.capacityPerMinute,
    limitPerKey: runtime.limitPerKey,
    apiUsage: runtime.apiUsage,
    requestDelayMs: runtime.requestDelayMs,
    usageLog,
    configPath: configPath(),
    penaltyPath: penaltiesPath(),
    port: unlockedConfig.port,
    selectedModel: getSelectedModel(),
    autoToggle: isAutoToggleEnabled(),
    reasoningMode: getReasoningMode(),
    activeModel: getActiveModel(),
    modelPriority: unlockedConfig.modelPriority,
    modelCatalog: unlockedConfig.modelCatalog,
    deactivatedModels: unlockedConfig.deactivatedModels,
    provider: 'Gemini',
    appVersion: APP_VERSION,
    apiKey: getLocalApiKey(),
    // true quando a sessao esta desbloqueada mas ainda nao ha chave local salva
    // no config: a UI pede para o usuario definir uma.
    needLocalKey: Boolean(sessionPassword) && !localKeyResolved,
    codexBaseUrl: `${baseUrl}/v1`,
    claudeBaseUrl: baseUrl,
    responsesEndpoint: `${baseUrl}/v1/responses`,
    messagesEndpoint: `${baseUrl}/v1/messages`,
    chatEndpoint: `${baseUrl}/v1/chat/completions`,
    locale: getLocale(),
    i18n: getMessages()
  };
}

function broadcastStatus() {
  mainWindow?.webContents.send('status:changed', getStatus());
}

function startStatusRefresh() {
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  statusRefreshTimer = setInterval(() => {
    broadcastStatus();
  }, 1000);
}

autoSaveDailyUsage(dailyUsagePath);

onApiKeyPenalized(() => {
  savePenalties();
  broadcastStatus();
});

onApiRequestLog((event) => {
  usageLog = pruneApiRequestLogs([...usageLog, {
    type: event.type,
    apiNumber: event.apiNumber,
    requestsThisMinute: event.requestsThisMinute,
    totalRequestsThisMinute: event.totalRequestsThisMinute,
    delayMs: event.delayMs,
    elapsedMs: event.elapsedMs,
    method: event.method,
    path: event.path,
    status: event.status,
    model: event.model,
    stream: event.stream,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    waitMs: event.waitMs,
    message: event.message,
    totalTokens: event.totalTokens,
    timestamp: event.timestamp
  }]);
  broadcastStatus();
});

async function stopProxy() {
  if (!proxyServer) {
    proxyState = sessionPassword ? 'stopped' : 'locked';
    broadcastStatus();
    return;
  }
  const server = proxyServer;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (proxyServer === server) proxyServer = null;
  proxyState = sessionPassword ? 'stopped' : 'locked';
  proxyError = '';
  broadcastStatus();
}

async function startProxy() {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  if (!unlockedConfig.apiKeys.length) throw new Error(t('error.cadastreFirst'));
  if (proxyServer) return;

  proxyState = 'starting';
  proxyError = '';
  broadcastStatus();

  await new Promise<void>((resolve) => {
    let settled = false;
    const server = serve({
      fetch: honoApp.fetch,
      port: unlockedConfig.port
    }, () => {
      settled = true;
      proxyServer = server;
      proxyState = 'running';
      broadcastStatus();
      resolve();
    });

    server.once('error', (error: NodeJS.ErrnoException) => {
      proxyServer = null;
      proxyState = 'error';
      proxyError = error.code === 'EADDRINUSE'
        ? `A porta ${unlockedConfig.port} ja esta em uso.`
        : error.message;
      broadcastStatus();
      if (!settled) resolve();
    });
  });
}

async function unlock(password: unknown) {
  const normalized = String(password || '');
  if (!normalized) throw new Error(t('vault.enterPassword'));

  // Tenta carregar locale do arquivo separado antes do desbloqueio.
  // So le o arquivo se o i18n ainda nao foi inicializado (primeira chamada).
  try {
    const filePath = localePath();
    if (existsSync(filePath)) {
      const saved = readFileSync(filePath, 'utf8').trim();
      if (saved) initLocale(saved);
    }
  } catch {
    // fallback: usa deteccao do SO.
  }

  if (configExists(configPath())) {
    unlockedConfig = unlockConfig(configPath(), normalized);
    sessionPassword = normalized;
    usageLog = [];
    setRuntimeConfig(unlockedConfig);
    // Inicializa o i18n com o locale salvo no config (ou detecta do SO se ausente).
    initLocale(unlockedConfig.locale);
    // So pede a chave local se o config ainda nao guarda uma (config antigo).
    localKeyResolved = localKeyStored(configPath());
    loadPenalties();
    loadDailyUsage(dailyUsagePath());
    proxyState = 'stopped';
    await startProxy();
  } else {
    sessionPassword = normalized;
    unlockedConfig = {
      apiKeys: [],
      port: DEFAULT_PORT,
      requestDelayMs: REQUEST_DELAY_MS,
      selectedModel: DEFAULT_MODEL,
      autoToggle: DEFAULT_AUTO_TOGGLE,
      modelPriority: [...DEFAULT_MODEL_PRIORITY],
      modelCatalog: DEFAULT_MODEL_CATALOG.map((item) => ({ ...item })),
      deactivatedModels: DEFAULT_DEACTIVATED_MODELS.map((item) => ({ ...item })),
      localApiKey: INTERNAL_API_KEY,
      locale: null
    };
    usageLog = [];
    clearRuntimeConfig();
    // Inicializa o i18n via deteccao automatica do SO (config novo).
    initLocale(null);
    // Cofre novo: ainda nao ha chave local definida, entao a UI vai pedir.
    localKeyResolved = false;
    proxyState = 'stopped';
  }
  broadcastStatus();
  return getStatus();
}

async function persistConfig(input: any) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  const submitted = Array.isArray(input?.apiKeys) ? input.apiKeys : [];
  const apiKeys = submitted
    .map((entry: unknown) => {
      const item = entry && typeof entry === 'object'
        ? entry as { value?: unknown; existingIndex?: unknown }
        : { value: entry, existingIndex: undefined };
      const normalized = String(item.value || '').trim();
      const hasExistingIndex = item.existingIndex !== null && item.existingIndex !== undefined;
      const existingIndex = Number(item.existingIndex);
      return normalized || (
        hasExistingIndex && Number.isInteger(existingIndex) && existingIndex >= 0
          ? unlockedConfig.apiKeys[existingIndex]
          : ''
      );
    })
    .filter(Boolean);
  if (!apiKeys.length) throw new Error(t('error.cadastreFirst'));

  const nextConfig: UnlockedConfig = {
    apiKeys,
    port: normalizePort(input?.port ?? unlockedConfig.port),
    requestDelayMs: normalizeDelayMs(input?.requestDelayMs ?? unlockedConfig.requestDelayMs),
    selectedModel: typeof input?.selectedModel === 'string' && input.selectedModel.trim()
      ? input.selectedModel.trim()
      : unlockedConfig.selectedModel,
    autoToggle: unlockedConfig.autoToggle,
    modelPriority: unlockedConfig.modelPriority,
    modelCatalog: unlockedConfig.modelCatalog,
    deactivatedModels: unlockedConfig.deactivatedModels,
    localApiKey: unlockedConfig.localApiKey,
    locale: unlockedConfig.locale
  };
  const shouldRestart = Boolean(proxyServer) && nextConfig.port !== unlockedConfig.port;
  if (shouldRestart) await stopProxy();

  unlockedConfig = nextConfig;
  saveConfig(configPath(), sessionPassword, unlockedConfig);
  setRuntimeConfig(unlockedConfig);
  savePenalties();
  if (!proxyServer) await startProxy();
  broadcastStatus();
  return getStatus();
}

// Define qual modelo Gemini o proxy usa para TODAS as chamadas. Trocar o modelo
// e a unica forma de "desligar" o anterior: o redirecionamento esta sempre ativo.
// Persistido em texto puro junto com a config.
async function selectModel(model: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  const normalized = String(model || '').trim();
  if (!normalized) throw new Error(t('error.generic'));
  unlockedConfig.selectedModel = normalized;
  setSelectedModel(normalized);
  setRuntimeConfig(unlockedConfig);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Raciocinio (thinking) aplicado pelo proxy em toda chamada. Persistido na config.
async function saveReasoningMode(value: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  unlockedConfig.reasoningMode = setReasoningMode(value);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Liga/desliga a alternancia automatica de modelo. Quando ligada, o proxy escolhe
// sozinho o modelo de cada chamada pela lista de prioridades. Persistido junto da
// config (texto puro).
async function setAutoMode(value: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  unlockedConfig.autoToggle = Boolean(value);
  setAutoToggle(unlockedConfig.autoToggle);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Saneia o catalogo recebido da UI: descarta entradas sem id "provider/modelo",
// normaliza textos e remove ids duplicados (mantendo a primeira ocorrencia).
function sanitizeCatalog(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return unlockedConfig.modelCatalog;
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<ModelCatalogEntry>;
    const model = String(entry.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const defPrices = DEFAULT_MODEL_PRICES[model];
    catalog.push({
      model,
      label: String(entry.label || '').trim() || model,
      icon: String(entry.icon || '').trim(),
      inputPrice: typeof entry.inputPrice === 'number' && Number.isFinite(entry.inputPrice) && entry.inputPrice >= 0
        ? entry.inputPrice
        : (defPrices ? defPrices.input : undefined),
      outputPrice: typeof entry.outputPrice === 'number' && Number.isFinite(entry.outputPrice) && entry.outputPrice >= 0
        ? entry.outputPrice
        : (defPrices ? defPrices.output : undefined)
    });
  }
  return catalog.length ? catalog : unlockedConfig.modelCatalog;
}

// Saneia o catalogo de modelos desativados: mesmo mecanismo do sanitizeCatalog,
// mas vazio e valido (sem fallback para DEFAULT_MODEL_CATALOG). Nao elimina
// duplicatas ja tratadas pelo sanitize do catalogo ativo: a interseccao e
// resolvida no caller (ao desativar/reactivar).
function sanitizeDeactivatedCatalog(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<ModelCatalogEntry>;
    const model = String(entry.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const defPrices = DEFAULT_MODEL_PRICES[model];
    catalog.push({
      model,
      label: String(entry.label || '').trim() || model,
      icon: String(entry.icon || '').trim(),
      inputPrice: typeof entry.inputPrice === 'number' && Number.isFinite(entry.inputPrice) && entry.inputPrice >= 0
        ? entry.inputPrice
        : (defPrices ? defPrices.input : undefined),
      outputPrice: typeof entry.outputPrice === 'number' && Number.isFinite(entry.outputPrice) && entry.outputPrice >= 0
        ? entry.outputPrice
        : (defPrices ? defPrices.output : undefined)
    });
  }
  return catalog;
}

// Saneia a prioridade: mantem apenas ids do catalogo, sem duplicar, e acrescenta no
// fim os modelos do catalogo que ficaram de fora (modelos novos entram no fim da fila).
function sanitizePriority(value: unknown, catalog: ModelCatalogEntry[], deactivated: ModelCatalogEntry[] = []): string[] {
  const known = new Set(catalog.map((item) => item.model));
  const deactivatedIds = new Set(deactivated.map((item) => item.model));
  const priority: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const model = String(raw || '').trim();
      if (model && known.has(model) && !seen.has(model) && !deactivatedIds.has(model)) {
        seen.add(model);
        priority.push(model);
      }
    }
  }
  for (const item of catalog) {
    if (!seen.has(item.model) && !deactivatedIds.has(item.model)) {
      seen.add(item.model);
      priority.push(item.model);
    }
  }
  return priority;
}

// Atualiza o catalogo de modelos (editar id/nome, adicionar novos) e a ordem da
// lista de prioridades de uma vez so. Persistido junto da config.
async function updateModels(payload: any) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  const catalog = sanitizeCatalog(payload?.catalog);
  const deactivated = sanitizeDeactivatedCatalog(payload?.deactivated ?? unlockedConfig.deactivatedModels);
  // Garante que nao ha interseccao entre catalogo ativo e desativado.
  const deactivatedIds = new Set(deactivated.map((item) => item.model));
  const activeCatalog = catalog.filter((item) => !deactivatedIds.has(item.model));
  const priority = sanitizePriority(payload?.priority, activeCatalog, deactivated);
  unlockedConfig.modelCatalog = activeCatalog;
  unlockedConfig.deactivatedModels = deactivated;
  unlockedConfig.modelPriority = priority;
  setModelPriority(priority);
  setDeactivatedModels(deactivated);
  // Se o modelo selecionado acabou de ser desativado, troca para um ativo.
  if (deactivatedIds.has(unlockedConfig.selectedModel)) {
    unlockedConfig.selectedModel = activeCatalog[0]?.model || DEFAULT_MODEL;
  }
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  setRuntimeConfig(unlockedConfig);
  broadcastStatus();
  return getStatus();
}

// Botao "Testar": roda o quiz rapido (src/services/modelQuiz.ts) no modelo do card,
// passando por toda a rotacao de chaves. NAO usa o redirecionamento.
async function testModel(model: unknown) {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) throw new Error('Modelo invalido.');
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  if (!unlockedConfig.apiKeys.length) throw new Error(t('error.cadastreFirst'));
  return runModelQuiz(normalizedModel, (body) => forwardToNvidia(body, fetch), extractProviderMessage);
}

async function saveDelay(value: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  unlockedConfig.requestDelayMs = normalizeDelayMs(value);
  setRuntimeConfig(unlockedConfig);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

async function savePort(value: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  const port = normalizePort(value);
  const wasRunning = Boolean(proxyServer);
  if (wasRunning) await stopProxy();
  unlockedConfig.port = port;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
    setRuntimeConfig(unlockedConfig);
  }
  if (wasRunning) await startProxy();
  broadcastStatus();
  return getStatus();
}

// Troca a chave local exigida dos clientes. Persistida criptografada junto da
// config. Pode ser chamada a qualquer momento pelo botao da UI, ou no primeiro
// desbloqueio quando o config ainda nao tem chave.
async function saveLocalKey(value: unknown) {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  const normalized = String(value || '').trim();
  if (normalized.length < 4) throw new Error(t('error.localKeyTooShort'));
  if (/\s/.test(normalized)) throw new Error(t('error.localKeySpaces'));
  unlockedConfig.localApiKey = normalized;
  setLocalApiKey(normalized);
  setRuntimeConfig(unlockedConfig);
  localKeyResolved = true;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

function registerIpc() {
  ipcMain.handle('status:get', () => getStatus());
  ipcMain.handle('vault:unlock', (_event, password) => unlock(password));
  ipcMain.handle('config:save', (_event, config) => persistConfig(config));
  ipcMain.handle('localKey:save', (_event, value) => saveLocalKey(value));
  ipcMain.handle('proxy:start', async () => {
    await startProxy();
    return getStatus();
  });
  ipcMain.handle('proxy:stop', async () => {
    await stopProxy();
    return getStatus();
  });
  ipcMain.handle('port:save', (_event, value) => savePort(value));
  ipcMain.handle('delay:save', (_event, value) => saveDelay(value));
  ipcMain.handle('model:select', (_event, model) => selectModel(model));
  ipcMain.handle('model:test', (_event, model) => testModel(model));
  ipcMain.handle('model:setAuto', (_event, value) => setAutoMode(value));
  ipcMain.handle('reasoning:set', (_event, value) => saveReasoningMode(value));
  ipcMain.handle('models:update', (_event, payload) => updateModels(payload));
  ipcMain.handle('clipboard:copy', (_event, value: string) => {
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle('locale:set', (_event, locale: string) => {
    setLocale(locale as Locale);
    unlockedConfig.locale = locale as Locale;
    // Persiste locale em arquivo separado (acessivel antes do desbloqueio).
    try {
      const filePath = localePath();
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, locale, 'utf8');
    } catch {
      // Fallback: locale fica so no config criptografado.
    }
    if (unlockedConfig.apiKeys.length) {
      saveConfig(configPath(), sessionPassword, unlockedConfig);
    }
    broadcastStatus();
    return getStatus();
  });
  ipcMain.handle('locale:getMessages', () => getMessages());
  ipcMain.handle('export:apis', () => {
    if (!sessionPassword) return { ok: false, error: t('error.unlockFirst') };
    try {
      const dir = path.join(electronApp.getPath('documents'), DATA_DIR_NAME);
      const file = path.join(dir, 'api_keys.txt');
      const content = unlockedConfig.apiKeys.join('\n');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, content, 'utf8');
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 820,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#090b10',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastStatus();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

electronApp.setName(APP_NAME);
function tokenUsagePath() {
  return path.join(electronApp.getPath('documents'), DATA_DIR_NAME, 'used_tokens.json');
}

electronApp.on('before-quit', () => {
  flushTokenUsage(tokenUsagePath());
  sessionPassword = '';
  usageLog = [];
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  clearRuntimeConfig();
  proxyServer?.close();
});

electronApp.whenReady().then(() => {
  // Carrega o locale salvo de locale.txt (se existir) ANTES de exibir a UI.
  // Assim a tela de desbloqueio ja aparece no idioma escolhido.
  try {
    const lPath = localePath();
    if (existsSync(lPath)) {
      const saved = readFileSync(lPath, 'utf8').trim();
      if (saved) initLocale(saved);
    }
  } catch {
    // Fallback: detecta do SO (ja e o padrao do initLocale).
  }
  registerIpc();
  startStatusRefresh();
  createMainWindow();
});

electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') electronApp.quit();
});

electronApp.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
