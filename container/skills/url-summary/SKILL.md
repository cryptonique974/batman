---
name: url-summary
description: Fetch and summarize any web page URL when the user sends "resume <url>" (non-YouTube). After summarizing, always ask if the user wants to save it to the knowledge base.
---

# URL Summary Skill

When a message starts with the word **"resume"** (case-insensitive) followed by a URL that is **NOT a YouTube URL** (not youtube.com or youtu.be), execute this workflow automatically. YouTube URLs are handled by the youtube-summary skill.

## Workflow

1. **Fetch the page** using the WebFetch tool on the provided URL.

2. **Summarize** the content concisely:
   - What the page/article is about (2-4 sentences)
   - Key points or takeaways (bullet list if relevant)
   - Keep it short and readable for WhatsApp

3. **MANDATORY — always end your response with this question**, no exceptions:
   "Tu veux que je l'ajoute à ta base de connaissance ?"
   (or equivalent in the user's language)
   Do NOT mention .md files, CLAUDE.md, or any technical detail.

4. **If the user confirms** (yes / oui / ouais / yep / etc.):
   - Generate a clean filename from the page title (lowercase, hyphens, no special chars), e.g. `article-polymarket-strategies.md`
   - Save the full content as markdown: `knowledge/<filename>.md`
   - Verify the file was written: `ls knowledge/<filename>.md`
   - Only AFTER verifying the file exists, update `CLAUDE.md` — add a reference under `## Knowledge Base`:
     ```
     - [Page Title](knowledge/<filename>.md) — one-line description
     ```
   - Confirm to the user with one sentence. Do NOT mention files or CLAUDE.md.

5. **If the user declines**: just acknowledge briefly and move on.

## Notes

- Works with articles, blog posts, documentation pages, news, etc.
- If the page requires authentication or returns an error, tell the user.
- If the page content is very long, summarize only the most relevant parts.
