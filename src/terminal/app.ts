import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app as honoApp } from '../index.ts';
import { TEST_PROMPT } from '../desktop/testPrompt.ts';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_AUTO_TOGGLE,
  DEFAULT_DEACTIVATED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_MODEL_PRIORITY,
  DEFAULT_PORT,
  INTERNAL_API_KEY,
  UPSTREAM_RPM_LIMIT,
  REQUEST_DELAY_MS,
  type ModelCatalogEntry,
  DEFAULT_MODEL_PRICES
} from '../config.ts';
import {
  configExists,
  localKeyStored,
  saveConfig,
  unlockConfig,
  type UnlockedConfig
} from '../services/vault.ts';
import {
  clearRuntimeConfig,
  getRuntimeStatus,
  onApiKeyPenalized,
  onApiRequestLog,
  pruneApiRequestLogs,
  setRuntimeConfig,
  type ApiRequestLogEvent
} from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';
import { getLocale, getMessages, initLocale, setLocale, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import {
  appDir,
  configPath,
  loadPenalties,
  localePath,
  penaltiesPath,
  savePenalties
} from './paths.ts';
import {
  bar,
  box,
  boxDivider,
  c,
  centerVisible,
  logo,
  padEndVisible,
  screen,
  statusBadge,
  visibleLength
} from './theme.ts';
import {
  confirm,
  drawFrame,
  field,
  getSize,
  pause,
  promptText,
  readKey,
  selectMenu,
  setKeyHandler,
  startInput,
  stopInput
} from './input.ts';
import {
  claudeSnippet,
  codexConfigToml,
  codexEnv,
  formatCountdown,
  formatElapsed,
  usageMessage
} from './format.ts';
import { copyToClipboard } from './clipboard.ts';
import { readTokenUsage, flushTokenUsage } from '../services/token-tracking.ts';

// ----------------------------------------------------------------------------
// Estado da sessao (espelha o que o main.ts do Electron mantem em memoria).
// ----------------------------------------------------------------------------
type ProxyState = 'locked' | 'starting' | 'running' | 'stopped' | 'error';

let sessionPassword = '';
let unlockedConfig: UnlockedConfig = freshConfig();
let proxyServer: ServerType | null = null;
let proxyState: ProxyState = 'locked';
let proxyError = '';
let usageLog: ApiRequestLogEvent[] = [];

function freshConfig(): UnlockedConfig {
  return {
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
}

// Chave local viva exibida nos snippets de integracao (a definida pelo usuario ou
// a padrao do config).
function localKey(): string {
  return (unlockedConfig.localApiKey && unlockedConfig.localApiKey.trim())
    ? unlockedConfig.localApiKey.trim()
    : INTERNAL_API_KEY;
}

function refreshRuntime(): void {
  setRuntimeConfig(unlockedConfig);
}

function baseUrl(): string {
  return `http://localhost:${unlockedConfig.port}`;
}

// ----------------------------------------------------------------------------
// Catalogo / prioridade: saneamento identico ao desktop.
// ----------------------------------------------------------------------------
function sanitizeCatalog(value: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    const model = String(raw.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    catalog.push({
      model,
      label: String(raw.label || '').trim() || model,
      icon: String(raw.icon || '').trim()
    });
  }
  return catalog.length ? catalog : unlockedConfig.modelCatalog;
}

function sanitizePriority(value: string[], catalog: ModelCatalogEntry[]): string[] {
  const known = new Set(catalog.map((item) => item.model));
  const priority: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const model = String(raw || '').trim();
    if (model && known.has(model) && !seen.has(model)) {
      seen.add(model);
      priority.push(model);
    }
  }
  for (const item of catalog) {
    if (!seen.has(item.model)) {
      seen.add(item.model);
      priority.push(item.model);
    }
  }
  return priority;
}

// Saneia o catalogo de modelos desativados: similar ao sanitizeCatalog, mas vazio
// e valido. Preenche precos padrao quando ausentes.
function sanitizeDeactivatedCatalog(value: ModelCatalogEntry[]): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    const model = String(raw.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const defPrices = DEFAULT_MODEL_PRICES[model];
    catalog.push({
      model,
      label: String(raw.label || '').trim() || model,
      icon: String(raw.icon || '').trim(),
      inputPrice: typeof raw.inputPrice === 'number' && Number.isFinite(raw.inputPrice) && raw.inputPrice >= 0
        ? raw.inputPrice
        : (defPrices ? defPrices.input : undefined),
      outputPrice: typeof raw.outputPrice === 'number' && Number.isFinite(raw.outputPrice) && raw.outputPrice >= 0
        ? raw.outputPrice
        : (defPrices ? defPrices.output : undefined)
    });
  }
  return catalog;
}

// Entradas do catalogo na ordem da lista de prioridades.
function orderedEntries(): ModelCatalogEntry[] {
  const byId = new Map(unlockedConfig.modelCatalog.map((entry) => [entry.model, entry]));
  const ordered: ModelCatalogEntry[] = [];
  for (const id of unlockedConfig.modelPriority) {
    const entry = byId.get(id);
    if (entry) {
      ordered.push(entry);
      byId.delete(id);
    }
  }
  byId.forEach((entry) => ordered.push(entry));
  return ordered;
}

// Modelo exibido no cabecalho de redirecionamento.
function headlineModel(): string {
  if (unlockedConfig.autoToggle) {
    const ordered = orderedEntries();
    if (ordered.length && ordered[0].model) return ordered[0].model.trim();
  }
  return unlockedConfig.selectedModel.trim() || DEFAULT_MODEL;
}

function labelFor(model: string): string {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  return entry ? entry.label : model;
}

// ----------------------------------------------------------------------------
// Persistencia.
// ----------------------------------------------------------------------------
function persistToDisk(): void {
  if (!sessionPassword) return;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
}

// ----------------------------------------------------------------------------
// Servidor (gateway).
// ----------------------------------------------------------------------------
async function startProxy(): Promise<void> {
  if (!sessionPassword) throw new Error(t('error.unlockFirst'));
  if (!unlockedConfig.apiKeys.length) throw new Error(t('error.cadastreFirst'));
  if (proxyServer) return;
  proxyState = 'starting';
  proxyError = '';
  await new Promise<void>((resolve) => {
    let settled = false;
    const server = serve({ fetch: honoApp.fetch, port: unlockedConfig.port }, () => {
      settled = true;
      proxyServer = server;
      proxyState = 'running';
      resolve();
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      proxyServer = null;
      proxyState = 'error';
      proxyError = error.code === 'EADDRINUSE'
        ? t('error.portInUse', { port: String(unlockedConfig.port) })
        : error.message;
      if (!settled) resolve();
    });
  });
}

async function stopProxy(): Promise<void> {
  if (!proxyServer) {
    proxyState = sessionPassword ? 'stopped' : 'locked';
    return;
  }
  const server = proxyServer;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (proxyServer === server) proxyServer = null;
  proxyState = sessionPassword ? 'stopped' : 'locked';
  proxyError = '';
}

// ----------------------------------------------------------------------------
// Layout helpers.
// ----------------------------------------------------------------------------
function innerWidth(): number {
  return Math.min(getSize().cols - 2, 96);
}

// Concatena dois blocos de caixa lado a lado (mesmo numero de linhas).
function twoColumns(left: string[], right: string[], gap = 2): string[] {
  const leftWidth = Math.max(...left.map((line) => visibleLength(line)));
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    out.push(padEndVisible(l, leftWidth) + ' '.repeat(gap) + r);
  }
  return out;
}

// Cabecalho de marca usado em todas as telas.
function brandHeader(): string[] {
  const w = innerWidth();
  const state = statusBadge(proxyState);
  const left = c.accent('▲ ') + c.bold(c.text(APP_NAME)) + ' ' + c.faint(`v${APP_VERSION}`);
  const right = state + c.faint(`  porta ${unlockedConfig.port}`);
  const space = Math.max(1, w - visibleLength(left) - visibleLength(right));
  return [
    '',
    ' ' + left + ' '.repeat(space) + right,
    ' ' + c.faint(t('header.subtitle')),
    ''
  ];
}

// Cabecalho compacto para sub-telas (titulo da secao).
function sectionHeader(title: string, subtitle?: string): string[] {
  const lines = brandHeader();
  lines.push(' ' + c.accent('▌ ') + c.bold(c.text(title.toUpperCase())));
  if (subtitle) lines.push(' ' + c.faint('  ' + subtitle));
  lines.push('');
  return lines;
}

// ----------------------------------------------------------------------------
// Dashboard ao vivo.
// ----------------------------------------------------------------------------
function dashboardLines(): string[] {
  const status = getRuntimeStatus();
  const w = innerWidth();
  const colInner = Math.floor((w - 2) / 2);

  // Le os tokens mais recentes para exibir no dashboard
  const tokenUsage = readTokenUsage(tokenUsagePath());
  const totalTokens = tokenUsage.totalInputTokens + tokenUsage.totalOutputTokens;
  let totalSpent = 0;
  // Calcula o custo total baseado nos precos do catalogo (inclui desativados,
  // que ainda contam na contabilidade de tokens e economia).
  for (const entry of [...unlockedConfig.modelCatalog, ...unlockedConfig.deactivatedModels]) {
    const data = tokenUsage.models[entry.model];
    if (!data) continue;
    const defPrices = DEFAULT_MODEL_PRICES[entry.model];
    const inputPrice = typeof entry.inputPrice === 'number' && entry.inputPrice >= 0 ? entry.inputPrice : (defPrices?.input || 0);
    const outputPrice = typeof entry.outputPrice === 'number' && entry.outputPrice >= 0 ? entry.outputPrice : (defPrices?.output || 0);
    totalSpent += calcSavings(data.inputTokens, data.outputTokens, inputPrice, outputPrice);
  }

  // Coluna esquerda: estado do proxy.
  const vaultLabel = sessionPassword ? c.green(t('vault.unlocked')) : c.faint(t('vault.locked'));
  const proxyRows = [
    field(t('dashboard.vault'), vaultLabel, 12),
    field(t('dashboard.port'), c.text(String(unlockedConfig.port)), 12),
    field(t('dashboard.keys'), c.text(String(status.keyCount)), 12),
    field(t('dashboard.spent'), c.text(formatUsd(totalSpent)), 12),
    field(t('dashboard.tokens'), c.text(formatTokens(totalTokens)), 12),
    field(t('dashboard.delay'), c.text(`${unlockedConfig.requestDelayMs} ms`), 12)
  ];

  // Coluna direita: modelo / redirecionamento.
  const headline = headlineModel();
  const modelRows = [
    field(t('dashboard.mode'), unlockedConfig.autoToggle ? c.accentStrong(t('dashboard.autoMode')) : c.text(t('dashboard.manualMode')), 12),
    field(t('dashboard.target'), c.accentStrong(headline), 12),
    field(t('dashboard.label'), c.text(labelFor(headline)), 12),
    field(t('dashboard.catalog'), c.text(String(unlockedConfig.modelCatalog.length)), 12),
    field(t('dashboard.inUse'), c.text(status.activeModel || headline), 12),
    field(t('dashboard.client'), c.faint('AgentBridge'), 12)
  ];

  const leftBox = box({ title: t('dashboard.proxy'), lines: proxyRows, innerWidth: colInner, color: c.faint, titleColor: c.accent });
  const rightBox = box({ title: t('dashboard.modelTitle'), lines: modelRows, innerWidth: w - 2 - colInner - 2, color: c.faint, titleColor: c.accent });

  const lines = brandHeader();
  lines.push(...twoColumns(leftBox, rightBox).map((line) => ' ' + line));
  lines.push('');

  // Log ao vivo.
  const size = getSize();
  const reserved = lines.length + 6; // bordas do log + rodape
  const logHeight = Math.max(4, Math.min(14, size.rows - reserved));
  const logs = pruneApiRequestLogs(usageLog);
  const tail = logs.slice(-logHeight);
  const logRows = tail.length
    ? tail.map((entry) => {
        const time = c.faint(new Date(entry.timestamp).toLocaleTimeString(getLocale()));
        return `${time} ${usageMessage(entry)}`;
      })
    : [c.faint(t('dashboard.waitingRequest'))];
  // Preenche ate a altura fixa para a caixa nao "pular".
  while (logRows.length < logHeight) logRows.push('');
  const rpmLabel = c.accentStrong(`${status.requestsThisMinute}/${status.capacityPerMinute} RPM`);
  lines.push(...box({
    title: t('dashboard.logTitle') + '   ' + rpmLabel,
    lines: logRows,
    innerWidth: w,
    color: c.faint,
    titleColor: c.accent
  }).map((line) => ' ' + line));

  // Mensagem de contexto + atalhos.
  lines.push('');
  const penaltyCount = countPenalties(status);
  const hint = proxyState === 'error'
    ? c.red('  ' + proxyError)
    : !status.keyCount
      ? c.amber('  ' + t('dashboard.cadastreApis'))
      : proxyState === 'running'
        ? c.green('  ' + t('dashboard.gatewayReady'))
        : c.muted('  ' + t('dashboard.pressToStart'));
  lines.push(hint);
  lines.push(hotkeyBar(penaltyCount));
  return lines;
}

function hotkeyBar(penaltyCount: number): string {
  const key = (label: string, desc: string) => c.accent(label) + c.faint(' ' + desc);
  const castigo = penaltyCount > 0
    ? c.accent('C') + c.amber(' ' + t('hotkey.penalties') + '(' + penaltyCount + ')')
    : key('C', t('hotkey.penalties'));
  return '  ' + [
    proxyServer ? c.accent('S') + c.faint(' ' + t('hotkey.stop')) : key('S', t('hotkey.start')),
    key('A', t('hotkey.apis')),
    key('M', t('hotkey.models')),
    key('V', t('hotkey.deactivated')),
    key('B', t('hotkey.tokens')),
    castigo,
    key('P', t('hotkey.port')),
    key('D', t('hotkey.delay')),
    key('K', t('hotkey.key')),
    key('I', t('hotkey.integration')),
    key('T', t('hotkey.locale')),
    key('L', t('hotkey.clear')),
    key('Q', t('hotkey.quit'))
  ].join(c.faint(' · '));
}

function countPenalties(status: ReturnType<typeof getRuntimeStatus>): number {
  let count = 0;
  for (const item of status.apiUsage as Array<{ penalties?: unknown[] }>) {
    count += (item.penalties || []).length;
  }
  return count;
}

// Loop do dashboard: re-renderiza a cada segundo e reage aos atalhos.
async function dashboardLoop(): Promise<void> {
  while (true) {
    const action = await new Promise<string>((resolve) => {
      const render = () => drawFrame(dashboardLines());
      render();
      const timer = setInterval(render, 1000);
      setKeyHandler((keyEvent) => {
        const key = (keyEvent.str || '').toLowerCase();
        const map: Record<string, string> = {
          s: 'toggle', a: 'apis', m: 'models', c: 'penalties', b: 'tokens',
          p: 'port', d: 'delay', k: 'localkey', i: 'integration', t: 'locale', l: 'clear', v: 'deactivated', q: 'quit'
        };
        const resolved = map[key];
        if (!resolved) return;
        clearInterval(timer);
        setKeyHandler(null);
        resolve(resolved);
      });
    });

    if (action === 'quit') {
      const ok = await confirm({
        header: sectionHeader(t('quit.title'), t('quit.subtitle')),
        question: t('quit.question'),
        defaultYes: true
      });
      if (ok) return;
      continue;
    }
    await handleAction(action);
  }
}

async function handleAction(action: string): Promise<void> {
  try {
    switch (action) {
      case 'toggle':
        if (proxyServer) await stopProxy();
        else await startProxy();
        break;
      case 'apis': await apisScreen(); break;
      case 'models': await modelsScreen(); break;
      case 'deactivated': await deactivatedModelsScreen(); break;
      case 'tokens': await tokensScreen(); break;
      case 'penalties': await penaltiesScreen(); break;
      case 'port': await portScreen(); break;
      case 'delay': await delayScreen(); break;
      case 'localkey': await localKeyScreen(); break;
      case 'integration': await integrationScreen(); break;
      case 'locale': await localeScreen(); break;
      case 'clear': usageLog = []; break;
    }
  } catch (error) {
    await pause({
      lines: sectionHeader(t('error.generic'), '').concat('  ' + c.red(error instanceof Error ? error.message : String(error)))
    });
  }
}

// ----------------------------------------------------------------------------
// Tela: APIs (cadastro/edicao das chaves criptografadas).
// ----------------------------------------------------------------------------
function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 2) + '…';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

async function apisScreen(): Promise<void> {
  while (true) {
    const header = sectionHeader(
      t('apis.title'),
      t('apis.subtitle', { path: configPath() })
    );
    const items = unlockedConfig.apiKeys.map((key, i) => ({
      label: `${t('apis.api')} ${i + 1}  ${c.faint(maskKey(key))}`,
      value: `edit:${i}`,
      hint: ''
    }));
    items.push({ label: c.accent(t('apis.add')), value: 'add', hint: '' });
    if (unlockedConfig.apiKeys.length) {
      items.push({ label: t('apis.save'), value: 'save', hint: c.faint(t('apis.nKeys', { count: String(unlockedConfig.apiKeys.length) })) });
      items.push({ label: t('apis.export'), value: 'export', hint: c.faint(t('apis.exportFile') + ' ' + path.join(appDir(), 'api_keys.txt')) });
    }
    items.push({ label: c.muted(t('apis.back')), value: 'back', hint: '' });

    const choice = await selectMenu({
      header: header.concat(
        '  ' + c.faint(t('apis.hint'))
      ),
      items
    });
    if (!choice || choice === 'back') return;

    if (choice === 'add') {
      const value = await promptText({
        header: sectionHeader(t('apis.addTitle'), t('apis.addPrompt')),
        label: t('apis.apiKeyLabel'),
        mask: true,
        placeholder: 'AQ.... (auth key)',
        validate: (v) => (/^\S{20,}$/.test(v.trim()) ? null : t('apis.mustStartWith'))
      });
      if (value && value.trim()) {
        unlockedConfig.apiKeys.push(value.trim());
        refreshRuntime();
      }
      continue;
    }

    if (choice === 'save') {
      persistToDisk();
      refreshRuntime();
      savePenalties(unlockedConfig.apiKeys);
      await pause({
        lines: sectionHeader(t('apis.save'), '').concat(
          '  ' + c.green(t('apis.saved', { count: String(unlockedConfig.apiKeys.length) })),
          '  ' + c.faint(configPath())
        )
      });
      continue;
    }

    if (choice === 'export') {
      await exportApis();
      continue;
    }

    if (choice.startsWith('edit:')) {
      const idx = Number(choice.slice(5));
      const action = await selectMenu({
        header: sectionHeader(`${t('apis.api')} ${idx + 1}`, maskKey(unlockedConfig.apiKeys[idx] || '')),
        items: [
          { label: t('apis.replace'), value: 'replace' },
          { label: c.red(t('apis.remove')), value: 'remove' },
          { label: c.muted(t('apis.back')), value: 'back' }
        ]
      });
      if (action === 'replace') {
        const value = await promptText({
          header: sectionHeader(t('apis.replaceTitle'), ''),
          label: t('apis.newKeyLabel'),
          mask: true,
          placeholder: 'AQ.... (auth key)',
          validate: (v) => (/^\S{20,}$/.test(v.trim()) ? null : t('apis.mustStartWith'))
        });
        if (value && value.trim()) {
          unlockedConfig.apiKeys[idx] = value.trim();
          refreshRuntime();
        }
      } else if (action === 'remove') {
        unlockedConfig.apiKeys.splice(idx, 1);
        refreshRuntime();
      }
      continue;
    }
  }
}

async function exportApis(): Promise<void> {
  const file = path.join(appDir(), 'api_keys.txt');
  const content = unlockedConfig.apiKeys.join('\n');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  await pause({
    lines: sectionHeader(t('apis.export'), '').concat(
      '  ' + c.green(t('apis.exported')),
      '  ' + c.faint(file)
    )
  });
}

// ----------------------------------------------------------------------------
// Tela: Modelos (selecao, automatico, prioridade, testar, editar).
// ----------------------------------------------------------------------------
async function modelsScreen(): Promise<void> {
  while (true) {
    const ordered = orderedEntries();
    const active = unlockedConfig.autoToggle
      ? (getRuntimeStatus().activeModel || headlineModel())
      : unlockedConfig.selectedModel;

    const header = sectionHeader(
      t('models.title'),
      unlockedConfig.autoToggle
        ? t('models.autoSubtitle')
        : t('models.manualSubtitle')
    );

    const items: Array<{ label: string; value: string; hint?: string }> = [];
    items.push({
      label: (unlockedConfig.autoToggle ? c.accent('◉') : c.faint('◯')) +
        ' ' + t('models.autoToggle') + ' ' +
        (unlockedConfig.autoToggle ? c.accentStrong(t('models.on')) : c.faint(t('models.off'))),
      value: 'auto'
    });
    ordered.forEach((entry, i) => {
      const isActive = entry.model === active;
      const rank = unlockedConfig.autoToggle ? c.accent(`${i + 1}. `) : '';
      const marker = isActive ? c.green('● ') : c.faint('○ ');
      const name = isActive ? c.bold(c.text(entry.label)) : c.text(entry.label);
      items.push({
        label: `${marker}${rank}${name}`,
        value: `model:${entry.model}`,
        hint: c.faint(entry.model)
      });
    });
    items.push({ label: c.accent(t('models.add')), value: 'add' });
    items.push({ label: c.muted(t('models.back')), value: 'back' });

    const choice = await selectMenu({ header, items });
    if (!choice || choice === 'back') return;

    if (choice === 'auto') {
      unlockedConfig.autoToggle = !unlockedConfig.autoToggle;
      refreshRuntime();
      persistToDisk();
      continue;
    }
    if (choice === 'add') {
      await addModelScreen();
      continue;
    }
    if (choice.startsWith('model:')) {
      await modelActionScreen(choice.slice(6));
      continue;
    }
  }
}

async function modelActionScreen(model: string): Promise<void> {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  if (!entry) return;
  const idx = unlockedConfig.modelPriority.indexOf(model);

  const choice = await selectMenu({
    header: sectionHeader(entry.label, model),
    items: [
      { label: t('models.useThis'), value: 'use' },
      { label: t('models.test'), value: 'test', hint: c.faint('') },
      { label: t('models.moveUp'), value: 'up', disabled: idx <= 0 },
      { label: t('models.moveDown'), value: 'down', disabled: idx < 0 || idx >= unlockedConfig.modelPriority.length - 1 },
      { label: t('models.edit'), value: 'edit' },
      { label: t('pricing.edit'), value: 'pricing' },
      { label: c.amber(t('models.deactivate')), value: 'deactivate' },
      { label: c.red(t('models.removeCatalog')), value: 'remove', disabled: unlockedConfig.modelCatalog.length <= 1 },
      { label: c.muted(t('models.back')), value: 'back' }
    ]
  });

  switch (choice) {
    case 'use':
      unlockedConfig.autoToggle = false;
      unlockedConfig.selectedModel = model;
      refreshRuntime();
      persistToDisk();
      break;
    case 'test':
      await testModelScreen(model);
      break;
    case 'up':
    case 'down': {
      const swap = choice === 'up' ? idx - 1 : idx + 1;
      const next = [...unlockedConfig.modelPriority];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      unlockedConfig.modelPriority = sanitizePriority(next, unlockedConfig.modelCatalog);
      refreshRuntime();
      persistToDisk();
      break;
    }
    case 'edit':
      await editModelScreen(model);
      break;
    case 'pricing':
      await pricingScreen(model);
      break;
    case 'deactivate': {
      const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
      if (!entry) break;
      unlockedConfig.modelCatalog = unlockedConfig.modelCatalog.filter((item) => item.model !== model);
      unlockedConfig.modelPriority = unlockedConfig.modelPriority.filter((id) => id !== model);
      unlockedConfig.deactivatedModels = sanitizeDeactivatedCatalog([...unlockedConfig.deactivatedModels, entry]);
      if (unlockedConfig.selectedModel === model) {
        unlockedConfig.selectedModel = unlockedConfig.modelCatalog[0]?.model || DEFAULT_MODEL;
      }
      refreshRuntime();
      persistToDisk();
      break;
    }
    case 'remove': {
      unlockedConfig.modelCatalog = unlockedConfig.modelCatalog.filter((item) => item.model !== model);
      unlockedConfig.modelPriority = sanitizePriority(
        unlockedConfig.modelPriority.filter((id) => id !== model),
        unlockedConfig.modelCatalog
      );
      if (unlockedConfig.selectedModel === model) {
        unlockedConfig.selectedModel = unlockedConfig.modelCatalog[0]?.model || DEFAULT_MODEL;
      }
      refreshRuntime();
      persistToDisk();
      break;
    }
  }
}

async function addModelScreen(): Promise<void> {
  const label = await promptText({
    header: sectionHeader(t('models.addModelTitle'), ''),
    label: t('models.friendlyName'),
    placeholder: t('models.friendlyNamePlaceholder')
  });
  if (label === null) return;
  const model = await promptText({
    header: sectionHeader(t('models.addModelTitle'), label.trim()),
    label: t('models.providerModel'),
    placeholder: t('models.providerModelPlaceholder'),
    validate: (v) => {
      const id = v.trim();
      if (!id) return t('models.mustInformProvider');
      if (unlockedConfig.modelCatalog.some((item) => item.model === id)) return t('models.alreadyExists');
      return null;
    }
  });
  if (model === null) return;
  const catalog = sanitizeCatalog([
    ...unlockedConfig.modelCatalog,
    { label: label.trim() || model.trim(), model: model.trim(), icon: '' }
  ]);
  unlockedConfig.modelCatalog = catalog;
  unlockedConfig.modelPriority = sanitizePriority(unlockedConfig.modelPriority, catalog);
  refreshRuntime();
  persistToDisk();
}

async function editModelScreen(model: string): Promise<void> {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  if (!entry) return;
  const label = await promptText({
    header: sectionHeader(t('models.editModelTitle'), model),
    label: t('models.modelName'),
    initial: entry.label
  });
  if (label === null) return;
  const newId = await promptText({
    header: sectionHeader(t('models.editModelTitle'), label.trim()),
    label: t('models.providerModel'),
    initial: entry.model,
    validate: (v) => {
      const id = v.trim();
      if (!id) return t('models.mustInformProvider');
      if (id !== model && unlockedConfig.modelCatalog.some((item) => item.model === id)) return t('models.alreadyExists');
      return null;
    }
  });
  if (newId === null) return;
  const id = newId.trim();
  unlockedConfig.modelCatalog = unlockedConfig.modelCatalog.map((item) =>
    item.model === model ? { label: label.trim() || id, model: id, icon: item.icon } : item
  );
  unlockedConfig.modelPriority = unlockedConfig.modelPriority.map((p) => (p === model ? id : p));
  if (unlockedConfig.selectedModel === model) unlockedConfig.selectedModel = id;
  unlockedConfig.modelCatalog = sanitizeCatalog(unlockedConfig.modelCatalog);
  unlockedConfig.modelPriority = sanitizePriority(unlockedConfig.modelPriority, unlockedConfig.modelCatalog);
  refreshRuntime();
  persistToDisk();
}

// Testa um modelo enviando o TEST_PROMPT por toda a rotacao e medindo o tempo.
async function testModelScreen(model: string): Promise<void> {
  if (!unlockedConfig.apiKeys.length) {
    await pause({ lines: sectionHeader(t('models.test'), '').concat('  ' + c.amber(t('models.registerFirst'))) });
    return;
  }
  const startedAt = Date.now();
  let done = false;
  const render = () => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    drawFrame(sectionHeader(t('models.test'), model).concat(
      '  ' + c.amber(t('models.testGenerating', { seconds })),
      '',
      c.faint('  ' + t('models.testSubtitle'))
    ));
  };
  render();
  const timer = setInterval(() => { if (!done) render(); }, 100);

  let resultLines: string[];
  try {
    const response = await forwardToNvidia(
      { model, messages: [{ role: 'user', content: TEST_PROMPT }], stream: false },
      fetch
    );
    const elapsed = Date.now() - startedAt;
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      resultLines = ['  ' + c.red(t('models.testFail', { status: String(response.status), elapsed: formatElapsed(elapsed), message: payload?.error?.message || t('models.testNoDetail') }))];
    } else {
      const reply = String(payload?.choices?.[0]?.message?.content || '').trim();
      const tokens = Number(payload?.usage?.total_tokens) || 0;
      resultLines = [
        '  ' + c.green(t('models.testSuccess', { elapsed: formatElapsed(elapsed), tokens: tokens ? t('models.testTokens', { count: String(tokens) }) : '' })),
        ''
      ];
      const snippet = reply.split('\n').slice(0, 18);
      for (const line of snippet) resultLines.push('  ' + c.faint('│ ') + c.text(line));
      if (reply.split('\n').length > 18) resultLines.push('  ' + c.faint('│ ...'));
    }
  } catch (error) {
    resultLines = ['  ' + c.red(t('models.testFailed', { message: error instanceof Error ? error.message : String(error) }))];
  } finally {
    done = true;
    clearInterval(timer);
  }
  await pause({ lines: sectionHeader(t('models.test'), model).concat(resultLines) });
}

// ----------------------------------------------------------------------------
// Tela: Modelos desativados (hotkey V).
// ----------------------------------------------------------------------------
async function deactivatedModelsScreen(): Promise<void> {
  while (true) {
    const header = sectionHeader(
      t('models.deactivatedTitle'),
      t('models.deactivatedSubtitle')
    );

    const items: Array<{ label: string; value: string; hint?: string }> = [];
    if (!unlockedConfig.deactivatedModels.length) {
      await pause({
        lines: header.concat(
          '',
          '  ' + c.faint(t('models.deactivatedEmpty')),
          ''
        )
      });
      return;
    }
    unlockedConfig.deactivatedModels.forEach((entry) => {
      items.push({
        label: c.faint('● ') + c.text(entry.label),
        value: `deactivated:${entry.model}`,
        hint: c.faint(entry.model)
      });
    });
    items.push({ label: c.muted(t('models.back')), value: 'back' });

    const choice = await selectMenu({ header, items });
    if (!choice || choice === 'back') return;

    if (choice.startsWith('deactivated:')) {
      await deactivatedModelActionScreen(choice.slice('deactivated:'.length));
    }
  }
}

async function deactivatedModelActionScreen(model: string): Promise<void> {
  const entry = unlockedConfig.deactivatedModels.find((item) => item.model === model);
  if (!entry) return;

  const choice = await selectMenu({
    header: sectionHeader(entry.label, model),
    items: [
      { label: t('models.edit'), value: 'edit' },
      { label: t('pricing.edit'), value: 'pricing' },
      { label: c.green(t('models.reactivate')), value: 'reactivate' },
      { label: c.red(t('models.removeCatalog')), value: 'remove' },
      { label: c.muted(t('models.back')), value: 'back' }
    ]
  });

  switch (choice) {
    case 'edit':
      await editDeactivatedModelScreen(model);
      break;
    case 'pricing':
      await pricingDeactivatedScreen(model);
      break;
    case 'reactivate': {
      unlockedConfig.deactivatedModels = unlockedConfig.deactivatedModels.filter((item) => item.model !== model);
      unlockedConfig.modelCatalog = sanitizeCatalog([...unlockedConfig.modelCatalog, entry]);
      unlockedConfig.modelPriority = sanitizePriority([...unlockedConfig.modelPriority, model], unlockedConfig.modelCatalog);
      refreshRuntime();
      persistToDisk();
      break;
    }
    case 'remove': {
      unlockedConfig.deactivatedModels = unlockedConfig.deactivatedModels.filter((item) => item.model !== model);
      refreshRuntime();
      persistToDisk();
      break;
    }
  }
}

async function editDeactivatedModelScreen(model: string): Promise<void> {
  const entry = unlockedConfig.deactivatedModels.find((item) => item.model === model);
  if (!entry) return;
  const label = await promptText({
    header: sectionHeader(t('models.editModelTitle'), model),
    label: t('models.modelName'),
    initial: entry.label
  });
  if (label === null) return;
  const newId = await promptText({
    header: sectionHeader(t('models.editModelTitle'), label.trim()),
    label: t('models.providerModel'),
    initial: entry.model,
    validate: (v) => {
      const id = v.trim();
      if (!id) return t('models.mustInformProvider');
      if (id !== model && unlockedConfig.modelCatalog.some((item) => item.model === id)) return t('models.alreadyExists');
      if (id !== model && unlockedConfig.deactivatedModels.some((item) => item.model === id)) return t('models.alreadyExists');
      return null;
    }
  });
  if (newId === null) return;
  const id = newId.trim();
  unlockedConfig.deactivatedModels = sanitizeDeactivatedCatalog(
    unlockedConfig.deactivatedModels.map((item) =>
      item.model === model ? { label: label.trim() || id, model: id, icon: item.icon, inputPrice: item.inputPrice, outputPrice: item.outputPrice } : item
    )
  );
  refreshRuntime();
  persistToDisk();
}

async function pricingDeactivatedScreen(model: string): Promise<void> {
  const entry = unlockedConfig.deactivatedModels.find((m) => m.model === model);
  if (!entry) return;

  const prices = DEFAULT_MODEL_PRICES[entry.model] || { input: 0, output: 0 };
  const curInput = typeof entry.inputPrice === 'number' ? entry.inputPrice : prices.input;
  const curOutput = typeof entry.outputPrice === 'number' ? entry.outputPrice : prices.output;

  const inputValue = await promptText({
    header: sectionHeader(t('pricing.title', { model: entry.label }), ''),
    label: t('pricing.inputPrice'),
    initial: String(curInput),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? null : t('pricing.invalid');
    }
  });
  if (inputValue === null) return;

  const outputValue = await promptText({
    header: sectionHeader(t('pricing.title', { model: entry.label }), ''),
    label: t('pricing.outputPrice'),
    initial: String(curOutput),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? null : t('pricing.invalid');
    }
  });
  if (outputValue === null) return;

  entry.inputPrice = Number(inputValue);
  entry.outputPrice = Number(outputValue);
  unlockedConfig.deactivatedModels = sanitizeDeactivatedCatalog(unlockedConfig.deactivatedModels);
  persistToDisk();
  await pause({
    lines: sectionHeader(t('pricing.title', { model: entry.label }), '').concat(
      '  ' + c.green(t('pricing.saved'))
    )
  });
}

// ----------------------------------------------------------------------------
// Tela: Castigos (429) ao vivo.
// ----------------------------------------------------------------------------
async function penaltiesScreen(): Promise<void> {
  await new Promise<void>((resolve) => {
    const render = () => {
      const status = getRuntimeStatus();
      const now = Date.now();
      const rows: string[] = [];
      (status.apiUsage as Array<{ apiNumber: number; penalties?: Array<{ model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number }> }>)
        .forEach((item) => {
          (item.penalties || []).forEach((penalty) => {
            rows.push(JSON.stringify({ ...penalty, apiNumber: item.apiNumber }));
          });
        });
      const parsed = rows
        .map((r) => JSON.parse(r) as { apiNumber: number; model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number })
        .sort((a, b) => a.penaltyUntil - b.penaltyUntil);

      const header = sectionHeader(t('penalties.title'), t('penalties.subtitle', { path: penaltiesPath() }));
      const w = innerWidth();
      let bodyLines: string[];
      if (!parsed.length) {
        bodyLines = [c.green(t('penalties.none')), '', c.faint(t('penalties.normalRotation'))];
      } else {
        bodyLines = parsed.map((item) => {
          const title = item.model ? `API ${item.apiNumber} · ${item.model}` : `API ${item.apiNumber}`;
          const remaining = item.penaltyUntil - now;
          const countdown = remaining > 0 ? c.amber(formatCountdown(remaining)) : c.green('00:00');
          const requests = c.faint(t('penalties.requests', { count: String(item.successesBefore429 || 0) }));
          const left = padEndVisible(c.text(title), Math.max(16, w - 22));
          return `${left} ${requests}  ${countdown}`;
        });
      }
      drawFrame(header.concat(
        box({ title: t('penalties.title'), lines: bodyLines, innerWidth: w, color: c.faint, titleColor: c.amber }).map((l) => ' ' + l),
        '',
        c.faint('  ' + t('penalties.refreshHint'))
      ));
    };
    render();
    const timer = setInterval(render, 1000);
    setKeyHandler((key) => {
      if (key.name === 'escape' || (key.str || '').toLowerCase() === 'q') {
        clearInterval(timer);
        setKeyHandler(null);
        resolve();
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Tela: Porta.
// ----------------------------------------------------------------------------
async function portScreen(): Promise<void> {
  const value = await promptText({
    header: sectionHeader(t('port.title'), t('port.subtitle')),
    label: t('port.label'),
    initial: String(unlockedConfig.port),
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : t('port.invalid');
    }
  });
  if (value === null) return;
  const wasRunning = Boolean(proxyServer);
  if (wasRunning) await stopProxy();
  unlockedConfig.port = Number(value);
  persistToDisk();
  refreshRuntime();
  if (wasRunning) await startProxy();
}

// ----------------------------------------------------------------------------
// Tela: Delay extra.
// ----------------------------------------------------------------------------
async function delayScreen(): Promise<void> {
  const value = await promptText({
    header: sectionHeader(t('delay.title'), t('delay.subtitle')),
    label: t('delay.label'),
    initial: String(unlockedConfig.requestDelayMs),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 600_000 ? null : t('delay.invalid');
    }
  });
  if (value === null) return;
  unlockedConfig.requestDelayMs = Math.round(Number(value));
  persistToDisk();
  refreshRuntime();
}

// ----------------------------------------------------------------------------
// Tela: Chave local (a que os clientes enviam para usar o proxy).
// ----------------------------------------------------------------------------
async function localKeyScreen(firstTime = false): Promise<void> {
  const subtitle = firstTime
    ? t('localkey.firstTimeSubtitle')
    : t('localkey.changeSubtitle');
  const value = await promptText({
    header: sectionHeader(t('localkey.title'), subtitle),
    label: t('localkey.label'),
    initial: firstTime ? '' : localKey(),
    placeholder: t('localkey.placeholder'),
    validate: (v) => {
      const key = v.trim();
      if (key.length < 4) return t('localkey.tooShort');
      if (/\s/.test(key)) return t('localkey.noSpaces');
      return null;
    }
  });
  if (value === null) return;
  unlockedConfig.localApiKey = value.trim();
  refreshRuntime();
  persistToDisk();
  await pause({
    lines: sectionHeader(t('localkey.saved'), '').concat(
      '  ' + c.green(t('localkey.savedMessage')),
      '  ' + c.faint(t('localkey.updateEnv'))
    )
  });
}

// ----------------------------------------------------------------------------
// Tela: Idioma da interface.
// ----------------------------------------------------------------------------
import { availableLocales } from '../i18n/index.ts';

async function localeScreen(): Promise<void> {
  const current = getLocale();
  const options = availableLocales();
  const items: Array<{ label: string; value: string; hint?: string }> = options.map((opt) => ({
    label: (opt.code === current ? c.accent('● ') : c.faint('○ ')) + opt.flag + '  ' + opt.label,
    value: opt.code
  }));
  items.push({ label: c.muted(t('models.back')), value: 'back' });

  const choice = await selectMenu<string>({
    header: sectionHeader(
      t('locale.title'),
      t('locale.subtitle', { current: options.find((o) => o.code === current)?.label || current })
    ),
    items
  });
  if (!choice || choice === 'back') return;

  setLocale(choice as Locale);
  unlockedConfig.locale = choice as Locale;
  // Persiste locale em arquivo separado (acessivel antes do desbloqueio).
  try {
    const lPath = localePath();
    mkdirSync(path.dirname(lPath), { recursive: true });
    writeFileSync(lPath, choice, 'utf8');
  } catch {
    // Fallback: locale fica so no config criptografado.
  }
  persistToDisk();

  const label = options.find((o) => o.code === choice)?.label || choice;
  await pause({
    lines: sectionHeader(t('locale.title'), '').concat(
      '  ' + c.green(t('locale.changed', { locale: label }))
    )
  });
}

// ----------------------------------------------------------------------------
// Helpers: Tokens e economia.
// ----------------------------------------------------------------------------
function tokenUsagePath(): string {
  return path.join(appDir(), 'used_tokens.json');
}

const MILLION = 1_000_000;

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < MILLION) return (n / 1000).toFixed(1) + 'K';
  return (n / MILLION).toFixed(2) + 'M';
}

function formatUsd(n: number): string {
  return '$' + n.toFixed(4);
}

function calcSavings(inputTokens: number, outputTokens: number, inputPrice: number, outputPrice: number): number {
  return (inputTokens / MILLION) * inputPrice + (outputTokens / MILLION) * outputPrice;
}

// ----------------------------------------------------------------------------
// Tela: Tokens e economia (hotkey B).
// ----------------------------------------------------------------------------
async function tokensScreen(): Promise<void> {
  flushTokenUsage(tokenUsagePath());
  const usage = readTokenUsage(tokenUsagePath());
  const entries = [...unlockedConfig.modelCatalog, ...unlockedConfig.deactivatedModels];

  if (!usage.models || !Object.keys(usage.models).length) {
    await pause({
      lines: sectionHeader(t('tokens.title'), '').concat(
        '',
        '  ' + c.faint(t('tokens.noData')),
        ''
      )
    });
    return;
  }

  let totalSavings = 0;
  const lines: string[] = [];
  for (const entry of entries) {
    const data = usage.models[entry.model];
    if (!data) continue;
    const defPrices = DEFAULT_MODEL_PRICES[entry.model];
    const inputPrice = typeof entry.inputPrice === 'number' && entry.inputPrice >= 0
      ? entry.inputPrice
      : (defPrices ? defPrices.input : 0);
    const outputPrice = typeof entry.outputPrice === 'number' && entry.outputPrice >= 0
      ? entry.outputPrice
      : (defPrices ? defPrices.output : 0);
    const savings = calcSavings(data.inputTokens, data.outputTokens, inputPrice, outputPrice);
    totalSavings += savings;
    const label = c.accent(entry.label);
    const calls = c.faint(`${data.totalCalls} ${t('tokens.calls')}`);
    const totalT = c.text(`${formatTokens(data.inputTokens + data.outputTokens)} tok`);
    const cost = c.green(formatUsd(savings));
    const left = padEndVisible(label, 22);
    const mid = padEndVisible(calls + '  ' + totalT, 30);
    lines.push('  ' + left + mid + cost);
  }

  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  const recentTokens = usage.recentTotalInputTokens + usage.recentTotalOutputTokens;

  const header = sectionHeader(
    t('tokens.title'),
    t('tokens.subtitle', {
      total: formatTokens(totalTokens),
      recent: formatTokens(recentTokens),
      savings: formatUsd(totalSavings)
    })
  );

  const w = innerWidth();
  lines.unshift('');
  const body = box({
    title: t('tokens.perModel'),
    lines,
    innerWidth: w,
    color: c.faint,
    titleColor: c.accent
  });

  await pause({
    lines: header.concat(
      body.map((l) => ' ' + l),
      '',
      '  ' + c.green(t('tokens.totalSavings', { savings: formatUsd(totalSavings) }))
    )
  });
}

// ----------------------------------------------------------------------------
// Tela: Configurar precos de modelo.
// ----------------------------------------------------------------------------
async function pricingScreen(model: string): Promise<void> {
  const entry = unlockedConfig.modelCatalog.find((m) => m.model === model);
  if (!entry) return;

  const prices = DEFAULT_MODEL_PRICES[entry.model] || { input: 0, output: 0 };
  const curInput = typeof entry.inputPrice === 'number' ? entry.inputPrice : prices.input;
  const curOutput = typeof entry.outputPrice === 'number' ? entry.outputPrice : prices.output;

  const inputValue = await promptText({
    header: sectionHeader(t('pricing.title', { model: entry.label }), ''),
    label: t('pricing.inputPrice'),
    initial: String(curInput),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? null : t('pricing.invalid');
    }
  });
  if (inputValue === null) return;

  const outputValue = await promptText({
    header: sectionHeader(t('pricing.title', { model: entry.label }), ''),
    label: t('pricing.outputPrice'),
    initial: String(curOutput),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? null : t('pricing.invalid');
    }
  });
  if (outputValue === null) return;

  entry.inputPrice = Number(inputValue);
  entry.outputPrice = Number(outputValue);
  persistToDisk();
  await pause({
    lines: sectionHeader(t('pricing.title', { model: entry.label }), '').concat(
      '  ' + c.green(t('pricing.saved'))
    )
  });
}

// ----------------------------------------------------------------------------
// Tela: Integracao (snippets Codex / Claude / API direta).
// ----------------------------------------------------------------------------
async function integrationScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader(t('integration.title'), t('integration.subtitle', { url: baseUrl() })),
      items: [
        { label: t('integration.codex'), value: 'codex', hint: c.faint(t('integration.codexDesc')) },
        { label: t('integration.claude'), value: 'claude', hint: c.faint(t('integration.claudeDesc')) },
        { label: t('integration.directApi'), value: 'api', hint: c.faint(t('integration.apiDesc')) },
        { label: t('integration.export'), value: 'export' },
        { label: c.muted(t('integration.back')), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'codex') await codexScreen();
    else if (choice === 'claude') await claudeScreen();
    else if (choice === 'api') await apiDirectScreen();
    else if (choice === 'export') await exportIntegrationFile();
  }
}

// Copia o texto para a area de transferencia e mostra uma confirmacao + o texto
// limpo (sem bordas, para selecao manual com o mouse tambem sair limpa).
async function copyAndShow(title: string, subtitle: string, text: string): Promise<void> {
  const result = await copyToClipboard(text);
  const note =
    result === 'native'
      ? c.green(t('integration.copied'))
      : result === 'osc52'
        ? c.green(t('integration.copiedViaTerminal')) + c.faint('  Se nao colar, selecione abaixo.')
        : c.amber(t('integration.copyFailed'));
  const block = text.split('\n').map((line) => '   ' + c.text(line));
  await pause({ lines: sectionHeader(title, subtitle).concat('  ' + note, '', ...block) });
}

async function codexScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader(t('integration.codex'), t('integration.configTomlDesc')),
      items: [
        { label: t('integration.codexToml'), value: 'toml', hint: c.faint('[model_providers]') },
        { label: t('integration.codexBash'), value: 'bash', hint: c.faint('export AGENTBRIDGE_ALT_API_KEY=...') },
        { label: t('integration.codexPwsh'), value: 'pwsh', hint: c.faint('$env:AGENTBRIDGE_ALT_API_KEY=...') },
        { label: c.muted(t('integration.back')), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'toml') {
      await copyAndShow(t('integration.codexToml'), t('integration.codexTomlDesc'), codexConfigToml(baseUrl()));
    } else if (choice === 'bash') {
      await copyAndShow(t('integration.codexBash'), t('integration.codexBashDesc'), codexEnv(localKey(), 'bash'));
    } else if (choice === 'pwsh') {
      await copyAndShow(t('integration.codexPwsh'), t('integration.codexPwshDesc'), codexEnv(localKey(), 'powershell'));
    }
  }
}

async function claudeScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader(t('integration.claude'), t('integration.chooseShell')),
      items: [
        { label: t('integration.claudeBash'), value: 'bash', hint: c.faint('export ...') },
        { label: t('integration.claudePwsh'), value: 'pwsh', hint: c.faint('$env:...') },
        { label: c.muted(t('integration.back')), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'bash') {
      await copyAndShow(t('integration.claudeBash'), t('integration.claudeBashDesc'), claudeSnippet(baseUrl(), localKey(), 'bash'));
    } else if (choice === 'pwsh') {
      await copyAndShow(t('integration.claudePwsh'), t('integration.claudePwshDesc'), claudeSnippet(baseUrl(), localKey(), 'powershell'));
    }
  }
}

async function apiDirectScreen(): Promise<void> {
  while (true) {
    const entries = [
      { label: t('integration.apiKey'), value: 'key', text: localKey() },
      { label: t('integration.chatCompletions'), value: 'chat', text: `${baseUrl()}/v1/chat/completions` },
      { label: t('integration.responses'), value: 'responses', text: `${baseUrl()}/v1/responses` },
      { label: t('integration.anthropicMessages'), value: 'messages', text: `${baseUrl()}/v1/messages` },
      { label: t('integration.health'), value: 'health', text: `${baseUrl()}/health` },
      { label: t('integration.models'), value: 'models', text: `${baseUrl()}/v1/models` }
    ];
    const choice = await selectMenu({
      header: sectionHeader(t('integration.directApi'), t('integration.enterToCopy')),
      items: [
        ...entries.map((entry) => ({ label: entry.label, value: entry.value, hint: c.faint(entry.text) })),
        { label: c.muted(t('integration.back')), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    const picked = entries.find((entry) => entry.value === choice);
    if (picked) await copyAndShow('API · ' + picked.label, t('integration.copied'), picked.text);
  }
}

async function exportIntegrationFile(): Promise<void> {
  const file = path.join(appDir(), 'integracao.txt');
  const content = [
    t('export.title', { url: baseUrl() }),
    t('export.localKey', { key: localKey() }),
    '',
    t('export.codexSection'),
    codexConfigToml(baseUrl()),
    '',
    '# bash / zsh',
    codexEnv(localKey(), 'bash'),
    '# PowerShell',
    codexEnv(localKey(), 'powershell'),
    '',
    t('export.claudeSectionBash'),
    claudeSnippet(baseUrl(), localKey(), 'bash'),
    '',
    t('export.claudeSectionPwsh'),
    claudeSnippet(baseUrl(), localKey(), 'powershell'),
    '',
    t('export.endpointsSection'),
    `${baseUrl()}/v1/chat/completions`,
    `${baseUrl()}/v1/responses`,
    `${baseUrl()}/v1/messages`,
    `${baseUrl()}/health`
  ].join('\n');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  await pause({ lines: sectionHeader(t('integration.exported'), '').concat('  ' + c.green(t('integration.exported')), '  ' + c.faint(file)) });
}

// ----------------------------------------------------------------------------
// Fluxo de desbloqueio / primeira execucao.
// ----------------------------------------------------------------------------
async function unlockFlow(): Promise<boolean> {
  const splash = () => {
    const w = innerWidth();
    const lines = ['', '', ...logo().map((l) => ' ' + centerVisible(l, w))];
    lines.push('', ' ' + centerVisible(c.faint(`Gemini (AI Studio) gateway · v${APP_VERSION}`), w), '');
    return lines;
  };

  if (configExists(configPath())) {
    let error = '';
    while (true) {
      const password = await promptText({
        header: splash().concat(
          ' ' + centerVisible(c.muted(t('vault.configFound')), innerWidth()),
          ''
        ),
        label: t('vault.enterPassword'),
        mask: true,
        footer: error ? '  ' + c.red(error) : c.faint('  ' + t('vault.enterToUnlock')),
        validate: () => null
      });
      if (password === null) return false;
      try {
        unlockedConfig = unlockConfig(configPath(), password);
        sessionPassword = password;
        usageLog = [];
        // Inicializa o i18n com o locale salvo (ou detecta do SO se ausente).
        initLocale(unlockedConfig.locale);
        refreshRuntime();
        loadPenalties(unlockedConfig.apiKeys);
        proxyState = 'stopped';
        // Sobe o gateway automaticamente, igual ao desktop.
        if (unlockedConfig.apiKeys.length) await startProxy();
        // So pede a chave local quando o config ainda nao guarda uma (config
        // antigo). Depois disso, a tecla K troca quando quiser.
        if (!localKeyStored(configPath())) await localKeyScreen(true);
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : t('vault.incorrectPassword');
      }
    }
  }

  // Primeira execucao: cria senha e segue para o cadastro de APIs.
  await pause({
    lines: splash().concat(
      ' ' + centerVisible(c.amber(t('vault.noConfig')), innerWidth()),
      ' ' + centerVisible(c.faint(t('vault.passwordNeverStored')), innerWidth())
    ),
    footer: c.faint('  ' + t('nav.pressAnyKeyStart'))
  });

  while (true) {
    const password = await promptText({
      header: sectionHeader(t('vault.createVault'), t('vault.choosePassword')),
      label: t('vault.newPassword'),
      mask: true,
      validate: (v) => (v.trim().length >= 4 ? null : t('vault.passwordTooShort'))
    });
    if (password === null) return false;
    const confirmPwd = await promptText({
      header: sectionHeader(t('vault.createVault'), t('vault.confirmPrompt')),
      label: t('vault.confirmPassword'),
      mask: true
    });
    if (confirmPwd === null) return false;
    if (password !== confirmPwd) {
      await pause({ lines: sectionHeader(t('vault.passwordMismatch'), '').concat('  ' + c.red(t('vault.tryAgain'))) });
      continue;
    }
    sessionPassword = password;
    unlockedConfig = freshConfig();
    clearRuntimeConfig();
    // Inicializa o i18n via deteccao automatica do SO (config novo).
    initLocale(null);
    proxyState = 'stopped';
    // Cofre novo: define a chave local antes de cadastrar as APIs.
    await localKeyScreen(true);
    // Cadastro inicial das APIs.
    await apisScreen();
    if (unlockedConfig.apiKeys.length) {
      persistToDisk();
      refreshRuntime();
      await startProxy();
    }
    return true;
  }
}

// ----------------------------------------------------------------------------
// Wiring de eventos do runtime -> log da TUI.
// ----------------------------------------------------------------------------
function wireRuntimeEvents(): void {
  onApiRequestLog((event) => {
    usageLog = pruneApiRequestLogs([...usageLog, event]);
  });
  onApiKeyPenalized(() => {
    savePenalties(unlockedConfig.apiKeys);
  });
}

// ----------------------------------------------------------------------------
// Entrada principal da TUI.
// ----------------------------------------------------------------------------
export async function runTui(): Promise<void> {
  process.stdout.write(screen.altOn);
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    flushTokenUsage(tokenUsagePath());
    proxyServer?.close();
    clearRuntimeConfig();
    stopInput();
    process.stdout.write(screen.showCursor + screen.altOff);
    process.exit(0);
  };
  startInput(cleanup);
  wireRuntimeEvents();

  // Carrega o locale salvo de locale.txt (se existir) para que a tela de
  // desbloqueio apareca no idioma escolhido, antes de desbloquear o cofre.
  try {
    const lPath = localePath();
    if (existsSync(lPath)) {
      const saved = readFileSync(lPath, 'utf8').trim();
      if (saved) initLocale(saved);
    }
  } catch {
    // fallback: detecta do SO (ja e o padrao do initLocale).
  }

  try {
    const unlocked = await unlockFlow();
    if (!unlocked) {
      cleanup();
      return;
    }
    await dashboardLoop();
  } finally {
    cleanup();
  }
}
