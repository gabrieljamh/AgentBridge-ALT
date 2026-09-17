// Salva requisicoes cujo prompt do usuario terminou VAZIO apos extracao.
// Fica em Documents/AgentBridge/empty_prompt.json.
//
// O objetivo e debugar POR QUE o prompt chega vazio: guarda nao so o prompt
// extraido (que ja sabemos que e vazio), mas tambem o corpo bruto completo, as
// mensagens no formato original, o protocolo de entrada, o modelo alvo e o IP
// do cliente. Assim e possivel ver se:
//   - O cliente mandou messages sem role "user" (ex.: so tool_result)
//   - O content era um array so com imagem (stripped pela extracao)
//   - O protocolo (Responses/Anthropic) nao produziu role "user"
//   - O body estava malformed ou com encoding inesperado
//
// O arquivo mantem sempre as 10 entradas mais recentes (FIFO).

import { DATA_DIR_NAME } from '../config.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const FILE_NAME = 'empty_prompt.json';
const MAX_ENTRIES = 10;
const MAX_PREVIEW_CHARS = 20000;

let configuredDirectory: string | null = null;

export function setEmptyPromptDirectory(directory: string) {
  configuredDirectory = directory || null;
}

function emptyPromptDirectory(): string {
  return configuredDirectory
    || process.env.AGENTBRIDGE_ALT_DATA_DIR
    || path.join(homedir(), 'Documents', DATA_DIR_NAME);
}

function emptyPromptPath(): string {
  return path.join(emptyPromptDirectory(), FILE_NAME);
}

export interface EmptyPromptEntry {
  savedAt: string;
  protocol: string;
  clientIp: string;
  requestedModel: string;
  targetModel: string;
  extractedPrompt: string;
  messageCount: number;
  messagesPreview: string;
  bodyPreview: string;
  rawBody: unknown;
}

interface EmptyPromptFile {
  entries: EmptyPromptEntry[];
}

let writeQueue: Promise<void> = Promise.resolve();

async function readEntries(): Promise<EmptyPromptEntry[]> {
  try {
    const raw = await readFile(emptyPromptPath(), 'utf8');
    const parsed: EmptyPromptFile = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

function safeStringify(value: unknown, maxChars: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length > maxChars) {
      return json.slice(0, maxChars) + '\n... [truncado]';
    }
    return json;
  } catch {
    return `[erro ao serializar: ${String(value)}]`;
  }
}

function truncateMessages(body: Record<string, unknown>): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const summary = messages.map((msg: any, i: number) => {
    if (!msg || typeof msg !== 'object') return `[${i}] <invalido: ${typeof msg}>`;
    const role = msg.role || '<sem role>';
    const content = msg.content;
    let contentDesc: string;
    if (typeof content === 'string') {
      const preview = content.slice(0, 500);
      contentDesc = `string(${content.length} chars): "${preview}${content.length > 500 ? '...' : ''}"`;
    } else if (Array.isArray(content)) {
      const types = content.map((part: any) =>
        part?.type || (typeof part === 'string' ? 'string' : typeof part)
      );
      contentDesc = `array[${content.length}]: [${types.join(', ')}]`;
    } else if (content == null) {
      contentDesc = 'null/undefined';
    } else if (typeof content === 'object') {
      contentDesc = `object: ${JSON.stringify(content).slice(0, 200)}`;
    } else {
      contentDesc = `${typeof content}: ${String(content).slice(0, 200)}`;
    }
    const hasToolCalls = msg.tool_calls ? ` tool_calls=${msg.tool_calls.length}` : '';
    const hasToolCallId = msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : '';
    return `[${i}] role=${role} content=${contentDesc}${hasToolCalls}${hasToolCallId}`;
  });
  return summary.join('\n');
}

// [DESLIGADO] saveEmptyPrompt comentado — empty_prompt.json nao sera mais salvo.
// Para reativar, descomente o bloco abaixo.
/*
export function saveEmptyPrompt(entry: {
  protocol: string;
  clientIp: string;
  requestedModel: string;
  targetModel: string;
  extractedPrompt: string;
  body: Record<string, unknown>;
}): Promise<void> {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const directory = emptyPromptDirectory();
      await mkdir(directory, { recursive: true });
      const entries = await readEntries();
      const messageCount = Array.isArray(entry.body?.messages)
        ? entry.body.messages.length
        : 0;
      const newEntry: EmptyPromptEntry = {
        savedAt: new Date().toISOString(),
        protocol: entry.protocol || '',
        clientIp: entry.clientIp || '',
        requestedModel: entry.requestedModel || '',
        targetModel: entry.targetModel || '',
        extractedPrompt: entry.extractedPrompt || '',
        messageCount,
        messagesPreview: truncateMessages(entry.body),
        bodyPreview: safeStringify(entry.body, MAX_PREVIEW_CHARS),
        rawBody: entry.body
      };
      entries.unshift(newEntry);
      const trimmed = entries.slice(0, MAX_ENTRIES);
      const payload = JSON.stringify({ entries: trimmed }, null, 2);
      await writeFile(emptyPromptPath(), payload, 'utf8');
    })
    .catch((error) => {
      if (!process.env.TEST_MOCK_PLAYWRIGHT) {
        console.warn('[AgentBridge] Falha ao salvar empty_prompt.json:', error);
      }
    });

  return writeQueue;
}
*/
