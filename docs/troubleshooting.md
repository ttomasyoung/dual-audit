# Troubleshooting

Start with `dual-audit doctor`. It exits 0 only when everything it checks is usable, and it never
fixes anything silently.

## Terminal states

### `INFRASTRUCTURE_BLOCKED`

**Nothing was judged.** This is not "no problems found", and it must never be reported as a pass.

| Symptom | Usual cause |
|---|---|
| `codex_unavailable` | The reviewer produced nothing, was killed, exited nonzero, or its exit code could not be read. |
| `driver_error` | The panel itself did not run, returned nothing, or returned no brief or state. |
| `driver_call_cap_reached` | The panel kept returning "waiting for the reviewer". Abnormal — send the last panel result to a human. |

Check, in order: is `dual-audit-codex` on your `PATH`; is the Codex CLI installed and
authenticated; does `rc_diagnostics` in the result say the exit-code marker went missing (see
below).

#### `codex_unavailable` on the very first audit after installing

If the reviewer produces **empty output twice** on a freshly installed package, and the reviewer
agent left no transcript at all, the likely cause is not Codex: the controller had not yet picked up
the newly installed `dual-audit-codex-readonly` agent definition. A session that was already running
when you installed does not necessarily see a new agent, and a request for an agent type that is not
registered fails before anything runs — which looks identical to a reviewer that produced nothing.

Start a new session (or restart the current one) after installing, then run the audit again. Two
signals separate this from a genuine Codex problem: there is **no transcript file** for the reviewer
agent, and calling the wrapper by hand works:

```sh
printf 'Reply with: VERDICT: APPROVE\\nP0: none\\nEND\\n' \
  | dual-audit-codex exec --sandbox read-only --skip-git-repo-check --emit-rc -
```

If that returns a verdict block with a `__DUAL_AUDIT_RC=` line, Codex and the wrapper are fine and
the problem is on the controller side.

#### `codex_unavailable` when the wrapper works by hand and the review is a big one

Same empty output, and the hand check above still succeeds — but the reviewer's transcript ends with
the tool result *"Command did not complete within its 600s timeout and was moved to the background"*.

The reviewer agent runs the wrapper as a **single** shell command, and the caller cuts that command
off at its own ceiling — in Claude Code, **120 seconds unless the call asks for more**, up to 600.
Whatever the review then produces is written to a file the agent is no longer waiting on, so it
returns nothing.

This used to be the one failure that looked identical from the outside to a dead reviewer. It no
longer is: the wrapper writes a launch marker the instant before it hands control over, so a run that
started and was killed reports `LAUNCHED_BUT_NO_VERDICT` rather than the same empty output as a run
that never started. **The marker does not save the review** — it only makes the loss visible, which is
the difference between losing a seat and not knowing you lost one.

The defaults are set so the wrapper hits its own limit first and says so (`124` timed out, `99` no
slot, `97` no budget left to start with). Queueing comes out of the **same** 600 seconds as
reviewing, which is why `LOCK_WAIT` defaults to 20 rather than to `TIMEOUT`'s 540, and why the
wrapper re-measures what is left *after* winning a slot or a lock rather than only at entry. If you
still see it:

- narrow the brief — fewer raw sources, or split one review into two;
- lower `DUAL_AUDIT_MAX_PAR` so fewer reviews compete for slots;
- do not raise `DUAL_AUDIT_TIMEOUT` on its own. A budget larger than
  `DUAL_AUDIT_OUTER_BUDGET` cannot be spent — it only moves the failure from a message you can read
  to silence. If your controller has no 600 s ceiling, raise `DUAL_AUDIT_OUTER_BUDGET` too; see
  [configuration.md](configuration.md).

### `INVALID_AUDIT`

Identity, state, schema or argument validation failed.

| Status | Meaning |
|---|---|
| `prior_state_identity_mismatch` | The state belongs to a **different audit**. Do not retry with it, and never hand-edit its fingerprint. |
| `prior_state_run_id_mismatch` | The run id drifted between rounds. Thread the same one back each round. |
| `prior_state_round_invalid` | The round number is not an integer in range. |
| `prior_state_malformed` | The state arrived as something other than a plain object — usually JSON-stringified in transit. |
| `orphan_codex_verdict` | A reviewer verdict arrived with no prior state. No legitimate first round carries one. |
| `codex_verdict_identity_mismatch` | The verdict does not carry this audit's id for this round, or the block could not be parsed. |
| `prior_state_frozen_r1_missing` | Round 2 or later with no frozen round-1 record on both sides. |
| `prior_state_schema_invalid` / `prior_state_legacy_worker_format` | The state came from an older, incompatible version. Start the audit again. |
| An `error` with no status | Arguments were refused — usually an incomplete `contextPack` or a non-absolute path. |

**Never edit an identity token to make a mismatch go away.** That forges the exact evidence the
check exists for. Re-run the reviewer on this audit's own brief instead.

#### `codex_verdict_identity_mismatch` when the id looks like it *is* there

The most common cause is not a missing id — it is **two verdict blocks that are not byte-identical**.

The panel folds duplicate blocks, but only when they match exactly; two blocks that differ are two
distinct verdicts, and it refuses to guess which one is the answer. So the failure looks like this:
the reviewer's output contains the verdict twice, once as the agent's own restatement and once as
the forwarded wrapper output, and only the forwarded copy carries the injected `__DUAL_AUDIT_RC=`
line. The two copies differ by that one line, folding does not happen, and the diagnosis reads
"no AUDIT-ID inside the block" even though both copies contain one.

To confirm, count the blocks and diff them:

```sh
awk '/^[ \t]*VERDICT[ \t]*:/{n++} n{print > ("/tmp/block" n ".txt")} /^[ \t]*END[ \t]*$/{n=n}' reviewer-output.txt
diff /tmp/block1.txt /tmp/block2.txt
```

A one-line difference of exactly the `__DUAL_AUDIT_RC=` marker confirms it.

The fix is on the reviewer side: the agent must return the wrapper's stdout **verbatim**, with no
restatement, preface or summary. The shipped `dual-audit-codex-readonly` agent says so explicitly.
This is fail-closed — a wasted round, never a wrong verdict — but it is a wasted round, so it is
worth getting the agent definition right rather than working around it.

### `NOT_CONVERGED`

The review ran and did not settle. Read `blockers`, `unresolved_p0`, minority positions and
`unanchored_claims`. Do not pass the work downstream.

Common and legitimate: a round-3 approval that flipped from the previous round has not been stable
for a further round, so the panel escalates rather than converging. That is the gate working.

## `dual-audit doctor` findings

| Finding | What to do |
|---|---|
| `~/.local/bin is NOT on PATH` | The reviewer wrapper is invoked by name. Add it to your shell profile. |
| `codex CLI not found` | Install it, or set `DUAL_AUDIT_CODEX_BIN` to its absolute path. |
| `PROFILE_STALE` | You edited the profile without recompiling. Run `dual-audit profile apply`. |
| `PROFILE_BLOCK_MISSING` | The installed panel has no generated profile block. Reinstall; do not hand-edit the panel. |
| `modified since install` | Either you edited an installed file, or something else did. Compare against the repository and reinstall with `--force` if you want the package version back (it backs yours up first). |
| `customized: false` | Automatic routing is off by design. Fill in `critical_areas` and set it to `true`. |

## The exit-code marker

The driver returns `rc_diagnostics` whenever it could not read `__DUAL_AUDIT_RC=` from inside the
verdict block. Each entry carries a `code` and a `why`. The causes are distinguished because they
need different fixes:

| `code` | `why`, in short | Fix |
|---|---|---|
| `EMPTY_VERDICT_TEXT` | nothing came back at all | The reviewer produced nothing, or the agent call failed. Check the wrapper's own exit code below. |
| `LAUNCHED_BUT_NO_VERDICT` | the wrapper announced the launch, then nothing came back | **The reviewer really did start and was killed part-way.** Almost always a caller wall-clock ceiling shorter than a review needs: set `DUAL_AUDIT_OUTER_BUDGET` to the real ceiling, and give the command itself the longest timeout the caller allows. Infrastructure — never "the review found nothing". |
| `NO_BLOCK_NO_MARKER` | no verdict block and no marker | The reviewer produced no verdict, or the wrapper ran without `--emit-rc`. |
| `MARKER_WITHOUT_BLOCK` | a marker, but no `VERDICT..END` block anywhere | The reviewer produced no verdict; the marker you see is the wrapper's fallback append. |
| `MARKER_OUTSIDE_ANY_BLOCK` | a block exists, the marker is outside every one | The wrapper did not take the injection path — check that the agent definition passes `--emit-rc`, and that no old command template is in use. |
| `MARKER_IN_EARLIER_BLOCK` | the marker is in an earlier block, not the last | The reviewer printed its verdict more than once with inconsistent injection. |
| `MARKER_AMBIGUOUS_IN_LAST_BLOCK` | several markers in the last block | Ambiguous; refused fail-closed. |
| `MARKER_UNREADABLE_INTERNAL_INCONSISTENCY` | exactly one marker in the last block, and it still would not parse | A bug here, not in your setup. Please report it with the reviewer output. |

**`code` is a contract; `why` is not.** Branch on `code` in scripts and assertions — the literals
never change meaning, and new ones are only ever added. The `why` sentence is for humans and may be
reworded or translated at any time. They are separate because asserting on prose is a weak-assertion
trap, and this project hit it: a suite pointed at a build whose diagnostics were written in another
language went red everywhere while every behaviour was identical.

## Reviewer wrapper exit codes

| Code | Meaning |
|---|---|
| 99 | No slot or lock available. (The reviewer can also return 99 itself; the wrapper cannot tell them apart.) |
| 98 | Token admission failed (`--preflight` or `--batch`). |
| 97 | The caller's wall-clock ceiling (`DUAL_AUDIT_OUTER_BUDGET`) was already spent before the reviewer could start — usually setup plus queueing. **This is the wrapper refusing on purpose**, so that the failure arrives as a readable message instead of the caller killing the command into an empty stdout. If you see it often, the review is queueing: lower `DUAL_AUDIT_MAX_PAR`, or raise the budget if your caller genuinely has no ceiling. |
| 124, 137 | Timed out **or** the child was killed. Timeout-*like*, not proof of a timeout: the reviewer can return 124 itself, and 137 also comes from the OOM killer or an external kill. |
| 9 | stdin was an empty TTY, or the brief was zero bytes. |
| 8 | A bad argument, a malformed environment value, or a failed path guard. |
| 7 | Could not enter the private working directory. |
| 3-6 | Bootstrap failure (credentials, config, temporary files). |
| other | The reviewer's own exit code, passed through. |

## Aborting a running review

Counter-intuitive, so it is written down:

- `kill -TERM` on the wrapper does **not** stop it promptly — bash defers the trap until the
  foreground child finishes.
- `kill -TERM` on the wrapper's `timeout` child stops it immediately and cleans up. But the
  reviewer often exits gracefully on TERM and returns 0, so **an aborted review can look like a
  successful one**. The wrapper reports the child's real status and cannot distinguish the two;
  whoever sends the signal must account for it.
- `kill -9` on the wrapper orphans the reviewer and leaves the private home behind.

## Reviewer calls that bypass the wrapper

```bash
dual-audit-lint
```

It scans your agents, workflows, skills and commands for reviewer calls that skip the wrapper —
a bare call reading a fixed brief path, a shared brief path, or a call without the read-only
sandbox. Any of those can make a reviewer audit **someone else's task** when two sessions run at
once, and the result looks like a perfectly normal review.
