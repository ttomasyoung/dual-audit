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
const PANEL = resolve(HERE, '../runtime/core/dual-audit-panel.js')
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
const CLAUDE_CLEAN_R = 'VERDICT: REJECT\nP0: none\nEVIDENCE: reviewed line 5 structure ok\nVERIFIED: pass\nEND'  // clean fixture: only the consensus gate can block it
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
// ==== Claim-mode fixtures. Without these, every case would be code mode and the claim gates would never run. ====
const B_BIO = { task: 'judge a classification claim', kind: 'claim', contextPack: { raw_sources: ['/tmp/x.fasta'], canonical_docs: ['/tmp/canon.md'] } }
const CLAIM_A = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples match the reference batch\nANCHOR: anchored\nUNANCHORED_CLAIMS: none\nEND'
const CLAIM_UN = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples\nANCHOR: none\nUNANCHORED_CLAIMS: instrument drift not cross-validated\nEND'  // ANCHOR is not "anchored", so the claim gate blocks
const cxClaimA = id => `VERDICT: APPROVE\nP0: none\nEVIDENCE: 4 samples reference\nANCHOR: anchored\nUNANCHORED_CLAIMS: none\nAUDIT-ID: ${id}\nEND`
const R1bio = (await runPanel(B_BIO, async () => CLAIM_A)).r
const R1bioUn = (await runPanel(B_BIO, async () => CLAIM_UN)).r

const conv = (r) => r && r.converged === true && r.convergence_status === 'converged' && r.audit_stage === 'converged_r1' && (r.blockers || []).length === 0 && r.needs_expert_signoff === false
const CASES_B = [
  { n: 'B0 converges on a clean round',         args: R2ok,                                                        fn: () => CLAUDE_APPROVE, ok: conv },
  { n: 'B1 reviewer verdict with the wrong audit id',        args: { ...R2ok, codex_prev_verdict_raw: cxApprove(FP + '_r9') },   fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_verdict_identity_mismatch', g: 'if (!idOk) {', gf: 'if (false) {' },
  // The reviewer CLI prints its verdict twice and the wrapper marks both copies, so they arrive
  // identical. A large transcript gets shortened on the way here, and the marker survives in only one
  // of them: two blocks that differ by a single line this parser never reads. Judging that ambiguous
  // discarded a completed review — safe, but it made every large review unable to converge.
  { n: 'B1b the same verdict twice, the exit marker surviving in only one copy, still folds',
    args: { ...R2ok, codex_prev_verdict_raw: cxApprove(A1) + '\n\n' + cxApprove(A1).replace('\nEND', '\n__DUAL_AUDIT_RC=0\nEND') },
    fn: () => CLAUDE_APPROVE, ok: conv,
    g: '!/^[ \\t]*__[A-Z][A-Z0-9_]*=/.test(L)', gf: '!/^ZZZ_MATCHES_NOTHING$/.test(L)' },
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
  { n: 'B6 claude clean-REJECT',    args: { ...BSRC, prior_state: R1cr.prior_state, codex_prev_verdict_raw: cxApprove(A1cr), codex_exit_code: 0 }, fn: () => CLAUDE_CLEAN_R, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex',
    g: "if (valid.length && !valid.every(a => a.parsed.approves)) blockers.push('not all valid auditors APPROVE')", gf: "if (false) blockers.push('not all valid auditors APPROVE')" },
  { n: 'B7 circular reference in the arguments',           args: circ,                                                        fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && /AUDIT IDENTITY UNAVAILABLE/.test(r.error || ''), g: 'if (CTX_SIG == null || CTX_SIG_ERROR) {', gf: 'if (false && (CTX_SIG == null || CTX_SIG_ERROR)) {' },
  { n: 'B8 high risk with no independent source',           args: noSrc,                                                       fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.blockers || []).some(b => /no independent R1 source/.test(b)), g: 'if (n === 1 && !hasIndependentR1Source) {', gf: 'if (false) {' },
  // B9: with the frozen round-1 record missing at round 2 or later, removing the guard skips the whole
  // anti-flip section and converges falsely.
  { n: 'B9 frozen round 1 missing',          args: { ...BSRC, prior_state: psNoFrozen, codex_prev_verdict_raw: cxApprove(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'prior_state_frozen_r1_missing', g: 'if (prior && priorRoundValid && priorRound >= 2 && !frozenOk) {', gf: 'if (false) {' },
  // B10: the reviewer rejects in round 1 and approves in round 2 with a DELTA (so the delta gate is not
  // what blocks). The flip-stability gate must block; removing it converges falsely.
  { n: 'B10 anti-flip: reviewer flipped',   args: { ...BSRC, prior_state: ps2, codex_prev_verdict_raw: cxApproveDelta(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r3_pending_codex', g: 'if (codexFreshFlipHard) {', gf: 'if (false) {' },
  // B11: a cumulative budget already at the ceiling means this round would exceed it, so it is refused
  // before convergence rather than after.
  { n: 'B11 budget over the hard ceiling',          args: { ...BSRC, prior_state: { ...ps2, cumulative_used: 18 }, codex_prev_verdict_raw: cxApprove(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.blockers || []).some(b => /HARD_TOTAL_CEILING.*exceeded/.test(b)), g: 'if (ledger.totalUsed > HARD_TOTAL_CEILING) {', gf: 'if (false) {' },
  // B12: an approving verdict whose EVIDENCE contains no digit must not converge. Removing the digit
  // gate converges falsely.
  { n: 'B12 EVIDENCE without a digit does not converge',   args: { ...BSRC, prior_state: R1nd.prior_state, codex_prev_verdict_raw: cxApprove(A1nd), codex_exit_code: 0 }, fn: () => CA_NODIGIT, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex', g: 'if (unanchoredEvidence.length) blockers.push', gf: 'if (false) blockers.push' },
  // ==== Validity gate and the parser's negative paths. This is where a decisive hole once lived:
  //      forcing the validity flag to true made the ENTIRE suite pass. ====
  // B13: a missing P0 is caught by the validity gate alone (no downstream gate overlaps it), which makes
  // it a clean isolation: removing that sub-gate converges falsely.
  { n: 'B13 reviewer verdict missing P0 is invalid', args: { ...R2ok, codex_prev_verdict_raw: cxNoP0(A1) },       fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex', g: 'p0Raw !== null &&', gf: 'true &&' },
  // B15-B18 cover the parser's negative paths positively: a malformed verdict must not be treated as a
  // valid approval. Their mutants are covered by the downstream defence-in-depth gates instead.
  { n: 'B15 reviewer verdict missing VERIFIED does not converge', args: { ...R2ok, codex_prev_verdict_raw: cxNoVerified(A1) }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex' },
  { n: 'B16 reviewer EVIDENCE without a digit does not converge',   args: { ...R2ok, codex_prev_verdict_raw: cxEvNoDigit(A1) },  fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex' },
  { n: 'B17 placeholder inside the reviewer block does not converge',   args: { ...R2ok, codex_prev_verdict_raw: cxPlaceholder(A1) },fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex' },
  { n: 'B18 reviewer verdict with no VERDICT fails identity',        args: { ...R2ok, codex_prev_verdict_raw: cxNoVerdict(A1) },  fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_verdict_identity_mismatch' },
  // B19 is the Claude-side anti-flip: round 1 rejects, round 2 approves with a DELTA (a genuine flip)
  // while the reviewer approves throughout, so the Claude flip gate must block. Removing it converges falsely.
  { n: 'B19 anti-flip: Claude side flipped',   args: { ...BSRC, prior_state: R2cr.prior_state, codex_prev_verdict_raw: cxApprove(R1cr.task_fingerprint + '_r2'), codex_exit_code: 0 }, fn: () => CA_DELTA, ok: r => r.converged === false && r.convergence_status === 'r3_pending_codex', g: 'if (claudeFreshFlipHard) {', gf: 'if (false) {' },
  // ==== The remaining live exits ====
  // B20: consecutive unavailable reviewer attempts reach the cap and escalate, which is different from
  // the single-attempt retry cases above.
  { n: 'B20 codex_unavailable escalate', args: { ...BSRC, prior_state: { ...R1.prior_state, codex_unavailable_streak: 1 }, codex_prev_verdict_raw: cxApprove(A1), codex_exit_code: 1 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'codex_unavailable', g: 'if (streak >= MAX_CODEX_UNAVAIL) {', gf: 'if (false) {' },
  // B21: the TOTAL budget is exhausted when a new round would open, which is a different exit from B11.
  { n: 'B21 hard ceiling blocks opening another round', args: { ...BSRC, prior_state: { ...ps2, cumulative_used: 17 }, codex_prev_verdict_raw: cxCleanReject(A2), codex_exit_code: 0 }, fn: () => CLAUDE_CLEAN_R, ok: r => r.converged === false && (r.blockers || []).some(b => /HARD_TOTAL_CEILING.*reached/.test(b)), g: 'if (ledger.totalUsed >= HARD_TOTAL_CEILING) {   // P0-3', gf: 'if (false) {   // P0-3' },
  // B22: at round 2 or later a missing prev_round_stance must be refused. The fixture gives the reviewer a
  // DELTA (so the delta gate is not what blocks) and keeps the Claude side stably approving (so the flip
  // gate is not what blocks), which leaves the missing-state guard as the ONLY thing that can block —
  // otherwise another gate would mask it and the mutant would look killed when it was not.
  { n: 'B22 missing prev_round_stance is refused', args: { ...BSRC, prior_state: psNoStance, codex_prev_verdict_raw: cxApproveDelta(A2), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && r.convergence_status === 'r3_pending_codex', g: 'if (priorRound >= 2 && !prevStanceUsable) {', gf: 'if (false) {' },
  // B25: a blocker reachable only by reading a value the gates never consult must not converge. The
  // reviewer is told verbatim that anything outside the field shapes is refused rather than
  // reinterpreted; until this gate existed the parser only warned and the round approved.
  { n: 'B25 a blocker hidden inside another field value cannot converge',
    args: { ...BSRC, prior_state: R1hid.prior_state, codex_prev_verdict_raw: cxApprove(R1hid.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_HIDDEN_P0, ok: r => r.converged === false,
    g: ' && !hidesGatingField', gf: '' },
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
    fn: () => CLAUDE_WIDE_COLON, ok: r => r.converged === false },
  // B30: the good case for B25/B29. Reviewers discuss these fields in prose constantly; an earlier
  // version of the rule refused 15 of 76 real verdicts for exactly this.
  { n: 'B30 prose naming a field, with a real blocker recorded, is not refused',
    args: { ...BSRC, prior_state: R1tlk.prior_state, codex_prev_verdict_raw: cxCleanReject(R1tlk.task_fingerprint + '_r1'), codex_exit_code: 0 },
    fn: () => CLAUDE_TALKS_ABOUT, ok: r => r.convergence_status !== 'prior_state_schema_invalid' },
  // ==== ⑤ claim fixtures + ⑥ claim gate ====
  { n: 'B23 claim mode converges on a clean anchored round', args: { ...B_BIO, prior_state: R1bio.prior_state, codex_prev_verdict_raw: cxClaimA(R1bio.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_A, ok: r => r.converged === true && r.convergence_status === 'converged' && (r.blockers || []).length === 0 && r.needs_expert_signoff === false },
  // B24: a Claude verdict whose ANCHOR is not "anchored" must be blocked by the claim gate.
  { n: 'B24 an unanchored claim is blocked by the claim gate', args: { ...B_BIO, prior_state: R1bioUn.prior_state, codex_prev_verdict_raw: cxClaimA(R1bioUn.task_fingerprint + '_r1'), codex_exit_code: 0 }, fn: () => CLAIM_UN, ok: r => r.converged === false && r.convergence_status === 'r2_pending_codex', g: "if (claimGap) blockers.push('claims not fully anchored", gf: "if (false) blockers.push('claims not fully anchored" },
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
  const ps3c  = (await runPanel({ ...BSRC, prior_state: ps2, codex_prev_verdict_raw: cxApproveDelta(A2), codex_exit_code: 0 }, () => CLAUDE_APPROVE)).r
  const ps3cl = (await runPanel({ ...BSRC, prior_state: R2cr.prior_state, codex_prev_verdict_raw: cxApprove(R1cr.task_fingerprint + '_r2'), codex_exit_code: 0 }, () => CA_NODELTA)).r
  const okPend = r => r.converged === false && r.convergence_status === 'r2_pending_codex'
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
    { n: 'D9 delta gate: a round-3 reviewer flip against frozen round 1 without a DELTA', args: { ...BSRC, prior_state: ps3c.prior_state, codex_prev_verdict_raw: cxApprove(ps3c.prior_state.task_fingerprint + '_r3'), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.gate_codes || []).includes('DELTA-GATE:codex'), g: 'if (codexFlippedUp && deltaMissingOrExplicitlyUnchanged) {', gf: 'if (false) {' },
    { n: 'D10 delta gate: a round-3 Claude flip against frozen round 1 without a DELTA', args: { ...BSRC, prior_state: ps3cl.prior_state, codex_prev_verdict_raw: cxApprove(ps3cl.prior_state.task_fingerprint + '_r3'), codex_exit_code: 0 }, fn: () => CLAUDE_APPROVE, ok: r => r.converged === false && (r.gate_codes || []).includes('DELTA-GATE:claude'), g: 'if (claudeFlippedUp && !claudeGaveNonEmptyDelta) {', gf: 'if (false) {' },
  ]
  for (const c of DCASES) { const { r } = await runPanel(c.args, c.fn).catch(e => ({ r: { __throw: e.message } })); rec(!r.__throw && c.ok(r), c.n, r.__throw || `converged=${r.converged} status=${r.convergence_status}`) }
  for (const c of DCASES) { const k = await mutKill(c.args, c.fn, c.ok, c.g, c.gf, true); if (k.threw) threwNote++; rec(k.kill, c.n + '[mut]' + (k.threw ? '(crashed)' : ''), k.why) }  // requireConverged=true: only a mutant that actually converges counts as a clean kill here
}

console.log('\n[note] the round-overflow backstop is provably unreachable: the round number is only ever\n'
  + '       set to 1, or to priorRound+1 while priorRound is below the allowance. It is not counted as a killable mutant.')
console.log(`[note] ${threwNote} mutant(s) crashed rather than failing an assertion. A crash counts as a FAILURE,
       not a kill: it is weak evidence that the guard was doing the work, so such a mutant must be replaced
       by one that does not crash. This should be 0.`)
console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
if (fail) process.exit(1)
