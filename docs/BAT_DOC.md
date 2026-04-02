# BAT_DOC — Documentation technique de NanoClaw

Documentation développeur exhaustive. Complète le README et les CLAUDE.md.

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture globale](#2-architecture-globale)
3. [Flux de données](#3-flux-de-données)
4. [Fichiers source (`src/`)](#4-fichiers-source-src)
5. [Container agent (`container/`)](#5-container-agent-container)
6. [Variables d'environnement](#6-variables-denvironnement)
7. [Base de données SQLite](#7-base-de-données-sqlite)
8. [Protocoles IPC](#8-protocoles-ipc)
9. [Sécurité des mounts](#9-sécurité-des-mounts)
10. [Dépendances clés](#10-dépendances-clés)
11. [Commandes utiles développeur](#11-commandes-utiles-développeur)

---

## 1. Vue d'ensemble

NanoClaw est un assistant Claude personnel fonctionnant comme **un seul processus Node.js**. Il écoute les messages WhatsApp (et potentiellement d'autres canaux), les route vers des agents Claude SDK tournant dans des **conteneurs Docker éphémères** (ou Apple Container sur macOS), et renvoie les réponses.

Chaque groupe a un **filesystem isolé** (`groups/{nom}/`) et une **mémoire indépendante**. Un groupe spécial appelé `main` a des droits élevés (accès au projet entier, gestion des autres groupes).

Tout est single-process, single-threaded (async). Pas de microservices.

---

## 2. Architecture globale

```
┌─────────────────────────────────────────────────────────┐
│                    Processus hôte Node.js               │
│                                                         │
│  WhatsAppChannel ──► MessageLoop ──► GroupQueue         │
│       │                                    │            │
│       │ (Baileys lib)              ContainerRunner      │
│       │                                    │            │
│  SQLite DB ◄──────────────────────────────┘            │
│       │                                                 │
│  IpcWatcher ◄── data/ipc/{group}/messages/*.json        │
│  Scheduler  ──► runTask() ──► ContainerRunner           │
│  CredentialProxy (port 3001)                            │
└──────────────────────────┬──────────────────────────────┘
                           │ container run (stdin/stdout)
              ┌────────────▼────────────────┐
              │     Container (VM Linux)     │
              │                             │
              │  agent-runner/src/index.ts  │
              │       ├── Claude SDK query()│
              │       └── IPC MCP Server    │
              │  /workspace/group/          │
              │  /workspace/ipc/            │
              └─────────────────────────────┘
```

---

## 3. Flux de données

### Message entrant (texte)

```
main()
  ├── ensureContainerRuntimeRunning()   // vérifie que Docker/container tourne
  ├── initDatabase()                    // SQLite
  ├── loadState()                       // charge sessions, groupes, curseurs depuis DB
  ├── startCredentialProxy()            // proxy HTTP port 3001 (credentials containers)
  ├── connectChannels()                 // instancie et connecte chaque canal
  ├── startSchedulerLoop()              // tâches planifiées
  ├── startIpcWatcher()                 // lit les fichiers IPC des conteneurs
  ├── recoverPendingMessages()          // reprend les messages non traités après crash
  └── startMessageLoop()               // boucle principale (poll DB toutes les POLL_INTERVAL ms)
```

```
WhatsApp (Baileys)
  └── sock.ev.on('messages.upsert')
        ├── normalizeMessageContent()    // unwrap ephemeral, viewOnce, etc.
        ├── translateJid()              // LID → phone JID (WhatsApp Privacy)
        ├── onChatMetadata()            // stocke le chat dans DB (découverte de groupes)
        └── onMessage()                 // si le groupe est enregistré :
              └── storeMessage() → DB messages

startMessageLoop()  [poll toutes les POLL_INTERVAL ms]
  └── getNewMessages(registeredJids, lastTimestamp)
        ├── si requiresTrigger && pas de "@batman" → skip
        ├── si container actif → pipe le message (stdin du container existant)
        └── sinon → queue.enqueueMessageCheck(chatJid)

processGroupMessages(chatJid)
  ├── getMessagesSince(lastAgentTimestamp)  // tous les msgs depuis le dernier traitement
  ├── formatMessages()                      // mise en forme XML pour le prompt Claude
  ├── runAgent()
  │     ├── writeTasksSnapshot()            // JSON tâches → IPC dir
  │     ├── writeGroupsSnapshot()           // JSON groupes → IPC dir
  │     └── runContainerAgent()             // spawn docker run ...
  │           ├── stdin ← JSON(input)
  │           ├── stdout → parse OUTPUT_START/END markers (streaming)
  │           └── résolution session ID (Claude Code SDK)
  └── channel.sendMessage(response)
```

**Deux curseurs** :
- `lastTimestamp` : "vu par la boucle" — avance dès réception
- `lastAgentTimestamp[chatJid]` : "traité par l'agent" — avance après réponse réussie. En cas d'erreur : rollback pour retry.

**JID** : identifiant unique WhatsApp.
- DM : `5219983186424@s.whatsapp.net`
- Groupe : `120363XXXXXXXX@g.us`
- LID : `55032070336737@lid` (nouveau format privacy de WA → traduit en phone JID)

### Message vocal

1. WhatsApp → `downloadMediaMessage()` → buffer OGG
2. `transcribeAudio()` → ffmpeg → Whisper → texte
3. Contenu stocké comme `[Voice: {transcript}]`
4. Si la réponse est aussi vocale → `textToSpeech()` → OGG → `channel.sendAudio()`

### Tâche planifiée

1. Agent écrit `/workspace/ipc/tasks/{file}.json` (type: `schedule_task`)
2. `startIpcWatcher()` détecte le fichier → `createTask()` → SQLite
3. `startSchedulerLoop()` poll toutes les 60s → `getDueTasks()`
4. `queue.enqueueTask()` → `runTask()` → `runContainerAgent()`

---

## 4. Fichiers source (`src/`)

---

### `src/index.ts` — Orchestrateur principal

**Point d'entrée de l'application.** Gère l'état global, la boucle de messages, et coordonne tous les sous-systèmes.

#### Variables globales

| Variable | Type | Rôle |
|----------|------|------|
| `lastTimestamp` | `string` | Timestamp ISO du dernier message vu (curseur global) |
| `sessions` | `Record<string, string>` | Map `groupFolder → sessionId` des sessions Claude actives |
| `registeredGroups` | `Record<string, RegisteredGroup>` | Map `chatJid → RegisteredGroup` des groupes enregistrés |
| `lastAgentTimestamp` | `Record<string, string>` | Map `chatJid → timestamp` du dernier message traité par l'agent |
| `messageLoopRunning` | `boolean` | Guard pour éviter de lancer deux boucles |
| `voiceSourceByChat` | `Map<string, boolean>` | Si le dernier message du chat était vocal (pour répondre en audio) |
| `channels` | `Channel[]` | Liste de tous les canaux actifs |
| `queue` | `GroupQueue` | File de traitement concurrent des groupes |

#### Fonctions

**`isVoiceTrigger(content, triggerName)`**
Retourne `true` si le message est une note vocale (`[Voice:...]`) contenant le nom du bot ou un variant phonétique proche. Utilise une fenêtre glissante avec distance de Hamming ≤ 1 pour tolérer les erreurs de transcription Whisper (ex: "batman" → "but man").

**`loadState()`**
Charge depuis SQLite : `lastTimestamp`, `lastAgentTimestamp`, `sessions`, `registeredGroups`. Appelé au démarrage.

**`saveState()`**
Persiste `lastTimestamp` et `lastAgentTimestamp` dans SQLite.

**`registerGroup(jid, group)`**
Enregistre un nouveau groupe : stocke en DB, crée le dossier `groups/{folder}/logs/`.

**`getAvailableGroups()`**
Retourne tous les chats connus avec leur statut d'enregistrement, triés par activité récente.

**`processGroupMessages(chatJid)`** ← fonction centrale
- Récupère les messages non traités depuis `lastAgentTimestamp[chatJid]`
- Vérifie la présence du trigger (texte ou vocal)
- Avance le curseur `lastAgentTimestamp`
- Lance `runAgent()` avec callback streaming
- Si réponse vocale → `textToSpeech()` + `sendAudio()`, sinon `sendMessage()`
- En cas d'erreur sans output envoyé → rollback du curseur pour retry

**`runAgent(group, prompt, chatJid, onOutput?)`**
- Écrit les snapshots tasks/groups pour le container
- Appelle `runContainerAgent()` avec callback wrappé qui capture le `newSessionId`
- Persiste le nouveau sessionId en DB

**`startMessageLoop()`**
Boucle infinie (interval 2s) :
1. `getNewMessages()` → nouveaux messages
2. Déduplique par groupe
3. Vérifie trigger → soit pipe dans container actif via `queue.sendMessage()`, soit `queue.enqueueMessageCheck()`

**`recoverPendingMessages()`**
Au démarrage, vérifie si des messages n'ont pas été traités (crash entre advancement du curseur et traitement). Si oui, re-enqueue.

**`ensureContainerRuntimeRunning()`**
Vérifie que le runtime container est démarré. Si non, le démarre. Nettoie aussi les containers orphelins `nanoclaw-*` de la run précédente.

---

### `src/channels/whatsapp.ts` — Canal WhatsApp

Implémente l'interface `Channel` via la librairie `@whiskeysockets/baileys`.

#### Interface `WhatsAppChannelOpts`

| Champ | Rôle |
|-------|------|
| `onMessage` | Callback appelé pour chaque message entrant |
| `onChatMetadata` | Callback appelé pour les métadonnées de chat (découverte de groupes) |
| `registeredGroups` | Getter des groupes enregistrés (pour filtrage) |

#### Classe `WhatsAppChannel`

**Propriétés privées**

| Propriété | Rôle |
|-----------|------|
| `sock` | Socket Baileys (connexion WebSocket WhatsApp) |
| `connected` | État de la connexion |
| `lidToPhoneMap` | Cache de traduction LID→phone JID |
| `outgoingQueue` | Messages en attente d'envoi si déconnecté |
| `flushing` | Guard pour flush de la queue |
| `groupSyncTimerStarted` | Guard pour éviter de créer plusieurs timers de sync |

**Constante**
- `GROUP_SYNC_INTERVAL_MS` = 24h — fréquence de synchronisation des métadonnées de groupes

**`connect()`** / **`connectInternal(onFirstOpen?)`**
Initialise la connexion WhatsApp via auth multi-fichiers (`store/auth/`). Configure :
- `connection.update` : gestion QR code, reconnexion auto, flush queue, sync groupes
- `creds.update` : sauvegarde des credentials
- `messages.upsert` : traitement des messages entrants

**`sendMessage(jid, text)`**
Envoie un message texte. Si déconnecté, met en queue.

**`sendAudio(jid, buffer, mimetype?)`**
Envoie un buffer audio en tant que voice note WhatsApp (`ptt: true`).

**`setTyping(jid, isTyping)`**
Envoie un indicateur de frappe (`composing`/`paused`) via `sendPresenceUpdate`.

**`syncGroupMetadata(force?)`**
Récupère les noms de tous les groupes depuis WhatsApp via `groupFetchAllParticipating()`. Respecte un cache de 24h. Appelé au démarrage et périodiquement.

**`translateJid(jid)`** (privé)
Traduit un JID format LID (`xxx@lid`) vers le format phone standard (`xxx@s.whatsapp.net`). Consulte le cache local puis `signalRepository.lidMapping`.

**`flushOutgoingQueue()`** (privé)
Vide la queue des messages en attente après reconnexion.

**Détection de message bot**
- Avec numéro dédié (`ASSISTANT_HAS_OWN_NUMBER=true`) : `fromMe` suffit
- Self-chat (remoteJid = numéro du bot) : jamais considéré comme message bot (tous les messages sont fromMe=true, mais c'est l'owner qui parle)
- Groupes sans numéro dédié : le message commence par `ASSISTANT_NAME:`

---

### `src/channels/registry.ts` — Registre des canaux

Système de plugins auto-enregistrés :

```typescript
// Chaque canal fait ça en bas de son fichier :
registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
```

Au démarrage, `src/channels/index.ts` importe tous les canaux (barrel file), ce qui déclenche leur auto-registration. Un canal est **actif** uniquement si ses credentials sont présents dans `.env`.

---

### `src/config.ts` — Configuration globale

Lit les valeurs depuis `.env` (via `readEnvFile`) et les expose comme constantes.

#### Constantes exportées

**Identité du bot**

| Constante | Défaut | Rôle |
|-----------|--------|------|
| `ASSISTANT_NAME` | `'Andy'` | Nom du bot, utilisé dans le trigger pattern |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | Si `true`, le bot a son propre numéro WhatsApp |
| `MESSAGE_PREFIX` | `'Andy: '` | Préfixe des messages sortants (vide string = désactivé) |
| `MESSAGE_EMOJI` | `''` | Emoji ajouté à la fin des messages |

**Timers**

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `POLL_INTERVAL` | 2000ms | Fréquence de la boucle de messages |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | Fréquence du scheduler |
| `IPC_POLL_INTERVAL` | 1000ms | Fréquence de poll des fichiers IPC |
| `IDLE_TIMEOUT` | 1800000ms (30min) | Durée max sans output avant fermeture du container |
| `CONTAINER_TIMEOUT` | 1800000ms | Timeout hard du container |

**Container**

| Constante | Défaut | Rôle |
|-----------|--------|------|
| `CONTAINER_IMAGE` | `'nanoclaw-agent:latest'` | Image container à utiliser |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | Taille max du stdout/stderr capturé |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Nombre max de containers simultanés |

**Chemins**

| Constante | Chemin | Rôle |
|-----------|--------|------|
| `STORE_DIR` | `./store` | Auth WhatsApp + DB SQLite |
| `GROUPS_DIR` | `./groups` | Dossiers par groupe |
| `DATA_DIR` | `./data` | Sessions Claude, IPC, snapshots |
| `MAIN_GROUP_FOLDER` | `'main'` | Nom du dossier du groupe principal |
| `MOUNT_ALLOWLIST_PATH` | `~/.config/nanoclaw/mount-allowlist.json` | Allowlist sécurité mounts additionnels |

**Pattern**
- `TRIGGER_PATTERN` : RegExp `/@Andy\b/i` — matchant le nom du bot
- `TIMEZONE` : Timezone système (pour cron)

---

### `src/env.ts` — Parseur de fichier .env

**`readEnvFile(keys)`**
Parse le fichier `.env` du CWD et retourne un objet avec les valeurs des clés demandées. **Ne modifie pas `process.env`** (les secrets ne doivent pas être visibles par les processus enfants). Supporte les valeurs entre guillemets simples ou doubles.

---

### `src/types.ts` — Interfaces TypeScript

#### `Channel`

Interface abstraite pour un canal de communication.

| Méthode | Rôle |
|---------|------|
| `name` | Nom du canal (ex: `'whatsapp'`) |
| `connect()` | Établit la connexion |
| `sendMessage(jid, text)` | Envoie un message texte |
| `isConnected()` | Retourne l'état de connexion |
| `ownsJid(jid)` | Retourne `true` si ce canal possède ce JID |
| `disconnect()` | Ferme la connexion |
| `setTyping?(jid, isTyping)` | Indicateur de frappe (optionnel) |
| `sendAudio?(jid, buffer, mimetype?)` | Envoie un audio (optionnel) |
| `syncGroups?(force)` | Resync metadata (optionnel) |

#### `RegisteredGroup`

| Champ | Rôle |
|-------|------|
| `name` | Nom affiché du groupe |
| `folder` | Nom du dossier (ex: `'family-chat'`) |
| `trigger` | Mot déclencheur (ex: `'@Andy'`) |
| `added_at` | Date d'enregistrement ISO |
| `containerConfig?` | Config container (mounts, timeout, MCP servers) |
| `requiresTrigger?` | Si `false`, le bot répond à tous les messages |
| `isMain?` | Si `true`, groupe avec droits élevés |
| `modelProvider?` | `'claude'` (défaut) ou `'ollama'` |
| `ollamaModel?` | Nom du modèle Ollama (ex: `'llama3.2'`) |

#### `ContainerConfig`

| Champ | Rôle |
|-------|------|
| `additionalMounts?` | Mounts additionnels (validés contre l'allowlist) |
| `timeout?` | Timeout container en ms |
| `mcpServers?` | Noms des serveurs MCP à activer (depuis `.mcp.json`) |

#### `NewMessage`

| Champ | Rôle |
|-------|------|
| `id` | ID unique du message |
| `chat_jid` | JID du chat |
| `sender` | JID de l'expéditeur |
| `sender_name` | Nom d'affichage de l'expéditeur |
| `content` | Contenu du message (texte ou `[Voice: ...]`) |
| `timestamp` | Timestamp ISO |
| `is_from_me?` | Message envoyé depuis notre compte |
| `is_bot_message?` | Message envoyé par le bot |

#### `ScheduledTask`

| Champ | Rôle |
|-------|------|
| `id` | ID unique de la tâche |
| `group_folder` | Groupe propriétaire |
| `chat_jid` | JID cible pour les messages |
| `prompt` | Prompt envoyé à l'agent |
| `schedule_type` | `'cron'`, `'interval'`, ou `'once'` |
| `schedule_value` | Expression cron, ms, ou timestamp ISO |
| `context_mode` | `'group'` (avec historique) ou `'isolated'` (session fraîche) |
| `next_run` | Prochain run ISO |
| `status` | `'active'`, `'paused'`, ou `'completed'` |

#### `MountAllowlist`

| Champ | Rôle |
|-------|------|
| `allowedRoots` | Répertoires autorisés pour les mounts |
| `blockedPatterns` | Patterns de chemin toujours bloqués |
| `nonMainReadOnly` | Si `true`, force read-only pour les groupes non-main |

---

### `src/db.ts` — Couche base de données SQLite

Singleton `better-sqlite3` initialisé via `initDatabase()`. DB à `store/messages.db`.

#### Fonctions exportées

**Chats**
- `storeChatMetadata(chatJid, timestamp, name?, channel?, isGroup?)` — Upsert métadonnées d'un chat
- `updateChatName(chatJid, name)` — Met à jour le nom d'un chat
- `getAllChats()` — Tous les chats triés par activité
- `getLastGroupSync()` / `setLastGroupSync()` — Timestamp de la dernière sync de groupes

**Messages**
- `storeMessage(msg)` — Stocke un message
- `getNewMessages(jids, lastTimestamp, botPrefix)` — Messages depuis un timestamp pour plusieurs JIDs
- `getMessagesSince(chatJid, sinceTimestamp, botPrefix)` — Messages depuis un timestamp pour un chat

**Tâches planifiées**
- `createTask(task)` / `getTaskById(id)` / `getTasksForGroup(groupFolder)` / `getAllTasks()`
- `updateTask(id, updates)` / `deleteTask(id)`
- `getDueTasks()` — Tâches actives dont `next_run <= now`
- `updateTaskAfterRun(id, nextRun, lastResult)` — Post-exécution
- `logTaskRun(log)` — Enregistre un run de tâche

**État du routeur**
- `getRouterState(key)` / `setRouterState(key, value)` — KV store persistant

**Sessions**
- `getSession(groupFolder)` / `setSession(groupFolder, sessionId)` / `deleteSession(groupFolder)` / `getAllSessions()`

**Groupes enregistrés**
- `getRegisteredGroup(jid)` / `setRegisteredGroup(jid, group)` / `getAllRegisteredGroups()`

---

### `src/router.ts` — Formatage et routage des messages

**`formatMessages(messages)`**
Formate un tableau de `NewMessage` en XML :
```xml
<messages>
  <message sender="Alice" time="2026-01-01T12:00:00.000Z">Hello</message>
</messages>
```

**`stripInternalTags(text)`**
Supprime les blocs `<internal>...</internal>` de l'output agent (raisonnement interne non destiné à l'utilisateur).

**`routeOutbound(channels, jid, text)`**
Trouve le canal propriétaire du JID et envoie le message.

---

### `src/container-runner.ts` — Gestion des containers

#### `ContainerInput` — Envoyé via stdin JSON

| Champ | Rôle |
|-------|------|
| `prompt` | Messages formatés (XML) |
| `sessionId?` | ID de session Claude à reprendre |
| `groupFolder` | Dossier du groupe |
| `chatJid` | JID du chat |
| `isMain` | Si c'est le groupe principal |
| `isScheduledTask?` | Si c'est une tâche planifiée |
| `assistantName?` | Nom de l'assistant |
| `modelProvider?` | `'claude'` ou `'ollama'` |
| `ollamaModel?` | Nom du modèle Ollama |

#### `ContainerOutput` — Parsé depuis stdout du container

| Champ | Rôle |
|-------|------|
| `status` | `'success'` ou `'error'` |
| `result` | Texte de réponse (null si pas de réponse) |
| `newSessionId?` | Nouveau sessionId Claude |
| `error?` | Message d'erreur |

#### Fonctions

**`buildVolumeMounts(group, isMain)`**
Construit la liste des mounts pour le container :

| Mount (hôte) | Mount (container) | RW | Condition |
|--------------|-------------------|----|-----------|
| `./` (projet entier) | `/workspace/project` | ✓ | main seulement |
| `groups/{folder}` | `/workspace/group` | ✓ | toujours |
| `groups/global` | `/workspace/global` | ✗ | non-main seulement |
| `data/sessions/{folder}/.claude` | `/home/node/.claude` | ✓ | toujours |
| `data/ipc/{folder}` | `/workspace/ipc` | ✓ | toujours |
| `data/sessions/{folder}/agent-runner-src` | `/app/src` | ✗ | toujours (bypass cache BuildKit) |
| mounts additionnels validés | `/workspace/extra/{name}` | selon allowlist | si `containerConfig.additionalMounts` |

Crée aussi `settings.json` dans `.claude/` avec les feature flags Claude Code :
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'`
- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1'`
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0'`

Synchronise les skills depuis `container/skills/` vers `.claude/skills/` de chaque groupe.

**`runContainerAgent(group, input, onProcess, onOutput?)`**
Orchestre l'exécution d'un container :
1. Crée les dossiers nécessaires
2. Construit mounts et args
3. `spawn('docker', args)` (ou `container` sur Apple Container) → process
4. Écrit l'input JSON sur stdin du process
5. Parse le stdout en streaming via les markers sentinelles
6. Gère timeout hard + timeout d'inactivité
7. Écrit un log dans `groups/{folder}/logs/`

**`writeTasksSnapshot(groupFolder, isMain, tasks)`**
Écrit `data/ipc/{folder}/current_tasks.json` pour que le container puisse lire la liste des tâches.

**`writeGroupsSnapshot(groupFolder, isMain, groups, registeredJids)`**
Écrit `data/ipc/{folder}/available_groups.json`. Seul le groupe main voit tous les groupes.

#### Credentials proxy (port 3001)

Les containers ne voient **jamais** les vraies clés API. Ils reçoivent :
- `ANTHROPIC_BASE_URL=http://host-gateway:3001`
- `ANTHROPIC_API_KEY=placeholder` ou `CLAUDE_CODE_OAUTH_TOKEN=placeholder`

Le proxy intercepte les requêtes et injecte les vraies credentials depuis le host.

#### Protocole stdin/stdout

- **Entrée** : JSON envoyé sur stdin (`ContainerInput`)
- **Sortie** : blocs délimités par des sentinelles :
  ```
  ---NANOCLAW_OUTPUT_START---
  {"status":"success","result":"texte réponse","newSessionId":"abc-123"}
  ---NANOCLAW_OUTPUT_END---
  ```
- Streaming : chaque bloc est parsé au fur et à mesure (pas d'attente de fin du process)

#### Sessions Claude Code

`newSessionId` retourné par le container = ID de session Claude Code SDK. Stocké en DB (`sessions` table). Réutilisé à l'invocation suivante pour continuer la conversation.

Si le session ID n'existe plus côté API ("No conversation found"), le service supprime automatiquement la session et repart à zéro au prochain message.

---

### `src/group-queue.ts` — File de concurrence

Gère la concurrence entre les containers (max `MAX_CONCURRENT_CONTAINERS` simultanés) et le piping de messages vers les containers actifs.

**Constantes** : `MAX_RETRIES = 5`, `BASE_RETRY_MS = 5000` (backoff exponentiel)

#### Classe `GroupQueue`

**`enqueueMessageCheck(groupJid)`**
Si container actif → `pendingMessages = true`. Si limite atteinte → file d'attente. Sinon → `runForGroup()`.

**`enqueueTask(groupJid, taskId, fn)`**
Idem pour les tâches. Évite le double-queuing d'une même tâche.

**`sendMessage(groupJid, text)`**
Écrit un fichier JSON dans `data/ipc/{folder}/input/` pour piper un message vers le container actif. Écriture atomique (temp file + rename). Retourne `false` si pas de container actif.

**`closeStdin(groupJid)`**
Crée le fichier sentinelle `data/ipc/{folder}/input/_close` pour signaler au container de terminer.

**`scheduleRetry(groupJid, state)`** (privé)
Backoff exponentiel : `5s * 2^(retryCount-1)`. Après 5 retries : abandon.

**`drainGroup(groupJid)`** (privé)
Après fin d'un container : traite les tâches pending en priorité, puis les messages.

**`shutdown(gracePeriodMs)`**
Arrêt gracieux : détache les containers actifs sans les tuer (ils se termineront via idle timeout).

---

### `src/ipc.ts` — Watcher IPC

Surveille les fichiers IPC écrits par les containers et les exécute.

**`startIpcWatcher(deps)`**
Boucle d'interval (1s). Pour chaque dossier `data/ipc/{group}/` :
- Traite les fichiers dans `messages/` → `sendMessage()`
- Traite les fichiers dans `tasks/` → `processTaskIpc()`
- Déplace les fichiers erronés dans `data/ipc/errors/`

**`processTaskIpc(data, sourceGroup, isMain, deps)`**
Dispatch par `data.type` :

| Type | Action | Auth requise |
|------|---------|--------------|
| `schedule_task` | Crée une tâche dans SQLite | non-main → seulement son propre groupe |
| `pause_task` | Pause une tâche | non-main → seulement ses propres tâches |
| `resume_task` | Reprend une tâche | non-main → seulement ses propres tâches |
| `cancel_task` | Supprime une tâche | non-main → seulement ses propres tâches |
| `refresh_groups` | Resync les métadonnées WhatsApp | main seulement |
| `register_group` | Enregistre un nouveau groupe | main seulement |
| `markitdown` | Exécute `markitdown <source>` sur le Mac hôte, écrit le résultat dans `groups/{sourceGroup}/{outputFilename}` | tous les groupes |

**Sécurité clé** : `isMain` ne peut être défini que via la DB directement ou le setup. Un agent dans un container ne peut pas s'auto-élever en `main` via IPC — le flag est vérifié depuis le dossier source IPC, pas depuis le payload.

---

### `src/task-scheduler.ts` — Scheduler de tâches

**`startSchedulerLoop(deps)`**
Boucle toutes les 60s. Appelle `getDueTasks()` et pour chaque tâche active : `queue.enqueueTask()`.

**`runTask(task, deps)`**
Exécute une tâche planifiée dans un container :
1. Trouve le groupe en DB
2. Détermine le sessionId selon `context_mode` ('group' = session existante, 'isolated' = nouvelle)
3. Démarre un idle timer (ferme le container après 30min sans output)
4. `runContainerAgent()` avec callback streaming
5. Logs le run et calcule `nextRun`

---

### `src/transcription.ts` — Transcription vocale

Transcription avec Whisper via `@xenova/transformers`. Modèle téléchargé au premier usage dans `~/.cache/nanoclaw/models/`.

**`transcribeAudio(audioBuffer)`**
1. Écrit le buffer OGG dans un fichier temp
2. Convertit en WAV 16kHz mono via `ffmpeg`
3. Décode WAV PCM → `Float32Array`
4. Passe au pipeline Whisper → texte
5. Nettoie les fichiers temp

Cherche `ffmpeg` dans : `FFMPEG_PATH` env, `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `/usr/bin/ffmpeg`.

---

### `src/tts.ts` — Synthèse vocale

TTS via Kokoro (`onnx-community/Kokoro-82M-v1.0-ONNX`) exécuté dans un **processus enfant isolé** pour éviter que les crashs natifs tuent le processus principal.

**`textToSpeech(text)`**
Exécute le worker TTS (avec timeout 2min), lit le fichier OGG produit.

---

### `src/mount-security.ts` — Sécurité des mounts

Valide les mounts additionnels contre une allowlist stockée **hors** du projet (non montée dans les containers, donc inaltérable par les agents).

**Patterns bloqués par défaut** : `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, `.npmrc`, etc.

**`validateAdditionalMounts(mounts, groupName, isMain)`**
Valide tous les mounts d'un groupe. Retourne uniquement les mounts valides, montés sous `/workspace/extra/`.

---

## 5. Container agent (`container/`)

---

### `container/Dockerfile`

Image basée sur `node:22-slim`. Installe :
- Chromium + dépendances (pour le browser automation)
- `agent-browser` (npm global)
- `@anthropic-ai/claude-code` (npm global)
- `@google/gemini-cli` (npm global)

Entrypoint : script bash qui :
1. Recompile le TypeScript (`npx tsc --outDir /tmp/dist`)
2. Symlinke `node_modules`
3. Lit stdin → `/tmp/input.json`
4. Exécute `node /tmp/dist/index.js < /tmp/input.json`

Le source TypeScript est monté depuis l'hôte (`/app/src`), ce qui bypasse le cache BuildKit.

**Note cache** : après tout changement de code agent-runner, supprimer `data/sessions/*/agent-runner-src/` pour que le nouveau code soit copié.

**Répertoires dans le container**

```
/workspace/group/     — Fichiers du groupe (mémoire, conversations, CLAUDE.md)
/workspace/global/    — CLAUDE.md global (read-only pour non-main)
/workspace/extra/     — Mounts additionnels validés
/workspace/ipc/       — Fichiers IPC (messages/, tasks/, input/)
/home/node/.claude/   — Sessions et settings Claude
/app/                 — Code agent-runner
```

---

### `container/agent-runner/src/index.ts` — Runner d'agent

Reçoit le `ContainerInput` via stdin, exécute Claude Agent SDK ou Ollama, stream les résultats.

**Dispatch au démarrage** :
```typescript
if (containerInput.modelProvider === 'ollama') {
  await runOllamaLoop(containerInput);
  return;
}
// sinon : backend Claude SDK
```

#### Fonctions (backend Claude SDK)

**`createPreCompactHook()`**
Hook SDK `PreCompact` : archive la conversation complète dans `/workspace/group/conversations/` avant la compaction du contexte.

**`createSanitizeBashHook()`**
Hook SDK `PreToolUse` sur `Bash` : préfixe chaque commande avec `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` pour que les sous-processus Bash ne voient pas les secrets.

**`shouldClose()`**
Vérifie l'existence du fichier sentinelle `_close` et le supprime.

**`waitForIpcMessage()`**
Polling toutes les 500ms : attend un fichier IPC ou `_close`. Retourne le texte des messages ou `null` si `_close`.

**`runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt?)`**
Exécute un appel au SDK Claude :
- `cwd: '/workspace/group'`
- `resume: sessionId` + `resumeSessionAt: resumeAt`
- `systemPrompt` : contenu de `/workspace/global/CLAUDE.md` si présent
- `permissionMode: 'bypassPermissions'`
- MCP servers : `nanoclaw` (IPC) + serveurs additionnels
- Hooks : `PreCompact` + `PreToolUse(Bash)`

**Outils autorisés dans le container**
`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage`, `TodoWrite`, `ToolSearch`, `Skill`, `NotebookEdit`, `mcp__nanoclaw__*`, plus les outils MCP additionnels.

**Boucle principale** :
1. Parse stdin → `ContainerInput`
2. Drain les IPC messages en attente
3. Boucle : `runQuery()` → `waitForIpcMessage()` → nouvelle query → ...
4. S'arrête sur `_close` ou erreur

---

### `container/agent-runner/src/ollama-runner.ts` — Backend Ollama

Backend alternatif pour les groupes configurés avec `modelProvider='ollama'`.

**`buildSystemMessage(containerInput)`**
Construit le system message en injectant dans l'ordre :
1. Identité du modèle (`"You are running locally via Ollama. Your model is: {name}..."`)
2. `/workspace/group/CLAUDE.md` (groupe spécifique)
3. `/home/node/.claude/projects/-workspace-group/memory/MEMORY.md` (auto-memory)
4. `/workspace/global/CLAUDE.md` (non-main seulement)

**`runOllamaLoop(containerInput)`**
Single-turn : traite le prompt et exit. La continuité de conversation est assurée par le fichier historique JSON.

**Tool loop** : POST streaming vers `OLLAMA_HOST/api/chat` → détecte les `tool_calls` → appelle MCP via `McpClient` → renvoie les résultats → loop jusqu'à réponse finale.

**`McpClient`** : client MCP stdio qui spawne `ipc-mcp-stdio.js` et communique via JSON-RPC.

`send_message` est exclu des tools Ollama (les modèles locaux l'appellent en boucle pour les updates intermédiaires ; la réponse finale est le message).

---

### `container/agent-runner/src/ollama-history.ts` — Historique Ollama

| Fonction | Rôle |
|----------|------|
| `loadHistory(sessionId)` | Lit `ollama-{sessionId}.json` depuis `/home/node/.claude/` |
| `saveHistory(sessionId, messages, model)` | Écrit le fichier |
| `truncateHistory(messages, maxPairs=50)` | Garde system message + 50 dernières paires (100 msgs max) |

---

### `container/agent-runner/src/ipc-mcp-stdio.ts` — Serveur MCP

Serveur MCP stdio exposé aux agents. Contexte injecté via variables d'env :
- `NANOCLAW_CHAT_JID` : JID du chat courant
- `NANOCLAW_GROUP_FOLDER` : Dossier du groupe
- `NANOCLAW_IS_MAIN` : `'1'` si groupe main

**Outils MCP exposés**

| Outil | Paramètres | Rôle |
|-------|-----------|------|
| `send_message` | `text`, `sender?` | Envoie un message immédiatement |
| `schedule_task` | `prompt`, `schedule_type`, `schedule_value`, `context_mode`, `target_group_jid?` | Planifie une tâche |
| `list_tasks` | — | Liste les tâches |
| `pause_task` | `task_id` | Pause une tâche |
| `resume_task` | `task_id` | Reprend une tâche |
| `cancel_task` | `task_id` | Annule une tâche |
| `register_group` | `jid`, `name`, `folder`, `trigger`, `model_provider?`, `ollama_model?` | Enregistre un groupe (main seulement) |
| `markitdown` | `source`, `output_filename` | Convertit une source en Markdown via le Mac hôte |

#### `markitdown` — Exécution sur le Mac hôte

Contourne les limitations réseau des containers (VMs avec IP NATée partagée, bloquée par certains services). Flux :
1. L'agent appelle `mcp__nanoclaw__markitdown(source, output_filename)`
2. `ipc-mcp-stdio.ts` écrit `{type: "markitdown", ...}` dans `tasks/`
3. `ipc.ts` sur le Mac exécute `markitdown "<source>"` avec la vraie IP publique
4. Le résultat est écrit dans `groups/{sourceGroup}/{outputFilename}` → monté à `/workspace/group/`
5. L'agent poll et lit le fichier

---

## 6. Variables d'environnement

Fichier `.env` à la racine du projet.

| Variable | Défaut | Rôle |
|----------|--------|------|
| `ASSISTANT_NAME` | `Andy` | Nom du bot (trigger = `@Andy`) |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | `true` si le bot a son propre numéro WhatsApp |
| `MESSAGE_PREFIX` | `Andy: ` | Préfixe messages sortants. `""` = désactivé |
| `MESSAGE_EMOJI` | `` | Emoji ajouté à la fin des messages |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Token OAuth Claude Code (prioritaire sur API key) |
| `ANTHROPIC_API_KEY` | — | Clé API Anthropic (fallback) |
| `HF_TOKEN` | — | Token HuggingFace (requis pour TTS Kokoro) |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Image container à utiliser |
| `CONTAINER_TIMEOUT` | `1800000` | Timeout hard container (ms) |
| `CONTAINER_MEMORY` | `4g` | Limite mémoire container |
| `IDLE_TIMEOUT` | `1800000` | Timeout inactivité container (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max containers simultanés |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` | Taille max sortie container (bytes) |
| `WHISPER_MODEL` | `Xenova/whisper-base` | Modèle Whisper pour transcription |
| `WHISPER_LANGUAGE` | — | Langue forcée pour Whisper (auto-detect si absent) |
| `FFMPEG_PATH` | — | Chemin absolu vers ffmpeg |
| `KOKORO_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | Modèle TTS |
| `TTS_VOICE` | `am_onyx` | Voix Kokoro |
| `LOG_LEVEL` | `info` | Niveau de log pino (`debug`, `info`, `warn`, `error`) |
| `TZ` | timezone système | Timezone pour les crons |

---

## 7. Base de données SQLite

Fichier : `store/messages.db`

### Table `chats`

| Colonne | Type | Rôle |
|---------|------|------|
| `jid` | TEXT PK | JID du chat |
| `name` | TEXT | Nom du groupe/contact |
| `last_message_time` | TEXT | Timestamp dernière activité |
| `channel` | TEXT | Canal (`whatsapp`, `telegram`, etc.) |
| `is_group` | INTEGER | 0=DM, 1=groupe |

Note : la row `jid='__group_sync__'` stocke le timestamp de la dernière sync de groupes.

### Table `messages`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | TEXT | ID message |
| `chat_jid` | TEXT | JID du chat (FK → chats) |
| `sender` | TEXT | JID expéditeur |
| `sender_name` | TEXT | Nom affiché |
| `content` | TEXT | Contenu (texte ou `[Voice: ...]`) |
| `timestamp` | TEXT | ISO timestamp |
| `is_from_me` | INTEGER | 1 si envoyé depuis notre compte |
| `is_bot_message` | INTEGER | 1 si message du bot |

Index : `idx_timestamp` sur `timestamp`.

### Table `scheduled_tasks`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | TEXT PK | ID unique |
| `group_folder` | TEXT | Groupe propriétaire |
| `chat_jid` | TEXT | JID cible |
| `prompt` | TEXT | Prompt de la tâche |
| `schedule_type` | TEXT | `cron`/`interval`/`once` |
| `schedule_value` | TEXT | Expression/valeur |
| `context_mode` | TEXT | `group` ou `isolated` |
| `next_run` | TEXT | Prochain run ISO |
| `last_run` | TEXT | Dernier run |
| `last_result` | TEXT | Résumé du dernier résultat |
| `status` | TEXT | `active`/`paused`/`completed` |
| `created_at` | TEXT | Date création |

### Table `task_run_logs`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | — |
| `task_id` | TEXT | FK → scheduled_tasks |
| `run_at` | TEXT | ISO timestamp |
| `duration_ms` | INTEGER | Durée en ms |
| `status` | TEXT | `success`/`error` |
| `result` | TEXT | Résultat tronqué |
| `error` | TEXT | Message d'erreur |

### Table `router_state`

KV store persistant.

| Clé | Valeur |
|-----|--------|
| `last_timestamp` | Dernier timestamp de message vu (curseur global) |
| `last_agent_timestamp` | JSON : `{chatJid: lastProcessedTimestamp}` par chat |

### Table `sessions`

| Colonne | Type | Rôle |
|---------|------|------|
| `group_folder` | TEXT PK | Nom du dossier du groupe |
| `session_id` | TEXT | ID de session Claude ou Ollama |

### Table `registered_groups`

| Colonne | Type | Rôle |
|---------|------|------|
| `jid` | TEXT PK | JID WhatsApp du groupe |
| `name` | TEXT | Nom affiché |
| `folder` | TEXT UNIQUE | Nom du dossier |
| `trigger_pattern` | TEXT | Mot déclencheur (ex: `@Andy`) |
| `added_at` | TEXT | Date d'ajout |
| `container_config` | TEXT | JSON de `ContainerConfig` |
| `requires_trigger` | INTEGER | 1=trigger requis, 0=toujours actif |
| `is_main` | INTEGER | 1=groupe principal avec droits élevés |
| `model_provider` | TEXT | `'claude'` (défaut) ou `'ollama'` |
| `ollama_model` | TEXT | Nom du modèle Ollama |

---

## Groupe `main` vs autres groupes

| Fonctionnalité | `main` | Autres |
|----------------|--------|--------|
| **Trigger requis** | Non — tout message déclenche | Oui — doit contenir `@batman` |
| **Mount projet** | `/workspace/project` — accès au code NanoClaw | Rien |
| **Mount global** | Non nécessaire (a accès au projet) | `/workspace/global` (ro) |
| **Groupes disponibles** | Voit tous les chats WhatsApp (`available_groups.json`) | Liste vide |
| **Tâches visibles** | Toutes les tâches de tous les groupes | Seulement ses propres tâches |
| **IPC messages** | Peut envoyer vers n'importe quel JID enregistré | Seulement vers lui-même |
| **IPC register_group** | Peut enregistrer de nouveaux groupes | Bloqué |
| **IPC refresh_groups** | Peut forcer une sync WhatsApp | Bloqué |

---

## 8. Protocoles IPC

### Host → Container (stdin)

JSON unique envoyé au démarrage du container (`ContainerInput`). Les secrets sont injectés ici et jamais écrits sur disque.

### Container → Host (stdout markers)

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"texte...","newSessionId":"uuid"}
---NANOCLAW_OUTPUT_END---
```

### Host → Container (follow-up messages)

Fichiers JSON dans `data/ipc/{folder}/input/` :
```json
{ "type": "message", "text": "..." }
```
Fichier sentinelle de fermeture : `_close` (fichier vide)

### Container → Host (IPC messages/tasks)

Fichiers JSON dans `data/ipc/{folder}/messages/` et `data/ipc/{folder}/tasks/`. L'IPC watcher les consomme toutes les secondes.

**Message** (`messages/`) :
```json
{ "type": "message", "chatJid": "...", "text": "...", "groupFolder": "..." }
```

**Tâche** (`tasks/`) :
```json
{ "type": "schedule_task", "prompt": "...", "schedule_type": "cron", "schedule_value": "0 9 * * *", "context_mode": "group", "targetJid": "..." }
{ "type": "register_group", "jid": "...", "name": "...", "folder": "...", "trigger": "@Andy" }
{ "type": "markitdown", "source": "https://...", "outputFilename": "output.md", "groupFolder": "..." }
```

---

## 9. Sécurité des mounts

L'allowlist est stockée à `~/.config/nanoclaw/mount-allowlist.json` — hors du projet, jamais montée dans les containers. Les agents ne peuvent pas la modifier.

### Règles de validation

1. Le `containerPath` doit être relatif et sans `..`
2. Le `hostPath` doit exister sur le filesystem
3. Le chemin résolu ne doit matcher aucun pattern bloqué (`.ssh`, `.aws`, etc.)
4. Le chemin résolu doit être sous une `allowedRoot` déclarée dans l'allowlist
5. Les groupes non-main sont forcés en read-only si `nonMainReadOnly: true`

### Format de l'allowlist

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "..." }
  ],
  "blockedPatterns": ["password", "secret"],
  "nonMainReadOnly": true
}
```

---

## 10. Dépendances clés

### Host (`package.json`)

| Package | Rôle |
|---------|------|
| `@whiskeysockets/baileys` | Client WhatsApp Web (WebSocket) |
| `@xenova/transformers` | Inference ML pour Whisper (transcription) |
| `kokoro-js` | TTS Kokoro (synthèse vocale) |
| `better-sqlite3` | SQLite synchrone |
| `cron-parser` | Parse les expressions cron |
| `pino` + `pino-pretty` | Logger structuré |
| `qrcode` + `qrcode-terminal` | QR code pour auth WhatsApp |
| `zod` | Validation de schéma (ipc-mcp-stdio) |

### Container (`container/agent-runner/`)

| Package | Rôle |
|---------|------|
| `@anthropic-ai/claude-agent-sdk` | SDK Claude Agent (query, hooks) |
| `@modelcontextprotocol/sdk` | Serveur MCP stdio |
| `cron-parser` | Parse les expressions cron dans le MCP |
| `zod` | Validation des paramètres MCP |

### Globaux dans le container (npm -g)

| Package | Rôle |
|---------|------|
| `agent-browser` | Automation navigateur via Chromium |
| `@anthropic-ai/claude-code` | CLI Claude Code (utilisé par le SDK) |
| `@google/gemini-cli` | CLI Gemini (pour les groupes avec `agent='gemini'`) |

---

## 11. Commandes utiles développeur

```bash
# Lancer en dev
npm run dev

# Rebuild image Docker
./container/build.sh

# Forcer rebuild propre (vider le cache buildkit)
docker builder prune -f && ./container/build.sh

# Rebuild complet (TS + container + purge agent-runner-src + restart)
./batman_rebuild.sh

# Reset session d'un groupe (preserve memory)
./batman_clear_session.sh <folder>

# Reset session manuel
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='main';"

# Voir tous les groupes enregistrés
sqlite3 store/messages.db "SELECT jid, name, folder, is_main FROM registered_groups;"

# Voir les logs en temps réel
tail -f logs/nanoclaw.log

# Redémarrer le service (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Démarrer / arrêter le service (macOS)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Voir les logs d'un container spécifique
ls groups/main/logs/
cat groups/main/logs/container-2026-*.log
```

---

## Structure des fichiers

```
src/
  index.ts              Orchestrateur principal
  channels/
    registry.ts         Registre des canaux (auto-registration)
    whatsapp.ts         Canal WhatsApp (Baileys)
    index.ts            Barrel — importe tous les canaux
  container-runner.ts   Spawn Docker, mounts, parsing stdout
  container-runtime.ts  Abstraction runtime (docker/apple container)
  ipc.ts                Watcher IPC + autorisation des commandes
  db.ts                 Toutes les opérations SQLite
  router.ts             Formatage messages entrants/sortants
  task-scheduler.ts     Scheduler de tâches
  credential-proxy.ts   Proxy HTTP pour les secrets (port 3001)
  group-queue.ts        File d'attente par groupe (évite concurrence)
  config.ts             Toutes les constantes et variables d'env
  types.ts              Types partagés

groups/
  main/                 Dossier de travail du groupe principal (admin)
  mat/                  Dossier du groupe DM de Mat
  global/               CLAUDE.md partagé (lu par tous les groupes non-main)

container/
  agent-runner/src/     Code de l'agent (copié par groupe dans data/sessions/)
    index.ts            Runner principal (dispatch Claude / Ollama)
    ollama-runner.ts    Backend Ollama
    ollama-history.ts   Historique JSON pour Ollama
    ipc-mcp-stdio.ts    Serveur MCP stdio
  skills/               Skills disponibles dans les conteneurs (voir §5 Skills)
  build.sh              Build de l'image Docker

data/
  ipc/                  Namespaces IPC par groupe
  sessions/             Sessions Claude et agent-runner par groupe
  env/                  .env copié (utilisé par le proxy)

store/
  messages.db           SQLite
  auth/                 Credentials WhatsApp (Baileys)
```

---

## 5b. Skills — `container/skills/`

Les skills sont des **instructions markdown** chargées automatiquement dans le contexte de l'agent à chaque spawn de container. Elles permettent d'ajouter des comportements sans modifier le code source.

### Fonctionnement

1. **Définition** : chaque skill est un dossier dans `container/skills/<nom>/` contenant un fichier `SKILL.md`.
2. **Sync automatique** : à chaque spawn de container, `container-runner.ts` copie tous les dossiers de `container/skills/` vers `data/sessions/<group>/.claude/skills/`. Le dossier `.claude/skills/` est monté à `/home/node/.claude/skills/` dans le container.
3. **Chargement** : Claude Code SDK charge automatiquement tous les fichiers `SKILL.md` trouvés dans `.claude/skills/` et les injecte dans le contexte de l'agent.
4. **Priorité** : les skills sont chargées après `CLAUDE.md` et l'auto-memory, mais avant le premier message utilisateur.

### Format d'un fichier SKILL.md

```markdown
---
name: nom-de-la-skill
description: Description utilisée pour décider de la pertinence en contexte futur.
allowed-tools: Bash(tool:*)   # optionnel — restreint les outils autorisés
---

# Titre

Instructions pour l'agent...
```

Le frontmatter YAML est **obligatoire**. Le champ `description` est utilisé par Claude Code pour décider si la skill est pertinente dans le contexte courant.

### Sync manuelle (sans restart)

Pour activer une skill immédiatement sans attendre le prochain spawn :
```bash
cp -r container/skills/<nom> data/sessions/<group>/.claude/skills/
```

### Skills installées

| Skill | Trigger | Rôle |
|-------|---------|------|
| `agent-browser` | Toujours disponible | Automation Chromium (WebSearch, formulaires, screenshots) |
| `capabilities` | `/capabilities` | Rapport des capacités installées du bot |
| `status` | `/status` | Health check rapide (session, workspace, tâches) |
| `pdf-handler` | `[Document: ...]` dans le message | Conversion auto de documents en markdown via `markitdown`, ajout à `knowledge/` |
| `url-summary` | `resume <url>` (non-YouTube) | Fetch et résumé d'une page web, proposition d'ajout à la base de connaissance |
| `youtube-summary` | `resume <youtube-url>` | Fetch du transcript YouTube + résumé, proposition d'ajout à la base de connaissance |
| `send-to-group` | "envoie un message à...", "dis à..." | Envoi d'un message WhatsApp vers n'importe quel contact ou groupe via IPC |

---

## 12. Améliorations récentes (avril 2026)

### Réception d'images WhatsApp

**Fichiers modifiés** : `src/channels/whatsapp.ts`, `src/types.ts`, `src/router.ts`

Quand une image est reçue via WhatsApp :
1. `normalizeMessageContent()` détecte `imageMessage`
2. `downloadMediaMessage()` télécharge le buffer
3. Sauvegarde dans `groups/{folder}/media/images/img-<timestamp>-<msgId>.<ext>`
4. Le champ `image_path` est ajouté à `NewMessage` avec le chemin **container** : `/workspace/group/media/images/<filename>`
5. `formatMessages()` inclut l'attribut XML `image="..."` dans le message :
   ```xml
   <message sender="Mat" time="..." image="/workspace/group/media/images/img-xxx.jpg">[Image]</message>
   ```
6. L'agent peut lire l'image via le tool `Read` avec ce chemin.

Si l'image a une légende, celle-ci est utilisée comme contenu du message. Sinon, le contenu est `[Image]`.

### Réception de documents WhatsApp

**Fichiers modifiés** : `src/channels/whatsapp.ts`

Même principe que les images, pour `documentMessage` (PDF, DOCX, XLSX, etc.) :
1. Téléchargement dans `groups/{folder}/downloads/<filename>`
2. Message envoyé à l'agent : `[Document: <filename> — saved to /workspace/group/downloads/<filename>]`
3. La skill `pdf-handler` détecte ce pattern et exécute automatiquement :
   - `markitdown downloads/<filename> > knowledge/<filename>.md`
   - Vérification que le fichier .md est non-vide
   - Update de `CLAUDE.md` sous `## Knowledge Base`
   - Confirmation à l'utilisateur (sans mentionner les fichiers)

**Dépendance container** : `markitdown` (Python, installé via `pip3`).

### Réactions emoji

**Fichiers modifiés** : `src/types.ts`, `src/channels/whatsapp.ts`, `src/router.ts`, `src/index.ts`

L'agent peut réagir à un message en incluant `<react>EMOJI</react>` dans sa réponse :
- `extractReaction(text)` dans `router.ts` extrait l'emoji et le texte restant
- `WhatsAppChannel.sendReaction(jid, emoji)` envoie la réaction via Baileys sur le dernier message reçu du JID
- Si la réponse contient à la fois une réaction et du texte, les deux sont envoyés
- `lastMsgKey` (Map privée de `WhatsAppChannel`) stocke la clé du dernier message reçu par JID pour cibler la réaction

```typescript
// Exemple de réponse agent
"<react>👍</react> Bien reçu, je m'en occupe !"
// → réaction 👍 + message texte "Bien reçu, je m'en occupe !"
```

### Correction du bug voice reply

**Fichier modifié** : `src/channels/whatsapp.ts`

**Bug** : si un message texte arrivait pendant le traitement d'un vocal (avant que la réponse vocale soit envoyée), le flag `voiceReplyJids` était consommé par la réponse au texte, qui partait donc en audio.

**Fix** : tout message non-vocal reçu efface immédiatement le flag pour ce JID :
```typescript
if (!isVoiceMessage(msg)) {
  this.voiceReplyJids.delete(chatJid);
  delete this.voiceReplyLang[chatJid];
}
```

**Règle** : texte → texte, vocal → vocal, sauf demande explicite dans le vocal.

### Envoi cross-group

**Skill** : `container/skills/send-to-group/`

L'agent (groupe `mat`, qui est `isMain`) peut envoyer un message à n'importe quel JID WhatsApp en écrivant un fichier IPC :
```json
{ "type": "message", "chatJid": "5219981698374@s.whatsapp.net", "text": "..." }
```

L'IPC watcher autorise l'envoi car `isMain = true`. Fonctionne avec :
- Les groupes enregistrés (trouvés via `available_groups.json`)
- N'importe quel numéro de téléphone (format `{numéro_sans_+}@s.whatsapp.net`)

**Fix associé** : `getAvailableGroups()` incluait uniquement les chats de type `@g.us` (groupes). Corrigé pour inclure aussi les chats directs enregistrés (`@s.whatsapp.net`).

### Résumé de pages web et vidéos YouTube

**Skills** : `url-summary`, `youtube-summary`

- `resume <url>` → WebFetch → résumé → propose ajout à `knowledge/`
- `resume <youtube-url>` → `youtube-transcript-api` → résumé du transcript → propose ajout à `knowledge/`

**Dépendance container** : `youtube-transcript-api` (Python, `pip3`).

Workflow d'ajout à la base de connaissance :
1. Génération d'un nom de fichier depuis le titre
2. Sauvegarde : `knowledge/<filename>.md`
3. Vérification existence avant toute modification de `CLAUDE.md`
4. Update `CLAUDE.md` → section `## Knowledge Base`

### Nouveaux groupes enregistrés

| Groupe | JID | Dossier |
|--------|-----|---------|
| Noemi | `5219981698374@s.whatsapp.net` | `groups/noemi/` (restauré depuis `noemi.old`) |
| Lila | `262692361745@s.whatsapp.net` | `groups/lila/` |
| Maloee | `262693632312@s.whatsapp.net` | `groups/maloee/` |
| Cathy | `262692942678@s.whatsapp.net` | `groups/cathy/` |

### Dépendances Python ajoutées au container

```dockerfile
RUN pip3 install --break-system-packages markitdown youtube-transcript-api
```

| Package | Rôle |
|---------|------|
| `markitdown` | Conversion PDF/DOCX/XLSX/HTML → Markdown |
| `youtube-transcript-api` | Fetch transcript YouTube sans télécharger la vidéo |

---

# Mémoire des Agents — Analyse du Code

> Analyse de `src/container-runner.ts`, `container/agent-runner/src/index.ts`,
> `container/agent-runner/src/ollama-runner.ts`, `container/agent-runner/src/ollama-history.ts`

---

## Vue d'ensemble

Il existe **4 couches de mémoire** dans NanoClaw, selon le backend utilisé (Claude SDK ou Ollama) :

| Couche | Fichier | Chargé par | Modifié par | Survit au clear-session ? |
|--------|---------|------------|-------------|--------------------------|
| CLAUDE.md | `groups/<folder>/CLAUDE.md` | SDK (cwd scan) / ollama-runner | Toi manuellement | ✅ Oui |
| Auto-memory | `data/sessions/<folder>/.claude/projects/-workspace-group/memory/` | SDK (system/init) / ollama-runner | Le bot automatiquement | ✅ Oui (depuis le fix) |
| Session history | `data/sessions/<folder>/.claude/projects/-workspace-group/<uuid>.jsonl` | SDK (resume:) | SDK automatiquement | ❌ Non |
| Ollama history | `data/sessions/<folder>/.claude/ollama-<uuid>.json` | ollama-runner (loadHistory) | ollama-runner automatiquement | ❌ Non |

---

## Couche 1 — CLAUDE.md (instructions statiques)

### Code source : `container-runner.ts`

```typescript
// src/container-runner.ts — buildVolumeMounts()
mounts.push({
  hostPath: groupDir,          // groups/<folder>/
  containerPath: '/workspace/group',
  readonly: false,
});
```

`groups/<folder>/` est monté à `/workspace/group` dans le container.

### Code source : `container/agent-runner/src/index.ts`

```typescript
for await (const message of query({
  options: {
    cwd: '/workspace/group',   // ← le SDK scanne ce répertoire
    ...
  }
}))
```

Le SDK Claude Code scanne automatiquement le `cwd` et ses parents à la recherche de fichiers `CLAUDE.md`. Il les charge **dans l'ordre** du plus lointain au plus proche (parent → enfant), les concatène, et les injecte comme **system prompt** avant le premier message.

Résultat : `/workspace/group/CLAUDE.md` = `groups/<folder>/CLAUDE.md` sur le host → toujours en contexte.

### Global CLAUDE.md

```typescript
// index.ts — chargé manuellement pour les groupes non-main
const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
}
// puis injecté via :
systemPrompt: { type: 'preset', preset: 'claude_code', append: globalClaudeMd }
```

`groups/global/CLAUDE.md` est monté en read-only à `/workspace/global` pour les groupes non-main, lu manuellement, et **appendé** au system prompt via `systemPrompt.append`.

Pour le groupe main, le global CLAUDE.md n'est PAS chargé (main a accès à tout via `/workspace/project`).

---

## Couche 2 — Auto-memory / MEMORY.md (mémoire dynamique)

### Activation

```typescript
// src/container-runner.ts — settings.json créé à la première exécution
{
  "env": {
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"   // ← active la feature
  }
}
```

Ce fichier est créé UNE SEULE FOIS (si inexistant) dans `data/sessions/<folder>/.claude/settings.json`, puis monté à `/home/node/.claude/settings.json`.

### Mécanisme SDK

Le SDK Claude Code lit `/home/node/.claude/projects/-workspace-group/memory/MEMORY.md` au moment du `system/init`. Le chemin `-workspace-group` est dérivé du `cwd` (`/workspace/group` → `-workspace-group`).

**Timing :** chargé UNE FOIS à l'initialisation de la session (message `type=system/init` dans les logs). Pas rechargé entre chaque tour d'une même session ouverte.

**Format attendu par le SDK :** MEMORY.md est un index qui pointe vers des fichiers individuels avec frontmatter :
```markdown
- [user_role](user_role.md) — Mat est Flutter engineer
- [feedback_style](feedback_style.md) — réponses courtes
```
Chaque fichier a un frontmatter :
```markdown
---
name: user_role
description: Rôle et background de l'utilisateur
type: user
---
Mat est Flutter engineer...
```

Le SDK gère ce répertoire lui-même. Écrire du contenu brut dans MEMORY.md → écrasé au prochain tour.

### Pour Ollama : chargement manuel

```typescript
// container/agent-runner/src/ollama-runner.ts — buildSystemMessage()
const memoryMd = '/home/node/.claude/projects/-workspace-group/memory/MEMORY.md';
if (fs.existsSync(memoryMd)) {
  const memContent = fs.readFileSync(memoryMd, 'utf-8').trim();
  if (memContent) {
    parts.push(`## Memory\n\n${memContent}`);
  }
}
```

Ollama n'utilisant pas le SDK, `buildSystemMessage()` lit MEMORY.md manuellement et l'injecte dans le system message au moment de chaque turn (pas seulement au `system/init`).

---

## Couche 3 — Session history Claude (historique de conversation)

### Stockage

```
data/sessions/<folder>/.claude/projects/-workspace-group/<uuid>.jsonl
```

Ce fichier `.jsonl` contient l'intégralité de la conversation (chaque message = une ligne JSON). C'est le format natif du SDK Claude Code.

### Chargement

```typescript
// container/agent-runner/src/index.ts
for await (const message of query({
  options: {
    resume: sessionId,           // ← UUID stocké en DB (table sessions)
    resumeSessionAt: resumeAt,   // 'latest' ou un UUID de message
  }
}))
```

Le SDK reprend la conversation depuis le `sessionId`. Si le fichier `.jsonl` n'existe pas ou si le sessionId est invalide → erreur `"No conversation found"` → NanoClaw efface la session en DB et repart de zéro.

### Gestion du sessionId

```typescript
// src/index.ts
if (output.newSessionId) {
  sessions[group.folder] = output.newSessionId;
  setSession(group.folder, output.newSessionId);   // stocké en SQLite
}
if (output.error?.includes('No conversation found with session ID')) {
  delete sessions[group.folder];
  deleteSession(group.folder);   // reset automatique
}
```

Le sessionId est persisté dans la table `sessions` de SQLite. À chaque démarrage du service, il est rechargé en mémoire.

---

## Couche 4 — Ollama history (historique JSON)

### Stockage

```
data/sessions/<folder>/.claude/ollama-<uuid>.json
```

Format : `{ messages: OllamaMessage[], model: string }`

### Chargement

```typescript
// ollama-runner.ts
const existing = loadHistory(sessionId);
let history: OllamaMessage[] = existing?.messages ?? [];
```

```typescript
// ollama-history.ts
const HISTORY_DIR = '/home/node/.claude';

export function loadHistory(sessionId: string): OllamaHistory | null {
  const file = path.join(HISTORY_DIR, `ollama-${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
```

Chargé à **chaque turn** (le container Ollama est single-turn, donc chaque message = un nouveau container = un nouveau chargement).

### Troncature

```typescript
// ollama-history.ts
const MAX_EXCHANGE_PAIRS = 50;

export function truncateHistory(messages: OllamaMessage[]): OllamaMessage[] {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const keep = MAX_EXCHANGE_PAIRS * 2;  // 100 messages max
  const trimmed = nonSystem.length > keep
    ? nonSystem.slice(nonSystem.length - keep)
    : nonSystem;
  return [...systemMsgs, ...trimmed];
}
```

Le system message (CLAUDE.md + MEMORY.md) est toujours recalculé à chaque turn et remplace le system message en tête de l'historique.

---

## Montages Docker — Vue complète

```typescript
// src/container-runner.ts — buildVolumeMounts()
```

| Host path | Container path | Accès |
|-----------|---------------|-------|
| `groups/<folder>/` | `/workspace/group` | rw — le groupe travaille ici |
| `groups/global/` | `/workspace/global` | ro — CLAUDE.md global partagé |
| `data/sessions/<folder>/.claude/` | `/home/node/.claude` | rw — sessions, mémoire, settings |
| `data/ipc/<folder>/` | `/workspace/ipc` | rw — communication avec le host |
| `data/sessions/<folder>/agent-runner-src/` | `/app/src` | rw — code de l'agent runner |
| (main only) projet racine | `/workspace/project` | rw — accès au code NanoClaw |

**Isolation :** Chaque groupe a son propre `data/sessions/<folder>/.claude/` → jamais de cross-contamination des sessions ou mémoires entre groupes.

---

## Flux complet au démarrage d'un turn

### Claude SDK

```
1. container-runner.ts : buildVolumeMounts() → prépare les montages
2. container-runner.ts : crée settings.json si inexistant
3. Docker lance le container avec les montages
4. agent-runner/index.ts : lit le prompt depuis stdin
5. agent-runner/index.ts : lit /workspace/global/CLAUDE.md si non-main
6. SDK query() :
   a. scanne /workspace/group/ → charge CLAUDE.md comme system prompt
   b. lit /home/node/.claude/settings.json → active auto-memory
   c. type=system/init → charge MEMORY.md depuis .claude/projects/.../memory/
   d. resume: sessionId → charge <uuid>.jsonl (historique)
7. Conversation multi-turns dans le même container
8. container-runner.ts : reçoit newSessionId → stocke en DB
```

### Ollama

```
1. (même montages Docker)
2. ollama-runner.ts : buildSystemMessage() :
   a. injecte identité modèle
   b. lit /workspace/group/CLAUDE.md
   c. lit /home/node/.claude/projects/-workspace-group/memory/MEMORY.md
   d. lit /workspace/global/CLAUDE.md si non-main
3. loadHistory(sessionId) → lit ollama-<uuid>.json
4. truncateHistory() → garde les 100 derniers messages (50 paires)
5. POST Ollama /api/chat → stream → tool calls loop
6. saveHistory() → écrit ollama-<uuid>.json
7. writeOutput() → exit (single-turn)
```

---

## Différences clés Claude SDK vs Ollama

| | Claude SDK | Ollama |
|---|---|---|
| CLAUDE.md | Chargé automatiquement par le SDK (scan cwd) | Lu manuellement dans `buildSystemMessage()` |
| MEMORY.md | Chargé par le SDK au `system/init`, géré automatiquement | Lu manuellement dans `buildSystemMessage()` à chaque turn |
| Historique | `.jsonl` géré par le SDK, repris via `resume:` | `ollama-<uuid>.json` custom, rechargé à chaque turn |
| Durée de vie du container | Long-running (multi-turns dans le même container) | Single-turn (un container par message) |
| Troncature contexte | Gérée par le SDK (fenêtre de contexte du modèle) | Manuelle : 50 paires max (`truncateHistory`) |
| Écriture auto-memory | Le SDK écrit directement dans `.claude/projects/` | Non (pas de mécanisme auto-memory dans Ollama) |
