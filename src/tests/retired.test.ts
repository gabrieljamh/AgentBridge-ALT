import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireApiKey, clearRuntimeConfig, getRuntimeStatus, setRuntimeConfig } from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';

const okSse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const gone = () => new Response(JSON.stringify({ status: 410, title: 'Gone', detail: 'Model has been retired' }), { status: 410, headers: { 'content-type': 'application/json' } });

test('retired: HTTP 410 benches the model on every key and auto mode fails over', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });
  const models: string[] = [];
  const response = await forwardToNvidia(
    { model: 'old/retired-model', messages: [{ role: 'user', content: 'oi' }] },
    async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);
      return model === 'old/retired-model' ? gone() : new Response(okSse, { headers: { 'content-type': 'text/event-stream' } });
    },
    0, {},
    { resolveModel: (exhausted) => (exhausted.includes('new/model') ? null : 'new/model') }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['old/retired-model', 'new/model'], 'no retry on another key for a retired model');
  const rows = getRuntimeStatus().apiUsage;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const penalty = row.penalties.find((p) => p.model === 'old/retired-model');
    assert.ok(penalty, 'every key benched');
    assert.equal(penalty.reason, 'retired');
    assert.ok(penalty.penaltyUntil - Date.now() > 23 * 60 * 60_000);
  }
  await assert.rejects(() => acquireApiKey({ model: 'old/retired-model' }), (error: any) => {
    assert.equal(error.retired, true);
    assert.match(error.message, /410/);
    return true;
  });
  clearRuntimeConfig();
});
