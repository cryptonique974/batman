/**
 * Ollama backend for NanoClaw.
 * Called instead of the Claude SDK when a group's modelProvider is 'ollama'.
 *
 * Flow per turn:
 *   1. Load CLAUDE.md(s) as system message
 *   2. Load/create session history
 *   3. Spawn ipc-mcp-stdio.js, MCP handshake, collect tool definitions
 *   4. POST to Ollama (/api/chat, streaming NDJSON)
 *   5. Handle tool_use via MCP tools/call loop
 *   6. Save history, emit sentinel output
 *   7. Wait for next IPC message or _close, repeat
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { loadHistory, saveHistory, truncateHistory, OllamaMessage } from './ollama-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ContainerInput shape (mirrors index.ts)
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  modelProvider?: 'claude' | 'ollama';
  ollamaModel?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// --- Output ---

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[ollama-runner] ${message}`);
}


// --- MCP client over stdio ---

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

class McpClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<number, (result: unknown) => void>();
  private nextId = 1;

  constructor(scriptPath: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn('node', [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg.result ?? msg.error);
            this.pending.delete(msg.id);
          }
        } catch { /* non-JSON line, ignore */ }
      }
    });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin!.write(msg);
    });
  }

  async initialize(chatJid: string, groupFolder: string, isMain: boolean): Promise<void> {
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'nanoclaw-ollama', version: '1.0.0' },
    });
    // Inject context so the MCP server knows which group it's serving
    (this.proc as ChildProcess & { env?: Record<string,string> });
    // env is already set via spawn — just store context for tools/call payloads
    this._chatJid = chatJid;
    this._groupFolder = groupFolder;
    this._isMain = isMain;
  }
  _chatJid = '';
  _groupFolder = '';
  _isMain = false;

  async listTools(): Promise<McpTool[]> {
    const result = await this.call('tools/list', {}) as { tools?: McpTool[] } | undefined;
    return (result as { tools?: McpTool[] })?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.call('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
    } | undefined;
    if (!result) return '';
    return (result as { content?: Array<{ type: string; text?: string }> }).content
      ?.filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('') ?? '';
  }

  destroy(): void {
    try { this.proc.stdin!.end(); this.proc.kill(); } catch { /* ignore */ }
  }
}

function mcpToolsToOllama(tools: McpTool[]): OllamaTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// --- Ollama streaming API ---

interface OllamaStreamChunk {
  model: string;
  message?: {
    role: string;
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: string;
}

async function* streamOllamaChat(
  ollamaHost: string,
  model: string,
  messages: OllamaMessage[],
  tools: OllamaTool[],
): AsyncGenerator<OllamaStreamChunk> {
  const url = `${ollamaHost}/api/chat`;
  const body = JSON.stringify({ model, messages, tools, stream: true });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '(no body)');
    throw new Error(`Ollama API error ${res.status}: ${errText}`);
  }

  let buf = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      yield JSON.parse(line) as OllamaStreamChunk;
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim()) as OllamaStreamChunk;
}

// --- Single Ollama turn (prompt → response, with tool call loop) ---

async function runOllamaTurn(
  ollamaHost: string,
  model: string,
  history: OllamaMessage[],
  userMessage: string,
  mcp: McpClient,
  ollamaTools: OllamaTool[],
): Promise<{ assistantText: string; updatedHistory: OllamaMessage[] }> {
  const messages: OllamaMessage[] = truncateHistory([
    ...history,
    { role: 'user', content: userMessage },
  ]);

  let assistantText = '';

  // Tool call loop: may run multiple turns if model calls tools
  while (true) {
    let accContent = '';
    const accToolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

    for await (const chunk of streamOllamaChat(ollamaHost, model, messages, ollamaTools)) {
      if (chunk.message?.content) accContent += chunk.message.content;
      if (chunk.message?.tool_calls?.length) accToolCalls.push(...chunk.message.tool_calls);
      if (chunk.done) break;
    }

    // Append assistant message to the working message list
    const assistantMsg: OllamaMessage = {
      role: 'assistant',
      content: accContent,
      ...(accToolCalls.length ? { tool_calls: accToolCalls } : {}),
    };
    messages.push(assistantMsg);

    if (accContent) assistantText += accContent;

    if (accToolCalls.length === 0) break; // No tool calls → final answer

    // Execute all tool calls via MCP and collect results
    for (const tc of accToolCalls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments ?? {};
      log(`Calling tool: ${toolName}`);
      let toolResult: string;
      try {
        toolResult = await mcp.callTool(toolName, toolArgs);
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: 'tool', content: toolResult, name: toolName });
    }
    // Loop back to send tool results to Ollama
  }

  return { assistantText, updatedHistory: messages };
}

// --- Build system message from CLAUDE.md files ---

function buildSystemMessage(containerInput: ContainerInput): string {
  const parts: string[] = [];

  // Group-specific CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8').trim());
  }

  // Global CLAUDE.md (non-main groups only, same logic as Claude path)
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      parts.push(fs.readFileSync(globalClaudeMd, 'utf-8').trim());
    }
  }

  return parts.join('\n\n---\n\n');
}

// --- Main entry point ---

export async function runOllamaLoop(containerInput: ContainerInput): Promise<void> {
  const model = containerInput.ollamaModel ?? 'llama3.2';
  const ollamaHost = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const sessionId = containerInput.sessionId ?? randomUUID();

  log(`Starting Ollama loop: model=${model}, session=${sessionId}`);

  // Load or create history
  const existing = loadHistory(sessionId);
  let history: OllamaMessage[] = existing?.messages ?? [];

  // Inject system message at position 0 (always fresh from CLAUDE.md)
  const systemContent = buildSystemMessage(containerInput);
  if (systemContent) {
    history = [
      { role: 'system', content: systemContent },
      ...history.filter(m => m.role !== 'system'),
    ];
  }

  // Spawn MCP server (ipc-mcp-stdio.js)
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const mcpEnv = {
    ...process.env,
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  };
  const mcp = new McpClient(mcpServerPath, mcpEnv);

  try {
    await mcp.initialize(containerInput.chatJid, containerInput.groupFolder, containerInput.isMain);
    const mcpTools = await mcp.listTools();
    const ollamaTools = mcpToolsToOllama(mcpTools);
    log(`MCP tools loaded: ${mcpTools.map(t => t.name).join(', ')}`);

    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    // Single-turn: process the prompt and exit.
    // History continuity is maintained via the JSON file — no need to keep
    // the container alive. Staying alive causes the host to pipe back the
    // bot's own outgoing messages, which Ollama would respond to in a loop.
    log(`Running turn (session: ${sessionId})...`);

    const { assistantText, updatedHistory } = await runOllamaTurn(
      ollamaHost, model, history, prompt, mcp, ollamaTools,
    );

    saveHistory(sessionId, updatedHistory, model);

    writeOutput({
      status: 'success',
      result: assistantText || null,
      newSessionId: sessionId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Ollama error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  } finally {
    mcp.destroy();
  }
}
