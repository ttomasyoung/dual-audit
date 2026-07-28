# Configuration

## Your profile

`~/.config/dual-audit/profile.yaml` is created once by the installer and never overwritten. After
editing it, run:

```bash
dual-audit profile apply    # recompile it into the installed panel
dual-audit doctor           # check it
dual-audit profile routing  # the routing table the controller actually uses
```

`profile routing` exists because the trigger lists are **inherited**. A user profile names a base
(`base: default` or `base: research`) and does not repeat that base's `routing:` block, so reading
your own file shows no routing keys at all — which looks like "there are no triggers" rather than
"they live one level up". `profile show` does not fill the gap either: it prints what is compiled
into the panel, and routing deliberately is not (the panel reviews; the controller routes). Write
your own `routing:` block only if you want to replace the inherited table outright — it is not
merged key by key.

The apply step is necessary because the panel runs in a sandbox with no filesystem access, so the
parts it needs are compiled into it. `doctor` reports `PROFILE_STALE` when the file has changed
since the last apply, rather than letting you believe an edit took effect.

### Schema

```yaml
version: 1                # must be 1
base: default             # default | research
customized: false         # automatic routing is OFF until this is true

critical_areas:           # what a full audit is for, in YOUR work
  - name: "Release and deployment"
    keywords: ["deploy", "release", "publish", "migration"]
    route: full           # full | light

projects:                 # optional anchors, injected when a caller passes `project: <id>`
  - id: my-service
    rules: "Working conclusions. Claude side only."
    docs: "Canonical document PATHS. This is what the independent reviewer sees."

evidence:
  brief_note: ""          # extra text appended to BOTH briefs; empty uses the base profile's
```

Validation refuses, rather than quietly accepting:

- an area with **no keywords** — it could never match;
- the keyword `*` — everything would become a full audit;
- two project ids differing only in case — matching is case-insensitive;
- a non-boolean `customized`, an unknown `base`, an unknown `route`.

It **warns** about a keyword shorter than three characters (it will match far more than intended)
and a project with no `docs` pointer (a high-risk audit naming it will still demand
`contextPack.canonical_docs`, because the independent reviewer needs something it can read).

### Why `rules` and `docs` are separate

`rules` may state what your project currently believes. `docs` gives only paths. The independent
reviewer receives `docs`, never `rules` — handing conclusions to a reviewer whose entire value is
independence turns it into a rubber stamp.

### The supported YAML subset

Nested maps by two-space indentation, lists of scalars, lists of maps, single-line plain or quoted
scalars, flow lists (`[a, b, "c d"]`), `#` comments, and `[]` for an empty list.

**Not supported, and refused loudly:** tabs for indentation, block scalars (`|`, `>`), anchors and
aliases (`&`, `*`), flow maps (`{}`), multiple documents, multi-line strings, and duplicate keys.
Every one of these produces an error naming the file and line. A parser that guesses is worse than
one that refuses: a silently misread routing rule is a rule you think you have and do not.

## Panel arguments

Passed as `args` to the driver workflow.

| Argument | Meaning |
|---|---|
| `task` | What is being reviewed. **Self-contained** — reviewers do not share the controller's context. |
| `context` | Controller notes. Used on the Claude side ONLY; never enters the independent round-1 brief. |
| `user_context_raw` | The user's own words. Safe for the independent brief, because it is not an interpretation. |
| `project` | Matches a `projects[].id` in your profile. Case-sensitive for identity purposes. |
| `risk` | `normal` (default) or `high`. High risk widens the panel and requires an anchor source. An unrecognised value fails **safe** to `high`. |
| `kind` | `mixed` (default) / `claim` / `code`. An unrecognised value falls back to `mixed`, which runs both gates. |
| `mode` | `adaptive` (default) / `quick` / `standard` / `deep`. |
| `run_id` | Required only when two concurrent audits could have byte-identical arguments. Thread it back unchanged each round. |
| `contextPack` | Required whenever `kind` involves code. See below. |

### `contextPack`

| Key | Meaning |
|---|---|
| `targets` | The files or scripts under review. Always enter the independent read allowlist. |
| `expected` | The expected outputs, columns or counts to check against. |
| `canonical_docs` | The source of truth. Required when `risk: high` unless the named project supplies `docs`. |
| `input_fixture` | A small fixture. Never a full production dataset. |
| `allowed_commands`, `forbidden_write_paths` | Boundaries stated to the reviewers. |
| `generated_by_claude` | Paths the controller produced. Excluded from the independent read list. |

**Every path must be absolute.** The read-only reviewer runs from a neutral working directory under
a restricted HOME, so `~`, relative paths and URLs silently read nothing — and a reviewer that
silently read nothing still returns a confident verdict. The panel validates path *shape* and
refuses non-absolute entries; it cannot check readability, because it has no filesystem access.

## Environment variables

Read by the reviewer wrapper. Except for the concurrency cap, a value above its ceiling or in a
malformed numeric form **exits 8** rather than falling back to the default — a malformed value that
silently becomes the default can buy *looser* runtime parameters than the user asked for.

| Variable | Default | Ceiling |
|---|---|---|
| `DUAL_AUDIT_TIMEOUT` | 540 | 86400 |
| `DUAL_AUDIT_KILL_AFTER` | 30 | 3600 |
| `DUAL_AUDIT_MAX_PAR` | 8 | 32 (clamps down rather than refusing: less concurrency is the safe direction) |
| `DUAL_AUDIT_LOCK_WAIT` | 540 | 7200 |
| `DUAL_AUDIT_EXP_MARGIN` | 900 | 604800 |
| `DUAL_AUDIT_STDIN_TIMEOUT` | 120 | 3600 |
| `DUAL_AUDIT_MODE` | `isolated` | `isolated` or `serial` only |
| `DUAL_AUDIT_BATCH` | `0` | `0` or `1` only |
| `DUAL_AUDIT_CODEX_BIN` | PATH lookup, then `~/.local/bin/codex` | |
| `DUAL_AUDIT_RUNTIME_DIR` | `/tmp/dual-audit-<uid>` | must be absolute |
| `DUAL_AUDIT_STATE_DIR` | `$XDG_STATE_HOME/dual-audit` | |

`DUAL_AUDIT_TIMEOUT` and `DUAL_AUDIT_LOCK_WAIT` default to 540 because of the **caller's** ceiling,
not because of anything about Codex. The reviewer agent runs the wrapper as a single shell command,
and Claude Code cuts that command off after 600 seconds. A budget larger than the ceiling cannot be
spent: the command is taken away, the agent is left with nothing to return, and the panel receives
an empty verdict. It reports that honestly — an empty reviewer is `INFRASTRUCTURE_BLOCKED`, never an
approval — but it looks identical to Codex being down, with no transcript to tell them apart.

At 540 the wrapper reaches its own limit first, so you get `124` (timed out) or `99` (no slot) with
a message, inside the ceiling. **Raise them only if your controller has no such ceiling**, and keep
`LOCK_WAIT + TIMEOUT` under whatever it is: a review that waits for a slot spends the same budget as
one that is running. For reference, a real review of two shell scripts at high reasoning effort took
456 seconds — the room above that is smaller than it looks.
| `DUAL_AUDIT_TELEMETRY` | **unset = telemetry OFF** | must be an absolute path to enable |

Installation paths honour `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and
`DUAL_AUDIT_BIN_DIR`, which is what makes an install into a temporary HOME possible for testing.

### Telemetry

Off unless `DUAL_AUDIT_TELEMETRY` points at an absolute path. When on, it appends JSON lines
recording timing, queue wait, mode, and an exit category. It records **no** brief, argv, path,
environment value, or anything derived from a token — including remaining token seconds, which
would reveal when it was issued.

Two caveats if you analyse it: an exit category of `timeout_like` is **inferred**, since the
reviewer can return that code itself and it also arises from an external kill; and telemetry is
best-effort, so it is evidence about trends, not proof that a run happened.
