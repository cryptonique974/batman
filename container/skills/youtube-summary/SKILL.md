---
name: youtube-summary
description: Fetch the transcript and summarize a YouTube video when the user sends "resume <youtube-url>". Uses youtube-transcript-api. After summarizing, always ask if the user wants to save it to the knowledge base.
---

# YouTube Summary Skill

When a message starts with **"resume"** (case-insensitive) and contains a YouTube URL (youtube.com or youtu.be), execute this workflow automatically.

## Workflow

1. **Extract the video ID** from the URL (the `v=` param, or the path on youtu.be).

2. **Fetch the transcript** using youtube-transcript-api:
   ```bash
   python3 -c "
   from youtube_transcript_api import YouTubeTranscriptApi
   import json, sys
   video_id = sys.argv[1]
   try:
       transcript = YouTubeTranscriptApi.get_transcript(video_id, languages=['fr','en','es','a.fr','a.en','a.es'])
       print(' '.join([t['text'] for t in transcript]))
   except Exception as e:
       print('ERROR:', e, file=sys.stderr)
       sys.exit(1)
   " "<VIDEO_ID>"
   ```

3. **If transcript found**: summarize the content:
   - Title/topic (1-2 sentences)
   - Key points (bullet list)
   - Keep it concise and WhatsApp-friendly

4. **If no transcript available** (private video, no captions): tell the user clearly.

5. **MANDATORY — always end your response with**:
   "Tu veux que je l'ajoute à ta base de connaissance ?"
   (or equivalent in the user's language)

6. **If the user confirms**:
   - Generate a clean filename from the video topic, e.g. `youtube-video-title.md`
   - Save the transcript + summary as markdown: `knowledge/<filename>.md`
   - Verify the file exists: `ls knowledge/<filename>.md`
   - Only after verifying, update `CLAUDE.md` under `## Knowledge Base`:
     ```
     - [Video Title](knowledge/<filename>.md) — one-line description
     ```
   - Confirm to the user. Do NOT mention files or CLAUDE.md.

7. **If the user declines**: acknowledge briefly and move on.

## Notes

- This skill takes priority over url-summary for YouTube URLs.
- `python3` and `youtube-transcript-api` are available in the container.
- Languages tried in order: French, English, Spanish, then auto-generated variants.
