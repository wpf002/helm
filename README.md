# Helm

A macOS terminal that runs both a real shell and the Claude agent loop behind a
single prompt, scoped to the whole home directory.

One input box. Lines that are shell commands go to a PTY. Lines that are
questions go to the agent. Both render into the same scrollback in real time
order, so `git status` and the agent's own `git status` land in one transcript
rather than two.

## Why this instead of `claude`

The CLI is directory-scoped and single-surface. Anthropic's desktop app adds
panes but keeps the chat and the terminal as separate things you switch between.
Helm merges them and puts the permission layer under your own UI, so approval
decisions show resolved paths and scope violations instead of a JSON blob.

If you don't need those three things, use the CLI. It is better at everything
else.

## Architecture

```
apps/desktop        Electron shell — main, preload, renderer
packages/shared     IPC contract and the StreamEvent union. No dependencies.
packages/engine     Agent SDK wrapper. No Electron imports — runs from plain node.
packages/shell      node-pty session manager. Main process only.
```

The renderer runs with `contextIsolation` on and reaches nothing directly. Every
capability crosses the preload bridge or does not exist.
`scripts/check-boundaries.sh` fails the build if that slips.

`packages/engine` staying free of Electron is deliberate: it keeps the Phase 0
auth probe and any later headless use from dragging the desktop app in, and it
keeps the routing and scope logic unit-testable without spawning a window.

### Input routing

`routeInput()` decides shell vs agent. Explicit prefixes win — `$` forces shell,
`?` forces agent. Otherwise a line whose first token resolves on PATH and which
carries no sentence punctuation goes to the shell.

Ties break toward the agent. A misrouted prompt wastes a turn; a misrouted shell
command can be destructive.

**Decided: bare input goes to the shell, not the agent.** The Phase 2 brief said
the opposite. Routing bare input to the agent requires Helm to own the line
editor for every line, which costs zsh's completion, history and Ctrl+R — the
things the Phase 1 kill gate was about — and makes typing `ls` cost an API turn,
against the always-available constraint. `?` opens a Helm-owned compose line;
everything else stays raw zsh. Phase 3's inference will decide bare input on
evidence instead, and this is the conservative default until it does. To flip
it, route the default branch of the input state machine in
`apps/desktop/src/renderer/src/App.tsx` into compose mode.

Prefix detection walks each input chunk character by character. Input arrives in
chunks, not keystrokes — a paste delivers a whole line in one event — so
comparing the whole payload against `'?'` only ever matches hand-typing and
silently misroutes anything pasted.

### Permissions

The Agent SDK's `canUseTool` callback fires over IPC to the renderer. Before the
prompt renders, `resolveAffectedPaths()` resolves symlinks and computes the
absolute paths the call would touch, and flags anything outside the configured
roots. Session-scoped "remember this" decisions are cleared on every new
session — a grant must not outlive the window it was made in.

`HELM_PERMISSION_MODE=off` exists. On a home-directory-wide agent it means every
tool call runs unreviewed. Use it deliberately or not at all.

## Setup

```bash
pnpm install
cp .env.example .env
```

### Phase 0 — verify auth before building anything

The SDK bundles its own Claude Code binary. Confirm your subscription
credentials carry through rather than falling back to metered API billing:

```bash
claude                          # authenticate once if you haven't
node scripts/probe-auth.mjs
```

Then check usage at console.anthropic.com. Zero new usage means the subscription
carried. Nonzero means every keystroke is billed per token, and the economics of
this app change enough to reconsider the build.

### Run

```bash
pnpm dev
```

### Package

```bash
pnpm package
pnpm sign:dev
```

## macOS specifics

Full Disk Access is required or reads into Documents, Desktop, and Downloads
fail. Grant it to the built `.app` under System Settings > Privacy & Security >
Full Disk Access.

**The grant is keyed to the code signature.** electron-builder signs ad-hoc by
default, producing a new signature on every build, and macOS silently drops the
grant each time. `pnpm sign:dev` signs with a stable self-signed identity so the
grant survives. Create the identity once — instructions are at the top of
`scripts/sign-dev.sh`.

`node-pty` is native and must be rebuilt against Electron's ABI. The root
`postinstall` runs `electron-builder install-app-deps` for this. A
`NODE_MODULE_VERSION` mismatch at startup means that step didn't run.

## Standing constraints

These hold across every phase. A change that violates one is wrong even if the
phase it belongs to is "done".

**Always available.** The terminal is the product. It must be usable the instant
the window appears, and must never be gated on anything else finishing its
startup — not the agent SDK, not a network call, not credential refresh. The pty
spawns first and independently; the agent initialises lazily, in the background,
and a failure there degrades Helm to a plain terminal rather than breaking it.
Once packaged, Helm stays resident so it is there when reached for rather than
cold-starting: the window hides instead of quitting, and a global hotkey brings
it back.

**Helm is its own application.** Not an Electron shell wearing a Helm label.
That means its own bundle identity (`com.wpf002.helm`), its own name in the menu
bar, Dock, and About panel, its own icon, its own user-data directory, and its
own process names — nothing user-visible reading "Electron". Electron is the
runtime, the way Chromium is Chrome's runtime; it is an implementation detail,
never the identity. (Leaving Electron altogether is a different project and
would contradict the first non-negotiable — it is not what this constraint
means.)

## Roadmap

Each phase ends in something usable. Stop at any of them.

**Phase 0 — auth gate.** Confirm how the SDK authenticates before building on
it. *Done.* Resolved to a metered `ANTHROPIC_API_KEY` in `.env`: the OAuth
record in the keychain had no refresh token, so subscription credentials could
not carry. One trivial turn cost $0.16, almost all of it the ~26k-token system
prompt, which is why the engine trims that aggressively.

**Phase 1 — terminal.** xterm.js over node-pty, OSC 7 cwd tracking, resize,
window chrome. No agent. *Done.* Ship point: a terminal you'd actually use.
Kill gate: if you don't prefer it to iTerm, the rest doesn't matter.

**Phase 2 — agent, single surface.** Agent SDK wired into the same scroll
container. Explicit `$`/`?` prefixes only, no inference. Permission prompts are
raw JSON. The agent must initialise lazily so it never delays the shell, per the
always-available constraint.
Kill gate: unified scrollback has to beat two windows. If it doesn't, you've
rebuilt the desktop app worse.

**Phase 3 — routing.** `routeInput()` with PATH scanning. Log every decision
with the rule that fired. *Done, running in shadow mode.*
Kill gate: measure misroute rate over a week of real use. Above 5% and the
inference is a liability — fall back to Phase 2 prefixes permanently.

Inference is implemented and logged but does **not** decide anything yet.
Every line you run is recorded alongside the verdict `routeInput()` would have
reached, so the misroute rate is measured before it is trusted — which is the
point of the kill gate. Switching it on before the data exists would be
deciding the gate by assumption.

Shell lines are reported by a `preexec` hook in `scripts/helm-osc7.zsh`:
`preexec` sees the final command after history recall and completion, which
nothing on Helm's side can reconstruct from keystrokes. Run
`pnpm routing:report` to see the distribution and the current misroute rate.

**Phase 4 — scope UI.** `resolveAffectedPaths()`, symlink resolution,
out-of-scope flagging, session-scoped persistence. *Done.* Includes a
`PreToolUse` hook, without which the SDK's own safe-command classification
lets calls through without Helm ever seeing them.
Kill gate: this is the one feature the official app doesn't have. If it doesn't
change how you approve things, the project's differentiator was imaginary.

**Phase 5 — package, install, and identity.** Generate the icon and rasterize
the full `.iconset` ladder into `icon.icns`. Build, sign with the stable
self-signed identity, install to `/Applications`, and pin to the Dock without
stacking duplicates. This phase is where both standing constraints are finally
paid off: the app becomes resident (window close hides rather than quits, global
`Cmd+Shift+H` toggles it) and fully self-identifying (own icon, bundle id, and
process names). Verify no user-visible surface reads "Electron".

**Phase 6 — sessions.** Multiple concurrent sessions, transcript persistence,
resume. *Done.*

Each session owns its own xterm instance, so switching tabs shows a different
surface rather than replaying one — scrollback, cursor and any running
full-screen program survive a switch untouched.

Transcripts record **events, not rendered text**: `{t:'pty'}` and `{t:'agent'}`
entries replay through the same code path that drew them live, so a resumed
session cannot drift from what the renderer would produce today. Capped at 8MB
per session, oldest pruned past 20, and a write failure drops the sink rather
than taking the terminal with it.

`⌘T` new, `⌘W` close, `⌘⇧R` resume, plus `+` and `⟲` in the tab strip — the
menu accelerators alone were undiscoverable.

## Conventions

- No LLM output on any control path. The agent narrates and edits; routing,
  scope resolution, and permission decisions are deterministic code.
- `packages/shared` has zero dependencies and stays that way.
- New `StreamEvent` kinds must fail the renderer typecheck, not render blank.
