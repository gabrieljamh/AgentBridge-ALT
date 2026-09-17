const previewStatus = {
  proxyState: 'locked',
  unlocked: false,
  hasConfig: false,
  keyCount: 0,
  requestsThisMinute: 0,
  capacityPerMinute: 0,
  limitPerKey: 35,
  requestDelayMs: 0,
  apiUsage: [],
  usageLog: [],
  port: 3001,
  selectedModel: 'gemini-3.8-flash',
  autoToggle: false,
  activeModel: 'gemini-3.8-flash',
  modelCatalog: Array.isArray(window.agentBridgeModels)
    ? window.agentBridgeModels.map((item) => ({ label: item.label, model: item.model, icon: item.key }))
    : [],
  modelPriority: Array.isArray(window.agentBridgeModels)
    ? window.agentBridgeModels.map((item) => item.model)
    : [],
  provider: 'Gemini',
  appVersion: '4.5.0',
  apiKey: 'EuAmoORyo',
  needLocalKey: false,
  codexBaseUrl: 'http://localhost:3001/v1',
  claudeBaseUrl: 'http://localhost:3001',
  responsesEndpoint: 'http://localhost:3001/v1/responses',
  messagesEndpoint: 'http://localhost:3001/v1/messages',
  chatEndpoint: 'http://localhost:3001/v1/chat/completions',
  configPath: 'Documentos\\AgentBridge\\config.json',
  penaltyPath: 'Documentos\\AgentBridge\\penalties.json',
  locale: 'pt-BR',
  i18n: {}
};
const bridge = window.agentBridge || {
  getStatus: async () => previewStatus,
  unlock: async () => ({ ...previewStatus, unlocked: true, proxyState: 'stopped' }),
  saveConfig: async () => ({ ...previewStatus, unlocked: true, keyCount: 3, proxyState: 'running' }),
  saveLocalKey: async (value) => ({ ...previewStatus, apiKey: value, needLocalKey: false }),
  startProxy: async () => ({ ...previewStatus, unlocked: true, proxyState: 'running' }),
  stopProxy: async () => ({ ...previewStatus, unlocked: true, proxyState: 'stopped' }),
  savePort: async () => previewStatus,
  saveDelay: async () => previewStatus,
  selectModel: async (model) => ({ ...previewStatus, selectedModel: model }),
  testModel: async () => ({ ok: false, error: 'Unavailable in preview mode.' }),
  setAutoToggle: async (value) => ({ ...previewStatus, autoToggle: Boolean(value) }),
  updateModels: async (payload) => ({
    ...previewStatus,
    modelCatalog: (payload && payload.catalog) || previewStatus.modelCatalog,
    modelPriority: (payload && payload.priority) || previewStatus.modelPriority
  }),
  setLocale: async (locale) => {
    previewStatus.locale = locale;
    return previewStatus;
  },
  copy: async () => true,
  onStatus: () => () => {}
};

// Helper: traduz usando o dicionario injetado no status.
// O fallback e a chave crua (para preview/bridge simulado).
function t(key, replacements) {
  const map = (lastStatus && lastStatus.i18n) || {};
  let value = map[key] || key;
  if (replacements) {
    Object.keys(replacements).forEach((k) => {
      value = value.replace('{' + k + '}', String(replacements[k]));
    });
  }
  return value;
}
const byId = (id) => document.getElementById(id);
const modelIcons = window.agentBridgeModelIcons;
let lastStatus = previewStatus;

const elements = Object.fromEntries([
  'appVersion', 'proxyStatus', 'vaultStatus', 'vaultDetail',
  'serverStatus', 'rateLimitDetail', 'portInput', 'savePortButton', 'delayInput', 'saveDelayButton', 'configButton', 'startButton',
  'stopButton', 'codexConfig', 'claudeConfig', 'chatValue', 'responsesValue',
  'messagesValue', 'apiKeyValue', 'messageLine', 'unlockModal', 'unlockForm',
  'passwordInput', 'unlockHint', 'unlockError', 'configModal', 'configForm',
  'closeConfigButton', 'apiFields', 'addApiButton', 'exportApisButton',
  'changeKeyButton', 'localKeyModal', 'localKeyForm', 'closeLocalKeyButton',
  'localKeyInput', 'localKeyError', 'localKeyHint',
  'configPathValue', 'configError', 'rpmCounter', 'usageTerminalOutput',
  'penaltyButton', 'penaltyBadge', 'penaltyModal', 'closePenaltyButton', 'penaltyList', 'penaltyPathValue',
  'copyLogButton',
  'selectedModelLabel', 'selectModelButton', 'selectModal', 'closeSelectButton', 'modelGrid',
  'autoToggleSwitch', 'autoToggleHint', 'selectModeHint', 'addModelButton', 'addModelForm',
  'addModelName', 'addModelId', 'addModelError', 'cancelAddModelButton',
  'localeButton', 'localeModal', 'closeLocaleButton', 'localeList', 'localeSourceHint',
  'tokenButton', 'tokenModal', 'closeTokenButton', 'tokenSummary', 'tokenModelList', 'tokenTotalSavings',
  'pricingModal', 'closePricingButton', 'pricingInputInput', 'pricingOutputInput', 'pricingModelLabel',
  'savePricingButton', 'cancelPricingButton',
  'deactivatedModelGrid', 'modelGridPanel', 'deactivatedGridPanel',
  'messageText'
].map((id) => [id, byId(id)]));

function stateLabel(state) {
  return t('status.' + state) || ({ locked: 'Bloqueado', starting: 'Iniciando', running: 'Online', stopped: 'Offline', error: 'Erro' })[state] || 'Offline';
}

function codexSnippet(status) {
  return [
    'model = "AgentBridge"',
    'model_provider = "agentbridge-alt"',
    '',
    '[model_providers.agentbridge-alt]',
    'name = "Gemini via AgentBridge"',
    `base_url = "${status.codexBaseUrl}"`,
    'wire_api = "responses"',
    'env_key = "AGENTBRIDGE_ALT_API_KEY"',
    '',
    '# PowerShell',
    `$env:AGENTBRIDGE_ALT_API_KEY="${status.apiKey}"`
  ].join('\n');
}

function claudeSnippet(status) {
  return [
    '# PowerShell',
    `$env:ANTHROPIC_BASE_URL="${status.claudeBaseUrl}"`,
    `$env:ANTHROPIC_AUTH_TOKEN="${status.apiKey}"`,
    '$env:ANTHROPIC_MODEL="AgentBridge"',
    '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL',
    '$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL',
    '$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL',
    'claude'
  ].join('\n');
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return '';
  const value = Number(milliseconds);
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function clientTarget(entry) {
  const route = entry.path ? `${entry.method || ''} ${entry.path}`.trim() : '';
  return [entry.protocol ? `[${entry.protocol}]` : '', route].filter(Boolean).join(' ');
}

function usageMessage(entry) {
  const target = clientTarget(entry);
  if (entry.type === 'received') return t('log.clientCalled', { target });
  if (entry.type === 'rejected') return t('log.clientRejected', { target, status: String(entry.status), message: entry.message || t('log.invalidKey') });
  if (entry.type === 'completed_client') return t('log.clientReceived', { target, status: String(entry.status), elapsed: formatElapsed(entry.elapsedMs) });
  if (entry.type === 'failed_client') return t('log.proxyError', { target, message: entry.message || t('log.unknownError') });
  if (entry.type === 'rate_limit_wait') return t('log.rateLimitWait', { elapsed: formatElapsed(entry.waitMs) });
  if (entry.type === 'delay') return t('log.delayWait', { elapsed: formatElapsed(entry.delayMs) });
  if (entry.type === 'started') return t('log.apiStarted', { number: String(entry.apiNumber), elapsed: formatElapsed(entry.elapsedMs), model: entry.model ? t('log.modelPrefix', { model: entry.model }) : '' });
  if (entry.type === 'completed') return t('log.apiCompleted', { number: String(entry.apiNumber), elapsed: formatElapsed(entry.elapsedMs), tokens: Number(entry.totalTokens) > 0 ? t('log.apiTokens', { count: String(entry.totalTokens) }) : '' });
  if (entry.type === 'upstream_error') return t('log.upstreamError', { status: String(entry.status), number: String(entry.apiNumber), model: entry.model ? ' (' + entry.model + ')' : '', message: entry.message || t('log.noDetail') });
  if (entry.type === 'cancelled') return t('log.streamCancelled', { number: String(entry.apiNumber), message: entry.message || t('log.clientDisconnected') });
  if (entry.type === 'model_switch') return t('log.modelSwitch', { reason: entry.message ? ' ' + entry.message : '', model: entry.model || '?' });
  if (entry.type === 'error') return t('log.apiError', { number: String(entry.apiNumber || '?'), message: entry.message || t('log.noDetail') });
  return t('log.apiCall', { number: String(entry.apiNumber) });
}

function renderUsageTerminal(status) {
  elements.rpmCounter.textContent =
    `${status.requestsThisMinute}/${status.capacityPerMinute} RPM`;
  const usageLog = Array.isArray(status.usageLog) ? status.usageLog : [];
  if (!usageLog.length) {
    elements.usageTerminalOutput.innerHTML =
      '<div class="terminal-empty">' + t('electron.waitingRequest') + '</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  usageLog.forEach((entry) => {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    const time = document.createElement('span');
    time.className = 'terminal-time';
    const loc = (lastStatus && lastStatus.locale) || 'en';
    time.textContent = new Date(entry.timestamp).toLocaleTimeString(loc);
    const message = document.createElement('span');
    message.textContent = usageMessage(entry);
    const count = document.createElement('span');
    count.className = 'terminal-count';
    count.textContent = Number.isFinite(Number(entry.requestsThisMinute))
      ? `${entry.requestsThisMinute}/${status.limitPerKey}`
      : '';
    line.append(time, message, count);
    fragment.append(line);
  });
  elements.usageTerminalOutput.replaceChildren(fragment);
}

function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const pad = (value) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

// Uma linha por (API, modelo) juntando o uso de hoje (RPD) e os castigos ativos.
// model '*' = chave inteira desativada (chave invalida/sem billing).
function usageRows(status) {
  const rows = new Map();
  const rowFor = (apiNumber, model) => {
    const key = apiNumber + '|' + model;
    if (!rows.has(key)) rows.set(key, { apiNumber, model, used: 0, limit: null, exhausted: false, penaltyUntil: 0, penaltyStartedAt: 0, successesBefore429: 0 });
    return rows.get(key);
  };
  (Array.isArray(status.apiUsage) ? status.apiUsage : []).forEach((item) => {
    (Array.isArray(item.daily) ? item.daily : []).forEach((d) => {
      const row = rowFor(item.apiNumber, d.model || '');
      row.used = Number(d.used) || 0;
      row.limit = d.limit === null || d.limit === undefined ? null : Number(d.limit);
      row.exhausted = Boolean(d.exhausted);
    });
    const penalties = Array.isArray(item.penalties) && item.penalties.length
      ? item.penalties
      : (item.resting && item.penaltyUntil
          ? [{ model: '', penaltyStartedAt: item.penaltyStartedAt, penaltyUntil: item.penaltyUntil }]
          : []);
    penalties.forEach((penalty) => {
      if (!penalty.penaltyUntil) return;
      const row = rowFor(item.apiNumber, penalty.model || '');
      row.penaltyUntil = penalty.penaltyUntil;
      row.penaltyStartedAt = penalty.penaltyStartedAt;
      row.successesBefore429 = Number(penalty.successesBefore429) || 0;
    });
  });
  return [...rows.values()];
}

function rowNeedsAttention(row, now) {
  return row.exhausted || (row.penaltyUntil && row.penaltyUntil > now);
}

function renderPenalties(status) {
  const now = Date.now();
  const rows = usageRows(status);
  const attention = rows.filter((row) => rowNeedsAttention(row, now)).length;
  if (elements.penaltyBadge) {
    elements.penaltyBadge.textContent = String(attention);
    elements.penaltyBadge.classList.toggle('hidden', attention === 0);
  }
  if (elements.penaltyPathValue) {
    elements.penaltyPathValue.textContent = status.penaltyPath || '';
  }
  if (!elements.penaltyList) return;
  if (!rows.length) {
    elements.penaltyList.innerHTML =
      '<div class="terminal-empty">' + t('electron.noPenalty') + '</div>';
    return;
  }
  const locale = (lastStatus && lastStatus.locale) || 'en';
  const resetTime = status.dailyResetsAt
    ? new Date(status.dailyResetsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : '';
  const fragment = document.createDocumentFragment();
  rows
    .slice()
    .sort((a, b) => (Number(rowNeedsAttention(b, now)) - Number(rowNeedsAttention(a, now)))
      || (a.apiNumber - b.apiNumber)
      || a.model.localeCompare(b.model))
    .forEach((item) => {
      const penalized = item.penaltyUntil && item.penaltyUntil > now;
      const row = document.createElement('div');
      row.className = 'penalty-row' + (penalized ? ' penalized' : item.exhausted ? ' exhausted' : '');
      const info = document.createElement('div');
      info.className = 'penalty-info';
      const title = document.createElement('strong');
      const modelName = item.model === '*' ? t('usage.keyDisabled') : item.model;
      title.textContent = modelName ? `API ${item.apiNumber} · ${modelName}` : `API ${item.apiNumber}`;
      info.append(title);
      if (item.used > 0 || item.limit !== null) {
        const usage = document.createElement('span');
        usage.className = 'usage-line';
        usage.textContent = item.limit !== null
          ? t('usage.today', { used: String(item.used), limit: String(item.limit) })
          : t('usage.todayNoLimit', { used: String(item.used) });
        info.append(usage);
        if (item.limit) {
          const barTrack = document.createElement('div');
          barTrack.className = 'usage-bar';
          const fill = document.createElement('span');
          const ratio = Math.min(1, item.used / item.limit);
          fill.style.width = (ratio * 100).toFixed(1) + '%';
          fill.className = ratio >= 1 ? 'full' : ratio >= 0.75 ? 'high' : '';
          barTrack.append(fill);
          info.append(barTrack);
        }
      }
      if (penalized) {
        const sub = document.createElement('span');
        sub.className = 'penalty-sub';
        sub.textContent = item.penaltyStartedAt
          ? t('penalties.enteredAt', { time: new Date(item.penaltyStartedAt).toLocaleTimeString(locale) })
          : t('penalties.after429');
        const successes = document.createElement('span');
        successes.className = 'penalty-successes';
        successes.textContent = t('penalties.requests', { count: String(item.successesBefore429) });
        info.append(sub, successes);
      }
      const state = document.createElement('span');
      if (penalized) {
        state.className = 'penalty-countdown';
        state.textContent = formatCountdown(item.penaltyUntil - now);
      } else if (item.exhausted) {
        state.className = 'usage-state exhausted';
        state.textContent = t('usage.exhausted', { time: resetTime });
      } else {
        state.className = 'usage-state free';
        state.textContent = t('usage.free');
      }
      row.append(info, state);
      fragment.append(row);
    });
  elements.penaltyList.replaceChildren(fragment);
}

function openPenalty() {
  if (!elements.penaltyModal) return;
  renderPenalties(lastStatus);
  elements.penaltyModal.classList.remove('hidden');
}

function buildLogText(status) {
  const logs = Array.isArray(status.usageLog) ? status.usageLog : [];
  if (!logs.length) return '';
  return logs.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString((lastStatus && lastStatus.locale) || 'en');
    const count = Number.isFinite(Number(entry.requestsThisMinute))
      ? ` [${entry.requestsThisMinute}/${status.limitPerKey}]`
      : '';
    return `[${time}] ${usageMessage(entry)}${count}`;
  }).join('\n');
}

function renderStatus(status) {
  lastStatus = status;
  const state = status.proxyState || 'stopped';
  elements.appVersion.textContent = `v${status.appVersion}`;
  elements.proxyStatus.className = `status-badge ${state}`;
  elements.proxyStatus.querySelector('.status-text').textContent = stateLabel(state);
  elements.vaultStatus.textContent = status.unlocked ? t('vault.unlocked') : t('vault.locked');
  elements.vaultDetail.textContent = status.unlocked
    ? t('vault.apiInMemory', { count: String(status.keyCount) })
    : t('vault.passwordNeverSaved');
  elements.serverStatus.textContent = (() => {
    if (state === 'error') return t('electron.gatewayFailed');
    if (state === 'running') return t('electron.gatewayOnline', { port: String(status.port) });
    if (state === 'starting') return t('electron.gatewayStarting', { port: String(status.port) });
    if (state === 'stopped') return t('electron.gatewayOffline');
    if (state === 'locked') return t('electron.gatewayWaiting');
    return `${stateLabel(state)} na porta ${status.port}`;
  })();
  elements.rateLimitDetail.textContent = status.keyCount
    ? t('electron.rateLimitRunning', {
        rpm: String(status.requestsThisMinute),
        capacity: String(status.capacityPerMinute),
        limit: String(status.limitPerKey),
        delay: String(status.requestDelayMs)
      })
    : t('electron.rateLimitStopped', {
        limit: String(status.limitPerKey),
        delay: String(status.requestDelayMs ?? 0)
      });
  if (document.activeElement !== elements.portInput) {
    elements.portInput.value = String(status.port);
  }
  if (document.activeElement !== elements.delayInput) {
    elements.delayInput.value = String(status.requestDelayMs ?? 0);
  }
  elements.startButton.disabled = !status.unlocked || !status.keyCount || state === 'running' || state === 'starting';
  elements.stopButton.disabled = state !== 'running';
  elements.configButton.disabled = !status.unlocked;
  elements.codexConfig.textContent = codexSnippet(status);
  elements.claudeConfig.textContent = claudeSnippet(status);
  elements.chatValue.textContent = status.chatEndpoint;
  elements.responsesValue.textContent = status.responsesEndpoint;
  elements.messagesValue.textContent = status.messagesEndpoint;
  elements.apiKeyValue.textContent = status.apiKey;
  elements.configPathValue.textContent = status.configPath;
  if (elements.selectedModelLabel) {
    const active = headlineModelOf(status);
    elements.selectedModelLabel.textContent = status.autoToggle
      ? `${active} · auto`
      : (active || 'gemini-3.8-flash');
  }
  if (elements.selectModelButton) elements.selectModelButton.disabled = !status.unlocked;
  renderModelModal(status);
  renderUsageTerminal(status);
  renderPenalties(status);

  const message = state === 'error'
    ? status.proxyError
    : !status.unlocked
      ? t('electron.enterPasswordHint')
      : !status.keyCount
        ? t('electron.bothApisHint')
        : state === 'running'
          ? t('electron.gatewayReady')
          : t('electron.apisUnlocked');
  elements.messageText.textContent = message;

  // Aplica traducoes a todos os elementos com [data-i18n].
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // Atualiza o hint da fonte do locale.
  if (elements.localeSourceHint) {
    const stored = (status.locale && status.locale !== '') ? 'electron.localeManual' : 'electron.localeDetected';
    elements.localeSourceHint.textContent = t(stored);
  }
}

function addApiField(value = '', existingIndex = null) {
  const row = document.createElement('div');
  row.className = 'api-field-row';
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = existingIndex === null
    ? 'AQ.... (auth key)'
    : `API salva ${existingIndex + 1} - deixe vazio para manter`;
  input.autocomplete = 'off';
  input.value = value;
  if (existingIndex !== null) input.dataset.existingIndex = String(existingIndex);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-api';
  remove.textContent = t('electron.remove');
  remove.addEventListener('click', () => row.remove());
  row.append(input, remove);
  elements.apiFields.append(row);
}

/* ----- Modal de selecao de modelo ----- */
let selectingModel = false;
let busyModels = false; // evita cliques concorrentes em editar/reordenar/adicionar
let modelGridSignature = ''; // so reconstroi o grid quando catalogo/prioridade/modo muda

// Modelo realmente em uso: no modo automatico e o activeModel; no manual, o fixo.
function activeModelOf(status) {
  const value = status.autoToggle ? status.activeModel : status.selectedModel;
  return (value || '').trim();
}

// Modelo exibido no cabecalho "REDIRECIONAMENTO DE MODELO". No modo automatico
// mostramos o PRIMEIRO da lista de prioridade (o alvo que o proxy tentara primeiro),
// e nao o ultimo realmente usado. Assim o cabecalho nao "volta" para o modelo padrao ao
// reiniciar o app, quando o backend ainda nao definiu activeModel por nenhuma
// chamada. No modo manual segue o modelo fixo escolhido.
function headlineModelOf(status) {
  if (status.autoToggle) {
    const ordered = orderedEntries(status);
    if (ordered.length && ordered[0].model) return ordered[0].model.trim();
  }
  return activeModelOf(status);
}

function catalogOf(status) {
  return Array.isArray(status.modelCatalog) ? status.modelCatalog : [];
}

function priorityOf(status) {
  return Array.isArray(status.modelPriority) ? status.modelPriority : [];
}

function deactivatedOf(status) {
  return Array.isArray(status.deactivatedModels) ? status.deactivatedModels : [];
}

// Devolve as entradas do catalogo na ORDEM da lista de prioridades (modelos fora da
// prioridade vao para o fim). E nesta ordem que o grid e desenhado.
function orderedEntries(status) {
  const byId = new Map(catalogOf(status).map((entry) => [entry.model, entry]));
  const ordered = [];
  priorityOf(status).forEach((id) => {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  });
  byId.forEach((entry) => ordered.push(entry));
  return ordered;
}

// Persiste catalogo + prioridade no backend e re-renderiza com o status retornado.
// Mantem o array de desativados inalterado.
async function persistModels(catalog, priority) {
  return persistModelsFull(catalog, priority, deactivatedOf(lastStatus));
}

// Persiste catalogo + prioridade + desativados no backend de uma vez so.
async function persistModelsFull(catalog, priority, deactivated) {
  if (busyModels) return;
  busyModels = true;
  try {
    const status = await bridge.updateModels({ catalog, priority, deactivated });
    renderStatus(status);
  } catch (error) {
    elements.messageText.textContent =
      error?.message || t('error.sentenceCouldNotSave');
  } finally {
    busyModels = false;
  }
}

// Liga o botao de teste de um card ao backend (gera uma calculadora e mede o tempo).
function wireTestButton(test, result, model) {
  test.addEventListener('click', async () => {
    test.disabled = true;
    result.hidden = false;
    result.className = 'model-result pending';
    const startedAt = Date.now();
    const tick = () => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      result.textContent = t('electron.testGenerating', { seconds });
    };
    tick();
    const liveTimer = setInterval(tick, 100);
    try {
      const outcome = await bridge.testModel(model);
      clearInterval(liveTimer);
      if (outcome && outcome.ok) {
        const perfect = outcome.score === outcome.total;
        result.className = 'model-result ' + (perfect ? 'ok' : outcome.score >= outcome.total - 1 ? 'partial' : 'fail');
        result.replaceChildren();
        const head = document.createElement('div');
        head.className = 'model-result-head';
        const status = document.createElement('span');
        const tokenInfo = Number(outcome.totalTokens) > 0
          ? t('electron.testTokens', { count: String(outcome.totalTokens) })
          : '';
        status.textContent = t('electron.testScore', {
          score: String(outcome.score),
          total: String(outcome.total),
          elapsed: formatElapsed(outcome.elapsedMs),
          tokens: tokenInfo
        });
        head.append(status);
        if (outcome.reply) {
          const copyReply = document.createElement('button');
          copyReply.type = 'button';
          copyReply.className = 'model-copy-reply';
          copyReply.textContent = t('electron.copyResponse');
          copyReply.addEventListener('click', async () => {
            await bridge.copy(outcome.reply);
            copyReply.textContent = t('electron.copied');
            copyReply.classList.add('copied');
            setTimeout(() => {
              copyReply.textContent = t('electron.copyResponse');
              copyReply.classList.remove('copied');
            }, 1200);
          });
          head.append(copyReply);
        }
        result.append(head);
        const list = document.createElement('ul');
        list.className = 'model-quiz-checks';
        for (const check of outcome.checks || []) {
          const item = document.createElement('li');
          item.className = check.pass ? 'pass' : 'miss';
          const label = t('quiz.' + check.id);
          item.textContent = (check.pass ? '✓ ' : '✗ ') + label
            + (check.pass ? '' : ' - ' + t('quiz.gotExpected', { got: check.got || '∅', expected: check.expected }));
          list.append(item);
        }
        result.append(list);
      } else {
        result.className = 'model-result fail';
        const elapsed = outcome && outcome.elapsedMs ? ' (' + formatElapsed(outcome.elapsedMs) + ')' : '';
        result.textContent = t('electron.testFailed', { elapsed, error: (outcome && outcome.error) || t('log.noDetail') });
      }
    } catch (error) {
      clearInterval(liveTimer);
      result.className = 'model-result fail';
      result.textContent = t('electron.testFailed', { elapsed: '', error: error?.message || t('log.unknownError') });
    } finally {
      test.disabled = false;
    }
  });
}

// Formulario inline de edicao (nome + provider/modelo) dentro do card.
function buildEditForm(entry, status) {
  const form = document.createElement('form');
  form.className = 'model-edit-form hidden';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'field-label';
  nameLabel.textContent = t('models.modelName');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = entry.label;

  const idLabel = document.createElement('label');
  idLabel.className = 'field-label';
  idLabel.textContent = t('models.providerModel');
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = entry.model;

  const error = document.createElement('div');
  error.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'add-model-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button ghost';
  cancel.textContent = t('electron.cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button primary';
  save.textContent = t('electron.save');
  actions.append(cancel, save);

  form.append(nameLabel, nameInput, idLabel, idInput, error, actions);

  cancel.addEventListener('click', () => form.classList.add('hidden'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const label = nameInput.value.trim();
    const model = idInput.value.trim();
    if (!model) {
      error.textContent = t('models.mustInformProvider');
      return;
    }
    const duplicated = catalogOf(status)
      .some((other) => other.model !== entry.model && other.model === model);
    if (duplicated) {
      error.textContent = t('models.alreadyExists');
      return;
    }
    const catalog = catalogOf(status).map((other) => other.model === entry.model
      ? { label: label || model, model, icon: other.icon }
      : other);
    const priority = priorityOf(status).map((id) => (id === entry.model ? model : id));
    persistModelsFull(catalog, priority, deactivatedOf(status));
  });

  return form;
}

// Constroi o grid de modelos na ordem de prioridade. No modo automatico mostra
// numero de prioridade + setas de reordenar; no manual mostra o toggle de escolha.
function buildModelGrid(status) {
  const fragment = document.createDocumentFragment();
  const ordered = orderedEntries(status);
  const auto = Boolean(status.autoToggle);
  const current = activeModelOf(status);
  const canRemove = catalogOf(status).length > 1;
  // No modo automatico o "Em uso" segue sempre o primeiro da lista (prioridade).

  ordered.forEach((entry, index) => {
    const isFirst = index === 0;
    // Modo manual: destaca o modelo fixo escolhido. Modo automatico: destaca o topo.
    const isActive = auto ? isFirst : (entry.model === current);
    const card = document.createElement('div');
    card.className = 'model-card' + (isActive ? ' active' : '');
    card.dataset.model = entry.model;

    const head = document.createElement('div');
    head.className = 'model-card-head';

    const icon = document.createElement('span');
    icon.className = 'model-icon';
    if (modelIcons) modelIcons.renderInto(icon, entry.icon, entry.label);

    const name = document.createElement('div');
    name.className = 'model-card-name';
    const strong = document.createElement('strong');
    strong.textContent = entry.label;
    const code = document.createElement('span');
    code.textContent = entry.model;
    const tag = document.createElement('span');
    tag.className = 'model-active-tag';
    tag.textContent = t('electron.inUse');
    tag.hidden = !isActive;
    name.append(strong, code);
    const daily = status.modelDaily && status.modelDaily[entry.model];
    if (daily && daily.used > 0) {
      const today = document.createElement('span');
      today.className = 'model-daily' + (daily.exhaustedKeys > 0 ? ' warn' : '');
      today.textContent = daily.limit
        ? t('usage.modelToday', { used: String(daily.used), limit: String(daily.limit) })
        : t('usage.todayNoLimit', { used: String(daily.used) });
      name.append(today);
    }
    name.append(tag);
    head.append(icon, name);

    if (auto) {
      // Modo automatico: numero da prioridade + setas para reordenar.
      const rank = document.createElement('div');
      rank.className = 'model-rank';
      const badge = document.createElement('span');
      badge.className = 'model-rank-badge';
      badge.textContent = String(index + 1);
      const arrows = document.createElement('div');
      arrows.className = 'model-rank-arrows';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'rank-arrow';
      up.textContent = '▲';
      up.title = 'Subir prioridade';
      up.disabled = index === 0;
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'rank-arrow';
      down.textContent = '▼';
      down.title = 'Descer prioridade';
      down.disabled = index === ordered.length - 1;
      arrows.append(up, down);
      rank.append(badge, arrows);
      head.append(rank);

      const reorder = (delta) => {
        const priority = ordered.map((item) => item.model);
        const target = index + delta;
        if (target < 0 || target >= priority.length) return;
        [priority[index], priority[target]] = [priority[target], priority[index]];
        persistModels(catalogOf(status), priority);
      };
      up.addEventListener('click', () => reorder(-1));
      down.addEventListener('click', () => reorder(1));
    } else {
      // Modo manual: toggle de escolha do modelo fixo de redirecionamento.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'model-toggle toggle' + (isActive ? ' on' : '');
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', isActive ? 'true' : 'false');
      toggle.setAttribute('aria-label', `Usar ${entry.label}`);
      toggle.innerHTML = '<span class="toggle-track"><span class="toggle-thumb"></span></span>';
      toggle.addEventListener('click', async () => {
        if (selectingModel || toggle.classList.contains('on')) return;
        selectingModel = true;
        try {
          renderStatus(await bridge.selectModel(entry.model));
        } catch (error) {
          elements.messageText.textContent =
            error?.message || t('error.generic');
        } finally {
          selectingModel = false;
        }
      });
      head.append(toggle);
    }

    const actions = document.createElement('div');
    actions.className = 'model-card-actions';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'model-test';
    test.textContent = t('electron.test');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'model-edit';
    edit.textContent = t('electron.edit');

    const pricing = document.createElement('button');
    pricing.type = 'button';
    pricing.className = 'model-pricing';
    pricing.textContent = '$';
    pricing.title = t('electron.pricing');
    pricing.addEventListener('click', () => openPricingModal(entry, status));

    actions.append(test, edit, pricing);
    {
      const deactivate = document.createElement('button');
      deactivate.type = 'button';
      deactivate.className = 'model-deactivate';
      deactivate.textContent = t('models.deactivate');
      deactivate.addEventListener('click', () => {
        const catalog = catalogOf(status).filter((other) => other.model !== entry.model);
        const priority = priorityOf(status).filter((id) => id !== entry.model);
        const deactivated = [...deactivatedOf(status), catalogOf(status).find((m) => m.model === entry.model) || entry];
        persistModelsFull(catalog, priority, deactivated);
      });
      actions.append(deactivate);
    }
    if (canRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'model-remove';
      remove.textContent = t('electron.remove');
      remove.addEventListener('click', () => {
        const catalog = catalogOf(status).filter((other) => other.model !== entry.model);
        const priority = priorityOf(status).filter((id) => id !== entry.model);
        persistModelsFull(catalog, priority, deactivatedOf(status));
      });
      actions.append(remove);
    }

    const editForm = buildEditForm(entry, status);
    edit.addEventListener('click', () => editForm.classList.toggle('hidden'));

    const result = document.createElement('div');
    result.className = 'model-result';
    result.hidden = true;
    wireTestButton(test, result, entry.model);

    card.append(head, actions, editForm, result);
    fragment.append(card);
  });

  elements.modelGrid.replaceChildren(fragment);
}

// Constroi o grid de modelos desativados. Cada card mostra nome/id e permite
// editar, configurar precos, reativar e remover permanentemente.
function buildDeactivatedGrid(status) {
  const fragment = document.createDocumentFragment();
  const deactivated = deactivatedOf(status);

  if (!deactivated.length) {
    const empty = document.createElement('div');
    empty.className = 'terminal-empty';
    empty.textContent = t('models.deactivatedEmpty');
    fragment.append(empty);
    elements.deactivatedModelGrid.replaceChildren(fragment);
    return;
  }

  deactivated.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'model-card deactivated';
    card.dataset.model = entry.model;

    const head = document.createElement('div');
    head.className = 'model-card-head';

    const icon = document.createElement('span');
    icon.className = 'model-icon';
    if (modelIcons) modelIcons.renderInto(icon, entry.icon, entry.label);

    const name = document.createElement('div');
    name.className = 'model-card-name';
    const strong = document.createElement('strong');
    strong.textContent = entry.label;
    const code = document.createElement('span');
    code.textContent = entry.model;
    name.append(strong, code);
    head.append(icon, name);

    const actions = document.createElement('div');
    actions.className = 'model-card-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'model-edit';
    edit.textContent = t('electron.edit');

    const pricing = document.createElement('button');
    pricing.type = 'button';
    pricing.className = 'model-pricing';
    pricing.textContent = '$';
    pricing.title = t('electron.pricing');
    pricing.addEventListener('click', () => openPricingModalDeactivated(entry, status));

    const reactivate = document.createElement('button');
    reactivate.type = 'button';
    reactivate.className = 'model-reactivate';
    reactivate.textContent = t('models.reactivate');
    reactivate.addEventListener('click', () => {
      const remain = deactivated.filter((other) => other.model !== entry.model);
      const catalog = [...catalogOf(status), entry];
      const priority = [...priorityOf(status), entry.model];
      persistModelsFull(catalog, priority, remain);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'model-remove';
    remove.textContent = t('electron.remove');
    remove.addEventListener('click', () => {
      const remain = deactivated.filter((other) => other.model !== entry.model);
      persistModelsFull(catalogOf(status), priorityOf(status), remain);
    });

    actions.append(edit, pricing, reactivate, remove);

    // Formulario inline de edicao para modelo desativado.
    const editForm = document.createElement('form');
    editForm.className = 'model-edit-form hidden';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'field-label';
    nameLabel.textContent = t('models.modelName');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = entry.label;
    const idLabel = document.createElement('label');
    idLabel.className = 'field-label';
    idLabel.textContent = t('models.providerModel');
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.value = entry.model;
    const error = document.createElement('div');
    error.className = 'form-error';
    const actions2 = document.createElement('div');
    actions2.className = 'add-model-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button ghost';
    cancel.textContent = t('electron.cancel');
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'button primary';
    save.textContent = t('electron.save');
    actions2.append(cancel, save);
    editForm.append(nameLabel, nameInput, idLabel, idInput, error, actions2);
    cancel.addEventListener('click', () => editForm.classList.add('hidden'));
    editForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const label = nameInput.value.trim();
      const model = idInput.value.trim();
      if (!model) { error.textContent = t('models.mustInformProvider'); return; }
      const dup = deactivated.some((other) => other.model !== entry.model && other.model === model)
        || catalogOf(status).some((other) => other.model === model);
      if (dup) { error.textContent = t('models.alreadyExists'); return; }
      const newDeactivated = deactivated.map((other) => other.model === entry.model
        ? { label: label || model, model, icon: other.icon, inputPrice: other.inputPrice, outputPrice: other.outputPrice }
        : other);
      persistModelsFull(catalogOf(status), priorityOf(status), newDeactivated);
    });
    edit.addEventListener('click', () => editForm.classList.toggle('hidden'));

    card.append(head, actions, editForm);
    fragment.append(card);
  });

  elements.deactivatedModelGrid.replaceChildren(fragment);
}

// Abre o modal de pricing para um modelo desativado.
function openPricingModalDeactivated(entry, status) {
  pricingModelId = entry.model;
  pricingIsDeactivated = true;
  elements.pricingModelLabel.textContent = entry.label + ' (' + entry.model + ')';
  const curInput = entry.inputPrice != null ? entry.inputPrice : 0;
  const curOutput = entry.outputPrice != null ? entry.outputPrice : 0;
  elements.pricingInputInput.value = curInput;
  elements.pricingOutputInput.value = curOutput;
  elements.pricingModal.classList.remove('hidden');
}

// Re-renderiza o modal de modelo a partir do status. So reconstroi o grid quando a
// assinatura (catalogo + prioridade + modo + modelo ativo) realmente muda, para nao
// perder resultados de teste em aberto a cada tick de status.
function renderModelModal(status) {
  if (!elements.modelGrid) return;
  const auto = Boolean(status.autoToggle);
  if (elements.autoToggleSwitch) {
    elements.autoToggleSwitch.classList.toggle('on', auto);
    elements.autoToggleSwitch.setAttribute('aria-checked', auto ? 'true' : 'false');
    elements.autoToggleSwitch.disabled = !status.unlocked;
  }
  if (elements.selectModeHint) {
    elements.selectModeHint.textContent = auto
      ? t('electron.autoModeHint')
      : t('electron.manualModeHint');
  }
  const signature = JSON.stringify({
    auto,
    active: activeModelOf(status),
    selected: status.selectedModel,
    catalog: catalogOf(status),
    priority: priorityOf(status),
    deactivated: deactivatedOf(status)
  });
  if (signature !== modelGridSignature) {
    modelGridSignature = signature;
    buildModelGrid(status);
    buildDeactivatedGrid(status);
  }
}

function openSelect() {
  renderModelModal(lastStatus);
  elements.selectModal.classList.remove('hidden');
}

// Tab switching dentro do modal de modelos: Ativos vs Desativados.
document.querySelectorAll('.model-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.model-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.model-tab-panel').forEach((p) => {
      p.classList.remove('active');
      p.classList.add('hidden');
    });
    tab.classList.add('active');
    const target = tab.dataset.modelTab;
    if (target === 'active') {
      elements.modelGridPanel.classList.add('active');
      elements.modelGridPanel.classList.remove('hidden');
    } else {
      elements.deactivatedGridPanel.classList.add('active');
      elements.deactivatedGridPanel.classList.remove('hidden');
    }
  });
});

function openConfig() {
  if (!elements.apiFields.children.length) {
    const fieldCount = Math.max(lastStatus.keyCount || 0, 3);
    for (let index = 0; index < fieldCount; index++) {
      addApiField('', index < lastStatus.keyCount ? index : null);
    }
  }
  elements.configModal.classList.remove('hidden');
}

// Modal da chave local. Abre pre-preenchido com a chave atual. Quando aberto por
// causa de needLocalKey (sem chave salva), ao fechar encaminha para o cadastro de
// APIs se ainda nao houver nenhuma.
function openLocalKey() {
  if (!elements.localKeyModal) return;
  if (elements.localKeyInput) elements.localKeyInput.value = lastStatus.apiKey || '';
  if (elements.localKeyError) elements.localKeyError.textContent = '';
  elements.localKeyModal.classList.remove('hidden');
  if (elements.localKeyInput) elements.localKeyInput.focus();
}

function closeLocalKey() {
  if (!elements.localKeyModal) return;
  elements.localKeyModal.classList.add('hidden');
  // Fluxo de primeira execucao: depois da chave, segue para o cadastro de APIs.
  if (lastStatus.unlocked && !lastStatus.keyCount && elements.configModal?.classList.contains('hidden')) {
    openConfig();
  }
}

if (elements.changeKeyButton) {
  elements.changeKeyButton.addEventListener('click', () => {
    if (!lastStatus.unlocked) {
      elements.messageText.textContent =
        t('electron.lockVaultFirst');
      return;
    }
    openLocalKey();
  });
}
if (elements.closeLocalKeyButton) {
  elements.closeLocalKeyButton.addEventListener('click', closeLocalKey);
}
if (elements.localKeyForm) {
  elements.localKeyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.localKeyError.textContent = '';
    const value = elements.localKeyInput.value.trim();
    if (value.length < 4) {
      elements.localKeyError.textContent = t('localkey.tooShort');
      return;
    }
    if (/\s/.test(value)) {
      elements.localKeyError.textContent = t('localkey.noSpaces');
      return;
    }
    try {
      const status = await bridge.saveLocalKey(value);
      renderStatus(status);
      closeLocalKey();
    } catch (error) {
      elements.localKeyError.textContent = error?.message || t('error.sentenceCouldNotSave');
    }
  });
}

elements.unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.unlockError.textContent = '';
  try {
    const status = await bridge.unlock(elements.passwordInput.value);
    elements.passwordInput.value = '';
    elements.unlockModal.classList.add('hidden');
    renderStatus(status);
    // Pede a chave local primeiro quando o config ainda nao tem uma; senao, vai
    // direto para o cadastro de APIs se nao houver nenhuma.
    if (status.needLocalKey) openLocalKey();
    else if (!status.keyCount) openConfig();
  } catch (error) {
    elements.unlockError.textContent = error?.message || t('error.sentenceCouldNotUnlock');
  }
});

elements.configButton.addEventListener('click', openConfig);
elements.closeConfigButton.addEventListener('click', () => elements.configModal.classList.add('hidden'));
elements.addApiButton.addEventListener('click', () => addApiField());
elements.exportApisButton.addEventListener('click', () => bridge.exportApis().then((result) => {
  if (result && result.ok) {
    elements.messageText.textContent = t('electron.exportApisDone', { path: result.path || '' });
  } else {
    elements.messageText.textContent = (result && result.error) || t('error.sentenceCouldNotExport');
  }
}));
elements.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.configError.textContent = '';
  const apiKeys = [...elements.apiFields.querySelectorAll('input')].map((input) => ({
    value: input.value.trim(),
    existingIndex: input.dataset.existingIndex === undefined
      ? null
      : Number(input.dataset.existingIndex)
  }));
  try {
    const status = await bridge.saveConfig({
      apiKeys,
      port: Number(elements.portInput.value),
      requestDelayMs: Number(elements.delayInput.value)
    });
    [...elements.apiFields.querySelectorAll('input')].forEach((input) => { input.value = ''; });
    elements.apiFields.replaceChildren();
    elements.configModal.classList.add('hidden');
    renderStatus(status);
  } catch (error) {
    elements.configError.textContent = error?.message || t('error.sentenceCouldNotSave');
  }
});

if (elements.selectModelButton) elements.selectModelButton.addEventListener('click', openSelect);
if (elements.closeSelectButton) {
  elements.closeSelectButton.addEventListener('click', () => elements.selectModal.classList.add('hidden'));
}

// Liga/desliga a alternancia automatica de modelo.
if (elements.autoToggleSwitch) {
  elements.autoToggleSwitch.addEventListener('click', async () => {
    if (busyModels) return;
    busyModels = true;
    try {
      renderStatus(await bridge.setAutoToggle(!lastStatus.autoToggle));
    } catch (error) {
      elements.messageText.textContent =
        error?.message || t('error.sentenceCouldNotToggle');
    } finally {
      busyModels = false;
    }
  });
}

// Mostra/esconde o formulario de adicionar modelo.
if (elements.addModelButton) {
  elements.addModelButton.addEventListener('click', () => {
    elements.addModelForm.classList.toggle('hidden');
    if (!elements.addModelForm.classList.contains('hidden')) {
      elements.addModelError.textContent = '';
      elements.addModelName.focus();
    }
  });
}
if (elements.cancelAddModelButton) {
  elements.cancelAddModelButton.addEventListener('click', () => {
    elements.addModelForm.classList.add('hidden');
    elements.addModelName.value = '';
    elements.addModelId.value = '';
    elements.addModelError.textContent = '';
  });
}
if (elements.addModelForm) {
  elements.addModelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.addModelError.textContent = '';
    const label = elements.addModelName.value.trim();
    const model = elements.addModelId.value.trim();
    if (!label || !model) {
      elements.addModelError.textContent = t('electron.fillNameAndId');
      return;
    }
    if (catalogOf(lastStatus).some((entry) => entry.model === model)) {
      elements.addModelError.textContent = t('electron.duplicateModel');
      return;
    }
    if (deactivatedOf(lastStatus).some((entry) => entry.model === model)) {
      elements.addModelError.textContent = t('models.alreadyExists');
      return;
    }
    // Novo modelo entra no catalogo (icone vazio = placeholder com a 1a letra) e no
    // FIM da fila de prioridades; pode ser reordenado depois.
    const catalog = [...catalogOf(lastStatus), { label, model, icon: '' }];
    const priority = [...priorityOf(lastStatus), model];
    elements.addModelName.value = '';
    elements.addModelId.value = '';
    elements.addModelForm.classList.add('hidden');
    await persistModels(catalog, priority);
  });
}
if (elements.penaltyButton) elements.penaltyButton.addEventListener('click', openPenalty);
if (elements.copyLogButton) {
  elements.copyLogButton.addEventListener('click', async () => {
    const text = buildLogText(lastStatus);
    if (!text) return;
    await bridge.copy(text);
    const original = elements.copyLogButton.textContent;
    elements.copyLogButton.textContent = t('electron.copied');
    setTimeout(() => { elements.copyLogButton.textContent = original; }, 1000);
  });
}
if (elements.closePenaltyButton) {
  elements.closePenaltyButton.addEventListener('click', () => elements.penaltyModal.classList.add('hidden'));
}
setInterval(() => {
  if (elements.penaltyModal && !elements.penaltyModal.classList.contains('hidden')) {
    renderPenalties(lastStatus);
  }
}, 1000);

elements.startButton.addEventListener('click', async () => renderStatus(await bridge.startProxy()));
elements.stopButton.addEventListener('click', async () => renderStatus(await bridge.stopProxy()));
elements.savePortButton.addEventListener('click', async () => {
  try {
    renderStatus(await bridge.savePort(elements.portInput.value));
  } catch (error) {
    elements.messageText.textContent = error?.message || t('port.invalid');
  }
});
elements.saveDelayButton.addEventListener('click', async () => {
  try {
    renderStatus(await bridge.saveDelay(elements.delayInput.value));
  } catch (error) {
    elements.messageText.textContent = error?.message || t('delay.invalid');
  }
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
  tab.classList.add('active');
  document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
}));
document.querySelectorAll('[data-copy-target]').forEach((button) => button.addEventListener('click', async () => {
  await bridge.copy(byId(button.dataset.copyTarget).textContent);
  const original = button.textContent;
  button.textContent = t('electron.copied');
  setTimeout(() => { button.textContent = original; }, 1000);
}));

// --- Modal de idioma ---
const localeOptions = [
  { code: 'en', flag: '🇺🇸', key: 'locale.en' },
  { code: 'pt-BR', flag: '🇧🇷', key: 'locale.pt-BR' },
  { code: 'de', flag: '🇩🇪', key: 'locale.de' },
  { code: 'ru', flag: '🇷🇺', key: 'locale.ru' },
  { code: 'zh-CN', flag: '🇨🇳', key: 'locale.zh-CN' }
];

function renderLocaleModal(status) {
  if (!elements.localeList) return;
  const current = (status.locale || 'en');
  const fragment = document.createDocumentFragment();
  localeOptions.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'locale-option' + (opt.code === current ? ' active' : '');
    btn.innerHTML = '<span class="locale-flag">' + opt.flag + '</span>' +
      '<span class="locale-name">' + t(opt.key) + '</span>' +
      '<span class="locale-check">✓</span>';
    btn.addEventListener('click', async () => {
      try {
        const newStatus = await bridge.setLocale(opt.code);
        renderStatus(newStatus);
        renderLocaleModal(newStatus);
      } catch (e) {
        // fallback
      }
    });
    fragment.append(btn);
  });
  elements.localeList.replaceChildren(fragment);
}

function openLocale() {
  renderLocaleModal(lastStatus);
  elements.localeModal.classList.remove('hidden');
}

if (elements.localeButton) {
  elements.localeButton.addEventListener('click', openLocale);
}
if (elements.closeLocaleButton) {
  elements.closeLocaleButton.addEventListener('click', () => elements.localeModal.classList.add('hidden'));
}

// --- Modal de pricing ---
let pricingModelId = null;
let pricingIsDeactivated = false;

function openPricingModal(entry, status) {
  pricingModelId = entry.model;
  pricingIsDeactivated = false;
  elements.pricingModelLabel.textContent = entry.label + ' (' + entry.model + ')';
  const curInput = entry.inputPrice != null ? entry.inputPrice : 0;
  const curOutput = entry.outputPrice != null ? entry.outputPrice : 0;
  elements.pricingInputInput.value = curInput;
  elements.pricingOutputInput.value = curOutput;
  elements.pricingModal.classList.remove('hidden');
}

elements.closePricingButton.addEventListener('click', () => {
  elements.pricingModal.classList.add('hidden');
  pricingModelId = null;
});

elements.cancelPricingButton.addEventListener('click', () => {
  elements.pricingModal.classList.add('hidden');
  pricingModelId = null;
});

elements.savePricingButton.addEventListener('click', async () => {
  if (!pricingModelId) return;
  const inputPrice = Number(elements.pricingInputInput.value);
  const outputPrice = Number(elements.pricingOutputInput.value);
  if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) return;

  const status = lastStatus;
  if (pricingIsDeactivated) {
    const deactivated = deactivatedOf(status).map((entry) => {
      if (entry.model === pricingModelId) {
        return { ...entry, inputPrice, outputPrice };
      }
      return entry;
    });
    try {
      const newStatus = await bridge.updateModels({ catalog: catalogOf(status), priority: priorityOf(status), deactivated });
      renderStatus(newStatus || status);
    } catch (e) {
      // ignore
    }
  } else {
    const catalog = catalogOf(status).map((entry) => {
      if (entry.model === pricingModelId) {
        return { ...entry, inputPrice, outputPrice };
      }
      return entry;
    });
    const priority = priorityOf(status);
    try {
      const newStatus = await bridge.updateModels({ catalog, priority, deactivated: deactivatedOf(status) });
      renderStatus(newStatus || status);
    } catch (e) {
      // ignore
    }
  }
  elements.pricingModal.classList.add('hidden');
  pricingModelId = null;
});

// --- Modal de tokens e economia ---
function openTokenModal() {
  const status = lastStatus;
  if (!status || !status.unlocked) return;

  fetch(status.codexBaseUrl.replace("/v1", "") + "/v1/tokens/usage")
    .then((res) => res.json())
    .then((usage) => {
      const models = usage.models || {};
      const entries = [...catalogOf(status), ...deactivatedOf(status)];
      const MILLION = 1000000;

      function fmt(n) {
        if (n < 1000) return String(n);
        if (n < MILLION) return (n / 1000).toFixed(1) + "K";
        return (n / MILLION).toFixed(2) + "M";
      }
      function usd(n) { return "$" + n.toFixed(4); }

      let totalSavings = 0;
      const rows = [];

      entries.forEach((entry) => {
        const data = models[entry.model];
        if (!data) return;
        const def = window.agentBridgeDefaultPrices ? window.agentBridgeDefaultPrices[entry.model] : null;
        const ip = typeof entry.inputPrice === "number" && entry.inputPrice >= 0
          ? entry.inputPrice : (def ? def.input : 0);
        const op = typeof entry.outputPrice === "number" && entry.outputPrice >= 0
          ? entry.outputPrice : (def ? def.output : 0);
        const savings = (data.inputTokens / MILLION) * ip + (data.outputTokens / MILLION) * op;
        totalSavings += savings;
        rows.push({
          label: entry.label,
          icon: entry.icon,
          calls: data.totalCalls,
          input: data.inputTokens,
          output: data.outputTokens,
          total: data.inputTokens + data.outputTokens,
          savings: savings
        });
      });

      const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
      const recent = (usage.recentTotalInputTokens || 0) + (usage.recentTotalOutputTokens || 0);

// Summary cards
      elements.tokenSummary.innerHTML =
        '<div class="token-summary-row">' +
          '<div class="token-stat"><span class="token-stat-value">' + fmt(totalTokens) + '</span><span class="token-stat-label">' + t('electron.total') + '</span></div>' +
          '<div class="token-stat"><span class="token-stat-value">' + fmt(recent) + '</span><span class="token-stat-label">' + t('electron.last30min') + '</span></div>' +
          '<div class="token-stat highlight"><span class="token-stat-value">' + usd(totalSavings) + '</span><span class="token-stat-label">' + t('electron.saved') + '</span></div>' +
        '</div>';

      // Per-model table
      let tableHtml = '<div class="token-table">' +
        '<div class="token-table-hdr">' +
          '<span>' + t('electron.model') + '</span><span>' + t('electron.tokenTokens') + '</span><span>' + t('electron.calls') + '</span><span class="right">' + t('electron.saved') + '</span>' +
        '</div>';

      rows.forEach((row) => {
        const iconKey = row.icon || "";
        const svg = iconKey && window.agentBridgeModelIcons && window.agentBridgeModelIcons[iconKey]
          ? window.agentBridgeModelIcons[iconKey] : "";
        const iconHtml = svg
          ? '<span class="token-model-icon">' + svg + '</span>'
          : '<span class="token-model-icon placeholder">' + (row.label[0] || "?").toUpperCase() + '</span>';

        tableHtml +=
          '<div class="token-table-row">' +
            '<span class="token-model-name">' + iconHtml + '<span>' + row.label + '</span></span>' +
            '<span class="token-model-tokens">' + fmt(row.total) + '</span>' +
            '<span class="token-model-calls">' + row.calls + '</span>' +
            '<span class="token-model-savings right">' + usd(row.savings) + '</span>' +
          '</div>';
      });

      tableHtml += '</div>';
      elements.tokenModelList.innerHTML = tableHtml;
      elements.tokenTotalSavings.innerHTML = usd(totalSavings);

      elements.tokenModal.classList.remove("hidden");
    })
    .catch(() => {
      elements.tokenSummary.textContent = t("electron.tokenError");
      elements.tokenModal.classList.remove("hidden");
    });
}

elements.tokenButton.addEventListener('click', openTokenModal);
elements.closeTokenButton.addEventListener('click', () => elements.tokenModal.classList.add('hidden'));

bridge.onStatus(renderStatus);
bridge.getStatus().then((status) => {
  renderStatus(status);
  elements.unlockHint.textContent = status.hasConfig
    ? t('electron.existingVaultHint')
    : t('electron.firstRunHint');
});
