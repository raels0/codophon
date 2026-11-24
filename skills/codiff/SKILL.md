---
name: codiff
description: Open Codiff for a narrative code walkthrough. Use when the user writes "$codiff", "/codiff", "show me codiff", "open Codiff", or asks to review a change in Codiff.
metadata:
  short-description: Review a code change in Codiff
---

# Codiff

Use Codiff to review a **narrative walkthrough** of a code change.

You write the JSON yourself because you already hold the conversation that produced the
change. Codiff owns the format and authoring guidance, so this skill only handles the handoff.

## Walkthrough Workflow

1. **Get the current guidance from Codiff.** It explains the data model and prints the JSON
   schema:

   ```bash
   node scripts/open-codiff.mjs --guide
   ```

2. **Pick the change.** Default to the staged diff (`git diff --staged`). If the user named a
   target such as a commit, `HEAD`, a PR, a range, or a path, use that. If nothing is
   staged, fall back to the working tree (`git diff`) and say so.

3. **Author the JSON** per the guide and write it to a unique temporary file outside the
   repository, such as `$TMPDIR/codiff-walkthrough-<id>.json`.

4. **Open the walkthrough in Codiff.**

   ```bash
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   **Agent integration:** The launcher detects Claude Code, Codex, or OpenCode from the
   environment and links the current session so follow-up questions in Codiff continue the
   conversation. Pass `--agent claude|codex|opencode` if detection picks the wrong agent.

   If a `hunkId` does not resolve, the command exits non-zero and prints the diff's real ids.
   Fix the document and rerun.

Emit walkthrough JSON only into the temporary file. Do not summarize the conversation back to
the user.
