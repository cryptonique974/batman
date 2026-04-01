/**
 * TTS router — Voicebox only.
 *
 * Cleans agent output text before forwarding to the Voicebox engine.
 * Text cleaning strips emojis, markdown formatting, headers, and list
 * markers that would sound wrong when spoken aloud.
 */
import { synthesizeSpeech as _synthesize } from './tts-voicebox.js';

/**
 * Strip text formatting that would degrade TTS quality.
 *
 * Removes: emojis, markdown code fences, inline code, bold/italic/strikethrough
 * markers, ATX headers, bullet and numbered list markers. Collapses excess
 * whitespace and newlines.
 *
 * @param text - Raw agent output text.
 * @returns Clean plain text suitable for speech synthesis.
 */
function cleanForTTS(text: string): string {
  return (
    text
      // Remove emojis
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
      // Remove WhatsApp/markdown formatting: *bold*, _italic_, ~strikethrough~, ```code```
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/\*+([^*]+)\*+/g, '$1')
      .replace(/_+([^_]+)_+/g, '$1')
      .replace(/~+([^~]+)~+/g, '$1')
      // Remove markdown headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bullet points / list markers
      .replace(/^[\s]*[-*•]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Collapse multiple spaces/newlines
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

/**
 * Synthesize speech from agent output text using Voicebox.
 *
 * Applies `cleanForTTS` to strip markdown and emoji before forwarding to Voicebox.
 *
 * @param text - Raw text to synthesize (markdown and emojis will be stripped).
 * @returns An ogg/opus `Buffer` for use as a WhatsApp voice note, or `null` on failure.
 */
export const synthesizeSpeech = (text: string) =>
  _synthesize(cleanForTTS(text));
