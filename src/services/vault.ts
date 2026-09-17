import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_AUTO_TOGGLE,
  DEFAULT_DEACTIVATED_MODELS,
  DEFAULT_LOCALE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MODEL_PRIORITY,
  INTERNAL_API_KEY,
  REQUEST_DELAY_MS,
  type ModelCatalogEntry,
  normalizeReasoningMode,
  type ReasoningMode
} from '../config.ts';

type CipherText = {
  iv: string;
  tag: string;
  data: string;
};

export type EncryptedConfig = {
  version: 1 | 2;
  port: number;
  requestDelayMs?: number;
  rateLimitMode?: 'smooth';
  // Modelo NVIDIA de redirecionamento escolhido no app (texto puro, nao sensivel).
  model?: string;
  // Alternancia automatica de modelo ligada? (texto puro, nao sensivel).
  autoToggle?: boolean;
  // Raciocinio aplicado pelo proxy (texto puro, nao sensivel).
  reasoningMode?: string;
  // Ordem de prioridade do failover automatico (ids "provider/modelo").
  modelPriority?: string[];
  // Catalogo de modelos selecionaveis, incluindo os adicionados/editados pelo usuario.
  modelCatalog?: ModelCatalogEntry[];
  // Catalogo de modelos desativados. Nao podem ser chamados nem listados, mas
  // ainda contam na contabilidade de tokens e economia.
  deactivatedModels?: ModelCatalogEntry[];
  // Chave local que os clientes precisam enviar para usar o proxy. E um segredo,
  // entao fica criptografada igual as chaves NVIDIA. Ausente em configs antigas.
  localApiKey?: CipherText;
  // Idioma da interface (texto puro, nao sensivel). Ausente em configs antigas.
  locale?: string;
  salt: string;
  verifier: CipherText;
  apiKeys: CipherText[];
};

export type UnlockedConfig = {
  port: number;
  requestDelayMs: number;
  apiKeys: string[];
  // Modelo NVIDIA para onde o proxy redireciona toda chamada (modo manual).
  selectedModel: string;
  // Alternancia automatica de modelo: o proxy escolhe sozinho pela lista de prioridades.
  autoToggle: boolean;
  // Raciocinio (thinking) aplicado pelo proxy. Ausente em configs antigas -> 'client'.
  reasoningMode?: ReasoningMode;
  // Ordem de prioridade do failover automatico (ids "provider/modelo").
  modelPriority: string[];
  // Catalogo de modelos selecionaveis exibido no app.
  modelCatalog: ModelCatalogEntry[];
  // Catalogo de modelos desativados: nao sao chamaveis nem listados, mas contam
  // na contabilidade de tokens e economia.
  deactivatedModels: ModelCatalogEntry[];
  // Chave local exigida dos clientes (Codex/Claude/etc.).
  localApiKey: string;
  // Idioma da interface (ex.: 'pt-BR', 'en'). null/undefined -> deteccao automatica.
  locale?: string | null;
};

// Saneia um catalogo vindo do disco: descarta entradas sem `model`, normaliza
// strings e remove ids duplicados (mantendo a primeira ocorrencia).
function normalizeCatalog(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return DEFAULT_MODEL_CATALOG.map((item) => ({ ...item }));
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
  return catalog.length ? catalog : DEFAULT_MODEL_CATALOG.map((item) => ({ ...item }));
}

// Saneia o catalogo de modelos desativados: mesma logica do normalizeCatalog, mas
// vazio e valido (sem fallback para DEFAULT_MODEL_CATALOG). Descarta entradas sem
// `model`, normaliza strings, remove ids duplicados e preenche precos padrao.
function normalizeDeactivatedCatalog(value: unknown): ModelCatalogEntry[] {
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

// Saneia a lista de prioridades: mantem apenas ids que existem no catalogo, sem
// duplicar, e acrescenta no fim qualquer modelo do catalogo que tenha ficado de fora.
function normalizePriority(value: unknown, catalog: ModelCatalogEntry[], deactivated: ModelCatalogEntry[] = []): string[] {
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

const VERIFIER = 'agentbridge-nvidia-v1';

function deriveKey(password: string, salt: Buffer) {
  return scryptSync(password, salt, 32);
}

function encryptValue(value: string, key: Buffer): CipherText {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptValue(value: CipherText, key: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function configExists(filePath: string) {
  return existsSync(filePath);
}

export function unlockConfig(filePath: string, password: string): UnlockedConfig {
  const stored = JSON.parse(readFileSync(filePath, 'utf8')) as EncryptedConfig;
  if (stored.version !== 1 && stored.version !== 2) throw new Error('Versao de configuracao nao suportada.');

  const key = deriveKey(password, Buffer.from(stored.salt, 'base64'));
  const verifier = Buffer.from(decryptValue(stored.verifier, key));
  const expected = Buffer.from(VERIFIER);
  if (verifier.length !== expected.length || !timingSafeEqual(verifier, expected)) {
    throw new Error('Senha incorreta.');
  }

  const modelCatalog = normalizeCatalog(stored.modelCatalog);
  const deactivatedModels = normalizeDeactivatedCatalog(stored.deactivatedModels);
  // Garante que nenhum modelo desativado esteja no catalogo ativo (migracao
  // de configs antigas onde a separacao ainda nao existia).
  const deactivatedIds = new Set(deactivatedModels.map((item) => item.model));
  const activeCatalog = modelCatalog.filter((item) => !deactivatedIds.has(item.model));
  // Configs antigas nao tem localApiKey: caem para a chave padrao do config.
  const localApiKey = stored.localApiKey
    ? (decryptValue(stored.localApiKey, key).trim() || INTERNAL_API_KEY)
    : INTERNAL_API_KEY;
  // Configs antigas nao tem locale: fica null (deteccao automatica no boot).
  const locale = typeof stored.locale === 'string' && stored.locale.trim()
    ? stored.locale.trim()
    : null;
  return {
    port: stored.port,
    requestDelayMs: normalizeRequestDelayMs(stored.requestDelayMs, stored.rateLimitMode),
    apiKeys: stored.apiKeys.map((item) => decryptValue(item, key)),
    selectedModel: stored.model && stored.model.trim() ? stored.model.trim() : DEFAULT_MODEL,
    autoToggle: typeof stored.autoToggle === 'boolean' ? stored.autoToggle : DEFAULT_AUTO_TOGGLE,
    reasoningMode: normalizeReasoningMode(stored.reasoningMode),
    modelCatalog: activeCatalog,
    deactivatedModels,
    modelPriority: normalizePriority(stored.modelPriority, activeCatalog, deactivatedModels),
    localApiKey,
    locale
  };
}

// Diz se o arquivo de config existente JA guarda uma chave local explicita. Usado
// pelos clientes (desktop/terminal) para decidir se pedem ao usuario para definir
// a chave: so quando ainda nao ha nenhuma salva no config.
export function localKeyStored(filePath: string) {
  try {
    if (!existsSync(filePath)) return false;
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as EncryptedConfig;
    return Boolean(stored && stored.localApiKey && stored.localApiKey.data);
  } catch {
    return false;
  }
}

function normalizeRequestDelayMs(value: unknown, rateLimitMode?: 'smooth') {
  if (value === undefined || value === null || value === '') return REQUEST_DELAY_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return REQUEST_DELAY_MS;
  if (rateLimitMode !== 'smooth' && parsed === 2500) return REQUEST_DELAY_MS;
  return Math.round(parsed);
}

export function saveConfig(
  filePath: string,
  password: string,
  config: UnlockedConfig
) {
  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  const modelCatalog = normalizeCatalog(config.modelCatalog);
  const deactivatedModels = normalizeDeactivatedCatalog(config.deactivatedModels);
  const stored: EncryptedConfig = {
    version: 2,
    port: config.port,
    requestDelayMs: normalizeRequestDelayMs(config.requestDelayMs),
    rateLimitMode: 'smooth',
    model: config.selectedModel && config.selectedModel.trim()
      ? config.selectedModel.trim()
      : DEFAULT_MODEL,
    autoToggle: Boolean(config.autoToggle),
    reasoningMode: normalizeReasoningMode(config.reasoningMode),
    modelCatalog,
    deactivatedModels,
    modelPriority: normalizePriority(config.modelPriority, modelCatalog, deactivatedModels),
    localApiKey: encryptValue(
      (config.localApiKey && config.localApiKey.trim()) || INTERNAL_API_KEY,
      key
    ),
    locale: config.locale && config.locale.trim() ? config.locale.trim() : undefined,
    salt: salt.toString('base64'),
    verifier: encryptValue(VERIFIER, key),
    apiKeys: config.apiKeys.map((apiKey) => encryptValue(apiKey, key))
  };

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(stored, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}