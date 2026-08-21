# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0]

**Read this first if anything you own branches on `terminal_state` or `converged`.** A run with
one reviewer seat now returns `CONVERGED_SINGLE_SEAT`, not `CONVERGED`. Code written as
`=== 'CONVERGED'` will stop matching those runs. That is the point: a single-seat run converged on
one reading with no cross-examination, and reporting it with the same string as a real dual audit
made the two machine-indistinguishable. The prose said "single seat"; nothing that branches reads
prose. The driver forces `converged: false` for anything that is not `CONVERGED`, so the new value
reads as *less* than approval, never as nothing.

**Findings are now recorded in a ledger that never removes an entry.** `open_p0s` was replaced
each round by that round's adjudicated findings, so a finding raised earlier that nobody restated
disappeared from every later result while the run still reported convergence — a consumer received
an approval covering a finding that had evaporated, and "nobody found anything" was byte-identical
to "the finding was dropped". Entries carry an opaque sequence id, the round that raised them, and
`open` / `not_restated`.

The ledger **gates nothing**, deliberately. This code cannot tell a refutation from a silence, and
blocking on every non-restated finding would deadlock ordinary runs. Naming the state is what a
human needs; deciding it is not something the panel can do. For the same reason, matching a
restatement to its entry is a heuristic (normalised text), and on no match a *new* entry is created
rather than merged — a duplicate is recoverable, an erased finding is not. Matching is
case-sensitive, because findings are `file:line` locators and two paths differing only in case are
two different files.

**`codex_only` works for `kind: code` and `kind: mixed`.** The code gate required a passing verdict
from a Claude run seat, and that mode dispatches none, so those combinations could never converge
and emitted that impossibility as their sole blocker — which read like a finding about the code
under review. A gate nothing can satisfy is not a gate. Single-seat runs now converge on the static
reading and say, loudly, that nothing was executed.

**Terminals that give up now carry what they were handed.** A refusal, a codex-unavailable exit and
a missing-brief exit each returned no advisories at all, and a refusal that could not prove the
ledger complete said nothing about what the refused state contained. The paths where the panel
admits it cannot finish are the paths a reader most needs the earlier warnings on.

Smaller, same shape: a refusal reports how many verdicts it carried (a count needing no parse) and
labels any P0 tally a floor rather than a count; advisories raised while adjudicating an earlier
round survive to the terminal instead of dying with their round; the seat-identity warning is
re-emitted naming the round it describes instead of being dropped once a later round is clean; the
advisory cap of 200 means 200 and its truncation notice accumulates across truncations.

## [1.1.1]

`codex_only` did not work end to end. 1.1.0 shipped it verified structurally — the mode was
accepted, one round was allowed, zero Claude seats were dispatched, other modes were unaffected —
and that was disclosed at the time as not having been exercised against a live reviewer. It had
not, and it was broken.

The round-2 state check requires `prior_state.claude_verdicts_raw` to be non-empty. That check
exists to catch a Claude side that was truncated or silently dropped; its own message names the
danger, "the round is decided by the codex verdict alone (not a dual audit)". Under `codex_only`
that is not a degradation — it is the mode the caller asked for. So the reviewer produced a
verdict, exit code 0, and the panel discarded it at the handoff.

The emptiness requirement is now lifted for `codex_only` alone. Everything else still applies: an
array that is present must still parse and must still match its declared count. The exemption
cannot be borrowed by another mode, because `mode` is part of the audit fingerprint — a
`prior_state` produced by a dual-mode run is a different audit and is refused by the identity
check long before reaching this point.

Verified end to end this time: a `codex_only` run reached the reviewer, took its verdict, and
returned a real terminal state instead of a state-schema abort.

## [1.1.0]

One new mode, one changed default, and one field that was accepted and then ignored.

**`standard` and `adaptive` are now two rounds, not three.** This is a behaviour change for
anyone relying on the old default, and the reasoning matters more than the number.

This panel does not exist to converge. Across a long run of real audits the three-round setting
reached `converged: true` rarely, and treating that as a defect led to the wrong repairs — raising
the round count to quiet a gate, or reading `escalate_to_user` as a malfunction. It is not one. The
panel's product is *independent readings of the same system*, and two independent readers of
anything non-trivial will usually still disagree about something at the end.

What the second round actually buys is cross-examination, and that is worth paying for. A single
round routinely produces a confident finding that a second reader takes apart: a cost extrapolated
from a synthetic fixture whose shape differs from the real input; a finding whose *conclusion* is
correct while its probe landed somewhere the code already excludes, so the stated damage chain does
not hold until the probe is re-anchored. Round two pins the real findings down and drops the rest,
which means **less** human arbitration, not more. The third round, in practice, mostly bought
another lap.

Known and accepted consequence: with two rounds the flip-stability gate — a verdict that flips in
the *last* round does not count as convergence — fires more often. That is the correct outcome. A
last-round reversal is exactly the case a human should look at. Do not raise the round count to
make that gate quiet; that is the trade the old default was making without saying so.

**New mode: `codex_only`.** One codex seat, zero Claude seats, one round — half of `quick`. For
when an independent second reader is all the situation calls for and a full panel is not warranted.

It takes the same input contract and produces the same output contract as every other mode, so
nothing downstream needs a special case for it. Notably, the convergence gate needed **no** change:
the codex verdict was already pushed into the same `valid` collection as the Claude verdicts, so
with zero Claude seats a valid codex verdict still satisfies the "no valid auditor verdict" check
and is still subject to the requirement that every valid verdict approve. It is deliberately held
to the same bar as a full panel — it simply has one fewer perspective. No convergence shortcut was
added for it, and none should be.

⚠️ Disclosed rather than glossed: `codex_only` has been verified structurally (mode accepted, one
round, zero seats, other modes unaffected, and the zero-seat case correctly reports "not all valid
auditors approve" rather than falsely reporting "no valid auditor verdict") but has **not** been
exercised end-to-end against a live reviewer.

**`contextPack.brief` now reaches the reviewers.** It was accepted by the schema and consumed by
nothing. The read-allowlist was built from `contextPack.targets` alone, so a caller could pass a
brief, have it validated, and then watch a seat be handed a task referring to sections of a
document it was not permitted to open. That is what happened: the seat reported it could not
adjudicate the questions it had been asked and, following its own coverage discipline, declined to
issue a converging verdict — while the seats on the other side had read the brief and did
adjudicate. The two sides were working from different material, and the entire value of an
independent first round rests on both sides reading the raw inputs themselves.

It is delivered as its **own** category, not folded into raw sources. A brief is a statement of
work — what to review, where the boundaries are, what must not be reopened. It is not evidence: it
is written by the submitting party and necessarily carries that party's conclusions and
self-assessment. Folding it in would hollow out "read the raw material independently"; withholding
it entirely leaves the reviewer unsure what it is reviewing. So it is supplied with its provenance
stated verbatim, and it deliberately does **not** count toward the check that a genuinely
independent source exists. A brief can never substitute for one.

## [1.0.1] — 2026-08-05

A diagnostic fix. Nothing about what gets audited, or how, changes.

**A lost payload no longer masquerades as a missing field.** When the argument object is too large,
the host can drop it WHOLE before this driver runs. What surfaced then was `missing task` — so the
caller went and *added* arguments, growing the payload that was already the problem, and the whole
loop read as a schema error from beginning to end. `args` absent and `args` present-without-a-task
are now two different messages, the first of which names size as a known cause and says to move the
long material into a brief file and pass its path. Every size-related message carries the measured
size, so nobody has to guess how close they are.

**No limit is enforced, deliberately.** The version of this change that was written first refused
anything over 2048, and that refusal was withdrawn before release. Two reasons, both worth stating
because they are the argument against putting it back:

- The size is measured in UTF-16 units. For Latin text those are bytes; for CJK text they are about
  a third of them (measured: 2.95x). One threshold therefore means two quite different things
  depending on who is calling — and the author's own payloads were the CJK kind, meaning the limit
  was miscalibrated for the only person who had it.
- The cliff is a single anecdote from one operator's log. An independent reviewer tried to reproduce
  a genuine whole-payload drop and could not, and whether the boundary lives in bytes or in UTF-16
  units was never established.

A refusal calibrated in an unconfirmed unit against an unreproduced failure cannot be shown to
prevent what it names, while certainly blocking callers who did nothing wrong. Here the asymmetry
runs the opposite way from most guards in this project: a false refusal is the expensive outcome,
and the failure being avoided costs only a confusing message — which the change above already fixes.
`tests/test_args_size_gate.mjs` keeps the withdrawal honest: reinstating a limit turns it red.

## [1.0.0] — 2026-08-03

The first two releases published a snapshot. This one publishes what is actually running.

`0.1.0` was an extraction — the protocol lifted out of a working private setup, generalised and
re-verified. What that framing quietly assumed is that the private setup would hold still. It did
not. Over the following week it was put through the panel it implements, repeatedly, and it did not
come out clean: the panel found fail-open defects in its own core, and then found defects in the
fixes for those defects. None of that reached the package.

So the two builds drifted — and, importantly, **in both directions**. The released build had a
terminal-state layer the running one lacked. The running one had a budget guard the released one
lacked. Neither was a superset of the other, which is the state where "just copy the newer one"
silently deletes a guard. That is not a packaging inconvenience; for a tool whose entire claim is
*a dead reviewer and a satisfied reviewer emit the same text*, it is the same failure one level up.

This release is the two things that follow from that:

1. **The package carries the running implementation**, not a snapshot of an earlier one.
2. **Divergence is checkable by a script rather than by memory** — `scripts/check-live-parity.sh`.
   "Keep the two in sync" is an instruction addressed to a human, and the failure being prevented
   here is exactly a human not remembering.

It is `1.0.0` and not `0.2.0` because the guarantees changed, not only the code. Inputs the earlier
releases accepted are now refused — a misspelt risk level, a mode name that does not exist, a
reviewer whose output arrived without its exit code, a brief whose hash matched while its content
did not. Every one of those used to be a pass. A refusal where there used to be a pass is a
breaking change for anyone who built on the old behaviour, and it should cost a major version.

### Changed — the shape of the thing

- **Two mechanisms became one panel with a depth setting.** `light-audit` is now `mode: 'quick'` on
  the same panel: same seats, same independent first-round reading, same gates, same terminal
  states, one round instead of three. It used to be a different mechanism — a single read-only
  reviewer dispatched with a brief the *caller* wrote — which meant the cheap lane read your framing
  of the problem instead of the problem, opting out of the one guarantee that made the expensive
  lane worth paying for, and had no Claude-side seat, so a question about whether code *works* was
  answered by reading it. The gates are identical at either depth: a finding that blocks at three
  rounds blocks at one.
- **The logic seat is separate from the run seat.** For code-relevant work the Claude side now
  dispatches two reviewers: one that executes the work on a fixture and reports what happened, and
  one that never runs it and asks whether the method answers the right question. Asked both
  questions, a single reviewer answers the easy one — it reports that the script executed cleanly,
  which is true, and says nothing about it being the wrong script. Both seats derive from a single
  definition (`SEAT_SPECS`), which the run-seat classifier and the `prior_state` shape check had
  previously duplicated by convention.
- **The panel no longer dispatches workers.** Production happens outside it; the panel only examines
  what is submitted. Fewer moving parts, and the author and the verifier cannot collapse into one
  process.
- **It costs less.** Quick depth is roughly three reviewer passes against roughly nine at full
  depth, and the Claude side sends at most two seats per round rather than three.

### Added

- `WHY.md` and `WHY.zh-CN.md` — the author's account of what went wrong before this existed, and
  why the answer turned out not to be "find a smarter model". Linked from both READMEs, because
  most people reading a README first want to know why the thing was built at all.
- **Named seat roles, derived from one definition.** The Claude side dispatches a run seat (`D1D2`)
  and a logic seat (`ABCL`) when the change is code-relevant, and the logic seat alone when it is
  not. Previously the seat list, the run-seat classifier in `evaluateConvergence`, and the shape
  check that rebuilds seats from `prior_state` each carried their own copy of that knowledge and
  agreed only by convention — renaming a lens would have broken the classifier silently.
- **A time box as a first-class brief field** (`TIME_BOX_MIN`, default 8 minutes) rather than a
  sentence in prose. ⚠️ Recorded honestly: prose in a brief is *advice to a model*, and a run given
  a three-minute box was measured taking 5.2. The enforcing ceiling is the wrapper's budget clamp,
  not this field; the field exists so the two are at least stated in the same place.
- **`scripts/check-live-parity.sh`** — compares an installed build against the package: the set of
  functions and guards after normalising known renames, plus the *values* that carry weight
  (numeric defaults, whether the lock is isolatable, whether the reviewer binary can be overridden).
  Accepted differences must be listed with a written reason, and the reasons print on every run,
  so an accepted difference cannot quietly become a forgotten one.
- **`scripts/sync-from-live.sh`** — the one supported direction of copying, with the de-domaining
  step attached, so syncing cannot smuggle a machine-local project name into the package.
- **A launch marker on stdout, so a reviewer killed part-way stops looking like one that never
  ran.** Until now the wrapper wrote nothing to stdout until the reviewer had already returned — the
  injected verdict block was the first byte. A review killed mid-flight and a review never invoked
  therefore produced byte-identical output: **empty**. That is this project's own thesis turned on
  itself, and it was not theoretical: a caller enforced a wall-clock ceiling nobody had declared to
  the wrapper, the reviewer started, read its sources, reasoned for two minutes and was killed;
  everything it had done went to stderr, which no caller reads, and stdout stayed empty. The seat,
  seeing nothing, reran the same doomed command six times.
  The wrapper now writes one line the instant before it hands control over, giving three
  distinguishable states — marker plus a complete block (normal), marker with no block (**started
  and killed**, reported as `LAUNCHED_BUT_NO_VERDICT` and always infrastructure), no marker at all
  (never got as far as launching). ⚠️ Emitted only under `--emit-rc`, which is the flag by which a
  caller opts into having its stdout rewritten; other callers parse raw reviewer output and are
  untouched. **The marker does not save the review** — it makes the loss visible, which is the
  difference between losing a reviewer and not knowing you lost one.
- **Machine-readable diagnostic codes** on every reviewer-parse failure: `EMPTY_VERDICT_TEXT`,
  `NO_MARKER_ANYWHERE`, `MARKER_WITHOUT_BLOCK`, `MARKER_OUTSIDE_ANY_BLOCK`,
  `MARKER_IN_EARLIER_BLOCK`, `MARKER_AMBIGUOUS_IN_LAST_BLOCK`, `NO_BLOCK_NO_MARKER`,
  `MARKER_UNREADABLE_INTERNAL_INCONSISTENCY`. These are a stable contract: assertions and callers
  may branch on them. They exist because the tests used to assert against the English sentence
  beside the code, which meant rewording a message broke a test that was testing nothing.
- **The test suites can be pointed at an external build** (`DUAL_AUDIT_PANEL`, `DUAL_AUDIT_DRIVER`,
  `DUAL_AUDIT_WRAPPER`, `DUAL_AUDIT_ENVP`, `DUAL_AUDIT_RC_MARKER`). A suite that can only test the
  copy in its own repository cannot detect that the copy in use is different, which is the whole
  problem above.

### Changed

- **Project-specific rules moved out of the panel and into a machine-local profile.** The panel body
  is domain-neutral: no project names, no project paths, no domain thresholds. A profile injects
  them only when the caller names that project, and the profile never enters a repository. A shared
  review tool that names one user's projects steers every other user's audit toward that shape.
- **`kind: 'biology'` is now `kind: 'claim'`.** The old name still works — callers and stored
  `prior_state` are unaffected — but the concept was never biology-specific: it is "this change is
  a claim about the world, not about code".
- **`LOCK_WAIT` default 540 s → 20 s.** Against a 600 s caller ceiling, a 540 s lock wait leaves
  nothing to review with. The post-lock clamp would correctly refuse — but only after spending 90%
  of the caller's budget queueing to be told there is none left. Safe, and useless. A caller with
  no ceiling can raise it; the default belongs to the caller that has one.
- **`MAX_PAR` default 12 → 8**, on measurement rather than opinion: across 548 recorded runs the
  highest slot ever taken was 5 and nothing ever queued.
- **`risk` and `mode` are validated against a closed set.** A misspelt risk (`hgh`) used to fall
  through to `normal`, so a task that should have had the strictest treatment got the default one.
  `mode: 'quick2'` used to fall through to `adaptive`, i.e. a caller asking for *one* round silently
  got three. Both now refuse.

### Fixed

- **The brief hash was forgeable, in six distinct ways.** It is what proves round 2 is examining the
  same submission round 1 saw, so a collision is not cosmetic. Every value is now emitted as a
  `[typeTag, payload]` tuple, because an untagged encoding let a literal string impersonate a
  structure. Alongside that: `JSON.stringify` collapses `NaN`, `Infinity` and `-Infinity` all to
  `null`, so three different briefs hashed identically; functions bound their name and not their
  source, so two different bodies with the same name hashed identically; `Symbol.toPrimitive` and
  `toString` decide what the brief *renders*, so two objects rendering `CONTRACT-A` and
  `CONTRACT-B` hashed identically; inherited and non-enumerable properties were not walked, though
  the execution logic reads arguments by plain property access and therefore sees them; and a plain
  `*` on 32-bit hash state overflows 2^53 and drops the low bits, losing most of the real entropy
  (now `Math.imul`).
- **A real blocking finding could be filtered away and the panel would then declare convergence** —
  probed, not hypothetical. The route was a heuristic that demoted a P0 whose text did not look
  specific enough; the demotion left the filtered blocker list empty, and an empty list is what
  `approvesFinal` reads as "nothing blocking". The counter-example that killed the heuristic had a
  file, a symbol and a full damage chain and still failed it. Qualification, demotion and the
  per-auditor count are now explicit and logged (`qualifyP0s`, `demotedLog`,
  `MAX_BLOCKING_P0_PER_AUDITOR`), and a demoted finding is carried into the next round rather than
  disappearing. The rule this leaves behind: when a filter's failure direction is *dropping a real
  blocker*, no amount of noise it removes pays for that.
- **"The reviewer did not answer" was decidable in more ways than the check knew about.** Line
  terminators are normalised at one entry point sharing one table with the line scanner (a second
  table inside the scanner is exactly how the two diverged before); VT/FF/FS/GS/RS/US render as
  line breaks and now parse as ones; zero-width and format characters do not `trim()` away, so
  `"\u200b".trim()` returns the zero-width space, not `""`; a bare combining mark carries no content while an attached one is
  part of a character; colons are recognised in their compatibility forms; and CJK is matched
  character-by-character because it has no inter-word spaces. The enumerated phrase list is gone —
  it was broken in four consecutive reviews — replaced by a structural test with a stated honest
  boundary: it catches empty and *explicit* non-answers, and verbose emptiness is caught instead by
  requiring a flip to stay stable across rounds.
- **`foldKey` and `normForDedup` disagreed**, so two spellings of the same finding could be folded
  by one and kept distinct by the other.
- **The wrapper stopped re-measuring its budget at the two points where waiting happens.** The
  isolated-path clamp sat *inside* the `if [ "$EMIT_RC" = 1 ]` branch while `--emit-rc` defaults
  off, so the path most callers take had no re-measurement after up to `LOCK_WAIT` seconds of
  queueing — measured launching with a 20 s timeout while 12 s of budget remained. A guard placed
  in one of two branches reads as present and is not. Separately, `run_serial` never re-measured
  between `flock` returning and the launch; the clamp is now immediately after the wait and
  *before* the credential write, so a doomed run leaves no credential behind.
- **The arithmetic invariant that was supposed to prove the timeout chain fits inside the caller's
  ceiling omitted `LOCK_WAIT`**, so the shipped defaults passed it while exceeding the ceiling. The
  general form of that mistake is worth naming: a static sum under-counts every time a stage is
  added, and it does so silently and in the unsafe direction.
- **The reviewer agent was never told to raise its own command timeout**, so whether a review could
  finish at all was left to the model happening to set it. In Claude Code the Bash tool defaults to
  **120 s** and a review takes several minutes; 600 s is the *maximum you must ask for*, not what
  silence gets you. Observed inside one panel: the round-1 seat set it and returned a full verdict in
  over nine minutes, while the round-2 seat did not, was killed at two minutes with exit 143 and an
  empty stdout, retried six times, and the panel lost that seat. Same brief, same agent definition,
  opposite outcomes. The definition now states the value, explains that the default cannot work, and
  says not to retry the identical command after a two-minute kill. The definition now also carries a
  machine-readable timeout contract checked by `tests/test_agentdef.sh` against the wrapper's real
  defaults, so raising the wrapper's own timeout past what seats are told to ask for turns the
  arithmetic red instead of leaving a stale instruction nobody rechecks. ⚠️ The first version of that
  check merely grepped for the two numbers; an independent review defeated it in one move by
  rewriting the paragraph to *withdraw* the requirement while keeping both figures, and pointed out
  that deleting the operative sentence alone already left them in the file. That exact rewrite is now
  a permanent negative fixture. Filed as `Fixed` and not as a
  documentation tidy-up because the observable failure — no verdict — is exactly what a reviewer that
  read everything and found nothing to say produces.
- **Cases that must reach a reviewer launch now SKIP where they cannot be built, instead of failing.**
  Strengthening the mutation checks (above) had an unlooked-for consequence: on a machine with no
  Codex credentials — CI, a fresh clone — the wrapper refuses during bootstrap long before any guard
  under test, so six cases went red for a reason that is not a defect. They now probe once whether a
  launch is reachable and report `SKIP` when it is not. ⚠️ Decided by probing, never by an
  environment switch: a switch would also silence a real regression on a machine that does have
  credentials. Verified in both directions — with credentials the group runs with **zero** skips;
  without them the whole suite is green with the skips reported.
- **The wrapper's own test suite launched the real reviewer**, with real credentials, while the
  file's header stated that no reviewer is ever launched and no tokens are ever spent. A stub is
  now exported for the whole file, the reviewer binary is overridable in both builds (it had been
  hardcoded in one), and the launch count is itself the assertion: zero for every unmutated case,
  exactly one for the mutant — which is also what proves the mutation test has teeth.

## [0.1.1] — 2026-07-28

### Fixed

- **The installation test suite could write outside its throwaway home.** It pinned `HOME` and
  nothing else, while `install.sh` honours `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and the `DUAL_AUDIT_*`
  location overrides — correctly; that is the convention. On a machine with any of them set, the
  suite installed into the real configuration directory, and the `--purge-profile` case then deleted
  a real profile. The suite's own header claimed this "can never touch the real one". CI found it on
  the first push; it reproduces with `XDG_CONFIG_HOME=/tmp/anything bash tests/test_install.sh`.
  All of them are now pinned inside the temporary home, with a guard that stops the run if that
  pinning is ever removed. The installer itself was not at fault and is unchanged.
- **The shell lint step had never passed**, on any commit, so the checks were not protecting
  anything. Four of the five findings were real, and two of them are the failure this package exists
  to make loud: `local x="$(cmd)"` makes the exit status of `local` the status of the line and
  discards the command's own. Declared and assigned separately now, in the wrapper's telemetry and
  in the wrapper tests. `cd` without a failure branch in the test runner is fixed too. The remaining
  two are a literal `~` inside a message a human reads, which is deliberate and now carries a scoped
  exemption with its reason.
- **CI never made the decision the identity gate asks for.** That gate fails closed by design:
  publishing under your own name is a fine decision, but it has to be one somebody made and wrote
  down. Nothing had written it down for CI, so the pre-publication scan refused every run — working
  exactly as intended, and reading as a broken check. The workflow now carries the approval, which
  also means a fork sees its own identity refused until it changes that line.

Also worth recording, because it is the same mistake this project is about: the local verification
that preceded the first release was not the check CI runs. It supplied `EXTRA_PATTERNS` and
`DUAL_AUDIT_ALLOW_GIT_IDENTITY`; CI supplies neither. Green locally and red in CI were both correct
answers to different questions.

## [0.1.0] — 2026-07-28

First public release. The protocol core is an extraction of a working implementation, generalised,
de-domained and re-verified for public use.

### Added

- **Bounded Claude+Codex review panel.** Round 1 is independent — both reviewers read the same raw
  sources and neither sees the other's summary or verdict. Rounds 2 and 3 are cross-examination
  over frozen round-1 verdicts. At most three rounds, with a hard ceiling of 18 reviewer calls,
  fail-closed.
- **Two user-facing skills.** `dual-audit` runs the full panel; `light-audit` gets one independent
  second opinion and escalates after at most two attempts rather than looping.
- **Four terminal states** — `CONVERGED`, `NOT_CONVERGED`, `INFRASTRUCTURE_BLOCKED`,
  `INVALID_AUDIT` — with an unrecognised state mapping to `INVALID_AUDIT`. Only `CONVERGED` may be
  described as a completed review.
- **Hardened read-only reviewer wrapper**: read-only enforced by the wrapper rather than trusted to
  the caller, a private home and working directory per run, an early stdin snapshot, a bounded slot
  semaphore, symlink and ownership guards on every control-plane path, credentials copied with the
  refresh token removed, and cleanup on normal and handled abnormal exits. Serial mode — the
  fallback when the access token is near expiry — trades the per-run home and the stripped refresh
  token for a shared home under an exclusive lock, deliberately and under a documented lock; see
  `SECURITY.md`.
- **Exit-code injection inside the verdict block**, written by the wrapper — the only party that
  can observe the process status. A dropped marker breaks parsing loudly instead of vanishing, and
  a verdict supplied without its exit code is treated as reviewer-unavailable.
- **Profiles.** A domain-neutral default, an optional research profile that adds evidence
  anchoring, and a user profile holding critical areas and project anchors. Automatic routing stays
  off until the user sets `customized: true`.
- **Installer, uninstaller and `dual-audit doctor`.** User-local, never needs sudo, never overwrites
  a file it did not write (`--force` included — that flag only discards your own edits to files it
  installed), records a hash of everything it writes, and removes only what still matches. The panel
  is checked outside its generated profile block rather than exempted.
- **Bypass linter** (`dual-audit-lint`) for reviewer calls that skip the wrapper.
- **Pre-publication scanner** (`scripts/sanitize-scan.sh`) for credentials, personal paths, e-mail
  addresses, internal history and non-English source text.
- **Test suites** covering the protocol, the driver and its terminal-state mapping, the profile
  parser, the wrapper's refusal paths, installation and removal in a temporary home, the linter and
  the scanner — including mutation cases that require each load-bearing gate's removal to break a
  test. No paid model is called.
- **Bilingual documentation**: English landing page and a complete Chinese counterpart, plus
  architecture, protocol, configuration, installation and troubleshooting guides.

### Changed during extraction

- **Domain-neutral vocabulary.** The claim-side review mode is `kind: claim` rather than a
  field-specific name, and the mechanism lens asks about units, magnitudes and method resolution
  instead of the vocabulary of any one field.
- **Project rules moved from hardcoded constants into profiles**, compiled into the installed panel
  because the workflow sandbox has no filesystem access, with a hash so `doctor` can report drift.
- **Telemetry now defaults to off** and must be enabled with an absolute path.
- **Runtime paths are per-uid and configurable**, rather than fixed shared locations.
- All naming is package-scoped (`dual-audit-codex`, `dual-audit-codex-readonly`,
  `DUAL_AUDIT_*`), so an installation cannot collide with unrelated tooling.
- **Executable strings that changed with the renaming**, listed explicitly so nobody has to infer
  which differences were intended: the panel's experimental forward-mode shell command now invokes
  `dual-audit-codex` with `--emit-rc` and a package-scoped temporary directory; the exit-code
  marker is `__DUAL_AUDIT_RC=`; and every wrapper diagnostic message is in English under the new
  program name. These are behaviour-visible, unlike the comment rewriting, and are named here
  because "only comments changed" would have been an overstatement.

### Fixed before release

Pre-release review of the extracted code found the following. Each is fixed here, and each has a
test that fails if the guard is removed.

**Configuration — an anchor that anchors nothing.** A profile's `docs` pointer is what satisfies
the high-risk anchor requirement, so a value that looks like a path but yields no evidence lets an
audit converge with the independent reviewer having read nothing.

- A quoted value with **no closing quote** was accepted as a plain string: `docs: "abc` became the
  string `"abc`, which is non-empty and therefore satisfied the gate.
- An **escaped** closing quote was treated as a terminator: `docs: "/some/path\"` ends with a quote
  character, but that quote is escaped, so the value was still unterminated — and the parser
  returned a silently truncated path that passed every later check.
- A **second YAML document** was silently merged into the first instead of being refused.
- A **degenerate** path was accepted. `/`, `//`, `/.`, `/..` all pass a "starts with a slash" test
  and all resolve to a directory holding no evidence.
- A path that is **absent, or present but unreadable in substance** (`/dev/null` is the clean
  example) was only ever a warning. It is now an error at compile time, because compiling is what
  puts the anchor into the panel, where the sandbox can never check it again.

**Installation — writes to paths nobody examined.**

- A **dangling symlink** at a destination bypassed the guard: `[ -e ]` is false for one, so the
  destination was skipped entirely, never entered the conflict list, and the copy then followed the
  link and created its target. Both the manifest path and ordinary destinations are affected; the
  symlink test now runs first everywhere, including backup destinations.
- **`--force` could overwrite a file this package never wrote.** It now means only "discard my own
  edits to files you installed". An unowned destination — or a foreign file at the manifest path,
  which is about to be truncated — is refused unconditionally.
- **Placeholder substitution wrote raw text into a single-quoted JavaScript literal.** A home
  directory containing a quote, a backslash or a newline produced a driver that did not parse, while
  the "no placeholder left" check still passed and the installer reported success. Substitution now
  escapes for the target literal, and the installer loads the installed driver afterwards.

**Removal and integrity — "verified" that verified nothing.**

- The **manifest was truncated without any ownership check**, unlike every other destination.
- A file marked **`mutable` was exempt from verification entirely**. Only one region of the panel
  legitimately changes — the generated profile block, rewritten by `profile apply` — but the
  exemption covered the whole file, so `uninstall` deleted the panel however much had been changed
  and `doctor` reported it unmodified without looking. The manifest now records a second hash over
  everything outside that block, and both commands check it. Every failure path resolves to "keep":
  not being able to prove a file is ours is a reason to leave it alone.
- **`doctor` reported integrity failures as notes**, which do not affect its exit code. A missing or
  altered installed file printed a message and still exited 0, so a script saw a pass.
- **`--purge-profile` recursively deleted whatever `DUAL_AUDIT_CONFIG_DIR` named.** It now refuses
  anything that is not an absolute, non-symlink directory containing a `profile.yaml`.

**The reviewer wrapper — a guarantee left to the caller.**

- The sandbox mode was **passed straight through**, so "the reviewer cannot write" held only for
  callers who already intended it. The wrapper now refuses any sandbox but `read-only`, refuses the
  explicit sandbox-removal flags, and refuses an exec request that does not ask for read-only at
  all.
- The **serial-mode credential home had no symlink or ownership guard**, though it is the one path
  that writes a credential to a long-lived location and both `mkdir -p` and `cp -f` follow links.

**Terminal states.**

- The mapping **checked the approval before the disqualifying signals**, so a result carrying
  `converged: true` alongside an `error`, or alongside an escalation stage, was reported as
  CONVERGED. Every disqualifying signal is now read first, and an approval must be unambiguous: the
  boolean and the status must both say so, with a missing status no longer accepted. The current
  panel cannot emit that combination, so this is defence in depth rather than a fixed defect — but
  this mapping is the system's fail-closed classifier, and it should refuse to classify rather than
  guess "approved".

**Documentation that overstated the code.** The README claimed uninstall removes only what still
matches its hashes (untrue for the panel, per the exemption above); `SECURITY.md` stated the private
per-run home and the stripped refresh token unconditionally, without saying that serial mode
deliberately trades both away under a lock; and `doctor` summarised its integrity check as "all
installed files present and unmodified" while skipping a file. All three now say what the code does.

**Naming left half-renamed.** The panel still told users to raise `CODEX_AUDIT_TIMEOUT`, a variable
the wrapper does not read — so anyone following that advice would change nothing and keep timing
out. This also contradicted the package-scoping claim above.

**Ownership that certified itself — the deepest version.** Found by a real reviewer run, not by a
test. A manifest is a plain file that anything can write, and it was what answered "is this
destination ours". A hand-written, shape-valid manifest naming a planned destination and that
destination's CURRENT hash therefore made the installer treat a stranger's file as its own untouched
copy — and overwrite it **silently, without `--force`, while reporting success**. Reproduced before
being fixed.

Ownership is now decided by a marker inside the file being replaced. Every file this package
installs carries one; a manifest cannot confer it. The installer, `uninstall` and `doctor` all ask
the file, and the manifest is demoted to answering only "did you edit it since". The manifest must
additionally name this package and may only list paths in the fixed install set, and it is never
truncated unless it passes those checks. An installed file that already holds exactly what would be
written — accounting for the substituted placeholders and the generated profile block — is a no-op
rather than a conflict, so losing the manifest no longer makes recovery need `--force`.

The honest limit: nothing without a secret can stop an attacker who already runs as you from
writing the marker too. What this stops is the realistic case — a stale, copied, or hand-made
manifest authorising a write to a file this package never installed.

**Ownership that certified itself.** The installation manifest is a file, and a file can claim
anything — but every path inside it was trusted enough to verify, overwrite or delete. Anything
shaped like `{version, files}` was accepted as this package's ownership record, so a stale manifest
from another installation, or a hand-written one, could name any file on the machine. The set of
paths this package may own is now computed in code, from one table that the installer builds its
plan from and that uninstall and doctor check against; a manifest entry outside it is reported and
left alone. Related, in the same layer: a backup destination could overwrite an earlier backup —
destroying the pristine original that `--force` exists to preserve — and the profile destination was
checked for symlinks only at the point of writing, which is after all twelve files have been copied
and before the manifest exists, leaving a half-installed tree that nothing owned. Both are now
checked in the pre-flight scan, before anything is written.

**Commit metadata was never scanned.** Publishing a repository publishes its history, and every
content scan excludes `.git` by construction, so an author name and e-mail in every commit stayed
invisible while the files came back clean. The scanner now reports commit identities and fails
unless they are explicitly approved through `DUAL_AUDIT_ALLOW_GIT_IDENTITY`. Publishing under your
own name is a perfectly good decision; it just has to be a decision. In the same pass, the
`sanitize-scan:allow` marker — a whole-line escape — now lists every line it exempts instead of
skipping them silently.

**A degenerate anchor spelled differently.** `/tmp/..` resolves to `/` but survived the check,
because the extractor stripped trailing dots as sentence punctuation and quietly rewrote it to
`/tmp`. Trailing dots are no longer stripped when the final segment is `.` or `..`, and the
comparison is made on the lexically normalised path.

**Routing keys that were not where the documentation said.** The skill routes on
`routing.full_audit_triggers`, but a user profile inherits that table from its base and does not
repeat it, and `profile show` prints only what is compiled into the panel — where routing
deliberately is not. Reading the profile therefore showed no routing at all. `dual-audit profile
routing` prints the merged table, and the skill now says to use it.

**The licence text was not the licence text.** Every non-blank line of `LICENSE` was indented one
space short of the canonical Apache-2.0 layout — 11,174 bytes against the real 11,358. It reads as
Apache-2.0 to a human and fails a byte comparison against it, which is what anyone auditing a
dependency actually runs. Replaced with the canonical text, with only the copyright line filled in,
and a check added so a reflowed copy cannot ship again. Found by a real reviewer run, not by any of
the tests: the suites verified everything about how the package behaves and nothing about what it
says it is licensed under.

**The test harness itself.** A mutation whose anchor no longer matched the source silently became a
no-op, and a no-op mutant always "survives" — which reads as "this assertion has no teeth" when the
real cause is that the mutation never happened. It would have let a source edit quietly disable
every mutant while the suite stayed green. An unmatched anchor is now a loud failure of its own.

**Removal and replacement could act on a file they had never classified.** Every one of these was
reproduced against a real installation before being fixed.

- The removal classifier runs in Node and its answer reached the shell as newline-separated,
  tab-delimited text — a format the *data* could split. A manifest entry whose path contained a
  newline arrived as two records, the first carrying no state at all, and the `case` reading them
  had no default branch: the empty state fell through to `rm -f`. That deleted a path which had
  never been classified, bypassing the install-set check, the ownership marker and the hash in one
  step. Records are now NUL-delimited with the state first, which the data cannot forge, and
  deletion is the only case spelled out — every other state, including an unrecognised one, keeps
  the file.
- The classifier ran inside a process substitution, which hides its exit status, so a run that died
  half way produced a short list that read as a complete one. Its status is now read.
- The backup `cp -p` had no failure check, and `set -e` is not in effect, so a failed backup did
  not stop the next line from replacing the file. `--force` reported success having destroyed the
  edits it exists to preserve, contradicting the script's own usage text.
- Whether to back up was decided twice — once in the pre-flight scan, once in the write loop — and
  the two disagreed for a destination already identical to what would be written. The guards on the
  backup path did not cover it, while the write loop still made one, so recovering from a lost
  manifest could overwrite the backup holding the original or follow a `.bak` symlink out of the
  tree.
- A destination owned by another user was replaced rather than refused; a group-writable shared
  directory is enough to reach that.
- Uninstall deleted the manifest even when it had just decided to KEEP one of this package's files,
  leaving that file with nothing to identify it.

**The same injection, wearing the delimiter that replaced it.** The removal classifier's records
were moved to a NUL-delimited format on the reasoning that a path cannot contain a NUL. That is true
of a filesystem path and false of a path in a JSON manifest, where a NUL has a legal escape and the
manifest is data rather than a path — so one entry could close its own record, open another, and have
the reader delete a path nothing had classified. Reproduced against a real installation. Control
characters in a manifest path are now refused outright, the classifier declares how many records it
wrote and the reader refuses a stream whose count does not match, and the reader now reads the whole
list before acting on any of it: a count check that runs after the deletions can only ever be a
post-mortem.

**Other ways a removal or an install could end badly.** All reproduced.

- A failed `rm` still counted as a removal, so the file stayed and the manifest describing it was
  deleted anyway.
- An installed file you edited, deleting its ownership marker comment along the way, was treated as a
  stranger's, so its record was deleted and the next install refused the leftover as unowned,
  permanently. Being one of our paths without the marker is now its own outcome.
- `--purge-profile` accepted any absolute directory that happened to contain a file called
  `profile.yaml`, and recursively deleted everything else in it. "It holds a profile.yaml" is not the
  question "is this our profile directory", and only the second licenses a recursive delete; the
  profile this package installs carries the ownership marker, so it can now be asked directly.
- The manifest was assembled with `printf`, so a destination path holding a quote or a backslash
  produced a file that no longer parsed while the install reported success — after which uninstall
  refused to read its own manifest and left everything behind. It is generated by a JSON serialiser.
- `chmod`, and the copy that creates the profile, could fail without stopping anything.

**The removal no longer takes its list of paths from the manifest.** This is the change the four
defects below were all symptoms of, and it is a structural one rather than another guard.

The loop used to run over the manifest's `files` array — a plain JSON file that anything can write —
and everything else in the removal path existed to make that safe. It was never safe: a path
containing a newline split one record into two under a newline-delimited format, and a path
containing an escaped NUL did the same to the NUL-delimited format that replaced it. Each fix
rejected the input that had just been demonstrated, and the next review demonstrated another.

The loop now runs over `installTargets`, the fixed list of paths this package installs, computed
from code. The manifest is consulted only by key, to answer "what hash did I write at this known
path". A path never leaves the manifest, so it cannot be smuggled, cannot close its own record, and
cannot name anything outside the install set — these are not blocked, they are inexpressible. Five
guards went with the defect: an entry-shape check, a control-character rejection, an install-set
membership test, a declared record count, and the "foreign" state itself. Entries naming paths this
package does not install are now counted and reported, and never examined.

**`--purge-profile` no longer deletes a directory at all.** Three checks stood in front of a
`rm -rf` whose target came from an environment variable, and each of them answered a question next
to the one that mattered.

- "Its `profile.yaml` carries our ownership marker" proves the FILE is ours. It cannot prove the
  DIRECTORY is, because the installer PLANTS that marker: it creates whatever `DUAL_AUDIT_CONFIG_DIR`
  names, existing or not, and copies a template whose first line carries it. Pointing the variable at
  a directory holding your own configuration made the package seed the very criterion the purge then
  accepted. Reproduced: an entire config directory recursively deleted, exit 0.
- A single trailing slash defeated both symlink guards at once — `[ -L "x/" ]` is false for a link to
  a directory, and `find "x/" -maxdepth 1 -type l` searches the target rather than the link — so the
  delete followed the link and emptied the directory it pointed at.

The fix is not a fourth check. The operation is now what the flag promises: remove the profile FILE,
then remove the directory only if that left it empty. `rmdir` cannot take anything with it.

**The record no longer dies before the files it describes.** Whether to keep the manifest was decided
by a counter that some keep-outcomes never incremented, and then by asking the library which paths
belong to this package — but that library is itself one of the installed files, so the question
destroyed its own answer. An ordinary two-run sequence (run one keeps an edited panel and removes the
library; run two can no longer see what is ours) deleted the manifest run one had deliberately
preserved, leaving the panel with nothing to identify it. The list of paths is now captured before
anything is removed, and a library that cannot be read is a refusal rather than a classification.

**`doctor` could report a pass it had not earned.** Also all reproduced.

- The exempt span in the panel was located by taking the *first* of each block marker. A decoy
  start marker above the real block widened the span to swallow arbitrary code while leaving the
  base hash untouched — 156 injected bytes, identical hash, exit 0, and the summary line still read
  "every byte outside the generated profile block still matches the manifest". Both markers must now
  occur exactly once, in order, or nothing is exempt.
- The integrity check iterated the manifest, so the manifest decided how much got verified: an empty
  file list produced an empty findings list, which read as "no problems". Coverage is now computed
  from code.
- A malformed manifest entry crashed the checker, and with its stderr discarded the crash was
  indistinguishable from a clean run with nothing to report.
- With no usable panel path the compiled-profile check was skipped in silence.
- Docs anchors were only `stat`-ed, which succeeds on a mode-000 file, an empty file and an empty
  directory — the exact anchors that satisfy the gate while yielding nothing to read.

**The removal path was rebuilt rather than guarded.** The uninstaller used to iterate the manifest,
and that one decision produced every serious defect it had: a path containing a newline split one
record into two, and a path containing an escaped NUL did the same to the NUL-delimited format that
replaced it. Each fix rejected the input just demonstrated and the next review demonstrated another.
The loop now runs over the list of files this package installs, held in code; the manifest is
consulted only by key, to answer "what hash did you record for this path I already know I install".
Those attacks are no longer blocked — they cannot be expressed. Five guards were removed with the
defect they existed for. The same review round found three more, all reproduced first:

- The list of paths to remove was derived **twice** — once before anything is removed, once inside
  the classifier — and the only thing comparing them was their **length**. Two same-length lists of
  different paths passed: the run deleted the second while deciding "nothing of ours is left" from
  the first, then removed the manifest identifying the files still on disk. The classifier now reads
  the captured list; one computation cannot disagree with itself. This seam was introduced by the
  fix above, which added the early capture but left the second derivation in place.
- An **empty** installed-file list sailed through that comparison, found no leftovers because it had
  looked at nothing, and deleted the manifest while every file it described was still installed.
  Reproduced against the pre-fix source. Now refused.
- The installation plan was `|`-joined, and the destination is built from directories the caller
  names in the environment. `DUAL_AUDIT_SHARE_DIR='/tmp/s|x'` truncated the destination at the
  delimiter and collapsed four source files onto one path, reporting success. Three NUL-terminated
  fields now, read from a file because `$( )` discards NUL — the same defect class as the two above,
  closed the same way.
- The plan-integrity check added with that change **did not fire on the case it was written for**: a
  fragment cut mid-field carries no delimiter, so the count still balanced. Found by probe, not by
  the test suite, which was green. The stream must now also end on a record boundary.

**A closed grammar the parser did not enforce.** The reviewer is told, verbatim, that the verdict
block is parsed by a closed grammar and that anything outside the listed shapes makes the verdict
INVALID — "refused, not silently reinterpreted". The parser detected a value hiding another field
declaration and only recorded a warning; nothing downstream read it. Reproduced:

```
P0: none
EVIDENCE: read 3 files<br>P0: the delete path removes user data
```

converged as an approval with no unresolved blockers. A stated blocker travelled through the entire
panel unread, which is the one outcome the whole design exists to prevent.

The first attempt at this was wrong in both directions, and both are worth recording because the
second attempt is shaped by them. It refused any value naming `P0`, `VERDICT` or `VERIFIED`, and it
only looked at lines the parser had already recognised. So:

- **It still leaked.** `**P0**: x`, `note P0: x`, `(P0: x)` and `P0 (blocking): x` are not lines this
  parser recognises, so they landed in the "unparsed" list, which a comment declared did not affect
  validity — and the round converged. A colon variant did the same from inside a recognised value:
  `P0： x` differs from the refused ASCII form by one character and passed with no warning at all.
  Naming those five shapes and matching them too would have been the same mistake a sixth time.
- **It also over-refused.** Measured against 76 real verdicts: 15 of them — one in five — were
  ordinary prose. Reviewers discuss these fields constantly ("that is `VERIFIED: fail`, an honest
  'I could not verify'"; quoting a log line; explaining what P0 means). A gate that refuses one
  honest verdict in five is a tax, not a protection.

What ships is two rules instead of one:

1. **A line inside the block that the parser cannot read makes the block invalid** — which is what
   the prompt has always promised ("EVERY line inside the block must be one of the listed fields...
   no prose lines, no bullets, no continuation lines, no notes"). Machine marker lines are exempt,
   because the wrapper writes its exit code inside every block. This closes the prefix shapes as a
   class rather than one at a time. Cost measured on the same 76 verdicts: **zero** contained one.
2. **A value naming `P0` invalidates the block only when this block's own `P0` says nothing.**
   `VERDICT` and `VERIFIED` are enumerated fields checked against their own token lists, so no
   blocker can hide in them; a blocker can only be lost when the field that carries blockers is
   empty. Same 76 verdicts: **one** refusal, 1%.

Folding a *bullet* that names a field is unchanged — that path captures the blocker into its own
field rather than losing it.

Rough edge, stated rather than hidden: a round-1 verdict rejected this way surfaces later as
`prior_state_schema_invalid`, which is fail-closed and never an approval, but names the symptom
rather than the cause.

**A reviewer budget that could not be spent.** `DUAL_AUDIT_TIMEOUT` and `DUAL_AUDIT_LOCK_WAIT`
defaulted to 900 and 1200 seconds, while the reviewer agent runs the wrapper as a single shell
command that Claude Code cuts off after 600. Whatever the review then produced went to a file the
agent was no longer waiting on, so it returned nothing — reported honestly as
`INFRASTRUCTURE_BLOCKED`, but indistinguishable from Codex being down, with no transcript to tell
them apart. A real review of two shell scripts took 456 seconds, so this worked until the review got
big. Both now default to 540, so the wrapper reaches its own limit first and says which one.

### Known limitations

- **A verdict restated in the forwarder's own words still fails the identity check.** Folding
  ignores machine-written `__NAME=value` marker lines, so a genuine duplicate that lost its marker
  in transit still folds. Nothing wider is ignored: if the agent paraphrases, re-wraps or annotates
  one of the copies, the two differ in a way a reader would care about, the panel sees two distinct
  verdicts, and it refuses to merge either — an `INVALID_AUDIT` rather than a wrong answer, costing
  a round. The shipped agent definition says to return the wrapper's stdout verbatim, and to shorten
  by dropping everything before the first `VERDICT:` rather than by rewriting. See
  `docs/troubleshooting.md`.
- **An install that fails part-way is not rolled back.** Every destination is checked before
  anything is written, so a *refusal* leaves the tree untouched. But a failure during the writing
  itself — a full disk, a permission that changed under us — stops at that point with the files
  before it already replaced and no manifest written. Nothing is lost that `--force` would not have
  backed up, and re-running the installer completes the job; there is no staging area and no
  automatic undo.
- **Neither the installer nor the uninstaller is atomic between deciding and acting.** Both examine
  a path and act on that path in a later pass, so what they judged and what they write or remove can
  be different files: a destination replaced by a symlink between the pre-flight scan and the write
  is followed; a file classified as removable and then replaced atomically by an editor is removed
  in its new form; the profile file whose ownership marker was checked is not pinned to the
  directory the removal then resolves. This needs same-uid access to your own home and precise
  timing, and both scripts refuse far more readily than they act — the realistic outcome is a file
  kept that could have gone. Closing it properly needs operations on open descriptors rather than on
  paths, which is not available here. It is a real gap, not a theoretical one, and it is listed
  rather than claimed away. Do not run two of them at once, and do not edit installed files while
  either is running.
- **The uninstaller decodes the captured path list as UTF-8.** A byte sequence in one of the install
  directories that is not valid UTF-8 is classified under a mangled name. It resolves safely — the
  mangled path cannot be read, so the file is kept, and the manifest is kept with it — but the file
  is then not removable by the uninstaller.
- CI stubs the reviewer CLI so `doctor`'s presence check passes on a clean runner. That means CI
  proves the guards, the protocol and the installation flow — not that a real review works
  end-to-end. Nothing in CI can reach a model, by design.

### Not included, deliberately

- Codex as the controller. The interface is reserved; an unverified implementation is not shipped.
- macOS and Windows support.
- A demonstration project, and the original system's design and incident history.
