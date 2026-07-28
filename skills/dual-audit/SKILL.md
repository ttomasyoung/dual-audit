---
name: dual-audit
description: Run the bounded Claude+Codex dual-audit panel — an independent first round followed by cross-examination, capped at three rounds, fail-closed. Use when a decision would be costly to get wrong: a definition, threshold or rule others will rely on; output that becomes a load-bearing input downstream; rules, schemas, permissions or critical configuration; an irreversible, destructive or production action; or anything the user's profile marks critical. Also use whenever the user explicitly asks for a dual audit or a full review.
---

# Dual audit (full panel)

Two reviewers from different model families examine the same work. Round 1 is **independent**:
each side reads the raw sources itself and never sees the other's summary or verdict. Rounds 2
and 3 are **cross-examination**: both sides receive each other's frozen round-1 verdicts and must
justify any change of position with evidence, not with the other side's confidence. The panel is
bounded: it converges, preserves a minority position, or hands the decision back to you.

## Before routing: read the profile

Read `__DUAL_AUDIT_PROFILE_PATH__` first.

- If `customized: false`, **automatic routing is off**. Still honour an explicit request for a
  review, and tell the user once that they can turn automatic routing on by filling in
  `critical_areas` and setting `customized: true`.
- If `customized: true`, use `critical_areas` from that file **together with the routing table from
  `dual-audit profile routing`** to decide the route.

  Run that command rather than looking for `routing:` in the profile itself. A user profile
  normally inherits its routing table from its base (`base: default` or `base: research`) and does
  not repeat it, so reading the file alone shows no routing keys at all — which reads as "there are
  no triggers" rather than "they live one level up". The command prints the merged table. If the
  user has written their own `routing:` block, theirs is what it prints.

Three routes, in order of cost:

1. **Direct verification** — low risk and reversible, or a deterministic check settles it. Prefer
   facts over opinions whenever facts are cheap: run the check instead of convening a panel.
2. **Light audit** — a small disagreement, or a run that did not settle the question. Use the
   `light-audit` skill. It escalates here rather than looping.
3. **Full dual audit** — this skill.

## Launching

Always launch through the driver, and always by **absolute script path**:

```
Workflow({
  scriptPath: '__DUAL_AUDIT_RUN_PATH__',
  args: { task, context, user_context_raw, project, risk, kind, mode, run_id, contextPack }
})
```

Never invoke the panel workflow directly, and never launch either one by registered name. The
panel is a pure function: one invocation runs one round of the Claude side, returns a brief for
the other reviewer, and exits. It NEEDS the driver to run the second reviewer between rounds and
feed the verdict back. Invoke the panel yourself and you get a "waiting for the second reviewer"
hand-off which is easy to mistake for a result — that is how a dual audit silently collapses into
a single-sided self-review. Launching by name can also resolve to a CACHED copy of the script,
and a stale panel converges on state the current one would refuse; an absolute path is read from
disk every time.

### Arguments

- **`task`** and **`context`** must be SELF-CONTAINED. The reviewers do not share your context:
  inline the paths, the code excerpts, the numbers, the acceptance criteria.
- **`user_context_raw`** — the user's own words. Unlike `context`, this is safe to show the
  independent reviewer in round 1, because it is not your interpretation.
- **`contextPack`** (object) — REQUIRED when `kind` involves code, otherwise the panel fails
  closed and asks for it:
  - `targets` — the files or scripts under review
  - `expected` — the expected outputs, columns or counts to check against
  - `canonical_docs` — the source of truth; required when `risk: high`
  - `input_fixture` — a small fixture, never a full production dataset
  - `allowed_commands`, `forbidden_write_paths`
  - `generated_by_claude` — paths YOU produced. These are excluded from the independent reviewer's
    round-1 reading list, because reviewing your own output is not independent evidence.
  - Every path must be ABSOLUTE. The read-only reviewer runs from a neutral directory under a
    restricted HOME, so `~`, relative paths and URLs silently read nothing.
- **`project`** — matches a `projects[].id` in the profile and injects that project's anchors.
  Case-sensitive for identity purposes: two projects differing only in case are different audits.
- **`risk: high`** — irreversible, or corrupts a chain downstream. Widens the panel and requires an
  anchor source.
- **`kind`** — `mixed` (default, both gates) | `claim` (judgement, no code) | `code` (code only).
- **`mode`** — `adaptive` (default) | `quick` (1 round) | `standard` | `deep`.
- **`run_id`** — required only when two audits could have byte-identical arguments. The panel
  cannot mint a nonce, so identical arguments share an identity unless you pass distinct run ids.
  Thread the same value back unchanged every round.

Hard cap: 3 rounds x (<=3 Claude + <=3 Codex) = 18 reviewer calls, fail-closed.

## The two hard gates

- **Claims** — definitions and conclusions must be right. Published and prior definitions are not
  automatically true: trace the evidence chain, distinguish decisive from anecdotal, scrutinise the
  method, cross-validate. Agreement between two models is NOT evidence. An unanchored claim
  escalates for human sign-off instead of converging.
- **Code and output** — smoke test plus dry run, verified independently by BOTH the read-only
  reviewer (static and contract tier) and the Claude side (isolated run tier). Unverified code that
  feeds the chain is a blocking issue.

## Reading the result

The driver returns exactly one `terminal_state`:

| `terminal_state` | Meaning | How to report it |
|---|---|---|
| `CONVERGED` | Both gates passed. | The only state you may describe as a completed review. |
| `NOT_CONVERGED` | Rounds ran out with substantive disagreement, or a claim needs human sign-off. | Surface `blockers`, `unresolved_p0`, minority positions, `unanchored_claims`. Do not pass the work downstream. |
| `INFRASTRUCTURE_BLOCKED` | A reviewer or runtime facility was unavailable — nothing was judged. | Say the review did not run. This is NOT "no problems found". |
| `INVALID_AUDIT` | Identity, state, schema or argument validation failed. | Say what was rejected and re-run correctly. Never edit an identity token to make a mismatch go away. |

A failed reviewer and a reviewer that found nothing produce very similar-looking output, which is
why empty output, a timeout and a nonzero exit are all treated as failures rather than approvals.
Report `agent_budget` when it is present — identity and shape failures return none at all. A high
`invalid_results` count means a reviewer returned placeholder or unparsable text: say so, and never
read an invalid result as an approval.

## Cost

A read-only reviewer pass takes minutes and tens of thousands of tokens; a full panel is
expensive. Use it per high-stakes step, and verify cheaply BETWEEN steps rather than convening a
panel for each one. For routine questions use `light-audit`, or just run the check.

<!-- dual-audit:package-file (installed by dual-audit; ownership marker — do not remove) -->
