# Installation

## Requirements

- Linux. Verified on Ubuntu 24.04; other modern distributions should work but are not tested.
- Bash and Node 18 or newer.
- `flock`, `mktemp`, `timeout`, `awk`, `sed`, `grep`, `find`, `sha256sum`.
- Claude Code, as the controller.
- The Codex CLI, authenticated, as the independent reviewer.
- `~/.local/bin` on your `PATH`.

No sudo, ever. Everything lives under your home directory.

## Installing

```bash
./install.sh --dry-run    # shows every destination, changes nothing
./install.sh
dual-audit doctor
```

### What is installed

| Path | |
|---|---|
| `~/.claude/workflows/dual-audit-panel.js` | the review protocol |
| `~/.claude/workflows/dual-audit-run.js` | the driver |
| `~/.claude/agents/dual-audit-codex-readonly.md` | the read-only reviewer |
| `~/.claude/skills/dual-audit/SKILL.md` | full panel |
| `~/.claude/skills/light-audit/SKILL.md` | one second opinion |
| `~/.local/bin/dual-audit` | CLI: `doctor`, `profile`, `paths`, `version` |
| `~/.local/bin/dual-audit-codex` | hardened read-only reviewer wrapper |
| `~/.local/bin/dual-audit-lint` | bypass linter |
| `~/.local/share/dual-audit/` | library, base profiles, ownership manifest |
| `~/.config/dual-audit/profile.yaml` | **yours** — created once, never overwritten |

### What the installer will not do

- **It will not overwrite a file it does not own.** Ownership comes from the manifest, which
  records a hash of everything written.
- **It will not overwrite a file you modified after installation.** Both cases stop the install
  with the paths listed, and nothing is changed. `--force` proceeds and backs each one up to
  `<file>.bak-dual-audit` first.
- **It will not write through a symlink.**
- **It will not touch anything else in those directories.**

Paths are resolved at install time, not at run time: the driver is given the absolute path of the
installed panel, and the skills are given the absolute path of your profile. Launching a workflow
by name can resolve to a cached copy, and a stale panel converges on state the current one would
refuse. An absolute path is read from disk every time.

## Upgrading

Pull and run `./install.sh` again. Files you have not modified are replaced; files you modified
stop the install so you can decide.

Your profile is never touched. After upgrading, run `dual-audit profile apply` to recompile it into
the new panel — `doctor` reports `PROFILE_STALE` if you forget.

## Removing

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

It removes only files whose hash still matches the manifest. A file you edited is **kept** and
reported: uninstalling must not be a way to lose your own work. Your profile survives unless you
explicitly pass `--purge-profile`.

## Testing without touching your real setup

Every path honours the usual environment overrides, so a complete install can happen inside a
throwaway home directory:

```bash
T=$(mktemp -d)
HOME=$T PATH="$T/.local/bin:$PATH" ./install.sh
HOME=$T PATH="$T/.local/bin:$PATH" dual-audit doctor
HOME=$T ./uninstall.sh
rm -rf "$T"
```

`tests/test_install.sh` does exactly this, including the refusal and backup paths.

## Start a new session before the first audit

The installer writes an agent definition and two skills into your Claude Code configuration
directory. A session that was **already running** when you installed does not necessarily pick them
up, and a request for an agent type that is not yet registered fails before anything runs — which
the panel reports as `INFRASTRUCTURE_BLOCKED` with an empty reviewer output, indistinguishable from
Codex being down. Restart, or open a new session, and the first audit will work.

This is fail-closed, not dangerous: the panel refuses to converge rather than treating the silence
as approval. It is just confusing the first time.

## Verifying the whole tree

```bash
bash tests/run-all.sh              # every suite; no paid model is called
bash scripts/sanitize-scan.sh      # no secrets, personal paths, e-mail or non-English source text
```

The reviewer tests exercise refusal paths only, and the protocol tests stub both reviewers, so the
suite costs nothing to run.
