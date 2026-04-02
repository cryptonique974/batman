---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/capabilities` there to see what I can do.

Then stop — do not generate the report.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

### 2. Container tools

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
which markitdown 2>/dev/null && python3 -c "import youtube_transcript_api; print('youtube-transcript-api: available')" 2>/dev/null || true
```

### 3. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null
```

## Report format

Present a clean, WhatsApp-readable message. Include only what's actually installed/available.

```
*Ce que je peux faire via WhatsApp*

*Messages*
• Texte, vocaux (STT → réponse → TTS), images, documents
• Réactions emoji (<react>👍</react>)
• Envoyer un message à n'importe quel contact ou groupe (@Batman envoie à Noemi que...)
• Envoyer depuis un numéro de téléphone direct

*Résumés*
• Résumer une page web : "resume <url>"
• Résumer une vidéo YouTube + transcript : "resume <youtube-url>"
• Proposer l'ajout à la base de connaissance après chaque résumé

*Documents*
• Réception de PDF, DOCX, XLSX, etc. → conversion automatique en markdown
• Ajout automatique à la base de connaissance + mise à jour CLAUDE.md

*Navigation web*
• Recherche web (WebSearch)
• Lecture de pages web (WebFetch)
• Automatisation navigateur (agent-browser) : formulaires, screenshots, extraction de données

*Tâches planifiées*
• Créer des tâches récurrentes (cron) ou ponctuelles
• Lister, pauser, reprendre, annuler des tâches

*Base de connaissance*
• Lire et écrire des fichiers dans knowledge/
• Mémoriser des informations entre les sessions

*Système*
• Groupes enregistrés : (list from available_groups.json)
• Mémoire groupe : oui/non
• markitdown : oui/non
• youtube-transcript-api : oui/non
• agent-browser : oui/non
```

Adapt based on what you actually find. Don't list tools that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
