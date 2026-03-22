import fs from 'fs';
import path from 'path';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // Tool call fields (Ollama format)
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  // Tool result field
  name?: string; // tool name, present when role === 'tool'
}

export interface OllamaHistory {
  messages: OllamaMessage[];
  model: string;
}

// History files live alongside Claude .claude/ sessions — same host mount.
// Path inside container: /home/node/.claude/ollama-<sessionId>.json
const HISTORY_DIR = '/home/node/.claude';
const MAX_EXCHANGE_PAIRS = 50;

function historyPath(sessionId: string): string {
  return path.join(HISTORY_DIR, `ollama-${sessionId}.json`);
}

export function loadHistory(sessionId: string): OllamaHistory | null {
  const file = historyPath(sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as OllamaHistory;
  } catch {
    return null;
  }
}

export function saveHistory(
  sessionId: string,
  messages: OllamaMessage[],
  model: string,
): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const data: OllamaHistory = { messages, model };
  fs.writeFileSync(historyPath(sessionId), JSON.stringify(data, null, 2));
}

/**
 * Keep the last MAX_EXCHANGE_PAIRS user/assistant exchange pairs.
 * System message is always preserved at index 0 if present.
 */
export function truncateHistory(messages: OllamaMessage[]): OllamaMessage[] {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Each exchange = 1 user turn + 1 or more assistant/tool turns.
  // Simple approach: keep last MAX_EXCHANGE_PAIRS * 2 non-system messages.
  const keep = MAX_EXCHANGE_PAIRS * 2;
  const trimmed =
    nonSystem.length > keep ? nonSystem.slice(nonSystem.length - keep) : nonSystem;

  return [...systemMsgs, ...trimmed];
}
