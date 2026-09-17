import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL, INTERNAL_API_KEY } from '../config.ts';
import { localKeyStored, saveConfig, unlockConfig } from '../services/vault.ts';
import type { UnlockedConfig } from '../services/vault.ts';

const baseConfig = (overrides?: Partial<UnlockedConfig>): UnlockedConfig => ({
  port: 3456,
  requestDelayMs: 0,
  apiKeys: [],
  selectedModel: DEFAULT_MODEL,
  autoToggle: false,
  modelPriority: [],
  modelCatalog: [],
  localApiKey: INTERNAL_API_KEY,
  ...overrides
});

test('vault encrypts API keys and decrypts them only with the password', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one', 'nvapi-secret-two'],
    selectedModel: 'moonshotai/kimi-k2.6'
  }));
  const raw = readFileSync(filePath, 'utf8');

  assert.doesNotMatch(raw, /nvapi-secret/);
  const unlocked = unlockConfig(filePath, 'minha-senha');
  assert.deepEqual(unlocked.apiKeys, ['nvapi-secret-one', 'nvapi-secret-two']);
  assert.equal(unlocked.port, 3456);
  assert.equal(unlocked.selectedModel, 'moonshotai/kimi-k2.6');
  assert.throws(() => unlockConfig(filePath, 'senha-errada'));
});

test('vault encrypts the local key and never writes it in plain text', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one'],
    localApiKey: 'minha-chave-local'
  }));
  const raw = readFileSync(filePath, 'utf8');

  assert.doesNotMatch(raw, /minha-chave-local/);
  assert.equal(localKeyStored(filePath), true);
  assert.equal(unlockConfig(filePath, 'minha-senha').localApiKey, 'minha-chave-local');
});

test('vault defaults the local key when the config has none (legacy)', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one']
  }));
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.localApiKey;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(localKeyStored(filePath), false);
  assert.equal(unlockConfig(filePath, 'minha-senha').localApiKey, INTERNAL_API_KEY);
});

test('vault defaults old configs to zero ms request delay', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one'],
    requestDelayMs: 2500
  }));
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.requestDelayMs;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(unlockConfig(filePath, 'minha-senha').requestDelayMs, 0);
});

test('vault migrates the old 2500 ms default to zero for smooth RPM mode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one'],
    requestDelayMs: 2500
  }));
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.rateLimitMode;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(unlockConfig(filePath, 'minha-senha').requestDelayMs, 0);
});

test('vault persists locale preference', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', baseConfig({
    apiKeys: ['nvapi-secret-one'],
    locale: 'de'
  }));
  const unlocked = unlockConfig(filePath, 'minha-senha');
  assert.equal(unlocked.locale, 'de');
});
test('vault persists the reasoning mode and defaults old configs to client', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');
  saveConfig(filePath, 'senha', baseConfig({ apiKeys: ['AQ.one'], reasoningMode: 'off' }));
  assert.equal(unlockConfig(filePath, 'senha').reasoningMode, 'off');
  saveConfig(filePath, 'senha', baseConfig({ apiKeys: ['AQ.one'] }));
  assert.equal(unlockConfig(filePath, 'senha').reasoningMode, 'client');
});
