import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../index.ts';
import { FIXED_CLIENT_MODEL, INTERNAL_API_KEY, UPSTREAM_RPM_LIMIT } from '../config.ts';
import { onApiRequestLog, setRuntimeConfig } from '../services/runtime.ts';
import {
  LOCAL_TOOL_EDIT_POLICY_MARKER,
  LOCAL_TOOL_INSTRUCTION_MARKER
} from '../routes/toolInstructions.ts';

test('health reports locked and unlocked runtime state', async () => {
  setRuntimeConfig({ apiKeys: [] });
  const locked = await app.request('/health');
  assert.equal((await locked.json()).status, 'locked');

  setRuntimeConfig({ apiKeys: ['nvapi-test'] });
  const unlocked = await app.request('/health');
  const body = await unlocked.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.api_keys, 1);
  assert.equal(body.delay_ms, 0);
  assert.equal(body.rpm_limit_per_key, UPSTREAM_RPM_LIMIT);
  assert.equal(body.capacity_per_minute, UPSTREAM_RPM_LIMIT);
});

test('local endpoints require EuAmoORyo', async () => {
  const unauthorized = await app.request('/v1/models');
  assert.equal(unauthorized.status, 401);

  const authorized = await app.request('/v1/models', {
    headers: { authorization: `Bearer ${INTERNAL_API_KEY}` }
  });
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.object, 'list');
});

test('Responses and Anthropic adapters return protocol-native payloads', async () => {
  const originalFetch = globalThis.fetch;
  // Com model "AgentBridge", o redirecionamento continua ativo: nao importa o
  // protocolo, o upstream recebe o modelo selecionado no proxy.
  setRuntimeConfig({ apiKeys: ['nvapi-one', 'nvapi-two'], selectedModel: 'forced/selected-model' });
  const receivedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body || '{}'));
    receivedModels.push(request.model);
    return new Response([
      `data: {"id":"chatcmpl-test","object":"chat.completion","model":${JSON.stringify(request.model)},"choices":[{"index":0,"delta":{"role":"assistant","content":"Resposta NVIDIA"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${INTERNAL_API_KEY}`
    };
    const [responses, messages] = await Promise.all([
      app.request('/v1/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: FIXED_CLIENT_MODEL,
          input: 'Teste Codex'
        })
      }),
      app.request('/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: FIXED_CLIENT_MODEL,
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Teste Claude' }]
        })
      })
    ]);

    assert.equal(responses.status, 200);
    assert.equal((await responses.json()).output_text, 'Resposta NVIDIA');
    assert.equal(messages.status, 200);
    const messageBody = await messages.json();
    assert.equal(messageBody.type, 'message');
    assert.equal(messageBody.content[0].text, 'Resposta NVIDIA');
    assert.deepEqual(
      receivedModels.sort(),
      ['forced/selected-model', 'forced/selected-model']
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tool requests carry local Codex and Claude Code execution instructions', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-tools'] });
  const forwardedBodies: any[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body || '{}'));
    forwardedBodies.push(request);
    return new Response([
      `data: {"id":"chatcmpl-tools","object":"chat.completion","model":${JSON.stringify(request.model)},"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${INTERNAL_API_KEY}`
    };
    const tool = {
      type: 'function',
      name: 'apply_patch',
      description: 'Apply a surgical file patch',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    };

    await app.request('/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'publisher/codex-model',
        input: 'Leia um arquivo local.',
        tools: [tool]
      })
    });
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'publisher/claude-model',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Leia um arquivo local.' }],
        tools: [{
          name: 'shell_command',
          description: 'Run a local shell command',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } }
        }]
      })
    });

    assert.equal(forwardedBodies.length, 2);
    for (const request of forwardedBodies) {
      const systemText = request.messages
        .filter((message: any) => message.role === 'system')
        .map((message: any) => message.content)
        .join('\n');
      assert.match(systemText, /Codex CLI or Claude Code/);
      assert.match(systemText, new RegExp(LOCAL_TOOL_INSTRUCTION_MARKER));
      assert.match(systemText, new RegExp(LOCAL_TOOL_EDIT_POLICY_MARKER));
      assert.match(systemText, /Prefer small surgical patches/);
      assert.match(systemText, /Do not use shell redirection/);
      assert.doesNotMatch(systemText, /\/mnt|\/home/);
      assert.match(systemText, /Client-advertised tools:/);
    }
    assert.equal(forwardedBodies[0].tools[0].function.name, 'apply_patch');
    assert.equal(forwardedBodies[1].tools[0].function.name, 'shell_command');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat completions redireciona requests sem modelo para o modelo selecionado', async () => {
  const originalFetch = globalThis.fetch;
  // Mesmo sem o campo "model" (ou com qualquer modelo), o proxy reescreve para o
  // modelo selecionado e nao devolve mais 400.
  setRuntimeConfig({ apiKeys: ['nvapi-test'], selectedModel: 'forced/no-empty-model' });
  let upstreamModel = '';
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body || '{}'));
    upstreamModel = request.model;
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  try {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_API_KEY}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Sem modelo' }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamModel, 'forced/no-empty-model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('chat completions honra modelo real disponivel e cai para o efetivo quando "AgentBridge"', async () => {
  const originalFetch = globalThis.fetch;
  // Nova regra: id real com chave livre e honrado; "AgentBridge" redireciona para
  // o modelo selecionado. Nunca devolve erro de modelo.
  setRuntimeConfig({ apiKeys: ['nvapi-passthrough'], selectedModel: 'forced/selected-model' });
  const receivedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body || '{}'));
    receivedModels.push(request.model);
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${INTERNAL_API_KEY}`
    };
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'oi' }]
      })
    });
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL,
        messages: [{ role: 'user', content: 'oi' }]
      })
    });

    assert.deepEqual(receivedModels, ['moonshotai/kimi-k2.6', 'forced/selected-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /v1/models lista os modelos reais e o pseudo-modelo AgentBridge', async () => {
  setRuntimeConfig({ apiKeys: ['nvapi-list'] });
  const res = await app.request('/v1/models', {
    headers: { authorization: `Bearer ${INTERNAL_API_KEY}` }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.data.map((m: any) => m.id);
  assert.ok(ids.includes('gemini-3.8-flash'), 'deve listar um modelo real');
  assert.ok(ids.includes(FIXED_CLIENT_MODEL), 'deve manter o AgentBridge');
});

function upstreamToolCallSse() {
  const chunks = [
    { choices: [{ delta: { role: 'assistant', content: 'Vou ler' } }] },
    { choices: [{ delta: { content: ' o arquivo tal' } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_read_file',
            type: 'function',
            function: {
              name: 'shell_command',
              arguments: '{"command":"Get-Content package.json"}'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function parseSsePayloads(text: string) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.split(/\r?\n/).find((line) => line.startsWith('event: '))?.slice(7);
      const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6);
      if (!data) return null;
      return { event, data: JSON.parse(data) };
    })
    .filter(Boolean) as Array<{ event?: string; data: any }>;
}

test('Responses streaming finaliza texto antes de iniciar tool call', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-responses-stream'], selectedModel: 'forced/stream-model' });
  globalThis.fetch = async () => new Response(upstreamToolCallSse(), {
    headers: { 'content-type': 'text/event-stream' }
  });

  try {
    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_API_KEY}`
      },
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL,
        input: 'Leia o package.json',
        stream: true,
        tools: [{
          type: 'function',
          name: 'shell_command',
          description: 'Run a local shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } }
        }]
      })
    });

    assert.equal(response.status, 200);
    const events = parseSsePayloads(await response.text());
    const textDoneIndex = events.findIndex((entry) => entry.event === 'response.output_text.done');
    const toolAddedIndex = events.findIndex((entry) =>
      entry.event === 'response.output_item.added' && entry.data.item?.type === 'function_call'
    );

    assert.ok(textDoneIndex >= 0, 'deve emitir output_text.done');
    assert.ok(toolAddedIndex >= 0, 'deve emitir function_call');
    assert.ok(textDoneIndex < toolAddedIndex, 'texto deve fechar antes da tool call');
    assert.equal(events[textDoneIndex].data.text, 'Vou ler o arquivo tal');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming fecha bloco de texto antes de iniciar tool_use', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-anthropic-stream'], selectedModel: 'forced/stream-model' });
  globalThis.fetch = async () => new Response(upstreamToolCallSse(), {
    headers: { 'content-type': 'text/event-stream' }
  });

  try {
    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_API_KEY}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Leia o package.json' }],
        stream: true,
        tools: [{
          name: 'shell_command',
          description: 'Run a local shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } }
        }]
      })
    });

    assert.equal(response.status, 200);
    const events = parseSsePayloads(await response.text());
    const textStopIndex = events.findIndex((entry) => entry.event === 'content_block_stop' && entry.data.index === 0);
    const toolStartIndex = events.findIndex((entry) =>
      entry.event === 'content_block_start' && entry.data.content_block?.type === 'tool_use'
    );
    const text = events
      .filter((entry) => entry.event === 'content_block_delta' && entry.data.delta?.type === 'text_delta')
      .map((entry) => entry.data.delta.text)
      .join('');

    assert.equal(text, 'Vou ler o arquivo tal');
    assert.ok(textStopIndex >= 0, 'deve fechar bloco de texto');
    assert.ok(toolStartIndex >= 0, 'deve iniciar tool_use');
    assert.ok(textStopIndex < toolStartIndex, 'bloco de texto deve fechar antes da tool');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('client request logs include called protocol format', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-protocol-log'], selectedModel: 'forced/log-model' });
  const protocols: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    if (event.type === 'received') protocols.push(event.protocol || '');
  });
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  });

  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${INTERNAL_API_KEY}`
    };
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, messages: [{ role: 'user', content: 'oi' }] })
    });
    await app.request('/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, input: 'oi' })
    });
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'oi' }] })
    });

    assert.deepEqual(protocols.slice(-3), ['Chat Completions', 'Responses', 'Anthropic Messages']);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('Responses adapter preserves final SSE event without trailing separator', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-final-frame'], selectedModel: 'forced/final-frame-model' });
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"role":"assistant","content":"final sem separador"},"finish_reason":"stop"}]}',
    { headers: { 'content-type': 'text/event-stream' } }
  );

  try {
    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_API_KEY}`
      },
      body: JSON.stringify({ model: FIXED_CLIENT_MODEL, input: 'teste parser' })
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.output_text, 'final sem separador');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat completions keeps tool requests direct without local instruction injection', async () => {
  const originalFetch = globalThis.fetch;
  setRuntimeConfig({ apiKeys: ['nvapi-chat-direct'], selectedModel: 'forced/chat-direct-model' });
  let forwardedBody: any;
  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(String(init?.body || '{}'));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  try {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_API_KEY}`
      },
      body: JSON.stringify({
        model: FIXED_CLIENT_MODEL,
        messages: [{ role: 'user', content: 'Use a tool' }],
        tools: [{
          type: 'function',
          function: {
            name: 'shell_command',
            description: 'Run a local shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }
        }]
      })
    });

    assert.equal(response.status, 200);
    const systemText = (forwardedBody.messages || [])
      .filter((message: any) => message.role === 'system')
      .map((message: any) => message.content)
      .join('\n');
    assert.doesNotMatch(systemText, new RegExp(LOCAL_TOOL_INSTRUCTION_MARKER));
    assert.equal(forwardedBody.tools[0].function.name, 'shell_command');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
