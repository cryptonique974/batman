---
name: send-to-group
description: Send a WhatsApp message to any registered contact, group, or phone number on behalf of the user. Use when the user asks to message someone else (e.g. "envoie un message à Noemi", "dis à Lila que...", "send to BatChat...").
---

# Send Message to Another Group/Contact

When the user asks you to send a message to another contact or group (e.g. "envoie un message à Noemi", "dis à Lila que...", "send to BatChat..."), use this workflow.

## Find the target JID

**If the user gives a name** — read the available groups list and match:
```bash
cat /workspace/ipc/available_groups.json
```

**If the user gives a phone number** — build the JID directly:
- Strip all non-digits and remove leading `+`: `+52 1 998 318 6424` → `5219983186424`
- Append `@s.whatsapp.net`: `5219983186424@s.whatsapp.net`

**For WhatsApp groups** — JID ends with `@g.us` (found in available_groups.json).

## Send the message

Write an IPC file to your messages directory:
```bash
cat > /workspace/ipc/messages/send-$(date +%s%N).json << 'EOF'
{
  "type": "message",
  "chatJid": "<TARGET_JID>",
  "text": "<MESSAGE_TEXT>"
}
EOF
```

NanoClaw picks it up within ~1 second and delivers it.

## Confirm to the user

One short sentence confirming the message was sent. Do not mention IPC, JIDs, or files.

## Notes

- You can send to any WhatsApp number, not just registered contacts. If the user provides a phone number, use it directly.
- If the target is not found, tell the user which contacts/groups are available.
- You can send on behalf of Mat (e.g. "dis à Noemi que je serai en retard") — just write the message in the appropriate language for the recipient.
- The message will appear as coming from the Batman number, not Mat's personal number.
