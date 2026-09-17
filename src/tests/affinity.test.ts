import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireApiKey, clearDailyUsage, clearRuntimeConfig, markApiRateLimited, setRuntimeConfig } from '../services/runtime.ts';
import { conversationFingerprint, forwardToNvidia } from '../services/nvidia.ts';

function reset(keys: string[]) {
  clearRuntimeConfig();
  clearDailyUsage();
  setRuntimeConfig({ apiKeys: keys });
}

test('affinity: fingerprint ignores later turns but differs per conversation', () => {
  const turn1 = { messages: [{ role: 'system', content: 'You are Aria.' }, { role: 'user', content: 'Hi' }] };
  const turn5 = { messages: [...turn1.messages, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Tell me more' }] };
  const other = { messages: [{ role: 'system', content: 'You are Bob.' }, { role: 'user', content: 'Hi' }] };
  assert.equal(conversationFingerprint(turn1), conversationFingerprint(turn5));
  assert.notEqual(conversationFingerprint(turn1), conversationFingerprint(other));
  assert.equal(conversationFingerprint({ messages: [] }), undefined);
});

test('affinity: same conversation keeps its key; a new conversation goes to the least-used key', async () => {
  reset(['AQ.a', 'AQ.b', 'AQ.c']);
  const first = await acquireApiKey({ model: 'gemma-4-26b-a4b-it', affinity: 'chat-1' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await acquireApiKey({ model: 'gemma-4-26b-a4b-it', affinity: 'chat-1' })).apiNumber, first.apiNumber);
  }
  const second = await acquireApiKey({ model: 'gemma-4-26b-a4b-it', affinity: 'chat-2' });
  assert.notEqual(second.apiNumber, first.apiNumber, 'busy key avoided for a new conversation');
  const third = await acquireApiKey({ model: 'gemma-4-26b-a4b-it', affinity: 'chat-3' });
  assert.notEqual(third.apiNumber, first.apiNumber);
  assert.notEqual(third.apiNumber, second.apiNumber, 'three conversations spread over three keys');
});

test('affinity: after a 429 the conversation moves and sticks to the new key', async () => {
  reset(['AQ.a', 'AQ.b', 'AQ.c']);
  const before = await acquireApiKey({ model: 'gemma-4-31b-it', affinity: 'rp' });
  markApiRateLimited({ apiNumber: before.apiNumber, model: 'gemma-4-31b-it', retryAfterMs: 60_000 });
  const moved = await acquireApiKey({ model: 'gemma-4-31b-it', affinity: 'rp' });
  assert.notEqual(moved.apiNumber, before.apiNumber);
  assert.equal((await acquireApiKey({ model: 'gemma-4-31b-it', affinity: 'rp' })).apiNumber, moved.apiNumber);
});

test('affinity: forwardToNvidia pins every turn of a chat to one key', async () => {
  reset(['AQ.one', 'AQ.two', 'AQ.three']);
  const auths: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    auths.push(String((init?.headers as Record<string, string>).authorization));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const history: any[] = [{ role: 'system', content: 'Narrator' }, { role: 'user', content: 'Start' }];
  for (let turn = 0; turn < 4; turn++) {
    await forwardToNvidia({ model: 'gemma-4-26b-a4b-it', messages: [...history] }, fetchImpl, 0);
    history.push({ role: 'assistant', content: `reply ${turn}` }, { role: 'user', content: `next ${turn}` });
  }
  assert.equal(new Set(auths).size, 1);
});
