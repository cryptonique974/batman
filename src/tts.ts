import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);

const PIPER_BIN = process.env.PIPER_BIN || '/opt/homebrew/bin/piper';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const PIPER_MODEL_FR =
  process.env.PIPER_MODEL_FR ||
  path.join(__dirname, '../data/models/piper/fr_FR-tom-medium.onnx');
const PIPER_MODEL_EN =
  process.env.PIPER_MODEL_EN ||
  path.join(__dirname, '../data/models/piper/en_US-ryan-medium.onnx');
const LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE || '0.8';

// Detect French: accented chars or common French words
function isFrench(text: string): boolean {
  if (/[àâäéèêëîïôùûüçœæ]/i.test(text)) return true;
  const frWords =
    /\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|du|de|et|est|pas|que|qui|dans|sur|avec|pour|par|mais|ou|donc|car|ni|or|je suis|c'est|n'est|vous|votre|notre|leur|leurs|bonjour|merci|oui|non|peut|aussi|très|plus|bien|tout|fait)\b/i;
  return frWords.test(text);
}

export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-tts-${Date.now()}`;
  const tmpTxt = path.join(tmpDir, `${id}.txt`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);

  const model = isFrench(text) ? PIPER_MODEL_FR : PIPER_MODEL_EN;

  try {
    fs.writeFileSync(tmpTxt, text, 'utf8');
    await execFileAsync(
      PIPER_BIN,
      [
        '--model',
        model,
        '--length_scale',
        LENGTH_SCALE,
        '--input_file',
        tmpTxt,
        '--output_file',
        tmpWav,
      ],
      { timeout: 60_000 },
    );

    await execFileAsync(
      FFMPEG_BIN,
      ['-i', tmpWav, '-c:a', 'libopus', '-b:a', '32k', '-y', tmpOgg],
      { timeout: 30_000 },
    );

    return fs.readFileSync(tmpOgg);
  } catch (err) {
    console.error('TTS synthesis failed:', err);
    return null;
  } finally {
    for (const f of [tmpTxt, tmpWav, tmpOgg]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}
