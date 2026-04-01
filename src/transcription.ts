import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  downloadMediaMessage,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

async function transcribeWithWhisperCpp(
  audioBuffer: Buffer,
): Promise<{ text: string | null; language: string | null }> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert ogg/opus to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      FFMPEG_BIN,
      ['-i', tmpOgg, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout, stderr } = await execFileAsync(
      WHISPER_BIN,
      [
        '-m',
        WHISPER_MODEL,
        '-f',
        tmpWav,
        '--no-timestamps',
        '-nt',
        '-l',
        'auto',
      ],
      { timeout: 60_000 },
    );

    const text = stdout.trim() || null;

    // Format: "whisper_full_with_state: auto-detected language: en (p = 0.xx)"
    const langMatch = stderr.match(/auto-detected language:\s+([a-z]{2,3})/i);
    const language = langMatch ? langMatch[1].toLowerCase() : null;

    return { text, language };
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return { text: null, language: null };
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<{ text: string; language: string | null }> {
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return { text: FALLBACK_MESSAGE, language: null };
    }

    const { text, language } = await transcribeWithWhisperCpp(buffer);

    if (!text) {
      return { text: FALLBACK_MESSAGE, language: null };
    }

    return { text: text.trim(), language };
  } catch (err) {
    console.error('Transcription error:', err);
    return { text: FALLBACK_MESSAGE, language: null };
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
