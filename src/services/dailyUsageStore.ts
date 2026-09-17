// Persiste o contador diario (RPD) por (chave, modelo) em daily_usage.json, na
// pasta de dados do app. Guarda so o hash curto da chave, nunca a chave. Desktop e
// TUI usam o mesmo arquivo, entao a contagem continua entre os dois modos.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportDailyUsage, importDailyUsage, onDailyUsageChanged } from './runtime.ts';

export function loadDailyUsage(filePath: string) {
  try {
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { usage?: unknown };
    importDailyUsage(raw.usage);
  } catch {
    // Arquivo corrompido nao pode travar o desbloqueio.
  }
}

export function saveDailyUsage(filePath: string) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), usage: exportDailyUsage() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // Persistir nao pode derrubar o proxy.
  }
}

// Salva no maximo 1x por segundo enquanto houver trafego.
export function autoSaveDailyUsage(filePath: () => string) {
  let timer: NodeJS.Timeout | undefined;
  return onDailyUsageChanged(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      saveDailyUsage(filePath());
    }, 1_000);
  });
}
