# The review protocol

This document describes what the panel actually enforces, and why each gate exists. Where a gate
exists because the obvious alternative failed, that is stated — a gate whose reason is not written
down gets removed by the next person who finds it inconvenient.

## Rounds

### Round 1 — independent

Both reviewers receive the same task and the same read allowlist, and **neither receives the
other's interpretation, summary or verdict**. The reason is simple: a reviewer shown a conclusion
tends to agree with it, and a second opinion that was told the answer first is not a second
opinion.

Two consequences are enforced mechanically:

- **The controller's own notes never enter the independent brief.** The caller can pass `context`
  (which may contain the controller's analysis) and `user_context_raw` (the user's own words).
  Only the latter reaches the independent reviewer.
- **Anything the controller generated is excluded from the independent read list.** Paths listed
  in `contextPack.generated_by_claude` are filtered out. Reviewing your own output is not
  independent evidence.

Independence is **not** unbounded exploration. The brief carries an explicit list of paths to
read, forbids searching elsewhere, and is time-boxed. An unbounded search reads unrelated material
and runs out of time before producing a verdict.

If, after the provenance filter, the independent reviewer would have **nothing real to read**, the
panel refuses to converge. An "independent" round over an empty reading list proves nothing, and
was able to converge before this was checked.

### Rounds 2 and 3 — cross-examination

Both sides receive each other's **frozen** round-1 verdicts plus the open issue ledger. Round 1 is
immutable. Each side must address the disagreement, and any change of position must be declared in
a `DELTA` field.

Two gates enforce that a change of position is meaningful:

- **The flip-stability gate.** Going from not-approving to approving relative to the immediately
  prior round is a *fresh flip*, and a round containing one may not declare convergence: the
  approval must survive one further round of review. If the round budget runs out while a fresh
  flip is outstanding, the panel does **not** converge and escalates — a last-minute change of
  heart is exactly the case a human should see.
  It compares against the *immediately prior* round, not the frozen round 1. Comparing against
  round 1 would make `REJECT → APPROVE → APPROVE` count as a flip forever, so convergence would be
  impossible.
- **The delta gate.** When a whole side returns to approving, **every** currently valid reviewer on
  that side must supply a non-empty, non-placeholder `DELTA`. A side-level rule ("at least one of
  them wrote a delta") left a hole: the reviewer who actually changed position could hide behind a
  colleague's delta, which is precisely the "changed because the other side sounded confident"
  the protocol forbids.

## The verdict contract

Every reviewer must end its reply with exactly one block:

```
VERDICT: APPROVE | REJECT
P0: none | <blocking issues>
EVIDENCE: <what you actually read, with concrete numbers>
VERIFIED: pass | fail          (code mode)
ANCHOR: anchored | none        (claim mode)
UNANCHORED_CLAIMS: none | ...  (claim mode)
DELTA: <what changed>          (cross-examination rounds)
AUDIT-ID: <id>
END
```

A malformed, truncated, placeholder, misidentified or incomplete verdict is **invalid**. It is not
negative evidence, and it is certainly not implicit approval.

### Why the block is parsed so strictly

Each rule below replaced something that failed open:

- **Line-anchored, with `END` alone on its own line.** An unanchored matcher let `NOT-VERDICT:`
  open a block, and let the everyday phrase "verified end-to-end" terminate one — so a foreign
  audit id could hide past the fake terminator.
- **Every Unicode line terminator counts as a line break.** Characters that *render* as a line
  break in terminals but are not JavaScript line terminators let `EVIDENCE: x<VT>P0: real blocker`
  look like two lines to a human and one line to the parser, and the P0 disappeared silently.
- **A field appearing twice with different values invalidates the block.** Taking the first match
  silently ignored a contradicting second line (`P0: none` then `P0: real blocker`).
- **A bullet or indented continuation naming a field is folded into that field**, neither ignored
  nor treated as fatal. Ignoring dropped real blockers; invalidating rejected honest verdicts over
  formatting.
- **Exactly one `VERDICT:` per block**, and a truncated `VERDICT:` start after a complete block
  invalidates it — that tail may be the reviewer's real, later conclusion, cut off mid-write.
- **`EVIDENCE` must contain at least one digit** to support an *approval*. This mechanises what the
  brief already asks for. It is a positive requirement precisely because the negative approach —
  listing phrases that mean "no evidence" — was defeated by paraphrase in every language, and every
  tightening rejected legitimate citations. Honest boundary: a digit does not make the evidence
  true. A reviewer can invent numbers. The gate only guarantees that something concrete was cited.

### Identity

Every brief carries `AUDIT-ID: <fingerprint>_r<round>`, and the verdict must reproduce it inside
the block. The fingerprint binds **every** caller argument except the per-round handshake payload,
so two substantively different audits cannot share an identity.

**Honest boundary:** this detects **mis-threading**, which is the realistic failure when a
controller juggles two audits. It is not authentication. A reviewer that copies the id can still
assert anything, and nothing here proves which model produced the text. Never hand-edit an id to
make a mismatch go away — that forges the very evidence the check exists for.

## Failure is not silence

A review pipeline fails in ways that look like success:

- **Empty output** — a reviewer that died and a reviewer that found nothing produce almost the same
  thing. Empty is a failure.
- **A killed or timed-out run** routinely leaves a complete-looking `APPROVE` block on stdout. The
  caller sees only text and cannot observe the exit code, so the wrapper — the only party that can
  see it — writes the code **inside** the verdict block. A missing marker breaks parsing loudly
  instead of vanishing. Supplying a verdict without its exit code is treated as "reviewer
  unavailable", never as a pass.
- **Repeated unavailability** escalates rather than burning the budget on retries.

## Budgets

Three rounds maximum, at most three reviewers per side per round, with an absolute ceiling of 18
reviewer calls, fail-closed. In the default configuration the reviewer side runs exactly one pass
per round, so the real topology is *W Claude reviewers + 1 independent reviewer*.

Width adapts: routine work starts at one Claude reviewer, high-risk or deep mode at two, and only
a signal — several real blocking issues, or the two sides splitting — widens to three. Cost is
controlled by width and rounds, **never** by lowering reviewer effort.

## Terminal states

The driver maps everything the panel can return onto exactly four classes:

- `CONVERGED` — both gates passed. The only state that means the review completed.
- `NOT_CONVERGED` — rounds exhausted with substantive disagreement, or a claim needs human
  sign-off. Unresolved issues and minority positions travel with it.
- `INFRASTRUCTURE_BLOCKED` — a reviewer or runtime facility was unavailable. Nothing was judged.
- `INVALID_AUDIT` — identity, state, schema or argument validation failed.

An unrecognised state maps to `INVALID_AUDIT`. This is the single most important default in the
system: the failure mode to avoid is not "we rejected something good", it is "we called something
approved that nobody actually reviewed".

## What this protocol does not do

- It does not verify that a claim is true, only that it was anchored to something checkable.
- It does not prove which model wrote a verdict.
- It does not judge whether prose says anything substantive. That was attempted with closed
  vocabularies and abandoned: the words that form an empty answer and the words that form a
  legitimate citation are lexically inseparable. The hard gates are structural; fuzzy judgement is
  downgraded to advisories addressed to a human.
- It does not perform the action under review. It never deploys, deletes, submits or publishes.
