// Nome diferente do AgentBridge original: o Electron usa este nome para a pasta
// %APPDATA% (cache/localStorage), entao as duas instalacoes nao se misturam.
export const APP_NAME = 'AgentBridge ALT';
// Pasta em Documents/. Diferente do AgentBridge original para nao misturar vaults.
export const DATA_DIR_NAME = 'AgentBridge-ALT';
export const APP_VERSION = '4.5.0';
export const INTERNAL_API_KEY = 'EuAmoORyo';
// 3001 para poder rodar ao lado do AgentBridge original (3000).
export const DEFAULT_PORT = 3001;
// Modelo NVIDIA padrao para onde o proxy redireciona qualquer chamada quando o
// usuario ainda nao escolheu nenhum dentro do app. O redirecionamento e SEMPRE
// ativo: o cliente pode mandar "AgentBridge", "gpt-5" ou qualquer coisa que o
// proxy reescreve para o modelo selecionado.
export const DEFAULT_MODEL = 'gemini-3.8-flash';

// Um item do catalogo de modelos selecionaveis. `model` e o id real enviado ao
// endpoint OpenAI-compativel do Gemini; `label` e o nome amigavel exibido; `icon`
// e a chave do SVG embutido (flash, pro, lite; vazio = placeholder com a primeira letra).
// `inputPrice` e `outputPrice` (USD por 1M tokens) sao opcionais e so alimentam o
// calculo de economia. Deixe vazio para modelos usados apenas no free tier.
export type ModelCatalogEntry = {
  label: string;
  model: string;
  icon: string;
  inputPrice?: number;
  outputPrice?: number;
};

// Precos padrao (USD por 1M tokens). Vazio de proposito: preencha pelo app se
// quiser acompanhar economia em relacao ao tier pago.
export const DEFAULT_MODEL_PRICES: Record<string, { input: number; output: number }> = {};

export const DEFAULT_DEACTIVATED_MODELS: ModelCatalogEntry[] = [];

// Catalogo padrao (ids conferidos em ai.google.dev/gemini-api/docs/models, set/2026).
// Editavel pelo usuario no app.
export const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  { label: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash', icon: 'flash' },
  { label: 'Gemini 3.1 Pro (preview)', model: 'gemini-3.1-pro-preview', icon: 'pro' },
  { label: 'Gemini 3.7 Flash', model: 'gemini-3.7-flash', icon: 'flash' },
  { label: 'Gemini 3.5 Flash', model: 'gemini-3.5-flash', icon: 'flash' },
  { label: 'Gemini 3.5 Flash-Lite', model: 'gemini-3.5-flash-lite', icon: 'lite' },
  { label: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro', icon: 'pro' },
  { label: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash', icon: 'flash' }
];

// Ordem de prioridade padrao do failover automatico de modelo (ids "provider/modelo").
// O proxy sempre tenta o primeiro disponivel desta lista, caindo para o proximo
// quando todas as chaves do atual estao de castigo (429).
export const DEFAULT_MODEL_PRIORITY: string[] = DEFAULT_MODEL_CATALOG.map((item) => item.model);

// Alternancia automatica de modelo desligada por padrao: o usuario liga no app.
export const DEFAULT_AUTO_TOGGLE = false; // alternancia automatica de modelo
// Nome fixo que o usuario coloca no client (Codex/Claude). Nunca chega na NVIDIA:
// e sempre substituido pelo modelo selecionado no proxy.
export const FIXED_CLIENT_MODEL = 'AgentBridge';
// Endpoint OpenAI-compativel do Gemini (AI Studio). Pode ser sobrescrito por
// AGENTBRIDGE_ALT_UPSTREAM_URL para testar outro provedor compativel.
export const UPSTREAM_CHAT_URL = process.env.AGENTBRIDGE_ALT_UPSTREAM_URL
  || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const REQUEST_DELAY_MS = 0;
// So telemetria (nao ha throttle local). Limites reais do Gemini variam por
// modelo/tier e sao POR PROJETO: veja aistudio.google.com/rate-limit.
export const UPSTREAM_RPM_LIMIT = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;
// Castigo aplicado a uma chave que recebeu HTTP 429: ela fica fora do rodizio
// por este tempo (1 hora) antes de poder ser chamada de novo. Contado por chave,
// em paralelo -- nao e um limite universal.
export const RATE_LIMIT_PENALTY_MS = 60 * 60_000;
// Castigo para 429 de limite POR MINUTO (RPM/TPM) quando o Gemini nao informa
// retryDelay. Limites diarios (RPD) ficam de castigo ate a meia-noite do Pacifico.
export const RATE_LIMIT_MINUTE_PENALTY_MS = 60_000;
// Teto so para socket realmente morto. Como nao ha mais retry/failover, NAO
// abortamos um prefill saudavel: contextos grandes podem demorar bem mais que 120s
// ate o primeiro token, e abortar so forcava o cliente a reenviar tudo de novo.
export const FIRST_RESPONSE_TIMEOUT_MS = 600_000;

// Tempo sem primeiro sinal de resposta (primeiro chunk/HTTP 200) antes de
// lancar uma requisicao de backup (hedge) no proximo modelo da prioridade.
// So ativo no modo automatico (autoToggle === true).
export const HEDGE_SLOW_THRESHOLD_MS = 60_000;
// Tempo extra que esperamos o primario responder DEPOIS que o backup ja
// respondeu. Se o primario ainda nao respondeu neste prazo, cancela o
// primario e fica com o backup.
export const HEDGE_PRIMARY_GRACE_MS = 10_000;
// Quantas requests o modelo backup fica "stickado" como ativo depois de
// ter vencido o hedge (primario muito lento). Durante estas requests nao
// tentamos o modelo de maior prioridade.
export const HEDGE_STICKY_REQUESTS = 5;

// Idioma padrao da interface. Se nao houver config salva, a deteccao automatica
// do SO decide; se a deteccao falhar, cai para 'en'.
export const DEFAULT_LOCALE = 'en';
