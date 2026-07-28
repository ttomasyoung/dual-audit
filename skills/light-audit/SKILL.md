---
name: light-audit
description: Get ONE independent read-only second opinion from Codex, bounded to at most two attempts. Use for a small disagreement, a suspected mistake, or a question a deterministic run did not settle — and whenever the user asks for a light review, a quick second opinion, or "check this with the other model". Escalates to the full dual-audit panel or to the user instead of looping.
---

# Light audit (one independent second opinion)

This is the cheap lane. One read-only reviewer, a bounded brief, and a hard ceiling of **two**
review attempts on the same question. It exists so that a small disagreement does not have to
convene a full panel, and it is deliberately unable to grind: if two attempts do not settle the
question, that is a signal to escalate, not to try again.

## When this is the right lane

Use it when:

- there is a small disagreement or a suspected mistake, and one outside opinion is enough;
- a deterministic run was attempted and did not settle the question;
- the user explicitly asked for a lightweight second opinion;
- you are closing out individual points a full panel left unresolved.

Do NOT use it when the question touches something the full panel exists for: a definition,
threshold or rule others will rely on; output that becomes a load-bearing input downstream; rules,
schemas, permissions or critical configuration; an irreversible, destructive or production action;
or anything listed in `critical_areas` in `__DUAL_AUDIT_PROFILE_PATH__`. Those go straight to the
`dual-audit` skill — light review is not a cheaper substitute for the panel, and must never be used
to pre-clear something the panel should judge.

If a deterministic check would answer the question, run the check instead. Facts beat opinions
whenever facts are cheap.

## How to run it

Dispatch the `dual-audit-codex-readonly` agent with a brief you have written yourself. The brief
must be self-contained, because the reviewer does not share your context:

1. **The question**, stated so it can be answered yes or no, or with a specific finding.
2. **A bounded read allowlist** — the ABSOLUTE paths it may read. No whole-tree searching. Relative
   paths and `~` silently read nothing, because the reviewer runs from a neutral directory under a
   restricted HOME.
3. **What "wrong" would look like** — the specific failure you are worried about.
4. **The output contract** — ask for a short verdict, the evidence it actually read (cite line
   numbers or concrete values), and any blocking issue with a damage chain: condition, error,
   consequence.

Do not send your own conclusion or draft verdict with the question. A reviewer shown the answer
first tends to agree with it, and then you have paid for a rubber stamp instead of an opinion.

## The ceiling

**At most two review attempts on the same question.** Attempt one is the review; attempt two is a
single targeted follow-up on what the first attempt raised. Rewriting the thing under review and
asking again is still the same question, and still counts.

Before a third attempt would happen, stop and choose:

- escalate to the `dual-audit` skill (a bounded panel with independent first-round reading and
  cross-examination), or
- hand the disagreement to the user with both positions and the evidence for each.

Two attempts that do not converge mean this lane is the wrong tool, not that the question needs
another pass. Looping here is how a "cheap" check quietly becomes more expensive than the panel.

## Reading the result

- **Empty output, a truncated reply, a timeout, or a nonzero exit is a FAILURE, never a pass.** A
  broken reviewer and a reviewer that found nothing look almost identical, which is exactly why
  silence must not be read as approval. If you did not get a substantive reply, this review did not
  happen: re-run it or hand it to the user, and do not report a pass.
- A finding needs a verifiable damage chain — condition, error, consequence. Without one it is an
  opinion, not a defect. That does not mean it must be reproduced on the spot: an irreversible
  event, a race, a scale effect or a leak cannot be safely reproduced.
- Agreement between you and the reviewer is not proof. Two models can be confidently wrong in the
  same direction. For anything load-bearing, anchor the conclusion to something outside both of
  you, or escalate.
- Report what came back plainly, including "the reviewer disagreed with me and I think it is
  wrong, for these reasons". Do not present a verdict you have privately overruled as a pass.

<!-- dual-audit:package-file (installed by dual-audit; ownership marker — do not remove) -->
