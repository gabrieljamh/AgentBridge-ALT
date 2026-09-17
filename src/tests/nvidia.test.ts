import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forwardToNvidia } from '../services/nvidia.ts';
import { setLastErrorDirectory } from '../services/lastErrors.ts';
import {
  clearRuntimeConfig,
  markApiRateLimited,
  onApiRequestLog,
  setRuntimeConfig
} from '../services/runtime.ts';

type LastErrorsFile = { entries: Array<{ errorMessage: string; errorStatus: number; errorBody: string }> };

async function readLastErrorsEventually(directory: string, expectedMessage?: RegExp): Promise<LastErrorsFile> {
  const filePath = path.join(directory, 'last_errors.json');
  let lastError: unknown;
  for (let index = 0; index < 30; index++) {
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as LastErrorsFile;
        if (parsed.entries?.length && (!expectedMessage || expectedMessage.test(parsed.entries[0].errorMessage))) return parsed;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  return JSON.parse(readFileSync(filePath, 'utf8')) as LastErrorsFile;
}
test('NVIDIA forwarding picks a key among the available ones (no 429) and preserves streaming responses', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-first', 'nvapi-second'] });
  const authorizations: string[] = [];
  const upstreamStreams: unknown[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    upstreamStreams.push(JSON.parse(String(init?.body || '{}')).stream);
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const first = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  const second = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);

  const validKeys = ['Bearer nvapi-first', 'Bearer nvapi-second'];
  assert.ok(authorizations.every((auth) => validKeys.includes(auth)));
  assert.equal(authorizations.length, 2);
  assert.deepEqual(upstreamStreams, [true, true]);
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.equal(await second.text(), 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});

test('NVIDIA forwarding waits before starting the upstream request', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-delay'] });
  const startedAt = Date.now();
  let fetchAt = 0;
  const fakeFetch: typeof fetch = async () => {
    fetchAt = Date.now();
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };

  await forwardToNvidia({ model: 'test' }, fakeFetch, 25);
  assert.ok(fetchAt - startedAt >= 20);
});

test('NVIDIA forwarding does not wait after the old 35 RPM threshold', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-limited'] });
  let now = 240_000;
  const rateSleeps: number[] = [];
  const rateLimitOptions = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      rateSleeps.push(milliseconds);
      now += milliseconds;
    }
  };
  const fakeFetch: typeof fetch = async () =>
    new Response('{}', { headers: { 'content-type': 'application/json' } });

  for (let index = 0; index < 36; index++) {
    await forwardToNvidia({ model: 'test' }, fakeFetch, 0, rateLimitOptions);
  }
  assert.equal(rateSleeps.length, 0);
});

test('NVIDIA forwarding aggregates upstream streaming for non-streaming clients and logs lifecycle', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-stream'] });
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","created":1,"model":"test","choices":[{"delta":{"role":"assistant","content":"Oi"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'Oi!');
  assert.deepEqual(events, ['delay', 'called', 'started', 'completed']);
  unsubscribe();
});

test('NVIDIA forwarding honors zero configured delay and logs it', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-zero'], requestDelayMs: 0 });
  const events: Array<{ type: string; delayMs?: number }> = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push({ type: event.type, delayMs: event.delayMs });
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(events.map((event) => event.type), ['delay', 'called', 'started', 'completed']);
  assert.equal(events.find((event) => event.type === 'delay')?.delayMs, 0);
  unsubscribe();
});

test('NVIDIA forwarding finishes non-streaming clients as soon as upstream sends DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-done'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      ].join('')));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'ok');
});

test('NVIDIA forwarding closes streaming clients as soon as upstream sends DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-done-stream'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch);

  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
test('NVIDIA forwarding closes streaming clients when upstream sends finish_reason without DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-finish-stream'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);

  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  );
  assert.equal(upstreamCancelled, true);
});

test('NVIDIA forwarding aggregates non-streaming clients when upstream sends finish_reason without DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-finish-json'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'final');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(upstreamCancelled, true);
});
test('NVIDIA forwarding emits SSE keep-alives while streaming upstream is idle', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-keepalive'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: true },
    fakeFetch,
    0,
    {},
    { streamKeepAliveMs: 5 }
  );
  assert.ok(response.body);
  const reader = response.body.getReader();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n');
  const keepAlive = await reader.read();
  assert.equal(decoder.decode(keepAlive.value), ': keep-alive\n\n');
  assert.equal(upstreamCancelled, false);

  await reader.cancel();
});

test('NVIDIA forwarding releases a role prelude with the first text delta without waiting for completion', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-role-prelude'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const roleChunk = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
  const contentChunk = 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n';
  const finishChunk = 'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n';
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signalReady!: () => void;
  const upstreamReady = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode(roleChunk));
      signalReady();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  let responseResolved = false;
  const responsePromise = forwardToNvidia(
    { model: 'test', stream: true },
    fakeFetch,
    0
  ).then((response) => {
    responseResolved = true;
    return response;
  });

  await upstreamReady;
  await Promise.resolve();
  assert.equal(responseResolved, false);

  assert.ok(upstreamController);
  upstreamController.enqueue(encoder.encode(contentChunk));
  const response = await responsePromise;
  assert.equal(responseResolved, true);
  assert.ok(response.body);
  const reader = response.body.getReader();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), roleChunk + contentChunk);

  upstreamController.enqueue(encoder.encode(finishChunk));
  upstreamController.close();
  const finish = await reader.read();
  assert.equal(decoder.decode(finish.value), finishChunk);
  const done = await reader.read();
  assert.equal(decoder.decode(done.value), 'data: [DONE]\n\n');
});

test('NVIDIA hedge releases the winning tool call as soon as it starts', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-hedge-tool'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const roleChunk = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
  const toolStartChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"buscar","arguments":""}}]}}]}\n\n';
  const toolFinishChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"q\\\":\\\"teste\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n';
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signalReady!: () => void;
  const upstreamReady = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode(roleChunk));
      signalReady();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  let responseResolved = false;
  const responsePromise = forwardToNvidia(
    { model: 'primary-model', stream: true },
    fakeFetch,
    0,
    {},
    {
      enableHedge: true,
      resolveModel: () => null
    }
  ).then((response) => {
    responseResolved = true;
    return response;
  });

  await upstreamReady;
  await Promise.resolve();
  assert.equal(responseResolved, false);

  assert.ok(upstreamController);
  upstreamController.enqueue(encoder.encode(toolStartChunk));
  const response = await responsePromise;
  assert.equal(responseResolved, true);
  assert.ok(response.body);
  const reader = response.body.getReader();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), roleChunk + toolStartChunk);

  upstreamController.enqueue(encoder.encode(toolFinishChunk));
  upstreamController.close();
  const finish = await reader.read();
  assert.equal(decoder.decode(finish.value), toolFinishChunk);
  const done = await reader.read();
  assert.equal(decoder.decode(done.value), 'data: [DONE]\n\n');
});

test('NVIDIA forwarding does not log local stream disposal as client cancellation', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-local-dispose'], requestDelayMs: 0 });
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n'));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.resolve();

  assert.equal(events.includes('cancelled'), false);
  unsubscribe();
});
test('NVIDIA forwarding captures streamed response text without cloning the response', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-capture-stream'], requestDelayMs: 0 });
  let captured = '';
  const fakeFetch: typeof fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: true },
    fakeFetch,
    0,
    {},
    { onResponseText: (text) => { captured = text; } }
  );

  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.equal(captured, 'Oi!');
});

test('NVIDIA forwarding captures aggregated response text for non-streaming clients', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-capture-json'], requestDelayMs: 0 });
  let captured = '';
  const fakeFetch: typeof fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Tudo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" certo"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: false },
    fakeFetch,
    0,
    {},
    { onResponseText: (text) => { captured = text; } }
  );
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'Tudo certo');
  assert.equal(captured, 'Tudo certo');
});
test('NVIDIA forwarding silently retries empty non-streaming completions', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-empty'], requestDelayMs: 0 });
  const errorDirectory = mkdtempSync(path.join(tmpdir(), 'agentbridge-empty-errors-'));
  setLastErrorDirectory(errorDirectory);
  const events: Array<{ type: string; status?: number; message?: string; model?: string }> = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push({ type: event.type, status: event.status, message: event.message, model: event.model });
  });
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response([
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n'
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"real"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  };

  const response = await forwardToNvidia({ model: 'empty-model', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, 'real');
  assert.equal(calls, 2);
  const upstreamError = events.find((event) => event.type === 'upstream_error');
  assert.equal(upstreamError?.status, 204);
  assert.equal(upstreamError?.model, 'empty-model');
  setLastErrorDirectory('');
  unsubscribe();
});
test('NVIDIA forwarding returns empty response with 200 after 3 empty retries', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-empty'], requestDelayMs: 0 });
  const errorDirectory = mkdtempSync(path.join(tmpdir(), 'agentbridge-empty-errors-'));
  setLastErrorDirectory(errorDirectory);
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response([
      'data: {"id":"chatcmpl-empty","model":"empty-model","choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), {
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': `empty-request-${calls}`
      }
    });
  };

  try {
    const response = await forwardToNvidia({ model: 'empty-model', stream: false }, fakeFetch, 0);
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(calls, 3);
    const content = body.choices?.[0]?.message?.content;
    assert.equal(content, '');

    // [DESLIGADO] last_errors.json nao e mais salvo — confirma que o arquivo nao existe.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(path.join(errorDirectory, 'last_errors.json')), false);
  } finally {
    setLastErrorDirectory('');
  }
});

test('NVIDIA forwarding treats SSE error payloads inside HTTP 200 as retryable upstream errors', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-sse-error-a', 'nvapi-sse-error-b', 'nvapi-sse-error-c'], requestDelayMs: 0 });
  const errorDirectory = mkdtempSync(path.join(tmpdir(), 'agentbridge-sse-errors-'));
  setLastErrorDirectory(errorDirectory);
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    if (calls <= 2) {
      return new Response([
        'data: {"error":{"message":"Internal server error","type":"internal_server_error","code":500}}\n\n',
        'data: [DONE]\n\n'
      ].join(''), {
        headers: {
          'content-type': 'text/event-stream',
          'nvcf-reqid': `sse-error-${calls}`
        }
      });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"real"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const response = await forwardToNvidia({ model: 'sse-error-model', stream: false }, fakeFetch, 0);
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(calls, 3);
    assert.equal(body.choices[0].message.content, 'real');

    // [DESLIGADO] last_errors.json nao e mais salvo — confirma que o arquivo nao existe.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(path.join(errorDirectory, 'last_errors.json')), false);
  } finally {
    setLastErrorDirectory('');
  }
});
test('NVIDIA forwarding logs upstream HTTP errors', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-error'] });
  const events: Array<{ type: string; status?: number; message?: string }> = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push({
      type: event.type,
      status: event.status,
      message: event.message
    });
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' }
    });

  const response = await forwardToNvidia({ model: 'test' }, fakeFetch, 0);

  assert.equal(response.status, 429);
  assert.deepEqual(events.map((event) => event.type), [
    'delay',
    'called',
    'started',
    'upstream_error',
    'completed'
  ]);
  assert.equal(events.find((event) => event.type === 'upstream_error')?.status, 429);
  assert.equal(
    events.find((event) => event.type === 'upstream_error')?.message,
    'rate limited' // corpo do provedor, nao o statusText
  );
  unsubscribe();
});

test('NVIDIA forwarding fails over to the next key on HTTP 429', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-limited', 'nvapi-spare'] });
  const authorizations: string[] = [];
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const fakeFetch: typeof fetch = async (_input, init) => {
    const auth = new Headers(init?.headers).get('authorization') || '';
    authorizations.push(auth);
    if (auth === 'Bearer nvapi-limited') {
      return new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'text/plain' }
      });
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };

  // Loop ate `nvapi-limited` ser sorteada, levar 429 e falhar para `nvapi-spare`.
  // Como acquireApiKey e sticky por modelo, reconfiguramos a cada tentativa para
  // zerar o cursor e dar a `nvapi-limited` uma chance real de ser sorteada.
  let response: Response = new Response(null, { status: 503 });
  let body: any = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    clearRuntimeConfig();
    setRuntimeConfig({ apiKeys: ['nvapi-limited', 'nvapi-spare'] });
    authorizations.length = 0;
    events.length = 0;
    response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
    body = await response.json() as any;
    if (authorizations.includes('Bearer nvapi-limited')) break;
  }

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, 'ok');
  assert.ok(authorizations.includes('Bearer nvapi-limited'));
  assert.ok(authorizations.includes('Bearer nvapi-spare'));
  assert.ok(events.includes('upstream_error'));
  assert.equal(events.filter((type) => type === 'called').length, 2);
  unsubscribe();
});

test('NVIDIA forwarding returns 429 only after every key is rate limited', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-a', 'nvapi-b'] });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    return new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' }
    });
  };

  const response = await forwardToNvidia({ model: 'test' }, fakeFetch, 0);

  assert.equal(response.status, 429);
  assert.ok(authorizations.includes('Bearer nvapi-a'));
  assert.ok(authorizations.includes('Bearer nvapi-b'));
  assert.equal(authorizations.length, 2);
});

test('NVIDIA forwarding serializes the configured delay so sends are spaced apart', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-gate'] });
  let now = 1_000_000;
  const opts = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  const sendTimes: number[] = [];
  const fakeFetch: typeof fetch = async () => {
    sendTimes.push(now);
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  await forwardToNvidia({ model: 'test' }, fakeFetch, 3000, opts);
  await forwardToNvidia({ model: 'test' }, fakeFetch, 3000, opts);

  // Cada request espera ao menos o delay antes de enviar, e os envios ficam
  // espacados em delayMs entre si (em vez de dispararem juntos apos um atraso comum).
  assert.equal(sendTimes[0], 1_003_000);
  assert.equal(sendTimes[1], 1_006_000);
});

test('NVIDIA forwarding skips a penalized key on later requests (1h castigo)', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-one', 'nvapi-two'] });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const auth = new Headers(init?.headers).get('authorization') || '';
    authorizations.push(auth);
    if (auth === 'Bearer nvapi-one') {
      return new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'text/plain' }
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  // Loop ate `nvapi-one` ser sorteada e entrar em castigo (determinismo).
  // Como acquireApiKey e sticky por modelo, reconfiguramos a cada tentativa para
  // zerar o cursor e dar a `nvapi-one` uma chance real de ser sorteada.
  for (let attempt = 0; attempt < 20; attempt++) {
    clearRuntimeConfig();
    setRuntimeConfig({ apiKeys: ['nvapi-one', 'nvapi-two'] });
    authorizations.length = 0;
    await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
    if (authorizations.includes('Bearer nvapi-one')) break;
  }
  assert.ok(authorizations.includes('Bearer nvapi-one'));
  // Request 2: vai DIRETO para key2, sem desperdicar uma chamada na key1 de castigo.
  authorizations.length = 0;
  await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  assert.deepEqual(authorizations, ['Bearer nvapi-two']);
  clearRuntimeConfig();
});

test('NVIDIA forwarding logs the model on started and upstream_error', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-model'] });
  const byType = new Map<string, string | undefined>();
  const unsubscribe = onApiRequestLog((event) => {
    if (event.type === 'started' || event.type === 'upstream_error') {
      byType.set(event.type, event.model);
    }
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('not found', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' }
    });

  await forwardToNvidia({ model: 'moonshotai/kimi-k2-instruct' }, fakeFetch, 0);

  assert.equal(byType.get('started'), 'moonshotai/kimi-k2-instruct');
  assert.equal(byType.get('upstream_error'), 'moonshotai/kimi-k2-instruct');
  unsubscribe();
  clearRuntimeConfig();
});

test('NVIDIA forwarding does not delegate to another API when the first stream is silent', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-silent', 'nvapi-fast'] });
  // Forca nvapi-fast (apiNumber 2) em castigo para que acquireApiKey sorteie
  // deterministicamente nvapi-silent. O teste valida que um stream silencioso
  // resulta em 504 sem delegar para outra chave -- com nvapi-fast em castigo,
  // nao ha outra elegivel para receber a delegacao.
  markApiRateLimited({ apiNumber: 2, model: 'test', timestamp: Date.now() });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    return new Response(new ReadableStream({ start() {} }), {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const response = await forwardToNvidia(
    { model: 'test', stream: false },
    fakeFetch,
    0,
    {},
    { firstResponseTimeoutMs: 5 }
  );

  assert.equal(response.status, 504);
  assert.deepEqual(authorizations, ['Bearer nvapi-silent']);
});
