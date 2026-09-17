import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../index.ts';
import { FIXED_CLIENT_MODEL, INTERNAL_API_KEY } from '../config.ts';
import { clearRuntimeConfig, getRuntimeStatus, setRuntimeConfig } from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';
import {
  SKIP_THOUGHT_SIGNATURE,
  classifyKeyFailure,
  classifyRateLimitBody,
  extractProviderMessage,
  clearToolCallExtras,
  msUntilNextPacificMidnight,
  withThoughtSignatures
} from '../services/gemini.ts';

async function requestText(...args: Parameters<typeof app.request>) {
  return (await app.request(...args)).text();
}

const dailyBody = [{
  error: {
    code: 429,
    message: 'You exceeded your current quota.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'
        }]
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }
    ]
  }
}];

const minuteBody = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }]
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17.5s' }
    ]
  }
};

test('429 diario fica de castigo ate a meia-noite do Pacifico', () => {
  const now = Date.parse('2026-09-16T15:00:00Z'); // 08:00 PDT
  const info = classifyRateLimitBody(JSON.stringify(dailyBody), now);
  assert.equal(info.scope, 'daily');
  const hours = info.penaltyMs / 3_600_000;
  assert.ok(hours > 15.9 && hours < 16.1, `esperado ~16h, veio ${hours}`);
});

test('429 por minuto usa o retryDelay informado', () => {
  const info = classifyRateLimitBody(minuteBody);
  assert.equal(info.scope, 'minute');
  assert.equal(info.penaltyMs, 17_500);
});

test('429 sem detalhes cai no castigo curto padrao', () => {
  const info = classifyRateLimitBody('not json');
  assert.equal(info.scope, 'unknown');
  assert.equal(info.penaltyMs, 60_000);
  assert.ok(msUntilNextPacificMidnight() <= 24 * 3_600_000 + 5_000);
});

test('forward aplica castigo diario por (chave, modelo) a partir do corpo do 429', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['AIza-daily', 'AIza-spare'] });
  const seen: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization);
    seen.push(auth);
    if (seen.length === 1) {
      return new Response(JSON.stringify(dailyBody), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  await forwardToNvidia({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'oi' }] }, fakeFetch, 0);
  const penalized = getRuntimeStatus().apiUsage.find((row) => row.resting);
  assert.ok(penalized, 'uma chave deve estar de castigo');
  assert.equal(penalized.penalties[0].model, 'gemini-3.8-flash');
  assert.ok(penalized.penaltyUntil! - Date.now() > 60 * 60_000, 'castigo diario deve passar de 1h');
  assert.ok(seen.length >= 2, 'deve tentar a outra chave');
  assert.notEqual(seen[0], seen[1]);
});

test('placeholder so e aplicado a modelos Gemini 3+ sem assinatura', () => {
  clearToolCallExtras();
  const messages = [{
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } }
    ]
  }];
  const g3 = withThoughtSignatures(messages, 'gemini-3.8-flash') as any[];
  assert.equal(g3[0].tool_calls[0].extra_content.google.thought_signature, SKIP_THOUGHT_SIGNATURE);
  assert.equal(g3[0].tool_calls[1].extra_content, undefined);
  const g25 = withThoughtSignatures(messages, 'gemini-2.5-flash') as any[];
  assert.equal(g25[0].tool_calls[0].extra_content, undefined);
});

function signedToolCallSse() {
  const chunks = [
    { choices: [{ delta: { role: 'assistant' } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_sig_1',
            type: 'function',
            function: { name: 'shell_command', arguments: '{"command":"ls"}' },
            extra_content: { google: { thought_signature: 'REAL_SIGNATURE_ABC' } }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test('Anthropic (Claude Code): thought signature volta ao Gemini no turno seguinte', async () => {
  clearToolCallExtras();
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['AIza-sig'], selectedModel: 'gemini-3.8-flash' });
  const upstreamBodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)));
    return new Response(signedToolCallSse(), { headers: { 'content-type': 'text/event-stream' } });
  };
  const tools = [{ name: 'shell_command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }];
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_API_KEY}`, 'anthropic-version': '2023-06-01' };
  try {
    const first = await app.request('/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, max_tokens: 64, stream: true, tools, messages: [{ role: 'user', content: 'liste' }] })
    });
    const text = await first.text();
    assert.match(text, /call_sig_1/);
    assert.doesNotMatch(text, /REAL_SIGNATURE_ABC/, 'assinatura nao vaza para o cliente Anthropic');

    // Claude Code devolve so id/name/input, sem extra_content.
    await requestText('/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL, max_tokens: 64, stream: true, tools,
        messages: [
          { role: 'user', content: 'liste' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_sig_1', name: 'shell_command', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_sig_1', content: 'a.txt' }] }
        ]
      })
    });

    const second = upstreamBodies[upstreamBodies.length - 1];
    const assistant = second.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    assert.equal(assistant.tool_calls[0].extra_content.google.thought_signature, 'REAL_SIGNATURE_ABC');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses (Codex): function_calls paralelos viram um unico turno com assinatura', async () => {
  clearToolCallExtras();
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['AIza-resp'], selectedModel: 'gemini-3.8-flash' });
  const upstreamBodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)));
    return new Response(signedToolCallSse(), { headers: { 'content-type': 'text/event-stream' } });
  };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_API_KEY}` };
  try {
    await requestText('/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, stream: true, input: 'liste' })
    });
    await requestText('/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL, stream: true,
        input: [
          { type: 'message', role: 'user', content: 'liste' },
          { type: 'function_call', call_id: 'call_sig_1', name: 'shell_command', arguments: '{"command":"ls"}' },
          { type: 'function_call', call_id: 'call_other', name: 'shell_command', arguments: '{"command":"pwd"}' },
          { type: 'function_call_output', call_id: 'call_sig_1', output: 'a.txt' },
          { type: 'function_call_output', call_id: 'call_other', output: '/' }
        ]
      })
    });
    const second = upstreamBodies[upstreamBodies.length - 1];
    const assistants = second.messages.filter((m: any) => m.role === 'assistant' && m.tool_calls);
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].tool_calls.length, 2);
    assert.equal(assistants[0].tool_calls[0].extra_content.google.thought_signature, 'REAL_SIGNATURE_ABC');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const invalidKeyBody = JSON.stringify([{
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
  }
}]);

test('classifica falhas de chave, billing e alta demanda', () => {
  assert.equal(classifyKeyFailure(400, invalidKeyBody), 'invalid_key');
  assert.equal(classifyKeyFailure(400, '{"error":{"status":"FAILED_PRECONDITION","message":"User location is not supported"}}'), 'billing');
  assert.equal(classifyKeyFailure(503, '{"error":{"message":"The model is currently experiencing high demand."}}'), 'high_demand');
  assert.equal(classifyKeyFailure(400, '{"error":{"message":"Invalid JSON payload"}}'), null);
  assert.equal(classifyKeyFailure(403, '{"error":{"status":"PERMISSION_DENIED","message":"Requests from unrestricted API keys are blocked."}}'), 'invalid_key');
  assert.equal(extractProviderMessage(invalidKeyBody), 'INVALID_ARGUMENT: API key not valid. Please pass a valid API key.');
});

test('chave invalida sai do rodizio em todos os modelos e a request tenta outra chave', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['AIza-bad', 'AIza-good'] });
  const seen: Array<{ auth: string; model: string }> = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization);
    const model = JSON.parse(String(init?.body)).model;
    seen.push({ auth, model });
    if (auth === 'Bearer AIza-bad') {
      return new Response(invalidKeyBody, { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };
  // Repete ate a chave ruim ser sorteada (a escolha inicial e aleatoria).
  let response: Response | undefined;
  for (let i = 0; i < 20 && !seen.some((row) => row.auth === 'Bearer AIza-bad'); i++) {
    clearRuntimeConfig();
    setRuntimeConfig({ apiKeys: ['AIza-bad', 'AIza-good'] });
    seen.length = 0;
    response = await forwardToNvidia({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'oi' }] }, fakeFetch, 0);
  }
  assert.ok(seen.some((row) => row.auth === 'Bearer AIza-bad'), 'chave ruim deveria ter sido sorteada');
  assert.equal(response!.status, 200);
  assert.ok(seen.every((row) => row.model === 'gemini-3.8-flash'), 'nao deve trocar de modelo por causa de chave invalida');
  const bad = getRuntimeStatus().apiUsage.find((row) => row.apiNumber === 1)!;
  assert.equal(bad.penalties[0].model, '*');

  // Proxima request, outro modelo: a chave ruim nao e mais usada.
  seen.length = 0;
  await forwardToNvidia({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'oi' }] }, fakeFetch, 0);
  assert.deepEqual(seen.map((row) => row.auth), ['Bearer AIza-good']);
});

const highDemandBody = JSON.stringify([{ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }]);
const okSse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('503 high demand com uma chave so: backoff e nova tentativa no mesmo modelo', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['AIza-single'] });
  let calls = 0;
  const sleeps: number[] = [];
  const fakeFetch: typeof fetch = async () => {
    calls++;
    if (calls <= 2) return new Response(highDemandBody, { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(okSse, { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await forwardToNvidia(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'oi' }] },
    fakeFetch, 0, { sleep: async (ms) => { sleeps.push(ms); } }
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1_500, 4_000]);
  assert.equal(getRuntimeStatus().apiUsage[0].resting, false, 'alta demanda nao castiga a chave');
});

test('503 high demand persistente troca de modelo no modo automatico', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['AIza-single'] });
  const models: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    models.push(model);
    if (model === 'gemini-3.8-flash') return new Response(highDemandBody, { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(okSse, { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await forwardToNvidia(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'oi' }] },
    fakeFetch, 0, { sleep: async () => {} },
    { resolveModel: (exhausted) => (exhausted.includes('gemini-3.5-flash-lite') ? null : 'gemini-3.5-flash-lite') }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']);
});
