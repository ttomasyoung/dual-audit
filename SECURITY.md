# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a
vulnerability" on the Security tab) so a fix can be prepared before details are public.

Useful in a report: what an attacker can achieve, the conditions required, and — if you have one —
a minimal reproduction. A description of a weakness with no path to consequence is still welcome;
just say which part is demonstrated and which is inferred.

## What this project does with your data

- Content is sent **only** to the model providers you have already configured: Anthropic through
  Claude Code, OpenAI through the Codex CLI. This project adds no service, endpoint or account of
  its own, and performs no network access outside those tools.
- **Telemetry is disabled by default.** When enabled it records timing, queue wait, mode and an
  exit category. It never records a brief, argv, a path, an environment value, or anything derived
  from a token — including remaining token lifetime, which would reveal when it was issued.
- Nothing is written outside your home directory, the per-user runtime directory, and the private
  temporary directories created per run.

## The isolation model

Most reviews run in **parallel mode**, with:

- a **private, temporary reviewer home** created per run and removed on exit, including on handled
  signals;
- **credentials copied with the refresh token removed**, written mode `0600`;
- an **empty HOME** and a **neutral working directory**, so directory-based configuration
  discovery cannot inject instructions into the reviewer;
- an **early snapshot of the brief** taken from stdin into a unique private file, which closes the
  window in which a shared path could be overwritten between write and read;
- a **bounded slot semaphore and lock**, with every control-plane path checked for symlinks and
  ownership before use, so another account cannot pre-create them to hang or deny service;
- a **per-uid runtime directory**, mode 0700.

The reviewer runs strictly read-only and cannot write anywhere, including temporary directories.
The Claude side may write only inside a directory it creates fresh for that purpose.

### The exception: serial mode

When the stored access token is close to expiry, a review cannot run in parallel mode, because a
private throwaway home has no way to renew a credential and every concurrent run would try to renew
at once. The wrapper falls back to **serial mode**, and two of the properties above are traded away
deliberately:

- the home is a **single shared directory**, not a per-run temporary one;
- the **refresh token is kept**, because renewing the credential is the entire reason this mode
  exists.

Both are held under an exclusive lock, so exactly one review runs at a time and the renewal happens
once. The reviewer is still read-only, and the credential file is still mode `0600`. If you would
rather a review fail than run this way, re-authenticate before starting, or run the preflight check
— it refuses a batch rather than letting one degrade into serial.

**The audit system never performs the action under review.** It does not deploy, delete, submit,
publish, or otherwise execute the thing it is reviewing.

## Threat model, stated honestly

What this system **does** defend against:

- **Cross-session contamination.** Two reviews running at once cannot read each other's briefs or
  merge each other's verdicts. This is the failure the isolation and the audit identity exist for.
- **Silent infrastructure failure being read as approval.** Empty output, a timeout, a nonzero
  exit, a missing exit code, a malformed verdict — each is a distinct failure, and none can become
  a pass.
- **Stale or foreign state being merged into an audit.** State and verdicts are bound to an audit
  identity that covers every caller argument.

What it **does not** defend against, and does not claim to:

- **Forgery.** The audit identity detects mis-threading, not authorship. A reviewer that copies the
  id can assert anything, and nothing here proves which model produced a piece of text. Preventing
  that would require the harness to store or sign the state, which is outside this project.
- **A compromised local account.** Everything runs as you, with your credentials. The path
  guards raise the cost of one user interfering with another on a shared machine; they are not a
  sandbox against your own account.
- **A hostile reviewer that is competent.** An adversarial model would simply return a compliant,
  well-formed, false APPROVE. The gates catch malformed, truncated and misidentified output — that
  is, **failure**, not deception.
- **The correctness of a claim.** The system checks that a claim was anchored to something
  checkable, and escalates when it was not.

## Known operational hazard

Aborting a run by signalling the wrapper's child can look like success: the reviewer frequently
exits gracefully on TERM and returns 0, and the wrapper faithfully reports the child's status. If
you need "aborted" to be distinguishable from "completed", the party sending the signal must record
it out of band.
