// Regression suite for the driver (runtime/claude-controller/dual-audit-run.js).
//
// Mechanism: read the source, drop the `export`, wrap it in an AsyncFunction and inject
// stubs for the workflow runtime (workflow/agent/log/phase). The driver body is not
// modified. Mutation cases re-run the same assertion against a single-point mutant and
// require it to FAIL, which is what proves the assertion has teeth.
//
// Run: node tests/test_driver.mjs      (exit 0 = all green, 1 = failures)
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
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
// Derived, not hardcoded: the two builds spell their markers differently and share the prefix.
const LAUNCHM = RCM.replace(/_RC$/, '_LAUNCHED')
// The environment-variable prefix the build under test writes into its seat-params line (long seat).
const ENVP = process.env.DUAL_AUDIT_ENVP || 'DUAL_AUDIT'
const SRC0 = readFileSync(DRIVER, 'utf8').replace('export const meta', 'const meta')
const AF = Object.getPrototypeOf(async function () {}).constructor

// The wrapper writes __BRIEF_SHA256=<sha256 of the brief it fed the reviewer> on the line above every
// exit-code marker. The stub below does the same over the prompt the forwarder was handed, so a normal
// case looks like production. A case that supplies its own __BRIEF_SHA256 line is left untouched: that
// is how the refusal cases hand the driver a fingerprint of some other text.
const canonBrief = (t) => {
  const lines = String(t).split('\n').map(l => l.replace(/[ \t\r]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  while (lines.length && lines[0] === '') lines.shift()
  return lines.join('\n')
}
const shaOf = (t) => createHash('sha256').update(canonBrief(t), 'utf8').digest('hex')
const RCM_LINE = new RegExp('^([ \\t]*' + RCM + '=.*)$', 'gm')
const injectBriefSha = (text, prompt) => (typeof text !== 'string' || /__BRIEF_SHA256=/.test(text))
  ? text : text.replace(RCM_LINE, (line) => `__BRIEF_SHA256=${shaOf(prompt)}\n${line}`)

// A verdict block carrying the wrapper-injected exit-code marker.
const block = (rc, verdict = 'APPROVE') =>
  `VERDICT: ${verdict}\nP0: none\nEVIDENCE: read 3 files, 42 lines\nVERIFIED: pass\n${RCM}=${rc}\nEND`

/**
 * Run the driver against a scripted sequence of panel replies.
 * panelReplies: array consumed one per panel call (or a function of call index).
 * agentReply:   string returned as the reviewer stdout, or a function of call index.
 */
async function runDriver({ args = { task: 't' }, panelReplies = [], agentReply = '', mutate = null, injectSha = true } = {}) {
  const src = mutate ? mutate(SRC0) : SRC0
  const calls = { panel: 0, agent: 0 }
  const panelArgsSeen = []
  const agentPrompts = []   // what the forwarder was actually handed, byte for byte
  const workflow = async (_ref, callArgs) => {
    panelArgsSeen.push(callArgs)
    const i = calls.panel++
    const r = typeof panelReplies === 'function' ? panelReplies(i) : panelReplies[Math.min(i, panelReplies.length - 1)]
    if (r instanceof Error) throw r
    return r
  }
  const agent = async (prompt) => {
    agentPrompts.push(String(prompt))
    const i = calls.agent++
    const t = typeof agentReply === 'function' ? agentReply(i) : agentReply
    return { verdict_text: injectSha ? injectBriefSha(t, prompt) : t }
  }
  const fn = new AF('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'workflow', src)
  const r = await fn(args, agent, async (t) => Promise.all(t.map(x => x())), () => {}, () => {},
    { total: null, spent: () => 0, remaining: () => Infinity }, workflow)
  return { r, calls, panelArgsSeen, agentPrompts }
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

// 🔴 The fixture carries `audit_stage: 'escalate_to_user'` because THAT is what the panel actually emits
// alongside this status (panel: the identity-mismatch return sets both). The first version omitted the
// stage, and an independent sweep showed what that cost: with the two identity statuses deleted from
// INVALID_STATUSES the whole release gate stayed green, because a stage-less object falls through to the
// trailing fail-closed default, which also answers INVALID_AUDIT. The case passed for a reason other than
// the one it names (shape 4: reader-binding too loose). Against the REAL shape the escalation stage is read
// first and the same deletion yields NOT_CONVERGED - a refused, never-adjudicated state would then read as
// substantive reviewer disagreement, carrying findings inherited from the state that was just refused.
await t('A5 identity mismatch -> INVALID_AUDIT (in the shape the panel really emits: with the escalation stage)',
  (m) => runDriver({ panelReplies: [{ converged: false, audit_stage: 'escalate_to_user', convergence_status: 'prior_state_identity_mismatch', unresolved_p0: ['inherited from the refused state'] }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT',
  (s) => s.replace("  'prior_state_identity_mismatch', 'codex_verdict_identity_mismatch',\n", ''))

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

// A single-seat run converged on ONE reviewer with no cross-examination. Mapping it to plain
// CONVERGED made it machine-identical to a dual audit: the prose said "single seat" and nothing
// that branches reads prose.
await t('A11d a single-seat convergence does NOT map to CONVERGED',
  (m) => runDriver({ panelReplies: [{ converged: true, audit_stage: 'converged_r2',
    convergence_status: 'converged_single_seat' }], mutate: m }),
  (r) => r.terminal_state === 'CONVERGED_SINGLE_SEAT')

await t('A11e a real dual-audit convergence still maps to CONVERGED (or the fix just breaks approval)',
  (m) => runDriver({ panelReplies: [{ converged: true, audit_stage: 'converged_r2',
    convergence_status: 'converged' }], mutate: m }),
  (r) => r.terminal_state === 'CONVERGED')

// A refusal of a corrupt handshake adjudicated NOTHING. Every sibling prior_state_* abort is in
// INVALID_STATUSES; a new one that is not gets classified as a substantive non-convergence, and the
// consumer is then handed unresolved_p0 inherited verbatim from the state that was just refused.
// Adding a terminal status without enumerating its readers is how that happens.
await t('A11c a refused malformed prior ledger classifies as INVALID_AUDIT, like every sibling refusal',
  (m) => runDriver({ panelReplies: [{ converged: false, audit_stage: 'escalate_to_user',
    convergence_status: 'prior_state_findings_ledger_malformed' }], mutate: m }),
  (r) => r.terminal_state === 'INVALID_AUDIT' && r.converged === false)

// The findings ledger is monotonic INSIDE the panel, but the driver is what the caller actually
// reads: it rewrites the terminal object before handing it back. A field the panel keeps and the
// driver drops is indistinguishable, at the boundary, from a panel that never recorded it.
await t('A11b the findings ledger survives the driver boundary',
  (m) => runDriver({ panelReplies: [{ converged: true, convergence_status: 'converged',
    findings_ledger: [{ id: 'F1', text: 'zed.py:71 the retry loop never exits', round_raised: 1, status: 'not_restated' }] }], mutate: m }),
  (r) => Array.isArray(r.findings_ledger) && r.findings_ledger.length === 1
      && r.findings_ledger[0].id === 'F1' && r.findings_ledger[0].status === 'not_restated')

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

await t('B7 the wrapper announced a launch and nothing came back -> diagnosed as KILLED, never as "found nothing"',
  (m) => runDriver({ panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }],
                     agentReply: `${LAUNCHM}=540\n`, mutate: m }),
  // The whole point of the marker: this text and B8's text both lack a verdict, and before the marker
  // existed they were the SAME text (empty). They must now land on different codes, and this one must
  // still be infrastructure — a reviewer that was started and killed has judged nothing.
  (r, g) => !('codex_exit_code' in g.panelArgsSeen[1]) &&
            r.rc_diagnostics[0].code === 'LAUNCHED_BUT_NO_VERDICT' &&
            r.terminal_state === 'INFRASTRUCTURE_BLOCKED',
  // Teeth: with the launch branch removed it falls back to the old code, which is exactly the
  // ambiguity this change exists to remove.
  (src) => src.replace("          : launched ? 'LAUNCHED_BUT_NO_VERDICT'\n", ''))

await t('B8 no launch marker and no block still reads as NO_BLOCK_NO_MARKER (the new branch must not swallow it)',
  (m) => runDriver({ panelReplies: [PENDING, { converged: false, convergence_status: 'codex_unavailable' }],
                     agentReply: 'the reviewer said nothing useful\n', mutate: m }),
  (r, g) => r.rc_diagnostics[0].code === 'NO_BLOCK_NO_MARKER',
  // Teeth in the other direction: make the launch test always true and this case must go red. A
  // one-directional check would pass a detector that fires on everything.
  (src) => src.replace('const launched = LAUNCHED_RE.test(String(verdictText))',
                       'const launched = true'))

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

console.log('=== D. The long seat (codex_timeout_s) ===')
// The Bash tool's 600000 ms is a default, not a ceiling: the CLI computes max(BASH_MAX_TIMEOUT_MS,
// default). A caller passes codex_timeout_s and the driver prefixes the forwarder's task with one
// seat-params line. These cases pin the arithmetic, the pass-through, the refusal of bad values, and
// the launch-marker check that tells an applied long seat from one that silently ran on the default.
const HANDOFF = { audit_stage: 'r1_handoff_to_codex', codex_brief: 'BRIEF BODY', prior_state: { round: 1 } }
const DONE = { converged: true, convergence_status: 'converged', audit_stage: 'converged_r1' }
const withLaunch = (launched, rc = 0) => `${LAUNCHM}=${launched}\n` + block(rc)
const seatEntry = (r) => ((r && r.driver_trace) || []).find(x => x && x.long_seat)

await t('D1 codex_timeout_s prefixes the forwarder prompt with ONE seat-params line carrying the budget arithmetic',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(2400), mutate: m }),
  (r, g) => {
    const p = g.agentPrompts[0] || ''
    const lines = p.split('\n')
    return lines[0] === `<!-- dual-audit:seat-params timeout_ms=2460000 env="${ENVP}_TIMEOUT=2400 ${ENVP}_OUTER_BUDGET=2460" -->`
      && lines.slice(1).join('\n') === 'BRIEF BODY' && r.terminal_state === 'CONVERGED'
  },
  (s) => s.replace('const LANE_HEADROOM_S = 60', 'const LANE_HEADROOM_S = 0'))

await t('D2 without codex_timeout_s the forwarder prompt is exactly the brief (the default lane is untouched)',
  (m) => runDriver({ panelReplies: [HANDOFF, DONE], agentReply: block(0), mutate: m }),
  (r, g) => g.agentPrompts[0] === 'BRIEF BODY' && r.terminal_state === 'CONVERGED',
  (s) => s.replace("const sentText = seatParamsLine ? seatParamsLine + '\\n' + String(brief) : String(brief)",
                   "const sentText = seatParamsLine + '\\n' + String(brief)"))

// Present-with-a-bad-value is refused; only ABSENT selects the default. null, '' and blanks are bad values:
// a review showed the first version read them as omission, so a caller who wrote the key and left it empty
// silently got the 540 s seat and a converged result it would read as the long review it asked for.
for (const bad of ['abc', '100', '0', '-5', '2400.5', '99999999', '0540', '540', '599', '', '   ', null]) {
  await t(`D3 codex_timeout_s=${JSON.stringify(bad)} is refused as INVALID_AUDIT before the panel is ever called, not run on the default seat`,
    (m) => runDriver({ args: { task: 't', codex_timeout_s: bad }, panelReplies: [HANDOFF, DONE], agentReply: block(0), mutate: m }),
    (r, g) => r.terminal_state === 'INVALID_AUDIT' && r.converged === false && /codex_timeout_s/.test(r.error || '') && g.calls.panel === 0,
    bad === '599' ? (s) => s.replace('n < LANE_MIN_S ||', 'false ||')
    : bad === null ? (s) => s.replace("const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s')",
                                      "const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s') && a.codex_timeout_s != null")
    : bad === '   ' ? (s) => s.replace("const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s')",
                                       "const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s') && String(a.codex_timeout_s).trim() !== ''")
    : bad === '' ? (s) => s.replace("const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s')",
                                    "const seatKeyPresent = allReadableKeys(a).includes('codex_timeout_s') && a.codex_timeout_s !== ''")
    : bad === '540' ? (s) => s.replace('n < LANE_MIN_S ||', 'n < DEFAULT_SEAT_S ||')
    : undefined)
}

await t('D4 codex_timeout_s reaches the panel like every other caller key (it is part of the audit identity)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(2400), mutate: m }),
  (r, g) => g.panelArgsSeen[0].codex_timeout_s === 2400 && g.panelArgsSeen[1].codex_timeout_s === 2400,
  (s) => s.replace('  panelArgs.codex_timeout_s = n\n', '  delete panelArgs.codex_timeout_s\n'))

await t('D5 the launch marker confirms the long seat was applied (a clamp of up to 200 s is still applied)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(2200), mutate: m }),
  (r) => { const e = seatEntry(r); return !!e && e.long_seat.applied === true && e.long_seat.launched_s === 2200 && e.long_seat.requested_s === 2400 },
  (s) => s.replace('launched >= seatTimeoutS - LANE_CLAMP_TOLERANCE_S', 'launched >= seatTimeoutS'))

await t('D5b a shortfall beyond the clamp allowance is NOT applied (2199 for 2400)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(2199), mutate: m }),
  (r) => { const e = seatEntry(r); return !!e && e.long_seat.applied === false && e.long_seat.launched_s === 2199 },
  (s) => s.replace('const LANE_CLAMP_TOLERANCE_S = 200', 'const LANE_CLAMP_TOLERANCE_S = 201'))

await t('D6 a seat that ran on the default 540 s is reported NOT applied, while its verdict is still forwarded with its exit code',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(540), mutate: m }),
  (r, g) => { const e = seatEntry(r); return !!e && e.long_seat.applied === false && e.long_seat.launched_s === 540 && r.terminal_state === 'CONVERGED' && g.panelArgsSeen[1].codex_exit_code === 0 },
  (s) => s.replace('launched > DEFAULT_SEAT_S && launched >= seatTimeoutS - LANE_CLAMP_TOLERANCE_S', 'launched != null'))

// The review's exact case: the smallest request the lane accepts, and a seat that ignored the line. Under the
// first version (applied := launched >= floor(0.9*t)) this read as APPLIED, because floor(0.9*600) = 540.
await t('D9 t=600 with a seat that fell back to the default 540 is NOT applied (the 541..600 false-pass window is closed)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 600 }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(540), mutate: m }),
  (r) => { const e = seatEntry(r); return !!e && e.long_seat.applied === false && e.long_seat.launched_s === 540 && r.terminal_state === 'CONVERGED' },
  (s) => s.replace('launched > DEFAULT_SEAT_S &&', 'launched >= DEFAULT_SEAT_S &&'))

await t('D10 a seat that retried prints two markers; the LAST one is the one read (540 then 2400 -> applied)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: `${LAUNCHM}=540\n` + withLaunch(2400), mutate: m }),
  (r) => { const e = seatEntry(r); return !!e && e.long_seat.applied === true && e.long_seat.launched_s === 2400 },
  (s) => s.replace('while ((lm = LAUNCHED_VALUE_RE.exec(String(verdictText))) !== null) launched = parseInt(lm[1], 10)',
                   'if ((lm = LAUNCHED_VALUE_RE.exec(String(verdictText))) !== null) launched = parseInt(lm[1], 10)'))

await t('D11 the panel receives the parsed integer, not the caller\'s spelling (" 2400 " -> 2400)',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: ' 2400 ' }, panelReplies: [HANDOFF, DONE], agentReply: withLaunch(2400), mutate: m }),
  (r, g) => g.panelArgsSeen[0].codex_timeout_s === 2400 && r.terminal_state === 'CONVERGED',
  (s) => s.replace('  panelArgs.codex_timeout_s = n\n', '\n'))

await t('D7 no launch marker at all is reported as launched_s=null, applied=false — never as applied',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: block(0), mutate: m }),
  (r) => { const e = seatEntry(r); return !!e && e.long_seat.applied === false && e.long_seat.launched_s === null },
  (s) => s.replace('const applied = launched != null && launched > DEFAULT_SEAT_S && launched >= seatTimeoutS - LANE_CLAMP_TOLERANCE_S', 'const applied = true'))

await t('D8 without the key no long_seat entry is written (the diagnostic belongs only to the lane that asked)',
  (m) => runDriver({ panelReplies: [HANDOFF, DONE], agentReply: withLaunch(540), mutate: m }),
  (r) => !((r.driver_trace || []).some(x => x && x.long_seat)),
  (s) => s.replace('if (seatTimeoutS != null) {\n    let lm, launched = null', 'if (true) {\n    let lm, launched = null'))

// ── E. Brief fingerprint: the reviewer must have received exactly the text the driver dispatched ──
const withSha = (sha, rc = 0) => block(rc).replace(`\n${RCM}=`, `\n__BRIEF_SHA256=${sha}\n${RCM}=`)
const codes = (r) => ((r && r.rc_diagnostics) || []).map(d => d.code)

await t('E1 a verdict about some other text (fingerprint mismatch) is refused: no exit code reaches the panel',
  (m) => runDriver({ panelReplies: [HANDOFF, DONE], agentReply: withSha(shaOf('[Workflow harness — user request] ...\nBRIEF BODY')), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && !('codex_exit_code' in g.panelArgsSeen[1]) && codes(r).includes('BRIEF_MISMATCH'),
  (s) => s.replace('briefShaMismatch(verdictText, sentText)', 'null'))

await t('E2 a verdict with no fingerprint line is refused as BRIEF_SHA_MISSING, not misfiled as a marker problem',
  (m) => runDriver({ panelReplies: [HANDOFF, DONE], agentReply: block(0), injectSha: false, mutate: m }),
  (r, g) => g.panelArgsSeen[1] && !('codex_exit_code' in g.panelArgsSeen[1])
    && codes(r).includes('BRIEF_SHA_MISSING') && !codes(r).some(c => /^MARKER_|^NO_MARKER/.test(c)),
  (s) => s.replace('if (codexExitCode === null && !briefMismatch) {', 'if (codexExitCode === null) {'))

await t('E3 the fingerprint covers the seat-params line too: a hash of the brief alone is refused on a long seat',
  (m) => runDriver({ args: { task: 't', codex_timeout_s: 2400 }, panelReplies: [HANDOFF, DONE], agentReply: withSha(shaOf('BRIEF BODY')), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && !('codex_exit_code' in g.panelArgsSeen[1]) && codes(r).includes('BRIEF_MISMATCH'),
  (s) => s.replace("const sentText = seatParamsLine ? seatParamsLine + '\\n' + String(brief) : String(brief)",
                   "const sentText = seatParamsLine ? String(brief) : String(brief)"))

await t('E4 a correct fingerprint lets the exit code through unchanged',
  (m) => runDriver({ panelReplies: [HANDOFF, DONE], agentReply: withSha(shaOf('BRIEF BODY'), 0), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && g.panelArgsSeen[1].codex_exit_code === 0 && r.terminal_state === 'CONVERGED',
  (s) => s.replace('const want = sha256Hex(canonicalBrief(sent))', "const want = sha256Hex(canonicalBrief(sent + 'x'))"))

// Non-ASCII, written as escapes so this file stays ASCII: a 2-byte, a 3-byte, a 3-byte CJK and a 4-byte
// (surrogate pair) code point, plus a CR and trailing blanks the canonical form must drop. node's own
// crypto computes the stub's fingerprint; the driver's hand-written SHA-256 must agree with it.
const MB = 'caf\u00e9 \u2014 \u4e2d ' + String.fromCodePoint(0x1F600) + ' end  \r\nsecond\t\n'
await t('E5 multi-byte text, CR and trailing blanks: the driver\'s SHA-256 agrees with node crypto',
  (m) => runDriver({ panelReplies: [{ ...HANDOFF, codex_brief: MB }, DONE], agentReply: block(0), mutate: m }),
  (r, g) => g.panelArgsSeen[1] && g.panelArgsSeen[1].codex_exit_code === 0 && !codes(r).length,
  (s) => s.replace('c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++', 'i++'))

// E6. Cross-language, end to end: the fingerprint in each reply is computed by the WRAPPER's own
// _brief_sha (Python) on the same text, and the driver's SHA-256 (JS) must accept it on every
// canonicalisation edge. A disagreement would refuse a faithful forward as BRIEF_MISMATCH.
const WRAPPER = process.env.DUAL_AUDIT_WRAPPER || resolve(HERE, '../runtime/codex-auditor/dual-audit-codex')
const SHA_DIR = mkdtempSync(resolve(tmpdir(), 'brief-sha-'))
let shaN = 0
const wrapperSha = (text) => {
  const f = resolve(SHA_DIR, `b${shaN++}.txt`)
  writeFileSync(f, text, 'utf8')
  return execFileSync('bash', ['-c', 'source <(sed -n "/^_brief_sha(){/,/^}/p" "$1"); _brief_sha "$2"', '_', WRAPPER, f]).toString().trim()
}
const cp = (n) => String.fromCodePoint(n)
const EDGE = [
  'plain', '\n  \nlead blank lines', '\n\nblank edges\n\n\n', 'trailing blanks   \t\nnext',
  'crlf line\r\nnext\r\n', 'mid-line\rCR stays\nsecond', 'tab\tinside',
  'caf' + cp(0xe9) + ' ' + cp(0x2014) + ' ' + cp(0x4e2d) + ' ' + cp(0x1F600),
  'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(119),
  cp(0x4e2d).repeat(19), cp(0x1F600).repeat(14), 'a\n'.repeat(40) + 'end',
]
let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const ALPH = ['a', 'Z', ' ', '\t', '\n', '\r', cp(0xe9), cp(0x2014), cp(0x4e2d), cp(0x1F600), '0']
for (let k = 0; k < 24; k++) {
  let s = ''
  const n = 1 + Math.floor(rnd() * 90)
  for (let j = 0; j < n; j++) s += ALPH[Math.floor(rnd() * ALPH.length)]
  EDGE.push(s)
}
await t(`E6 the wrapper's own fingerprint (Python) and the driver's (JS) agree on all ${EDGE.length} edge texts`,
  async (m) => {
    const bad = []
    for (const v of EDGE) {
      const g = await runDriver({ panelReplies: [{ ...HANDOFF, codex_brief: v }, DONE], agentReply: withSha(wrapperSha(v), 0), mutate: m })
      if (!(g.panelArgsSeen[1] && g.panelArgsSeen[1].codex_exit_code === 0)) bad.push(JSON.stringify(v).slice(0, 40))
    }
    return { r: { bad } }
  },
  (r) => r.bad.length === 0,
  (s) => s.replace("l.replace(/[ \\t\\r]+$/, '')", "l.replace(/[ \\t]+$/, '')"))

console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
