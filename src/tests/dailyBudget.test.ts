import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLimitsFor } from '../config.ts';
import {
  acquireApiKey,
  clearDailyUsage,
  clearRuntimeConfig,
  exportDailyUsage,
  getRuntimeStatus,
  importDailyUsage,
  keyFingerprint,
  markDailyBudgetExhausted,
  pacificDay,
  setRuntimeConfig
} from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';

function reset(keys: string[]) {
  clearRuntimeConfig();
  clearDailyUsage();
  setRuntimeConfig({ apiKeys: keys });
}

const okSse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('daily: family limits (Flash 5/20, Flash-Lite 15/500, others none)', () => {
  assert.deepEqual(modelLimitsFor('gemini-3.6-flash'), { rpm: 5, rpd: 20 });
  assert.deepEqual(modelLimitsFor('gemini-3.1-flash-lite'), { rpm: 15, rpd: 500 });
  assert.deepEqual(modelLimitsFor('gemini-3.1-pro-preview'), { rpm: 0, rpd: 0 });
  assert.deepEqual(modelLimitsFor('gemma-4-26b-a4b-it'), { rpm: 30, rpd: 14_400 });
  assert.equal(modelLimitsFor('moonshotai/kimi-k2.6'), undefined);
});

test('daily: a key at 20/20 on a Flash model is skipped only for that model', async () => {
  reset(['AQ.key-one', 'AQ.key-two']);
  for (let i = 0; i < 40; i++) await acquireApiKey({ model: 'gemini-3.6-flash' });
  const status = getRuntimeStatus();
  const used = status.apiUsage.map((row) => row.daily.find((d) => d.model === 'gemini-3.6-flash')?.used);
  assert.deepEqual(used, [20, 20], 'sticky key fills to 20, then the other key takes over');
  assert.equal(status.modelDaily['gemini-3.6-flash'].used, 40);
  assert.equal(status.modelDaily['gemini-3.6-flash'].limit, 40);
  await assert.rejects(() => acquireApiKey({ model: 'gemini-3.6-flash' }), (error: any) => {
    assert.equal(error.code, 'all_resting');
    assert.equal(error.dailyBudget, true);
    assert.match(error.message, /Limite diario/);
    return true;
  });
  const other = await acquireApiKey({ model: 'gemini-3.5-flash' });
  assert.ok(other.apiNumber >= 1, 'a different Flash model still has its own budget');
});

test('daily: failover to next model when every key used the Flash budget', async () => {
  reset(['AQ.only']);
  for (let i = 0; i < 20; i++) await acquireApiKey({ model: 'gemini-3.8-flash' });
  const models: string[] = [];
  const response = await forwardToNvidia(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'oi' }] },
    async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response(okSse, { headers: { 'content-type': 'text/event-stream' } });
    },
    0, {},
    { resolveModel: (exhausted) => (exhausted.includes('gemini-3.1-flash-lite') ? null : 'gemini-3.1-flash-lite') }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['gemini-3.1-flash-lite'], 'no request wasted on the exhausted model');
});

test('daily: a real daily 429 syncs the counter to the limit', () => {
  reset(['AQ.used-elsewhere']);
  markDailyBudgetExhausted({ apiNumber: 1, model: 'gemini-3.5-flash' });
  const row = getRuntimeStatus().apiUsage[0].daily.find((d) => d.model === 'gemini-3.5-flash');
  assert.deepEqual(row, { model: 'gemini-3.5-flash', used: 20, limit: 20, exhausted: true });
});

test('daily: persistence round-trip keeps today and drops other days, never stores the key', async () => {
  reset(['AQ.persist-me']);
  for (let i = 0; i < 3; i++) await acquireApiKey({ model: 'gemini-3.1-flash-lite' });
  const saved = exportDailyUsage();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].keyFingerprint, keyFingerprint('AQ.persist-me'));
  assert.doesNotMatch(JSON.stringify(saved), /persist-me/);

  clearDailyUsage();
  importDailyUsage([...saved, { keyFingerprint: saved[0].keyFingerprint, model: 'gemini-3.6-flash', day: '2000-01-01', count: 20 }]);
  const daily = getRuntimeStatus().apiUsage[0].daily;
  assert.deepEqual(daily.map((d) => [d.model, d.used]), [['gemini-3.1-flash-lite', 3]]);
  assert.equal(saved[0].day, pacificDay());
});

test('daily: Pro family has no free quota, so no request is sent and auto mode moves on', async () => {
  reset(['AQ.free']);
  await assert.rejects(() => acquireApiKey({ model: 'gemini-3.1-pro-preview' }), (error: any) => {
    assert.equal(error.dailyBudget, true);
    assert.match(error.message, /nao tem cota no free tier/);
    return true;
  });
  const models: string[] = [];
  const response = await forwardToNvidia(
    { model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'oi' }] },
    async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response(okSse, { headers: { 'content-type': 'text/event-stream' } });
    },
    0, {},
    { resolveModel: (exhausted) => (exhausted.includes('gemini-3.6-flash') ? null : 'gemini-3.6-flash') }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['gemini-3.6-flash']);
});
