import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';

// Read Voicebox config from .env (process.env/plist takes priority if set)
const _env = readEnvFile([
  'VOICEBOX_URL',
  'VOICEBOX_VOICE_FR',
  'VOICEBOX_VOICE_EN',
  'VOICEBOX_INSTRUCT',
  'VOICEBOX_SPEED',
  'FFMPEG_BIN',
]);
function _cfg(key: string, fallback: string): string {
  return process.env[key] || _env[key] || fallback;
}

const execFileAsync = promisify(execFile);

/**
 * Serialization mutex for Voicebox generation requests.
 * Voicebox MLX backend uses a single Metal command buffer — concurrent
 * requests cause a GPU assertion failure and crash the server.
 * All calls to synthesizeSpeech() are queued through this promise chain.
 */
let _generationQueue: Promise<unknown> = Promise.resolve();

/** Base URL of the Voicebox HTTP server. Configure via `VOICEBOX_URL` in .env. */
const VOICEBOX_URL = _cfg('VOICEBOX_URL', 'http://localhost:17493');

/** Voicebox profile ID for French speech. Configure via `VOICEBOX_VOICE_FR` in .env. */
const VOICEBOX_PROFILE_FR = _cfg('VOICEBOX_VOICE_FR', '');

/** Voicebox profile ID for English speech. Configure via `VOICEBOX_VOICE_EN` in .env. */
const VOICEBOX_PROFILE_EN = _cfg('VOICEBOX_VOICE_EN', '');

/**
 * Qwen TTS voice style instruction. Controls voice character/tone.
 * Without this, Qwen picks a random voice each generation (inconsistent/garbled).
 * Configure via `VOICEBOX_INSTRUCT` in .env.
 */
const VOICEBOX_INSTRUCT = _cfg(
  'VOICEBOX_INSTRUCT',
  'Speak in a clear, calm, natural male voice at a moderate pace.',
);

/** Path to the ffmpeg binary. Configure via `FFMPEG_BIN` in .env. */
const FFMPEG_BIN = _cfg('FFMPEG_BIN', '/opt/homebrew/bin/ffmpeg');

/** Audio playback speed multiplier via ffmpeg atempo. Configure via `VOICEBOX_SPEED` in .env. */
const VOICEBOX_SPEED = parseFloat(_cfg('VOICEBOX_SPEED', '1.0'));

/**
 * Heuristic language detector for French.
 * Checks for French-specific accented characters first, then a keyword list.
 *
 * @param text - Input text to classify.
 * @returns `true` if the text is likely French.
 */
function isFrench(text: string): boolean {
  if (/[àâäéèêëîïôùûüçœæ]/i.test(text)) return true;
  const frWords =
    /\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|du|de|et|est|pas|que|qui|dans|sur|avec|pour|par|mais|ou|donc|car|ni|or|je suis|c'est|n'est|vous|votre|notre|leur|leurs|bonjour|merci|oui|non|peut|aussi|très|plus|bien|tout|fait)\b/i;
  return frWords.test(text);
}

/**
 * Synthesize speech from text using a Voicebox HTTP server.
 *
 * Selects the French or English profile ID based on `isFrench(text)`.
 * POSTs to `VOICEBOX_URL/generate/stream`, receives WAV audio, then converts
 * to ogg/opus via ffmpeg. Returns `null` if the profile ID is not configured
 * or if the HTTP request or conversion fails.
 *
 * Two temp files are written to `os.tmpdir()` and deleted in the `finally` block.
 *
 * @param text - Plain text to synthesize (should be pre-cleaned; no markdown or emojis).
 * @returns An ogg/opus `Buffer` ready for sending as a WhatsApp voice note, or `null` on failure.
 * @sideEffects Makes an HTTP POST to `VOICEBOX_URL`; writes and deletes temp files in `os.tmpdir()`;
 *   spawns an `ffmpeg` subprocess.
 */
export function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const task = _generationQueue.then(() => _synthesize(text));
  _generationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function _synthesize(text: string): Promise<Buffer | null> {
  const fr = isFrench(text);
  const profileId = fr ? VOICEBOX_PROFILE_FR : VOICEBOX_PROFILE_EN;
  const language = fr ? 'fr' : 'en';

  if (!profileId) {
    console.error(
      `TTS Voicebox: profile ID not configured (${fr ? 'VOICEBOX_VOICE_FR' : 'VOICEBOX_VOICE_EN'})`,
    );
    return null;
  }

  const tmpDir = os.tmpdir();
  const id = `nanoclaw-vb-${Date.now()}`;
  const tmpWav = path.join(tmpDir, `${id}.wav`);
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);

  try {
    const response = await fetch(`${VOICEBOX_URL}/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        text,
        language,
        instruct: VOICEBOX_INSTRUCT,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`TTS Voicebox: HTTP ${response.status} — ${body}`);
      return null;
    }

    const arrayBuf = await response.arrayBuffer();
    fs.writeFileSync(tmpWav, Buffer.from(arrayBuf));

    await execFileAsync(
      FFMPEG_BIN,
      [
        '-i',
        tmpWav,
        '-filter:a',
        `atempo=${VOICEBOX_SPEED}`,
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'on',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-y',
        tmpOgg,
      ],
      { timeout: 30_000 },
    );

    return fs.readFileSync(tmpOgg);
  } catch (err) {
    console.error('TTS Voicebox synthesis failed:', err);
    return null;
  } finally {
    for (const f of [tmpWav, tmpOgg]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}
