# Codophon

Codophon is a desktop code review app for Git, GitHub, and Azure DevOps. It started from [Codiff](https://github.com/nkzw-tech/codiff) by Nakazawa Tech (MIT), with Azure DevOps support from the raels0 fork.
Start with **Walkthrough** to understand what the PR is trying to do and where the design
decisions are. Then jump to the code in **Tree**, or use **Ask** on a line when something
doesn't add up. You can also review local Git changes without setting up an AI agent.

## Install on Windows

1. Build from [source](#development), or use a Windows ZIP when one is available on [Codophon Releases](https://github.com/raels0/codophon/releases). Pick `win32-arm64` for a Windows on Arm machine or `win32-x64` for Intel/AMD. If you're not sure, check **Settings > System > About > System type** in Windows.
2. Extract the **whole ZIP** to a folder you own and run `codophon.exe` from that folder. Don't move the executable out on its own. You don't need the terminal helper on Windows.
3. To review an Azure DevOps PR, follow the [Azure DevOps setup](#open-an-azure-devops-pr). If you're just looking at a local diff, open a Git checkout and you're done.

## Open an Azure DevOps PR

Install Git for Windows and Azure CLI if you don't already have them. In PowerShell:

```powershell
winget install --id Git.Git --exact
winget install --id Microsoft.AzureCLI --exact
```

Open a new PowerShell window and run `az login --allow-no-subscriptions`. In the browser, pick
an account with access to the Azure DevOps organization. You need
access to the PR and Git access to the repo, not an Azure subscription. If the wrong tenant
is selected, use `az login --tenant <tenant-id> --allow-no-subscriptions`.

Clone the repo using its Azure DevOps **Clone** URL if you haven't already. In Codophon, open that
checkout with **File > Open Folder**, then use **+ > Open PR** and paste the full PR URL. Both
`dev.azure.com` and `*.visualstudio.com` links work. You don't need to check out the PR branch.

## Use GitHub Copilot in Codophon

You don't need Copilot to view diffs or post review comments. **OpenCode runs Ask and
Walkthrough with GitHub Copilot. GitHub Copilot CLI supplies the model list.** Those
sign-ins are separate from each other and from Azure CLI.

### 1. Connect OpenCode to GitHub Copilot

1. Install the **OpenCode CLI**, not just its desktop app. [OpenCode 1.19.5](https://github.com/anomalyco/opencode/releases/tag/v1.19.5) is the version I verified. You can extract the matching Windows ZIP and add the folder containing `opencode.exe` to your user `PATH`. Open a new PowerShell window and check `opencode --version`.
2. Run `opencode`, enter `/connect`, and choose **GitHub Copilot**. Sign in with a GitHub account that has Copilot access. Use `github.com` if that's where you sign in to GitHub. Choose the enterprise-host option only if your account uses a separate GitHub Enterprise Cloud hostname.
3. Run `opencode models github-copilot` in PowerShell to see the provider's model IDs. In Codophon, choose **File > Agent > OpenCode**. If Codophon was already running when you changed `PATH`, reopen it first.

**Ask** and **Walkthrough** send review context through OpenCode to the selected model
provider. Opening a diff doesn't call a model. For private repositories, check that
you're allowed to send the code to the provider and model you select.

### 2. Sync and pick a model

On a build with **File > Choose Model…**, install [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli) if needed:

```powershell
winget install --id GitHub.Copilot --exact
```

In a new terminal, run `copilot`, then `/login`. Follow the
[official sign-in instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
for your account, then run `/model` to see what's available. This sign-in doesn't
connect OpenCode. Codophon doesn't run Ask or Walkthrough directly through Copilot CLI.

Back in Codophon, open **File > Choose Model…** and filter by name or ID. Under OpenCode, the
GitHub Copilot choices are the models listed by **both** CLIs. Catalog sync doesn't send a
prompt. If the list looks wrong, check `/model` in Copilot CLI and `opencode models github-copilot`
in PowerShell, then click **Refresh**. Pick an explicit `github-copilot/...` model so you know
what you're starting with. If OpenCode rejects the model, Codophon can retry with OpenCode's
configured default, so make sure that default is approved for the review too.

## Command Line

```bash
codophon
```

Run it from any Git repository, or pass a path:

```bash
codophon /path/to/repository
```

Review a specific commit:

```bash
codophon a1b2c3d
```

Review the current branch against a target branch:

```bash
codophon main
```

Review a GitHub or Azure DevOps pull request using the current repository remote:

```bash
codophon pr 75
codophon pr owner:my-feature-branch
codophon ado 75
```

Branch lookup uses `gh` and selects an open GitHub pull request. Include `owner:` for pull
requests from forks. `codophon pr 75` also works against an Azure DevOps remote. `codophon ado 75`
forces Azure DevOps when a repository has more than one review host.

Full GitHub and Azure DevOps review URLs work too.
For Azure DevOps, see [Open an Azure DevOps PR](#open-an-azure-devops-pr). Codophon uses
the PR's source and target commits and their merge base, not your current branch or uncommitted
changes. Azure SSH remotes also work.

Start with an LLM-generated narrative walkthrough. When generating a walkthrough without an
explicit target, Codophon uses local changes when present and falls back to `HEAD` when the working
tree is clean:

```bash
codophon -w
codophon -w a1b2c3d
```

Show all available options:

```bash
codophon --help
```

Codophon prints its own shell completions for bash, fish and zsh. They complete every flag, the
values those flags accept, and Git refs for the ref argument:

```bash
# bash, in ~/.bashrc
source <(codophon --completions bash)

# fish, in ~/.config/fish/completions/codophon.fish
codophon --completions fish | source

# zsh, on the fpath
codophon --completions zsh > ~/.zsh/completions/_codophon
```

Launching Codophon in multiple repositories opens a separate native window for each repository.

## Command Palette

Click **Commands** in the top toolbar, or open the palette with
<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on macOS, or
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on other platforms.
<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> also works. Type to filter commands, use
<kbd>Up</kbd>/<kbd>Down</kbd> to move through results, press <kbd>Enter</kbd> to run the selected
command, and press <kbd>Esc</kbd> to close it.

The command palette includes actions for common review workflows:

- Increase, Decrease, and Reset Code Font Size
- Review Theme: Neutral Review or Blue/Amber
- Open PR, Branch, Commit, or Folder
- Focus File Filter
- Find in Diffs
- Show File Tree, Show History, and Show Walkthrough
- Copy Review Comments
- Copy Review Comments and Close
- Toggle Viewed for the currently selected file
- Toggle Diff Layout, with the target layout action shown as the hint
- Open the currently selected file in your editor
- Toggle Sidebar
- Refresh Changes, including remote PR state

Use **Edit selected file** in the palette, the pencil in the file header, or `Mod+E` for quick local edits. `Mod+S` saves the file and refreshes its diff.

## Review Themes

Both review presets keep code and line-number backgrounds neutral, including entirely new or
deleted files. Gutter bars and file status show additions and deletions. Small in-place edits
receive precise word highlights with a faint tint, thin rounded outline, and underline,
without replacing syntax colors or highlighting unchanged punctuation between edited words.
Syntax colors are contrast-tuned for both presets in light and dark appearance.

Open **Commands**, search for **review theme**, and choose **Neutral Review** (the default,
green/red markers) or **Blue/Amber**. The selection is saved as `settings.reviewTheme`
(`"neutral"` or `"blue-amber"`) and applies immediately without reloading the PR.
Light/dark appearance remains controlled separately by `settings.theme`.

## Ask About a Review

**Ask** uses your selection as a starting point, not a boundary. It receives the
changed-file list and changes across the review. For pull requests, it can read
related files from the exact before/after commits without using your checkout.
Large reviews are read in smaller pieces, with additional file and text lookups
when needed.

Each answer includes an expandable context summary with the saved version and any
missing or shortened material. If the review or question changes while an answer
is being prepared, ask again rather than relying on an outdated answer.

The default Ask prompt asks for a direct answer with file and line references, not a rewritten
review comment. To change that guidance, open **Agent Settings > Prompts > Ask response**.

Use **Ask a follow-up** below an answer to continue the conversation. Earlier
questions and answers stay visible and are included with the next question.
Click **Send**, or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> or your
usual **Ask** shortcut (by default <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Enter</kbd>); plain
<kbd>Enter</kbd> adds a new line. Failed follow-ups keep the conversation and your
draft so you can retry. **Ask** on the original note starts a fresh conversation.
After the reviewed code or original question changes, start fresh rather than
mixing answers from different versions. Conversations that exceed the input
limit report an explicit error instead of silently dropping earlier exchanges.

You can send questions in different Ask threads without waiting for earlier
answers. Each reply or failure gets a small in-app notification with the file
and question. Click it to jump to the line in the diff, or to the file for a
file-level question.

On a pull request, Codophon saves Ask conversations and follow-up drafts locally
as they change. Reopening the same PR restores threads for the same diff version.
An interrupted request is ready to retry, not sent again automatically. Use
**Ask History** in the command palette to read saved conversations after a
comment is posted or the diff changes. Switching the same review window to
another PR clears the previous PR's cache; closing the app or refreshing the
same PR does not. Windows in the same profile share this cache. If Codophon exits
during a post, check the PR before posting again; the note remains in **Ask
History**, not in the queue of comments to post.

On a pull request, use **Copy Re-review Brief** in the command palette to preview
and copy an **Areas to investigate** checklist. It groups Ask questions and
follow-ups by code location and merges identical notes. For Azure DevOps it also
reads the signed-in user's posted inline comments, general comments, and replies,
including closed threads. Ask questions are saved locally for this feature.
Previously discarded Ask history cannot be recovered. The brief is assembled
locally; Codophon does not send it to an agent or post it to the PR.

## Commit from Walkthrough

For local changes, Walkthrough can propose a commit message and run `git commit`. The terminal in the commit view displays Git and hook output while they run. A pseudo-terminal (PTY) lets hooks use terminal colors and prompts.

## Configuration

Open **File > Open Config File…** on Windows or **Codophon > Open Config File…** on macOS.
The config lives at `~/.codophon/codophon.jsonc`. It supports comments and trailing commas, and
Codophon picks up edits while it's running. On first launch, Codophon imports settings and shortcuts from an existing `~/.codiff/codiff.jsonc` and leaves that file intact.

Set `settings.showWhitespace` to `true` to show whitespace-only changes in diffs and file line
counts; when it is `false`, Codophon hides those changes from the working-tree review state.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/raels0/codophon/main/core/config/codophon-config.schema.json",
  "settings": {
    "agentBackend": "codex",
    "agentPrompts": {},
    "agents": {
      "claude": { "model": "sonnet" },
      "codex": { "model": "gpt-5.6-terra", "reasoningEffort": "" },
      "opencode": { "model": "opencode-default" },
    },
    "codeFontFamily": "",
    "codeFontSize": 13,
    "copyCommentsOnClose": false,
    "diffStyle": "split",
    "editorCommand": "",
    "lastRepositoryPath": "",
    "sidebarPosition": "left",
    "reviewTheme": "neutral",
    "showWhitespace": false,
    "theme": "system",
    "wordWrap": false,
  },
  "keymap": {
    "commandBar": ["Mod+Shift+p", "Mod+k"],
    "diffSearch": "Mod+f",
    "fileFilter": "Mod+p",
    "nextSearchMatch": "Enter",
    "openFile": "Mod+Shift+o",
    "prevSearchMatch": "Shift+Enter",
    "closeSearch": "Escape",
    "submitComment": "Mod+Enter",
    "askAgent": "Mod+Alt+Enter",
    "discardComment": "Escape",
    "toggleSidebar": "Mod+Shift+b",
  },
}
```

Set `settings.editorCommand` to customize file opening. Use `{file}` for the selected file,
`{line}` for its line number when available, and `{repo}` for the repository root, for example
`"subl \"{repo}\" \"{file}\""`.
Set `settings.sidebarPosition` to `left` or `right` to choose which side of the desktop window shows
the file sidebar.

Choose `View > Diff > Split` or `View > Diff > Unified`, use Toggle Diff Layout in the command bar,
or set `settings.diffStyle` to `split` for side-by-side diffs or `unified` for unified diffs.
Choose `View > Diff > Word Wrap`, use Toggle Word Wrap in the command bar, or set
`settings.wordWrap` to `true` to wrap long diff lines.
Choose `View > Diff > Expand Unchanged Lines` or set `settings.expandUnchanged` to `true` to show
full files instead of collapsing unchanged lines between hunks.
Set `settings.renderMarkdownAs` to `source` to open Markdown files as text diffs by default instead
of rendered previews.
Choose `View > Diff > Font Size`, use the code font size commands in the command bar, or use
<kbd>Cmd/Ctrl</kbd>+<kbd>+</kbd>, <kbd>Cmd/Ctrl</kbd>+<kbd>-</kbd>, and
<kbd>Cmd/Ctrl</kbd>+<kbd>0</kbd> to change only diff and code rendering font size.
Set `settings.codeFontFamily` manually to an installed CSS font family name, for example
`"JetBrains Mono"` or `"SF Mono"`. Leave it empty to use Codophon's bundled mono stack.
Use `Mod` for <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> on other platforms. Shortcut strings can
combine `Mod`, `Ctrl`, `Alt`, `Shift`, or `Meta` with a key, for example `Mod+k` or
`Alt+Enter`.

## Walkthroughs

For substantive pull requests, Walkthrough can start with a **Design overview**: the PR’s goal,
what changes from before to after, an optional diagram of the changed flow, and up to three
short explanations of how the change works. Use **View implementation** to jump to the cited diff hunk.
Codophon distinguishes inferred goals from stated intent and flags incomplete patch evidence.

Codophon uses a local agent CLI for walkthroughs and inline review assistance. On the first launch
without an existing config file, it selects the first installed CLI in this order: Codex, Claude
Code, then OpenCode. This checks executable presence only and persists the selection. If none
are installed, Codophon keeps Codex as the default. After that, select a backend with the
`settings.agentBackend` config value (or the `--agent` flag for a single launch) and the `Agent`
application menu:

- `codex` (default) — the OpenAI Codex CLI, configured with `settings.agents.codex.model`.
- `claude` — the [Claude Code](https://claude.com/claude-code) CLI, configured with `settings.agents.claude.model`.
- `opencode` — the [OpenCode](https://opencode.ai/) CLI, configured with
  `settings.agents.opencode.model`.

For Codex, **Choose Model…** and **Reasoning Effort** use the installed CLI's model catalog.
They show its visible models and supported reasoning efforts, including new models
without a Codophon update. Legacy models omitted from a successful catalog, including GPT-5.5,
remain configurable by ID; a selected model missing from the catalog appears as a custom choice.
If discovery fails or an older CLI does not support it, the predefined model choices remain
available, and selecting Codex or changing configuration retries discovery. Custom model IDs in
`settings.agents.codex.model` are also accepted.

Set `settings.agents.codex.reasoningEffort` to an effort supported by your selected model, for example
`"high"` with `settings.agents.codex.model` set to `"gpt-6.1-sol"`. Selecting a different model in the menu
resets an explicit effort that the new model does not advertise. Leave the effort empty to keep
Codophon's existing defaults for its predefined models and inherit Codex settings for other models.
An unsupported explicit effort reports an error rather than triggering a model fallback.
An explicit effort also applies to a fallback model; clear it to use that model's default.
Walkthrough caches distinguish explicit reasoning efforts, so a new generation request with a
different effort does not reuse the previous effort's result.

Codex walkthroughs still default to GPT-5.6 Terra with low reasoning. GPT-5.6 Sol and Luna use
medium reasoning unless you override it. If a selected model is unavailable, Codophon retries with
Terra when applicable and then GPT-5.5, persisting the first model that succeeds unless you changed
the selection during the run. Walkthroughs with at least 100 reviewable hunks use GPT-5.5 with low
reasoning when Terra is the configured default and no explicit effort is configured. An explicit
effort keeps the selected model for these large walkthroughs.

Install the backend you want and verify it is available before using `codophon -w`:

```bash
codex --version
claude --version
opencode --version
```

Codophon looks for the CLI on `PATH` and the usual install locations. On macOS, it also recognizes
the CLI embedded in `Codex.app` or `ChatGPT.app` under `/Applications` or `~/Applications`. It does
not run your shell startup files to discover CLIs. If a CLI is installed somewhere else, launch
Codophon with an explicit path:

```bash
CODOPHON_CODEX_PATH=/absolute/path/to/codex codophon -w
CODOPHON_CLAUDE_PATH=/absolute/path/to/claude codophon --agent claude -w
CODOPHON_OPENCODE_PATH=/absolute/path/to/opencode codophon --agent opencode -w
```

Claude Code rides your existing `claude` login (subscription or `ANTHROPIC_API_KEY`); run `claude`
once and complete `/login` if you have not already.

OpenCode keeps its own configured model when `settings.agents.opencode.model` is `opencode-default`.
Choose another model from **Choose Model…**, or set a provider-qualified ID such as
`anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`, or another model available to your OpenCode
account. When Codophon launches OpenCode for walkthroughs or review assistance and an explicit model
is unavailable, it retries with OpenCode's configured default and persists that fallback. The
managed `/codophon` command runs directly in OpenCode, so OpenCode reports access errors for its
selected model; choose `opencode-default` when portability is more important than pinning.

To change how a walkthrough reads, go to **File > Agent Settings… > Prompts** on Windows
(**Codophon > Agent Settings…** on macOS). Start with **Walkthrough summary** if you want a different
opening. You can edit and reset the design overview, titles, stop explanations, regeneration
guidance, Ask replies, and commit messages separately. Saving changes the next generation, not
the walkthrough already on screen. The output format and diff evidence rules stay the same.
Set `settings.agentPrompts.walkthrough` to add guidance across the walkthrough. Existing config files using `settings.walkthroughPrompt` or top-level model settings are read automatically.

To drive Codophon from your agent, install its integration from the application menu under
`Install Skill`, then choose Codex, Claude Code, or OpenCode. Codophon updates keep the installed
skill current. The OpenCode integration also installs a managed `/codophon` command that uses
`settings.agents.opencode.model`; choosing `opencode-default` leaves the command unpinned. Invoke it from
the agent:

```text
$codophon       /codophon        # author a narrative walkthrough and open Codophon
```

In OpenCode, `/codophon` uses the model selected in Codophon while `$codophon` runs as part of the
current session and therefore uses that session's active model.

`codophon` asks Codophon for the current authoring guide (`codophon --walkthrough-guide`), writes a
narrative walkthrough JSON to a temporary file, and opens Codophon on it with `--walkthrough-file`
plus the current session id. Because the guidance lives in Codophon, the installed skill stays a thin
shim while the walkthrough sees the original conversation context without a lossy summary handoff.

## Development

Use Node.js 24.21.0 or later.

```bash
vp install
vpr build
vpr codophon
```

For live development:

```bash
vpr dev
ELECTRON_RENDERER_URL=http://127.0.0.1:5173 vpr electron
```

Useful checks:

```bash
vp check
vp test
vp run test:e2e
vp build
```

## Contributing

Found an issue, or want to improve something? See the
[contributing guide](CONTRIBUTING.md) for desktop development and testing.
