// Regression suite for the driver (runtime/claude-controller/dual-audit-run.js).
//
// Mechanism: read the source, drop the `export`, wrap it in an AsyncFunction and inject
// stubs for the workflow runtime (workflow/agent/log/phase). The driver body is not
// modified. Mutation cases re-run the same assertion against a single-point mutant and
// require it to FAIL, which is what proves the assertion has teeth.
//
// Run: node tests/test_driver.mjs      (exit 0 = all green, 1 = failures)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Both the file under test and the marker name are overridable so that ONE suite can be pointed at a
// differently-named build of the same driver. Without this the suite silently only ever covered the
// copy sitting next to it, and a second deployed copy could drift arbitrarily with nothing to notice:
// pointing this suite at such a copy for the first time turned up a whole classification layer that
// had never been ported. A test that can only reach one of two live copies is half a test.
const DRIVER = process.env.DUAL_AUDIT_DRIVER || resolve(HERE, '../runtime/claude-controller/dual-audit-run.js')
const RCM = process.env.DUAL_AUDIT_RC_MARKER || '__DUAL_AUDIT_RC'
const SRC0 = readFileSync(DRIVER, 'utf8').replace('export const meta', 'const meta')
const AF = Object.getPrototypeOf(async function () {}).constructor

// A verdict block carrying the wrapper-injected exit-code marker.
const block = (rc, verdict = 'APPROVE') =>
  `VERDICT: ${verdict}\nP0: none\nEVIDENCE: read 3 files, 42 lines\nVERIFIED: pass\n${RCM}=${rc}\nEND`

/**
 * Run the driver against a scripted sequence of panel replies.
 * panelReplies: array consumed one per panel call (or a function of call index).
 * agentReply:   string returned as the reviewer stdout, or a function of call index.
 */
async function runDriver({ args = { task: 't' }, panelReplies = [], agentReply = '', mutate = null } = {}) {
  const src = mutate ? mutate(SRC0) : SRC0
  const calls = { panel: 0, agent: 0 }
  const panelArgsSeen = []
  const workflow = async (_ref, callArgs) => {
    panelArgsSeen.push(callArgs)
    const i = calls.panel++
    const r = typeof panelReplies === 'function' ? panelReplies(i) : panelReplies[Math.min(i, panelReplies.length - 1)]
    if (r instanceof Error) throw r
    return r
  }
  const agent = async () => {
    const i = calls.agent++
    const t = typeof agentReply === 'function' ? agentReply(i) : agentReply
    return { verdict_text: t }
  }
  const fn = new AF('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'workflow', src)
  const r = await fn(args, agent, async (t) => Promise.all(t.map(x => x())), () => {}, () => {},
    { total: null, spent: () => 0, remaining: () => Infinity }, workflow)
  return { r, calls, panelArgsSeen }
}

let pass = 0, fail = 0
const rec = (ok, name, why) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  << ' + why}`) }

async function t(name, run, check, mutant) {
  let got
  try { got = await run() } catch (e) { rec(false, name, 'threw: ' + e.message); return }
  const ok = check(got.r, got)
  rec(ok, name, `terminal_state=${got.r && got.r.terminal_state} converged=${got.r && got.r.converged}`)
  if (mutant) {
    // A mutation whose anchor no longer matches the source silently becomes a NO-OP, and a no-op
    // mutant always "survives" — which reads as "this assertion has no teeth" when the real cause
    // is that the mutation never happened. Worse, the opposite reading is possible too: someone
    // edits the source, every mutant quietly stops mutating, and the suite still reports green.
    // So an unmatched anchor is a LOUD failure of its own.
    if (mutant(SRC0) === SRC0) {
      rec(false, name + ' [mut]', 'mutation anchor did not match the source — the mutant is a no-op, so this proves nothing')
      return
    }
    let mr
    try { mr = await run(mutant) } catch (e) { rec(true, name + ' [mut]', ''); return }
    const stillOk = check(mr.r, mr)
    rec(!stillOk, name + ' [mut]', 'mutant still satisfies the assertion — the check has no teeth')
  }
}

console.log('=== A. Terminal-state mapping ===')

const PENDING = { audit_stage: 'r1_pending_codex', codex_brief: 'brief text', prior_state: { round: 1 } }

await t('A1 converged panel -> CONVERGED',
  (m) => runDriver({ panelReplies: [{ converged: true, convergence_status: 'converged', audit_stage: 'converged_r1' }], mutate: m }),
  (r) => r.terminal_state === 'CONVERGED' && r.converged === true)

await t('A2 escalate_to_user -> NOT_CONVERGED',
  (m) => runDriver({ panelReplies: [{ converged: false, audit_stage: 'escalate_to_user', convergence_status: 'not_converged', blockers: ['x'] }], mutate: m }),
  (r) => r.terminal_state === 'NOT_CONVERGED' && r.converged === false)

await t('A3 converged BUT needs_expert_signoff -> NOT_CONVERGED (never reported as a pass)',
  (m) => runDriver({ panelReplies: [{ converged: true, needs_expert_signoff: true, convergence_status: 'converged' }], mutate: m }),
  (r) => r.terminal_state === 'NOT_CONVERGED' && r.converged === false,
  (s) => s.replace('if (res.needs_expert_signoff === true) return NOT_CONVERGED',
                   'if (false) return NOT_CONVERGED'))

// Three signals must agree before anything is called CONVERGED. The panel does not currently emit
// this combination, so the case is defence in depth: if a future version ever pairs an approval
// with an error status, the answer must be "I cannot classify this", not "approved".
// The status here is one no list recognises, so the earlier fail-closed branches do NOT fire and
// this really does exercise the approval branch. Using a KNOWN error status instead would be
// caught earlier by defence in depth, and the mutant would survive for the wrong reason.
await t('A3b converged:true with an UNRECOGNISED status -> INVALID_AUDIT, never CONVERGED',
  (m) => runDriver({ panelReplies: [{ converged: true, convergence_status: 'a_status_no_list_knows' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT' && r.converged === false,
  (s) => s.replace("if (status === 'converged') return CONVERGED", 'return CONVERGED'))

// Branch ORDER is the property under test here: a disqualifying signal must be read BEFORE the
// approval, or an object carrying both is reported as a pass.
await t('A3c converged:true carrying an `error` -> INVALID_AUDIT (the error is read first)',
  (m) => runDriver({ panelReplies: [{ converged: true, convergence_status: 'converged', error: 'rejected' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT' && r.converged === false,
  (s) => s.replace('  if (res.error) return INVALID_AUDIT\n', '\n'))

await t('A3d converged:true carrying an escalation stage -> NOT_CONVERGED',
  (m) => runDriver({ panelReplies: [{ converged: true, convergence_status: 'converged', audit_stage: 'escalate_to_user' }], mutate: m }),
  (r) => r.terminal_state === 'NOT_CONVERGED' && r.converged === false,
  (s) => s.replace("  if (stage === 'escalate_to_user') return NOT_CONVERGED\n", '\n'))

await t('A3e converged:true with NO status -> INVALID_AUDIT (the panel always sets it when it converges)',
  (m) => runDriver({ panelReplies: [{ converged: true }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT' && r.converged === false,
  (s) => s.replace("if (status === 'converged') return CONVERGED", "if (status === 'converged' || status === '') return CONVERGED"))

await t('A4 codex_unavailable -> INFRASTRUCTURE_BLOCKED',
  (m) => runDriver({ panelReplies: [{ converged: false, convergence_status: 'codex_unavailable', audit_stage: 'escalate_to_user' }], mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED',
  (s) => s.replace("const INFRA_STATUSES = ['codex_unavailable', 'prior_state_missing_brief']",
                   "const INFRA_STATUSES = ['prior_state_missing_brief']"))

await t('A5 identity mismatch -> INVALID_AUDIT',
  (m) => runDriver({ panelReplies: [{ converged: false, convergence_status: 'prior_state_identity_mismatch' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT')

// The fixture deliberately carries BOTH an `error` and an escalation stage. With only
// the trailing fail-closed default, such a result would be classified NOT_CONVERGED —
// i.e. "the reviewers disagreed" — when in fact the panel refused the arguments and
// judged nothing. The dedicated `error` branch is what keeps those two apart, so the
// mutant must die on this case and not on the simpler one.
await t('A6 a result carrying `error` is INVALID_AUDIT even when another field suggests escalation',
  (m) => runDriver({ panelReplies: [{ converged: false, error: 'CONTEXT-PACK INCOMPLETE', audit_stage: 'escalate_to_user' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT',
  (s) => s.replace('if (res.error) return INVALID_AUDIT', 'if (false) return INVALID_AUDIT'))

await t('A6b plain argument rejection (error, no other field) -> INVALID_AUDIT',
  (m) => runDriver({ panelReplies: [{ converged: false, error: 'CONTEXT-PACK INCOMPLETE' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT')

await t('A7 UNKNOWN panel status -> INVALID_AUDIT (fail closed, never CONVERGED)',
  (m) => runDriver({ panelReplies: [{ converged: false, convergence_status: 'something_new_we_never_saw' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT',
  (s) => s.replace('  // Unknown state: fail closed. A state we cannot classify is not an approval.\n  return INVALID_AUDIT',
                   '  return CONVERGED'))

await t('A8 panel throws -> INFRASTRUCTURE_BLOCKED',
  (m) => runDriver({ panelReplies: [new Error('boom')], mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED' && r.converged === false)

await t('A9 panel returns a non-object -> INFRASTRUCTURE_BLOCKED',
  (m) => runDriver({ panelReplies: ['not an object'], mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED' && r.converged === false)

await t('A10 pending but no codex_brief -> INFRASTRUCTURE_BLOCKED',
  (m) => runDriver({ panelReplies: [{ audit_stage: 'r1_pending_codex', prior_state: { round: 1 } }], mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED')

await t('A11 pending but no prior_state -> INFRASTRUCTURE_BLOCKED',
  (m) => runDriver({ panelReplies: [{ audit_stage: 'r1_pending_codex', codex_brief: 'b' }], agentReply: block(0), mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED')

await t('A12 panel never terminal -> call cap -> INFRASTRUCTURE_BLOCKED, panel content preserved',
  (m) => runDriver({ panelReplies: [{ ...PENDING, blockers: ['open issue from the last round'] }], agentReply: block(0), mutate: m }),
  (r) => r.terminal_state === 'INFRASTRUCTURE_BLOCKED' && r.panel_calls === 8 &&
         (r.blockers || []).some(b => /open issue from the last round/.test(b)))

await t('A13 empty task -> INVALID_AUDIT before any panel call',
  (m) => runDriver({ args: { task: '   ' }, panelReplies: [{ converged: true }], mutate: m }),
  (r, g) => r.terminal_state === 'INVALID_AUDIT' && g.calls.panel === 0 && Array.isArray(r.rc_diagnostics))

console.log('=== B. Exit-code marker extraction ===')

await t('B1 marker inside the last block is forwarded to the panel',
  (m) => runDriver({ panelReplies: [PENDING, { converged: true, convergence_status: 'converged' }], agentReply: block(0), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && g.panelArgsSeen[1].codex_exit_code === 0 && r.terminal_state === 'CONVERGED')

await t('B2 nonzero exit code is forwarded verbatim (never normalised to 0)',
  (m) => runDriver({ panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }], agentReply: block(137), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && g.panelArgsSeen[1].codex_exit_code === 137)

await t('B3 marker OUTSIDE any block -> not forwarded + diagnostic',
  (m) => runDriver({
    panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }],
    agentReply: `VERDICT: APPROVE\nP0: none\nEVIDENCE: 1 file\nVERIFIED: pass\nEND\n${RCM}=0`, mutate: m }),
  (r, g) => g.panelArgsSeen[1] && !('codex_exit_code' in g.panelArgsSeen[1]) &&
            r.rc_diagnostics.length === 1 && r.rc_diagnostics[0].code === 'MARKER_OUTSIDE_ANY_BLOCK')

await t('B4 two markers in the last block -> ambiguous, not forwarded',
  (m) => runDriver({
    panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }],
    agentReply: `VERDICT: APPROVE\nP0: none\nEVIDENCE: 2 files\nVERIFIED: pass\n${RCM}=0\n${RCM}=137\nEND`, mutate: m }),
  (r, g) => !('codex_exit_code' in g.panelArgsSeen[1]) && r.rc_diagnostics[0].code === 'MARKER_AMBIGUOUS_IN_LAST_BLOCK')

await t('B5 marker only in an EARLIER block -> diagnosed as inconsistent injection, not as a missing wrapper',
  (m) => runDriver({
    panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }],
    agentReply: block(0) + '\n' + 'VERDICT: APPROVE\nP0: none\nEVIDENCE: 9 lines\nVERIFIED: pass\nEND', mutate: m }),
  (r, g) => !('codex_exit_code' in g.panelArgsSeen[1]) && r.rc_diagnostics[0].code === 'MARKER_IN_EARLIER_BLOCK',
  (s) => s.replace('const inLast = nBlocks ? countMarkers(blocks[nBlocks - 1]) : 0',
                   'const inLast = nBlocks ? countMarkers(blocks.join("\\n")) : 0'))

await t('B6 empty reviewer output -> not forwarded, diagnosed, never a pass',
  (m) => runDriver({ panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }], agentReply: '', mutate: m }),
  (r, g) => !('codex_exit_code' in g.panelArgsSeen[1]) && r.rc_diagnostics[0].code === 'EMPTY_VERDICT_TEXT' &&
            r.terminal_state === 'INFRASTRUCTURE_BLOCKED')

console.log('=== C. Verbatim forwarding and argument threading ===')

await t('C1 a truncated tail after END is forwarded UNCHANGED (the panel tail guard must see it)',
  (m) => runDriver({
    panelReplies: [PENDING, { converged: false, convergence_status: 'not_converged', audit_stage: 'escalate_to_user' }],
    agentReply: block(0) + '\nVERDICT: REJECT\nP0: late blocker found', mutate: m }),
  (r, g) => /VERDICT: REJECT\nP0: late blocker found$/.test(g.panelArgsSeen[1].codex_prev_verdict_raw))

await t('C2 caller-supplied handshake keys are NOT forwarded (they would cross-thread two audits)',
  (m) => runDriver({
    args: { task: 't', project: 'p', prior_state: { round: 3 }, codex_exit_code: 0, codex_prev_verdict_raw: 'x' },
    panelReplies: [{ converged: true, convergence_status: 'converged' }], mutate: m }),
  (r, g) => g.panelArgsSeen[0].project === 'p' && !('prior_state' in g.panelArgsSeen[0]) &&
            !('codex_exit_code' in g.panelArgsSeen[0]) && !('codex_prev_verdict_raw' in g.panelArgsSeen[0]))

await t('C3 every other caller argument IS forwarded (the panel fingerprint binds them all)',
  (m) => runDriver({
    args: { task: 't', kind: 'code', risk: 'high', mode: 'deep', run_id: 'r1', contextPack: { targets: ['/a'] } },
    panelReplies: [{ converged: true, convergence_status: 'converged' }], mutate: m }),
  (r, g) => ['kind', 'risk', 'mode', 'run_id', 'contextPack'].every(k => k in g.panelArgsSeen[0]))

await t('C4 args arriving as a JSON STRING are parsed, not treated as the task text',
  (m) => runDriver({ args: JSON.stringify({ task: 'real task', kind: 'code' }),
                     panelReplies: [{ converged: true, convergence_status: 'converged' }], mutate: m }),
  (r, g) => g.panelArgsSeen[0].task === 'real task' && g.panelArgsSeen[0].kind === 'code')

await t('C5 a later round converging still reports CONVERGED and keeps the trace',
  (m) => runDriver({
    panelReplies: [PENDING, { ...PENDING, audit_stage: 'r2_pending_codex', prior_state: { round: 2 } },
                   { converged: true, convergence_status: 'converged', audit_stage: 'converged_r2' }],
    agentReply: block(0), mutate: m }),
  (r) => r.terminal_state === 'CONVERGED' && r.panel_calls === 3 && r.driver_trace.length === 3)

// Backward-compatible read of the renamed status. The risk of a rename is not "the new name is not
// recognised" - that fails loudly at once - but "the OLD name is silently treated as a terminal
// state": an unsynced panel copy or a replayed old record takes that path, and it presents as "the
// panel has reached a conclusion", which looks exactly like real convergence. So this is the
// good-example-not-falsely-rejected side of the calibration and it must not be dropped.
await t('C6 the old r1_pending_codex still counts as a handoff (compat read; misreading it as terminal collapses the panel to one side silently)',
  (m) => runDriver({
    panelReplies: [{ audit_stage: 'r1_pending_codex', codex_brief: 'brief text', prior_state: { round: 1 } },
                   { converged: true, convergence_status: 'converged', audit_stage: 'converged_r1' }],
    agentReply: block(0), mutate: m }),
  (r) => r.terminal_state === 'CONVERGED' && r.panel_calls === 2,
  (s) => s.replace('/_(handoff_to|pending)_codex$/', '/_(handoff_to)_codex$/'))

// C7/C8 exist because a reader misread a real run. Two reviewer attempts happened in one round: the
// first was killed by a caller-imposed wall-clock ceiling and returned only a forwarder status report,
// the second returned a complete verdict. The result then carried "no VERDICT..END block and no
// marker" next to a panel advisory quoting the marker it had just read, and that pair was read as a
// self-contradiction meaning "the reviewer never ran". Nothing was wrong with the parser; the record
// simply never said which attempt it described. C8 is the other half of the calibration: a diagnostic
// that genuinely was never superseded must NOT be labelled as superseded.
const FORWARDER_STATUS = 'FORWARDER STATUS: the reviewer process was killed by the caller before it produced a verdict. No VERDICT block exists.'

await t('C7 a failed attempt diagnostic is marked SUPERSEDED once a later attempt returns a verdict',
  (m) => runDriver({
    panelReplies: [{ audit_stage: 'r1_handoff_to_codex', codex_brief: 'b', prior_state: { round: 1 } },
                   { audit_stage: 'r2_handoff_to_codex', codex_brief: 'b', prior_state: { round: 2 } },
                   { converged: true, convergence_status: 'converged', audit_stage: 'converged_r2' }],
    agentReply: (i) => (i === 0 ? FORWARDER_STATUS : block(0)), mutate: m }),
  (r) => {
    const d = r.rc_diagnostics || []
    return d.length === 1 && d[0].call === 1 && d[0].superseded_by_call === 2 &&
      /superseded by call2/.test(d[0].why) && /call1:/.test(d[0].why)
  },
  (s) => s.replace('if (d.superseded_by_call == null) {', 'if (false) {'))

await t('C8 a diagnostic that was never superseded keeps superseded_by_call null (good example not mislabelled)',
  (m) => runDriver({
    panelReplies: [{ audit_stage: 'r1_handoff_to_codex', codex_brief: 'b', prior_state: { round: 1 } },
                   { converged: false, convergence_status: 'not_converged', audit_stage: 'escalate_to_user', blockers: ['x'] }],
    agentReply: FORWARDER_STATUS, mutate: m }),
  (r) => {
    const d = r.rc_diagnostics || []
    return d.length === 1 && d[0].superseded_by_call === null && !/superseded/.test(d[0].why)
  },
  (s) => s.replace('superseded_by_call: null,', 'superseded_by_call: 1,'))

await t('C9 the diagnostic carries the evidence it judged, so the reader need not open a journal',
  (m) => runDriver({
    panelReplies: [{ audit_stage: 'r1_handoff_to_codex', codex_brief: 'b', prior_state: { round: 1 } },
                   { converged: false, convergence_status: 'not_converged', audit_stage: 'escalate_to_user', blockers: ['x'] }],
    agentReply: FORWARDER_STATUS, mutate: m }),
  (r) => {
    const d = (r.rc_diagnostics || [])[0] || {}
    return d.verdict_text_len === FORWARDER_STATUS.length && /No VERDICT block exists\.$/.test(d.verdict_text_tail || '')
  },
  (s) => s.replace('verdict_text_tail: String(verdictText).slice(-160),', 'verdict_text_tail: null,'))

console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
