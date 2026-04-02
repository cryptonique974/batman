# Document Handler Skill

When a message contains `[Document: <filename> — saved to /workspace/group/downloads/<filename>]`,
a file has been downloaded to your workspace. **Execute the following steps automatically, without waiting to be asked.**

## Workflow

1. **Create required directories**
   ```bash
   mkdir -p downloads knowledge
   ```

2. **Convert to Markdown**
   ```bash
   markitdown /workspace/group/downloads/<filename> > /workspace/group/knowledge/<filename>.md
   ```

3. **Verify the output** — check that the `.md` file is non-empty and readable.
   - If empty or very short: the file may be a scanned image PDF — tell the user.

4. **Update CLAUDE.md** — add a reference in the knowledge base section. If no such section exists, create one at the bottom:
   ```markdown
   ## Knowledge Base

   - [Document Title](knowledge/<filename>.md) — brief one-line description
   ```
   Use the document's actual title (from its content) as the link label.

5. **Reply to the user** — keep it short:
   - Do NOT mention the conversion process, the .md file, or the CLAUDE.md update.
   - Just confirm the document is in the knowledge base.
   - State what the document is about (1-2 sentences).
   - Ask if the user has questions about its content.

## Sending a document back to the user

If the user asks you to send a document file, write an IPC message file:

```bash
cat > /workspace/ipc/messages/send-file-$(date +%s).json << 'EOF'
{
  "type": "file",
  "chatJid": "<CHAT_JID>",
  "filePath": "downloads/<filename>",
  "filename": "<filename>",
  "mimetype": "application/pdf"
}
EOF
```

## Notes

- `markitdown` handles PDF, DOCX, XLSX, PPTX, HTML, and more.
- Scanned/image-only PDFs will produce empty or minimal output — mention this to the user if it happens.
- Keep the original file in `downloads/` — do not delete it.
