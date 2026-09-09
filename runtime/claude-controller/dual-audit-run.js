// dual-audit:package-file (installed by dual-audit; ownership marker — do not remove)
export const meta = {
  name: 'dual-audit-run',
  description: 'Dual-audit driver: runs every round of the panel automatically and returns only the final result.',
  whenToUse: 'Anything that needs a dual audit. This is the ONLY entry point — do not start the Codex wrapper yourself, and do not invoke dual-audit-panel directly.',
  phases: [
    { title: 'Dual audit', detail: 'panel Claude side -> independent Codex side -> convergence check, looped until the panel returns a terminal state' },
  ],
}

// ═══════════════════════════════════════════════════════════════════════════
// Why this file exists
//
// dual-audit-panel.js is a PURE FUNCTION: one invocation runs one round of the
// Claude side, returns a codex_brief plus a prior_state, and exits. There is no
// background work and nothing self-driving. By design it NEEDS a driver to run
// the Codex side between rounds and feed the verdict back.
//
// When that driver is a human (or a model) shuttling state by hand, the handshake
// is skipped under load: the panel's "round 1, waiting for codex" hand-off gets
// reported as if it were the audit result, the Codex side never runs at all, and
// the dual audit silently collapses into a single-sided self-review. This file
// replaces the unreliable manual driver with a script. The panel itself is
// unchanged.
//
// IRON RULE: NEVER duplicate any of the panel's judgement here. Whether the audit
// converged, whether Codex should be retried, whether the round budget is spent —
// all of that is read from the panel's returned fields and nothing else. This file
// does exactly three things: call the panel, run Codex, and report back what it
// actually observed. It does not parse verdicts, count P0s, or add any "helpful"
// interpretation of its own.
// ═══════════════════════════════════════════════════════════════════════════

// Launch the panel by ABSOLUTE PATH, never by registered name. Name resolution can
// execute a CACHED copy of the workflow, so a hardened driver can end up driving a
// stale panel — and a stale panel converges on state the current one would refuse.
// A path read from disk on every call has no cache to be wrong, which makes this a
// mechanical rather than a remembered safeguard.
// The installer rewrites the placeholder below with the real installed path.
const PANEL = { scriptPath: '__DUAL_AUDIT_PANEL_PATH__' }

// Runaway backstop, NOT a round limit. The real round and budget limits belong to
// the panel (roundsAllowed, HARD_TOTAL_CEILING, MAX_CODEX_UNAVAIL). This only stops
// the loop if the panel keeps returning "still waiting for codex" forever.
// Three rounds normally need four calls; each codex retry adds one, so 8 leaves room.
const MAX_PANEL_CALLS = 8

// The panel's handshake keys. The driver generates these per round; they must never
// be forwarded from the caller's arguments or two audits would cross-contaminate.
const HANDSHAKE_KEYS = ['prior_state', 'codex_prev_verdict_raw', 'codex_exit_code']

// ---------------------------------------------------------------------------
// TERMINAL STATES — the four classes this system exposes to a caller.
//
// Only CONVERGED may be described as "the review passed". Every other state means
// the review did not complete, and an UNRECOGNISED panel state is deliberately
// mapped to INVALID_AUDIT rather than to anything that could read as approval.
// ---------------------------------------------------------------------------
const CONVERGED = 'CONVERGED'
const CONVERGED_SINGLE_SEAT = 'CONVERGED_SINGLE_SEAT'
const NOT_CONVERGED = 'NOT_CONVERGED'
const INFRASTRUCTURE_BLOCKED = 'INFRASTRUCTURE_BLOCKED'
const INVALID_AUDIT = 'INVALID_AUDIT'

// A required reviewer or runtime facility was unavailable: nothing was judged.
const INFRA_STATUSES = ['codex_unavailable', 'prior_state_missing_brief']
// Identity, state, schema or argument validation failed: the audit is not trustworthy.
const INVALID_STATUSES = [
  'prior_state_identity_mismatch', 'codex_verdict_identity_mismatch',
  'prior_state_malformed', 'orphan_codex_verdict', 'prior_state_round_invalid',
  'prior_state_run_id_mismatch', 'prior_state_budget_invalid',
  'prior_state_legacy_worker_format', 'prior_state_schema_invalid',
  'prior_state_frozen_r1_missing',
  'prior_state_findings_ledger_malformed',
]
// The panel ran to the end of its round budget with substantive disagreement, or the
// reviewers agreed but could not anchor a claim and asked for human sign-off.
const NOT_CONVERGED_STATUSES = ['not_converged']

function terminalStateOf(res) {
  if (!res || typeof res !== 'object') return INFRASTRUCTURE_BLOCKED
  const status = String(res.convergence_status == null ? '' : res.convergence_status)
  const stage = String(res.audit_stage == null ? '' : res.audit_stage)
  // CONVERGED requires agreement from THREE independent signals, not just the boolean:
  //   - converged === true
  //   - the panel is not simultaneously asking for a human (needs_expert_signoff)
  //   - the status actually SAYS converged
  // The current panel never emits a contradictory combination, so this is defence in depth
  // rather than a live defect. It is here because this function is the fail-closed classifier
  // for the whole system: if a future panel version ever emits `converged: true` alongside an
  // error status, the answer must be "I cannot classify this", never "approved".
  // ORDER MATTERS. Every DISQUALIFYING signal is checked BEFORE the approval, so that a result
  // carrying both cannot be read as a pass. Putting the approval first meant an object with
  // `converged: true` alongside an `error`, or alongside an escalation stage, returned CONVERGED
  // — the approval was read before anything that contradicted it.
  if (res.error) return INVALID_AUDIT
  if (INVALID_STATUSES.indexOf(status) >= 0) return INVALID_AUDIT
  if (INFRA_STATUSES.indexOf(status) >= 0) return INFRASTRUCTURE_BLOCKED
  // A result asking for a human is a substantive outcome, not a broken one, so it is reported as
  // NOT_CONVERGED with its detail intact — never as a completed review.
  if (res.needs_expert_signoff === true) return NOT_CONVERGED
  if (stage === 'escalate_to_user') return NOT_CONVERGED

  // Only now may an approval be considered, and it must be UNAMBIGUOUS: the boolean and the status
  // must both say so. An empty or absent status is NOT accepted — the panel always sets it on the
  // converging path, so a missing one means this object did not come from that path.
  if (res.converged === true) {
    if (status === 'converged') return CONVERGED
    // 🔴 A single-seat run converged on ONE reviewer with no cross-examination. Mapping it to
    // CONVERGED made it machine-identical to a dual audit, so a consumer branching on
    // terminal_state or converged drew a stronger assurance than the run supports -- the prose
    // said "single seat" but nothing that branches reads prose.
    if (status === 'converged_single_seat') return CONVERGED_SINGLE_SEAT
    return INVALID_AUDIT
  }
  if (NOT_CONVERGED_STATUSES.indexOf(status) >= 0) return NOT_CONVERGED
  // Unknown state: fail closed. A state we cannot classify is not an approval.
  return INVALID_AUDIT
}

// Attach the terminal state to whatever the panel returned, without rewriting it.
function finish(res, extra) {
  const base = (res && typeof res === 'object') ? res : {}
  const out = { ...base, ...extra }
  out.converged = base.converged === true && base.needs_expert_signoff !== true
  out.terminal_state = extra && extra.terminal_state ? extra.terminal_state : terminalStateOf(base)
  if (out.terminal_state !== CONVERGED) out.converged = false
  return out
}

// args may arrive as an OBJECT or as a JSON STRING depending on the harness. This
// normalisation is copied from the panel so both sides read one input identically.
// Getting it wrong is not subtle: treating a JSON string as the task text drops
// contextPack/kind/risk entirely and the panel then fails closed on a missing pack.
let a
if (typeof args === 'string') {
  const s = args.trim()
  if (s[0] === '{') { try { const p = JSON.parse(s); a = (p && typeof p === 'object') ? p : { task: args } } catch (e) { a = { task: args } } }
  else a = { task: args }
} else a = (args && typeof args === 'object') ? args : {}

// ── Oversized arguments: report them honestly, do not refuse ─────────────────
// A large argument object can be dropped WHOLE by the host before this script runs. What then
// surfaces is not "your payload was too big" but "a required field is missing", which sends the
// caller off to ADD arguments — growing the payload that was already the problem. The loop is
// expensive and reads as a schema error from beginning to end.
//
// This does two things, both of which are just better reporting:
//  (a) "the payload never arrived" and "it arrived without a task" become DIFFERENT messages.
//      Collapsing them into one 'missing task' is what pointed the wrong way in the first place.
//  (b) every size-related message states the measured size, so the caller can see for themselves
//      how close they are rather than guessing.
//
// WHY THERE IS NO HARD REFUSAL HERE, AND WHY ONE SHOULD NOT BE ADDED WITHOUT NEW MEASUREMENT:
// an earlier version of this patch refused anything over 2048. It was removed before release,
// for a reason worth keeping written down:
//
//   * The size is measured with `JSON.stringify(...).length`, i.e. in UTF-16 code units. For Latin
//     text that equals the byte count. For CJK text it is about one THIRD of it (measured: 2.95x).
//     So a single threshold means two very different things depending on who is calling, and the
//     author's own payloads were the CJK kind.
//   * The cliff itself is anecdotal. It comes from one incident in one operator's log. An
//     independent reviewer tried to reproduce a genuine whole-payload drop and could not, and the
//     unit it lives in (bytes or UTF-16 units) was never established either.
//
// A refusal calibrated in an unconfirmed unit against an unreproduced failure cannot be shown to
// prevent the thing it names, but will certainly block callers who did nothing wrong. The
// asymmetry runs the opposite way from most gates in this project: here a false refusal is the
// expensive outcome and the failure being prevented costs only a confusing message — which (a)
// already fixes. Establish the unit and reproduce the drop first; then a refusal can be argued for.
const ARGS_SOFT = 1024
const argsSize = (() => { try { return JSON.stringify(a || {}).length } catch (e) { return -1 } })()
const MOVE_TO_BRIEF = 'Put the long material (brief, file lists, quoted sources) in a brief file and '
  + 'pass only its path, keeping args small. Do NOT add more arguments.'

if (typeof args === 'undefined' || args === null) {
  return {
    converged: false, terminal_state: INVALID_AUDIT, rc_diagnostics: [],
    error: 'No arguments arrived at all. This is usually NOT a missing field — the whole payload '
         + `failed to parse, and one known cause is that it was too large. ${MOVE_TO_BRIEF}`,
  }
}

if (!a.task || !String(a.task).trim()) {
  // rc_diagnostics is an empty array rather than absent, so every exit has the same
  // shape and a caller can read the field unconditionally.
  return {
    converged: false, terminal_state: INVALID_AUDIT, rc_diagnostics: [],
    error: `missing \`task\` — say what is being reviewed. (This call carried ${argsSize} UTF-16 `
         + `units; if that is large, suspect size before a missing field: ${MOVE_TO_BRIEF})`,
  }
}

// NOTE: cannot push to `trace` here — it is declared further down and would hit the TDZ.
// Advisory only. It never changes what runs, so a wrong threshold costs one extra line of output.
const argsSizeNote = argsSize > ARGS_SOFT
  ? `args is ${argsSize} UTF-16 units (${ARGS_SOFT}+). Not a problem by itself, but oversized `
    + `payloads can be dropped whole by the host before this script sees them, and the error you `
    + `would then get names a missing field instead. ${MOVE_TO_BRIEF}`
  : null

// Forward EVERY caller argument except the three handshake keys. The panel's
// fingerprint binds all arguments except those, so an allowlist here would drop
// arguments the panel still reads — and two different audits would then share one
// identity.
//
// The key enumeration must use the SAME rule as the panel: for...in (enumerable own
// and inherited) plus getOwnPropertyNames along the prototype chain (non-enumerable
// inherited). Object.keys sees only own enumerable properties, so the panel would
// fingerprint values the driver never forwarded.
const PROTO_STOP = [Object.prototype, Array.prototype, Function.prototype, Map.prototype, Set.prototype, Date.prototype, RegExp.prototype]
const allReadableKeys = (o) => {
  const keys = []
  for (const k in o) if (keys.indexOf(k) < 0) keys.push(k)
  let cur = o
  while (cur && PROTO_STOP.indexOf(cur) < 0) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === 'constructor' || keys.indexOf(k) >= 0) continue
      keys.push(k)
    }
    cur = Object.getPrototypeOf(cur)
  }
  return keys
}
const panelArgs = {}
for (const k of allReadableKeys(a)) {
  if (!HANDSHAKE_KEYS.includes(k)) panelArgs[k] = a[k]
}

// ── Long seat (the second lane) ──────────────────────────────────────────────
// The Bash tool's 600000 ms is NOT a hard ceiling: the CLI computes max = max(BASH_MAX_TIMEOUT_MS,
// default), so a machine that sets that variable in its settings env can hold a seat open longer.
// A caller opts in with `codex_timeout_s` (seconds the reviewer may run). The driver then prefixes the
// reviewer's task text with ONE machine-readable line; the forwarder reads its timeout and wrapper
// budget from that line (see the agent definition). The panel is not touched, and without the key the
// prompt handed to the forwarder is byte-identical to what it was before this lane existed.
//
// Budget arithmetic, defined ONCE here and mirrored by the tests:
//   wrapper TIMEOUT = t      wrapper OUTER_BUDGET = t + 60      Bash timeout_ms = (t + 60) * 1000
//   the wrapper keeps KILL_AFTER(30) + BUDGET_SLACK(10) out of the 60 s headroom, so its pre-steps
//   (stdin snapshot, lock wait, credential write) may use 20 s before _clamp_timeout starts shortening
//   t; either way the wrapper times out FIRST, at least BUDGET_SLACK before the harness, and stays loud.
// 🔴 Whether THIS machine has raised the cap is not decided here: a workflow script cannot read the
//    environment. The wrapper decides (under CLAUDECODE=1 a budget above BASH_MAX_TIMEOUT_MS is refused
//    with rc=8 before anything starts), so a misconfigured lane fails loudly instead of being killed
//    into an empty stdout.
const SEAT_PARAMS_TOKEN = 'dual-audit:seat-params'
const SEAT_ENV_PREFIX = 'DUAL_AUDIT'
const DEFAULT_SEAT_S = 540    // the wrapper's own TIMEOUT default; test_agentdef.sh pins this to the wrapper's real value
// 🔴 The smallest accepted request must EXCEED the default seat. A review found the gap: with t=600 and the
//    old relative tolerance, a seat that ignored the line and ran the default 540 s read as applied, because
//    floor(0.9*600) = 540. Below 600 the lane buys nothing anyway; at 600 and above the strict '> default'
//    test below separates an applied long seat from an ignored line with no overlap.
const LANE_MIN_S = 600
const LANE_MAX_S = 86340      // the wrapper's own TIMEOUT ceiling (86400) minus the headroom below
const LANE_HEADROOM_S = 60
// The wrapper may trim TIMEOUT by what its own pre-steps consumed: stdin snapshot (<= 120 s), slot or lock
// wait (<= 20 s), credential write (<= 30 s). An absolute allowance covers that mechanism at every t; a
// percentage did not (too loose at large t, too tight at small t).
const LANE_CLAMP_TOLERANCE_S = 200
let seatTimeoutS = null
// Present-or-absent, not truthy-or-falsy: a key that is there with null, '' or blanks is a malformed request
// and is refused like any other bad value. Only a key that is ABSENT selects the default seat.
const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s')
if (seatKeyPresent) {
  const raw = a.codex_timeout_s == null ? String(a.codex_timeout_s) : String(a.codex_timeout_s).trim()
  const n = /^[1-9][0-9]{0,6}$/.test(raw) ? parseInt(raw, 10) : NaN
  if (!Number.isInteger(n) || n < LANE_MIN_S || n > LANE_MAX_S) {
    // Refused, never silently reduced to the default: a caller who asked for a long seat and got the
    // short one would read a 540 s verdict as the long review it requested.
    return {
      converged: false, terminal_state: INVALID_AUDIT, rc_diagnostics: [],
      error: `codex_timeout_s='${raw}' is not valid: an integer number of seconds between ${LANE_MIN_S} and ${LANE_MAX_S}`
           + ' (omit the key entirely for the default 540 s seat; null, empty and blank count as malformed).'
           + ' Refused rather than falling back to the default.',
    }
  }
  seatTimeoutS = n
  // The panel fingerprints every caller key; hand it the parsed integer, not the caller's spelling of it.
  panelArgs.codex_timeout_s = n
}
const seatParamsLine = seatTimeoutS == null ? '' :
  `<!-- ${SEAT_PARAMS_TOKEN} timeout_ms=${(seatTimeoutS + LANE_HEADROOM_S) * 1000}`
  + ` env="${SEAT_ENV_PREFIX}_TIMEOUT=${seatTimeoutS} ${SEAT_ENV_PREFIX}_OUTER_BUDGET=${seatTimeoutS + LANE_HEADROOM_S}" -->`

// ============================================================================
// Exit-code extraction. THE ONLY SOURCE is the marker the wrapper writes INSIDE
// the VERDICT..END block.
//
// The caller of a review agent sees only text on stdout; it cannot observe the
// process exit code. Asking the forwarding agent to print `$?` after the block does
// not work: forwarders routinely truncate output at `END`, the line disappears, and
// nothing reports that it did. A driver that then "infers" a zero is guessing the
// single value that opens the gate — a Codex run killed mid-flight still leaves a
// complete-looking APPROVE block on stdout, and only exit code 0 lets the panel
// converge on it.
//
// Two self-reported fields from the same model are NOT two sources: one model can
// report both consistently and be consistently wrong. So the source itself changed:
// the wrapper — the only party that actually holds `$?` — writes the marker INTO the
// verdict block. The block is payload the panel must already parse verbatim, so a
// marker that goes missing BREAKS PARSING LOUDLY instead of vanishing silently.
//
// Honest boundary: a language model is still structurally in the path, because a
// workflow agent can only return text. This does not eliminate that; it converts a
// silent failure into a loud one. Forgery remains out of scope — the panel detects
// MIS-THREADING, not forgery.
// ============================================================================
const RC_IN_BLOCK_RE = /^[ \t]*__DUAL_AUDIT_RC=(-?\d+)[ \t]*$/gm
// Same block pattern the panel uses: line-anchored, with END alone on its own line
// (so the phrase "end-to-end" in prose is not a terminator).
const BLOCK_RE = /^[ \t]*VERDICT:[\s\S]*?^[ \t]*END[ \t]*$/gm
// The wrapper writes this the instant before it hands control to the reviewer, so that a run
// killed part-way is DISTINGUISHABLE from one that never started. Without it both produced an
// empty stdout, and no amount of care downstream can separate two identical signals.
const LAUNCHED_RE = /^[ \t]*__DUAL_AUDIT_LAUNCHED=/m
// Same marker, value captured: the seconds the wrapper actually granted the reviewer (long-seat check).
const LAUNCHED_VALUE_RE = /^[ \t]*__DUAL_AUDIT_LAUNCHED=([0-9]+)[ \t]*$/gm   // /g: the LAST marker is read (a retried seat prints two)

// Take the LAST VERDICT..END block (the panel picks the same one) and require
// EXACTLY ONE marker inside it. Zero means the marker was dropped or the wrapper ran
// without --emit-rc; more than one is ambiguous. Both return null, and the panel
// then applies its own fail-closed "codex unavailable" rule.
function rcInsideVerdictBlock(text) {
  const s = String(text == null ? '' : text)
  BLOCK_RE.lastIndex = 0
  const blocks = []
  let b
  while ((b = BLOCK_RE.exec(s)) !== null) blocks.push(b[0])
  if (!blocks.length) return null
  const last = blocks[blocks.length - 1]
  RC_IN_BLOCK_RE.lastIndex = 0
  const hits = last.match(RC_IN_BLOCK_RE)
  if (!hits || hits.length !== 1) return null
  const n = /(-?\d+)/.exec(hits[0])
  return n ? parseInt(n[1], 10) : null
}

// NOTE: there is deliberately no "trim the reply down to the verdict region" step.
// Trimming to the last END also deletes a TRUNCATED TAIL after it, which is exactly
// what the panel's tail guard needs to see: `[complete APPROVE][END][truncated REJECT
// carrying a late blocker]` must fail closed, and a trimmed reply leaves only the
// clean APPROVE — a silent false convergence. The driver forwards the reviewer's text
// VERBATIM and never reshapes it.

let priorState = null
let codexPrevRaw = null
let codexExitCode = null
let calls = 0
// One diagnostic per round where the in-block marker could not be read; returned with
// the final result so nobody has to dig through logs to find out where it went.
const rcDiagnostics = []
let lastPanelResult = null
const trace = []
if (argsSizeNote) trace.push(argsSizeNote)

phase('Dual audit')

while (calls < MAX_PANEL_CALLS) {
  calls++

  // -- 1. Call the panel ----------------------------------------------------
  const call = { ...panelArgs }
  if (priorState) {
    call.prior_state = priorState
    call.codex_prev_verdict_raw = codexPrevRaw
    // Contract: supplying a verdict REQUIRES supplying its exit code. A MISSING code
    // means "reviewer unavailable". Pass it only when it was actually observed.
    if (codexExitCode !== null) call.codex_exit_code = codexExitCode
  }

  let res
  try {
    res = await workflow(PANEL, call)
  } catch (e) {
    return finish(lastPanelResult, {
      terminal_state: INFRASTRUCTURE_BLOCKED, audit_stage: 'driver_error', panel_calls: calls,
      blockers: [`panel invocation failed: ${String((e && e.message) || e)}`],
      recommended_next_action: 'The panel itself did not run. This is not an audit result.',
      panel_last: lastPanelResult, driver_trace: trace, rc_diagnostics: rcDiagnostics,
    })
  }

  if (!res || typeof res !== 'object') {
    return finish(lastPanelResult, {
      terminal_state: INFRASTRUCTURE_BLOCKED, audit_stage: 'driver_error', panel_calls: calls,
      blockers: ['panel returned nothing, or a non-object — treated as failure, never as a pass'],
      panel_last: lastPanelResult, driver_trace: trace, rc_diagnostics: rcDiagnostics,
    })
  }
  lastPanelResult = res
  trace.push({
    call: calls, audit_stage: res.audit_stage,
    convergence_status: res.convergence_status, converged: res.converged === true,
  })

  // -- 2. Panel reached a terminal state: hand it back unchanged ------------
  // The only test is the panel's own fields: anything that is not "waiting for codex"
  // is terminal (converged, escalated, arguments refused, or budget exhausted).
  const stage = String(res.audit_stage || '')
  const status = String(res.convergence_status || '')
  // Compatible read: both the new _handoff_to_codex and the old _pending_codex are accepted,
  // otherwise an unsynced panel copy or a replayed old record is misread as "the panel is finished".
  const HANDOFF_RE = /_(handoff_to|pending)_codex$/
  const waitingForCodex = HANDOFF_RE.test(stage) || HANDOFF_RE.test(status) ||
                          stage === 'codex_retry_pending' || status === 'codex_retry_pending'
  if (!waitingForCodex) {
    return finish(res, { panel_calls: calls, driver_trace: trace, rc_diagnostics: rcDiagnostics })
  }

  // -- 3. Panel is waiting for codex: run the independent side ---------------
  const brief = res.codex_brief
  if (!brief || !String(brief).trim()) {
    return finish(res, {
      terminal_state: INFRASTRUCTURE_BLOCKED, audit_stage: 'driver_error', panel_calls: calls,
      blockers: ['panel is waiting for codex but produced no codex_brief — cannot continue, and not a pass'],
      panel_last: res, driver_trace: trace, rc_diagnostics: rcDiagnostics,
    })
  }

  let out = null
  try {
    // The brief already carries its own sentinel contract (rawSourceBrief and
    // sharedCodexBrief each call sentinelContract), so it is forwarded as-is and
    // never wrapped in another layer.
    //
    // The schema exists ONLY to guarantee that verdict_text is a verbatim string.
    // Do NOT add exit-code fields here. A model can report them consistently wrongly,
    // and two self-reported fields are not two sources. The only exit-code source is
    // rcInsideVerdictBlock above.
    out = await agent(seatParamsLine ? seatParamsLine + '\n' + String(brief) : String(brief), {
      agentType: 'dual-audit-codex-readonly',
      label: `codex-ro:call${calls}`,
      phase: 'Dual audit',
      schema: {
        type: 'object',
        required: ['verdict_text'],
        properties: {
          verdict_text: {
            type: 'string',
            description: 'The reviewer stdout, copied verbatim: do not rewrite, abbreviate or summarise it. '
              + 'It MUST contain the complete VERDICT..END block, and the __DUAL_AUDIT_RC= line inside that '
              + 'block must be preserved exactly — the wrapper wrote it, and removing it makes this audit fail.',
          },
        },
      },
    })
  } catch (e) {
    out = null
  }

  // Exit code: the only source is the in-block marker written by the wrapper's
  // --emit-rc. Unreadable -> null -> not forwarded -> the panel applies its own
  // fail-closed "unavailable" rule. There is no single-source fallback.
  let verdictText = ''
  if (out && typeof out === 'object' && typeof out.verdict_text === 'string') {
    verdictText = out.verdict_text
  } else if (typeof out === 'string') {
    verdictText = out
  }
  // The marker line is NOT stripped: the driver forwards verdict text verbatim. The
  // panel treats it as one unparsed note plus a warning; the block stays valid.
  codexExitCode = rcInsideVerdictBlock(verdictText)
  // 🔴 When one reviewer attempt fails and a later one succeeds, the earlier diagnostic must be
  //    marked SUPERSEDED. Measured incident: a round ran the reviewer twice - the first attempt was
  //    killed by a caller-imposed wall-clock ceiling and emitted only a forwarder status report (no
  //    END, no marker), the second returned a complete verdict with both. The final result therefore
  //    carried "no VERDICT..END block and no marker" alongside a panel advisory reporting the marker
  //    it had just read. Both statements were true and about DIFFERENT attempts, but side by side
  //    they read as a contradiction: the caller concluded the reviewer had never run and reported the
  //    round as a one-sided self-audit, then had to correct that.
  //    ⚠️ The parser was never wrong. The good verdict had its END and its marker, and BLOCK_RE
  //    matched it. What was wrong is that a record describing ONE ATTEMPT was phrased as if it
  //    described the round. A diagnostic that cannot say which attempt it is about will be read as a
  //    conclusion about all of them.
  if (codexExitCode !== null) {
    for (const d of rcDiagnostics) {
      if (d.superseded_by_call == null) {
        d.superseded_by_call = calls
        d.why = `[superseded by call${calls}; NOT this round's outcome] ${d.why}`
      }
    }
  }
  codexPrevRaw = verdictText
  // Long seat: the wrapper announces the TIMEOUT it really granted (__DUAL_AUDIT_LAUNCHED=<s>) the instant it
  // hands over control. Compare it with what was asked for, so a seat that ignored the seat-params line
  // and ran on the default 540 s is SEEN rather than assumed. Diagnostic only, never a rewrite of the
  // verdict: a complete verdict produced on the default budget is still a verdict, it just did not use
  // the extra time. Two conditions, both required:
  //   launched > DEFAULT_SEAT_S        — the default lane can never announce more than 540 (its TIMEOUT
  //                                      defaults to 540 and clamping only lowers it), so this alone
  //                                      separates an applied long seat from an ignored line;
  //   launched >= t - CLAMP_TOLERANCE  — the wrapper trims by its pre-steps at most; a bigger shortfall
  //                                      means the seat was not given what was asked.
  // The marker read is the LAST one in the text: a seat that retried prints one per attempt.
  if (seatTimeoutS != null) {
    let lm, launched = null
    LAUNCHED_VALUE_RE.lastIndex = 0
    while ((lm = LAUNCHED_VALUE_RE.exec(String(verdictText))) !== null) launched = parseInt(lm[1], 10)
    const applied = launched != null && launched > DEFAULT_SEAT_S && launched >= seatTimeoutS - LANE_CLAMP_TOLERANCE_S
    trace.push({ call: calls, long_seat: { requested_s: seatTimeoutS, launched_s: launched, applied } })
    if (!applied) log(`call${calls}: long seat NOT applied — asked for ${seatTimeoutS}s, wrapper announced ${launched == null ? 'no __DUAL_AUDIT_LAUNCHED line' : launched + 's'}; the verdict is forwarded as usual but the extra time was not used`)
  }

  if (codexExitCode === null) {
    // Diagnostics must travel in the RETURN VALUE, not only in a log line. The first
    // time this mechanism shipped, one code path failed to inject the marker and every
    // round failed closed, while the panel result said only "codex produced no
    // trustworthy verdict" — locating the cause meant reading run journals.
    // The classification is computed PER BLOCK, not "does the marker appear anywhere":
    // when an earlier block carries the marker and the last one does not, a whole-text
    // test reports "not inside a verdict block" and sends the reader after the wrapper,
    // when the real cause is a reviewer printing several blocks inconsistently.
    const blocks = String(verdictText).match(BLOCK_RE) || []
    const nBlocks = blocks.length
    const countMarkers = (s) => (String(s).match(RC_IN_BLOCK_RE) || []).length
    const inLast = nBlocks ? countMarkers(blocks[nBlocks - 1]) : 0
    const inAnyBlock = blocks.reduce((n, b) => n + countMarkers(b), 0)
    const anywhere = /__DUAL_AUDIT_RC=/.test(String(verdictText))
    // No `g` flag on LAUNCHED_RE, deliberately: a /g/ regex carries lastIndex between .test() calls
    // and would answer differently on the second identical question.
    const launched = LAUNCHED_RE.test(String(verdictText))
    // 🔴 `code` is the STABLE machine-readable identifier; `why` is the human sentence.
    //    They are separate because asserting on prose is a known weak-assertion trap: reword the
    //    sentence and the test fails while the behaviour is unchanged, and translate it and every
    //    such test goes red at once. That is not hypothetical — it is exactly what happened when
    //    this suite was first pointed at a copy whose diagnostics were written in another language.
    //    Once a code is published it is a contract: never change a literal, only add new ones.
    const code = !verdictText
      ? 'EMPTY_VERDICT_TEXT'
      : nBlocks === 0
        ? (anywhere ? 'MARKER_WITHOUT_BLOCK'
          : launched ? 'LAUNCHED_BUT_NO_VERDICT'
          : 'NO_BLOCK_NO_MARKER')
      : inLast > 1 ? 'MARKER_AMBIGUOUS_IN_LAST_BLOCK'
      : inLast === 1 ? 'MARKER_UNREADABLE_INTERNAL_INCONSISTENCY'
      : inAnyBlock > 0 ? 'MARKER_IN_EARLIER_BLOCK'
      : anywhere ? 'MARKER_OUTSIDE_ANY_BLOCK'
      : 'NO_MARKER_ANYWHERE'
    const why = !verdictText
      ? 'verdict_text is empty — the reviewer produced no output, or the agent call failed'
      : nBlocks === 0
        ? (anywhere
          ? 'a marker is present but there is no VERDICT..END block — the reviewer produced no verdict (the marker is the wrapper\'s fallback append)'
          : launched
          ? 'the wrapper announced the launch and then nothing came back — the reviewer WAS started and did not finish. '
            + 'It was killed from outside (a caller wall-clock ceiling shorter than the reviewer needs is the common cause; '
            + 'set DUAL_AUDIT_OUTER_BUDGET to the real ceiling, and give the command itself the longest timeout the caller allows). '
            + 'This is infrastructure, NOT a review that found nothing'
          // ⚠️ Three causes, not one. An earlier version named only the last, which a reviewer showed
          //    is false for the first: a run killed while WAITING for a slot or the serial lock has
          //    legitimately announced nothing yet, and sending the reader after --emit-rc points them
          //    at a flag that was set correctly.
          : 'no VERDICT..END block and no marker at all — the run never got as far as launching a reviewer. '
            + 'Either it was killed while still queueing for a slot or the serial lock, or it was refused '
            + 'during setup (check stderr and the wrapper exit code), or the wrapper did not run with --emit-rc')
      : inLast > 1
        ? `${inLast} markers inside the last block — ambiguous, refused fail-closed`
      : inLast === 1
        ? 'exactly one marker inside the last block yet no value could be read — extraction and diagnosis disagree about the same text; inspect rcInsideVerdictBlock'
      : inAnyBlock > 0
        ? `the marker is in an EARLIER block and not in the last one (${nBlocks} blocks) — the reviewer printed its verdict more than once with inconsistent injection, or the last block was appended afterwards`
      : anywhere
        ? 'a marker exists but is NOT inside any verdict block — most likely the wrapper did not take the --emit-rc injection path '
          + '(check: does the agent definition pass --emit-rc; did it fall back to serial mode; is the forwarder using an old command template)'
      : 'no marker inside or outside any block — the wrapper ran without --emit-rc, or the output was truncated by the forwarder'
    // Long seat: a wrapper refusal BEFORE launch (rc=8: declared budget above the harness cap, or above the
    // wrapper's own 86400 s ceiling) leaves no stdout and lands in these two codes. The refusal text names the
    // numbers and is on stderr, which the forwarder appends only when no verdict came back.
    const whyLane = (seatTimeoutS != null && (code === 'EMPTY_VERDICT_TEXT' || code === 'NO_BLOCK_NO_MARKER'))
      ? why + ` [long seat ${seatTimeoutS}s was requested: a wrapper refusal before launch (rc=8, budget above the harness cap or the wrapper ceiling) looks exactly like this — read verdict_text_tail for the wrapper's own message]`
      : why
    rcDiagnostics.push({
      call: calls, code, blocks: nBlocks,
      markers_in_last_block: inLast, markers_in_any_block: inAnyBlock,
      marker_present_anywhere: anywhere,
      // One record describes ONE attempt. null = nothing has superseded it yet; the loop above fills
      // this in with the call number as soon as some later attempt does return a usable exit code.
      superseded_by_call: null,
      // The evidence the classification rests on, so a reader can check it without opening journals.
      verdict_text_len: String(verdictText).length,
      verdict_text_tail: String(verdictText).slice(-160),
      why: `call${calls}: ${whyLane}`,
    })
    log(`call${calls}: no __DUAL_AUDIT_RC inside the verdict block — not forwarded, so the panel will treat the reviewer as unavailable. Reason: ${why}`)
  }

  // The driver does NOT retry on its own. Whether to retry is the panel's decision
  // (MAX_CODEX_UNAVAIL / codex_retry_pending); adding a second retry policy here would
  // duplicate panel logic and break the iron rule above. Empty output is forwarded
  // as-is and judged by the panel.
  priorState = res.prior_state || null
  if (!priorState) {
    return finish(res, {
      terminal_state: INFRASTRUCTURE_BLOCKED, audit_stage: 'driver_error', panel_calls: calls,
      blockers: ['panel is waiting for codex but returned no prior_state — cannot start the next round'],
      panel_last: res, driver_trace: trace, rc_diagnostics: rcDiagnostics,
    })
  }
}

// Runaway backstop: the call ceiling was reached and the panel never reached a
// terminal state. The last panel result MUST be carried out whole, or its blockers,
// advisories and unresolved P0s all disappear at the exact moment they matter.
return finish(lastPanelResult, {
  terminal_state: INFRASTRUCTURE_BLOCKED,
  audit_stage: 'escalate_to_user',
  convergence_status: 'driver_call_cap_reached',
  panel_calls: calls,
  blockers: [
    `driver call ceiling of ${MAX_PANEL_CALLS} reached while the panel was still not terminal (this is a runaway backstop, not an audit result)`,
    ...((lastPanelResult && lastPanelResult.blockers) || []),
  ],
  recommended_next_action: 'The panel kept returning "pending", which is abnormal. Hand the panel\'s last result and this record to the user.',
  driver_trace: trace,
  rc_diagnostics: rcDiagnostics,
})
