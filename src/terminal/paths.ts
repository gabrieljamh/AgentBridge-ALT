import { DATA_DIR_NAME } from '../config.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getRuntimeStatus, setApiPenaltyUntil } from '../services/runtime.ts';

// Resolve a pasta "Documentos" do usuario do mesmo jeito que o Electron
// (app.getPath('documents')), para que o modo terminal e o modo desktop leiam e
// gravem EXATAMENTE o mesmo arquivo. Assim a config criptografada criada num modo
// abre no outro sem conversao.
function documentsDir(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    // Conhecido como FOLDERID_Documents. O padrao e %USERPROFILE%\Documents.
    const profile = process.env.USERPROFILE || home;
    return path.join(profile, 'Documents');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Documents');
  }
  // Linux: respeita XDG_DOCUMENTS_DIR (de ~/.config/user-dirs.dirs) como o Electron.
  const fromEnv = process.env.XDG_DOCUMENTS_DIR;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.replace(/^~(?=$|\/)/, home);
  }
  const userDirsFile = path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'user-dirs.dirs'
  );
  try {
    if (existsSync(userDirsFile)) {
      const raw = readFileSync(userDirsFile, 'utf8');
      const match = raw.match(/XDG_DOCUMENTS_DIR\s*=\s*"([^"]+)"/);
      if (match) {
        return match[1]
          .replace(/\$HOME/g, home)
          .replace(/^~(?=$|\/)/, home);
      }
    }
  } catch {
    // Sem permissao para ler user-dirs: cai no padrao ~/Documents.
  }
  return path.join(home, 'Documents');
}

export function appDir(): string {
  return path.join(documentsDir(), DATA_DIR_NAME);
}

export function configPath(): string {
  return path.join(appDir(), 'config.json');
}

export function dailyUsagePath(): string {
  return path.join(appDir(), 'daily_usage.json');
}

export function penaltiesPath(): string {
  return path.join(appDir(), 'penalties.json');
}

export function localePath(): string {
  return path.join(appDir(), 'locale.txt');
}

// Impressao digital curta da chave (NAO o segredo) para casar o castigo salvo com
// a chave certa mesmo que a ordem das APIs mude entre reinicios.
function keyFingerprint(apiKey: string): string {
  return apiKey ? apiKey.slice(-6) : '';
}

type PersistedPenalty = {
  apiNumber: number;
  keyFingerprint: string;
  model: string;
  successesBefore429: number;
  reason?: 'retired';
  enteredAt: string;
  penaltyUntil: string;
};

// Salva os castigos ativos (HTTP 429) em penalties.json, no mesmo formato do
// desktop, para que o cooldown de 1 hora sobreviva ao fechar/reabrir o terminal.
export function savePenalties(apiKeys: string[]): void {
  try {
    const usage = getRuntimeStatus().apiUsage as Array<{
      apiNumber: number;
      penalties?: Array<{
        model: string;
        penaltyStartedAt: number;
        penaltyUntil: number;
        successesBefore429?: number;
        reason?: 'retired';
      }>;
    }>;
    const penalties: PersistedPenalty[] = [];
    for (const item of usage) {
      for (const penalty of item.penalties || []) {
        penalties.push({
          apiNumber: item.apiNumber,
          keyFingerprint: keyFingerprint(apiKeys[item.apiNumber - 1] || ''),
          model: penalty.model,
          successesBefore429: Number(penalty.successesBefore429) || 0,
          ...(penalty.reason === 'retired' ? { reason: 'retired' as const } : {}),
          enteredAt: new Date(penalty.penaltyStartedAt || Date.now()).toISOString(),
          penaltyUntil: new Date(penalty.penaltyUntil).toISOString()
        });
      }
    }
    const filePath = penaltiesPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), penalties }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // Persistir o castigo nao pode derrubar o proxy.
  }
}

// Le penalties.json no arranque: restaura quem ainda esta dentro da 1 hora e
// descarta quem ja passou. Depois normaliza o arquivo no disco.
export function loadPenalties(apiKeys: string[]): void {
  try {
    const filePath = penaltiesPath();
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { penalties?: PersistedPenalty[] };
    const now = Date.now();
    for (const entry of raw.penalties || []) {
      const penaltyUntil = Date.parse(entry.penaltyUntil);
      if (!Number.isFinite(penaltyUntil) || penaltyUntil <= now) continue;
      const enteredAt = Date.parse(entry.enteredAt);
      let apiNumber = apiKeys.findIndex(
        (apiKey) => keyFingerprint(apiKey) === entry.keyFingerprint
      ) + 1;
      if (apiNumber === 0 && entry.apiNumber >= 1 && entry.apiNumber <= apiKeys.length) {
        apiNumber = entry.apiNumber;
      }
      if (apiNumber >= 1) {
        setApiPenaltyUntil(
          apiNumber,
          penaltyUntil,
          Number.isFinite(enteredAt) ? enteredAt : undefined,
          typeof entry.model === 'string' ? entry.model : '',
          Number(entry.successesBefore429) || 0,
          entry.reason === 'retired' ? 'retired' : undefined
        );
      }
    }
    savePenalties(apiKeys);
  } catch {
    // Arquivo corrompido nao pode travar o desbloqueio.
  }
}
