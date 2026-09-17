// Salva as ULTIMAS 10 requisicoes ao modelo em um unico arquivo rotativo.
// Fica em Documents/AgentBridge/last_prompt.json.
//
// Alem do modelo, prompt e resposta, guarda o IP do cliente que fez a request,
// para identificar uso nao autorizado.
//
// O arquivo mantem sempre as 10 entradas mais recentes: cada nova request
// empurra a mais antiga para fora (FIFO).

import { DATA_DIR_NAME } from '../config.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Context } from 'hono';

const FILE_NAME = 'last_prompt.json';
const MAX_ENTRIES = 10;

// Diretorio onde ficam as APIs. No app desktop, main.ts chama
// setLastPromptDirectory() com o caminho exato do Electron (getPath('documents')).
// Em modo standalone, cai no padrao homedir()/Documents/AgentBridge.
let configuredDirectory: string | null = null;

export function setLastPromptDirectory(directory: string) {
  configuredDirectory = directory || null;
}

function lastPromptDirectory(): string {
  return configuredDirectory
    || process.env.AGENTBRIDGE_APIS_DIR
    || path.join(homedir(), 'Documents', DATA_DIR_NAME);
}

function lastPromptPath(): string {
  return path.join(lastPromptDirectory(), FILE_NAME);
}

// Extrai o texto da ultima mensagem do usuario de um corpo OpenAI.
export function extractUserPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | unknown;
    if (!message || typeof message !== 'object') continue;
    if ((message as Record<string, unknown>).role !== 'user') continue;
    return contentToText((message as Record<string, unknown>).content);
  }
  return '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return content == null ? '' : String(content);
}

export interface LastPromptEntry {
  model: string;
  prompt: string;
  response: string;
  clientIp: string;
}

export interface LastPromptEntry {
  savedAt: string;
  model: string;
  prompt: string;
  response: string;
  clientIp: string;
}

interface LastPromptFile {
  entries: LastPromptEntry[];
}

// Fila de escrita para evitar duas gravacoes simultaneas no mesmo arquivo.
let writeQueue: Promise<void> = Promise.resolve();

// Le o arquivo existente (ou retorna array vazio se nao existir/corromper).
async function readEntries(): Promise<LastPromptEntry[]> {
  try {
    const raw = await readFile(lastPromptPath(), 'utf8');
    const parsed: LastPromptFile = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

// Adiciona uma nova entrada no log rotativo mantendo no maximo MAX_ENTRIES.
// A entrada mais recente fica no indice 0 (topo do array).
// Nunca lanca: uma falha ao salvar o log nao pode derrubar a resposta ao cliente.
//
// [DESLIGADO] saveLastPrompt foi comentado a pedido — o last_prompt.json nao sera salvo.
// Para reativar, basta descomentar o bloqueio abaixo.
/*
export function saveLastPrompt(entry: LastPromptEntry): Promise<void> {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const directory = lastPromptDirectory();
      await mkdir(directory, { recursive: true });
      const entries = await readEntries();
      entries.unshift({
        savedAt: new Date().toISOString(),
        model: entry.model || '',
        prompt: entry.prompt || '',
        response: entry.response || '',
        clientIp: entry.clientIp || ''
      });
      // Mantem so as MAX_ENTRIES mais recentes
      const trimmed = entries.slice(0, MAX_ENTRIES);
      const payload = JSON.stringify({ entries: trimmed }, null, 2);
      await writeFile(lastPromptPath(), payload, 'utf8');
    })
    .catch((error) => {
      if (!process.env.TEST_MOCK_PLAYWRIGHT) {
        console.warn('[AgentBridge] Falha ao salvar last_prompt.json:', error);
      }
    });

  return writeQueue;
}
*/

// Extrai o IP do cliente de um Hono Context.
// Em Electron/desktop, usa o IP da conexao TCP. Em dev, pode vir via
// cabecalho x-forwarded-for ou ser '127.0.0.1' (local).
export function extractClientIp(context: Context): string {
  // Cabecalho x-forwarded-for pode vir de proxies reversos
  const forwarded = context.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  // IP real da conexao TCP via @hono/node-server (env.incoming)
  const env = context.env as Record<string, unknown>;
  const incoming = env?.incoming as IncomingMessage | undefined;
  if (incoming?.socket?.remoteAddress) {
    return incoming.socket.remoteAddress;
  }
  // Fallback: cabecalho x-real-ip
  const realIp = context.req.header('x-real-ip');
  if (realIp) return realIp.trim();
  return '';
}