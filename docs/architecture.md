# Architecture

```text
        user request + raw sources + profile
                        |
                        v
                controller adapter            (Claude Code in this release)
                        |
                        v
                  stable loop driver          dual-audit-run.js
                        |
        +---------------+----------------+
        |                                |
        v                                v
 Claude reviewers                 reviewer brief
        |                                |
        |                                v
        |                    read-only reviewer adapter    dual-audit-codex
        |                                |
        +-------> verdict exchange <-----+
                        |
                        v
                convergence evaluation        dual-audit-panel.js
                 |        |          |
            CONVERGED   next     escalate / block
                        round
```

## Components

### Protocol core — `runtime/core/dual-audit-panel.js`

A **pure function**: one invocation runs one round of the Claude side, returns the brief for the
independent reviewer plus the round state, and exits. It owns the verdict schema, round state,
audit identity, the frozen round-1 record, the issue ledger, the anti-flip and evidence gates, and
the convergence decision.

It runs inside a workflow sandbox with **no filesystem access**. That single constraint explains
two design choices that would otherwise look odd: the profile is *compiled into* this file rather
than read at run time, and the panel cannot verify that a source path is readable — it validates
path *shape* only, and leaves readability to the reviewer that actually reads it.

### Controller adapter — `runtime/claude-controller/dual-audit-run.js`

The loop. It calls the panel, runs the independent reviewer between rounds, threads the verdict
back verbatim, and returns a terminal state.

It has one iron rule: **it never duplicates the panel's judgement.** Whether the audit converged,
whether to retry, whether the budget is spent — all read from the panel's returned fields. The
driver's job is to call, to run, and to report what it observed. A driver that starts interpreting
verdicts becomes a second, divergent implementation of the protocol.

Two consequences worth knowing:

- **It forwards reviewer text verbatim** and never reshapes it. Trimming the reply to the verdict
  region also deletes a truncated tail after the last `END`, which is exactly what the panel's tail
  guard needs to see.
- **It never invents an exit code.** The code comes only from the marker the wrapper injects inside
  the verdict block. If it cannot be read, nothing is forwarded and the panel applies its own
  fail-closed rule.

### Reviewer adapters

- **Claude side** runs inside the panel through the workflow runtime, and may write only inside a
  freshly created temporary directory of its own.
- **Independent side** — `runtime/codex-auditor/dual-audit-codex` plus the agent definition beside
  it. Strictly read-only, with a private home per run, a private working directory, an early
  snapshot of the brief, a bounded slot semaphore, and credentials with the refresh token removed.
  Serial mode is the documented exception: it reuses one long-lived home and keeps the refresh
  token, under an exclusive lock, because renewing the credential is why that mode exists.

Both return the same verdict contract even though their execution mechanisms differ, which is what
keeps the protocol controller-neutral.

### Profiles — `profiles/`, `runtime/core/profile.js`

Domain-neutral by construction. The default profile ships no opinion about what matters in your
work; the research profile adds an evidence-anchoring note; your profile owns the critical areas
and project anchors.

The split is deliberate. **Routing** (what deserves review) is consumed by the controller, which
can read files. **Project anchors** are consumed by the panel, which cannot — so they are compiled
in, with a hash of the source, and `doctor` reports when the two have drifted apart.

A project entry carries two different strings on purpose: `rules` may state your working
conclusions and goes to the Claude side only; `docs` gives only document *paths* and is what the
independent reviewer receives, so that it reads the source itself instead of inheriting a
conclusion.

### Skills — `skills/`

Turn a natural-language request into a route. They never bypass the driver, and they always defer
to an explicit request. Automatic routing stays off until the user's profile is customised.

## Boundaries this system does not cross

- It **never performs the action under review**: no deploying, deleting, submitting or publishing.
- The independent reviewer **cannot write anywhere**, including temporary directories.
- Telemetry, when enabled, records timing, waiting, mode and an exit category. Never content.
- Nothing is sent anywhere except to the model providers the user has already configured.
