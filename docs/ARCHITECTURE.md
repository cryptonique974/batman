# NanoClaw Architecture

## System Overview

NanoClaw is a single Node.js process that bridges one or more messaging channels (WhatsApp, Telegram, Discord, Slack, Gmail) to Claude Code agents running inside isolated Linux containers. Inbound messages are stored in SQLite, batched per chat group, formatted into structured XML prompts, and fed to a containerised Claude Code session via stdin. Agent responses stream back through stdout markers and are forwarded to the originating channel. Each registered group has its own container filesystem, session state, and IPC namespace, providing hard isolation between users.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NanoClaw Host Process                        │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐            │
│  │  WhatsApp    │   │  Telegram    │   │  Discord …   │  Channels  │
│  │  (Baileys)   │   │  (channel)   │   │  (channel)   │            │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘            │
│         │  onMessage / onChatMetadata           │                   │
│         └──────────────────┬──────────────────-┘                   │
│                            ▼                                        │
│                     ┌─────────────┐                                 │
│                     │   db.ts     │  SQLite  store/messages.db      │
│                     │  storeMsg   │  chats, messages, sessions,     │
│                     │  storeMeta  │  registered_groups, tasks, …    │
│                     └──────┬──────┘                                 │
│                            │                                        │
│              ┌─────────────▼──────────────┐                         │
│              │       src/index.ts          │                         │
│              │  startMessageLoop (poll)    │                         │
│              │  GroupQueue (serialise)     │                         │
│              │  processGroupMessages       │                         │
│              └──────┬──────────────┬───────┘                         │
│                     │              │                                 │
│           ┌─────────▼──┐    ┌──────▼───────────┐                    │
│           │ router.ts  │    │ container-runner  │                    │
│           │ format XML │    │  spawn container  │                    │
│           │ find chan. │    │  stream output    │                    │
│           └────────────┘    └──────┬────────────┘                    │
│                                    │ docker/podman run -i            │
│                                    ▼                                 │
│              ┌─────────────────────────────────────┐                 │
│              │   Agent Container (per group)        │                 │
│              │   Claude Code CLI / Ollama agent     │                 │
│              │   /workspace/group  (rw)             │                 │
│              │   /workspace/ipc    (rw)             │                 │
│              │   /home/node/.claude (rw, isolated)  │                 │
│              └──────────────┬──────────────────────┘                 │
│                             │ IPC files                              │
│              ┌──────────────▼──────────────┐                         │
│              │        src/ipc.ts            │                         │
│              │   poll data/ipc/<group>/     │                         │
│              │   messages/ tasks/           │                         │
│              └──────────────────────────────┘                         │
│                                                                     │
│  ┌──────────────────┐   ┌───────────────────┐                       │
│  │  task-scheduler  │   │ credential-proxy  │  :3001               │
│  │  getDueTasks()   │   │  (ANTHROPIC_BASE_URL) │                   │
│  │  runTask()       │   │  injects API key  │                       │
│  └──────────────────┘   └───────────────────┘                       │
│                                                                     │
│  ┌────────────────────────────────────────────────┐                 │
│  │              Voice Pipeline (WhatsApp only)     │                 │
│  │  voice note in → transcription.ts (whisper.cpp) │                 │
│  │  text out      → tts-router.ts → tts.ts / tts-voicebox.ts │      │
│  │  ogg/opus      → sock.sendMessage(ptt:true)    │                 │
│  └────────────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Descriptions

### `src/index.ts` — Orchestrator

The main entry point. Initialises all subsystems in order:

1. Ensures the container runtime (Docker/Podman) is running and orphaned containers are cleaned up.
2. Calls `initDatabase()`.
3. Loads persistent state (`last_timestamp`, `last_agent_timestamp`, sessions, registered groups) from SQLite.
4. Starts the credential proxy server.
5. Iterates `getRegisteredChannelNames()`, instantiates each channel via its factory, and calls `channel.connect()`.
6. Starts `startSchedulerLoop`, `startIpcWatcher`, and the `GroupQueue`.
7. Runs `recoverPendingMessages()` to re-queue any messages missed during a crash.
8. Enters `startMessageLoop()` — an infinite poll that calls `getNewMessages()` every `POLL_INTERVAL` (2 s), groups results by chat JID, and enqueues each group for processing via `GroupQueue`.

`processGroupMessages` is the per-group worker: it fetches all unprocessed messages since `lastAgentTimestamp[chatJid]`, formats them with `formatMessages`, and calls `runAgent`. It advances the cursor optimistically and rolls it back on error (unless output was already sent to the user).

### `src/channels/registry.ts` — Channel Registry

A simple in-memory `Map<string, ChannelFactory>`. Channels call `registerChannel(name, factory)` at module load time (via a side-effectful barrel import in `src/channels/index.ts`). The orchestrator reads `getRegisteredChannelNames()` and creates each channel at startup.

### `src/channels/whatsapp.ts` — WhatsApp Channel

Implements the `Channel` interface using the Baileys library (unofficial WhatsApp Web API).

Key responsibilities:
- Manages connection lifecycle, automatic reconnection, and QR code detection.
- Handles LID→phone JID translation (WhatsApp's linked-device addressing).
- On every `messages.upsert` event: stores chat metadata for all chats, stores full message content only for registered groups.
- Detects push-to-talk voice notes (`isVoiceMessage`), transcribes them via `transcribeAudioMessage`, and flags the JID for a voice reply.
- `sendMessage`: if the JID is flagged for a voice reply, calls `synthesizeSpeech` and sends ogg/opus with `ptt:true`; falls back to text on TTS failure.
- Queues outgoing messages while disconnected and flushes on reconnect.
- Syncs group metadata (`groupFetchAllParticipating`) on startup and every 24 h.
- Self-registers via `registerChannel('whatsapp', factory)` at the bottom of the file.

### `src/ipc.ts` — IPC Watcher

Polls `data/ipc/<groupFolder>/messages/` and `data/ipc/<groupFolder>/tasks/` every `IPC_POLL_INTERVAL` (1 s). Containers write JSON files to their namespaced IPC directory; the watcher reads and deletes them.

Authorization model:
- Non-main groups can only send messages to their own chat JID and manage their own tasks.
- Only the main group can register new groups (`register_group`), refresh group metadata (`refresh_groups`), or send messages to arbitrary JIDs.
- `isMain` is determined from the directory path, not from the file contents — containers cannot forge their own identity.

Supported IPC task types: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `refresh_groups`, `register_group`.

### `src/router.ts` — Message Formatter / Outbound Router

Stateless utility functions:

- `formatMessages(messages, timezone)` — Serialises a list of `NewMessage` rows into an XML prompt (`<context timezone="…"/><messages>…</messages>`) that is fed to the agent via stdin.
- `escapeXml(s)` — XML-safe string escaping used by `formatMessages`.
- `formatOutbound(rawText)` — Strips `<internal>…</internal>` blocks from agent output before sending to users.
- `findChannel(channels, jid)` — Returns the first `Channel` that owns a given JID.
- `routeOutbound(channels, jid, text)` — Sends text to the correct channel (throws if none found).

### `src/config.ts` — Configuration Constants

Reads `.env` (via `readEnvFile`) and `process.env`. Exports all tuneable constants used across the codebase. Secrets (API keys, OAuth tokens) are intentionally not read here; they are loaded exclusively by the credential proxy.

See the [Configuration](#configuration) section for the full variable reference.

### `src/container-runner.ts` — Container Lifecycle

Spawns and monitors agent containers.

`runContainerAgent(group, input, onProcess, onOutput)`:
1. Calls `buildVolumeMounts` to assemble the bind-mount list for the group.
2. Calls `buildContainerArgs` to produce the `docker run` / `podman run` argument array (env vars, mounts, user mapping, image name).
3. Spawns the container with `stdio: ['pipe','pipe','pipe']`.
4. Writes the JSON-serialised `ContainerInput` to stdin and closes it.
5. Streams stdout, parsing `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` sentinel pairs as they arrive and calling `onOutput` for each.
6. Resets a hard timeout on each output marker. If no output is received before timeout, the container is stopped gracefully (then force-killed if needed).
7. Resolves with `ContainerOutput` once the process exits.

`buildVolumeMounts` enforces the security model:
- Main group: project root (rw, but `.env` shadowed to `/dev/null`), group folder, global memory (if present).
- Non-main groups: only their own group folder + read-only global memory directory.
- All groups: isolated `.claude/` session directory, isolated IPC directory, per-group copy of `agent-runner-src`.
- Additional mounts from `containerConfig.additionalMounts` are validated against an external allowlist.

`writeTasksSnapshot` and `writeGroupsSnapshot` write JSON files to the group's IPC directory so containers can read task and group state without a database connection.

### `src/task-scheduler.ts` — Scheduled Task Runner

Polls `getDueTasks()` every `SCHEDULER_POLL_INTERVAL` (60 s). For each due task, enqueues it via `GroupQueue.enqueueTask`. The `runTask` function spawns a container agent with `isScheduledTask: true` and streams results to `sendMessage`. After completion, calls `computeNextRun` to advance the task's next execution time and `updateTaskAfterRun` to persist the result.

`computeNextRun` anchors the next interval to the scheduled time (not `Date.now()`) to prevent cumulative drift on interval-based tasks.

### `src/db.ts` — Database Layer

Thin synchronous wrapper around `better-sqlite3`. Manages the schema (with inline migrations for additive column changes), and exposes typed functions for every table. Notable behaviours:

- `initDatabase()` opens `store/messages.db`, runs `createSchema`, and triggers a one-time JSON→SQLite migration for legacy installs.
- `getNewMessages` and `getMessagesSince` filter out bot messages using both the `is_bot_message` flag and a content-prefix backstop for pre-migration rows.
- `getAllRegisteredGroups` validates folder names via `isValidGroupFolder` and silently skips malformed rows.

### `src/transcription.ts` — Speech-to-Text (whisper.cpp)

Downloads the voice note buffer from WhatsApp, converts it from ogg/opus to 16 kHz mono WAV using ffmpeg, and runs `whisper-cli` on the WAV file. Both temp files are cleaned up in a `finally` block. Returns a fallback string on any error so callers can always store a result.

### `src/tts.ts` — Piper TTS Engine

Writes text to a temp file, runs `piper` with the appropriate French or English ONNX model, then converts the WAV output to ogg/opus at 32 kbps using ffmpeg. Returns the ogg buffer. Language is detected by `isFrench()`, which checks for accented characters and common French words.

### `src/tts-voicebox.ts` — Voicebox TTS Engine

POSTs text to a Voicebox HTTP server (`POST /generate/stream`), receives WAV audio, and converts to ogg/opus via ffmpeg. Requires `VOICEBOX_VOICE_FR` and `VOICEBOX_VOICE_EN` profile IDs to be configured; returns `null` immediately if either is missing for the detected language.

### `src/tts-router.ts` — TTS Engine Router

Top-level module for TTS. Imports the correct engine module at startup based on `TTS_ENGINE`. Applies `cleanForTTS` to all text before passing it to the engine — this strips emojis, markdown code fences, bold/italic markers, ATX headers, and list markers. Exports a single `synthesizeSpeech(text)` function used by the WhatsApp channel.

---

## Message Lifecycle

### Inbound → Agent → Outbound

```
1. WhatsApp message arrives (Baileys messages.upsert event)
2. WhatsApp channel calls opts.onChatMetadata → storeChatMetadata (all chats)
3. If chatJid is a registered group:
   a. Text content extracted from normalized message
   b. If voice note: transcribeAudioMessage → "[Voice: <transcript>]"
   c. opts.onMessage → storeMessage (SQLite)
4. startMessageLoop polls getNewMessages every 2 s
5. New messages grouped by chatJid
6. For non-main groups: check TRIGGER_PATTERN (@Batman) in message content
7. If trigger present (or main group): getMessagesSince(lastAgentTimestamp)
8. If container already active for group: pipe formatted XML to container stdin
   (GroupQueue.sendMessage); else enqueue for new container
9. processGroupMessages:
   a. formatMessages → XML prompt
   b. runAgent → runContainerAgent (spawns docker/podman)
   c. ContainerInput written to container stdin
   d. Streaming: OUTPUT_START…OUTPUT_END pairs parsed from stdout
   e. Each result chunk: strip <internal> tags → channel.sendMessage
10. Container exits → lastAgentTimestamp cursor advanced in SQLite
11. channel.sendMessage → sock.sendMessage (Baileys)
```

---

## Voice Pipeline

```
Inbound voice note (ptt=true)
  └─ WhatsApp channel: isVoiceMessage(msg) → true
  └─ transcribeAudioMessage(msg, sock)
       ├─ downloadMediaMessage → Buffer (ogg/opus)
       ├─ ffmpeg: ogg → 16 kHz mono WAV (temp file)
       ├─ whisper-cli: WAV → text transcript
       └─ returns "[Voice: <transcript>]"
  └─ storeMessage with finalContent = "[Voice: <transcript>]"
  └─ voiceReplyJids.add(chatJid)  ← flag for voice reply

Agent processes message, calls channel.sendMessage(chatJid, responseText)
  └─ voiceReplyJids.has(chatJid) → true
  └─ synthesizeSpeech(responseText)   [tts-router.ts]
       ├─ cleanForTTS: strip markdown/emoji
       ├─ isFrench(): select model/profile
       ├─ Piper:     text → WAV → ffmpeg → ogg/opus Buffer
       │  OR
       └─ Voicebox:  POST /generate/stream → WAV → ffmpeg → ogg/opus Buffer
  └─ sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  └─ Falls back to text message if TTS returns null
```

---

## Channel System

Channels implement the `Channel` interface (`src/types.ts`):

```ts
interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

**Self-registration:** Each channel module calls `registerChannel(name, factory)` at the bottom of its file. The barrel file `src/channels/index.ts` imports all channel modules as side effects. When `src/index.ts` imports `'./channels/index.js'`, all channels register themselves before `main()` runs.

**Factory pattern:** Each factory receives `ChannelOpts` (callbacks + `registeredGroups` getter) and returns a `Channel` instance or `null` if credentials are missing. This allows channels to be installed but unconfigured without crashing the process.

**JID routing:** `findChannel(channels, jid)` scans the live channel list and calls `channel.ownsJid(jid)`. WhatsApp owns `*.@g.us` and `*@s.whatsapp.net` JIDs; other channels use their own prefixes (e.g., `dc:` for Discord, `tg:` for Telegram).

---

## Container System

### Spawn Flow

```
runContainerAgent(group, input, onProcess, onOutput)
  ├─ buildVolumeMounts(group, isMain) → VolumeMount[]
  ├─ buildContainerArgs(mounts, containerName, isOllama) → string[]
  │    ├─ docker run -i --rm --name <name>
  │    ├─ -e TZ=<timezone>
  │    ├─ -e ANTHROPIC_BASE_URL=http://host-gateway:3001
  │    ├─ -e ANTHROPIC_API_KEY=placeholder  (or CLAUDE_CODE_OAUTH_TOKEN)
  │    ├─ -e OLLAMA_HOST=...  (if ollama group)
  │    ├─ --add-host host.docker.internal:host-gateway
  │    ├─ --user <hostUid>:<hostGid>
  │    ├─ -v <hostPath>:<containerPath>  (per mount)
  │    └─ nanoclaw-agent:latest
  ├─ spawn(CONTAINER_RUNTIME_BIN, args)
  ├─ stdin.write(JSON.stringify(ContainerInput)); stdin.end()
  └─ stdout streaming: parse OUTPUT_START/END markers → call onOutput
```

### Mounts (per group)

| Mount | Container path | Access |
|---|---|---|
| `groups/<folder>/` | `/workspace/group` | rw |
| `groups/global/` (non-main) | `/workspace/global` | ro |
| Project root (main only) | `/workspace/project` | rw |
| `.env` shadow (main only) | `/workspace/project/.env` | `/dev/null` |
| `data/sessions/<folder>/.claude/` | `/home/node/.claude` | rw |
| `data/ipc/<folder>/` | `/workspace/ipc` | rw |
| `data/sessions/<folder>/agent-runner-src/` | `/app/src` | rw |
| Additional mounts (allowlist-validated) | configured | configured |

### Credential Proxy

Containers are given a placeholder API key or OAuth token and route all Anthropic API calls through `http://host-gateway:3001` (the credential proxy). The proxy injects the real credentials from the host process. Containers never see actual secrets.

### Session Persistence

Each group's Claude Code session ID is stored in the `sessions` table. On the next container invocation, the session ID is passed as `ContainerInput.sessionId` so Claude Code resumes the conversation. If the session ID is invalid (e.g., expired), the error message is detected and the session is deleted so the next run starts fresh.

### IPC Protocol

Containers write JSON files to `/workspace/ipc/messages/<uuid>.json` or `/workspace/ipc/tasks/<uuid>.json`. The host IPC watcher reads and deletes them on the next poll cycle. Failed files are moved to `data/ipc/errors/` for debugging.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ASSISTANT_NAME` | `Batman` | Trigger name (`@Batman`) and bot message prefix |
| `ASSISTANT_HAS_OWN_NUMBER` | — | `true` if bot has a dedicated WhatsApp number (makes `fromMe` reliable for bot detection) |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker/Podman image name |
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Hard timeout per container invocation (ms) |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | Max stdout/stderr buffer before truncation |
| `CREDENTIAL_PROXY_PORT` | `3001` | Port the credential proxy listens on |
| `IDLE_TIMEOUT` | `1800000` (30 min) | Time after last output before container stdin is closed |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Maximum simultaneous running containers |
| `TZ` | system timezone | Timezone for cron expressions and message formatting |
| `FFMPEG_BIN` | `/opt/homebrew/bin/ffmpeg` | Path to ffmpeg binary |
| `WHISPER_BIN` | `/opt/homebrew/bin/whisper-cli` | Path to whisper.cpp CLI binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |
| `TTS_ENGINE` | `piper` | TTS backend: `piper` or `voicebox` |
| `PIPER_BIN` | `/opt/homebrew/bin/piper` | Path to Piper TTS binary |
| `PIPER_MODEL_FR` | `data/models/piper/fr_FR-tom-medium.onnx` | Piper French voice model |
| `PIPER_MODEL_EN` | `data/models/piper/en_US-ryan-medium.onnx` | Piper English voice model |
| `PIPER_LENGTH_SCALE` | `0.8` | Piper speech rate (< 1.0 = faster) |
| `VOICEBOX_URL` | `http://localhost:17493` | Voicebox HTTP server base URL |
| `VOICEBOX_VOICE_FR` | — | Voicebox profile UUID for French voice |
| `VOICEBOX_VOICE_EN` | — | Voicebox profile UUID for English voice |
| `LOG_LEVEL` | — | Set to `debug` or `trace` for verbose container logs |

### macOS launchd (`com.nanoclaw.plist`)

The plist sets `TTS_ENGINE=voicebox`, `VOICEBOX_URL`, `VOICEBOX_VOICE_FR`, `VOICEBOX_VOICE_EN`, and `PATH`/`HOME`. All other variables are read from `.env` or their compiled defaults.

Logs: `logs/nanoclaw.log` (stdout), `logs/nanoclaw.error.log` (stderr).

---

## Database Schema

Database file: `store/messages.db` (SQLite via `better-sqlite3`).

### `chats`

Stores metadata for every chat seen by any channel. Used for group discovery without storing message content for unregistered groups.

| Column | Type | Notes |
|---|---|---|
| `jid` | TEXT PK | Unique chat identifier (WhatsApp JID, `dc:…`, `tg:…`, etc.) |
| `name` | TEXT | Display name of the chat or group |
| `last_message_time` | TEXT | ISO 8601 timestamp of most recent activity |
| `channel` | TEXT | Channel name (`whatsapp`, `discord`, `telegram`, …) |
| `is_group` | INTEGER | `1` if group chat, `0` if direct |

Special row: `jid = '__group_sync__'` records the last time WhatsApp group metadata was synced.

### `messages`

Full message content, stored only for registered groups.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Message ID from the channel |
| `chat_jid` | TEXT FK→chats | Chat this message belongs to |
| `sender` | TEXT | Sender JID |
| `sender_name` | TEXT | Display name |
| `content` | TEXT | Message text (voice notes stored as `[Voice: <transcript>]`) |
| `timestamp` | TEXT | ISO 8601 |
| `is_from_me` | INTEGER | `1` if sent by the bot |
| `is_bot_message` | INTEGER | `1` if this is a bot outgoing message (excluded from agent prompts) |

Index: `idx_timestamp` on `timestamp` for efficient range queries.

### `registered_groups`

Groups that NanoClaw actively monitors and responds to.

| Column | Type | Notes |
|---|---|---|
| `jid` | TEXT PK | Chat JID |
| `name` | TEXT | Human-readable group name |
| `folder` | TEXT UNIQUE | Filesystem folder name under `groups/` |
| `trigger_pattern` | TEXT | Trigger keyword stored for reference |
| `added_at` | TEXT | ISO 8601 registration timestamp |
| `container_config` | TEXT | JSON blob (`additionalMounts`, `timeout`, etc.) |
| `requires_trigger` | INTEGER | `1` if trigger required to wake agent (default), `0` for always-on |
| `is_main` | INTEGER | `1` for the main privileged group |
| `model_provider` | TEXT | `claude` or `ollama` |
| `ollama_model` | TEXT | Ollama model name when `model_provider=ollama` |

### `sessions`

Persistent Claude Code session IDs, one per group folder.

| Column | Type | Notes |
|---|---|---|
| `group_folder` | TEXT PK | Matches `registered_groups.folder` |
| `session_id` | TEXT | Claude Code session UUID |

### `scheduled_tasks`

Agent-defined recurring or one-shot tasks.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Unique task ID |
| `group_folder` | TEXT | Owning group |
| `chat_jid` | TEXT | Target chat for task output |
| `prompt` | TEXT | Prompt sent to the agent when the task fires |
| `schedule_type` | TEXT | `cron`, `interval`, or `once` |
| `schedule_value` | TEXT | Cron expression, ms interval, or ISO 8601 datetime |
| `context_mode` | TEXT | `isolated` (fresh session) or `group` (reuse group session) |
| `next_run` | TEXT | ISO 8601 next execution time |
| `last_run` | TEXT | ISO 8601 last execution time |
| `last_result` | TEXT | Truncated result of last run |
| `status` | TEXT | `active`, `paused`, or `completed` |
| `created_at` | TEXT | ISO 8601 creation time |

Indexes: `idx_next_run`, `idx_status`.

### `task_run_logs`

Execution history for scheduled tasks.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `task_id` | TEXT FK→scheduled_tasks | |
| `run_at` | TEXT | ISO 8601 |
| `duration_ms` | INTEGER | Wall-clock duration |
| `status` | TEXT | `success` or `error` |
| `result` | TEXT | Agent output (nullable) |
| `error` | TEXT | Error message (nullable) |

Index: `idx_task_run_logs` on `(task_id, run_at)`.

### `router_state`

Key-value store for persistent orchestrator state.

| Key | Value |
|---|---|
| `last_timestamp` | Highest message timestamp seen by the poll loop (prevents re-processing on restart) |
| `last_agent_timestamp` | JSON object `{ [chatJid]: timestamp }` — per-group cursor for agent invocations |
