// Teste rapido de modelo ("Testar"): um quiz de 5 perguntas com resposta unica,
// respondido via tool call. O app corrige sozinho, entao o resultado e um placar
// objetivo (ex.: 6/6) em ~2 s e poucas centenas de tokens, e ainda confere se o
// modelo sabe chamar ferramentas -- o que importa para Claude Code e Codex.
//
// Nenhum codigo gerado pelo modelo e executado: a pergunta de codigo pede apenas
// o que um trecho FIXO imprime.

export const QUIZ_TOOL_NAME = 'submit_answers';

export type QuizCheckId = 'tool_call' | 'arithmetic' | 'brick' | 'code' | 'count' | 'reverse';

type QuizQuestion = {
  id: Exclude<QuizCheckId, 'tool_call'>;
  prompt: string;
  expected: string;
  kind: 'number' | 'exact';
};

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  { id: 'arithmetic', prompt: 'Compute (17 * 23) - (144 / 12). Answer with a number only.', expected: '379', kind: 'number' },
  { id: 'brick', prompt: 'A brick weighs 1 kg plus half of the same brick. How many kg does the whole brick weigh? Answer with a number only.', expected: '2', kind: 'number' },
  { id: 'code', prompt: 'What does this Python code print? print([x*x for x in range(5) if x % 2][-1]) Answer with the printed value only.', expected: '9', kind: 'number' },
  { id: 'count', prompt: 'How many times does the letter "r" appear in "strawberry raspberry"? Answer with a number only.', expected: '6', kind: 'number' },
  { id: 'reverse', prompt: 'Write the word "bridge" in uppercase letters, reversed. Answer with the word only.', expected: 'EGDIRB', kind: 'exact' }
];

export const QUIZ_PROMPT = [
  `Answer the ${QUIZ_QUESTIONS.length} questions below. Call the function ${QUIZ_TOOL_NAME} exactly once with your answers.`,
  'Do not write any other text.',
  '',
  ...QUIZ_QUESTIONS.map((q, i) => `${i + 1}. ${q.id}: ${q.prompt}`)
].join('\n');

export function buildQuizRequest(model: string, toolChoice: 'required' | 'auto' = 'required') {
  return {
    model,
    stream: false,
    messages: [{ role: 'user', content: QUIZ_PROMPT }],
    tools: [{
      type: 'function',
      function: {
        name: QUIZ_TOOL_NAME,
        description: 'Submit the answers to the quiz.',
        parameters: {
          type: 'object',
          properties: Object.fromEntries(QUIZ_QUESTIONS.map((q) => [q.id, { type: 'string', description: q.prompt }])),
          required: QUIZ_QUESTIONS.map((q) => q.id)
        }
      }
    }],
    tool_choice: toolChoice
  };
}

export type QuizCheck = { id: QuizCheckId; pass: boolean; got: string; expected: string };

export type QuizGrade = {
  score: number;
  total: number;
  toolCall: boolean;
  checks: QuizCheck[];
  raw: string;
};

// Procura as respostas do quiz dentro de um valor JSON qualquer. Aceita o objeto
// direto ({ arithmetic, ... }) e tambem tool calls "escritas como texto" por modelos
// que nao usam o formato nativo, ex.: [[{"name":"submit_answers","parameters":{...}}]]
// (Nemotron) ou {"name":..., "arguments":"{...}"}.
function findAnswers(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try { return findAnswers(JSON.parse(value), depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAnswers(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (QUIZ_QUESTIONS.some((q) => q.id in record)) return record;
  for (const key of ['parameters', 'arguments', 'args', 'input', 'function']) {
    if (key in record) {
      const found = findAnswers(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  const candidates = [unfenced];
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = unfenced.indexOf(open);
    const end = unfenced.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const found = findAnswers(JSON.parse(candidate));
      if (found) return found;
    } catch {
      // tenta o proximo candidato
    }
  }
  return undefined;
}

function normalizeNumber(value: string) {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? String(Number(match[0])) : '';
}

function normalizeExact(value: string) {
  return value.trim().replace(/^["'`]+|["'`.]+$/g, '').trim();
}

// Corrige a resposta (chat completion nao-stream no formato OpenAI).
export function gradeQuizCompletion(completion: any): QuizGrade {
  const message = completion?.choices?.[0]?.message || {};
  const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = toolCalls.find((c) => c?.function?.name === QUIZ_TOOL_NAME) || toolCalls[0];
  const toolArgs = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
  const content = typeof message.content === 'string' ? message.content : '';

  const fromTool = parseJsonObject(toolArgs);
  const answers = fromTool || parseJsonObject(content) || {};
  const toolCall = Boolean(fromTool && call?.function?.name === QUIZ_TOOL_NAME);

  const checks: QuizCheck[] = [{ id: 'tool_call', pass: toolCall, got: toolCall ? QUIZ_TOOL_NAME : (call?.function?.name || 'text'), expected: QUIZ_TOOL_NAME }];
  for (const q of QUIZ_QUESTIONS) {
    const got = answers[q.id] === undefined || answers[q.id] === null ? '' : String(answers[q.id]);
    const pass = q.kind === 'number'
      ? normalizeNumber(got) === q.expected
      : normalizeExact(got) === q.expected;
    checks.push({ id: q.id, pass, got, expected: q.expected });
  }
  const score = checks.filter((c) => c.pass).length;
  return { score, total: checks.length, toolCall, checks, raw: toolArgs || content };
}

export type QuizOutcome =
  | ({ ok: true; model: string; elapsedMs: number; status: number; totalTokens: number; reply: string } & QuizGrade)
  | { ok: false; model: string; elapsedMs: number; status?: number; error: string; timedOut?: boolean };

// Roda o quiz usando o invocador informado (forwardToNvidia no app). Se o endpoint
// recusar tool_choice "required" (HTTP 400 citando tool_choice), repete com "auto".
// Teste rapido: se o modelo nao responder em QUIZ_TIMEOUT_MS, desiste e cancela a
// chamada (antes esperava o timeout do proxy, 600 s).
export const QUIZ_TIMEOUT_MS = 120_000;

export type QuizInvoker = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

// Junta o signal do quiz ao signal que o proxy ja usa em cada fetch.
export function fetchWithQuizSignal(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal
  });
}

export async function runModelQuiz(
  model: string,
  invoke: QuizInvoker,
  describeError: (text: string) => string | undefined,
  timeoutMs = QUIZ_TIMEOUT_MS
): Promise<QuizOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  const timedOut = (): QuizOutcome => ({
    ok: false,
    model,
    elapsedMs: Date.now() - startedAt,
    timedOut: true,
    error: `No response in ${Math.round(timeoutMs / 1000)} s`
  });
  const withTimeout = async <T,>(work: Promise<T>): Promise<T | 'timeout'> => Promise.race([work, timeout]);
  try {
    let response = await withTimeout(invoke(buildQuizRequest(model, 'required'), controller.signal));
    if (response === 'timeout') return timedOut();
    let text = await withTimeout(response.text().catch(() => ''));
    if (text === 'timeout') return timedOut();
    if (response.status === 400 && /tool_choice|function_calling_config|mode/i.test(text)) {
      response = await withTimeout(invoke(buildQuizRequest(model, 'auto'), controller.signal));
      if (response === 'timeout') return timedOut();
      text = await withTimeout(response.text().catch(() => ''));
      if (text === 'timeout') return timedOut();
    }
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const message = describeError(text);
      return { ok: false, model, elapsedMs, status: response.status, error: message ? `HTTP ${response.status} - ${message}` : `HTTP ${response.status}` };
    }
    let payload: any = {};
    try { payload = JSON.parse(text); } catch { payload = {}; }
    const grade = gradeQuizCompletion(payload);
    return {
      ok: true,
      model,
      elapsedMs,
      status: response.status,
      totalTokens: Number(payload?.usage?.total_tokens) || 0,
      reply: grade.raw,
      ...grade
    };
  } catch (error: any) {
    if (controller.signal.aborted) return timedOut();
    return { ok: false, model, elapsedMs: Date.now() - startedAt, error: error?.message || String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
