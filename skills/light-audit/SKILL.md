---
name: light-audit
description: Run the dual-audit panel at its shortest depth — one independent round instead of three. Use for a small disagreement, a suspected mistake, or a question a deterministic run did not settle, and whenever the user asks for a light review, a quick second opinion, or "check this with the other model". Same panel, same gates, fewer rounds.
---

# Light audit (the panel, one round)

This is the **same panel** as `dual-audit`, run at its shortest depth: `mode: 'quick'`, one round
instead of three. Same seats, same independent first-round reading, same gates, same terminal
states. You give up cross-examination and nothing else.

It is worth knowing what that replaced, because it changes what you can use this for. The old cheap
lane was a different mechanism: a single read-only reviewer, dispatched with a brief *you* had
written — so it read your framing of the problem instead of the problem, which is the exact failure
this project exists to prevent — and with no Claude-side seat, so a question about whether code
*works* was answered by reading it. Quick depth keeps the independent reading and the run seat.

## When this is the right depth

- a small disagreement or a suspected mistake, and one round of independent reading settles it;
- a deterministic run was attempted and did not settle the question;
- the user asked for a quick second opinion;
- closing out individual points a full panel left unresolved.

Go to full depth instead when the question touches what the panel exists for: a definition,
threshold or rule others will rely on; output that becomes a load-bearing input downstream; rules,
schemas, permissions or critical configuration; an irreversible, destructive or production action;
or anything in `critical_areas` in `__DUAL_AUDIT_PROFILE_PATH__`.

**One round is shorter, never softer.** The gates are identical, so a finding that blocks at three
rounds blocks at one — including a finding that full depth should have judged.

If a deterministic check would answer the question, run the check. Facts beat opinions whenever
facts are cheap.

## How to run it

```
Workflow({
  scriptPath: '__DUAL_AUDIT_RUN_PATH__',
  args: { task, context, user_context_raw, project, risk, kind, mode: 'quick', run_id, contextPack }
})
```

Every argument means what it means in the `dual-audit` skill; read that for the contract. `task` and
`context` must be **self-contained** — the reviewers do not share your context — and every path in
`contextPack` must be absolute.

**Do not write the reviewers' brief for them, and do not send your own conclusion.** The panel builds
the independent first-round brief from your raw sources. That is the mechanism, not a formality.

## The ceiling

**At most two panels on the same question**, at any depth. The first is the review; the second is a
targeted follow-up on what the first raised. Rewriting the thing under review and asking again is
still the same question, and still counts.

Before a third would happen, stop and choose: run it at full depth, or hand the disagreement to the
user with both positions and the evidence for each. Two panels that do not settle it mean the
question is not the kind this tool answers — not that it needs another pass. Looping is how a
"cheap" check becomes more expensive than the panel it was avoiding.

## Reading the result

The terminal states are the same four, and only `CONVERGED` means the review passed.

- **Empty output, a truncated reply, a timeout, or a nonzero exit is a FAILURE, never a pass.** A
  broken reviewer and a reviewer that found nothing look almost identical. If you did not get a
  substantive reply, this review did not happen.
- A finding needs a verifiable damage chain — condition, error, consequence. Without one it is an
  opinion, not a defect. It need not be reproduced on the spot: an irreversible event, a race, a
  scale effect or a leak cannot be safely reproduced.
- Agreement between two models is not proof. For anything load-bearing, anchor the conclusion to
  something outside both of them, or escalate.
- Report what came back plainly, including "the reviewer disagreed with me and I think it is wrong,
  for these reasons". Never present a verdict you have privately overruled as a pass.

<!-- dual-audit:package-file (installed by dual-audit; ownership marker — do not remove) -->
