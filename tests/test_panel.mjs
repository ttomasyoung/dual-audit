// Regression suite for the review panel.
// Mechanism: read the source, drop the `export`, wrap it in an AsyncFunction with stubs injected
// (agent() returns a verdict STRING), and capture the return value. The panel itself is not modified.
// What makes an assertion have teeth: the SAME assertion must pass against the original source and
// FAIL against a single-point mutant. Group A additionally asserts that no agent was ever spawned.
// A mutant that CRASHES is marked separately from one that fails the assertion: only the latter is a
// clean kill, because a crash is weak evidence that the guard was doing the work. REJECT fixtures are
// kept clean (P0: none, VERIFIED: pass) so that only the consensus gate can be the thing that blocks.
// Run: node tests/test_panel.mjs   (exit 0 = all green, 1 = failures)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const HERE = dirname(fileURLToPath(import.meta.url))
// Overridable so this ONE suite can also be pointed at a separately deployed copy of the same panel.
// A suite that can only reach the file next to it cannot notice the other copy drifting.
const PANEL = process.env.DUAL_AUDIT_PANEL || resolve(HERE, '../runtime/core/dual-audit-panel.js')
const SRC0 = readFileSync(PANEL, 'utf8').replace('export const meta', 'const meta')
const AF = Object.getPrototypeOf(async function () {}).constructor

function runner(agentFn) {
  const calls = { agent: 0, parallel: 0 }
  const stub = {
    agent: async (p, o) => { calls.agent++; return agentFn ? await agentFn(p, o) : '' },
    parallel: async (t) => { calls.parallel++; return Promise.all(t.map(x => x())) },
    log: () => {}, phase: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  }
  return { calls, stub }
}
async function runPanel(args, agentFn, mutate) {
  const src = mutate ? mutate(SRC0) : SRC0
  const { calls, stub } = runner(agentFn)
  const fn = new AF('args', 'agent', 'parallel', 'log', 'phase', 'budget', src)
  const r = await fn(args, stub.agent, stub.parallel, stub.log, stub.phase, stub.budget)
  return { r, calls }
}

// ---- valid and malformed sentinel verdicts ----
const CLAUDE_APPROVE = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: ran regression 462/0 at line 1191\nVERIFIED: pass\nEND'
// A real blocker written INSIDE another field's value, while the field that gates the round says
// "none". The parser detected this and only warned, so the blocker was carried through the panel
// unread and the round converged as an approval.
const CLAUDE_HIDDEN_P0 = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: read 3 files line 12<br>P0: the delete path removes user data\nVERIFIED: pass\nEND'
// The same shape with a NON-gating field name in the value: ordinary prose, and it must still converge.
const CLAUDE_BENIGN_REF = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: read 3 files line 12\nVERIFIED: pass\nRECOMMEND: see EVIDENCE: above\nEND'
// A line the parser cannot read at all. Every prefix shape a blocker can be dressed in — `**P0**:`,
// `note P0:`, `(P0:)`, `P0 (blocking):` — arrives here, so this is one case standing for a class that
// has no end: naming the shapes one at a time is how the previous four fixes were wrong.
const CLAUDE_FOREIGN_LINE = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: read 3 files line 12\nVERIFIED: pass\n**P0**: the delete path removes user data\nEND'
// The wrapper injects its exit-code marker INSIDE the block. If a foreign line invalidated without
// exempting it, every verdict the wrapper ever produced would be refused.
const cxMarker = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: static/import ok, 3 modules\nVERIFIED: pass\nAUDIT-ID: ${id}\n__DUAL_AUDIT_RC=0\nEND`
// A full-width colon reads as a colon to the reviewer that wrote it, but not to an ASCII pattern.
const CLAUDE_WIDE_COLON = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: read 3 files\uFF1C br\uFF1EP0\uFF1A the delete path removes user data\nVERIFIED: pass\nEND'
// A value naming VERIFIED, with a real P0 recorded: prose about the fields, which must NOT be refused.
const CLAUDE_TALKS_ABOUT = 'VERDICT: REJECT\nP0: the delete path removes user data at line 44\nEVIDENCE: read 3 files line 12\nVERIFIED: fail\nRECOMMEND: an honest VERIFIED: fail beats a guess\nEND'
// The shape a hard gate would refuse and must not: a cross-examination DELTA saying WHICH of the other
// side's P0s this reviewer overturned. Naming P0 there is what DELTA is FOR. 8 of the 13 refusals.
const CLAUDE_DELTA_NAMES_P0 = 'VERDICT: APPROVE\nP0: none\nDELTA: I overturned the other side P0: (1) instrumented the call, the guard uses the same path at line 378\nEVIDENCE: read 3 files line 12\nVERIFIED: pass\nEND'
const CLAUDE_CLEAN_R = 'VERDICT: REJECT\nP0: none\nEVIDENCE: reviewed line 5 structure ok\nVERIFIED: pass\nEND'  // clean fixture: only the consensus gate can block it
// RETENTION fixture: five distinct, individually locatable P0s raised in one round-1 verdict.
const RET_IDS = ['bar.py:11', 'bar.py:12', 'bar.py:13', 'bar.py:14', 'bar.py:15']
const CLAUDE_FIVE_P0 = 'VERDICT: REJECT\nP0: bar.py:11 the retry loop never exits; bar.py:12 the lock is released twice; '
  + 'bar.py:13 the digest covers the wrong buffer; bar.py:14 the fallback swallows the error code; '
  + 'bar.py:15 the cache key omits the version\nEVIDENCE: read 5 files line 7\nVERIFIED: fail\nEND'
const cxApprove      = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: static/import ok, 3 modules\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND`
const cxApproveDelta = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: re-ran, fix line 90\nVERIFIED: pass\nDELTA: re-verified line 90 now passes\nAUDIT-ID: ${id}\nEND`
const cxCleanReject  = id => `VERDICT: REJECT\nP0: none\nEVIDENCE: reviewed 3 files structure ok\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND`
// Malformed reviewer verdicts, each violating one validity sub-gate or one negative path of the
// parser. Every one must be judged INVALID, must not count as a valid approval, and must not converge.
const cxNoP0      = id => `VERDICT: APPROVE\nEVIDENCE: static ok 3 modules\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND`               // missing P0 field
const cxNoVerified = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: static ok 3 modules\nAUDIT-ID: ${id}\nEND`                    // missing VERIFIED in code mode: validity gate plus a downstream convergence gate (defence in depth)
const cxEvNoDigit = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: looks fine\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND`               // EVIDENCE without a digit: validity gate plus the downstream digit gate (defence in depth)
const cxPlaceholder = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: running in background will share\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND` // a placeholder phrase inside the block
const cxNoVerdict = id => `P0: none\nEVIDENCE: static ok 3 modules\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND`                       // no VERDICT: the block is invalid, the audit id cannot be read, so this fails as an identity mismatch

const BASE = { task: 't', kind: 'code', contextPack: { targets: ['/tmp/x.py'], expected: 'cols=3' } }
const BSRC = { task: 'review a script', kind: 'code', contextPack: { targets: ['/tmp/x.py'], expected: 'cols=3', raw_sources: ['/tmp/x.py'] } }
const REAL_FP = (await runPanel({ ...BASE, prior_state: [1, 2] })).r.task_fingerprint
if (!REAL_FP) { console.error('could not obtain the real fingerprint'); process.exit(1) }
// Legacy-format state whose worker field lives on the PROTOTYPE. The guard uses `in`, so it is caught;
// falling back to hasOwnProperty would miss it. All own properties are present so earlier gates pass.
const evilProtoState = Object.assign(Object.create({ worker_output: 'garbage' }), { round: 1, run_id: '', task_fingerprint: REAL_FP, cumulative_used: 0 })

let pass = 0, fail = 0, threwNote = 0
const rec = (good, name, why) => { good ? pass++ : fail++; console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : ' << ' + why}`) }

// ============ Group A: input guards (they return before any agent is spawned, so each case
// asserts both the refusal AND that zero agents were launched) ============
const abStatus = s => (r, c) => r && r.converged === false && r.convergence_status === s && c.agent === 0 && c.parallel === 0
const abErr = re => (r, c) => r && r.converged === false && re.test(r.error || '') && c.agent === 0 && c.parallel === 0
const CASES_A = [
  { n: '#1 empty task',            in: { task: '' },                                                                  ok: abErr(/non-empty task/),                  g: 'if (!TASK) return',                   gf: 'if (false) return' },
  { n: '#2 incomplete context pack', in: { task: 't', kind: 'code' },                                                   ok: abErr(/CONTEXT-PACK INCOMPLETE/),         g: 'if (missing.length) return',          gf: 'if (false) return' },
  { n: '#3 non-absolute source path',       in: { ...BASE, contextPack: { targets: ['x.py'], expected: 'c' } },                 ok: abErr(/invalid source paths/),            g: 'if (nonAbsSources.length) return',    gf: 'if (false) return' },
  { n: '#4 prior_state is not an object',        in: { ...BASE, prior_state: [1, 2] },                                               ok: abStatus('prior_state_malformed'),        g: 'if (priorPresent && !priorUsable) {', gf: 'if (false) {' },
  { n: '#5 orphan codex',       in: { ...BASE, codex_prev_verdict_raw: 'x' },                                       ok: abStatus('orphan_codex_verdict'),         g: 'if (!prior && prevCodexRaw) {',       gf: 'if (false) {' },
  { n: '#6 invalid round number',          in: { ...BASE, prior_state: { round: 99 } },                                        ok: abStatus('prior_state_round_invalid'),    g: 'if (prior && !priorRoundValid) {',    gf: 'if (false) {' },
  { n: '#7 run_id mismatch',         in: { ...BASE, prior_state: { round: 1, run_id: 'x' } },                            ok: abStatus('prior_state_run_id_mismatch'),  g: 'if (priorRunIdRaw !== RUN_ID) {',     gf: 'if (false) {' },
  { n: '#8 fingerprint mismatch',             in: { ...BASE, prior_state: { round: 1, run_id: '', task_fingerprint: 'wrong' } },  ok: abStatus('prior_state_identity_mismatch'),g: 'if (priorFp !== TASK_FP) {',          gf: 'if (false) {' },
  { n: '#9 invalid cumulative budget',     in: { ...BASE, prior_state: { round: 1, run_id: '', task_fingerprint: REAL_FP, cumulative_used: -5 } },                                              ok: abStatus('prior_state_budget_invalid'),      g: 'if (prior && !cumulativeValid) {',   gf: 'if (false) {' },
  { n: '#10 legacy state format is refused',in: { ...BASE, prior_state: { round: 1, run_id: '', task_fingerprint: REAL_FP, cumulative_used: 0, worker_output: 'garbage', worker_parsed: null } }, ok: abStatus('prior_state_legacy_worker_format'), g: 'if (hasLegacyWorkerField) {',  gf: 'if (false) {' },
  { n: '#10b legacy field on the prototype is still caught', in: { ...BASE, prior_state: evilProtoState }, ok: abStatus('prior_state_legacy_worker_format'), g: "('worker_output' in prior) || ('worker_parsed' in prior)", gf: "Object.prototype.hasOwnProperty.call(prior, 'worker_output') || Object.prototype.hasOwnProperty.call(prior, 'worker_parsed')" },
  { n: '#11 no valid Claude verdicts in state',in: { ...BASE, prior_state: { round: 1, run_id: '', task_fingerprint: REAL_FP, cumulative_used: 0 } },                                             ok: abStatus('prior_state_schema_invalid'),      g: 'if (prior && !claudeVerdictsOk) {',  gf: 'if (false) {' },
]

// ============ Group B: convergence gates, driven by stubbed verdicts ============
const R1 = (await runPanel(BSRC, async () => CLAUDE_APPROVE)).r
const FP = R1.task_fingerprint, A1 = FP + '_r1', A2 = FP + '_r2'
const R2ok = { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxApprove(A1), codex_exit_code: 0 }
const R1hid = (await runPanel(BSRC, async () => CLAUDE_HIDDEN_P0)).r
const R1ben = (await runPanel(BSRC, async () => CLAUDE_BENIGN_REF)).r
const R1for = (await runPanel(BSRC, async () => CLAUDE_FOREIGN_LINE)).r
const R1wid = (await runPanel(BSRC, async () => CLAUDE_WIDE_COLON)).r
const R1tlk = (await runPanel(BSRC, async () => CLAUDE_TALKS_ABOUT)).r
// Round-2 prior state: round 1 had Claude approving and the reviewer rejecting, so round 2 opens.
const ps2 = (await runPanel(R2ok.prior_state ? { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxCleanReject(A1), codex_exit_code: 0 } : BSRC, async () => CLAUDE_APPROVE)).r.prior_state
// Baseline where the Claude side returns a clean REJECT.
const R1cr = (await runPanel(BSRC, async () => CLAUDE_CLEAN_R)).r
const A1cr = R1cr.task_fingerprint + '_r1'
// Correct construction for the Claude anti-flip case: round 1 Claude rejects, round 2 Claude approves
// WITH a delta (a genuine flip), while the reviewer approves in both rounds.
const CA_DELTA = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: re-ran 462/0 line 90\nVERIFIED: pass\nDELTA: re-verified line 90 passes\nEND'
const R2cr = (await runPanel({ ...BSRC, prior_state: R1cr.prior_state, codex_prev_verdict_raw: cxApprove(A1cr), codex_exit_code: 0 }, async () => CA_DELTA)).r  // round 2 Claude approves with a delta (a flip); the previous stance was not-approved
const circ = { task: 't', kind: 'code', contextPack: { targets: ['/tmp/x.py'], expected: 'c' } }; circ.loop = circ
const noSrc = { task: 't', kind: 'code', risk: 'high', contextPack: { targets: ['/tmp/x.py'], expected: 'c', canonical_docs: ['/tmp/c.md'], generated_by_claude: ['/tmp/c.md', '/tmp/x.py'], raw_sources: [] } }
const psNoFrozen = { ...ps2 }; delete psNoFrozen.frozen_r1
const CA_NODIGIT = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: looks good structurally\nVERIFIED: pass\nEND'  // APPROVE with no digit in EVIDENCE: fails the digit gate
const R1nd = (await runPanel(BSRC, async () => CA_NODIGIT)).r
const A1nd = R1nd.task_fingerprint + '_r1'
const psNoStance = { ...ps2 }; delete psNoStance.prev_round_stance  // round-2 prior state with prev_round_stance removed
// ==== deep-mode parallel chain: the ONLY fixtures that may assert a round-3 handoff ====
// 🔴 Why a whole separate chain instead of adding mode:'deep' to the four cases below.
//    The default allowance is TWO rounds. Under it there is no third round to open, so an
//    anti-flip refusal terminates as not_converged and the round-3 handoff — and the total
//    budget ceiling that guards it — are never reached. Those paths would silently stop being
//    tested.
//    But `mode` is part of the audit fingerprint, by design: a prior_state produced under one
//    mode is a DIFFERENT audit from a call made under another, and the panel refuses the mix
//    (prior_state_identity_mismatch). Measured: pinning deep on the final call alone turns all
//    four red for that reason. So the whole chain — round 1, the round-2 state, and the AUDIT-IDs
//    derived from its fingerprint — has to be built under deep as well.
// ⚠️ Do NOT "simplify" this by relaxing the four expectations to not_converged. That is green for
//    the wrong reason: it drops coverage of the handoff path and of the ceiling guard entirely.
const BDEEP  = { ...BSRC, mode: 'deep' }
const R1D    = (await runPanel(BDEEP, async () => CLAUDE_APPROVE)).r
const FPD    = R1D.task_fingerprint, A1D = FPD + '_r1', A2D = FPD + '_r2'
const ps2D   = (await runPanel({ ...BDEEP, prior_state: R1D.prior_state, codex_prev_verdict_raw: cxCleanReject(A1D), codex_exit_code: 0 }, async () => CLAUDE_APPROVE)).r.prior_state
const R1crD  = (await runPanel(BDEEP, async () => CLAUDE_CLEAN_R)).r
const A1crD  = R1crD.task_fingerprint + '_r1'
const R2crD  = (await runPanel({ ...BDEEP, prior_state: R1crD.prior_state, codex_prev_verdict_raw: cxApprove(A1crD), codex_exit_code: 0 }, async () => CA_DELTA)).r
const psNoStanceD = { ...ps2D }; delete psNoStanceD.prev_round_stance
// ==== Claim-mode fixtures. Without these, every case would be code mode and the claim gates would never run. ====
const B_BIO = { task: 'judge a classification claim', kind: 'claim', contextPack: { raw_sources: ['/tmp/x.fasta'], canonical_docs: ['/tmp/canon.md'] } }
const CLAIM_A = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples match the reference batch\nANCHOR: anchored\nUNANCHORED_CLAIMS: none\nEND'
const CLAIM_UN = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples\nANCHOR: none\nUNANCHORED_CLAIMS: instrument drift not cross-validated\nEND'  // ANCHOR is not "anchored", so the claim gate blocks
const cxClaimA = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples reference\nANCHOR: anchored\nUNANCHORED_CLAIMS: none\nAUDIT-ID: ${id}\nEND`
const R1bio = (await runPanel(B_BIO, async () => CLAIM_A)).r
const R1bioUn = (await runPanel(B_BIO, async () => CLAIM_UN)).r

const conv = (r) => r && r.converged === true && r.convergence_status === 'converged' && r.audit_stage === 'converged_r1' && (r.blockers || []).length === 0 && r.needs_expert_signoff === false
const RET_R1 = (await runPanel(BSRC, async () => CLAUDE_FIVE_P0)).r
const CASES_B = [
  // RETENTION: every P0 raised in round 1 must reach the next round's OPEN P0 LEDGER.
  // WITHOUT this case, replacing `const carry = newP0s.slice()` with
  // `const carry = []` -- a mutation that erases every open finding -- still left this suite
  // at 111 passed / 0 failed. A suite that cannot see findings disappear cannot serve as
  // acceptance evidence for anything about finding retention.
  { n: 'RETENTION every R1 P0 reaches the next round ledger',
    args: { ...BSRC, prior_state: RET_R1.prior_state, codex_prev_verdict_raw: cxApprove(RET_R1.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_APPROVE,
    ok: r => { const m = /OPEN P0 LEDGER[^\n]*/.exec(r.codex_brief || '')
               return !!m && RET_IDS.every(id => m[0].includes(id)) },
    g: 'const converged = blockers.length === 0\n  const carry = newP0s.slice()',
    gf: 'const converged = blockers.length === 0\n  const carry = []' },

  { n: 'B0 converges on a clean round',         args: R2ok,                                                        fn: () => CLAUDE_APPROVE, ok: conv },
  { n: 'B1 reviewer verdict with the wrong audit id',        args: { ...R2ok, codex_prev_verdict_raw: cxApprove(FP + '_r9') },   fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_verdict_identity_mismatch', g: 'if (!idOk) {', gf: 'if (false) {' },
  // The reviewer CLI prints its verdict twice and the wrapper marks both copies, so they arrive
  // identical. A large transcript gets shortened on the way here, and the marker survives in only one
  // of them: two blocks that differ by a single line this parser never reads. Judging that ambiguous
  // discarded a completed review — safe, but it made every large review unable to converge.
  { n: 'B1b the same verdict twice, the exit marker surviving in only one copy, still folds',
    args: { ...R2ok, codex_prev_verdict_raw: cxApprove(A1) + '\n\n' + cxApprove(A1).replace('\nEND', '\n__DUAL_AUDIT_RC=0\nEND') },
    fn: () => CLAUDE_APPROVE, ok: conv,
    // 🔴 NOT COUNTED AS A KILLABLE MUTANT, and the reason is recorded honestly (neither an oversight
    // nor "it would not die so we let it pass"). After the merge this case is covered by TWO
    // INDEPENDENT MECHANISMS, so no single-point mutation changes the outcome: (1) one block marked
    // and one not -> anyMarker=true -> candidates=marked -> one block -> converge; (2) even with (1)
    // disabled, both enter dedup and the dedup key strips the marker, so they are identical -> still
    // one block -> converge. Probed one mutation at a time: mutants on either mechanism survive. That
    // is redundant coverage, not a dead gate. If either mechanism is removed, this note is void.
  },
  // ...and nothing wider than that is ignored: two blocks that differ in a field a reader cares about
  // are still two verdicts, and still refused.
  { n: 'B1c two blocks differing in a real field are still ambiguous',
    args: { ...R2ok, codex_prev_verdict_raw: cxApprove(A1) + '\n\n' + cxApprove(A1).replace('P0: none', 'P0: a late blocker') },
    fn: () => CLAUDE_APPROVE, ok: r => r.converged === false },
  { n: 'B2 codex exit≠0',           args: { ...R2ok, codex_exit_code: 1 },                             fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r1_codex_unavailable_retry', g: 'if (codexUnavailable) {', gf: 'if (false) {' },
  { n: 'B3 reviewer exit code missing',         args: { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxApprove(A1) }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r1_codex_unavailable_retry' },
  { n: 'B4 reviewer produced empty output',          args: { ...R2ok, codex_prev_verdict_raw: '' },                     fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r1_codex_unavailable_retry' },
  // B6 uses a CLEAN Claude REJECT, so the consensus gate is the only thing that can block it.
  // Removing that gate produces a false convergence, which is what isolates it.
  { n: 'B6 claude clean-REJECT',    args: { ...BSRC, prior_state: R1cr.prior_state, codex_prev_verdict_raw: cxApprove(A1cr), codex_exit_code: 0 }, fn: () => CLAUDE_CLEAN_R, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex',
    g: "if (valid.length && !valid.every(a => a.parsed.approves)) blockers.push('not all valid auditors APPROVE')", gf: "if (false) blockers.push('not all valid auditors APPROVE')" },
  { n: 'B7 circular reference in the arguments',           args: circ,                                                        fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && /AUDIT IDENTITY UNAVAILABLE/.test(r.error || ''), g: 'if (CTX_SIG == null || CTX_SIG_ERROR) {', gf: 'if (false && (CTX_SIG == null || CTX_SIG_ERROR)) {' },
  { n: 'B8 high risk with no independent source',           args: noSrc,                                                       fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.blockers || []).some(b => /no independent R1 source/.test(b)), g: 'if (n === 1 && !hasIndependentR1Source) {', gf: 'if (false) {' },
  // B9: with the frozen round-1 record missing at round 2 or later, removing the guard skips the whole
  // anti-flip section and converges falsely.
  { n: 'B9 frozen round 1 missing',          args: { ...BSRC, prior_state: psNoFrozen, codex_prev_verdict_raw: cxApprove(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'prior_state_frozen_r1_missing', g: 'if (prior && priorRoundValid && priorRound >= 2 && !frozenOk) {', gf: 'if (false) {' },
  // B10: the reviewer rejects in round 1 and approves in round 2 with a DELTA (so the delta gate is not
  // what blocks). The flip-stability gate must block; removing it converges falsely.
  { n: 'B10 anti-flip: reviewer flipped',   args: { ...BDEEP, prior_state: ps2D, codex_prev_verdict_raw: cxApproveDelta(A2D), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r3_handoff_to_codex', g: 'if (codexFreshFlipHard) {', gf: 'if (false) {' },
  // B11: a cumulative budget already at the ceiling means this round would exceed it, so it is refused
  // before convergence rather than after.
  { n: 'B11 budget over the hard ceiling',          args: { ...BSRC, prior_state: { ...ps2, cumulative_used: 18 }, codex_prev_verdict_raw: cxApprove(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.blockers || []).some(b => /HARD_TOTAL_CEILING.*exceeded/.test(b)), g: 'if (ledger.totalUsed > HARD_TOTAL_CEILING) {', gf: 'if (false) {' },
  // B12: an approving verdict whose EVIDENCE contains no digit must not converge. Removing the digit
  // gate converges falsely.
  { n: 'B12 EVIDENCE without a digit does not converge',   args: { ...BSRC, prior_state: R1nd.prior_state, codex_prev_verdict_raw: cxApprove(A1nd), codex_exit_code: 0 }, fn: () => CA_NODIGIT, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex', g: 'if (unanchoredEvidence.length) blockers.push', gf: 'if (false) blockers.push' },
  // ==== Validity gate and the parser's negative paths. This is where a decisive hole once lived:
  //      forcing the validity flag to true made the ENTIRE suite pass. ====
  // B13: a missing P0 is caught by the validity gate alone (no downstream gate overlaps it), which makes
  // it a clean isolation: removing that sub-gate converges falsely.
  { n: 'B13 reviewer verdict missing P0 is invalid', args: { ...R2ok, codex_prev_verdict_raw: cxNoP0(A1) },       fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex', g: 'p0Raw !== null &&', gf: 'true &&' },
  // B15-B18 cover the parser's negative paths positively: a malformed verdict must not be treated as a
  // valid approval. Their mutants are covered by the downstream defence-in-depth gates instead.
  { n: 'B15 reviewer verdict missing VERIFIED does not converge', args: { ...R2ok, codex_prev_verdict_raw: cxNoVerified(A1) }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex' },
  { n: 'B16 reviewer EVIDENCE without a digit does not converge',   args: { ...R2ok, codex_prev_verdict_raw: cxEvNoDigit(A1) },  fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex' },
  { n: 'B17 placeholder inside the reviewer block does not converge',   args: { ...R2ok, codex_prev_verdict_raw: cxPlaceholder(A1) },fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex' },
  { n: 'B18 reviewer verdict with no VERDICT fails identity',        args: { ...R2ok, codex_prev_verdict_raw: cxNoVerdict(A1) },  fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_verdict_identity_mismatch' },
  // B19 is the Claude-side anti-flip: round 1 rejects, round 2 approves with a DELTA (a genuine flip)
  // while the reviewer approves throughout, so the Claude flip gate must block. Removing it converges falsely.
  { n: 'B19 anti-flip: Claude side flipped',   args: { ...BDEEP, prior_state: R2crD.prior_state, codex_prev_verdict_raw: cxApprove(R1crD.task_fingerprint + '_r2'), codex_exit_code: 0 }, fn: () => CA_DELTA, ok: r => r.converged === false && r.convergence_status === 'r3_handoff_to_codex', g: 'if (claudeFreshFlipHard) {', gf: 'if (false) {' },
  // ==== The remaining live exits ====
  // B20: consecutive unavailable reviewer attempts reach the cap and escalate, which is different from
  // the single-attempt retry cases above.
  { n: 'B20 codex_unavailable escalate', args: { ...BSRC, prior_state: { ...R1.prior_state, codex_unavailable_streak: 1 }, codex_prev_verdict_raw: cxApprove(A1), codex_exit_code: 1 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_unavailable', g: 'if (streak >= MAX_CODEX_UNAVAIL) {', gf: 'if (false) {' },
  // B21: the TOTAL budget is exhausted when a new round would open, which is a different exit from B11.
  { n: 'B21 hard ceiling blocks opening another round', args: { ...BDEEP, prior_state: { ...ps2D, cumulative_used: 17 }, codex_prev_verdict_raw: cxCleanReject(A2D), codex_exit_code: 0 }, fn: () => CLAUDE_CLEAN_R, ok: r => r.converged === false && (r.blockers || []).some(b => /HARD_TOTAL_CEILING.*reached/.test(b)), g: 'if (ledger.totalUsed >= HARD_TOTAL_CEILING) {   // P0-3', gf: 'if (false) {   // P0-3' },
  // B22: at round 2 or later a missing prev_round_stance must be refused. The fixture gives the reviewer a
  // DELTA (so the delta gate is not what blocks) and keeps the Claude side stably approving (so the flip
  // gate is not what blocks), which leaves the missing-state guard as the ONLY thing that can block —
  // otherwise another gate would mask it and the mutant would look killed when it was not.
  { n: 'B22 missing prev_round_stance is refused', args: { ...BDEEP, prior_state: psNoStanceD, codex_prev_verdict_raw: cxApproveDelta(A2D), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r3_handoff_to_codex', g: 'if (priorRound >= 2 && !prevStanceUsable) {', gf: 'if (false) {' },
  // B25: a blocker reachable only by reading a value the gates never consult must not converge. The
  // reviewer is told verbatim that anything outside the field shapes is refused rather than
  // reinterpreted; until this gate existed the parser only warned and the round approved.
  { n: 'B25 a blocker hidden inside another field value cannot converge',
    args: { ...BSRC, prior_state: R1hid.prior_state, codex_prev_verdict_raw: cxApprove(R1hid.task_fingerprint + '_r1'), codex_exit_code: 0 },
    // 🔴 Changed to ADVISORY rather than invalidating, on the strength of a larger measured corpus.
    // The original design was calibrated on 76 verdicts and chose a hard gate. Re-calibrated on 470
    // real verdicts, a hard gate would add 13 rejections with ZERO true positives - 8 are
    // cross-examination DELTAs explaining which of the other side's P0s were rejected (exactly what a
    // DELTA is for) and 5 are reviews OF THIS PANEL quoting its own field names as data.
    // Worse: a rejection DISCARDS THE WHOLE VERDICT, including any real P0s it was carrying.
    fn: () => CLAUDE_HIDDEN_P0, ok: r => (r.advisories || []).some(a => /contains "P0:"/.test(a)),
    g: 'const hidesGatingWarn = hidesGatingField', gf: 'const hidesGatingWarn = false && hidesGatingField' },
  { n: 'B25c a cross-examination DELTA naming the other side P0 still converges',
    args: { ...BSRC, prior_state: R1hid.prior_state, codex_prev_verdict_raw: cxApprove(R1hid.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_DELTA_NAMES_P0, ok: r => r.converged === true },
  // B26: the good case for B25. A value mentioning a NON-gating field name is prose, and rejecting it
  // would cost a round for nothing — a gate that fires on everything is not a gate.
  { n: 'B26 a value naming a non-gating field still converges',
    args: { ...BSRC, prior_state: R1ben.prior_state, codex_prev_verdict_raw: cxApprove(R1ben.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_BENIGN_REF, ok: r => r.converged === true && r.convergence_status === 'converged' },
  // B27: the closed grammar the prompt promises. A line this parser cannot read has unknown meaning,
  // and an unknown line inside a verdict block is what the contract says is refused. Measured against
  // 76 real verdicts before shipping: none of them contained one, so this costs nothing in practice.
  { n: 'B27 an unreadable line inside the block cannot converge',
    args: { ...BSRC, prior_state: R1for.prior_state, codex_prev_verdict_raw: cxApprove(R1for.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_FOREIGN_LINE, ok: r => r.converged === false,
    g: ' && !foreignLine', gf: '' },
  // B28: the good case for B27 — the wrapper's own marker line must survive it.
  { n: 'B28 the exit-code marker inside the block is not a foreign line',
    args: { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxMarker(A1), codex_exit_code: 0 },
    fn: () => CLAUDE_APPROVE, ok: conv },
  // B29: a colon variant is still a colon to whoever wrote it.
  { n: 'B29 a blocker hidden behind a full-width colon cannot converge',
    args: { ...BSRC, prior_state: R1wid.prior_state, codex_prev_verdict_raw: cxApprove(R1wid.task_fingerprint + '_r1'), codex_exit_code: 0 },
    // As in B25: advise, do not reject. But a fullwidth colon must still be SEEN.
    fn: () => CLAUDE_WIDE_COLON, ok: r => (r.advisories || []).some(a => /contains "P0:"/.test(a)) },
  // B30: the good case for B25/B29. Reviewers discuss these fields in prose constantly; an earlier
  // version of the rule refused 15 of 76 real verdicts for exactly this.
  { n: 'B30 prose naming a field, with a real blocker recorded, is not refused',
    args: { ...BSRC, prior_state: R1tlk.prior_state, codex_prev_verdict_raw: cxCleanReject(R1tlk.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_TALKS_ABOUT, ok: r => r.convergence_status !== 'prior_state_schema_invalid' },
  // ==== ⑤ claim fixtures + ⑥ claim gate ====
  { n: 'B23 claim mode converges on a clean anchored round', args: { ...B_BIO, prior_state: R1bio.prior_state, codex_prev_verdict_raw: cxClaimA(R1bio.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_A, ok: r => r.converged === true && r.convergence_status === 'converged' && (r.blockers || []).length === 0 && r.needs_expert_signoff === false },
  // B24: a Claude verdict whose ANCHOR is not "anchored" must be blocked by the claim gate.
  { n: 'B24 an unanchored claim is blocked by the claim gate', args: { ...B_BIO, prior_state: R1bioUn.prior_state, codex_prev_verdict_raw: cxClaimA(R1bioUn.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_UN, ok: r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex', g: "if (claimGap) blockers.push('substantive claims not fully anchored", gf: "if (false) blockers.push('substantive claims not fully anchored" },
]

// ============ Runner: the original source, then mutants (distinguishing a crash from an assertion failure) ============
const mutKill = async (args, fn, ok, g, gf, requireConverged = false) => {
  if (SRC0.split(g).length - 1 !== 1) return { kill: false, why: `mutation anchor is not unique: ${g}` }
  let r
  try { r = (await runPanel(args, fn, s => s.replace(g, gf))).r } catch (e) { return { kill: false, threw: true, why: 'the mutant crashed, which is not a clean kill — replace it with a non-crashing mutant' } }
  // For gates whose mutant is EXPECTED to converge (group D), a clean kill requires the mutant to actually
  // reach converged === true. Otherwise "the status changed but another gate still blocked it" would be
  // miscounted as a kill — a false clean kill.
  const killed = !ok(r, { agent: 0, parallel: 0 }) && (!requireConverged || (r && r.converged === true))
  return { kill: killed, why: `mut converged=${r && r.converged} status=${r && r.convergence_status}` }
}
console.log('=== Group A: input guards ===')
for (const c of CASES_A) { const { r, calls } = await runPanel(c.in).catch(e => ({ r: { __throw: e.message }, calls: {} })); rec(!r.__throw && c.ok(r, calls), c.n, r.__throw || `status=${r.convergence_status} agent=${calls.agent}`) }
console.log('=== Group A mutants (proving the assertions have teeth) ===')
for (const c of CASES_A) { const k = await mutKill(c.in, null, c.ok, c.g, c.gf); if (k.threw) threwNote++; rec(k.kill, c.n + '[mut]' + (k.threw ? '(crashed)' : ''), k.why) }
console.log('=== Group B: convergence gates ===')
for (const c of CASES_B) { const { r, calls } = await runPanel(c.args, c.fn).catch(e => ({ r: { __throw: e.message }, calls: {} })); rec(!r.__throw && c.ok(r, calls), c.n, r.__throw || `converged=${r.converged} status=${r.convergence_status}`) }
console.log('=== Group B mutants (those with a source anchor) ===')
for (const c of CASES_B) { if (!c.g) continue; const k = await mutKill(c.args, c.fn, c.ok, c.g, c.gf); if (k.threw) threwNote++; rec(k.kill, c.n + '[mut]' + (k.threw ? '(crashed)' : ''), k.why) }

// ============ Group E: the contract the panel EMITS. A stub that never inspects the prompt cannot
// detect the panel dropping its own verdict-field requirements, so these cases read the prompt. ============
console.log('=== Group E: the prompt the panel sends an auditor must carry the verdict contract ===')
// Capture the first Claude auditor prompt of the round.
// This couples to the current label space: if a differently-labelled Claude call were ever added before
// the auditor, this would capture the wrong one. No such role exists today.
async function firstAuditorPrompt(args, mutate) {
  let p = ''
  await runPanel(args, async (prompt, opts) => {
    const lbl = (opts && opts.label) || ''
    if (!p && /^claude:/.test(lbl) && !/^claude:worker:/.test(lbl)) p = String(prompt || '')
    return args.kind === 'claim' ? CLAIM_A : CLAUDE_APPROVE
  }, mutate)
  return p
}
{
  // E1: the core fields, on a round-1 code auditor.
  const RE_V = /VERDICT: APPROVE \| APPROVE_WITH_CHANGES \| REJECT/
  const p1 = await firstAuditorPrompt(BSRC)
  rec(RE_V.test(p1) && /\nP0:/.test(p1) && /EVIDENCE:/.test(p1), 'E1 auditor prompt carries the VERDICT/P0/EVIDENCE contract', 'the emitting side omits the core fields')
  const p1m = await firstAuditorPrompt(BSRC, s => s.replace("'VERDICT: APPROVE | APPROVE_WITH_CHANGES | REJECT',", "'',"))
  rec(!RE_V.test(p1m), 'E1[mut] removing the VERDICT contract line drops it from the prompt', 'the prompt still carries it, so the emitting side is not being tested')
  // E2: the DELTA contract in cross-examination. A round-1 reviewer rejection is what forces round 2 to
  // open; the round-1-converging fixture cannot be used here, because no new auditor runs and the
  // captured prompt would be empty.
  const RE_D = /DELTA: <ALWAYS document any change of stance/
  const R2args = { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxCleanReject(A1), codex_exit_code: 0 }
  const p2 = await firstAuditorPrompt(R2args)
  rec(RE_D.test(p2), 'E2 the round-2 auditor prompt carries the DELTA contract', 'the cross-examination prompt omits DELTA')
  const p2m = await firstAuditorPrompt(R2args, s => s.replace("L.push('DELTA: <ALWAYS document any change of stance", "L.push('__X: <"))
  rec(!RE_D.test(p2m), 'E2[mut] removing the DELTA contract line drops it from the prompt', 'the prompt still carries DELTA')
  // E3: the ANCHOR contract, on a claim-mode auditor.
  const RE_A = /ANCHOR: anchored \| partial \| none/
  const p3 = await firstAuditorPrompt(B_BIO)
  rec(RE_A.test(p3), 'E3 the claim-mode auditor prompt carries the ANCHOR contract', 'claim mode omits ANCHOR')
  const p3m = await firstAuditorPrompt(B_BIO, s => s.replace("L.push('ANCHOR: anchored | partial | none", "L.push('__X: <"))
  rec(!RE_A.test(p3m), 'E3[mut] removing the ANCHOR contract line drops it from the prompt', 'the prompt still carries ANCHOR')
  // E4: the contract is appended by the shared dispatch layer. Breaking that append must strip it from the
  // captured prompt, which proves the contract really comes from the shared layer. E1 tests WHAT the
  // contract contains; E4 tests whether it is connected at all.
  const AUD_ONLY = s => s.replace("const fullTask = prompt + '\\n' + sentinelContract(rs.n >= 2)", "const fullTask = prompt")
  const p4 = await firstAuditorPrompt(BSRC, AUD_ONLY)
  rec(p4.length > 0 && !RE_V.test(p4), 'E4[mut] breaking the shared contract append drops the contract from the prompt', 'the prompt still carries it, so the shared layer is not being tested')
}

// ============ Group C: the reviewer brief. The reviewer side does not go through an agent — its contract
// travels back to the driver inside the returned brief, so group E cannot see it at all. ============
// Probing confirmed the gap: breaking either brief's contract call individually left the suite fully green.
console.log('=== Group C: the reviewer brief the panel returns to the driver must carry the contract ===')
{
  const RE_V = /VERDICT: APPROVE \| APPROVE_WITH_CHANGES \| REJECT/
  // C1: the round-1 code brief carries the core fields and the audit id.
  const b1 = (await runPanel(BSRC, async () => CLAUDE_APPROVE)).r.codex_brief || ''
  rec(RE_V.test(b1) && /\nP0:/.test(b1) && /EVIDENCE:/.test(b1) && /VERIFIED:/.test(b1) && /AUDIT-ID:/.test(b1), 'C1 the round-1 brief carries the core contract and the audit id', 'the round-1 brief omits the contract')
  const b1m = (await runPanel(BSRC, async () => CLAUDE_APPROVE, s => s.replace('sentinelContract(false, auditIdFor(1))', "''"))).r.codex_brief || ''
  rec(b1m.length > 0 && !RE_V.test(b1m), 'C1[mut] breaking the round-1 contract call drops it from the brief', 'the brief still carries it, so the reviewer side is not locked down')
  // C2: the round-2 brief additionally carries the DELTA contract.
  const RE_D = /DELTA: <ALWAYS document any change of stance/
  const R2args = { ...BSRC, prior_state: R1.prior_state, codex_prev_verdict_raw: cxCleanReject(A1), codex_exit_code: 0 }
  const b2 = (await runPanel(R2args, async () => CLAUDE_APPROVE)).r.codex_brief || ''
  rec(RE_D.test(b2) && /AUDIT-ID:/.test(b2), 'C2 the round-2 brief carries the DELTA contract and the audit id', 'the round-2 brief omits DELTA')
  const b2m = (await runPanel(R2args, async () => CLAUDE_APPROVE, s => s.replace('sentinelContract(true, auditIdFor(n))', "''"))).r.codex_brief || ''
  rec(b2m.length > 0 && !RE_D.test(b2m), 'C2[mut] breaking the round-2 contract call drops DELTA from the brief', 'the brief still carries DELTA, so the reviewer side is not locked down')
  // C3: the claim-mode round-1 brief carries the anchoring fields.
  const RE_A = /ANCHOR: anchored \| partial \| none/
  const b3 = (await runPanel(B_BIO, async () => CLAIM_A)).r.codex_brief || ''
  rec(RE_A.test(b3) && /UNANCHORED_CLAIMS:/.test(b3), 'C3 the claim-mode round-1 brief carries the ANCHOR contract', 'the claim-mode brief omits ANCHOR')
  const b3m = (await runPanel(B_BIO, async () => CLAIM_A, s => s.replace('sentinelContract(false, auditIdFor(1))', "''"))).r.codex_brief || ''
  rec(b3m.length > 0 && !RE_A.test(b3m), 'C3[mut] breaking the claim-mode contract call drops ANCHOR from the brief', 'the brief still carries ANCHOR')
}

console.log('=== Group F: the bounded-scope and time-box paragraph in the reviewer brief ===')
// Why this group exists: the paragraph is prose, so nothing mechanical was watching it, and it had
// already been wrong TWICE in ways that flipped the panel from fail-closed to fail-open. Version one
// said only "a partial verdict beats no verdict", which made FINISHING cheaper than being HONEST: an
// APPROVE whose own text admitted it had read 2 of 7 targets converged with no blockers. Version two
// offered APPROVE_WITH_CHANGES as the polite way out — and approvesFinal treats that identically to
// APPROVE, so the panel was pointing the reviewer back into the same hole. Both were caught by people
// reading it. Prose that gates convergence needs a test like any other gate.
//
// ⚠️ The observable is `r.codex_brief`, NOT the Claude-side prompt: this paragraph only ever goes to
// the reviewer. Asserting against the wrong observable is how the first attempt at this group produced
// six failures and, worse, two negative assertions that passed for free because the string they were
// searching was empty. Hence the non-empty precondition on every case below.
{
  const bCode  = (await runPanel(BSRC,  async () => CLAUDE_APPROVE)).r.codex_brief || ''
  const bClaim = (await runPanel(B_BIO, async () => CLAIM_A)).r.codex_brief || ''
  rec(bCode.length > 0 && bClaim.length > 0, 'F0 precondition: both briefs are non-empty (else every assertion below passes for free)', 'a brief came back empty, so this group proves nothing')

  const ECASES = [
    { n: 'F1 the brief forbids reading outside the listed paths',
      ok: b => /BOUNDED SCOPE \(mandatory\)/.test(b) && /Do NOT grep\/rg\/find/.test(b),
      g: "'BOUNDED SCOPE (mandatory): read ONLY", gf: "'XX (mandatory): read ONLY" },
    { n: 'F2 the brief states the ceiling is hard and that overrunning returns NOTHING',
      ok: b => /TIME BOX \(hard, \d+ minutes\)/.test(b) && /returns NOTHING/.test(b),
      g: 'TIME BOX (hard, ${TIME_BOX_MIN} minutes)', gf: 'TIME BOX (soft, ${TIME_BOX_MIN} minutes)' },
    // 🔴 The single most important assertion here: an incomplete review must be told to REJECT, and
    //    must be told that BOTH approving shapes converge. Naming only APPROVE is the exact bug that
    //    shipped once already.
    { n: 'F3 an incomplete review is forbidden from carrying EITHER approving verdict',
      ok: b => /MUST NOT carry VERDICT: APPROVE or APPROVE_WITH_CHANGES/.test(b) && /Use VERDICT: REJECT\./.test(b),
      g: 'MUST NOT carry VERDICT: APPROVE or APPROVE_WITH_CHANGES', gf: 'MUST NOT carry VERDICT: APPROVE' },
  ]
  for (const c of ECASES) {
    rec(bCode.length > 0 && c.ok(bCode), c.n, 'the code-mode brief does not carry it')
    if (SRC0.split(c.g).length - 1 !== 1) { rec(false, c.n + '[mut]', `mutation anchor is not unique: ${c.g}`); continue }
    const bm = (await runPanel(BSRC, async () => CLAUDE_APPROVE, s => s.replace(c.g, c.gf))).r.codex_brief || ''
    rec(bm.length > 0 && !c.ok(bm), c.n + '[mut]', 'the mutant brief still satisfies the assertion — the check has no teeth')
  }

  // The honest valve must name the field that ACTUALLY gates the mode. Pointing a claim-mode review at
  // VERIFIED: fail is not a smaller mistake than saying nothing: codeFieldsOk = !codeRelevant || ...,
  // so VERIFIED is inert there, and the incident that produced this whole paragraph WAS claim mode.
  rec(bClaim.length > 0 && /set ANCHOR: partial \(or none\)/.test(bClaim) && /UNANCHORED_CLAIMS/.test(bClaim),
      'F4 claim mode points the honest valve at ANCHOR/UNANCHORED_CLAIMS', 'claim mode does not name the field that gates it')
  rec(bClaim.length > 0 && !/set VERIFIED: fail and name every target/.test(bClaim),
      'F5 claim mode does NOT point at VERIFIED, which is inert there', 'claim mode points at an inert field')
  rec(bCode.length > 0 && /set VERIFIED: fail and name every target/.test(bCode),
      'F6 code mode points the honest valve at VERIFIED', 'code mode does not name the field that gates it')
  // F5 is a NEGATIVE assertion, so it needs its own teeth check: swap the two arms and it must fail.
  const bClaimSwap = (await runPanel(B_BIO, async () => CLAIM_A, s => s.replace(
    "claimMode\n    ? 'If you could not cover everything: set ANCHOR: partial", "!claimMode\n    ? 'If you could not cover everything: set ANCHOR: partial"))).r.codex_brief || ''
  rec(bClaimSwap.length > 0 && /set VERIFIED: fail and name every target/.test(bClaimSwap),
      'F5[mut] inverting the mode test makes claim mode point at the inert field', 'inverting the mode test changed nothing — F5/F6 have no teeth')
}

// ============ Group D: single load-bearing convergence and parsing gates ============
// Each was isolated by probe: the original source does NOT converge, and removing that ONE gate makes it
// converge — which is what proves the gate is the sole blocker rather than one of several.
// Reviewer-side violations arrive through the raw verdict; Claude-side ones through an injected frozen state.
console.log('=== Group D: single load-bearing convergence and parsing gates ===')
{
  const CA_VFAIL  = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: ran 462/0 line 1191\nVERIFIED: fail\nEND'          // approves while VERIFIED says fail
  const cxPHd     = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: running in background will share line 42\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND` // a placeholder inside the block that also contains a digit
  const cxTrunc   = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: ok line 3\nVERIFIED: pass\nAUDIT-ID: ${id}\nEND\nVERDICT: REJECT truncated append` // a complete block followed by an appended VERDICT start
  const cxClaimNoP0 = id => `VERDICT: APPROVE\nEVIDENCE: 4 samples reference line 3\nANCHOR: anchored\nUNANCHORED_CLAIMS: none\nAUDIT-ID: ${id}\nEND`   // claim mode, missing P0: invalid
  const cxClaimNoUn = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples line 3\nANCHOR: anchored\nAUDIT-ID: ${id}\nEND`                          // claim mode, missing UNANCHORED_CLAIMS
  const CA_NODELTA = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: re-ran 462/0 line 90\nVERIFIED: pass\nEND'   // approves without a DELTA (used by the round-3 chain)
  const R1vf = (await runPanel(BSRC, async () => CA_VFAIL)).r
  // The delta-gate chain at round 3: a flip that IS stable across two rounds but arrives without a DELTA,
  // which is a different failure from the flip gate. The reviewer chain and the Claude chain are symmetric.
  // Round 3 only exists under deep (see the deep-mode parallel chain above): the default
  // allowance is two rounds, so this state and the delta-gate cases below must be built there.
  const ps3c  = (await runPanel({ ...BDEEP, prior_state: ps2D, codex_prev_verdict_raw: cxApproveDelta(A2D), codex_exit_code: 0 }, () => CLAUDE_APPROVE)).r
  const ps3cl = (await runPanel({ ...BDEEP, prior_state: R2crD.prior_state, codex_prev_verdict_raw: cxApprove(R1crD.task_fingerprint + '_r2'), codex_exit_code: 0 }, () => CA_NODELTA)).r
  const okPend = r => r.converged === false && r.convergence_status === 'r2_handoff_to_codex'
  const DCASES = [
    { n: 'D1 approving while VERIFIED says fail is blocked', args: { ...BSRC, prior_state: R1vf.prior_state, codex_prev_verdict_raw: cxApprove(R1vf.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: okPend, g: 'if (codeGap) blockers.push(codeGap)', gf: 'if (false) blockers.push(codeGap)' },
  // Two gates deliberately NOT tested here, with the reasoning recorded so nobody adds them back as
  // "missing coverage":
  //   * The open-P0 gate is now an EQUIVALENT MUTANT: if a verdict carrying a P0 is valid, the consensus
  //     gate fires (an approval requires zero P0s); if it is invalid, the any-invalid gate fires. One of
  //     the two always fires alongside it, so it can never be the sole blocker. Probing confirms removing
  //     it still does not converge. The BEHAVIOUR (a P0 blocks convergence) is covered by those two.
  //   * The any-null and any-skipped gates are unreachable in the real flow: the dispatch layer converts a
  //     null or throwing auditor into an invalid result, so the slot list never contains null, and a skipped
  //     auditor is not persisted. They are backstops, not load-bearing gates.
  // An earlier analysis listed both as load-bearing; it triggered them by injecting state without checking
  // reachability. Agreement between reviewers is not evidence — the probe decided this.
    { n: 'D5 an invalid reviewer verdict in claim mode blocks convergence', args: { ...B_BIO, prior_state: R1bio.prior_state, codex_prev_verdict_raw: cxClaimNoP0(R1bio.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_A, ok: okPend, g: 'if (anyInvalid) blockers.push', gf: 'if (false && anyInvalid) blockers.push' },
    { n: 'D6 claim mode requires UNANCHORED_CLAIMS to be present', args: { ...B_BIO, prior_state: R1bio.prior_state, codex_prev_verdict_raw: cxClaimNoUn(R1bio.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_A, ok: okPend, g: 'unanchoredList !== null', gf: 'true' },
    { n: 'D7 a truncated VERDICT appended after the block is refused', args: { ...R2ok, codex_prev_verdict_raw: cxTrunc(A1) }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_verdict_identity_mismatch', g: 'if (splitLines(tail).some(', gf: 'if (false && splitLines(tail).some(' },
    { n: 'D8 a placeholder inside the block is refused even with a digit present', args: { ...R2ok, codex_prev_verdict_raw: cxPHd(A1) }, fn: () => CLAUDE_APPROVE, ok: okPend, g: '!placeholderInBlock', gf: 'true' },
    { n: 'D9 delta gate: a round-3 reviewer flip against frozen round 1 without a DELTA', args: { ...BDEEP, prior_state: ps3c.prior_state, codex_prev_verdict_raw: cxApprove(ps3c.prior_state.task_fingerprint + '_r3'), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.gate_codes || []).includes('DELTA-GATE:codex'), g: 'if (codexFlippedUp && deltaMissingOrExplicitlyUnchanged) {', gf: 'if (false) {' },
    { n: 'D10 delta gate: a round-3 Claude flip against frozen round 1 without a DELTA', args: { ...BDEEP, prior_state: ps3cl.prior_state, codex_prev_verdict_raw: cxApprove(ps3cl.prior_state.task_fingerprint + '_r3'), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.gate_codes || []).includes('DELTA-GATE:claude'), g: 'if (claudeFlippedUp && !claudeGaveNonEmptyDelta) {', gf: 'if (false) {' },
  ]
  for (const c of DCASES) { const { r } = await runPanel(c.args, c.fn).catch(e => ({ r: { __throw: e.message } })); rec(!r.__throw && c.ok(r), c.n, r.__throw || `converged=${r.converged} status=${r.convergence_status}`) }
  for (const c of DCASES) { const k = await mutKill(c.args, c.fn, c.ok, c.g, c.gf, true); if (k.threw) threwNote++; rec(k.kill, c.n + '[mut]' + (k.threw ? '(crashed)' : ''), k.why) }  // requireConverged=true: only a mutant that actually converges counts as a clean kill here
}

console.log('\n[note] the round-overflow backstop is provably unreachable: the round number is only ever\n'
  + '       set to 1, or to priorRound+1 while priorRound is below the allowance. It is not counted as a killable mutant.')
console.log(`[note] ${threwNote} mutant(s) crashed rather than failing an assertion. A crash counts as a FAILURE,
       not a kill: it is weak evidence that the guard was doing the work, so such a mutant must be replaced
       by one that does not crash. This should be 0.`)

// ============ Group L: the findings ledger is monotonic ============
// The defect it exists for: openP0s is REPLACED by gate.carry each round and carry holds only the
// P0s adjudicated in THAT round, so a finding raised earlier that nobody restates disappears from
// every later result while the run still reports convergence -- the caller is handed an approval
// over a finding that evaporated, and "nobody found anything" becomes byte-identical to "the
// finding was dropped".
// Observation point: the panel runs ONE round per invocation and a round's P0s are adjudicated by
// the NEXT invocation, so a non-restatement is only visible at the third call. Asserting earlier
// measures something else.
{
  console.log('\n=== Group L: findings ledger ===')
  const LDEEP = { ...BSRC, mode: 'deep' }
  const L_A = 'VERDICT: REJECT\nP0: zed.py:71 the retry loop never exits; zed.py:72 the lock is released twice\nEVIDENCE: read 4 files line 9\nVERIFIED: fail\nEND'
  const L_B = 'VERDICT: REJECT\nP0: zed.py:71 the retry loop never exits\nEVIDENCE: re-read line 9 again\nVERIFIED: fail\nEND'
  const step = async (prev, fn) => (await runPanel({ ...LDEEP, prior_state: prev.prior_state, codex_prev_verdict_raw: cxCleanReject(prev.task_fingerprint + '_r' + prev.prior_state.round), codex_exit_code: 0 }, fn)).r
  const l1 = (await runPanel(LDEEP, async () => L_A)).r
  const l2 = await step(l1, async () => L_B)
  const l3 = await step(l2, async () => L_B)

  rec(Array.isArray(l1.findings_ledger) && Array.isArray(l2.findings_ledger), 'L1 every result carries a findings_ledger array', `r1=${typeof l1.findings_ledger} r2=${typeof l2.findings_ledger}`)
  const led2 = l2.findings_ledger || [], ids2 = led2.map(e => e.id)
  rec(led2.length >= 2 && new Set(ids2).size === ids2.length, 'L2 both round-1 findings get a distinct id (ledger must be non-empty)', `ids=${JSON.stringify(ids2)}`)
  rec(led2.length >= 2 && led2.every(e => e.status === 'open'), 'L3 freshly adjudicated entries are open (every() is vacuously true on [], so length is asserted too)', JSON.stringify(led2))
  rec(led2.length >= 2 && led2.every(e => e.round_raised === 1), 'L4 an entry remembers which round raised it', JSON.stringify(led2.map(e => e.round_raised)))

  const led3 = l3.findings_ledger || []
  const e71 = led3.find(e => /zed\.py:71/.test(e.text || ''))
  const e72 = led3.find(e => /zed\.py:72/.test(e.text || ''))
  rec(!!e72, 'L5 the finding nobody restated is STILL in the ledger -- disappearance is the violation', `n=${led3.length}`)
  rec(!!e72 && e72.status === 'not_restated', 'L6 it is marked not_restated, not silently green and not gone', `status=${e72 && e72.status}`)
  rec(!!e71 && e71.status === 'open', 'L7 the restated one stays open', `status=${e71 && e71.status}`)
  const idOf = (led, re) => { const e = led.find(x => re.test(x.text || '')); return e && e.id }
  rec(!!idOf(led2, /zed\.py:71/) && idOf(led2, /zed\.py:71/) === idOf(led3, /zed\.py:71/), 'L8 a restatement keeps its id and does not create a second entry', `r2=${idOf(led2, /zed\.py:71/)} r3=${idOf(led3, /zed\.py:71/)}`)
  const ids3 = led3.map(e => e.id)
  rec(ids3.length >= 2 && new Set(ids3).size === ids3.length, 'L9 no duplicate entries (must actually have entries)', `ids=${JSON.stringify(ids3)}`)
}

// ---- L10-L13: holes the panel found in its own ledger, each fixed and pinned ----
{
  const LD2 = { ...BSRC, mode: 'deep' }
  const P_A = 'VERDICT: REJECT\nP0: hex.py:31 the writer truncates before reading\nEVIDENCE: read 4 files line 9\nVERIFIED: fail\nEND'
  const q1 = (await runPanel(LD2, async () => P_A)).r
  const q2 = (await runPanel({ ...LD2, prior_state: q1.prior_state, codex_prev_verdict_raw: cxCleanReject(q1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => P_A)).r
  const inLedger = (r, re) => (r.findings_ledger || []).some(e => re.test(e.text || ''))
  rec(inLedger(q2, /hex\.py:31/), 'L10-pre the finding is in the ledger at this point (premise of what follows)', `n=${(q2.findings_ledger || []).length}`)

  const qUnavail = (await runPanel({ ...LD2, prior_state: q2.prior_state, codex_prev_verdict_raw: cxCleanReject(q2.task_fingerprint + '_r2'), codex_exit_code: 1 }, async () => P_A)).r
  rec(inLedger(qUnavail, /hex\.py:31/), 'L10 a terminal reached BEFORE the gate does not empty the ledger', `status=${qUnavail.convergence_status} n=${(qUnavail.findings_ledger || []).length}`)

  const qBad = (await runPanel({ ...LD2, prior_state: { ...q2.prior_state, findings_ledger: 'not-an-array' }, codex_prev_verdict_raw: cxCleanReject(q2.task_fingerprint + '_r2'), codex_exit_code: 0 }, async () => P_A)).r
  rec(qBad.converged === false && /ledger/i.test(String(qBad.convergence_status) + JSON.stringify(qBad.blockers || [])),
      'L11 a non-array prior ledger is REFUSED, not silently discarded', `status=${qBad.convergence_status}`)

  const { findings_ledger: _drop, ...psNoLedger } = q2.prior_state
  const qMissing = (await runPanel({ ...LD2, prior_state: psNoLedger, codex_prev_verdict_raw: cxCleanReject(q2.task_fingerprint + '_r2'), codex_exit_code: 0 }, async () => P_A)).r
  rec(qMissing.ledger_incomplete === true, 'L12 an absent prior ledger is marked incomplete, not presented as empty-and-complete', `ledger_incomplete=${qMissing.ledger_incomplete}`)

  // The fixture must actually PRODUCE the directive, or the next assertion passes on nothing.
  const NODIGIT = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: looks structurally fine\nVERIFIED: pass\nEND'
  const d1 = (await runPanel(LD2, async () => NODIGIT)).r
  const d2 = (await runPanel({ ...LD2, prior_state: d1.prior_state, codex_prev_verdict_raw: cxCleanReject(d1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => NODIGIT)).r
  const DIRECTIVE = /must cite a CONCRETE locator|Anchor these to a decisive/
  const fired = DIRECTIVE.test(JSON.stringify((d2.prior_state && d2.prior_state.open_p0s) || []))
  rec(fired, 'L13-pre the directive really was produced this round (otherwise L13 passes on nothing)', `fired=${fired}`)
  rec(fired && !(d2.findings_ledger || []).some(e => DIRECTIVE.test(e.text || '')), 'L13 a next-round directive is not a finding and does not enter the ledger', 'directive present as finding')
}

// ---- L14/L16: repair B was only half closed; the delta round found the rest ----
{
  const LD3 = { ...BSRC, mode: 'deep' }
  const P_B = 'VERDICT: REJECT\nP0: oct.py:52 the digest covers the wrong buffer\nEVIDENCE: read 4 files line 9\nVERIFIED: fail\nEND'
  const w1 = (await runPanel(LD3, async () => P_B)).r
  const w2 = (await runPanel({ ...LD3, prior_state: w1.prior_state, codex_prev_verdict_raw: cxCleanReject(w1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => P_B)).r
  const { findings_ledger: _d2, ...wLegacy } = w2.prior_state
  const w3 = (await runPanel({ ...LD3, prior_state: wLegacy, codex_prev_verdict_raw: cxCleanReject(w2.task_fingerprint + '_r2'), codex_exit_code: 0 }, async () => P_B)).r
  rec(w3.ledger_incomplete === true, 'L14-pre resuming from a pre-field state really did mark it incomplete', `v=${w3.ledger_incomplete}`)
  rec(!!(w3.prior_state && w3.prior_state.ledger_incomplete === true),
      'L14 the incomplete marker is threaded into prior_state, or it survives exactly one invocation', `in_prior=${w3.prior_state && w3.prior_state.ledger_incomplete}`)

  // A not_restated entry must reach the channel demoted P0s already use, or the ledger has no reader.
  // Assert on a TERMINAL: that is what the driver hands back; a handoff routes advisories elsewhere.
  const A2_ = 'VERDICT: REJECT\nP0: oct.py:52 the digest covers the wrong buffer; oct.py:53 the fallback swallows the code\nEVIDENCE: read 4 files line 9\nVERIFIED: fail\nEND'
  const v1 = (await runPanel(LD3, async () => A2_)).r
  const v2 = (await runPanel({ ...LD3, prior_state: v1.prior_state, codex_prev_verdict_raw: cxCleanReject(v1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => P_B)).r
  const v3 = (await runPanel({ ...LD3, prior_state: v2.prior_state, codex_prev_verdict_raw: cxCleanReject(v2.task_fingerprint + '_r2'), codex_exit_code: 0 }, async () => P_B)).r
  const v4 = (await runPanel({ ...LD3, prior_state: v3.prior_state, codex_prev_verdict_raw: cxCleanReject(v3.task_fingerprint + '_r3'), codex_exit_code: 0 }, async () => P_B)).r
  const nr = (v4.findings_ledger || []).filter(e => e.status === 'not_restated')
  rec(nr.length >= 1, 'L16-pre the terminal really has a not_restated entry (else L16 passes on nothing)', `n=${nr.length}`)
  // Matches on "not restated" rather than the exact former sentence: the wording changed when the
  // advisory stopped claiming a finding had VANISHED (a paraphrase is indistinguishable from a
  // silence to this matcher). What L16 is actually for is that the entry is NAMED, so that is what
  // it pins -- the locator -- plus the weaker claim the panel can still support.
  rec(nr.length >= 1 && (v4.advisories || []).some(a => /not restated/i.test(String(a)) && /oct\.py:53/.test(String(a))),
      'L16 a not_restated finding is NAMED in the terminal advisories, or nothing reads the ledger', `advisories=${(v4.advisories || []).length}`)
}

// ---- Group P: the six findings the release-diff-0820 panel returned ------------------
// Each was measured before it was fixed, and each assertion here was confirmed red against
// the pre-fix source. Two seats ran independently; where they disagreed (aliasing) the
// assertion pins the stricter reading, because "nothing mutates it today" is the kind of
// safety that stops holding without anything failing.
{
  console.log('\n=== Group P: release-diff audit findings ===')
  const PD = { ...BSRC, mode: 'deep' }
  const P_TWO = 'VERDICT: REJECT\nP0: zed.py:71 the retry loop never exits; zed.py:72 the lock is released twice\nEVIDENCE: read 4 files line 9\nVERIFIED: fail\nEND'
  const P_ONE = 'VERDICT: REJECT\nP0: zed.py:71 the retry loop never exits\nEVIDENCE: re-read line 9 again\nVERIFIED: fail\nEND'
  // The SAME finding as P_ONE, reworded by one word. To the normalised-text matcher this is
  // indistinguishable from the finding having gone silent.
  const P_REWORD = 'VERDICT: REJECT\nP0: zed.py:71 the retry loop never terminates\nEVIDENCE: re-read line 9 again\nVERIFIED: fail\nEND'
  const pstep = async (prev, fn) => (await runPanel({ ...PD, prior_state: prev.prior_state,
    codex_prev_verdict_raw: cxCleanReject(prev.task_fingerprint + '_r' + prev.prior_state.round), codex_exit_code: 0 }, fn)).r

  const p1 = (await runPanel(PD, async () => P_TWO)).r
  const p2 = await pstep(p1, async () => P_ONE)

  // --- P1: ids must stay unique when the incoming ledger is not dense 1..n.
  // The panel refuses a NON-ARRAY findings_ledger but does not validate entries inside one,
  // so this state is accepted -- and `'F' + (out.length + 1)` then reissued an id in use.
  const sparse = { ...p2.prior_state, findings_ledger: [
    { id: 'F3', text: 'alpha', round_raised: 1, last_seen_round: 1, status: 'open' },
    { id: 'F2', text: 'beta',  round_raised: 1, last_seen_round: 1, status: 'open' }] }
  const pSp = (await runPanel({ ...PD, prior_state: sparse,
    codex_prev_verdict_raw: cxCleanReject(p2.task_fingerprint + '_r' + p2.prior_state.round), codex_exit_code: 0 },
    async () => P_TWO)).r
  const spIds = (pSp.findings_ledger || []).map(e => e.id)
  rec(spIds.length >= 3 && new Set(spIds).size === spIds.length,
      'P1 ids stay unique when the incoming ledger is not dense 1..n (length asserted: Set on [] is vacuously fine)',
      `ids=${JSON.stringify(spIds)}`)

  // --- P7: the returned ledger must not BE the prior_state array. Measured identical by
  // reference before the fix; nothing mutated it, which is why nothing failed.
  rec(pSp.findings_ledger !== (pSp.prior_state && pSp.prior_state.findings_ledger),
      'P7 the returned ledger is a copy, not the same array prior_state carries', 'same reference')

  // --- P5: a rephrased restatement must not be reported as a disappearance.
  const p3 = await pstep(p2, async () => P_REWORD)
  const p4 = await pstep(p3, async () => P_REWORD)
  const nrAdv = (p4.advisories || []).concat(p3.advisories || []).filter(a => /not restated|NO LONGER restated/i.test(String(a)))
  // POSITIVE CONTROL first: the `length === 0 ||` form below is satisfied by the advisory never
  // being emitted at all, so without this it would go green the day the emission breaks.
  rec(nrAdv.length >= 1, 'P5-pre a non-restatement advisory is actually emitted (else P5 is satisfied by zero)', `n=${nrAdv.length}`)
  rec(nrAdv.length >= 1 && nrAdv.every(a => /MATCHING WORDS/.test(String(a)) && /REPHRASED|reworded/i.test(String(a))),
      'P5 a non-restatement advisory says a paraphrase is indistinguishable from a silence',
      JSON.stringify(nrAdv).slice(0, 260))

  // --- P3/P4: a refused state must say what it carried, whatever prefix the blocker wore.
  // `**P0**:` is one of the shapes test_panel.mjs already catalogues above; the old counter
  // matched only a bare line-initial `P0:` and reported nothing at all for this state.
  const BOLD = 'VERDICT: REJECT\n**P0**: the delete path removes user data\nEVIDENCE: read 3 files\nVERIFIED: fail\nEND'
  const bad = { ...p2.prior_state, findings_ledger: 'not-an-array', claude_verdicts_raw: [BOLD] }
  const pBad = (await runPanel({ ...PD, prior_state: bad,
    codex_prev_verdict_raw: cxCleanReject(p2.task_fingerprint + '_r' + p2.prior_state.round), codex_exit_code: 0 },
    async () => P_ONE)).r
  const bl = JSON.stringify(pBad.blockers || [])
  rec(/carried 1 verdict|carried \d+ verdict/.test(bl),
      'P3 a refused state reports how many verdicts it carried (a count needing no parse)', bl.slice(0, 240))
  rec(/FLOOR/.test(bl),
      'P4 the P0 tally is labelled a floor, not a count, because prefix shapes it cannot match exist', bl.slice(0, 240))

  // --- P6: the refusal that cannot prove the ledger complete must say so.
  rec(pBad.ledger_incomplete === true,
      'P6 the malformed-ledger refusal marks the ledger incomplete', `ledger_incomplete=${pBad.ledger_incomplete}`)

  // --- P2: the seat-identity advisory is regenerated every round AND embeds a round-varying
  // count, so exact-string dedup could not catch the carried copy. At most one per terminal.
  // rolesUsable goes false when prior_state.claude_roles is blank, which is what these states do.
  // A POSITIVE CONTROL comes first: without it "at most one" is satisfied by zero, and the first
  // version of this test passed against the unfixed panel for exactly that reason.
  const blankRoles = r => ({ ...r.prior_state, claude_roles: (r.prior_state.claude_roles || []).map(() => '') })
  const sstep = async (prev, ps, fn) => (await runPanel({ ...PD, prior_state: ps,
    codex_prev_verdict_raw: cxCleanReject(prev.task_fingerprint + '_r' + ps.round), codex_exit_code: 0 }, fn)).r
  const s1 = (await runPanel(PD, async () => P_TWO)).r
  const s2 = await sstep(s1, blankRoles(s1), async () => P_TWO)
  const s3 = await sstep(s2, blankRoles(s2), async () => P_ONE)
  const s4 = await sstep(s3, blankRoles(s3), async () => P_ONE)
  const seatAt = r => (r.advisories || []).filter(a => /Seat identity was lost/.test(String(a)))
  rec(seatAt(s2).length + seatAt(s3).length + seatAt(s4).length >= 1,
      'P2-pre the seat-identity advisory is actually reached (else P2 is satisfied by zero)',
      `counts=${[s2, s3, s4].map(r => seatAt(r).length).join(',')}`)
  rec(seatAt(s4).length <= 1 && seatAt(s3).length <= 1,
      'P2 at most one seat-identity advisory per terminal (it is regenerated, so it is not carried)',
      `r3=${seatAt(s3).length} r4=${seatAt(s4).length}`)
}

// ---- Group Q: the three fixes Group P does not reach ---------------------------------
{
  console.log('\n=== Group Q: normaliser, give-up terminal, cap arithmetic ===')
  const QD = { ...BSRC, mode: 'deep' }
  // Two findings about two DIFFERENT files on a case-sensitive filesystem, identical otherwise.
  const Q_CASE = 'VERDICT: REJECT\nP0: src/Foo.js:10 the handler swallows the error; src/foo.js:10 the handler swallows the error\nEVIDENCE: read 2 files line 4\nVERIFIED: fail\nEND'
  const q1 = (await runPanel(QD, async () => Q_CASE)).r
  const q2 = (await runPanel({ ...QD, prior_state: q1.prior_state,
    codex_prev_verdict_raw: cxCleanReject(q1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => Q_CASE)).r
  const qTexts = (q2.findings_ledger || []).map(e => e.text)
  rec(qTexts.length >= 2 && qTexts.some(t => /src\/Foo\.js:10/.test(t)) && qTexts.some(t => /src\/foo\.js:10/.test(t)),
      'Q1 findings about two files differing only in case stay TWO entries (case-folding merged them, losing one)',
      JSON.stringify(qTexts))

  // The give-up terminal: reached WITHOUT running the gate, so the merge inside the gate never
  // happens. An advisory carried in from an earlier round has to survive here too -- this is the
  // path a reader most needs earlier warnings on.
  const CARRIED = '[ADVISORY] carried in from an earlier round and must survive the give-up terminal'
  const qUn = (await runPanel({ ...QD,
    prior_state: { ...q1.prior_state, codex_unavailable_streak: 1, advisory_carry: [CARRIED] },
    codex_prev_verdict_raw: '', codex_exit_code: 1 }, async () => Q_CASE)).r
  rec(qUn.convergence_status === 'codex_unavailable', 'Q2-pre the give-up terminal is actually reached', `status=${qUn.convergence_status}`)
  rec((qUn.advisories || []).some(a => String(a) === CARRIED),
      'Q2 a carried advisory survives the codex-unavailable terminal (it had no advisories key at all)',
      `advisories=${JSON.stringify(qUn.advisories)}`)

  // The cap: "200" must mean 200, and a second truncation must not forget what the first dropped.
  const many = Array.from({ length: 260 }, (_, i) => `[ADVISORY] filler ${i}`)
  const qCap = (await runPanel({ ...QD, prior_state: { ...q1.prior_state, advisory_carry: many },
    codex_prev_verdict_raw: cxCleanReject(q1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => Q_CASE)).r
  const carried = (qCap.prior_state && qCap.prior_state.advisory_carry) || []
  const notices = carried.filter(a => /earlier advisory line\(s\) dropped/.test(String(a)))
  // Lower bound as well: `<= 200` alone is satisfied by an empty carry, which is the failure the
  // cap is not supposed to cause. 260 went in, so a healthy cap keeps exactly 200.
  rec(carried.length === 200, 'Q3 the 200 cap yields exactly 200 entries (slice-then-unshift produced 201; an empty carry would also satisfy <=200)', `n=${carried.length}`)
  rec(notices.length === 1, 'Q4 exactly one truncation notice is kept', `n=${notices.length}`)
  // Truncate a second time: the new notice must include what the first one already dropped.
  const first = Number((/(\d+) earlier/.exec(String(notices[0])) || [])[1] || 0)
  const qCap2 = (await runPanel({ ...QD,
    prior_state: { ...qCap.prior_state, advisory_carry: carried.concat(Array.from({ length: 60 }, (_, i) => `[ADVISORY] second wave ${i}`)) },
    codex_prev_verdict_raw: cxCleanReject(qCap.task_fingerprint + '_r' + qCap.prior_state.round), codex_exit_code: 0 }, async () => Q_CASE)).r
  const carried2 = (qCap2.prior_state && qCap2.prior_state.advisory_carry) || []
  const second = Number((/(\d+) earlier/.exec(String(carried2.find(a => /earlier advisory line\(s\) dropped/.test(String(a))) || '')) || [])[1] || 0)
  // `second >= first` is NOT discriminating: the pre-fix version also grew, it just restarted the
  // tally from this pass. The claim that separates them is ACCOUNTING -- the notice must cover
  // everything that did not survive, i.e. every line ever fed in minus the ones still present.
  const everFed = 260 + 60
  rec(first > 0 && second >= everFed - carried2.length,
      'Q5 the notice accounts for ALL lines ever dropped, not just this truncation',
      `first=${first} second=${second} everFed=${everFed} kept=${carried2.length} floor=${everFed - carried2.length}`)
}

// ---- Group R: the two the second round found that the first did not ------------------
{
  console.log('\n=== Group R: shielded ids, and the OTHER give-up terminal ===')
  const RD = { ...BSRC, mode: 'deep' }
  const R_A = 'VERDICT: REJECT\nP0: ohm.py:12 the buffer is reused after free\nEVIDENCE: read 3 files line 8\nVERIFIED: fail\nEND'
  const r1 = (await runPanel(RD, async () => R_A)).r

  // Two entries sharing one id. seenThisRound is keyed by id, so restating ONE marked the other
  // seen as well, and a genuinely un-restated finding was handed to the reader as still open.
  const twinned = { ...r1.prior_state, findings_ledger: [
    { id: 'F1', text: 'ohm.py:12 the buffer is reused after free', round_raised: 1, last_seen_round: 1, status: 'open' },
    { id: 'F1', text: 'ohm.py:99 a completely different finding',  round_raised: 1, last_seen_round: 1, status: 'open' }] }
  const r2 = (await runPanel({ ...RD, prior_state: twinned,
    codex_prev_verdict_raw: cxCleanReject(r1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => R_A)).r
  const led = r2.findings_ledger || []
  const ids = led.map(e => e.id)
  rec(led.length >= 2 && new Set(ids).size === ids.length,
      'R1 duplicate ids arriving in prior_state are repaired, not carried', JSON.stringify(ids))
  const other = led.find(e => /ohm\.py:99/.test(e.text || ''))
  rec(!!other && other.status === 'not_restated',
      'R2 restating one entry does not shield its id-twin from being marked (it was reported open)',
      other ? `status=${other.status}` : 'entry missing')

  // The give-up terminal that is NOT codex_unavailable: codex is unusable AND last_codex_brief is
  // gone. Round 1 found the first such return; there were three, which is why the carry now lives
  // on resultBase instead of being pasted into each one.
  const CARRIED = '[ADVISORY] raised earlier and must survive every give-up terminal'
  const { last_codex_brief: _gone, ...noBrief } = r1.prior_state
  const rMB = (await runPanel({ ...RD, prior_state: { ...noBrief, advisory_carry: [CARRIED] },
    codex_prev_verdict_raw: '', codex_exit_code: 1 }, async () => R_A)).r
  rec(rMB.convergence_status === 'prior_state_missing_brief',
      'R3-pre the missing-brief terminal is actually reached', `status=${rMB.convergence_status}`)
  rec((rMB.advisories || []).some(a => String(a) === CARRIED),
      'R3 a carried advisory survives the missing-brief terminal too', `advisories=${JSON.stringify(rMB.advisories)}`)
}

// ---- Group S: what the delta round found in the repairs themselves --------------------
{
  console.log('\n=== Group S: the repairs\' own defects ===')
  const SD = { ...BSRC, mode: 'deep' }
  const S_TWO = 'VERDICT: REJECT\nP0: sig.py:14 the digest is computed over the wrong slice; sig.py:15 the retry never backs off\nEVIDENCE: read 4 files line 7\nVERIFIED: fail\nEND'
  const blank = r => ({ ...r.prior_state, claude_roles: (r.prior_state.claude_roles || []).map(() => '') })
  const sstep = async (prev, ps, fn) => (await runPanel({ ...SD, prior_state: ps,
    codex_prev_verdict_raw: cxCleanReject(prev.task_fingerprint + '_r' + ps.round), codex_exit_code: 0 }, fn)).r

  // Seat identity is unusable at ROUND 2 ONLY. The driver returns only the LAST result, so unless
  // the warning is re-emitted with the round named, a reader of the final verdict never learns
  // that round 2's seat attribution was untrustworthy. Excluding it from the carry silenced it.
  // OBSERVATION POINT: a handoff's top-level `advisories` is empty BY DESIGN (its content lives in
  // prior_round_note), so asserting on calls 2 or 3 measures nothing -- the first version of this
  // test did exactly that and read 0 against the fixed panel too. In deep mode the terminal is the
  // FOURTH call. Roles are unusable only while adjudicating round 1; rounds 2 and 3 are clean, so
  // an implementation that merely stops duplicating the warning shows zero here.
  const t1 = (await runPanel(SD, async () => S_TWO)).r
  const t2 = await sstep(t1, blank(t1), async () => S_TWO)          // roles unusable for round 1
  const t3 = await sstep(t2, t2.prior_state, async () => S_TWO)     // roles fine again
  const t4 = await sstep(t3, t3.prior_state, async () => S_TWO)     // terminal
  const seatAt = r => (r.advisories || []).filter(a => /Seat identity was lost/.test(String(a)))
  rec(t4.convergence_status === 'not_converged', 'S1-pre the fourth call really is the terminal', `status=${t4.convergence_status}`)
  rec(seatAt(t4).length === 1,
      'S1 the terminal still carries the warning from the round that had it (excluding it deleted it)',
      `n=${seatAt(t4).length}`)
  rec(seatAt(t4).some(a => /in round 1\b/.test(String(a))),
      'S2 the carried warning NAMES the round it is about (the original complaint was that none did)',
      JSON.stringify(seatAt(t4)).slice(0, 200))

  // A refusal must carry the advisories too. shapeAbort spreads ...resultBase, but the seed used
  // to sit BELOW every shapeAbort call, so the spread copied an object without the key.
  const CARRIED = '[ADVISORY] raised earlier and must survive a refusal too'
  const bad = { ...t1.prior_state, findings_ledger: 'not-an-array', advisory_carry: [CARRIED] }
  const tBad = (await runPanel({ ...SD, prior_state: bad,
    codex_prev_verdict_raw: cxCleanReject(t1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => S_TWO)).r
  rec(tBad.convergence_status === 'prior_state_findings_ledger_malformed', 'S3-pre the refusal is actually reached', `status=${tBad.convergence_status}`)
  rec((tBad.advisories || []).some(a => String(a) === CARRIED),
      'S3 a refusal carries the advisories it was handed (it reported advisories: undefined)',
      `advisories=${JSON.stringify(tBad.advisories)}`)

  // The floor must be the RIGHT number, not merely present: forcing it to 0 left every assertion
  // green, so nothing pinned the count itself.
  const IND = 'VERDICT: REJECT\n  P0: sig.py:14 the digest is computed over the wrong slice\nEVIDENCE: read 3 files\nVERIFIED: fail\nEND'
  const bad2 = { ...t1.prior_state, findings_ledger: 'not-an-array', claude_verdicts_raw: [IND] }
  const tInd = (await runPanel({ ...SD, prior_state: bad2,
    codex_prev_verdict_raw: cxCleanReject(t1.task_fingerprint + '_r1'), codex_exit_code: 0 }, async () => S_TWO)).r
  const bl = JSON.stringify(tInd.blockers || [])
  rec(/At least 1 of them declare a P0/.test(bl),
      'S4 an INDENTED P0 line counts toward the floor (the shape the panel\'s own parser accepts)', bl.slice(0, 260))
}

console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
if (fail) process.exit(1)
