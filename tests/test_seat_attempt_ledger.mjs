// Gate for the seat attempt ledger (defect: an interrupted seat's work is discarded silently).
// Same mechanism as test_panel.mjs: read the source, wrap it in an AsyncFunction with stubs, inspect
// what the panel actually emits. Points at the LIVE panel via DUAL_AUDIT_PANEL.
//
// TEETH: every assertion below is paired with a single-point MUTANT that must make it fail. An
// assertion no mutant can break is decoration. A mutant that CRASHES is reported separately from one
// that fails the assertion - only the latter is a clean kill.
// Run: node tests/test_seat_attempt_ledger.mjs   (0 = green, 1 = failures)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = process.env.DUAL_AUDIT_PANEL || resolve(HERE, '../runtime/core/dual-audit-panel.js')
const SRC0 = readFileSync(PANEL, 'utf8').replace('export const meta', 'const meta')
const AF = Object.getPrototypeOf(async function () {}).constructor

async function runPanel(args, agentFn, mutate) {
  const src = mutate ? mutate(SRC0) : SRC0
  const prompts = []
  const stub = {
    agent: async (p, o) => { prompts.push(String(p)); return agentFn ? await agentFn(p, o) : '' },
    parallel: async (t) => Promise.all(t.map(x => x())),
    log: () => {}, phase: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  }
  const fn = new AF('args', 'agent', 'parallel', 'log', 'phase', 'budget', src)
  const r = await fn(args, stub.agent, stub.parallel, stub.log, stub.phase, stub.budget)
  return { r, prompts }
}

const V  = 'VERDICT: APPROVE\nP0: none\nEVIDENCE: ran regression 462/0 at line 1191\nVERIFIED: pass\nEND'
const V2 = 'VERDICT: APPROVE\nP0: none\nATTEMPT: 2\nEVIDENCE: ran regression 462/0 at line 1191\nVERIFIED: pass\nEND'
const BASE = { task: 't', kind: 'code', contextPack: { targets: ['/tmp/x.py'], expected: 'cols=3' } }

// These three arms EXECUTE the emitted commands, so they need the directory the panel ACTUALLY
// writes to. Reconstructing it from the run_id is what broke: the slug gained an unconditional hash
// suffix, the reconstructed path stopped matching, cleanup silently cleaned nothing, and residue from
// an earlier run made the next one fail. Parse the real path out of the command instead — the command
// is the single source of truth, and the prompt is built without running anything.
async function ledgerCmds(rid, mut) {
  const { prompts } = await runPanel({ ...BASE, run_id: rid }, () => V, mut)
  const lines = prompts[0].split('\n')
  const start = (lines.find(l => l.includes('mkdir -p /tmp/dual-audit/.attempts/')) || '').trim()
  const done = (lines.find(l => l.includes('echo "__DA_SEAT_DONE__') && !l.includes('mkdir')) || '').trim()
  // \S+ is greedy and swallowed the command separator, so `dir` ended in ';' and rmSync deleted a
  // path that does not exist — cleanup silently did nothing and the SECOND run of the suite failed on
  // its own residue. Stop at the separator.
  const dir = (start.match(/mkdir -p ([^\s;]+)/) || [])[1] || ''
  if (!start || !dir) throw new Error('ledger command not found in the prompt')
  const wipe = () => { try { rmSync(dir, { recursive: true, force: true }) } catch (e) { /* absent */ } }
  // The command prints more than one line (PRIOR_ATTEMPTS and REPORT_ATTEMPT), so comparing the whole
  // output breaks whenever a line is added — it did, on the very next change. Return the field asked for.
  const runRaw = (c) => execSync(c, { shell: '/bin/bash', encoding: 'utf8' }).trim()
  const run = (c, field = 'PRIOR_ATTEMPTS') => {
    const out = runRaw(c)
    const m = out.match(new RegExp('^' + field + '=(\\d+)$', 'm'))
    return m ? field + '=' + m[1] : out
  }
  return { start, done, dir, wipe, run, runRaw }
}

// ---- the assertions, each a function so a mutant can be run through the same code -------------
const CASES = {
  // POSITIVE: with a run_id, every seat is told to keep an attempt ledger under that run's partition.
  positive: async (mut) => {
    const { prompts } = await runPanel({ ...BASE, run_id: 'ep-alpha-01' }, () => V, mut)
    if (!prompts.length) throw new Error('no seats spawned')
    // The slug now ALWAYS carries a hash suffix, so assert the prefix rather than an exact path.
    return prompts.every(p => p.includes('ATTEMPT LEDGER')
      && /\/tmp\/dual-audit\/\.attempts\/ep-alpha-01-[0-9a-z]+\//.test(p))
  },
  // NEGATIVE (the arm that makes this a gate): with NO run_id there is no partition key, so the
  // ledger must be OFF rather than falling back to a shared fixed path.
  negative: async (mut) => {
    const { prompts } = await runPanel({ ...BASE }, () => V, mut)
    if (!prompts.length) throw new Error('no seats spawned')
    return prompts.every(p => !p.includes('.attempts'))
  },
  // INJECTION: run_id is caller-supplied and lands inside a shell command in the prompt.
  injection: async (mut) => {
    const { prompts } = await runPanel({ ...BASE, run_id: 'a;rm -rf /;$(id)`x`' }, () => V, mut)
    const slug = (prompts[0].match(/\.attempts\/([^\s\/]+)\//) || [])[1] || ''
    return /^[A-Za-z0-9._-]+$/.test(slug) && !slug.includes(';') && !slug.includes('$')
  },
  // TRAVERSAL: `..` must not survive into the path.
  traversal: async (mut) => {
    const { prompts } = await runPanel({ ...BASE, run_id: '../../etc/cron.d' }, () => V, mut)
    const slug = (prompts[0].match(/\.attempts\/([^\s\/]+)\//) || [])[1] || ''
    return !slug.includes('..') && !slug.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(slug)
  },
  // NON-REGRESSION, the dangerous one: FIELD_NAMES is a CLOSED grammar. A verdict carrying the new
  // ATTEMPT field must behave IDENTICALLY to the same verdict without it - same validity, same
  // convergence - or a change meant to surface lost work would start invalidating good verdicts.
  inert: async (mut) => {
    const A = await runPanel({ ...BASE, run_id: 'ep-x' }, () => V, mut)
    const B = await runPanel({ ...BASE, run_id: 'ep-x' }, () => V2, mut)
    const norm = (o) => JSON.stringify(o).split('ATTEMPT: 2\\n').join('')
      .replace(/"seat_retries":\d+/g, '"seat_retries":0')
      .replace(/"seat_retries_cumulative":\d+/g, '"seat_retries_cumulative":0')
    return norm(A.r) === norm(B.r)
  },
  // EXECUTABLE (the arm that earns its keep): the ledger lives in a PROMPT, so every other assertion
  // here only proves the panel EMITS a string. This one RUNS it. The first version of that command
  // chained with `&&` and `grep -c` exits 1 when it counts zero - the normal first-seat case - so the
  // chain aborted before appending and the ledger was permanently empty while every string-shaped
  // assertion stayed green. Asserting on the text of a command is not asserting on its behaviour.
  executable: async (mut) => {
    const { start, wipe, run } = await ledgerCmds('gate-exec-probe', mut)
    wipe()
    const out1 = run(start)
    const out2 = run(start)
    wipe()
    return out1 === 'PRIOR_ATTEMPTS=0' && out2 === 'PRIOR_ATTEMPTS=1'
  },
  // 🔴 THE REGRESSION THE REVIEW PANEL FOUND (F1/F2). panel_cap_guard mandates the SAME episode for
  // every launch of one problem, the driver derives run_id from it, and /tmp keeps these files for
  // weeks -- so counting STARTS made launches 2 and 3 of any audit report retries that never happened.
  // A seat that ran and RETURNED must leave the counter at zero. Start, finish, start again => 0.
  completion_clears: async (mut) => {
    const { start, done, wipe, run } = await ledgerCmds('gate-completion-probe', mut)
    if (!done) throw new Error('DONE command not found in the prompt')
    wipe()
    const a = run(start); run(done)   // launch 1 starts and finishes normally
    const b = run(start); run(done)   // launch 2 of the SAME episode
    const c = run(start)              // launch 3
    wipe()
    return a === 'PRIOR_ATTEMPTS=0' && b === 'PRIOR_ATTEMPTS=0' && c === 'PRIOR_ATTEMPTS=0'
  },
  // ...and the other side of it: a start with NO completion is exactly what must be reported.
  interrupted_counts: async (mut) => {
    const { start, wipe, run } = await ledgerCmds('gate-interrupt-probe', mut)
    wipe()
    const a = run(start)   // starts, never finishes (interrupted)
    const b = run(start)   // the replacement seat
    wipe()
    return a === 'PRIOR_ATTEMPTS=0' && b === 'PRIOR_ATTEMPTS=1'
  },
  // F5: the sanitiser is lossy, so two DIFFERENT run_ids must still get DIFFERENT ledger paths.
  slug_injective: async (mut) => {
    const slug = async (rid) => {
      const { prompts } = await runPanel({ ...BASE, run_id: rid }, () => V, mut)
      return (prompts[0].match(/\.attempts\/([^\s\/]+)\//) || [])[1] || ''
    }
    const a = await slug('proj/alpha'), b = await slug('proj?alpha')
    return !!a && !!b && a !== b
  },
  // 🔴 R3 counter-example, supplied by the review panel after my own 410-sample sweep said "no
  // collisions". It was right and the sweep was wrong: it never fed an id that EQUALS another id's
  // COMPUTED slug. `proj/alpha` sanitises and takes the suffixed branch to `proj_alpha-dda7hp`;
  // the literal id `proj_alpha-dda7hp` is already legal, took the UNsuffixed branch, and landed on
  // the same string. The branch asymmetry was the bug. Pinned here with the literal pair.
  slug_fixpoint: async (mut) => {
    const slug = async (rid) => {
      const { prompts } = await runPanel({ ...BASE, run_id: rid }, () => V, mut)
      return (prompts[0].match(/\.attempts\/([^\s\/]+)\//) || [])[1] || ''
    }
    const a = await slug('proj/alpha')
    const b = await slug('proj_alpha-dda7hp')
    return !!a && !!b && a !== b
  },
  // F3: the count must survive the round handoff, or the driver's terminal result always reads 0.
  survives_handoff: async (mut) => {
    const { r } = await runPanel({ ...BASE, run_id: 'ep-x' }, () => V2, mut)
    return !!(r && r.prior_state && r.prior_state.seat_retries_cumulative >= 1)
  },
  // 🔴 R2 finding: the scope qualifier was added to exactly ONE of eleven `agent_budget` literals, and
  // that one was the internal handoff the driver never returns — so it reached nobody while every
  // terminal emitted a bare count. Two arms, because one is not enough:
  //   dynamic — the object we can actually reach must carry it;
  //   static  — no `agent_budget: {` literal may remain, which is the only assertion that covers all
  //             eleven sites including the terminals this harness cannot drive to. Asserting only on
  //             the reachable one is how the first miss happened.
  scope_on_reachable_output: async (mut) => {
    const { r } = await runPanel({ ...BASE, run_id: 'ep-x' }, () => V2, mut)
    const s = r && r.agent_budget && r.agent_budget.seat_retries_scope
    return typeof s === 'string' && /claude_seats_only/.test(s) && /read-only/.test(s)
  },
  scope_cannot_drift: async (mut) => {
    const src = mut ? mut(SRC0) : SRC0
    const literals = (src.match(/agent_budget:\s*\{/g) || []).length
    const viaCtor = (src.match(/agent_budget:\s*agentBudget\(/g) || []).length
    return literals === 0 && viaCtor >= 11
  },
  // 🔴 The legacy forward path (codex_mode:'forward') shipped without `--emit-rc` and without telling
  // the runner to pass the Bash tool's timeout. Both are load-bearing: no RC marker => the driver reads
  // "codex unavailable"; no timeout => killed at the 120s default with an EMPTY stdout, which is
  // byte-identical to "found nothing". Dormant paths are exactly where this rots unnoticed, so it is
  // pinned even though the default mode never reaches it.
  // Refusing only the exact token left every near-miss falling through to the default: measured,
  // 'forwrad' / 'fwd' / 'forwards' each ran an ordinary deferred round with no error — the SAME silent
  // downgrade the guard exists to stop. A whitelist is the only shape that closes the class; testing
  // the one spelled-correctly value is how the first version passed while still being broken.
  codex_mode_is_a_whitelist: async (mut) => {
    for (const bad of ['forward', 'forwrad', 'fwd', 'forwards', 'FORWARD']) {
      const { r, prompts } = await runPanel({ ...BASE, codex_mode: bad }, () => V, mut)
      if (!(r && r.converged === false && typeof r.error === 'string'
            && /not recognised|orphaned/i.test(r.error) && prompts.length === 0)) return false
    }
    // ...and the legitimate values must still run, or the guard is just breakage.
    for (const ok of ['deferred', undefined]) {
      const { prompts } = await runPanel({ ...BASE, codex_mode: ok }, () => V, mut)
      if (prompts.length === 0) return false
    }
    return true
  },
  // The seat must not be asked to do arithmetic: measured, both seats read PRIOR_ATTEMPTS=2 correctly
  // and then wrote `ATTEMPT: 2` instead of 3, so the panel under-counted discarded work.
  command_precomputes_the_reported_number: async (mut) => {
    const { prompts } = await runPanel({ ...BASE, run_id: 'ep-report' }, () => V, mut)
    const p0 = prompts[0] || ''
    return /REPORT_ATTEMPT=\$\(\(PRIOR\+1\)\)/.test(p0) && /copy the REPORT_ATTEMPT number/.test(p0)
  },
  // COUNTED: a reported retry must actually reach the returned ledger, not just a log line nobody reads.
  counted: async (mut) => {
    const { r } = await runPanel({ ...BASE, run_id: 'ep-x' }, () => V2, mut)
    return !!(r && r.agent_budget && r.agent_budget.seat_retries >= 1)
  },
}

// ---- mutants: {name, patch, mustKill: [case names]} --------------------------------------------
const MUTANTS = [
  { name: 'sanitiser removed', mustKill: ['injection', 'traversal'],
    patch: s => s.replace("RUN_ID.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 48)", 'RUN_ID') },
  { name: 'empty-run_id guard removed', mustKill: ['negative'],
    patch: s => s.replace("  if (!RUN_SLUG) return ''   // no partition key -> disabled, see RUN_SLUG\n", '') },
  { name: 'ledger note never emitted', mustKill: ['positive'],
    patch: s => s.replace('    attemptLedgerNote(tag),\n', '') },
  { name: "ATTEMPT dropped from closed grammar", mustKill: ['inert'],
    patch: s => s.replace("'AUDIT-ID', 'ATTEMPT']", "'AUDIT-ID']") },
  // Same class as the original `&&` defect: the counting path must be TOTAL. Without `touch`, grep
  // runs on a missing file, prints nothing, and the arithmetic expansion breaks -- the command fails
  // instead of reporting 0. Asserting on the command's text would never notice.
  { name: 'touch dropped (count path no longer total)', mustKill: ['executable', 'interrupted_counts'],
    patch: s => s.replace("'  mkdir -p ' + dir + '; touch ' + f + '; PRIOR=", "'  mkdir -p ' + dir + '; PRIOR=") },
  // Reverting to "count starts" -- the exact defect the review panel reproduced.
  { name: 'counts STARTS not unfinished starts (DONE term dropped)', mustKill: ['completion_clears'],
    patch: s => s.replace('$(( $(grep -c \"^\' + S + \'\" \' + f + \') - $(grep -c \"^\' + D + \'\" \' + f + \') ))',
                          '$(grep -c \"^\' + S + \'\" \' + f + \')') },
  { name: 'slug hash suffix dropped entirely', mustKill: ['slug_injective'],
    patch: s => s.replace("((_slugBody || 'run') + '-' + _fnv1a(RUN_ID))", "(_slugBody || 'run')") },
  // Restoring the "suffix only when sanitising changed something" branch — the exact R3 defect.
  { name: 'suffix made conditional again (branch asymmetry returns)', mustKill: ['slug_fixpoint'],
    patch: s => s.replace("const RUN_SLUG = !RUN_ID ? '' : ((_slugBody || 'run') + '-' + _fnv1a(RUN_ID))",
                          "const RUN_SLUG = !RUN_ID ? '' : (_slugBody === RUN_ID ? _slugBody : ((_slugBody || 'run') + '-' + _fnv1a(RUN_ID)))") },
  { name: 'retry count not threaded into prior_state', mustKill: ['survives_handoff'],
    patch: s => s.replace('    seat_retries_cumulative: ledger.seatRetries,', '') },
  { name: 'scope qualifier removed from the constructor', mustKill: ['scope_on_reachable_output'],
    patch: s => s.replace('    seat_retries: ledger.seatRetries, seat_retries_scope: SEAT_RETRIES_SCOPE,\n',
                          '    seat_retries: ledger.seatRetries,\n') },
  // One site reverted to a literal — the exact drift the constructor exists to make impossible.
  { name: 'one agent_budget reverted to a literal', mustKill: ['scope_cannot_drift'],
    patch: s => s.replace('agent_budget: agentBudget({ codex_in_main_loop: priorRound })',
                          'agent_budget: { total_used: ledger.totalUsed, codex_in_main_loop: priorRound }') },
  // Restoring the silent acceptance — the actual shipped defect, where the flag lied.
  { name: 'whitelist narrowed back to the exact token (typos slip through)', mustKill: ['codex_mode_is_a_whitelist'],
    patch: s => s.replace("if (!CODEX_MODE_VALID.includes(CODEX_MODE_RAW)) {", "if (CODEX_MODE_RAW === 'forward') {") },
  { name: 'seat told to compute PRIOR+1 itself again', mustKill: ['command_precomputes_the_reported_number'],
    patch: s => s.replace('; echo "REPORT_ATTEMPT=$((PRIOR+1))"', '') },
  { name: "codex_mode guard removed entirely", mustKill: ['codex_mode_is_a_whitelist'],
    patch: s => s.replace("if (!CODEX_MODE_VALID.includes(CODEX_MODE_RAW)) {", "if (false) {") },
  { name: 'attempt always reads as 1', mustKill: ['counted'],
    patch: s => s.replace('? parseInt(attemptRaw, 10) : 1', '? 1 : 1') },
]

let fail = 0
console.log('--- baseline: every case must pass against the unmutated live panel ---')
const base = {}
for (const [n, f] of Object.entries(CASES)) {
  let ok, err = null
  try { ok = await f(null) } catch (e) { ok = false; err = e.message }
  base[n] = ok
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${err ? '  (' + err + ')' : ''}`)
  if (!ok) fail++
}

console.log('--- calibration: each mutant must be KILLED by the case(s) named ---')
for (const m of MUTANTS) {
  const patched = m.patch(SRC0)
  if (patched === SRC0) { console.log(`  NOT-APPLIED  ${m.name}  <- patch matched nothing; the assertion it calibrates is UNVALIDATED`); fail++; continue }
  for (const cn of m.mustKill) {
    let ok, crashed = false
    try { ok = await CASES[cn](m.patch) } catch (e) { crashed = true; ok = false }
    const killed = !ok
    console.log(`  ${killed ? (crashed ? 'KILLED(crash)' : 'KILLED') : 'SURVIVED'}  ${m.name}  vs  ${cn}`)
    if (!killed) fail++
  }
}

const total = Object.keys(CASES).length + MUTANTS.reduce((n, m) => n + m.mustKill.length, 0)
console.log(`\n=== RESULT: ${total - fail} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
