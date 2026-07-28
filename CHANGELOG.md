# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `WHY.md` and `WHY.zh-CN.md` — the author's account of what went wrong before this existed, and
  why the answer turned out not to be "find a smarter model". Linked from both READMEs, because
  most people reading a README first want to know why the thing was built at all.

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
