# Contributing

Thanks for considering a contribution. This project has an unusual constraint: it is a tool whose
entire value is that its verdicts can be trusted. A bug here does not produce a wrong answer, it
produces a **confident** wrong answer. The rules below follow from that.

## The one rule that matters

**A change to a gate needs a test that FAILS when the gate is removed.**

A test that passes both with and without the code it claims to protect is not evidence — it is
reassurance. The suites do this for the gates that have been mutation-checked — the protocol
parser, the terminal-state mapping, the installer and uninstaller guards, the profile anchor checks
and the wrapper's refusal paths — where a case passes against the original source and fails against
a single-point mutant with that gate removed. It is not yet true of every line in the tree, so
treat it as the standard for new work rather than a claim about all existing code. If your mutant does not kill the test, one of three things is true, and you should say
which:

1. the gate is genuinely redundant (another gate covers the same behaviour) — then say so and
   consider removing it, because dead defence is worse than none: it looks like protection;
2. the fixture is not isolating your gate — another gate is blocking first, so the assertion never
   reaches yours;
3. the assertion is too weak.

A mutant that **crashes** is not a kill either. A crash shows behaviour changed, not that the
guard was doing the work. Replace it with a mutant that does not crash.

## Running the tests

```bash
bash tests/run-all.sh
```

No paid model is ever called: the reviewers are stubbed — including in the mutation cases, where a
local stub stands in for the reviewer binary — and everything happens in throwaway directories.

A case that cannot be constructed against the build under test must report **SKIP**, not pass. A
skipped case and a passed case are different facts.

Before proposing a release:

```bash
bash scripts/sanitize-scan.sh
```

## This package is derived from a running build, not a mirror of one

Worth stating plainly, because it changes what "in sync" can mean.

The protocol here was extracted from a working private setup, and that setup **kept running** —
which means there are two builds of the same components, and they are not interchangeable. The
package carries a de-domained profile block where the running one carries real project rules; some
paths and defaults differ for stated reasons. So `diff` is not the right tool: it reports
differences that are supposed to be there, and a maintainer who learns to skim past those will skim
past the one that is not.

What happened when nobody was checking is the reason 1.0.0 exists: the two drifted **in both
directions** — the package had a terminal-state layer the running build lacked, the running build
had a budget guard the package lacked. Neither was a superset, so "just copy the newer one" would
have deleted a real guard. Both suites were green throughout, because each suite could only reach
the copy sitting beside it.

```bash
bash scripts/check-live-parity.sh          # compare, then run all suites against BOTH builds
```

It compares the set of functions and guards after normalising known renames, and the values that
carry weight — numeric defaults, whether the lock can be isolated, whether the reviewer binary can
be overridden. **Accepted differences must be listed with a written reason, and every reason prints
on every run**, so an accepted difference cannot decay into a forgotten one.

`scripts/sync-from-live.sh` is the one supported direction of copying, with the de-domaining step
attached so a sync cannot smuggle a machine-local project name into the package.

## Before publishing anything

```bash
bash tests/run-all.sh

approved='ttomasyoung <163614498+ttomasyoung@users.noreply.github.com>'   # sanitize-scan:allow (an approval string necessarily contains the address it approves)
DUAL_AUDIT_ALLOW_GIT_IDENTITY="$approved" bash scripts/sanitize-scan.sh
```

The scanner reads commit metadata as well as file contents, because publishing a repository
publishes its history and every content scan excludes `.git` by construction. It fails on any
commit identity that is not named in `DUAL_AUDIT_ALLOW_GIT_IDENTITY`, so the identity you ship
under is recorded here rather than assumed. If you fork this project, put your own there — and if
you would rather not publish an address at all, GitHub issues every account a
`<id>+<name>@users.noreply.github.com` alias that keeps attribution without the mailbox.

## What this project will not accept

- **A gate that fails open.** If a check cannot decide, it must refuse, not proceed. An
  unrecognised state must never map onto anything that reads as approval.
- **A silent fallback.** A malformed configuration value must be an error, not a quiet default.
  A default that is *looser* than what the user asked for is the specific failure to avoid.
- **Domain vocabulary in the protocol.** The panel, the lenses and the routing rules must stay
  domain-neutral. Anything project-specific belongs in a profile, injected only when the caller
  names that project. Before adding text to a lens, ask whether it is true for every field.
- **Conclusions in the independent brief.** Nothing that reaches the round-1 independent reviewer
  may contain the other side's analysis or verdict. This is the one property the whole tool exists
  to provide.
- **A word-list that pretends to judge prose.** Deciding whether text says something substantive
  was attempted with closed vocabularies and abandoned: paraphrase always escapes, and every
  tightening rejected legitimate content. Structural gates only; fuzzy checks may raise advisories.

## Comments

Write down **why**, especially for anything that looks removable. Several gates here exist because
the obvious simpler version failed open. A comment that only restates the code is noise; a comment
explaining which failure a line prevents is what stops it being deleted next year.

Do not document intent that the code does not implement. A comment claiming a stricter check than
the code performs is worse than no comment, because it is read as a specification.

## Style

- English, in code and documentation. `README.zh-CN.md` and `docs/*.zh-CN.md` are the translated
  entry points.
- No dated design history or incident narrative in source. Explain the behaviour and the reason,
  not the meeting that produced it. `scripts/sanitize-scan.sh` enforces this.
- No personal paths, e-mail addresses or credentials, anywhere. Also enforced by the scanner.
- Shell: `set -uo pipefail`, quote everything, and capture exit codes directly — never from the end
  of a pipeline, where you get the last command's status instead of the one you care about.

## Pull requests

Say what failure the change prevents, and how you know. Include the mutation result for any change
to a gate. If you removed something, explain why its absence is safe rather than merely untested.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
