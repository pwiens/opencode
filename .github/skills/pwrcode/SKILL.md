---
name: pwrcode
description: >-
  Maintain the pwrcode fork of opencode — a long-lived patch series on top of
  anomalyco/opencode. Covers branch hygiene, rebase workflow on upstream dev,
  adding new patches, verifying builds, and the copilot-cli config loading
  feature this fork ships. Use when adding or modifying patches, rebasing on
  upstream, debugging build/typecheck failures, or touching any of the copilot
  loaders.
---

# pwrcode — opencode fork maintenance

This is the **pwrcode** fork of [anomalyco/opencode](https://github.com/anomalyco/opencode)
(formerly `sst/opencode`, redirects). The fork lives at
[`github:pwiens/opencode`](https://github.com/pwiens/opencode) with `pwrcode` as
the default and only long-lived branch. Patches are commits on that branch;
the branch is rebased on upstream `dev` periodically.

The Nix integration in `~/.dotfiles` consumes this fork via a flake input and
renames the binary to `pwrcode` at the derivation level (symlink only — no
source patch for the binary name).

## Layout

| Thing | Where |
|---|---|
| This repo | `~/code/personal/opencode/` |
| Remote | `origin` = `pwiens/opencode`, `upstream` = `anomalyco/opencode` |
| Branch | `pwrcode` (default; only long-lived branch) |
| Binary (installed) | `pwrcode` on `$PATH` (`/run/current-system/sw/bin/pwrcode`) |
| Config dir (installed) | `~/.config/opencode/` (see "Why config dir is still opencode" below) |
| Flake input (dotfiles) | `pwrcode` in `~/.dotfiles/flake.nix`, follows `nixpkgs-unstable` |
| Overlay (dotfiles) | `pwrcode` in `~/.dotfiles/overlays/default.nix` — symlinks `bin/opencode` to `bin/pwrcode` |
| Install site (dotfiles) | `pkgs.pwrcode` in `hosts/common/optional/development.nix` |

## Why config dir is still `~/.config/opencode/`

The config path is baked into the program (`OPENCODE_CONFIG_DIR` env var,
`Global.Path.config`, hundreds of internal references). Patching it across the
codebase would balloon the patch series and create constant rebase conflicts.
The binary is renamed at the Nix derivation level only (symlink in
`postBuild`).

If a distinct config dir is ever wanted, set `OPENCODE_CONFIG_DIR` in a wrapper
script. **Don't patch the source for this.**

## Current patches

As of the initial release (`b5d7aff`):

1. **Add copilot config schema + resolver** — top-level
   `copilot: true | {enabled, instructions, skills, mcp, agents, prompts}`
   field. Auto-detects via `.github/copilot-instructions.md` walk-up.
2. **Skills loader** — `~/.copilot/skills/<name>/SKILL.md` and
   `.github/skills/<name>/SKILL.md`.
3. **Instructions loader** — `~/.copilot/copilot-instructions.md`,
   `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`.
4. **MCP loader** — `~/.copilot/mcp-config.json`, `.github/mcp.json`,
   `.vscode/mcp.json` (handles both `mcpServers` and `servers` shapes).
5. **Agents loader** — `.github/agents/*.agent.md`.
6. **Prompts loader** — `.github/prompts/*.prompt.md` → opencode commands.
7. **Regenerate SDK types** — auto-derived from the schema change.

All loaders gate on the resolved `copilot.<subsystem>` flag. Existing opencode
config wins on key conflict so users can override or disable imported items.

## Where the load logic lives

| Subsystem | File |
|---|---|
| Schema + resolver + auto-detect | `packages/opencode/src/config/copilot.ts` |
| MCP / agents / prompts loaders | `packages/opencode/src/config/copilot.ts` (`loadMcpServers`, `loadAgents`, `loadPrompts`) |
| Skills loader | `packages/opencode/src/skill/index.ts` (search for `COPILOT_GLOBAL_DIR`) |
| Instructions loader | `packages/opencode/src/session/instruction.ts` (search for `copilot.instructions`) |
| Wire-up + state plumbing | `packages/opencode/src/config/config.ts` (search for `resolvedCopilot`) |
| `getCopilot()` on Service | `packages/opencode/src/config/config.ts` |
| Test fixture | `packages/opencode/test/fixture/config.ts` |
| SDK types | `packages/sdk/js/src/v2/gen/types.gen.ts` (regenerated) |

## Workflows

### Rebase on upstream (do this periodically)

```bash
cd ~/code/personal/opencode
git fetch upstream
git rebase upstream/dev
# Typical conflict files: copilot.ts (new), config.ts, instruction.ts,
# skill/index.ts, fixture/config.ts, sdk/types.gen.ts
nix develop --command bun --cwd packages/opencode tsc --noEmit
git push --force-with-lease --no-verify origin pwrcode

cd ~/.dotfiles
nix flake update pwrcode
just rebuild
```

### Add a new patch

Append commits on `pwrcode`. One feature per commit makes rebase easier.

```bash
cd ~/code/personal/opencode
git checkout pwrcode
# edit
nix develop --command bun --cwd packages/opencode tsc --noEmit
nix develop --command bun turbo typecheck     # full repo
git add -A
git commit -m "Short feature title

Longer explanation of what and why."
git push --no-verify origin pwrcode
cd ~/.dotfiles
nix flake update pwrcode
just rebuild
```

### Verify a build locally before bumping the dotfiles input

```bash
cd ~/code/personal/opencode
nix build .#opencode -o result-pwrcode
./result-pwrcode/bin/opencode --version
./result-pwrcode/bin/opencode                # smoke test interactively
```

### Test the copilot loaders end-to-end

In a repo that has a `.github/copilot-instructions.md` plus skills / MCP /
agents / prompts under `.github/` and `~/.copilot/`, the loaders should
auto-activate. Override in `opencode.json`:

```jsonc
{
  "copilot": {
    "enabled": "auto",        // or true / false
    "mcp": false,             // disable individual subsystems
    "agents": false
  }
}
```

## Gotchas

### `bun: command not found` on `git push`

The repo ships a husky `pre-push` hook that runs typecheck via `bun`. Bun is
not on the system `$PATH` outside the Nix dev shell. Always push with
`--no-verify` (or run `git push` from inside `nix develop`).

### `nix develop` is required for `bun install`

The dev shell provides `node-gyp` and a node toolchain that some native deps
(`tree-sitter-powershell`) need to build. Plain `nix shell nixpkgs#bun` is not
enough.

```bash
nix develop --command bun install
nix develop --command bun --cwd packages/opencode tsc --noEmit
nix develop --command bun turbo typecheck     # all workspaces
```

### Pre-existing test failures on upstream `dev`

These failures exist with **zero patches applied** — do not treat as
regressions:

- `Project.fromDirectory with bare repos > *`
- `Worktree.remove > continues when git remove exits non-zero after detaching`
- `HttpApi Server.listen > *`
- `pty HttpApi bridge > *`

If a rebase ever exposes a *new* test failure, that's worth investigating.

### Nvidia kmod failures break `just rebuild` on this dotfiles repo

Independent issue. The `pwrcode` overlay can be validated without a full
system rebuild:

```bash
cd ~/.dotfiles
nix build --impure --expr \
  '(import <nixpkgs> {
     overlays = [ (import ./overlays {
       inputs = (builtins.getFlake (toString ./.)).inputs;
     }).default ];
     system = builtins.currentSystem;
   }).pwrcode' --no-link --print-out-paths
```

### SDK types are generated

`packages/sdk/js/src/v2/gen/types.gen.ts` is regenerated by a script after
schema changes. After modifying any `Schema.Struct` field in `config.ts`, run
the typecheck — the script auto-regenerates and the diff lands in your working
tree. Commit it as a separate "regen SDK types" patch.

## Adding a new copilot-CLI-style asset

If you want to load yet another Copilot CLI config asset (e.g., hooks, plugins,
LSP), the pattern is:

1. Add a new boolean field to the `copilot` config struct in
   `src/config/copilot.ts` (`Info` and `Resolved`).
2. Update the `resolve()` function so the new field inherits from the master
   switch / auto-detect.
3. Add a loader function in `src/config/copilot.ts` next to `loadMcpServers`
   / `loadAgents` / `loadPrompts`.
4. Wire it into `loadInstanceState` in `src/config/config.ts`, gated on
   `resolvedCopilot.<field>`.
5. Update `test/fixture/config.ts` to include the new boolean in the
   default `getCopilot()` stub.
6. Run `bun --cwd packages/opencode tsc --noEmit` — SDK types regenerate.
7. Commit each step as separate commits where it makes sense, but a single
   "add <X> loader" commit is fine if the change is tight.

Mirror the existing pattern in the order: schema → loader function → wire-up
→ fixture → SDK regen.
