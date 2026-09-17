// Salva os ULTIMOS 10 erros detalhados em um unico arquivo rotativo.
// Fica em Documents/AgentBridge/last_errors.json.
//
// Guarda hora, modelo, prompt enviado, mensagem de erro e o corpo do erro
// (status HTTP + corpo bruto retornado pelo upstream ou pelo proxy).
//
// O arquivo mantem sempre as 10 entradas mais recentes: cada novo erro
// empurra o mais antigo para fora (FIFO).

import { DATA_DIR_NAME } from '../config.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const FILE_NAME = 'last_errors.json';
const MAX_ENTRIES = 10;

let configuredDirectory: string | null = null;

export function setLastErrorDirectory(directory: string) {
  configuredDirectory = directory || null;
}

function lastErrorDirectory(): string {
  return configuredDirectory
    || process.env.AGENTBRIDGE_APIS_DIR
    || path.join(homedir(), 'Documents', DATA_DIR_NAME);
}

function lastErrorPath(directory = lastErrorDirectory()): string {
  return path.join(directory, FILE_NAME);
}

export interface LastErrorEntry {
  savedAt: string;
  model: string;
  prompt: string;
  errorMessage: string;
  errorStatus: number;
  errorBody: string;
}

interface LastErrorFile {
  entries: LastErrorEntry[];
}

let writeQueue: Promise<void> = Promise.resolve();

async function readEntries(filePath: string): Promise<LastErrorEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: LastErrorFile = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

// Adiciona uma nova entrada de erro no log rotativo mantendo no maximo MAX_ENTRIES.
// A entrada mais recente fica no indice 0 (topo do array).
// Nunca lanca: uma falha ao salvar o log nao pode derrubar a resposta ao cliente.
//
// [DESLIGADO] saveLastError comentado — last_errors.json nao sera mais salvo.
// Para reativar, descomente o bloco abaixo.
/*
export function saveLastError(entry: LastErrorEntry): Promise<void> {
  const directory = lastErrorDirectory();
  const filePath = lastErrorPath(directory);
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(directory, { recursive: true });
      const entries = await readEntries(filePath);
      entries.unshift({
        savedAt: new Date().toISOString(),
        model: entry.model || '',
        prompt: entry.prompt || '',
        errorMessage: entry.errorMessage || '',
        errorStatus: entry.errorStatus || 0,
        errorBody: entry.errorBody || ''
      });
      const trimmed = entries.slice(0, MAX_ENTRIES);
      const payload = JSON.stringify({ entries: trimmed }, null, 2);
      await writeFile(filePath, payload, 'utf8');
    })
    .catch((error) => {
      if (!process.env.TEST_MOCK_PLAYWRIGHT) {
        console.warn('[AgentBridge] Falha ao salvar last_errors.json:', error);
      }
    });

  return writeQueue;
}
*/
