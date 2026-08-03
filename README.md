# dual-audit

**Independent, bounded, multi-round review between Claude and Codex — without rubber-stamping.**

[中文说明 / Chinese README](README.zh-CN.md) · [Apache-2.0](LICENSE) · Linux (verified on Ubuntu 24.04) <!-- sanitize-scan:allow (the link label is intentionally in Chinese so Chinese readers find it) -->

[![CI](https://github.com/ttomasyoung/dual-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/ttomasyoung/dual-audit/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/tag/ttomasyoung/dual-audit?label=release&sort=semver)](https://github.com/ttomasyoung/dual-audit/releases)

**Why this exists:** [Two Days of Nothing](WHY.md) — the account that led to it.

---

## The problem

Asking a second model to check the first one feels like a second opinion. Usually it is not.

Show a reviewer the answer and it tends to agree with it. Ask two models the same question and
they can be confidently wrong in the same direction, because their agreement is a fact about
models, not about the world. And when the review pipeline itself breaks — an empty reply, a
truncated answer, a process killed halfway — the output looks almost exactly like "I looked and
found nothing". A broken reviewer and a satisfied reviewer are hard to tell apart, so a broken one
quietly reads as approval.

`dual-audit` is a review protocol that treats all three of those as first-class problems.

## What it does

- **Round 1 is genuinely independent.** Both reviewers read the same raw sources themselves.
  Neither is shown the other's summary, analysis or verdict. The scope is an explicit read
  allowlist — independence, not unbounded exploration.
- **Rounds 2 and 3 are cross-examination.** Both sides receive each other's frozen round-1
  verdicts and must address the disagreement. Round 1 is immutable. Changing position **only**
  because the other side sounded more confident does not count as convergence, and the protocol
  asks for the evidence that changed your mind.
- **Agreement is not proof.** A claim that cannot be anchored to something outside the two
  reviewers is escalated for human sign-off rather than converged on.
- **It is bounded.** At most three rounds, with a hard ceiling on reviewer calls. It converges,
  preserves a minority position, or hands the decision back to you.
- **Failures are loud.** Empty output, a timeout, a nonzero exit, a malformed or misidentified
  verdict — each is a distinct, named failure. None of them can become an approval.

The protocol is controller-neutral by design. This release uses Claude Code as the controller and
Codex as the independent reviewer; the review state and verdict contract do not assume that.

## Two lanes

| | `dual-audit` | `light-audit` |
|---|---|---|
| What | Full bounded panel | One independent second opinion |
| Rounds | Up to 3, with cross-examination | At most 2 attempts, then escalate |
| Use for | Definitions, thresholds, rules, load-bearing output, irreversible actions | A small disagreement, or a run that did not settle the question |
| Cost | Minutes and tens of thousands of tokens per reviewer pass | One reviewer pass |

And a third lane that costs nothing: **just run the check.** When a deterministic test, a smoke
test or a dry run can settle the question, use facts instead of opinions. The skills say so
explicitly, because a review convened where a test would do is the most common way this kind of
tooling becomes expensive without becoming safer.

## Requirements

- Linux (verified on Ubuntu 24.04)
- Bash, Node 18+, and the usual utilities (`flock`, `mktemp`, `timeout`, `awk`, `sed`, `grep`, `find`, `sha256sum`)
- [Claude Code](https://claude.com/claude-code) — the controller
- The Codex CLI, authenticated — the independent reviewer. It is a separate product from Claude
  Code and most people arriving here will not have it yet: install it (`npm i -g @openai/codex`, or
  see [the Codex CLI project](https://github.com/openai/codex)) and run `codex login`. "Authenticated"
  concretely means a credential file at `~/.codex/auth.json`; `dual-audit doctor` reports whether the
  CLI is found, and the reviewer wrapper refuses to run without the credential rather than producing
  an empty review
- `~/.local/bin` on your `PATH`

No sudo. Everything installs under your home directory.

## Install

```bash
git clone https://github.com/ttomasyoung/dual-audit.git
cd dual-audit
./install.sh          # --dry-run first if you want to see exactly what it touches
dual-audit doctor
```

**Start a new Claude Code session before your first review.** The reviewer is a Claude Code agent
definition, and a session that was already running when you installed does not necessarily pick it
up. Asking for an agent type that is not registered yet fails before anything runs, which looks
exactly like a reviewer that produced nothing — `INFRASTRUCTURE_BLOCKED`, twice, with no transcript.
See `docs/troubleshooting.md` if you hit it anyway.

The installer never overwrites a file it did not write — not even with `--force`, which only
replaces files it installed and you edited afterwards. Ownership is decided by a marker inside the
file being replaced, not by the installation manifest: a manifest is a side file that anything can
write, and one that merely *claims* a path cannot make that path ours. It records a hash of everything it writes.
`./uninstall.sh` removes only what still matches those hashes and keeps anything you edited; the
panel is the one file whose contents legitimately change afterwards, so it is checked outside its
generated profile block rather than exempted. What it removes comes from the list of files this
package installs, held in code — never from the manifest, which is only ever asked "what hash did
you record for this path I already know I install". Your profile is never deleted unless you ask
with `--purge-profile`, and that flag deletes the profile *file*; it removes the directory only if
that left it empty, so it can never take anything else with it.

## Then customise your profile — this part is not optional

```bash
$EDITOR ~/.config/dual-audit/profile.yaml
dual-audit profile apply      # compile it into the installed panel
dual-audit doctor             # check it, and catch a profile edited but not applied
dual-audit profile routing    # what will actually route now — read this before trusting it
```

The file ships with two commented-out example areas. Replace them with your own; uncommenting them
as they stand describes somebody else's work. `doctor` will tell you if `critical_areas` is still
empty, if a keyword is short enough to match far more than you meant, and if you edited the profile
without applying it.

Until that file says `customized: true`, **automatic routing is off**: nothing is sent to a review
because a rule guessed it was important. Explicitly asking for a review works from the start.

This is deliberate. A shipped list of "things that matter" would either be broad enough to audit
everything, or narrow enough to give false reassurance about the things it missed. Only you know
which decisions in your work are expensive to get wrong. `dual-audit doctor` will keep reminding
you until you have told it.

## Using it

In Claude Code, the skills route on their own once your profile is customised, and always respond
to an explicit request:

```
Please dual-audit this migration plan.
Light-audit this function for me.
```

The full panel runs through one entry point:

```
Workflow({
  scriptPath: '~/.claude/workflows/dual-audit-run.js',   # resolved to an absolute path at install
  args: { task, context, user_context_raw, project, risk, kind, mode, run_id, contextPack }
})
```

`task` and `context` must be self-contained — the reviewers do not share the controller's context.
For anything involving code, `contextPack` is required (targets, expected outputs, canonical
docs), and every path in it must be absolute. See [docs/configuration.md](docs/configuration.md).

## Reading the result

There are exactly four terminal states, and only one of them means the review passed:

| State | Meaning |
|---|---|
| `CONVERGED` | Both gates passed. **The only state that may be described as a completed review.** |
| `NOT_CONVERGED` | The rounds ran out with substantive disagreement, or a claim needs human sign-off. Unresolved issues and minority positions come with it. |
| `INFRASTRUCTURE_BLOCKED` | A reviewer or a runtime facility was unavailable. **Nothing was judged** — this is not "no problems found". |
| `INVALID_AUDIT` | Identity, state, schema or argument validation failed. The audit is not trustworthy; fix the input and re-run. |

An unrecognised internal state maps to `INVALID_AUDIT`, never to anything that reads as approval.

When a reviewer's reply could not be read, the result also carries `rc_diagnostics`, and each entry
has a stable machine-readable `code` (`EMPTY_VERDICT_TEXT`, `MARKER_OUTSIDE_ANY_BLOCK`, …) next to
its human-readable `why`. **Branch on `code`, never on `why`** — the codes are a contract and only
ever gain new members; the sentences may be reworded or translated. The full list, and what each one
tells you to fix, is in [docs/troubleshooting.md](docs/troubleshooting.md).

## Privacy, cost and what leaves your machine

- **Your content goes to the model providers you have already configured** — Anthropic through
  Claude Code, OpenAI through the Codex CLI — and nowhere else. This project adds no service,
  no endpoint and no account.
- **Telemetry is off by default.** If you turn it on, it records exactly these fields and no others:
  how long the run took, how long it queued, which slot it used, whether it ran in serial or isolated
  mode, the configured timeout, a batch id when one was supplied, a coarse HTTP signal, an exit
  category, and whether the stored access token was still fresh. Never a brief, argv, a path, an
  environment value, or a credential. The token field is a two-state freshness flag, not anything
  derived from the token itself — it is there because it is the only thing that explains a fall back
  to serial mode.
- **The reviewer runs read-only**, in a private home directory, from a neutral working directory,
  with the refresh token stripped from its temporary credentials. One exception, deliberate and
  documented: when the access token is near expiry the wrapper falls back to serial mode, which
  reuses a single long-lived home and keeps the refresh token so the credential can be renewed —
  under an exclusive lock, one review at a time. See `SECURITY.md`.
- **Cost is real.** A reviewer pass takes minutes and tens of thousands of tokens; a full
  three-round panel costs several of those. Use it per high-stakes decision, not per step.

## Known limitations

Stated plainly, because a review tool that oversells itself is worse than none:

- **It detects mis-threading, not forgery.** Every verdict carries an audit id that binds it to
  this audit and this round, which catches a verdict from a different audit being merged in. A
  reviewer that deliberately copies the id can still assert whatever it likes, and nothing here
  proves which model produced a piece of text.
- **It cannot tell you whether a claim is true.** It can tell you whether it was anchored to
  something checkable, and it escalates when it was not.
- **A digit in the evidence field does not make the evidence real.** The gate guarantees that
  something concrete was cited, not that the citation is correct.
- **"Every approver spoke" is not "every approver was right."** The flip gates guarantee that a
  change of position was declared and survived another round, not that the reasoning was sound.
- **Prose judgement is advisory.** Deciding whether a paragraph says anything substantive is not
  something lexical rules can do; that was attempted and abandoned. The hard gates are structural,
  and the fuzzy checks only raise warnings for a human.
- **The installer and the uninstaller are not safe against files moving under them.** Both decide
  what to do by examining a path, then act on that path a moment later. If what lives there changes
  in between — an editor saving atomically, a second install running concurrently, a directory
  renamed, remounted or repointed — the decision describes a file other than the one written or
  removed. Nothing here holds a lock or verifies through an open descriptor. Both refuse far more
  readily than they act, so the realistic outcome is a file kept that could have been removed; the
  reverse needs the replacement to land inside a window of milliseconds. Do not run two of them at
  once, and do not edit the installed files while either is running.
- **Linux only in this release.** macOS and Windows are not supported yet.

## Troubleshooting

Start with `dual-audit doctor`. It checks dependencies, whether every installed file is present
and unmodified, whether `~/.local/bin` is on your `PATH`, whether your profile parses, and whether
the compiled copy inside the panel is still up to date. See
[docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

| | |
|---|---|
| [docs/installation.md](docs/installation.md) | Installing, upgrading, removing, temporary-HOME testing |
| [docs/configuration.md](docs/configuration.md) | Profile schema, arguments, environment variables |
| [docs/protocol.md](docs/protocol.md) | The review protocol and every gate, with the reasoning |
| [docs/architecture.md](docs/architecture.md) | Components and boundaries |
| [docs/troubleshooting.md](docs/troubleshooting.md) | What each failure means and what to do |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: a change to a gate needs a test that
FAILS when the gate is removed. A test that passes with and without the code it claims to protect
is not evidence.

If you run a modified or separately deployed build of these components, the suites can be pointed at
it (`DUAL_AUDIT_PANEL`, `DUAL_AUDIT_DRIVER`, `DUAL_AUDIT_WRAPPER`, …), and
`scripts/check-live-parity.sh` compares two builds directly. That exists because a suite which can
only reach the copy beside it cannot notice that the copy in use is different — which is how a guard
came to live in one build and not the other, with both test runs green.

Security issues: [SECURITY.md](SECURITY.md).

## Roadmap

- Codex as the controller, with Claude as the independent reviewer (the interface is reserved; an
  unverified implementation is deliberately not shipped)
- A macOS runtime adapter
- Further optional domain profiles

None of these may weaken this release's protocol, isolation or fail-closed behaviour.

## Questions, problems, ideas

- **Something is broken, or a gate fired when it should not have** — open an
  [issue](https://github.com/ttomasyoung/dual-audit/issues). Include the terminal state, the
  `convergence_status`, and what you expected. `dual-audit doctor` output helps.
- **"Should I audit this?", "how do I write my critical areas?", or you want to argue with the
  protocol** — that is a
  [discussion](https://github.com/ttomasyoung/dual-audit/discussions), not a bug.
- **You adapted it** — a single-model self-review, a macOS runtime, a domain profile — please say so
  in a discussion. That is the point of the seed.
- **Security** — see [SECURITY.md](SECURITY.md), not a public issue.

## Acknowledgements

The two reviewers were used on this repository throughout its own development, and both sides
earned their place in it.

**Codex** reviewed as the independent side. Working from the raw sources and without seeing the
other side's conclusions, it found things the author's own tooling was structurally blind to —
including a private identifier surviving in git history that the repository's own pre-publication
scanner did not look for, a hole in the verdict grammar that let a stated blocker travel through the
whole panel unread, and a delete path deriving its file list twice while comparing only the lengths.
On several of those the author's side had argued the opposite and was wrong.

**Claude** was the controller and the author's side of every panel, and wrote the code.

Codex is deliberately not listed as a co-author of the commits. Attribution in git means "helped
write this", and its role here was to review — which in a project built on the premise that the
author and the verifier must not collapse into one is a distinction worth keeping visible rather
than flattening into a contributor count.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
