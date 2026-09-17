import type { ApiRequestLogEvent } from '../services/runtime.ts';
import { c } from './theme.ts';
import { t } from '../i18n/index.ts';

// Formatacoes de texto compartilhadas pelas telas (espelham renderer.js do
// desktop): tempo decorrido, mensagem amigavel de cada evento de log, contagem
// regressiva do castigo e os snippets de integracao Codex/Claude.

export function formatElapsed(milliseconds: unknown): string {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

// Mensagem amigavel de uma linha do log, ja colorida por tipo de evento.
function clientTarget(entry: ApiRequestLogEvent): string {
  const route = entry.path ? `${entry.method || ''} ${entry.path}`.trim() : '';
  return [entry.protocol ? `[${entry.protocol}]` : '', route].filter(Boolean).join(' ');
}

export function usageMessage(entry: ApiRequestLogEvent): string {
  const target = clientTarget(entry);
  switch (entry.type) {
    case 'received':
      return c.muted(t('log.clientCalled', { target }));
    case 'rejected':
      return c.red(t('log.clientRejected', { target, status: String(entry.status), message: entry.message || t('log.invalidKey') }));
    case 'completed_client':
      return c.green(t('log.clientReceived', { target, status: String(entry.status), elapsed: formatElapsed(entry.elapsedMs) }));
    case 'failed_client':
      return c.red(t('log.proxyError', { target, message: entry.message || t('log.unknownError') }));
    case 'rate_limit_wait':
      return c.amber(t('log.rateLimitWait', { elapsed: formatElapsed(entry.waitMs) }));
    case 'delay':
      return c.faint(t('log.delayWait', { elapsed: formatElapsed(entry.delayMs) }));
    case 'called':
      return c.text(t('log.apiSelected', { number: String(entry.apiNumber) }));
    case 'started':
      return c.text(t('log.apiStarted', { number: String(entry.apiNumber), elapsed: formatElapsed(entry.elapsedMs), model: entry.model ? c.faint(t('log.modelPrefix', { model: entry.model })) : '' }));
    case 'completed':
      return c.green(t('log.apiCompleted', { number: String(entry.apiNumber), elapsed: formatElapsed(entry.elapsedMs), tokens: Number(entry.totalTokens) > 0 ? t('log.apiTokens', { count: String(entry.totalTokens) }) : '' }));
    case 'upstream_error':
      return c.red(t('log.upstreamError', { status: String(entry.status), number: String(entry.apiNumber), model: entry.model ? ' (' + entry.model + ')' : '', message: entry.message || t('log.noDetail') }));
    case 'cancelled':
      return c.amber(t('log.streamCancelled', { number: String(entry.apiNumber), message: entry.message || t('log.clientDisconnected') }));
    case 'model_switch':
      return c.accentStrong(t('log.modelSwitch', { reason: entry.message ? ' ' + entry.message : '', model: entry.model || '?' }));
    case 'error':
      return c.red(t('log.apiError', { number: String(entry.apiNumber || '?'), message: entry.message || t('log.noDetail') }));
    default:
      return c.text(t('log.apiCall', { number: String(entry.apiNumber) }));
  }
}

export type Shell = 'bash' | 'powershell';

// Bloco do ~/.codex/config.toml (independente de shell).
export function codexConfigToml(baseUrl: string): string {
  return [
    'model = "AgentBridge"',
    'model_provider = "agentbridge"',
    '',
    '[model_providers.agentbridge]',
    'name = "Gemini via AgentBridge"',
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "responses"',
    'env_key = "AGENTBRIDGE_API_KEY"'
  ].join('\n');
}

// Variavel de ambiente do Codex, ja no formato do shell escolhido.
export function codexEnv(apiKey: string, shell: Shell): string {
  return shell === 'powershell'
    ? `$env:AGENTBRIDGE_API_KEY="${apiKey}"`
    : `export AGENTBRIDGE_API_KEY="${apiKey}"`;
}

// Bloco completo do Claude Code para um shell especifico (cole e ja inicia).
export function claudeSnippet(baseUrl: string, apiKey: string, shell: Shell): string {
  if (shell === 'powershell') {
    return [
      `$env:ANTHROPIC_BASE_URL="${baseUrl}"`,
      `$env:ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
      '$env:ANTHROPIC_MODEL="AgentBridge"',
      '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL',
      '$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL',
      '$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL',
      'claude'
    ].join('\n');
  }
  return [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
    'export ANTHROPIC_MODEL="AgentBridge"',
    'export ANTHROPIC_DEFAULT_HAIKU_MODEL=$ANTHROPIC_MODEL',
    'export ANTHROPIC_DEFAULT_SONNET_MODEL=$ANTHROPIC_MODEL',
    'export ANTHROPIC_DEFAULT_OPUS_MODEL=$ANTHROPIC_MODEL',
    'claude'
  ].join('\n');
}
