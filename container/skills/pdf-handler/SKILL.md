# PDF Reader Skill

When a message arrives as `[PDF: filename.pdf — saved to downloads/filename.pdf. ...]`,
a PDF file has been downloaded to your workspace. Follow these steps automatically:

## Workflow

1. **Convert to Markdown**
   ```bash
   markitdown downloads/filename.pdf > knowledge/filename.md
   ```

2. **Verify the output** — check that `knowledge/filename.md` is non-empty and readable.

3. **Update CLAUDE.md** — add a reference under `## Knowledge Base`:
   ```markdown
   - [Document Title](knowledge/filename.md) — brief one-line description
   ```
   Use the document's actual title (from its content) as the link label.

4. **Reply to the user** — keep it short:
   - Do NOT mention the conversion, the .md file, or the CLAUDE.md update. The user does not care about these technical steps.
   - Just tell the user that the document has been successfully added to assistant´s knowledge base
   - Also tell the user what the document is about (1-2 sentences)
   - Ask if the user have questions about its content

## Sending a PDF back to the user

If the user asks you to send them a PDF file (e.g. one you downloaded earlier), write an IPC message file:

```bash
cat > /workspace/ipc/messages/send-file-$(date +%s).json << 'EOF'
{
  "type": "file",
  "chatJid": "<CHAT_JID>",
  "filePath": "downloads/<filename.pdf>",
  "filename": "<filename.pdf>",
  "mimetype": "application/pdf"
}
EOF
```

- `chatJid` is the WhatsApp JID of the current chat (available in your context as the group JID).
- `filePath` is relative to the group workspace root (e.g. `downloads/report.pdf`).
- NanoClaw will detect the file, read it from disk, and send it via WhatsApp automatically within a few seconds.

## Notes

- `markitdown` is available in the container and handles text-based PDFs.
- Scanned/image-only PDFs will produce empty or minimal output — mention this to the user if it happens.
- The `downloads/` folder is writable. The `knowledge/` folder is writable.
- Do not delete the original PDF from `downloads/` — keep it for reference.
