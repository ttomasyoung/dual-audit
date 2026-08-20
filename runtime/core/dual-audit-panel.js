// dual-audit:package-file (installed by dual-audit; ownership marker — do not remove)
export const meta = {
  name: 'dual-audit-panel',
  description: 'Bounded Claude+Codex dual-audit panel for a long chained scientific workflow. HARD CAP <=3 rounds x (<=3 Claude + <=3 Codex)=18, fail-closed. R1 INDEPENDENT: round 1 Claude and Codex each read the RAW sources themselves and form independent verdicts — Codex is NEVER fed Claude\'s summary/verdict (that would bias it into a rubber stamp); round 2+ is the SHARING phase (both sides see each others\' raw R1 verdicts and cross-examine, R1 frozen, changing a verdict only because the other side was more confident does NOT count as convergence). Independence is NOT unbounded exploration: the Codex brief carries an explicit read-allowlist + forbids whole-tree grep + time-box. Two co-equal hard gates: (1) BIOLOGY correctness — definitions/conclusions must be right; literature & prior definitions are NOT automatically true (trace the evidence chain, scrutinize method, cross-validate); AI agreement is NOT truth, so claims must anchor to a decisive cross-validated evidence chain or escalate to the human expert. (2) CODE/OUTPUT correctness — smoke-test + dry-run, independently verified by BOTH a read-only Codex side (static/contract) and a Claude side (isolated run), because an unverified bug propagates down the chain. Codex runs READ-ONLY (codex exec --sandbox read-only) in the MAIN LOOP on the frozen per-round brief; the panel hands off after each round and is re-invoked with the codex verdict (one round per invocation).',
  whenToUse: 'High-stakes links in the work chain that would be costly if wrong: family/canonical determination, coordination/binding interpretation, threshold/biological-parameter changes, a pipeline stage whose output feeds downstream, phase plans, SOP changes, HPC sbatch / destructive ops. NOT for trivial doc edits or throwaway one-offs.',
  phases: [
    { title: 'Round 1 (independent)', detail: 'Claude side reads raw + produces auditable artifact; Codex (main loop) independently reads the SAME raw sources — neither sees the other' },
    { title: 'Round 2 (cross-examine)', detail: 'escalate ONLY if R1 did not converge: both sides see each others\' raw R1 verdicts + issue ledger and cross-examine (R1 frozen)' },
    { title: 'Round 3 (cross-examine)', detail: 'escalate ONLY if still diverging: final cross-examination, then converge or escalate to user' },
  ],
}

// ============ HARD CAPS (workflow-internal, fail-closed; NOT a harness global cap) ============
const MAX_ROUNDS = 3
const MAX_CLAUDE_PER_ROUND = 3   // Review-only panel: at most 3 Claude auditors per side per round (workers were removed and take no seats)
const MAX_CODEX_PER_ROUND = 3
const HARD_TOTAL_CEILING = MAX_ROUNDS * (MAX_CLAUDE_PER_ROUND + MAX_CODEX_PER_ROUND) // 18 = absolute fail-closed backstop
const MAX_CODEX_UNAVAIL = 2   // false-death angle: after this many consecutive UNAVAILABLE codex attempts (empty stdout / killed / nonzero exit / MISSING or malformed exit code) for a round, escalate (don't burn budget re-running, don't silently restart R1)
// NOTE: 18 is the backstop for legacy 'forward' mode (<=3 codex spawned in-panel per round). In the DEFAULT
// 'deferred' mode codex runs ONCE per round in the MAIN LOOP (counted via `ledger.totalUsed += 1` at STEP A),
// so the real agent max ~= MAX_ROUNDS * (MAX_CLAUDE_PER_ROUND + 1) = 12; the practical bound is roundsAllowed.

// ---- Args (normalized + enum-validated; default toward MORE checking) ----
// args may arrive as an object OR as a JSON string (harness-dependent) OR as a plain task string
let input
if (typeof args === 'string') {
  const s = args.trim()
  if (s[0] === '{') { try { const p = JSON.parse(s); input = (p && typeof p === 'object') ? p : { task: args } } catch (e) { input = { task: args } } }
  else input = { task: args }
} else input = (args && typeof args === 'object') ? args : {}
const norm = (v, d) => (v == null ? d : String(v)).trim().toLowerCase()
const TASK = (input.task == null ? '' : String(input.task)).trim()
// CONTEXT may be Claude-authored notes -> it is used on the CLAUDE side only and is NEVER put into the
// independent R1 Codex brief (provenance discipline). USER_RAW = the user's OWN words, safe for R1.
const CONTEXT = (input.context == null ? '' : String(input.context)).trim()
const USER_RAW = (input.user_context_raw == null ? '' : String(input.user_context_raw)).trim()
const PROJECT = (input.project == null ? '' : String(input.project)).trim()
// A misspelt risk (e.g. 'hgh') used to fall through to normal, so a task that should have been
//   high ran fewer auditor seats and skipped the canonical-doc requirement. Now: absent -> normal
//   (unchanged); PROVIDED BUT UNRECOGNISED -> fail-SAFE to high, never a silent downgrade. (A
const _riskRaw = norm(input.risk, '')
const RISK = _riskRaw === '' ? 'normal' : ((_riskRaw === 'high' || _riskRaw === 'normal') ? _riskRaw : 'high')
// 'biology' -> 'claim': the mode actually governs NON-CODE FACTUAL CLAIMS - definitions,
// thresholds, decision criteria, conclusions. Calling it "biology" was one project's vocabulary
// leaking into a general-purpose layer. Not one gate changed (see claimMode).
// 'biology' is still accepted for BACKWARD COMPATIBILITY: old callers and old prior_state must
// 🔴 An UNRECOGNISED kind is a HARD ERROR, not a silent fallback. Measured incident: a caller passed
//    kind:'design' meaning "review the design, not the code". It fell silently to mixed ->
//    codeRelevant=true -> the panel ran a code dry-run against .md documents -> VERIFIED:fail was
//    guaranteed, and "code dry-run/smoke-test FAILED" appeared in blockers on two consecutive rounds.
//    Every one of those blockers was spurious, and they polluted the converged decision.
//    ⚠️ The defect was never "it fell to mixed" - mixed is the STRICTER destination, which is the
//    right direction for an unknown risk. The defect is SILENCE: the caller had a specific intent,
//    the panel discarded it, and nothing said so. Falling back to something stricter is safe for the
//    panel and useless to the caller, who keeps believing the argument was honoured.
//    An error that only says "invalid" repeats the trap in a new shape, so the message must name the
//    value the caller actually wanted. A design / plan / spec / method is exactly what claim is for.
const KIND_VALID = ['claim', 'code', 'mixed']
const KIND_ALIAS = { biology: 'claim' }   // legacy name; old callers and old prior_state keep working
const KIND_HINT = {
  design: 'claim', doc: 'claim', docs: 'claim', document: 'claim', plan: 'claim', spec: 'claim',
  method: 'claim', methods: 'claim', proposal: 'claim', writeup: 'claim', analysis: 'claim',
  script: 'code', implementation: 'code', impl: 'code', patch: 'code', diff: 'code',
}
const KIND_RAW = norm(input.kind, 'mixed')
const KIND = KIND_VALID.includes(KIND_RAW) ? KIND_RAW : (KIND_ALIAS[KIND_RAW] || null)
if (KIND === null) {
  const hint = KIND_HINT[KIND_RAW]
  return {
    converged: false,
    error: `kind '${KIND_RAW}' is not a recognised kind. Valid: ${KIND_VALID.join(' | ')} `
      + `('biology' is still accepted as a legacy alias for 'claim').`
      + (hint ? ` For '${KIND_RAW}', use kind:'${hint}'.` : '')
      + ` claim = a NON-CODE argument (a design, plan, spec, method, threshold, definition or conclusion);`
      + ` code = something with a runnable dry-run/smoke-test; mixed = both.`,
    note: 'Refused rather than falling back. An unrecognised kind used to fall silently to mixed, which'
      + ' turns codeRelevant on and makes the panel demand a code dry-run of whatever you submitted -'
      + ' so a document under review produced a guaranteed VERIFIED:fail and a spurious blocker.',
    kind_received: KIND_RAW,
  }
}
// Same treatment for mode: 'quick2' used to fall silently to adaptive, i.e. a caller asking for ONE
// round would silently get three (about 81 minutes instead of 15) with nothing said.
// codex_only: ONE codex seat, ZERO Claude seats, one round. Half of `quick` — an independent
// second reader without the Claude side, for when that is all the situation calls for.
// Same input contract and same output contract as every other mode, so nothing downstream
// (triage, reminders, terminal_state handling) needs a special case for it.
// The convergence gate needed NO change for this: `valid` already includes the codex verdict
// (see evaluateConvergence), so with zero Claude seats a valid codex verdict still satisfies
// `!valid.length` and is still subject to `valid.every(approves)`. The only thing that changes
// is seat composition.
const MODE_VALID = ['quick', 'standard', 'deep', 'adaptive', 'codex_only']
const MODE_RAW = norm(input.mode, 'adaptive')
if (!MODE_VALID.includes(MODE_RAW)) {
  return {
    converged: false,
    error: `mode '${MODE_RAW}' is not a recognised mode. Valid: ${MODE_VALID.join(' | ')}.`
      + ` quick = 1 round; standard / adaptive = 2 rounds; deep = 3 rounds;`
      + ` codex_only = 1 round with NO Claude seats (codex verdict only).`,
    note: 'Refused rather than falling back. An unrecognised mode used to fall silently to adaptive, so a'
      + ' caller asking for a single round would silently be charged three.',
    mode_received: MODE_RAW,
  }
}
const MODE = MODE_RAW
const CP = (input.contextPack && typeof input.contextPack === 'object') ? input.contextPack : {}

// ---- CROSS-PROJECT STATE-IDENTITY FINGERPRINT ----
// prior_state is round-tripped through the MAIN LOOP by hand. With two panels auditing DIFFERENT
// projects/tasks concurrently (the normal case on this multi-project machine), a mis-threaded state
// object would silently cross-merge one project's verdicts/frozen-R1/budget into the other's audit —
// an undetectable cross-project contamination. Bind every emitted state to a fingerprint of
// (project, task) and REFUSE to consume a state whose fingerprint is absent or different.
// Deterministic (no Date/random) so the same audit re-fingerprints identically across rounds.
// Components are joined via JSON.stringify (unambiguous delimiting; no separator byte needed -- the earlier
// NUL separator was a source-corruption hazard). project keeps its ORIGINAL case: on Linux `Project-A` and
// `project-a` are DIFFERENT projects, and lowercasing collapsed them onto one fingerprint. ctx
// (targets/raw_sources/expected) disambiguates two audits sharing a task string but reading DIFFERENT
// sources, and covers the project-omitted case. Both collisions were found by the independent audit.
function taskFingerprint(project, task, ctx) {
  const s = JSON.stringify([(project || '').trim(), (task || '').trim(), ctx == null ? '' : ctx])
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // Math.imul: a plain `*` on 32-bit hashes overflows 2^53 and silently drops low bits, so the real entropy
    // was well below what the two-hash construction implies (independent review).
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul((h2 + c) >>> 0, 0x85ebca6b) >>> 0
  }
  return `fp_${h1.toString(36)}_${h2.toString(36)}`
}
// RUN_ID: the only thing separating two concurrent audits whose ARGS are byte-identical. The workflow runtime
// forbids Date.now()/Math.random(), so the panel cannot mint a nonce — the caller supplies one and threads it
// back unchanged every round.
const RUN_ID = (input.run_id == null ? '' : String(input.run_id)).trim()
// CTX_SIG binds EVERY caller-supplied arg except the per-round handshake payload. Enumerating a hand-picked
// subset was repeatedly fail-OPEN: `context`, `kind`, `risk`, `mode`, `codex_mode` all reshape the brief, the
// lens set, the mandatory sentinel fields and the convergence gates, yet none were bound — two substantively
// DIFFERENT audits produced the SAME fingerprint and the SAME AUDIT-ID, so both guards passed and a foreign
// verdict merged (reproduced live). Binding the whole arg object also covers args added later.
let CTX_SIG_ERROR = null
const CTX_SIG = (() => {
  // EVERY value is emitted as a [typeTag, payload] tuple. An untagged encoding was forgeable: a literal
  // object shaped like the marker (e.g. {__bigint:"1"}) hashed identically to a real 1n while producing a
  // completely different brief. Tagging uniformly makes "a BigInt" and "an object that looks like one"
  // structurally distinct (independent review).
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
    return keys.sort()
  }
  const ownExtras = (o) => Object.getOwnPropertyNames(o)
    .filter(k => k !== 'length' && !/^[0-9]+$/.test(k)).sort().map(k => [k, walk(o[k])])
  const inheritedExtras = (o) => {
    const own = Object.getOwnPropertyNames(o)
    return allReadableKeys(o).filter(k => own.indexOf(k) < 0 && !/^[0-9]+$/.test(k)).map(k => [k, walk(o[k])])
  }
  const path = []   // ANCESTOR path, not a visited-set: a shared-but-acyclic reference is legal and must not
                    // be mistaken for a cycle (the WeakSet version refused to run on such args).
  const walk = (x) => {
    const t = typeof x
    if (x === null) return ['null']
    if (t === 'bigint') return ['bigint', x.toString()]
    if (t === 'symbol') return ['symbol', String(x)]
    if (t === 'undefined') return ['undefined']
    // Functions: bind the SOURCE, not just the name — two same-named functions with different bodies render
    // differently in the brief and must not share a fingerprint.
    if (t === 'function') {
      // Functions join the ancestor path too: a self-referential own property recursed until RangeError
      // instead of returning the structured AUDIT IDENTITY UNAVAILABLE that ordinary cycles produce.
      if (path.indexOf(x) >= 0) { CTX_SIG_ERROR = 'circular reference in args'; return ['circular'] }
      path.push(x)
      try {
      let body = ''
      try { body = Function.prototype.toString.call(x) } catch (e) { body = '[unprintable fn]' }
      let fnCoerced = ''
      try { fnCoerced = String(x) } catch (e) { fnCoerced = '[unstringifiable]' }
      // A function can define Symbol.toPrimitive too; the brief renders THAT, not the source. It can also
      // carry own/inherited properties that the brief reads — those must be bound as well.
      const fnOwn = Object.getOwnPropertyNames(x)
        .filter(k => k !== 'length' && k !== 'name' && k !== 'prototype').sort().map(k => [k, walk(x[k])])
      // Walk the prototype chain for NON-enumerable inherited props too (for-in only sees enumerable ones).
      const fnInherited = []
      { const seenK = []
        let cur = Object.getPrototypeOf(x)
        while (cur && cur !== Function.prototype && cur !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(cur)) {
            if (k === 'constructor' || seenK.indexOf(k) >= 0) continue
            seenK.push(k); fnInherited.push([k, walk(cur[k])])
          }
          cur = Object.getPrototypeOf(cur)
        }
        for (const k in x) if (!Object.prototype.hasOwnProperty.call(x, k) && seenK.indexOf(k) < 0) {
          seenK.push(k); fnInherited.push([k, walk(x[k])])
        } }
      fnInherited.sort((a, b) => (a[0] < b[0] ? -1 : 1))
      return ['function', x.name || 'anonymous', body, fnCoerced, fnOwn, fnInherited]
      } finally { path.pop() }
    }
    // JSON.stringify collapses NaN and +/-Infinity ALL to null, so three different briefs hashed identically.
    if (t === 'number') {
      if (Number.isNaN(x)) return ['number', 'NaN']
      if (x === Infinity) return ['number', 'Infinity']
      if (x === -Infinity) return ['number', '-Infinity']
      if (Object.is(x, -0)) return ['number', '-0']
      return ['number', x]
    }
    if (t !== 'object') return [t, x]
    if (path.indexOf(x) >= 0) { CTX_SIG_ERROR = 'circular reference in args'; return ['circular'] }
    // Objects may define Symbol.toPrimitive / toString, which is what the BRIEF renders. Two objects with
    // identical structure but different coercions produced different briefs and identical fingerprints.
    let coerced = ''
    try { coerced = String(x) } catch (e) { coerced = '[unstringifiable]' }
    path.push(x)
    let out
    try {
      if (Array.isArray(x)) {
        // An array can carry OWN non-index properties (an array-shaped contextPack with .targets/.expected
        // hung off it). Encoding only the indices made two different contracts collide.
        // Own extras AND inherited ones (an array whose prototype carries `expected` rendered differently).
        out = ['array', x.map(walk), ownExtras(x), inheritedExtras(x), coerced]   // ORDER PRESERVED: order is semantic
      } else if (x instanceof Map) {
        // ALSO encode own non-entry properties: an empty Map carrying .targets/.expected rendered a different
        // brief while hashing identically when only entries were encoded.
        // coerced + inherited extras on EVERY branch. Computing `coerced` but only emitting it from the
        // plain-object branch left Array/Map/Set/Date/function collisions wide open: a Map whose
        // Symbol.toPrimitive rendered CONTRACT-A vs CONTRACT-B hashed identically while the briefs differed
        // (independent review). "All objects bind String(x)" has to actually mean all of them.
        out = ['map', Array.from(x.entries()).map(([k, v]) => [walk(k), walk(v)]), ownExtras(x), inheritedExtras(x), coerced]
      } else if (x instanceof Set) {
        out = ['set', Array.from(x.values()).map(walk), ownExtras(x), inheritedExtras(x), coerced]
      } else if (x instanceof Date) {
        out = ['date', isNaN(x.getTime()) ? 'invalid' : x.toISOString(), ownExtras(x), inheritedExtras(x), coerced]
      } else if (x instanceof RegExp) {
        out = ['regexp', String(x), ownExtras(x), inheritedExtras(x), coerced]
      } else {
        // Include INHERITED enumerable properties: the execution logic reads args via plain property access,
        // so a value living on the prototype chain (e.g. risk) shaped the audit while Object.keys() missed it
        // and the fingerprint stayed identical across different risks.
        // getOwnPropertyNames picks up NON-ENUMERABLE own props (plain property access still reads them, so
        // they shaped the audit while staying invisible to Object.keys/for-in); for-in adds inherited ones.
        // for-in gives ENUMERABLE own+inherited; getOwnPropertyNames gives own incl. NON-enumerable; walking
        // the prototype chain adds NON-enumerable INHERITED ones (plain property access reads all of these,
        // so they shaped the audit while staying invisible to the first two).
        const keys = allReadableKeys(x)
        const proto = Object.getPrototypeOf(x)
        const nonPlain = (proto !== Object.prototype && proto !== null)
        out = ['object', nonPlain ? Object.prototype.toString.call(x) : 'plain', coerced, keys.map(k => [k, walk(x[k])])]
      }
    } finally { path.pop() }
    return out
  }
  const HANDSHAKE = ['prior_state', 'codex_prev_verdict_raw', 'codex_exit_code']
  const inputKeys = []
  for (const k of allReadableKeys(input || {})) if (inputKeys.indexOf(k) < 0) inputKeys.push(k)
  inputKeys.sort()
  const shaped = inputKeys.filter(k => HANDSHAKE.indexOf(k) < 0).map(k => [k, walk((input || {})[k])])
  try { return JSON.stringify(shaped) }
  catch (e) { CTX_SIG_ERROR = (e && e.message) ? e.message : 'unserializable args'; return null }
})()
// fail-CLOSED: a weak fallback fingerprint was itself a collision source (two audits with different
// unserializable args shared one id). If identity cannot be derived, refuse to run rather than run unidentified.
if (CTX_SIG == null || CTX_SIG_ERROR) {
  return {
    // Early rejections carry converged:false explicitly. Without the field a downstream
    //   `x.converged === false` test silently fails, so "arguments rejected" reads as "not a failure".
    converged: false,
    error: `AUDIT IDENTITY UNAVAILABLE (fail-closed): panel args cannot be canonically serialized (${CTX_SIG_ERROR || 'unserializable'}), so no audit fingerprint can be derived. Without one, two different audits could share an identity and cross-merge state/verdicts. Re-invoke with plain JSON-serializable args (no circular references).`,
    missing: ['canonically serializable args'],
  }
}
const TASK_FP = taskFingerprint(PROJECT, TASK, CTX_SIG)
// Per-round audit id echoed into every codex brief; the verdict MUST echo it back (guard before the merge).
const auditIdFor = (round) => `${TASK_FP}_r${round}`
// shared source-list cleaner (whole-flow audit R2): String -> trim -> drop empty/whitespace, so a
// blank/whitespace entry can NEVER be counted as a real independent source (that bypassed the no-source guard).
const cleanList = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])).map(x => String(x).trim()).filter(Boolean)
// A source must be a plausible ABSOLUTE local file path (whole-flow audit R3): reject pseudo-absolute
// garbage that would masquerade as a source — root/root-aliases (`/`, `/.`, `/..`), protocol-relative `//x`, NUL
// bytes, and URLs (the read-only/no-network Codex auditor cannot fetch them). NOTE: this validates path SHAPE only;
// the panel runs in a sandbox with NO fs access, so it CANNOT stat/verify readability — that a real, readable file
// actually exists is the independent Codex auditor's job at read time + human review (heuristic backstop, like DELTA).
const isRealSourcePath = (p) =>
  /^\/[^\0]+$/.test(p) &&   // absolute, non-empty after the slash, no NUL byte
  !/^\/\//.test(p) &&       // not protocol-relative / UNC-style //host
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(p) &&  // no control chars / line separators (whole-flow R4): a
                            // newline in a path would inject an EXTRA bullet into the RAW SOURCES allowlist of the
                            // codex brief — smuggling an unvetted path past provenance. Real file paths never have these.
  /[^\/.\s]/.test(p)        // has >=1 real name char (NOT slash/dot/whitespace) -> rejects "/", "/.", "/..", "/   ";
                            // Unicode-safe: allows non-ASCII paths, which are common here
// standard went from 2 rounds to 3. Once the stability gate applied at every risk level, a flip
// had to stay stable for one more round to count - and under a 2-round budget that "next round"
// does not exist, so every ordinary "found a problem -> fixed it -> re-review passes" cycle was
// forced to a human. The cost, stated honestly: that extra round is spent on EVERY non-converged
// case under standard, not only on flips. MAX_ROUNDS and the agent ceiling still cap it.
// MODE SEMANTICS. An earlier comment said standard and deep were "still not identical, they
// differ in the starting width". That premise no longer holds: the width knob is gone and seats
// are decided solely by codeRelevant (2 seats with a code axis, 1 without), independent of mode,
// risk and round. standard / deep / adaptive are now LITERALLY equivalent - same rounds, same
// seats, same scheduling; only quick differs (1 round). Do not read "deep" as a wider panel.
// >>> DUAL-AUDIT PROFILE (generated by `dual-audit profile apply` — do not edit by hand) >>>
const PROFILE = {"version":1,"name":"default","customized":false,"projects":[],"evidence":{"brief_note":""},"profile_sha256":null}
// <<< END DUAL-AUDIT PROFILE <<<

// SYNC-GROUP: dual-audit-rounds  (this value also lives in the driver and in the operator docs)
// Three tiers, picked by the operator according to the size of the problem:
//   quick = 1 round, standard/adaptive = 2, deep = 3.
//
// 🔴 The default of 2 is NOT an attempt to reach converged=true. This panel does not exist to
//    converge; it exists to get independent readings of the same system, and a run that ends
//    not-converged is a normal outcome rather than a fault.
//    What the second round buys is CROSS-EXAMINATION. A single round routinely produces a
//    confident finding that a second reader dismantles: an extrapolated cost measured on a
//    synthetic fixture whose shape differs from the real input; a finding whose CONCLUSION is
//    right while its probe landed somewhere the code excludes, so the stated damage chain does
//    not hold until the probe is re-anchored. Round 2 fixes the real ones in place and drops
//    the rest, which means LESS human arbitration, not more.
//
//    Consequence, known and accepted: with standard=2 the flip-stability gate below ("a verdict
//    that flips in the LAST round does not count as convergence") will fire more often. That is
//    the correct outcome — a last-round reversal is exactly the case a human should look at, and
//    escalate_to_user is a terminal state, not a malfunction. Do NOT raise the round count to
//    make that gate quiet.
const MODE_ROUNDS = { quick: 1, standard: 2, adaptive: 2, deep: 3, codex_only: 1 }
const roundsAllowed = Math.min(MAX_ROUNDS, MODE_ROUNDS[MODE])
// claimMode: the submission contains NON-CODE FACTUAL CLAIMS. It gates exactly the same five
// things it did before the rename: ANCHOR/UNANCHORED_CLAIMS required; both fields in the validity
// contract; the anchor gate blocks convergence; LENS C routes unresolved conflicts there; and the
const claimMode = (KIND === 'claim' || KIND === 'mixed')
const codeRelevant = (KIND === 'code' || KIND === 'mixed')

// ---- Codex side mode (HYBRID; R1-INDEPENDENT two-phase) ----
// The in-workflow read-only Codex forwarder (a haiku agent base64-decodes the brief + runs
// `codex exec`) is STRUCTURALLY unreliable in headless/background runs (auto-mode SEMANTIC classifier
// blocks the base64-deobfuscate-then-exec pattern; haiku corrupts the ~10KB base64 blob). So Codex
// ALWAYS runs in the MAIN LOOP on a real frozen brief file. The panel runs ONE round of the CLAUDE
// side per invocation, emits the per-round Codex brief, and hands off; the main loop runs codex and
// re-invokes with the codex verdict. 'forward' keeps the old in-workflow forwarder as an explicit
// experimental opt-in only. See memory reference_dual_audit_panel.
const CODEX_MODE = (norm(input.codex_mode, 'deferred') === 'forward') ? 'forward' : 'deferred'

if (!TASK) return { converged: false, error: 'dual-audit-panel needs a non-empty task. Pass a string or {task, context, project, risk, kind, mode, contextPack}.' }

// ---- R3: context-pack required fields, fail-closed for code / high-risk ----
// Objects are valid for structured acceptance contracts. String(object) destroys every key as
// "[object Object]" while the presence gate still treats it as supplied — a fail-open contract.
// Preserve structured values as JSON; cyclic/non-serializable values format to empty and are
// rejected by fieldEmpty below.
const fmt = (v) => {
  if (Array.isArray(v) && v.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) {
    return v.join('; ')
  }
  if (v != null && typeof v === 'object') {
    try { return JSON.stringify(v) }
    catch { return '' }
  }
  return String(v)
}
// `!CP.targets` was a truthiness test, and an empty array is truthy - so `targets: []` or a
//   whitespace-only string counted as PROVIDED, skipped the missing-field check, and a code audit
//   with no real target still converged through the VERIFIED gates on both sides. fieldEmpty treats
const fieldEmpty = (v) => v == null
  || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.filter(x => !(x == null || String(x).trim() === '')).length === 0)
  || (!Array.isArray(v) && typeof v === 'object' && (fmt(v) === '' || fmt(v) === '{}'))
const missing = []
if (codeRelevant) { if (fieldEmpty(CP.targets)) missing.push('contextPack.targets (files/scripts to verify)'); if (fieldEmpty(CP.expected)) missing.push('contextPack.expected (expected outputs/columns/counts to check against)') }
// 🔴 Profile fields are read with strField, never with String(). A profile is hand-written YAML, so
//    `docs:` written as a mapping or a list instead of a scalar is an ordinary authoring mistake —
//    and String({}) is "[object Object]", which is non-empty. That made a malformed profile look
//    like a project WITH canonical docs, so the risk:high canonical_docs guard below and the
//    independent-R1-source guard further down both passed on a profile that declares no usable
//    anchor at all. A high-risk verdict would then be allowed to converge with no anchor source.
//    Coercion is the bug: a non-string here means "not declared", not "declared as gibberish".
const strField = (v) => (typeof v === 'string' ? v.trim() : '')
// An id may legitimately be written as a number in YAML (`id: 2024`), so ids accept string|number;
// everything that GATES (docs, rules) must be a real string.
const idField = (v) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim() : ''
// knownProject is no longer a hardcoded project list; it asks "does this machine's profile declare
// canonical docs for this project".
// ⚠️ It is used BEFORE profileProject exists, so it looks PROFILE up itself rather than reusing that
//    constant (temporal dead zone).
const knownProject = !!(PROJECT && ((PROFILE && Array.isArray(PROFILE.projects)) ? PROFILE.projects : [])
  .some(p => p && idField(p.id).toLowerCase() === PROJECT.toLowerCase() && strField(p.docs)))
if (RISK === 'high' && fieldEmpty(CP.canonical_docs) && !knownProject) missing.push('contextPack.canonical_docs OR a `project` declared with `docs` in your dual-audit profile — anchor source for a high-risk decision')
if (missing.length) return { converged: false, error: 'CONTEXT-PACK INCOMPLETE (fail-closed). Re-invoke with: ' + missing.join(' | '), missing, note: 'Subagents do not share caller context; without these they cannot do a meaningful dry-run or anchoring.' }
// whole-flow audit (R2 broadened from ~/-only after codex re-audit): ANY non-absolute source path
// (~/, ./, ../, bare relative) breaks under the read-only Codex auditor — the codex-audit wrapper runs it from
// /tmp under a restricted HOME, so ~ does not expand and relative paths resolve to the wrong place / nothing,
// and the independent Codex silently reads nothing. Require ABSOLUTE paths (or http(s):// URLs). Empty/whitespace
// entries are dropped by cleanList (so they can't masquerade as a source); non-absolute non-empty -> fail-closed.
const nonAbsSources = [].concat(cleanList(CP.raw_sources), cleanList(CP.canonical_docs), cleanList(CP.targets), cleanList(CP.input_fixture)).filter(p => !isRealSourcePath(p))
if (nonAbsSources.length) return { converged: false, error: 'CONTEXT-PACK has invalid source paths (fail-closed): ' + nonAbsSources.join(', ') + ' — raw_sources/canonical_docs/targets/input_fixture must be plausible ABSOLUTE local file paths (no ~/, no relative, no URL, no bare root/"//"). The read-only Codex auditor runs from /tmp under a restricted HOME and cannot fetch URLs or resolve relative/~ paths, so such entries would silently fail to read.', non_absolute_sources: nonAbsSources }

// ---- Project rules come from the PROFILE, not from hardcoded names ---------------------------
// WHY: this block used to name specific projects and their absolute paths. A shared review tool
// must not hardcode any single project's vocabulary - "only injected when the caller names the
// project" mitigates that, it does not fix it, and it made this panel STRUCTURALLY unpublishable.
// Project names now live only in the machine-local profile, which never enters a repository.
//
// `rules` may embed canonical CONCLUSIONS -> Claude side only (it may use them as working truth).
// `docs` carries canonical document PATHS only -> used in the independent-R1 codex brief so codex
// reads and judges for itself instead of inheriting a ready-made conclusion (R1 independence).
//
// The block below is regenerated from profile.yaml by `dual-audit profile apply`. Do not hand-edit.
// (It is hoisted to the top of the file: knownProject needs it inside the input guards.)
const PROFILE_PROJECTS = (PROFILE && Array.isArray(PROFILE.projects)) ? PROFILE.projects : []
const pKey = PROJECT.toLowerCase()
const profileProject = PROFILE_PROJECTS.find(p => p && idField(p.id).toLowerCase() === pKey && pKey !== '') || null
// strField, not String() — see the note at knownProject above. A non-string field means "not
// declared"; coercing it produces a non-empty "[object Object]" that silently satisfies the guards.
const PROFILE_BRIEF_NOTE = strField(PROFILE && PROFILE.evidence && PROFILE.evidence.brief_note)
const projectRules = strField(profileProject && profileProject.rules)
const projectDocs = strField(profileProject && profileProject.docs)
const projectNote = PROJECT && projectRules ? `PROJECT: ${PROJECT}. ${projectRules}` : (PROJECT ? `PROJECT: ${PROJECT}.` : '')
const projectDocNote = PROJECT && projectDocs ? `PROJECT: ${PROJECT}. ${projectDocs}` : (PROJECT ? `PROJECT: ${PROJECT}.` : '')
const cpNote = [
  CP.targets ? `TARGETS (verify these): ${fmt(CP.targets)}` : '',
  CP.canonical_docs ? `CANONICAL DOCS (source of truth): ${fmt(CP.canonical_docs)}` : '',
  CP.input_fixture ? `INPUT FIXTURE (use this, not full/HPC data): ${fmt(CP.input_fixture)}` : '',
  CP.expected ? `EXPECTED OUTPUT CONTRACT: ${fmt(CP.expected)}` : '',
  CP.allowed_commands ? `ALLOWED COMMANDS: ${fmt(CP.allowed_commands)}` : '',
  CP.forbidden_write_paths ? `FORBIDDEN WRITE PATHS (NEVER write here): ${fmt(CP.forbidden_write_paths)}` : '',
].filter(Boolean).join('\n')
// CLAUDE-side header (may carry Claude notes + canonical conclusions)
// PROFILE_BRIEF_NOTE: the evidence discipline declared by this machine's profile. Both briefs
// carry it - this is where domain rigour moved to when it left the panel body.
const HEADER = [`TASK: ${TASK}`, CONTEXT ? `CONTEXT: ${CONTEXT}` : '', projectNote, PROFILE_BRIEF_NOTE, cpNote].filter(Boolean).join('\n')

// ---- RAW-SOURCE read-allowlist for the INDEPENDENT Codex side (bounded scope) ----
// Independence != unbounded exploration. The Codex brief lists EXACTLY which paths to read and
// forbids searching anywhere else (lesson: an unbounded grep read unrelated sessions and
// was killed by timeout). raw_sources defaults to the union of the verifiable/anchor inputs.
// P1-b provenance filter: a Claude-GENERATED path is NOT independent raw and must NOT enter the
// independent R1 read-allowlist. Caller tags them via contextPack.generated_by_claude.
const generatedByClaude = cleanList(CP.generated_by_claude)   // trimmed so provenance compare matches cleaned source entries
const rawSourcesAll = (() => {
  const explicit = cleanList(CP.raw_sources)
  const listed = explicit.length ? explicit : [].concat(cleanList(CP.canonical_docs), cleanList(CP.input_fixture))
  // TARGETS always enter the codex R1 read allowlist. The old rule - "if explicit raw_sources were
  // given, use only those" - could exclude the very things under review, leaving codex auditing blind.
  return [...new Set([].concat(cleanList(CP.targets), listed))]
})()
const rawSourcesExcluded = rawSourcesAll.filter(p => generatedByClaude.includes(p))
const rawSources = rawSourcesAll.filter(p => !generatedByClaude.includes(p))
// R1 provenance exclusion is deliberately temporary. In R2+ the independent seat must inspect the
// actual submitted target in order to adjudicate whether a reported defect was fixed. Only generated
// TARGETS are restored here — never the lead's CONTEXT, summary, conclusion, or arbitrary generated
// support material. This keeps R1 independent without making cross-examination permanently blind.
const generatedTargetsForCrossExam = cleanList(CP.targets).filter(p => generatedByClaude.includes(p))
const crossExamSources = [...new Set(rawSources.concat(generatedTargetsForCrossExam))]
// NOTE (corrected by whole-flow audit): the earlier claim "line-62 validation guarantees a readable
// source so no empty-rawSources guard is needed" was WRONG — validation checks canonical_docs PRESENCE, which
// passes even when every canonical_doc is generated_by_claude (post-filter → []) on an unknown project, leaving
// the independent R1 with nothing to read yet still able to converge. The real guard is `hasIndependentR1Source`
// (below) + the STEP-B fail-closed when it is false. The FILTER here is the provenance (P1-b) fix.
// ---- TASK BRIEF ----
// `contextPack.brief` used to be accepted by the schema and then consumed by nothing. The
// read-allowlist was built from `contextPack.targets` alone, so a caller could pass a brief,
// have it validated, and watch the codex seat be handed a task that refers to sections of a
// document it is not allowed to open. Observed exactly that: the seat reported it could not
// adjudicate the questions it had been asked and, following its own coverage discipline,
// declined to issue a converging verdict. The Claude seats in the same round HAD read the
// brief and did adjudicate. The two sides were working from different material — and the
// entire value of an independent round 1 rests on both sides reading the raw inputs
// themselves. Asymmetric material makes that independence claim empty.
//
// 🔴 Why this is its own category and NOT folded into RAW SOURCES:
//    The brief is a STATEMENT OF WORK — what to review, what the discipline boundaries are,
//    what must not be reopened. It is not evidence. It is written by the submitting party and
//    necessarily carries that party's conclusions and self-assessment. Folding it into RAW
//    SOURCES would hollow out "read the raw material independently"; withholding it entirely
//    leaves the seat unsure what it is even reviewing. So it is supplied, with its provenance
//    stated verbatim: read it for scope, do not treat it as evidence.
//    ⚠️ It deliberately does NOT count toward hasIndependentR1Source — a brief can never
//       substitute for a genuinely independent source.
const taskBriefPath = (typeof CP.brief === 'string' && CP.brief.trim().startsWith('/'))
  ? CP.brief.trim() : ''
const taskBriefNote = taskBriefPath
  ? `TASK BRIEF — read this FIRST to learn WHAT to audit and WHICH disciplines apply:\n  - ${taskBriefPath}\n`
    + `  \u26a0 PROVENANCE: written by the SUBMITTING agent. Its conclusions, self-assessment and `
    + `"already fixed" claims are NOT evidence. Read it for scope / questions / rules, then verify `
    + `everything yourself against RAW SOURCES and TARGETS.`
  : ''
const rawSourcesNote = rawSources.length
  ? `RAW SOURCES — read ONLY these (read them yourself):\n${rawSources.map(s => '  - ' + s).join('\n')}` + (rawSourcesExcluded.length ? `\n(${rawSourcesExcluded.length} Claude-generated path(s) were EXCLUDED from this independent allowlist by provenance.)` : '')
  : ''
const crossExamSourcesNote = crossExamSources.length
  ? `CROSS-EXAM SOURCES — read ONLY these in R2+ (read the submitted targets yourself):\n${crossExamSources.map(s => '  - ' + s).join('\n')}`
  : ''
// 🔴 The time box is a DEFAULT FIELD of every brief, not something the caller writes by hand.
//    Measured incident: a reviewer spent ten minutes reading a project's whole control-plane
//    documentation because a profile `docs` entry pointed at it with an open-ended glob
//    ("... and the relevant phase_XX_*.md"). It then hit the caller's hard wall-clock ceiling and was
//    killed with empty stdout. The caller worked around it by hand-writing a reading limit at the top
//    of the next brief, and that worked - which is precisely why it belongs in the template instead
//    of depending on the caller remembering.
//    ⚠️ The ceiling is REAL and not advisory: the reviewer wrapper is capped at 570s (see
//    CODEX_AUDIT_TIMEOUT in ~/bin/codex-audit), itself under the 600s the calling tool enforces and
//    cannot raise. Overrunning does not produce a late verdict; it produces NO verdict.
//    So the honest instruction is not "be efficient" - it is "a partial verdict beats no verdict".
const TIME_BOX_MIN = 8
const boundedScopeNote = [
  'BOUNDED SCOPE (mandatory): read ONLY the files/paths listed above (TASK BRIEF / RAW SOURCES / CROSS-EXAM SOURCES / PROJECT docs / CANONICAL DOCS).',
  'Do NOT grep/rg/find across other directories, other sessions, unrelated project histories, or *-backup copies — that pollutes your judgment and wastes your turn (this exact failure killed a prior run on timeout).',
  `TIME BOX (hard, ${TIME_BOX_MIN} minutes): your process is killed at a fixed wall-clock ceiling you cannot raise, and a killed run returns NOTHING — no verdict, no partial findings, no error.`,
  'Therefore: budget your reading, and EMIT A VERDICT even if your review is incomplete — your partial findings are worth keeping.',
  // 🔴 These three sentences are the LOAD-BEARING fail-closed part, not politeness. Drop any one of
  //    them and the direction flips back. The first version said only "a partial verdict beats no
  //    verdict", and three independent seats caught what that bought: an APPROVE carrying
  //    ANCHOR:anchored + VERIFIED:fail whose own prose said "read 2 of the 7 listed files" came back
  //    converged=true / blockers=[] / "Safe to pass to the next chain link". The honest shape
  //    (ANCHOR:partial) came back converged=false and cost another round - so FINISHING was cheaper
  //    than being HONEST, and at minute 7 the rational move is the shallow APPROVE. Before that
  //    instruction, running out of time produced nothing at all, which failed closed.
  //    ⚠️ Worse, the honest valve pointed at VERIFIED:fail, which does NOTHING in claim mode
  //    (codeFieldsOk = !codeRelevant || ...) - and the incident that prompted this change WAS a
  //    claim-mode document review. The field with teeth there is ANCHOR/UNANCHORED_CLAIMS, which the
  //    original wording never mentioned. So each mode now points at the field that actually gates it,
  //    and an incomplete review is forbidden from carrying APPROVE at all.
  // 🔴 REJECT only. The first version of this sentence offered APPROVE_WITH_CHANGES as the polite
  //    alternative — but approvesFinal treats it EXACTLY like APPROVE (`verdict === 'APPROVE' ||
  //    verdict === 'APPROVE_WITH_CHANGES'`), so it converges. That instruction pointed the reviewer
  //    straight back into the fail-open this whole paragraph exists to close, and this time the panel
  //    itself was doing the pointing. If a shape converges, it is not an option for a review that
  //    admits it did not finish.
  'A review that did not cover the listed targets is NOT an approval and MUST NOT carry VERDICT: APPROVE or APPROVE_WITH_CHANGES — both of those converge, regardless of how good the part you did read looked. Use VERDICT: REJECT.',
  claimMode
    ? 'If you could not cover everything: set ANCHOR: partial (or none) and name every target you did not reach in UNANCHORED_CLAIMS. That is the field that actually gates convergence here — writing your coverage gap only in EVIDENCE prose leaves it in a place nothing reads, and the round will converge as though you had reviewed it all.'
    : 'If you could not cover everything: set VERIFIED: fail and name every target you did not reach. That is the field that actually gates convergence here — writing your coverage gap only in EVIDENCE prose leaves it in a place nothing reads, and the round will converge as though you had reviewed it all.',
  codeRelevant && claimMode ? 'This submission is mixed, so BOTH apply: ANCHOR: partial AND VERIFIED: fail.' : '',
  'When a listed path is a DIRECTORY or a glob, treat it as a pointer, not as an instruction to read everything under it: open what the task actually turns on. If the listed docs and the concrete review targets compete for your budget, the TARGETS win — they are what the verdict is about.',
  'For large JSONL transcripts, target the relevant lines (e.g. the user turns) instead of reading the whole file.',
].filter(Boolean).join(' ')
// HEADER for the INDEPENDENT R1 Codex brief: task + USER's raw words + project doc PATHS (no conclusions)
// + raw-source allowlist + the verifiable contract pieces. NO Claude CONTEXT notes, NO conclusions.
// canonical_docs ALSO get the provenance filter (a Claude-generated path must not slip in via canonical_docs).
const canonicalDocsForR1 = cleanList(CP.canonical_docs).filter(p => !generatedByClaude.includes(p))
// P0 (whole-flow audit): the R1 INDEPENDENT codex needs at least one REAL, non-Claude-generated source
// to read; else "independence" is vacuous (codex reads nothing yet the round can still converge). The line-62
// validation only checks canonical_docs PRESENCE — it passes even when every canonical_doc is generated_by_claude
// (post-filter → []) and the project has no `docs` in the profile. Guard the POST-FILTER availability, not presence.
const hasIndependentR1Source = rawSources.length > 0 || canonicalDocsForR1.length > 0 || !!(PROJECT && projectDocs)
const HEADER_RAW = [
  `TASK: ${TASK}`,
  USER_RAW ? `USER (verbatim): ${USER_RAW}` : '',
  projectDocNote,
  PROFILE_BRIEF_NOTE,
  canonicalDocsForR1.length ? `CANONICAL DOCS (read them yourself; source of truth): ${canonicalDocsForR1.join('; ')}` : '',
  CP.expected ? `EXPECTED OUTPUT CONTRACT: ${fmt(CP.expected)}` : '',
  CP.forbidden_write_paths ? `FORBIDDEN WRITE PATHS (NEVER write here): ${fmt(CP.forbidden_write_paths)}` : '',
  taskBriefNote,
  rawSourcesNote,
].filter(Boolean).join('\n')
// R2+ stays neutral (no lead-authored CONTEXT or conclusions) but restores submitted generated
// targets so the independent seat can personally inspect the fix it is cross-examining.
const HEADER_CROSS = [
  `TASK: ${TASK}`,
  USER_RAW ? `USER (verbatim): ${USER_RAW}` : '',
  projectDocNote,
  PROFILE_BRIEF_NOTE,
  canonicalDocsForR1.length ? `CANONICAL DOCS (read them yourself; source of truth): ${canonicalDocsForR1.join('; ')}` : '',
  CP.expected ? `EXPECTED OUTPUT CONTRACT: ${fmt(CP.expected)}` : '',
  CP.forbidden_write_paths ? `FORBIDDEN WRITE PATHS (NEVER write here): ${fmt(CP.forbidden_write_paths)}` : '',
  taskBriefNote,
  crossExamSourcesNote,
].filter(Boolean).join('\n')

// ---- Two-phase handshake state (one round per invocation) ----
// prior_state carries the CLAUDE-side result of the previous round + cumulative budget across
// invocations (so the 18-agent fail-closed cap holds ACROSS the handshake, not per-invocation).
// Distinguish ABSENT from PRESENT-BUT-UNUSABLE. Coercing a non-object to null silently discarded the codex
// verdict, reopened Round 1, ERASED the unresolved-P0 ledger and reset the cumulative budget — and could then
// declare converged on that fresh R1 (reproduced live). The most likely trigger is a prior_state
// that got JSON.stringify'd somewhere in the hand-threading.
const priorPresent = input.prior_state != null
const priorUsable = priorPresent && typeof input.prior_state === 'object' && !Array.isArray(input.prior_state)
const prior = priorUsable ? input.prior_state : null
const prevCodexRaw = (input.codex_prev_verdict_raw == null ? '' : String(input.codex_prev_verdict_raw)).trim()
// false-death angle: the MAIN LOOP runs codex via ~/bin/codex-audit and MUST pass its exit code.
// A nonzero exit (124 timeout / 137 SIGKILL / 99 lock / any crash) means codex did NOT produce a trustworthy
// verdict even if stdout contains a complete-looking APPROVE block (killed-mid-run / stale / echoed). The panel
// MUST NOT parse such stdout as a verdict — exit!=0 => codex unavailable, fail-closed. ABSENCE is ALSO
// unavailable (see A2 below): it used to be read as "legacy, assume fine", which was fail-OPEN.
const codexExitAbsent = (input.codex_exit_code == null || input.codex_exit_code === '')   // absent => treated as UNAVAILABLE (see A2 below); NOT 'legacy, assume fine'
// fail-closed on present-but-MALFORMED too (whole-flow false-death re-audits R2+R3): a caller that passes the whole
// "EXIT=124" echo line / "abc" / "0x7b" (scalars) OR a NON-scalar like [0] (String([0])==="0") must NOT be read as
// success. Require a SCALAR (string|number) AND a clean all-zeros string. ONLY then is it "codex exited 0 = ok".
// ANY other present value (non-scalar, nonzero, or malformed) => codex unavailable, fail-closed. True absence is
// ALSO unavailable (A2). (parseInt was too lax: parseInt("0x7b")=0 / NaN-as-legacy; and
// plain String() coercion let [0]->"0" through — hence the explicit scalar type-guard.)
const codexExitScalar = (typeof input.codex_exit_code === 'string' || typeof input.codex_exit_code === 'number')
const codexExitStr = (!codexExitAbsent && codexExitScalar) ? String(input.codex_exit_code).trim() : ''
const codexExitOkZero = (!codexExitAbsent && codexExitScalar) && /^0+$/.test(codexExitStr)
const codexExitBad = !codexExitAbsent && !codexExitOkZero   // present & (non-scalar OR not-a-clean-zero) => bad
// A2 (independent review, REPRODUCED): treating ABSENCE as "legacy, assume fine" was fail-OPEN and
// contradicted the standing rule "timeout / truncated output / nonzero exit is NOT a pass". A codex run that was
// killed (137) or timed out (124) routinely leaves a COMPLETE-looking APPROVE block on stdout; if the caller then
// omits codex_exit_code, the panel parsed that stdout and CONVERGED (converged=true, reproduced with a probe).
// Absence is not evidence of success — it is absence of evidence. When a codex verdict TEXT is present, the exit
// code is MANDATORY: no exit code => codex unavailable => fail-closed retry, never a silent convergence.
// (This only binds R2+ handoffs, where `prior` exists and a codex verdict is actually being consumed.)
const codexUnavailable = !!prior && (!prevCodexRaw || codexExitBad || codexExitAbsent)
// Validate the RAW value, not a parseInt() of it. parseInt was fail-OPEN in three ways (all reproduced
//): parseInt(1.5)===1 and parseInt("1junk")===1 both passed an "is it an integer" test that was
// applied to the PARSED value, and an out-of-range round (99) sailed through to converged_r99, bypassing the
// MAX_ROUNDS cap entirely. Accept only a true integer (or an all-digits string) within 1..MAX_ROUNDS.
const priorRoundRaw = prior ? prior.round : undefined
const priorRoundValid = !prior ? true : (
  (typeof priorRoundRaw === 'number' && Number.isInteger(priorRoundRaw) && priorRoundRaw >= 1 && priorRoundRaw <= MAX_ROUNDS) ||
  (typeof priorRoundRaw === 'string' && /^[0-9]+$/.test(priorRoundRaw.trim()) && Number(priorRoundRaw.trim()) >= 1 && Number(priorRoundRaw.trim()) <= MAX_ROUNDS)
)
const priorRound = (prior && priorRoundValid) ? Number(String(priorRoundRaw).trim()) : 0
// fail-closed: clamp to >=0 so a tampered/negative cumulative cannot reset the budget below zero (P0-3 fix)
// A negative/absurd cumulative was silently clamped to 0, which LAUNDERS the cross-invocation budget (the
// 18-agent fail-closed cap is enforced against this number). Validate instead of clamp; invalid => reject.
const cumulativeRaw = prior ? prior.cumulative_used : undefined
// REQUIRED whenever prior exists. Treating missing/null as 0 reopened the whole cross-invocation allowance —
// the very budget reset this check was added to stop.
const cumulativeValid = !prior ? true :
  (typeof cumulativeRaw === 'number' && Number.isInteger(cumulativeRaw) && cumulativeRaw >= 0 && cumulativeRaw <= HARD_TOTAL_CEILING)
const cumulativeUsed = (prior && cumulativeValid) ? cumulativeRaw : 0

// ---- Budget ledger (fail-closed; seeded with cumulative use across invocations) ----
const ledger = { claudeUsed: 0, codexUsed: 0, totalUsed: cumulativeUsed, skippedOverBudget: 0, invalid: 0, codexBlocked: false, codexSkipped: 0, codexDeferred: 0, rounds: [] }
function canLaunch(kind, rc, rx) {
  if (ledger.totalUsed >= HARD_TOTAL_CEILING) return false
  if (kind === 'claude' && rc >= MAX_CLAUDE_PER_ROUND) return false
  if (kind === 'codex' && rx >= MAX_CODEX_PER_ROUND) return false
  if (budget.total && budget.remaining() < 20000) return false
  return true
}

// ---- STRICT sentinel parser: last block, by-line, exact first-token, fail-closed ----
// Split on EVERY Unicode line terminator. A bare split('\n') left a foreign AUDIT-ID separated by U+2028/
// U+2029 or a lone CR on the same logical line as far as the scanner was concerned, so it never entered the
// "all ids must match" comparison.
// WHAT RENDERS AS A LINE BREAK MUST PARSE AS ONE. VT/FF/FS/GS/RS/US display as line breaks in most
// terminals and editors but are not JS line terminators. So `EVIDENCE: x<VT>P0: real blocker` looks
// to a human like two lines, the second a genuine blocker, while the panel reads one line - the
// blocker vanishes silently and the round converges. Reproduced locally.
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c\u001c\u001d\u001e\u001f]/
function splitLines(s) { return String(s == null ? '' : s).split(new RegExp(LINE_BREAKS.source, 'g')) }
// A6 (independent review): `"\u200b".trim` is "\u200b", NOT "" \u2014 zero-width/format characters are
// not whitespace to String.trim(). So `EVIDENCE: <U+200B>` passed a `.trim().length > 0` emptiness check and a
// verdict citing literally nothing converged (reproduced). Strip the invisible/format set BEFORE any emptiness
// test. NOTE: this is WIDER than the AUDIT-ID recognizer's own class (which still enumerates a narrow set);
// they are deliberately NOT the same today. An earlier comment here claimed they could not drift apart -- that
// was false. Widening the identity layer is a separate, higher-risk change and has not been made.
// Enumerating a hand-picked set was incomplete: U+2061..U+2064 (FUNCTION APPLICATION / INVISIBLE TIMES /
// INVISIBLE SEPARATOR / INVISIBLE PLUS) and U+180E all sailed through, so `EVIDENCE: <U+2063>` still counted as
// non-empty and converged (independent review, reproduced). Use the Unicode FORMAT category itself \u2014
// it covers the whole class, including characters added later, instead of a list that has to be maintained.
// (Zs-style spaces are already handled by String.trim(); Cf is exactly what trim does NOT remove.)
// `\p{Cf}` alone was still incomplete: U+034F COMBINING GRAPHEME JOINER and any bare combining mark are `Mn`,
// not `Cf`, so `EVIDENCE: <U+034F>` survived and converged (independent review, reproduced).
// For an EMPTINESS test the right question is "is there any character that carries content on its own" —
// format chars, control chars and *bare* combining marks (no base character) all answer no.
// ⚠️ ORDER MATTERS: NFKC first, then strip. NFKC CREATES new combining marks (U+00B4 becomes space
// + U+0301), so stripping before normalising leaves them in the string and `unchanged´` / `none´`
// slip past the token list. Measured, not assumed. The class includes Mc (spacing combining marks):
// a lone U+093E has no base character and carries no content.
const INVIS_RE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Mc}]/gu
// A BARE combining mark (no base character before it) carries no content; an ATTACHED one is part
// of ordinary text. Deleting every Mn/Me/Mc unconditionally reduces `no<U+0338>` to `no` and
// misreads it as a non-answer - a measured false rejection. Emptiness may strip everything.
const BARE_MARK_RE = /(^|[\s\p{Cf}\p{Cc}\p{P}\p{S}])[\p{Mn}\p{Me}\p{Mc}]+/gu
function stripBareMarks(s) { let p = null, cur = String(s); while (cur !== p) { p = cur; cur = cur.replace(BARE_MARK_RE, '$1') } return cur }
// Strip only, no NFKC here: semantic normalisation is normVariants' job, and emptiness does not
// need NFKC (trim + INVIS_RE suffice). Checked by mutation: with normVariants' NFKC removed,
// removing this one produced no observable difference - redundant, not load-bearing.
function normStrip(s) { return String(s == null ? '' : s).replace(INVIS_RE, '') }
function stripInvisible(s) { return normStrip(s) }
// DELETING invisible characters GLUES neighbouring words together: `same<U+200B>as<U+200B>the...`
// becomes `sameasthe...`, matches nothing, and is waved through. Deletion is right for emptiness
// and creates a blind spot for semantic matching, so BOTH candidate forms are always tried.
function normVariants(s) {
  const base = stripBareMarks(String(s == null ? '' : s).normalize('NFKC'))
  const fmt = /[\p{Cf}\p{Cc}]/gu
  return [base.replace(fmt, ''), base.replace(fmt, ' ')]
}
// ======== Non-answer detection: the hard gate is STRUCTURAL only; prose judgement is advisory ====
// WHY. Deciding whether a piece of natural language says anything cannot be done lexically, and
//   neither a phrase list nor a closed vocabulary converges. Five consecutive independent reviews
//   each broke the previous list: "unchanged from R1"; "same as the previous round"; zero-width-
//   glued words and "no difference from"; "as before" / "still unchanged"; "no modifications" /
//   "no change whatsoever" / the same phrase in other languages. Each round plugged the last
//   batch; the next walked through with fresh paraphrases. Worse, tightening necessarily
//   misfires: adding evidence/provided/citation to catch "no evidence" immediately classified the
//   legitimate "evidence provided above" as a non-answer. The same words form both a non-answer
//   and a valid reference; they are lexically inseparable. That is a property of the problem.
// So the guarantee was re-based onto "a flip must stay stable across rounds" (see freshFlip).
const NON_ANSWER_SENTINELS = new Set([
  'none', 'n a', 'na', 'nil', 'null', 'nan', 'nothing', 'tbd', 'unchanged', 'same', 'no change', 'no changes',
  '无', '無', '没有', '沒有', '无变化', '無變化', '沒有變化', '不变', '不變', '同上', '同前', '暂无', '暫無', '未提供',   // sanitize-scan:allow (CJK/JP/KR placeholder tokens - functional lexicon, not prose)
  '変更なし', 'なし', '없음',   // sanitize-scan:allow (CJK/JP/KR placeholder tokens - functional lexicon, not prose)
])
// A STRUCTURAL non-answer = the field is empty, or the whole field value is exactly one placeholder
// token. The difference from the abandoned closed-vocabulary approach: this matches the WHOLE
// FIELD exactly and never parses prose. Paraphrase cannot defeat it (it never claimed to handle
// prose), and it cannot misfire on real content (a field that says something is never == "none").
// Honest boundary: prose like "no supporting evidence" is NOT caught here; freshFlip backs it up.
// Emptiness must be judged BEFORE punctuation folding: folding first classifies a legitimate
function isStructuralNonAnswer(v) {
  if (!normStrip(v == null ? '' : v).trim()) return true   // emptiness uses the deleted form; all-invisible = empty
// BOTH FORMS ARE REQUIRED. The space form was once deleted on the reasoning that "under whole-field
// exact matching, word splitting can never be the only hit". That was wrong: the sentinel set has
// MULTI-WORD entries (no change / no changes), so `no<U+200B>change` collapses to "nochange" under
// deletion and only the space form restores "no change". Mutation testing reported "no observable
// difference" only because no test covered that input - a surviving mutant is not proof of redundancy.
  return normVariants(v).some(cand => {
    const k = cand.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    return NON_ANSWER_SENTINELS.has(k)
  })
}
// Legacy name kept: the hard gate narrowed to a structural test, but call sites still say isTrivialDelta.
function isTrivialDelta(d) { return isStructuralNonAnswer(d) }
// ADVISORY only; it never participates in the converged computation. The closed-vocabulary heuristic
// is kept solely to flag suspicious fields for the reader. Its limits, stated plainly: incomplete by
// construction (paraphrase always escapes) and capable of false positives - which is exactly why it
function looksLikeNonAnswerAdvisory(v) {
  if (normStrip(v == null ? '' : v).trim() === '') return false   // empties belong to the structural gate; do not warn twice
  return normVariants(v).some(cand => matchesNonAnswer(cand))
}
// stripRefs: only DELTA needs anaphora stripped ("same as the previous round"). EVIDENCE must NOT
// be stripped - "r1 evidence" points at real content, and removing "r1" leaves "evidence", which
// then reads as no evidence at all. Caught by a regression case while writing this.
function matchesNonAnswer(candidate, extraVocab, stripRefs) {
  const raw = candidate.trim()
  if (!raw) return true
  const n = raw.toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim()
  // Judges EMPTY and EXPLICIT NON-ANSWER only; it no longer tries to decide mechanically whether
  // text "has substance". Three independent reviews converged on the same finding: a lexical
  //   heuristic cannot do this, and every tightening produced fresh false rejections - a
  //   12-character minimum rejected a short but real CJK sentence while passing the 15-character
  //   "changed changed"; counting content units passed "ok ok ok" while rejecting space-free Thai,
  //   Arabic and NFD Korean. Honest boundary: this gate guarantees only that the field was filled
  //   in and is not an outright "nothing changed". With an English-only list, a non-answer written
  //   in another language passed straight through - and reviews here are frequently not in English.
  // Method: strip the purely anaphoric tail, then test whether what remains is a non-answer.
  const stripped = n
    .replace(/\b(from|vs|versus|than|as|to|with|since|compared|comparing|relative)\b/g, ' ')
    .replace(/\b(the|my|our|its|this|that)\b/g, ' ')   // no a/an: `n/a` normalises to `n a`, and stripping `a` would wash it down to `n`
    .replace(/\b(r1|r2|r3|round|rounds|above|prior|previous|last|earlier|before|stance|position|verdict)\b/g, ' ')
    .replace(/\b(see|seen)\b/g, ' ')
    .replace(/\b(has|have|had|is|are|was|were|been|any|at|all|in|of)\b/g, ' ')
    .replace(/(与|跟|和|同|比|对)?(上一轮|上轮|前一轮|上面|以上|之前|原来|先前|前次|上次)/g, ' ')   // sanitize-scan:allow (CJK anaphora - functional, strips "compared with the previous round" and friends)
    .replace(/(相比|对比|比较|来说|而言|一致|任何|完全|丝毫)/g, ' ')   // sanitize-scan:allow (CJK anaphora - functional)
    .replace(/\s+/g, ' ').trim()
  // Honest boundary (unchanged): this catches EXPLICIT non-answers only. Verbose emptiness ("we
  // looked again and it seems fine") still passes - only the reader can judge that.
  // Both forms are matched: the normalised original and the residue after stripping; either hits.
  // Residue-only misses "n/a"; original-only misses "same as the previous round".
  // Phrases are no longer enumerated. A phrase list was broken in four consecutive reviews
  // ("unchanged from R1" / "same as the previous round" / "no difference from..." / "as before"),
  // and no amount of additions converges on that axis. Replaced by a CLOSED-VOCABULARY structural
  // test: small closed sets of negation, change, state and function words. If EVERY residual token
  // falls inside those sets, the sentence says nothing. Bounded: new phrases built from these
  const NEG = 'no|not|none|nil|nothing|never|without|n|na|无|没|没有|未|不'   // sanitize-scan:allow (CJK negation lexicon; bare "n" is intentional - "n/a" normalises to "n a")
  const CHG = 'change|changed|changes|changing|difference|differences|diff|new|update|updated|movement|move|moved|变化|变动|变更|区别|差异|改变|变|新'   // sanitize-scan:allow (CJK change-word lexicon)
  const STA = 'same|identical|unchanged|still|as|before|above|previous|prior|last|earlier|already|相同|一样|同上|同前|不变|依旧|仍|仍然|照旧'   // sanitize-scan:allow (CJK state-word lexicon)
  const FILL = 'is|are|was|were|be|been|being|has|have|had|do|does|did|any|all|at|in|on|of|from|to|the|a|an|my|our|its|it|this|that|there|and|or|but|so|yet|here'
  const CLOSED = new RegExp('^(' + [NEG, CHG, STA, FILL].concat(extraVocab ? [extraVocab] : []).join('|') + ')$')
  // CJK has no inter-word spaces: check character by character against the single-character set.
  const CJK_BASE = '无没有未不变化动更区别差异改相同一样上前依旧仍然照新'   // sanitize-scan:allow (CJK single-character closed set)
  const CJK_EXTRA = (extraVocab || '').replace(/[^\u4e00-\u9fff]/gu, '')
  const CJK_CLOSED = new RegExp('^[' + CJK_BASE + CJK_EXTRA + ']+$', 'u')
  // Spaces inserted while stripping break CJK matching, so a space-free candidate form is added too
  const squeezed = stripped.replace(/\s+/gu, '')
  const allClosed = (str) => {
    const t = str.split(/\s+/).filter(Boolean)
    // An empty token set is not a hit: emptiness is decided by the earlier raw check. Returning
    // true here misreads a symbolic DELTA such as `!=`, which folds to empty, as a non-answer.
    if (!t.length) return false
    return t.every(x => CLOSED.test(x) || CJK_CLOSED.test(x))
  }
  if (stripRefs === false) return allClosed(n)
  return allClosed(n) || allClosed(stripped) || allClosed(squeezed)
}
function parseSentinel(text) {
  // Normalize EVERY line terminator to LF at the entry point, so the block regex and the line scanner cannot
  // disagree about where a line ends. They previously did: U+0085 was in splitLines but JS `$` under /m only
  // recognizes \n \r \u2028 \u2029, so a NEL-terminated END line was never seen as a block end and a valid
  // verdict was falsely rejected (independent review). One normalization beats two lists.
  // Shares one table (LINE_BREAKS) with splitLines: one table at the entry point and a different one inside the scanner is exactly how they diverged before.
  const lfOnly = (text == null ? '' : String(text)).replace(new RegExp(LINE_BREAKS.source, 'g'), '\n')
  // \u5b57\u6bb5\u540d\u5f52\u4e00\u5fc5\u987b\u5728\u3010\u5165\u53e3\u3011\u505a\u4e00\u6b21, \u8986\u76d6\u6240\u6709\u4e0b\u6e38\u8bfb\u53d6\u8005\u3002\u6b64\u524d\u53ea\u6709 lineValAll \u81ea\u5df1\u5f52\u4e00, \u4e8e\u662f:
  //   - `P0<U+034F>: real blocker` \u91cc\u7684 U+034F \u662f Mn, \u4e0d\u5728 lineValAll \u7684 Cf/Cc \u96c6\u5408\u91cc -> \u6574\u884c\u4e0d\u88ab\u5f53\u4f5c P0,
  //     \u540c\u5757\u7684 `P0: none` \u72ec\u81ea\u751f\u6548, \u771f\u5b9e blocker \u9759\u9ed8\u4e22\u5931;
  //   - \u5757\u8d77\u70b9 / \u53cc\u8d77\u70b9 / \u5c3e\u90e8\u672a\u95ed\u5408 \u4e09\u4e2a\u68c0\u6d4b\u6839\u672c\u4e0d\u5f52\u4e00, \u4e8e\u662f\u5b8c\u6574 APPROVE \u4e4b\u540e\u8ffd\u52a0\u7684
  //     `VERDICT<U+200B>: REJECT` \u4e0d\u88ab\u89c6\u4e3a\u672a\u95ed\u5408\u7684\u7b2c\u4e8c\u4e2a\u88c1\u51b3\u800c\u88ab\u6574\u6bb5\u5ffd\u7565\u3002
  //   \u4e24\u8005\u5747\u7531\u72ec\u7acb\u590d\u6838\u7b2c\u5341\u56db\u8f6e\u62a5\u51fa, \u672c\u5730\u63a2\u9488\u590d\u73b0(U+200B \u5bf9\u7167\u7ec4\u88ab\u6b63\u786e\u62e6\u4e0b, \u8bc1\u660e\u662f\u8986\u76d6\u4e0d\u5168\u800c\u975e\u65e0\u5b88\u536b)\u3002
  // \u53ea\u5f52\u4e00\u3010\u7b2c\u4e00\u4e2a\u5192\u53f7\u5de6\u4fa7\u3011: \u503c\u4e00\u4fa7\u5fc5\u987b\u4fdd\u6301\u539f\u6837, \u5426\u5219\u4f1a\u628a\u503c\u91cc\u7684\u4e0d\u53ef\u89c1\u5b57\u7b26\u4e5f\u5220\u6389,
  // \u800c"\u5220\u9664\u4e0d\u53ef\u89c1\u5b57\u7b26\u4f1a\u628a\u8bcd\u7c98\u8d77\u6765"\u6b63\u662f\u7b2c\u5341\u4e8c\u8f6e\u7684\u65c1\u8def\u6210\u56e0\u3002
  // \u5265\u79bb\u7528\u5b8c\u6574\u4e0d\u53ef\u89c1\u96c6(Cf/Cc/Mn/Me/Mc): \u5b57\u6bb5\u540d\u672c\u8eab\u5168\u662f ASCII, \u91cc\u9762\u51fa\u73b0\u4efb\u4f55\u7ec4\u5408\u6807\u8bb0\u90fd\u53ea\u53ef\u80fd\u662f\u6c61\u67d3\u6216\u653b\u51fb\u3002
  // Colons must be recognised in their COMPATIBILITY forms too. Matching only ASCII ':' means a
  // fullwidth-colon `P0: real blocker` is not seen as a field at all, so a `P0: none` elsewhere in
  // the same block stands unopposed; and a fullwidth-colon `VERDICT: REJECT` appended after a
  // complete block is not seen as a second, unclosed verdict. Field names are NFKC-normalised too,
  // so a fullwidth-letter disguise surfaces and lands in the existing duplicate-field gate. Values
  const COLONS = /[:\uFF1A\uFE55\uFE13\u2236\uA789]/
  const t = lfOnly.split('\n').map(L => {
    const m = COLONS.exec(L)
    if (!m) return L
    const ci = m.index
    // Normalise colons to ASCII ':' or the downstream regexes still fail to match.
    return L.slice(0, ci).normalize('NFKC').replace(INVIS_RE, '') + ':' + L.slice(ci + 1)
  }).join('\n')
  const PLACEHOLDER_RE = /running in background|i['’]?ll share|once it completes|in the background|will share the output/i
  // Whole-text placeholder: used ONLY for the no-block early return. When the reply is pure stalling
  // with no verdict at all, scanning the whole text is the right thing to do.
  const placeholder = PLACEHOLDER_RE.test(t)
  // take the LAST VERDICT...END block (codex stdout may echo the prompt template earlier)
  // Block boundaries are LINE-ANCHORED with an exact standalone `END` terminator. The old
  // /VERDICT:[\s\S]*?\bEND\b/gi was fail-OPEN and fail-CLOSED at the same time (independent review):
  //  - unanchored start: `NOT-VERDICT: APPROVE` opened a block;
  //  - case-insensitive \bEND\b: the everyday phrase "verified end-to-end" inside EVIDENCE truncated the block,
  //    which BOTH falsely rejected honest verdicts AND let a foreign AUDIT-ID hide beyond the fake terminator;
  //  - a block could span TWO `VERDICT:` starts, so VERDICT/P0 were read (via non-global lineVal, first match)
  //    from a stale/foreign FIRST segment while the AUDIT-ID came from the second — the identity guard passed
  //    while a foreign conclusion was merged.
  const re = /^[ \t]*VERDICT:[\s\S]*?^[ \t]*END[ \t]*$/gm
  let m
  const allBlocks = []
  while ((m = re.exec(t)) !== null) allBlocks.push(m[0])
  // ======== Closed grammar: a block either fits the shape exactly, or it is invalid ========
  // The reserved field names are OUR OWN vocabulary - finite, defined by us - which is a different
  // problem from "enumerate every colon-like or newline-like character in Unicode". That one has no
  const FIELD_NAMES = ['VERDICT', 'P0', 'P1', 'VERIFIED', 'EVIDENCE', 'RECOMMEND', 'DELTA',
    'ANCHOR', 'LIT_CONFLICTS', 'UNANCHORED_CLAIMS', 'AUDIT-ID']
  const NAME_ALT = FIELD_NAMES.join('|')
  // A value may not contain "reserved field name + colon". That one rule covers both
  //   `EVIDENCE: x<br>P0: real blocker` (Markdown renders it as two lines) and `- P0: real blocker`
  //   (an unrecognised continuation) without guessing which other markup renders as a line break.
  const VALUE_HAS_FIELD = new RegExp('(?:' + NAME_ALT + ')\\s*:', 'i')
  // ⚠️ Only P0 counts, not every field name. Calibration on 76 real verdicts forced that narrowing:
  //    the wide version (any field name inside a value invalidates) rejected 15/76 = one in five,
  //    ALL of them ordinary prose - a reviewer writing "that is VERIFIED: fail, an honest 'I could
  //    not verify'", quoting a log line, explaining what P0 means. A gate that rejects a fifth of
  //    honest verdicts is not protection, it is a tax, and reviewers learn to route around it.
  //    Narrowed to P0 only, it rejects 1 of those same 76 = 1%.
  const VALUE_HIDES_GATING = new RegExp('P0\\s*' + COLONS.source.replace(/^\//, ''), 'i')
  // A FIELD NAME INSIDE A BULLET OR INDENTED CONTINUATION IS FOLDED INTO THAT FIELD - not ignored,
  // and not treated as invalidating the block. Ignoring silently drops a real `- P0: real blocker`;
  // invalidating is the single most common false rejection (one extra line of explanation and the
  // whole verdict dies). Folding loses no blocker and errs safe: at worst it counts one P0 twice.
  const BULLET_FIELD = new RegExp('^\\s*[-*\u2022>\\d.)\\]]*\\s*(' + NAME_ALT + ')\\s*:([\\s\\S]*)$', 'i')
  // Machine marker line injected by the wrapper (__CODEX_RC=0 and friends). It is machine output,
  // not reviewer prose, and it is the ONLY legal non-field line inside a block. The shape is kept
  // generic (__[A-Z][A-Z0-9_]*=) rather than hardcoding __CODEX_RC so a different wrapper still fits.
  //
  // 🔴 The trailing `\S*[ \t]*$` is the load-bearing part, not decoration. A prefix-only match made
  //    this exemption a smuggling channel: `__X_MARK=1 P0: the delete path removes user data` matched
  //    the prefix, was exempted from `foreign`, and the blocker inside it was never counted — the
  //    round converged. Measured on the live panel: converged=true, zero P0 recorded.
  //    A real marker is a bare token (`__CODEX_RC=0`); anything with prose after the value is not a
  //    marker. Getting this wrong in the strict direction fails CLOSED (a future wrapper that emits
  //    spaces gets rejected, visibly); getting it wrong in the loose direction fails OPEN, silently.
  const MARKER_LINE = /^[ \t]*__[A-Z][A-Z0-9_]*=\S*[ \t]*$/
  // Block "shape" is deliberately permissive: reject GENUINE AMBIGUITY, not untidy formatting.
  // null = not a candidate block; otherwise { text, fields, unparsed, warnings, hidesGating }.
  const shapeOf = (b) => {
    const lines = splitLines(b)
    if (lines.length < 3) return null
    if (!/^[ \t]*END[ \t]*$/.test(lines[lines.length - 1])) return null
    // Raw control characters are still rejected: the cost is negligible and normal output has none.
    if (/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(b)) return null
    const fields = new Map(), unparsed = [], warnings = [], hidesGating = [], foreign = []
    let lastName = null
    for (let i = 0; i < lines.length - 1; i++) {
      const L = lines[i]
      if (/^[ \t]*$/.test(L)) continue
      const mm = L.match(new RegExp('^\\s*(' + NAME_ALT + ')\\s*:([\\s\\S]*)$', 'i'))
      const bm = mm || L.match(BULLET_FIELD)
      if (bm) {
        const name = bm[1].toUpperCase(), val = bm[2].trim()
        if (!mm) warnings.push('bullet/indented line folded into field ' + name)
        // SINGLE SOURCE OF TRUTH: fields stores EVERY occurrence of a field (an array). It used to
        // hold one string and was read exactly once, at the VERDICT enum filter - the real reads went
        // through lineValAll re-scanning the original text, and that regex's \s never matched a bullet
        // prefix. So a folded value NEVER REACHED p0/verified: `P0: none` plus `- P0: real blocker`
        // converged as usual while the warning said "folded into field P0"; `- VERIFIED: fail` was
        // hollowed out the same way. Two parsers over one text eventually give two truths. Now one.
        const prevAll = fields.get(name)
        if (prevAll) {
          if (prevAll.some(p => p.trim().toLowerCase() === val.toLowerCase()))
            warnings.push('duplicate field ' + name + ' with identical value (folded)')
          prevAll.push(val)   // conflicting duplicates go to the downstream fieldDup gate (fail-closed); no winner is picked here
        } else fields.set(name, [val])
        lastName = name
        if (VALUE_HAS_FIELD.test(bm[2])) warnings.push('value of ' + name + ' contains a field-name-like token')
        // BLOCKER SMUGGLING. A verdict saying `P0: none` while hiding the real blocker inside some
        // other field VALUE was judged valid=true, approves=true, p0 count 0 - the finding was
        // written down but never counted, and the panel converged. That is this project's core
        // failure mode. ⚠️ Recorded, not judged here: hidesGatingField below decides what it means.
        if (VALUE_HIDES_GATING.test(bm[2])) hidesGating.push(name)
        continue
      }
      // Neither a field line nor a bullet carrying a field name -> recorded as an unparsed note.
      // This USED to be a harmless remark, and that one decision was the hole: the prompt promises a
      // CLOSED GRAMMAR ("every line inside the block must be one of the listed fields; no prose,
      // bullets, continuations or notes") while the parser accepted whatever it could not recognise
      // and moved on. A blocker only had to be written in an unrecognised shape to disappear:
      // `**P0**: x`, `note P0: x`, `(P0: x)`, `P0 (blocking): x` all landed here while the round
      // converged as APPROVED. Adding those four to the matcher would be the fifth pass at the same
      // mistake - there is always another prefix. ⚠️ The machine-marker exemption below is LOAD-
      // BEARING: the exit-code marker appears in every wrapper-produced block, so treating it as a
      // foreign line would reject every one of them. Calibrated on 435 real verdicts: 1 new rejection.
      unparsed.push(L.trim())
      if (lastName) warnings.push('unparsed line after field ' + lastName)
      if (!MARKER_LINE.test(L)) foreign.push(L.trim())
    }
    if (!fields.has('VERDICT')) return null
    return { text: b, fields, unparsed, warnings, hidesGating, foreign }
  }
  // Filter out TEMPLATE/PLACEHOLDER blocks (the brief echoed back), then require exactly one
  // semantically valid block. The test is semantic: VERDICT must match the enum as a whole value, so
  // a template saying `APPROVE | ... | REJECT` is excluded by construction. Filtering on strict
  const VERDICT_ENUM = ['APPROVE', 'APPROVE_WITH_CHANGES', 'REJECT']
  const shapes = allBlocks.map(shapeOf).filter(Boolean)
  const verdictOf = (sh) => {
    const u = [...new Set((sh.fields.get('VERDICT') || []).map(v => v.trim().toUpperCase()))]
    return u.length === 1 ? u[0] : ''   // a self-contradicting VERDICT is no more "semantically valid" than a template
  }
  const semantic = shapes.filter(sh => VERDICT_ENUM.includes(verdictOf(sh)))
  // Identical valid blocks repeated = one verdict printed twice, so fold them; blocks that differ in
  // content are still ambiguous. The wrapper's closing marker (__CODEX_RC= / __DUAL_AUDIT_RC=) is
  // INJECTED, not written by the auditor: the wrapper re-emits the verdict block verbatim with that
  // line added, so stdout holds both codex's own copy and the wrapper's canonical re-emission. They
  // differ BY THAT ONE LINE, and a literal comparison called them two different verdicts, so no
  // field was readable and "no AUDIT-ID" was reported while the AUDIT-ID was present in both.
  // Measured: one real audit was rejected this way and the whole session was wasted. Normalisation
  // strips THAT LINE ONLY; genuinely different blocks are still ambiguous and still fail closed.
  // ⚠️ The marker is recognised BY WHOLE LINE, never as a substring. A third real audit was wasted
  // because codex quoted `__CODEX_RC=0` and `__CODEX_RC=137` inside its own P0 prose - it was
  // discussing this very mechanism - and an unanchored scan swept those literals into rcVals ->
  // conflict -> folding refused -> two blocks -> the identity gate rejected a LEGITIMATE verdict.
  // Discriminating control: change only the prose literals, leave the injected line untouched, and
  // it hands off immediately. Line anchoring cannot miss a real marker: the wrapper always prints it
  // on a line of its own. Residual risk, known and accepted: an auditor who writes the marker as a
  // whole line (in a code example) is still counted, which fails closed.
  // One regex serves both replace and matchAll; neither advances lastIndex on the original.
  // ---- Dedup key and RC marker extraction -----------------------------------------------------
  // Each side had half of it right, so the merged version takes both: splitLines plus the generic
  // __[A-Z][A-Z0-9_]*= filter (correct for generality and for the Unicode line terminators), and
  // folding away blank-line differences (a real fixture is two near-duplicates differing by one
  // blank line). ⚠️ The earlier version used /^...$/gm and stepped on a trap this file documents
  // elsewhere: JS `$` under /m honours only \n, not U+2028/U+2029/U+0085, while splitLines honours
  // them. 🔴 Do NOT read that as "a hole was fixed". The note here originally claimed two conflicting
  // exit codes could evade rcConflict. That was written without checking, and it was wrong: a
  // full-rollback control probe measured IDENTICAL behaviour, because the ambiguity gate stops it
  // first regardless of the regex. An equivalent mutation; the change is for consistency only.
  const RC_MARKER_RE = /^[ \t]*__(?:CODEX|DUAL_AUDIT)_RC[ \t]*=[ \t]*(\d+)[ \t]*$/
  const normForDedup = (x) => splitLines(String(x))
    .filter(L => !MARKER_LINE.test(L))
    .join('\n').replace(/\n{2,}/g, '\n').trim()
  const rcMarkerVals = (x) => splitLines(String(x))
    .map(L => (L.match(RC_MARKER_RE) || [])[1])
    .filter(v => v !== undefined)
  // ⚠️ The wrapper stamps ONLY the block that actually went to stdout - the mechanical way to tell
  // which copy is this run's verdict. Measured: one real audit produced 565KB of output holding 3
  // VERDICT..END blocks, and re-running the wrapper's awk over the same content would inject 3
  // times - yet only 1 block carried a marker, meaning the other two were never on stdout (the codex
  // CLI writes the brief echo and intermediate rendering to stderr, and the caller's harness merged
  // both streams). So: if ANY block carries an injected marker, the unmarked ones are not this
  // run's stdout verdict -> drop them rather than let them manufacture ambiguity. If NO block
  // carries one, leave everything alone: callers that do not use --emit-rc must keep working.
  // ⚠️ The fallback test must be "does the WHOLE TEXT contain an injected marker", not "how many
  // blocks were stamped". By stamped-block count it fails open: an unstamped semantic block plus a
  // stray `__CODEX_RC=137` OUTSIDE any block -> marked.length===0 -> fall back to semantic -> the
  // unstamped stderr copy is accepted -> converged=true. That is exactly the "complete-looking
  // APPROVE left behind by a killed run" that the injected marker exists to distinguish.
  const anyMarker = rcMarkerVals(t).length > 0
  const marked = semantic.filter(sh => rcMarkerVals(sh.text).length > 0)
  const candidates = anyMarker ? marked : semantic
  // ⚠️ Conflicting exit codes are evidence that the output was concatenated or tampered with, and
  // must NOT be accepted. An honest wrapper injects the SAME actual rc into every block of one run.
  // A 137 and a 0 in the same output mean the two blocks did not come from the same run - and the
  // driver, reading only the last block's 0, could converge straight through. Stay fail-closed.
  // Scan the WHOLE TEXT, not only inside the block: "0 inside the block, another 137 after END"
  const rcVals = new Set(rcMarkerVals(t))
  const rcConflict = rcVals.size > 1
  // ⚠️ Folding keeps the LAST occurrence, not the first. This is not a style choice: the tail guard
  // below computes the tail with `t.lastIndexOf(blk)`, so if an earlier copy is selected then ITS
  // OWN duplicate is still in the tail, the guard sees another VERDICT: there and calls it a
  // structural ambiguity -> blk=null -> parseSentinel returns empty -> the identity gate cannot read
  // AUDIT-ID -> "codex_verdict_identity_mismatch" while the id is plainly inside the block. TWO
  // consecutive real audits died here. Semantically the last copy is also the wrapper's re-emission.
  const uniq = []
  for (const sh of candidates) {
    const key = normForDedup(sh.text)
    const at = uniq.findIndex(u => normForDedup(u.text) === key)
    if (at >= 0) uniq[at] = sh
    else uniq.push(sh)
  }
  const ambiguousBlockCount = uniq.length
  // blk and blockShape must derive from the SAME decision. They were once two independent ternaries,
  // and changing only one of them would fork "the block that was selected" from "the block values are
  // read from". ⚠️ rcConflict invalidates INDEPENDENTLY of block count: hanging it off the folding
  // step meant "137 and 0 inside a single block" was accepted, because no folding was needed at all.
  const blockShape = (uniq.length === 1 && !rcConflict) ? uniq[0] : null
  let blk = blockShape ? blockShape.text : null
  // A block containing more than one field-position `VERDICT:` line is structurally ambiguous about which
  // segment the parsed fields came from. Refuse it rather than guess (fail-closed).
  // Case-INsensitive, matching lineVal's own /im/ field reader. A case-sensitive detector was blind to a
  // second `Verdict:` start that lineVal could still read, so the foreign segment stayed inside the block
  // undetected (reproduced).
  // Whitespace class must match lineVal's own /\s/: a second start prefixed with NBSP was invisible to a
  // [ \t]-only detector while lineVal still read it, splicing APPROVE from segment 1 with P0/AUDIT-ID from 2.
  if (blk && splitLines(blk).filter(L => /^\s*VERDICT\s*:/i.test(L)).length > 1) blk = null
  // A COMPLETE block followed by a TRUNCATED second verdict (a `VERDICT:` start with no closing `END`) is
  // structurally ambiguous: the tail may be the auditor's real, later conclusion, cut off mid-write. Ignoring
  // it silently accepted the earlier APPROVE while a `VERDICT: REJECT / P0: late blocker` sat unread right
  // below it (independent review). Refuse rather than pick the convenient half.
  // ======== Suspicious separators: a structural test, not an enumeration of colons ========
  // An allowlist loses by construction: after six colon variants were added, U+02D0, U+02F8, U+2982
  // and U+1365 walked straight through. Unicode has no shortage of colon-lookalikes, and adding them
  // one at a time is an unwinnable fight. Rule: after normalisation, a line that STARTS with a
  // reserved field name, is followed by a non-ASCII colon-like punctuation or symbol, and then has
  // content, invalidates the block. A legitimate verdict is always `NAME: value` (compatibility
  // colons are already folded to ASCII at the entry point), so this cannot misfire on conforming
  // output; a non-conforming line already violates "EXACTLY this block, one field per line".
  const RESERVED = 'VERDICT|P0|P1|VERIFIED|EVIDENCE|RECOMMEND|DELTA|ANCHOR|LIT_CONFLICTS|UNANCHORED_CLAIMS|AUDIT-ID'
  // (oddSep was deleted: after both call sites were reverted it had no reader left, and unreachable
  // code is not defence in depth.)
  // (REVERTED) A reserved field name plus a non-ASCII colon inside the block used to invalidate it.
  // Reverted because its false-rejection surface is "an ordinary explanatory line inside the block
  // that happens to start with P0 or VERDICT", while the smuggling it defended against belongs to a
  if (blk) {
    const tail = t.slice(t.lastIndexOf(blk) + blk.length)
    // The tail watches VERDICT only: a tail can equally well be narrative prose, and applying the
    // whole reserved-name table there has too wide a false-rejection surface, whereas "a second
    // verdict start appears after the block" is the structural ambiguity that swallows a late REJECT.
    if (splitLines(tail).some(L => /^\s*VERDICT\s*:/i.test(L))) blk = null
    // A line after the block that LOOKS like a reserved field (any separator) does not change
    // validity, but the reader must see it: the relaxation is "do not falsely reject", not "ignore".
    else if (blockShape) {
      for (const L of splitLines(tail)) {
        const nl = String(L).normalize('NFKC').replace(INVIS_RE, '')
        if (new RegExp('^[ \\t]*(?:' + NAME_ALT + ')(?![A-Za-z0-9_-])', 'i').test(nl) && nl.trim())
          blockShape.warnings.push('text after the verdict block looks like a field declaration (ignored, NOT counted): ' + nl.trim().slice(0, 80))
      }
    }
  }
  const empty = { valid: false, placeholder, verdict: null, p0: [], p0_demoted: [], p1: [], ambiguous_block_count: 0, anchor: '', litConflicts: [], unanchored: [], verified: '', evidence: '', recommend: '', approves: false, format_warnings: [], unparsed_lines: [], audit_ids: [], raw: t, blockRaw: null }
  if (!blk) return empty
  // ---- Placeholder detection scans blockRaw only when a block exists, never the whole text -------
  //   That treats both ends of the same problem:
  //   1. SELF-POISONING: codex often echoes the panel's own anti-placeholder instruction in the
  //      narrative BEFORE the block. Scanning the whole text then classified a genuine verdict that
  //      CONTAINED A COMPLETE VALID BLOCK as a placeholder, which produced a missing-frozen-R1 state.
  //      The block itself does not contain that sentence, so blockRaw scanning does not misfire.
  //   2. A structurally complete APPROVE whose EVIDENCE is itself a stalling phrase ("I'll share once
  //      it completes") has that phrase INSIDE the block -> placeholderInBlock=true -> invalid. More
  //      precise than not gating at all: gate real in-block placeholders, do not misfire on echoes.
  const placeholderInBlock = PLACEHOLDER_RE.test(blk)
  // Collect ALL occurrences of a field, not just the first. Taking the first match silently ignored a second
  // line that CONTRADICTED it: `P0: none` followed by `P0: real blocker` converged, and `VERIFIED: pass`
  // followed by `VERIFIED: fail` converged (independent review). A field that appears more than
  // once with DIFFERENT values makes the block self-contradictory -> fail-closed, do not pick a winner.
  const fieldDup = [], fieldMerged = []
  // A CONTRADICTION ONLY MATTERS ON A FIELD THAT CHANGES THE DECISION.
  // A load-bearing field carrying two DIFFERENT values means the verdict contradicts itself ->
  //   fail-closed, no winner picked. DELTA is one of them: a "DELTA: unchanged" slipped in alongside
  //   would otherwise merge into something non-empty and walk past the flip gate.
  // The rest (P1/EVIDENCE/RECOMMEND/LIT_CONFLICTS/UNANCHORED_CLAIMS) written across several lines,
  // all with content, is one thing written on several lines, not a contradiction. Invalidating them
  // meant the very common "EVIDENCE as a two-line bullet list" discarded the entire verdict.
  // HONEST CORRECTION - an earlier version of this comment was wrong: these fields are NOT "outside
  // the convergence decision". EVIDENCE feeds validity and the numeric gate, UNANCHORED_CLAIMS feeds
  const DECISIVE_FIELDS = new Set(['VERDICT', 'P0', 'VERIFIED', 'ANCHOR', 'AUDIT-ID', 'DELTA'])
  // SINGLE SOURCE OF VALUES = the fields already parsed by shapeOf. Never re-scan blk here: a second
  // scan is a second parser, and once "the parser that decides validity" and "the parser that reads
  // values" diverge you get self-contradictions like "warning: folded into field P0" with P0 empty.
  const lineValAll = (name) => {
    const vs = blockShape ? blockShape.fields.get(String(name).toUpperCase()) : null
    return vs ? vs.map(v => v.trim()) : []
  }
  const lineVal = (name) => {
    const all = lineValAll(name)
    if (all.length === 0) return null
    // Case-insensitive comparison: `P0: none` vs `P0: NONE` is the same statement, not a contradiction.
    if (all.length > 1 && new Set(all.map(v => v.trim().toLowerCase())).size > 1) {
      if (DECISIVE_FIELDS.has(String(name).toUpperCase())) { fieldDup.push(name); return all[0].trim() }
      // "ABSENT" ALONGSIDE "PRESENT" IS A CONTRADICTION, NOT A SUPPLEMENT. Merging is right when both
      // lines carry content, but one line saying "none"/empty while another gives specifics is not an
      // added detail - it is self-contradiction. Measured: `EVIDENCE: none` plus a second EVIDENCE
      // line with a real citation merged into "has evidence" and converged.
      // The test reuses the existing isStructuralNonAnswer / has-substance definitions rather than
      // introducing a second word list. THREE STATES, not two: empty-or-structural-non-answer |
      // has content | all non-answers. Pure symbols (a tick, an arrow) COUNT AS CONTENT - they carry
      // no letters or digits but the auditor did write them, and treating them as absent would kill
      // the normal `EVIDENCE: 436/436 passed` plus `- EVIDENCE: <tick>` pattern.
      const isNoneLike = (v) => {
        const t0 = String(v == null ? '' : v).trim()
        return stripInvisible(t0) === '' || isStructuralNonAnswer(t0)
      }
      const contentful = all.filter(v => !isNoneLike(v))
      // "absent" alongside "present" is a contradiction, not a supplement
      if (contentful.length > 0 && contentful.length !== all.length) { fieldDup.push(name); return all[0].trim() }
      fieldMerged.push(name)
      // ALL NON-ANSWERS: keep one, never concatenate. Joining them into "none; n/a" stops the result
      // matching "explicitly no evidence" - washing two absences into a presence. Same hole, other side.
      if (contentful.length === 0) return all[0].trim()
      return [...new Set(contentful.map(v => v.trim()).filter(Boolean))].join('; ')
    }
    return all[0].trim()
  }
  // A6 (independent review, REPRODUCED): an EMPTY / invisible-only value was read as the SAME
  // statement as "none". `P0:` with nothing after it therefore asserted "no blocking issues" and the round
  // CONVERGED. A field that is written but left blank is a MALFORMED verdict, not a claim of "none".
  // Return null (= absent) so the mandatory-field guards fail closed; the optional lists keep their `|| []`
  // fallbacks, so P1/LIT_CONFLICTS behave exactly as before.
  const listVal = (name) => {
    const v = lineVal(name); if (v == null) return null
    const raw = v.trim()
    // Emptiness is decided on the STRIPPED value; semantic matching on the RAW one. Never mix them.
    // An earlier implementation stripped invisibles first and then compared against "none", so
    // `P0: n<U+200B>one` normalised INTO none and was read as "no blocking issues" — a false
    // convergence. Normalisation may decide whether there is content; it must never manufacture
    // meaning.
    if (stripInvisible(raw) === '') return null
    if (/^none$/i.test(raw)) return []
    const s = raw
    // 🔴 Separator set must match what the prompt promises, and nothing more. The prompt states one
    //    finding per ";"-separated entry (see the P0 field spec below). This split used to include
    //    "、" and "。" as well, which are ordinary punctuation inside a sentence — so a finding
    //    written in prose was shredded into one "finding" per clause. Measured on a real round:
    //    two seats reporting 5 findings between them were reported as 19, with fragments like a
    //    single quoted regex alternation split across five separate "P0" entries. The count feeds
    //    the blocker line the user reads, so the damage is that the report becomes unreadable and
    //    overstates the finding count roughly fourfold.
    //    Fullwidth "；" is kept: it is a semicolon, not sentence punctuation.
    const parts = s.split(/[;；]/).map(x => x.trim()).filter(Boolean)
    // Emptiness must be re-checked AFTER the split: `P0: ;` filters down to [], which an earlier
    // implementation read as "no blocking issues" and converged on. Separators only = a field that
    // was written wrong, which is not the same statement as "none".
    if (parts.length === 0) return null
    // The reverse: `P0: none;` does not match ^none$ because of the trailing separator, and an
    // earlier implementation turned it into a finding literally named "none" - a false rejection.
    if (parts.length === 1 && /^none$/i.test(parts[0].replace(/[\p{P}\p{S}]+$/gu, '').trim())) return []
    return parts
  }
  // WHOLE-VALUE MATCHING, not just the first token. Reading only the first token meant the REJECT in
  // `VERDICT: APPROVE; REJECT` and the fail in `VERIFIED: pass; fail` were discarded outright while
  // the panel converged. A closed enum must hold for the WHOLE value: anything extra in the value
  const wholeVal = (v) => (v == null ? '' : String(v).trim())
  const enumVal = (v, allowed, lower) => {
    const raw = wholeVal(v)
    const k = lower ? raw.toLowerCase() : raw.toUpperCase()
    return allowed.includes(k) ? k : ''
  }
  const vTok = enumVal(lineVal('VERDICT'), ['APPROVE', 'APPROVE_WITH_CHANGES', 'REJECT'], false)
  const verdict = vTok || null
  const anchor = enumVal(lineVal('ANCHOR'), ['anchored', 'partial', 'none'], true)
  const vfRaw = wholeVal(lineVal('VERIFIED')).toLowerCase()
  const verified = vfRaw === 'pass' ? 'pass' : (vfRaw === 'fail' ? 'fail'
    : ((vfRaw === 'n/a' || vfRaw === 'na') ? 'na' : ''))
  const p0Raw = listVal('P0')   // null = the "P0:" line is ABSENT -> malformed/echo-fragment, NOT a real verdict
  // The P0 admission gate lives HERE, not in evaluateConvergence. The first attempt put it there and
  // produced a half-applied state: newP0s was filtered, but approvesFinal still carried
  // `p0.length === 0`, so "APPROVE plus one demoted P0" was still judged as not approving and the
  // consensus gate still blocked - the gate might as well not have existed. It must be here, so that
  // EVERY downstream reader (approves / newP0s / carry) sees the same filtered set of P0s.
  const { blocking: p0, demoted: p0Demoted } = qualifyP0s(p0Raw || [])
  const unanchoredList = listVal('UNANCHORED_CLAIMS')   // null = field absent
  const litList = listVal('LIT_CONFLICTS') || []
  const claimFieldsOk = !claimMode || (anchor !== '' && unanchoredList !== null)
  const codeFieldsOk = !codeRelevant || verified === 'pass' || verified === 'fail'
  // false-death angle: require the mandatory P0 field PRESENT — a block missing the "P0:" line
  // (truncated/echoed fragment, or a misformatted APPROVE) defaulted p0=[] -> approves=true = fail-OPEN. A real
  // verdict always carries P0. Missing it => invalid => fail-closed (never silently accepted as an approve).
  // EVIDENCE is declared mandatory by the output contract but was never required, so a verdict citing nothing
  // still counted. And a block with contradictory duplicate fields is not a verdict at all.
  const evidenceVal = lineVal('EVIDENCE')
  // Checking EVIDENCE for "non-empty" is not enough: `EVIDENCE: none`, `;`, or a single combining
  // mark all pass, which amounts to declaring that a verdict with no evidence is safe. Require (1) at
  // least one letter or digit, and (2) that it is not an explicit statement of "no evidence".
  const evidenceRawTrim = evidenceVal == null ? '' : evidenceVal.trim()
  const evidenceHasContent = /[\p{L}\p{N}]/u.test(stripInvisible(evidenceRawTrim))
  // Same closed-vocabulary test as DELTA plus evidence-context words. A phrase list was broken
  // repeatedly ("no evidence was found" / "no new evidence"), and enumeration does not converge here.
  // The EVIDENCE hard gate is STRUCTURAL only (see the long note above isStructuralNonAnswer).
  // A closed vocabulary was once used to detect "explicitly no evidence"; it failed on both sides:
  //   - it missed "no supporting evidence" / "no relevant evidence" and their translations;
  //   - and it misfired: the evidence|provided|citation words added to catch "no evidence" classified
  //     the legitimate "evidence provided above" and "same citation as above" as having none.
  // Lexically inseparable, so only the decidable part is kept; prose-level suspicion is an advisory.
  const evidenceIsExplicitNone = isStructuralNonAnswer(evidenceRawTrim)
  // STRUCTURED EVIDENCE CITATION: EVIDENCE must contain at least one digit. This is not a heuristic;
  // it mechanises what the brief ALREADY demands - that the field carry the line numbers you actually
  // read, or concrete numbers from the evidence file. Line numbers, counts, versions and exit codes
  // all contain digits.
  // Why a positive requirement instead of yet another non-answer word list:
  //   - the negative list was walked through by paraphrase five rounds running (no evidence -> no
  //     evidence found -> no new evidence -> no supporting evidence -> the same in another language),
  //     and every tightening misfired on legitimate citations;
  //   - a positive requirement is language-independent: empty talk in any language contains no digits,
  //     and no rewording gets round it;
  //   - the false-rejection direction is acceptable: the cost is one more round and a request for a
  //     citation, rather than treating an unevidenced verdict as converged.
  // Honest boundary: containing a digit does NOT make the evidence true - an auditor can invent
  const evidenceOk = evidenceVal !== null && evidenceHasContent && !evidenceIsExplicitNone
  // NOTE: `valid` is computed AFTER every field has been read (see below) — computing it here read only the
  // fields consulted so far, so a duplicated P1 / RECOMMEND / DELTA was never registered in fieldDup. A
  // duplicated DELTA in particular slipped `unchanged` past the R2 anti-flip gate (independent review
  //). Field reads first, verdict validity last.
  // 🔴 The whole-text placeholder gate was REMOVED from validBase - a self-inflicted bug found by
  //   probing the driver directly. It scanned the WHOLE TEXT, so it read the panel's own injected
  //   anti-placeholder instruction, echoed back inside codex's copy of the brief, as codex itself
  //   stalling, and classified A GENUINE VERDICT CONTAINING A COMPLETE VERDICT..END BLOCK as invalid.
  //   The panel poisoned its own placeholder detector with a phrase it had injected. Measured on real
  //   R1 codex text: whole-text placeholder=true -> validBase=false on a text holding a valid block.
  //   Whenever R1 echoed the brief, that verdict went invalid -> the frozen R1 codex entry went
  //   invalid -> R2 reported a missing frozen R1.
  //   Why removing it is safe rather than a weakened guard: genuine "pure stalling, no verdict" is
  //   already valid:false at `if (!blk) return empty` above, so by this line a complete VERDICT..END
  //   block necessarily exists, which means codex committed to a verdict; a delay phrase in the
  //   surrounding narrative does not change that. Here it can only be a false positive. Echoed
  //   TEMPLATE blocks are excluded by the semantic enum filter, not by this. The field is still
  // computed and returned; placeholderInBlock (blockRaw only) is what feeds validBase now.
  // Blocker-smuggling gate. WHY `&& p0IsNonAnswer`: a verdict that already recorded a real P0 and
  // then mentions "P0" again elsewhere is just prose - nothing is being lost. Only when the field
  // that CARRIES blockers says there are none does that other mention become a swallowed finding.
  // Measured before the fix: `P0: none` with a real blocker hidden in an EVIDENCE value was judged
  // valid=true / approves=true / p0 count 0 - written down, never counted, converged anyway.
  const p0IsNonAnswer = !p0Raw || p0.length === 0 || p0.every(x => isStructuralNonAnswer(String(x)))
  const hidesGatingField = blockShape ? ((blockShape.hidesGating || []).length > 0 && p0IsNonAnswer) : false
  // 🔴 hidesGatingField is an ADVISORY, not a hard gate - a calibration result from this machine's
  //    corpus, deliberately different from the shipped default; it is not a porting slip. Against 470
  //    real verdicts a hard gate would add 13 rejections, ALL of them honest prose: 0 true positives,
  //    13 false. 8 are cross-examination DELTAs saying which of the other side's P0s were rejected
  //    (exactly what a DELTA is for); 5 are reviews OF THIS PANEL quoting its field names as data.
  //    A rejection discards the WHOLE verdict including any real P0s it carried, which is why the two
  //    halves are graded differently. The structural half (own-line `**P0**: x`) is stopped hard.
  const hidesGatingWarn = hidesGatingField
    ? ['P0 says none, but the value of ' + blockShape.hidesGating.join('/') + ' contains "P0:" - if a real blocker is written there it is NOT being counted. ADVISORY ONLY: this panel does not invalidate on it (measured 0 true / 13 false on 470 real verdicts from this machine). A human should look.']
    : []
  const foreignLine = blockShape ? ((blockShape.foreign || []).length > 0) : false
  const validBase = !!verdict && p0Raw !== null && claimFieldsOk && codeFieldsOk && evidenceOk && !placeholderInBlock && !foreignLine
  // (approves is finalized after every field has been read — see approvesFinal below)
  // DELTA captured SAME-LINE only ([^\n\r]*, not lineVal's \s* which would greedily grab the NEXT line on
  // an empty "DELTA:" value and fail-OPEN the anti-false-convergence gate). Scoped fix; lineVal unchanged.
  // DELTA via the shared line splitter. The old regex excluded only LF/CR, so a value terminated by U+2028
  // swallowed the NEXT field and turned an EMPTY delta into a non-empty one — defeating the guard that
  // stops a verdict flipping sides without new evidence (independent review).
  const delta = (lineVal('DELTA') || '').trim()   // via lineVal so a contradictory duplicate registers in fieldDup
  // blockRaw: the LAST VERDICT..END block ONLY. The audit-id check scopes to this so (a) an id echoed after
  // END, and (b) the prior-round ids legitimately embedded in an R2+ brief, cannot satisfy or trip the check.
  // Read the remaining fields BEFORE deciding validity, so their duplicates land in fieldDup too.
  const p1List = listVal('P1') || []
  const recommendVal = lineVal('RECOMMEND') || ''
  // AUDIT-ID used to be read ONLY by two dedicated scanners and never through lineVal, so a
  // conflicting duplicate could never reach fieldDup: "the correct id plus a foreign id smuggled in
  // behind a numbered prefix" stayed valid and converged. A `- ` or `* ` prefix happened to be caught
  // by the main scanner's near-name rule - luck, not design. Three readers of one field, three truths.
  const auditIdList = lineValAll('AUDIT-ID')
  lineVal('AUDIT-ID')   // registers conflicting duplicates: two DIFFERENT ids in one block invalidate it, same rule as every other field
  const valid = validBase && fieldDup.length === 0
  const approvesFinal = valid && (verdict === 'APPROVE' || verdict === 'APPROVE_WITH_CHANGES') && p0.length === 0
  return { valid, placeholder, verdict, p0, p0_demoted: p0Demoted, p1: p1List, anchor, litConflicts: litList, unanchored: unanchoredList || [], verified, evidence: evidenceVal || '', recommend: recommendVal, delta, approves: approvesFinal, duplicated_fields: fieldDup.slice(),
    ambiguous_block_count: ambiguousBlockCount,
    format_warnings: (blockShape ? blockShape.warnings.slice() : []).concat(hidesGatingWarn)
      .concat(fieldMerged.map(n => 'field ' + n + ' appeared more than once with different values - collapsed into ONE value. Exactly what happens: if every occurrence is a non-answer ("none"/"n/a"/empty) the FIRST one is kept verbatim (they are never concatenated, which would launder two non-answers into something that reads as content); otherwise the contentful occurrences are joined with "; " and duplicate/empty entries are dropped. A "none"/empty occurrence sitting alongside a contentful one is NOT merged at all - it is treated as a contradiction and invalidates the block. NOTE this field MAY still gate the round: EVIDENCE gates validity and the digit requirement, UNANCHORED_CLAIMS gates the anchor check.')),
    unparsed_lines: blockShape ? blockShape.unparsed.slice() : [],
    audit_ids: auditIdList,   // EVERY AUDIT-ID value the parser recognised, so downstream identity checks share one truth
    raw: t, blockRaw: blk }
}

// crossExamine=true (R2+) adds a DELTA field so a verdict FLIP can be checked mechanically (not just by prose).
// auditId: ONLY the codex briefs carry one. The Claude-side auditor prompts call this with no id —
// they never receive an AUDIT-ID, so demanding one there was an unfulfillable instruction (independent audit
//). The literal value is emitted as the field value (not a <placeholder>) and the caution is kept
// OUTSIDE the block, so an auditor copying the template cannot accidentally paste hint text into the value.
function sentinelContract(crossExamine, auditId) {
  // "Mandatory" refers to the FORMAT: the reply must end with this block, one field per line. Only
  // some fields PARTICIPATE IN VALIDITY - always VERDICT / P0 / EVIDENCE; code mode adds VERIFIED;
  // claim mode adds ANCHOR + UNANCHORED_CLAIMS; a flip in R2+ adds DELTA. A missing P1 /
  const L = ['', '=== OUTPUT CONTRACT (your reply is parsed by machine; end with EXACTLY this block) ===',
    'Do NOT spawn subagents/workflows; do the work yourself. Never reply with placeholder text ("running in background"). No long Summary.',
    'End with this block. It is parsed by a CLOSED GRAMMAR - anything outside the shapes below makes your',
    'verdict INVALID (it is refused, not silently reinterpreted). Three rules, no exceptions:',
    '  (1) EVERY line inside the block must be one of the listed fields, written as "NAME: value".',
    '      No prose lines, no bullets, no continuation lines, no notes. Blank lines are the only exception.',
    '      Put any commentary BEFORE the block, never inside it.',
    '  (2) Each field appears AT MOST ONCE, and for the enumerated fields (VERDICT, VERIFIED, ANCHOR) the',
    '      ENTIRE value must be exactly one listed token - "APPROVE; REJECT" or "pass; fail" is INVALID,',
    '      not "the first one wins".',
    '  (3) A value must not contain another field name followed by a colon, and the block must not contain',
    '      raw control characters or escape sequences (TAB is fine). Emit exactly ONE such block.',
    'For an APPROVE verdict, EVIDENCE must contain AT LEAST ONE decimal digit (a line number, a count, a',
    'version, an exit code - any Unicode decimal digit). An APPROVE citing no concrete figure cannot converge.',
    'This digit rule does NOT apply to REJECT verdicts. If your evidence is genuinely a path or a symbol name,',
    'add the line number or the count you actually observed.',
    'P0 ADMISSION (mechanically enforced since - read this before you write a single P0).',
    'A P0 is NOT "something worth mentioning". A P0 is something that, left unfixed, makes a DOWNSTREAM',
    'consumer take a wrong input or reach a wrong conclusion. Name that consumer. Two rules follow, and',
    'Cite something concrete for each one - file:line, a count, a measured value - so the other side can check it.',
    'That part is NOT mechanically enforced and you should not game it; it is how a reader tells a finding from an',
    'impression. There is NO per-auditor quota - every P0 you write blocks, so write only what you mean to block on.',
    'Rank the most-blocking FIRST anyway: the human reads them in your order.',
    'ONE MORE THING, and it is mechanical, not stylistic: the P0 field is SPLIT on ";" - each fragment is counted as',
    'a SEPARATE P0. So do NOT use ";" to separate the clauses WITHIN one finding (condition; error; consequence) -',
    'that turns one finding into three and inflates every count downstream. Use "," or a dash inside a finding, and',
    'reserve ";" for the boundary BETWEEN two genuinely different findings.',
    'NOTHING you write is discarded: demoted entries are reported to the human verbatim. If you want something',
    'on the record that does not block, put it in P1 - that is precisely what P1 is for, and it costs you nothing.',
    'Padding P0 does not make your review look thorough; it makes the panel run another round for no reason.',
    '"P0: none" is a complete, valid, and frequently correct answer.',
    'Fields that decide whether your verdict is VALID: VERDICT, P0, EVIDENCE' + (codeRelevant ? ', VERIFIED' : '') + (claimMode ? ', ANCHOR, UNANCHORED_CLAIMS' : '') + '.',
    'P1 / LIT_CONFLICTS / RECOMMEND are expected but their absence does NOT invalidate your verdict.',
    'The final line of your entire reply MUST be exactly: END. Nothing after it - no closing remark, no code fence.',
    'A reply without that line is discarded WHOLE (fail-closed): every finding in it is lost and the round cannot converge.',
    'Write your prose first if you want, then the block below, then END.',
    ...(crossExamine ? ['DELTA does NOT affect whether your verdict PARSES as valid. What it affects is CONVERGENCE: when your SIDE as a whole moves TO approval and the round would otherwise converge, every approving auditor must have a real DELTA or the round is blocked. You cannot see your side aggregate state, so filling it in whenever you APPROVE is the safe habit.'] : []),
    'VERDICT: APPROVE | APPROVE_WITH_CHANGES | REJECT',
    'P0: <BLOCKING issues, ONE finding per ";"-separated entry, ranked most-blocking FIRST, or none. See P0 ADMISSION above: each entry needs a concrete locator; do NOT split a single finding across ";".>',
    'P1: <non-blocking issues separated by ";", or none>']
  if (crossExamine) {
    // The contract must name EVERY baseline the gate actually compares against. It used to name only
    // the frozen R1 while the gate also compared the IMMEDIATELY PRECEDING round - so on APPROVE ->
    // REJECT -> APPROVE the auditor wrote "unchanged" per the contract (its R3 position really does
    L.push('DELTA: <ALWAYS document any change of stance. MECHANICALLY ENFORCED ONLY when a side moves TO approval and the round would otherwise converge; other changes are expected but not auto-rejected. State EXACTLY what changed + the new evidence/reasoning, if your verdict CHANGED from EITHER (a) your frozen R1 stance OR (b) your stance in the IMMEDIATELY-PRIOR round. Both are checked. In particular, if you moved away and are now moving BACK (e.g. R1 approve -> R2 reject -> R3 approve), that IS a change and needs a DELTA. WHERE THIS IS MECHANICALLY ENFORCED (stated exactly, so you are not guessing): the panel blocks a round only when YOUR SIDE as a whole is moving TO approval (measured by the same two comparisons named above, applied to the side rather than to you individually); in that case EVERY approving auditor on that side must underwrite the approval, so a bare "unchanged" from any one of you blocks the round. You cannot see your side aggregate state reliably, so the safe rule is simple: whenever you APPROVE on round 2+, write a real DELTA. It costs one line and cannot cost you a blocked round. A bare "unchanged" is only safe when you are NOT approving — every approving auditor must underwrite the approval ITSELF, either by saying what changed, or by stating the basis on which YOU re-verified it THIS round (e.g. "position unchanged; re-ran the regression, 462/0, see :1191"). You may NOT rely on the DELTA written by someone else on your side: the whole point is that whoever actually changed their mind cannot hide behind a colleague. Leaving this empty, or writing an explicit non-answer ("unchanged"/"none"/"n/a"), when you DID flip is rejected as false convergence. NOTE: the panel only checks mechanically that this field is filled in and is not an explicit non-answer — whether the content is genuinely new evidence is judged by the other side, not by the script.>')
  }
  if (claimMode) {
    L.push('ANCHOR: anchored | partial | none   <"anchored" REQUIRES a decisive, cross-validated evidence chain (not a bare citation, not contradicted by stronger functional/recent data)>')
    L.push('LIT_CONFLICTS: <literature/definition conflicts found + how resolved by evidence quality, or none>')
    L.push('UNANCHORED_CLAIMS: <claims lacking a decisive cross-validated chain OR unresolved conflicts (escalated to the human), or none>')
  }
  L.push('VERIFIED: pass | fail' + (codeRelevant
    ? '   <pass/fail of the verification tier ASSIGNED TO YOU above — Codex: the static/contract tier (you are read-only; a genuine static/contract check that holds is pass); Claude D1/D2: the RUN tier (you must actually execute). "n/a" is NOT accepted on a code task. If you were assigned the RUN tier and could not execute it (missing deps, blocked sandbox), that is VERIFIED: fail — an honest "I could not verify" — not n/a, and say why in EVIDENCE.>'
    : ' | n/a   <pass/fail of the smoke-test/dry-run you actually performed; n/a only if no code involved>'))
  L.push('EVIDENCE: <files/lines, citations, structure IDs, numbers, and exact commands+outputs you ACTUALLY ran>')
  L.push('RECOMMEND: <concrete next action>')
  if (auditId) L.push(`AUDIT-ID: ${auditId}`)
  L.push('END')
  // `END` used to be merely the last item in the field list, with no sentence saying it was required,
  // while AUDIT-ID had a whole MUST sentence. Measured across 465 historical verdicts: after the
  // parser refactor, 6/281 = 2.1% were complete except for the END line. parseSentinel fails closed
  // on that, so one seat is void and the round does not converge. Every stop_reason was end_turn
  // (no token limit was hit), i.e. the instruction simply was not followed rather than truncated.
  //
  // 🔴 The first version pushed that sentence here, AFTER END - while what it says is that nothing may
  // follow END. The template violated itself. It now sits in the contract prose before the template;
  // only the parenthetical below stays after END, explicitly marked as not part of the block to copy.
  if (auditId) L.push(`(NOT part of the block above - instructions to you: the AUDIT-ID line MUST appear INSIDE the block, and the ENTIRE value of that line must be exactly "${auditId}" — no quotes, no trailing comma or period, no extra tokens, nothing else on the line. A block whose AUDIT-ID is absent, different, decorated, or accompanied by another id is REFUSED and never merged. Do not put it after END.)`)
  return L.join('\n')
}

// pure-JS UTF-8 base64 (no Buffer/btoa dependency) — used by the legacy 'forward' forwarder only.
function b64utf8(str) {
  const u = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) u.push(c)
    else if (c < 0x800) u.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c >= 0xd800 && c <= 0xdbff) {            // high surrogate
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff)
        u.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      } else u.push(0xef, 0xbf, 0xbd)                  // lone high surrogate -> U+FFFD
    } else if (c >= 0xdc00 && c <= 0xdfff) u.push(0xef, 0xbf, 0xbd)  // lone low surrogate -> U+FFFD
    else u.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < u.length; i += 3) {
    const b0 = u[i], b1 = i + 1 < u.length ? u[i + 1] : -1, b2 = i + 2 < u.length ? u[i + 2] : -1
    out += A[b0 >> 2]
    out += A[((b0 & 3) << 4) | (b1 < 0 ? 0 : (b1 >> 4))]
    out += b1 < 0 ? '=' : A[((b1 & 15) << 2) | (b2 < 0 ? 0 : (b2 >> 6))]
    out += b2 < 0 ? '=' : A[b2 & 63]
  }
  return out
}

// legacy read-only Codex forwarder (experimental 'forward' opt-in only; default 'deferred' never uses it).
// Per-run UNIQUE dir (mktemp -d, collision-free across parallel sessions) + route through the hardened
// ~/bin/codex-audit wrapper (stdin -> private CODEX_HOME + slot + early snapshot). A FIXED path like the
// old /tmp/dual-audit/task_<tag>.txt is SHARED across sessions and gets overwritten -> cross-session
// contamination; tag is kept only for the call signature/labeling.
function codexRoForward(task, tag) {
  const b64 = b64utf8(task)
  const sh = "set -e\nD=$(mktemp -d /tmp/codex_ro.XXXXXX)\ntrap 'rm -rf \"$D\"' EXIT\nprintf '%s' '" + b64 + "' | base64 -d > \"$D/brief.md\"\n~/bin/codex-audit exec --sandbox read-only --skip-git-repo-check - < \"$D/brief.md\""
  return 'You are a non-reasoning command runner. Use the Bash tool to execute the following shell script EXACTLY as written (do not modify it, do not add/remove flags, do not explain). Then return ONLY the script\'s stdout, verbatim, with no preface or commentary:\n\n```bash\n' + sh + '\n```'
}

// kind: 'claude' | 'codex'(=read-only via forwarder, forward mode only) ; returns {kind, role, parsed, invalid|skipped|deferred}
async function budgetedAgent(kind, role, prompt, rs) {
  // HYBRID/DEFERRED: the codex side runs in the MAIN LOOP on a real frozen brief. In the panel we
  // emit a deferred marker (zero budget, zero spawn) BEFORE any cap check.
  if (kind === 'codex' && CODEX_MODE === 'deferred') {
    ledger.codexDeferred = (ledger.codexDeferred || 0) + 1
    log(`DEFER codex/${role} r${rs.n}: runs in MAIN LOOP on the frozen brief (HYBRID R1-independent). See memory reference_dual_audit_panel.`)
    return { kind, role, deferred: true }
  }
  if (!canLaunch(kind, rs.claude, rs.codex)) {
    ledger.skippedOverBudget++
    log(`SKIP ${kind}/${role} r${rs.n}: over cap (total=${ledger.totalUsed}/${HARD_TOTAL_CEILING})`)
    return { kind, role, skipped: true }
  }
  if (kind === 'codex' && ledger.codexBlocked) {
    ledger.codexSkipped++
    log(`SKIP codex/${role} r${rs.n}: read-only forwarder blocked by auto-mode classifier (latched)`)
    return { kind, role, skipped: true, skipReason: 'codex_headless_blocked' }
  }
  if (kind === 'claude') { rs.claude++; ledger.claudeUsed++ } else { rs.codex++; ledger.codexUsed++ }
  ledger.totalUsed++
  // A4 follow-up (independent review of the A4 patch, REPRODUCED): this dispatch path was calling
  // sentinelContract() with NO crossExamine, so the R2+ CLAUDE auditors were never asked for a DELTA field —
  // while the new claude-side anti-flip gate REQUIRES one. A gate that demands a field the panel never requests
  // does not catch false convergence, it just falsely rejects every legitimate flip (probe: a lawful R2 flip
  // documented in EVIDENCE was blocked and pushed to R3). Ask for DELTA on the same rounds the gate checks it.
  const fullTask = prompt + '\n' + sentinelContract(rs.n >= 2)
  const tag = `r${rs.n}_${role}_${kind}`
  let dispatchPrompt, opts
  if (kind === 'codex') {
    dispatchPrompt = codexRoForward(fullTask, tag)
    opts = { label: `codex-ro:${role}:r${rs.n}`, phase: `Round ${rs.n}`, agentType: 'claude', model: 'haiku' }
  } else {
    dispatchPrompt = fullTask
    // Effort is pinned to high and no longer inherits the session setting. The codex side is pinned
    // to high by its own config, and this keeps both sides at the same level - cost is controlled by
    // seat count and round count, not by lowering effort. Covers the Claude auditor seats.
    opts = { label: `claude:${role}:r${rs.n}`, phase: `Round ${rs.n}`, effort: 'high' }
  }
  let raw
  try { raw = await agent(dispatchPrompt, opts) }
  catch (e) { ledger.invalid++; return { kind, role, invalid: true, invalidReason: 'agent_threw', parsed: parseSentinel('') } }
  if (raw == null) { ledger.invalid++; return { kind, role, invalid: true, invalidReason: 'null_result', parsed: parseSentinel('') } }
  const parsed = parseSentinel(raw)
  if (!parsed.valid) {
    ledger.invalid++
    if (kind === 'codex' && !ledger.codexBlocked && /auto mode classifier|could not evaluate this action|denied by the Claude Code/i.test(String(raw))) {
      ledger.codexBlocked = true
      log('NOTE: codex read-only forwarder blocked by auto-mode classifier (headless). Latching.')
    }
  }
  return { kind, role, raw: String(raw), parsed, invalid: !parsed.valid }
}

// ---- Lenses: A/B/C biology (steering priority), D code (co-equal). ----
const LENSES = {
  A: 'LENS A — DEFINITIONS & CRITERIA (question them, do not inherit them): Is the discriminator, threshold or definition actually correct? Do NOT accept a definition merely because it is published or long-standing — does it rest on DECISIVE evidence or on an early single case, and does newer evidence contradict it (a "feature X defines class Y" claim collapses the moment genuine members of Y that lack X exist)? Is an optional or supporting indicator being treated as a hard requirement? Caller-supplied canonical documents are the working truth, but FLAG it when new evidence challenges even a canonical definition.',
  B: 'LENS B — MECHANISM & QUANTITATIVE PLAUSIBILITY: Does the proposed mechanism actually work, and do the numbers hold? Check units, magnitudes, ranges and directions of effect; check that a quantity is being compared against something it is commensurable with; check whether the reported effect is larger than the resolution of the method that produced it. Separate an artefact of the measurement or the pipeline from a real result. If a number cannot be reproduced from the stated inputs, say so.',
  C: 'LENS C — EVIDENCE CHAIN, CROSS-VALIDATION & EVIDENCE!=TRUTH: Do NOT accept a citation at face value. TRACE the evidence chain of every load-bearing claim (a publication, a prior definition, an inherited label): is it decisive or anecdotal? Scrutinize the METHOD that produced it — a set assembled by a broad similarity search WITHOUT a confirmatory test is weak evidence for a functional claim, and a published label can be REJECTED when a direct test contradicts it. CROSS-VALIDATE across independent sources. Evidence hierarchy: decisive direct measurement with independent replication > systematic/high-throughput result > single-case definition > similarity-based inference > model inference. Record conflicts in LIT_CONFLICTS and rank them by evidence quality, NOT by authority or recency. A weak-evidence claim that would change the conclusion is a P0; an unresolved conflict goes to {{UNRESOLVED_SINK}}. Watch for an inherited label quietly promoted to truth, for a conclusion reaching further than the data supports, and for work that silently exceeded the scope the task authorised.',
  D1: 'LENS D1 — BEHAVIOUR & SEMANTICS (co-equal hard gate; you OWN the run tier for this lens): actually RUN it. Does it do what it claims — outputs/columns/counts, edge and boundary inputs, numeric/semantic invariants, non-determinism? Compare the ACTUAL outputs/columns/counts item by item against the caller-provided EXPECTED OUTPUT CONTRACT in the header — that comparison is yours to make, do not assume someone else did it. Report VERIFIED from what YOU executed, never from reading alone. Ignore style; judge behaviour.',
  D2: 'LENS D2 — CONTRACT, NEGATIVE PATHS & REGRESSION (co-equal hard gate; you OWN the run tier for this lens): also actually RUN things, but a different set — exercise the CALLERS and the failure paths (bad input, missing file, nonzero exit, permission denied), run the existing test/regression suite if one exists, and check what DOWNSTREAM consumers of this output would see. Ask: what silently changed for someone who depends on this? Report VERIFIED from what YOU executed. Ignore style; judge behaviour.',
  L: 'LENS L — METHOD & REASONING (the UPSTREAM question; ask it before any implementation detail): is the APPROACH itself right? Does the stated method actually answer the stated question, or does it answer a neighbouring one? Interrogate the DEFINITIONS and CRITERIA the work rests on: where did each threshold, cutoff, category boundary or inclusion rule come from — measured, derived, or decreed? A criterion the author chose for themselves and then met is not evidence. Check the POPULATION and the UNIT: what exactly is being counted, is the set the right set, are cases silently excluded by a hand-written filter, does one unit mean the same thing throughout? Check what a stated result would look like if the premise were FALSE — if it looks identical, the work does not test its premise. Name any conclusion that outruns its evidence. This lens does NOT run code and does NOT review style; a defect here invalidates results that are otherwise correctly computed.',
  D: 'LENS D — CODE/REPRODUCIBILITY (co-equal hard gate; long chain, bugs propagate): verify the code actually behaves as claimed (outputs/columns/counts match the EXPECTED contract). Ignore code style/minimalism — judge behavior only.',
}
// 🔴 Where LENS C sends an unresolved conflict MUST follow the mode; it cannot be hardcoded to
// UNANCHORED_CLAIMS. That field enters the output contract ONLY in claimMode (see "Fields that
// decide whether your verdict is VALID" below) and is collected by the anchor gate ONLY in claimMode.
// Copying the sentence into non-claim modes means the auditor dutifully writes the conflict there
// and the panel neither lists nor reads it - the content is silently discarded. Probed: under
// kind=code an UNANCHORED_CLAIMS line does not appear anywhere in the return value; the same content
// under claim mode is kept and blocks. Routing, not opening the field: opening it would add a new
const UNRESOLVED_SINK = claimMode ? 'UNANCHORED_CLAIMS' : 'P1'
const lensText = (k) => String(LENSES[k]).split('{{UNRESOLVED_SINK}}').join(UNRESOLVED_SINK)
// 🔴 Lenses are NOT split by subject matter. One general set:
// A definitions and criteria * B mechanism and order-of-magnitude plausibility * C evidence chain and
// cross-validation * L method and reasoning (the upstream question) * D/D1/D2 the run layer.
// The old split gave A/B/C to claim mode and L to everything else, so NON-CLAIM submissions never got
// the evidence-chain lens and CLAIM submissions never got the method-and-reasoning lens - even though
const AVAILABLE = ['A', 'B', 'C', 'L', 'D']
// The lens set assignable to an AUDITOR SEAT. The codex brief still uses AVAILABLE (with the merged
// D): it has no seat split, and handing it D1/D2 would only repeat the same work twice.
// ⚠️ This USED to fork on claimMode with D1/D2 missing from the claim branch. Under kind:'mixed' the
// [D1,D2] seat was therefore emptied by the auditorPrompt filter and then silently restored to the
// full set by `if (!keys.length) keys = AVAILABLE.slice()` - the two seats became A/B/C/D and A/B/C,
// the axis split failed completely, and nothing in the log looked wrong. Reproduced by probe.
const ASSIGNABLE = AVAILABLE.concat(['D1', 'D2'])

// ---- SINGLE SOURCE for the seat definition -------------------------------------------------
// LOGIC and specs used to be local variables inside runClaudeRound while two downstream places
// needed them:
//   * the run-seat classifier in evaluateConvergence (previously a /D1|D2/ regex)
//   * the claude_roles shape check when seats are rebuilt from prior_state
// Both matched this definition BY CONVENTION with no assertion, so renaming a seat or a lens would
const LOGIC = ['A', 'B', 'C', 'L']
const RUN_LENSES = ['D1', 'D2']
const SEAT_SPECS = codeRelevant ? [RUN_LENSES, LOGIC] : [LOGIC]
const SEAT_ROLES = SEAT_SPECS.map(k => k.join(''))   // ['D1D2','ABCL'] or ['ABCL']; the order is the dispatch order
const RUN_SEAT_ROLE = RUN_LENSES.join('')            // 'D1D2'
// Lenses are DOMAIN-NEUTRAL: no hardcoded project/family names. Project-specific canon
// (a project-specific threshold, say) is injected ONLY via the profile's `rules` when the caller names that project — never baked
// into the generic lens text, so the panel does not steer one project's audit toward another project's shape.

function dNote(agentKind, tag) {
  if (!codeRelevant) return ''
  if (agentKind === 'codex') return 'CODE-VERIFY (you are READ-ONLY: codex exec --sandbox read-only, you CANNOT write anywhere incl /tmp): do STATIC analysis by READING — parse the script (AST/imports), and review the output CONTRACT by reading existing output files vs EXPECTED. Report VERIFIED:pass ONLY for this static/contract tier; VERIFIED:fail if static analysis reveals a defect; the run-tier is the Claude auditor\'s job.'
  return 'CODE-VERIFY (you have full tools): run the script/command on the MINIMAL fixture, writing ONLY into a dir YOU create fresh with `D=$(mkdir -p /tmp/dual-audit && mktemp -d /tmp/dual-audit/run_' + tag + '.XXXXXX)` and write under "$D" — mktemp is REQUIRED, NOT optional: the tag alone (e.g. run_' + tag + '/) is DETERMINISTIC and repeats across concurrent panels auditing DIFFERENT projects, so a fixed path would let two projects clobber each other\'s run-tier evidence (cross-project contamination). NEVER repo outputs or any FORBIDDEN WRITE PATH. Use ABSOLUTE paths (background cwd is untrustworthy; `tail` can mask a FileNotFoundError into a false exit-0). If the script cannot target an isolated output dir (writes to fixed repo paths), do NOT run it — do static checks and set VERIFIED accordingly. VERIFIED:pass attests the run tier.'
}

// Workers were removed: production happens outside the panel, and the panel only independently
// reviews what the caller submits. The worker prompt, dispatch, handoff and schema went with them;

// ---- INDEPENDENT R1 Codex brief: raw sources only, bounded scope, NO Claude digest/verdict ----
function rawSourceBrief() {
  return [
    HEADER_RAW,
    `AUDIT-ID: ${auditIdFor(1)}`,
    'MANDATORY: reproduce the AUDIT-ID line above VERBATIM inside your verdict block. It proves your verdict answers THIS audit. A verdict that omits it, or carries a different id, is REFUSED and never merged — this is what stops one project\'s verdict from being merged into a different project\'s panel when two audits run concurrently.',
    'You are an INDEPENDENT FIRST-ROUND AUDITOR (second model, gpt/codex), READ-ONLY (codex exec --sandbox read-only; you CANNOT write anywhere incl /tmp).',
    'This is ROUND 1: form your OWN verdict by reading the RAW sources YOURSELF. You are deliberately NOT given any other AI\'s summary, analysis, or verdict — so your opinion is genuinely independent, not a rubber stamp.',
    boundedScopeNote,
    claimMode ? 'Two AIs agreeing is NOT proof. For biology demand EXTERNAL anchoring (canonical docs/literature/structure/data); published/prior conclusions are NOT automatically true — trace the evidence chain, scrutinize method, cross-validate.' : '',
    AVAILABLE.map(k => lensText(k)).join('\n'),
    codeRelevant ? dNote('codex', 'r1') : '',
    'Independently assess the TASK against the raw sources. Default to skepticism. APPROVE only with zero blocking (P0) issues.',
    sentinelContract(false, auditIdFor(1)),
  ].filter(Boolean).join('\n')
}

// ---- R2+ SHARING Codex brief: both sides see each others' frozen R1 raw verdicts + cross-examine ----
// Uses HEADER_CROSS (NOT HEADER): R2 shares frozen R1 verdicts and restores submitted targets, but
// must NOT silently
// re-inject Claude's CONTEXT narrative / the profile's canonical conclusions, which would dilute
// cross-examination neutrality (P1, Claude-side finding). (No worker output — pure review panel.)
function sharedCodexBrief(n, shared, openP0s) {
  const prevBlock = (shared && shared.prevRound >= 2) ? [
    `--- IMMEDIATELY-PRIOR ROUND ${shared.prevRound} CLAUDE VERDICTS (verbatim) ---`,
    (shared.prevClaudeRaw && shared.prevClaudeRaw.length ? shared.prevClaudeRaw.join('\n--- next ---\n') : '(none)'),
    `--- IMMEDIATELY-PRIOR ROUND ${shared.prevRound} CODEX VERDICT (verbatim) ---`,
    shared.prevCodexRaw || '(none)',
  ] : []
  return [
    HEADER_CROSS,
    `AUDIT-ID: ${auditIdFor(n)}`,
    'MANDATORY: reproduce the AUDIT-ID line above VERBATIM inside your verdict block. A verdict that omits it, or carries a different id, is REFUSED and never merged (cross-project safety when two audits run concurrently).',
    `You are the READ-ONLY auditor (second model, gpt/codex) in ROUND ${n} — the CROSS-EXAMINATION phase. You CANNOT write anywhere.`,
    'Round 1 is FROZEN. Below are BOTH sides\' raw R1 verdicts (and the immediately-prior round when R>=3). Cross-examine: where do you and the Claude side disagree, and which side does the EVIDENCE support? You MAY change your stance ONLY with new evidence/reasoning — changing merely because the other side sounded confident does NOT count. You may keep a minority position if the evidence backs it.',
    boundedScopeNote,
    claimMode ? 'Two AIs agreeing is NOT proof. Demand external anchoring; trace the evidence chain.' : '',
    AVAILABLE.map(k => lensText(k)).join('\n'),
    codeRelevant ? dNote('codex', 'r' + n) : '',
    '--- YOUR (CODEX) FROZEN R1 VERDICT (verbatim) ---', (shared && shared.codexR1Raw) || '(none)',
    '--- CLAUDE SIDE FROZEN R1 VERDICTS (verbatim) ---', (shared && shared.claudeR1Raw && shared.claudeR1Raw.length ? shared.claudeR1Raw.join('\n--- next ---\n') : '(none)'),
    ...prevBlock,
    openP0s && openP0s.length ? ('OPEN P0 LEDGER (raised in R1; NO worker fixes them — this is a pure review panel; ADJUDICATE each: is it a REAL blocker with a concrete damage chain condition→error→consequence, or refute it): ' + openP0s.join('; ')) : '',
    'Default to skepticism. APPROVE only with zero blocking (P0) issues.',
    sentinelContract(true, auditIdFor(n)),   // R2+ cross-examination: require a DELTA field for any verdict flip
  ].filter(Boolean).join('\n')
}

// CLAUDE-side auditor prompt. shared (R2+) injects BOTH frozen R1 raw verdicts for cross-examination.
// Pure review panel: the auditor reviews the caller-submitted work (TARGETS/EXPECTED in HEADER) directly —
// there is no worker digest to audit.
function auditorPrompt(agentKind, n, openP0s, lensKeys, tag, shared) {
  let keys = (lensKeys && lensKeys.length) ? lensKeys.filter(k => ASSIGNABLE.includes(k)) : AVAILABLE.slice()
  if (!keys.length) {
    // The fallback itself is right (some lens beats no lens); what was wrong is that it was SILENT.
    // Reaching it necessarily means the seat configuration disagrees with ASSIGNABLE, and the result
    log(`LENS-FALLBACK ${agentKind} r${n}: none of the requested lenses [${(lensKeys || []).join(',')}] are in ASSIGNABLE, so this seat fell back to the full set - that is a seat misconfiguration, not a normal path`)
    keys = AVAILABLE.slice()
  }
  const sharedBlock = (n >= 2 && shared) ? [
    'ROUND 1 is FROZEN. Cross-examine against BOTH sides\' raw R1 verdicts below (+ the immediately-prior round when R>=3). Change a verdict ONLY on new evidence/reasoning, never because the other side sounded confident; a minority position backed by evidence is allowed.',
    '--- CLAUDE FROZEN R1 VERDICTS (verbatim) ---', (shared.claudeR1Raw && shared.claudeR1Raw.length ? shared.claudeR1Raw.join('\n--- next ---\n') : '(none)'),
    '--- CODEX FROZEN R1 VERDICT (verbatim) ---', shared.codexR1Raw || '(none)',
    ...((shared.prevRound >= 2) ? [
      `--- IMMEDIATELY-PRIOR ROUND ${shared.prevRound} CLAUDE VERDICTS (verbatim) ---`, (shared.prevClaudeRaw && shared.prevClaudeRaw.length ? shared.prevClaudeRaw.join('\n--- next ---\n') : '(none)'),
      `--- IMMEDIATELY-PRIOR ROUND ${shared.prevRound} CODEX VERDICT (verbatim) ---`, shared.prevCodexRaw || '(none)',
    ] : []),
  ] : []
  return [
    HEADER,
    'You are an ADVERSARIAL AUDITOR (independent second opinion). Do NOT edit files. Read-only/dry-run verification only; never mutate repo state.',
    claimMode ? 'Two AIs agreeing is NOT proof. For biology demand EXTERNAL anchoring (canonical docs, literature, structure/data) and flag any claim resting only on AI inference. Published/prior conclusions are not automatically true — trace the evidence chain.' : '',
    'This work is one link in a long chain — verify before trusting; flag anything unverified that would propagate downstream.',
    keys.map(k => lensText(k)).join('\n'),
    keys.some(k => k === 'D' || k === 'D1' || k === 'D2') ? dNote(agentKind, tag) : '',
    ...sharedBlock,
    'REVIEW TARGET: the work submitted for audit is the TASK + TARGETS + EXPECTED OUTPUT CONTRACT in the HEADER above. READ those sources YOURSELF and form your own independent verdict — this is a PURE REVIEW panel, no worker produced a digest for you.',
    openP0s.length ? ('These P0 blockers were raised in ROUND 1. No worker has "fixed" them (pure review panel) — independently ADJUDICATE each: is it a REAL blocking defect with a concrete damage chain (condition→error→consequence), or should it be refuted? ' + openP0s.join('; ')) : '',
    'Default to skepticism. APPROVE only with zero blocking (P0) issues.',
  ].filter(Boolean).join('\n')
}

// ---- run ONE round of the CLAUDE side; returns raw verdicts + claude-side flags (codex runs in main loop) ----
// Pure review panel: NO worker. Independent Claude auditors review the caller-submitted
// artifact (TARGETS/EXPECTED in HEADER) directly; lenses are split across seats to reduce common-mode blindness.
async function runClaudeRound(n, openP0s, shared) {
  const rs = { n, claude: 0, codex: 0 }

  // 🔴 Seat composition: a code axis -> two seats; no code -> one seat. NOT split by subject matter.
  //   Run-axis seat D1+D2 - actually runs things and opens the artefacts to check them (only Claude
  //     can execute; codex is read-only).
  //   Logic-axis seat A/B/C/L - criteria, mechanism and magnitude, evidence chain, method and reasoning.
  //
  // History (do not walk back into these):
  //  * An older version split D1/D2 across two Claude seats - that is sampling one mind twice, not a
  //    second perspective.
  //  * A third same-vendor seat was removed: it buys another sample of the same mind, not independence.
  //    More independent minds means a different vendor, which is what the codex side is for.
  //  * Lenses used to fork on claim vs non-claim; merging them fixed the case where non-claim
  //    submissions never saw the evidence-chain lens and claim submissions never saw the
  //    method-and-reasoning lens - neither question depends on the subject matter.
  // codex_only: zero Claude seats. Everything downstream already tolerates this —
  // anyNull becomes [].some() === false, auditors becomes [], and the `no valid auditor verdict`
  // blocker is satisfied by the codex verdict because evaluateConvergence pushes codex into
  // the same `valid` array. Do NOT special-case the convergence gate for this mode: the whole
  // point is that a codex-only run is held to the SAME bar, just with one fewer perspective.
  const specs = MODE === 'codex_only' ? [] : SEAT_SPECS.map(keys => ({ keys, kind: 'claude' }))

  const thunks = specs.map(s => () => {
    const tag = `r${rs.n}_${s.kind}_${(s.keys || ['all']).join('')}`
    return budgetedAgent(s.kind, (s.keys || ['all']).join(''), auditorPrompt(s.kind, n, openP0s, s.keys, tag, shared), rs)
  })
  const slots = await parallel(thunks)
  const anyNull = slots.some(x => x == null)
  const auditors = slots.filter(Boolean)
  ledger.codexDeferred += 1 // telemetry (codex re-audit): 1 codex pass deferred to the main loop per round
  ledger.rounds.push({ round: n, width: specs.length, claude_used: rs.claude, codex_deferred_this_round: 1 })
  log(`Round ${n} (Claude side): seats=${specs.length}[${specs.map(s => s.keys.join('')).join('|')}] claude=${rs.claude} auditors=${auditors.length}; codex deferred to main loop`)
  return {
    n,
    // role (this seat's lens string, e.g. 'ABCL' / 'D1D2') was always in budgetedAgent's return value;
    // it was simply dropped here. Keeping it is what lets downstream tell whether a P0 came from the
    auditors: auditors.map(a => ({ kind: a.kind, role: a.role, invalid: !!a.invalid, skipped: !!a.skipped, parsed: a.parsed, raw: a.raw || (a.parsed && a.parsed.raw) || '' })),
    anyNull, width: specs.length,
  }
}

// ---- P0 admission gate ----------------------------------------------------------------------
// Symptom, as reported from real use: nearly every session ran the full 3 rounds, produced dozens to
// hundreds of P0s that largely overlapped, most of them long-tail rather than genuinely blocking, and
// took two hours or more of wall clock. The cause was not the auditors' wording; it was these three
// lines together:
//   const p0Raw = listVal('P0')            // P0 is a SELF-DECLARED label; the panel never checked it
//   if (newP0s.length) blockers.push(...)  // anything calling itself P0 blocks convergence
//   const carry = newP0s.slice()           // all of it is fed back into the next prompt verbatim
//
// This gate does NOT judge whether a P0 is correct - the panel cannot, and does not pretend to. It
// judges only whether a P0 QUALIFIES TO BLOCK. Nothing that fails is discarded: the full text goes
// into advisories for a human. Silent truncation erases a seat that was carrying a real P0.
// 🔴 A "3 blocking P0s per seat" quota was added and disproved by this very panel on the same day.
// Do not put it back. Its failure direction is BURYING REAL P0s, and the failure is systematic:
//
// The count was an illusion, and that is the root cause. listVal splits the P0 field on separators,
// while the brief asks auditors to write "condition -> error -> consequence" with clauses separated
// by ";" - so ONE finding was split into 7-12 entries. Measured across six seats in one round: P0
// texts of 968/688/986/1744/1401/1702 characters split into 8/5/9/12/13/12 entries while the number
// of genuinely distinct findings was THREE. So "keep the first 3 per seat" kept the first three
// CLAUSES OF THE FIRST FINDING and demoted entire other findings.
//
// That also explains the original observation (dozens of P0s per round, mostly overlapping, mostly
// long tail): the overlap was not chiefly auditors repeating each other, it was ONE FINDING COUNTED
// 7-12 TIMES. The quota did not reduce the number of findings; it truncated the first and lost the rest.
//
// Conclusion: noise must be merged in the REPORTING layer shown to a human, never discarded in the
// BLOCKING layer. The cost of discarding has been measured. Only a runaway cap remains here, set far
const MAX_BLOCKING_P0_PER_AUDITOR = 50

// The call site is in parseSentinel (see the note there), not evaluateConvergence: downstream would miss approvesFinal.
function qualifyP0s(rawP0s) {
  const blocking = [], demoted = []
  for (const item of (rawP0s || [])) {
    const s = stripInvisible(String(item == null ? '' : item)).trim()
    if (!s) continue
    // ⚠️ There USED to be a "a P0 must contain a decimal digit" gate here. It was added and removed
    // the same day by an independent panel. Why it went (do not walk back into it): "contains a
    // digit" is a false proxy for BLOCKING. The counter-example given was decisive -
    //   "checkToken in auth.js accepts empty credentials, so the release controller grants access"
    // - file, symbol and damage chain all present, and not one decimal digit. Probed: that finding
    // was demoted -> approvesFinal saw an empty filtered p0 -> converged=true. The failure direction
    // of that gate is LETTING A REAL BLOCKER THROUGH, which is worse than the noise it treated.
    // Nor should it be replaced with a "smarter locator heuristic": the comments in this file already
    // record a negative word list being walked through by paraphrase five rounds running, and a
    // positive heuristic will be walked through too - except that this time it walks in the
    // permissive direction. ⚠️ A second gate, the per-seat quota of 3, is also gone; see the long note
    // above MAX_BLOCKING_P0_PER_AUDITOR. In one word: it demoted BY POSITION.
    if (blocking.length >= MAX_BLOCKING_P0_PER_AUDITOR) {
      demoted.push({ text: s, why: `over the per-seat runaway cap of ${MAX_BLOCKING_P0_PER_AUDITOR} (anomalous output, not normal filtering)` })
      continue
    }
    blocking.push(s)
  }
  return { blocking, demoted }
}

// ---- combined convergence gate: applied in the MAIN LOOP after BOTH sides' verdicts for a round exist ----
// claudeRound = output of runClaudeRound; codexParsed = parseSentinel(codex main-loop verdict)
// ── findings ledger: monotonic, records only, gates NOTHING ─────────────────────────────
// The measured defect it exists for: openP0s is REPLACED by gate.carry every round, and carry holds
// only the P0s adjudicated in THAT round, so a finding raised earlier that nobody restates vanishes
// from every later result while the driver still reports convergence. The consumer then receives an
// approval over a finding that evaporated, and "nobody found anything" is byte-identical to "the
// finding was dropped". The ledger never removes an entry; it marks it.
//
// It deliberately sets no gate. The panel cannot distinguish "refuted on the merits" from "nobody
// mentioned it again", and a blocker on every non-restated finding would deadlock ordinary runs.
// Naming the state is what a human needs; deciding it is not something this code can do.
//
// Identity is an OPAQUE sequence number assigned on first entry, never derived from the text: a
// content hash is a fingerprint, not an identity -- it fragments one finding that two seats
// paraphrase and merges two different findings that share wording. Matching a restatement back to
// its entry is therefore a HEURISTIC (normalised text equality). On no match a NEW entry is created
// rather than merged: a duplicate entry is recoverable, an erased finding is not.
// NOT lowercased. Findings are file:line locators and this is a case-sensitive filesystem, so
// `src/Foo.js:10 ...` and `src/foo.js:10 ...` are findings about two DIFFERENT files -- and
// case-folding collapsed them into one entry, silently dropping the second. That is precisely the
// erasure this ledger was built to prevent, reintroduced by its own matcher. Keeping case makes the
// matcher stricter, so the failure moves to SPLIT (a duplicate entry, recoverable) instead of MERGE
// (a finding gone, not recoverable) -- the direction this file already chose everywhere else.
const normFinding = v => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim()
// markAbsent: true on an ADJUDICATION round (the previous round's verdicts are being judged, so a
// finding nobody restated genuinely stopped being restated).  false when merely RECORDING what a
// round raised -- there, absence from this one list means nothing and marking it would be a lie.
function buildFindingsLedger(n, priorLedger, carry, markAbsent = true) {
  const out = (Array.isArray(priorLedger) ? priorLedger : []).map(e => ({ ...e }))
  // seenThisRound is keyed by id, so two entries sharing one id make restating EITHER mark the
  // other seen -- shielding a genuinely un-restated finding from being marked, and reporting it
  // to the reader as still open. The array shape is validated on load; the entries inside it are
  // not, so a duplicate or missing id can arrive from a hand-assembled state. Repair it here
  // rather than trusting it: a reassigned id is a cosmetic loss, a shielded finding is not.
  {
    const used = new Set()
    let max = 0
    for (const e of out) { const m = /^F(\d+)$/.exec(String(e && e.id)); if (m && +m[1] > max) max = +m[1] }
    for (const e of out) {
      const id = String((e && e.id) == null ? '' : e.id)
      if (!id || used.has(id)) { e.id = 'F' + (++max) }
      used.add(String(e.id))
    }
  }
  const seenThisRound = new Set()
  for (const raw of (Array.isArray(carry) ? carry : [])) {
    const key = normFinding(raw)
    if (!key) continue
    const hit = out.find(e => normFinding(e.text) === key)
    if (hit) { hit.status = 'open'; hit.last_seen_round = n; seenThisRound.add(hit.id); continue }
    // NOT `'F' + (out.length + 1)`: that assumes the ids present are dense 1..n. The panel
    // refuses a non-array findings_ledger but does not validate the entries inside one, so a
    // prior_state carrying [F3, F2] made the next entry F3 as well -- two distinct findings
    // sharing one id, in the one structure whose entire purpose is stable identity.
    let max = 0
    for (const e of out) { const m = /^F(\d+)$/.exec(String(e && e.id)); if (m && +m[1] > max) max = +m[1] }
    const id = 'F' + (max + 1)
    out.push({ id, text: String(raw), round_raised: n, last_seen_round: n, status: 'open' })
    seenThisRound.add(id)
  }
  if (markAbsent) for (const e of out) if (!seenThisRound.has(e.id)) e.status = 'not_restated'
  return out
}

function evaluateConvergence(n, claudeRound, codexParsed, codexInvalid, priorTimingRounds) {
  const claudeAuditors = (claudeRound.auditors || [])
  const valid = []
  for (const a of claudeAuditors) if (a.parsed && a.parsed.valid) valid.push({ kind: 'claude', parsed: a.parsed })
  if (codexParsed && codexParsed.valid) valid.push({ kind: 'codex', parsed: codexParsed })

  // open P0s: from every auditor (claude + codex). No worker in a pure-review panel.
  // Everything passes through the qualifyP0s admission gate. newP0s holds only what QUALIFIES TO
  // BLOCK; demoted entries go to demotedP0s and their full text reaches advisories. carry =
  // newP0s.slice() therefore carries only qualifying items, which breaks the "last round's P0 goes
  const newP0s = []
  const demotedP0s = []
  // Per-seat accounting, used to decide whether the run seat's findings are conditional (see
  // runFindingsConditional below). The test is purely mechanical: is that seat's p0 array empty.
  let logicSeatP0 = 0, runSeatP0 = 0
  for (const a of claudeAuditors) {
    if (!a.parsed) continue
    const nP0 = (a.parsed.p0 || []).length
    // Compared against SEAT_ROLES, the same source, rather than a /D1|D2/ convention regex: when the
    // regex and the seat definition live in different places, a rename touches one and the other
    if (String(a.role || '') === RUN_SEAT_ROLE) runSeatP0 += nP0
    else logicSeatP0 += nP0
    if (a.parsed.p0) newP0s.push(...a.parsed.p0)
    for (const d of (a.parsed.p0_demoted || [])) demotedP0s.push({ ...d, kind: 'claude' })
  }
  if (codexParsed) {
    if (codexParsed.p0) newP0s.push(...codexParsed.p0)
    for (const d of (codexParsed.p0_demoted || [])) demotedP0s.push({ ...d, kind: 'codex' })
  }
  // ⚠️ Making a sequencing mismatch visible: if the logic seat judges that the METHOD ITSELF is wrong,
  // the run seat's line-level findings may be invalidated by the rewrite - yet they still enter the P0
  // ledger, still carry across rounds, and still hold up convergence. The panel CANNOT tell whether
  // the method really has to change (that is a human judgement), so it sets no gate, filters nothing
  // and demotes nothing; it only says so when both seats raise P0s. Rules do not govern execution;
  const runFindingsConditional = logicSeatP0 > 0 && runSeatP0 > 0
  // When seat identity is lost in transit the accounting above counts everything as the logic seat,
  // runSeatP0 stays 0, and the note silently never fires. Say so: "cannot be decided this round" and
  const rolesUsable = claudeRound.rolesUsable !== false   // R1 is dispatched live and has no such key, so default to usable

  const litConflicts = []
  for (const a of valid) litConflicts.push(...(a.parsed.litConflicts || []))
  const approveCount = valid.filter(a => a.parsed.approves).length
  // Removed: split used to feed the "widen when the two sides disagree" signal, and that path went
  // with prevSplit. Zero readers remain across the panel, the driver and all three suites. A returned

  const anyInvalid = claudeAuditors.some(a => a.invalid) || !!codexInvalid
  const anySkipped = claudeAuditors.some(a => a.skipped)

  const blockers = []
  if (claudeRound.anyNull) blockers.push('an auditor slot returned null (dispatch/agent failure)')
  if (anyInvalid) blockers.push('an agent returned invalid/placeholder/non-sentinel output')
  if (anySkipped) blockers.push('an agent was skipped (budget cap)')
  if (!valid.length) blockers.push('no valid auditor verdict')
  if (valid.length && !valid.every(a => a.parsed.approves)) blockers.push('not all valid auditors APPROVE')
  if (newP0s.length) blockers.push(`${newP0s.length} open P0`)
  // STRUCTURED EVIDENCE CITATION, replacing the non-answer word list that paraphrase kept defeating:
  // the EVIDENCE on an APPROVING vote must contain at least one digit. This mechanises what the brief
  // ALREADY demands - that the field carry the line numbers you actually read, or concrete numbers
  // from the evidence file.
  // Why a positive requirement rather than another non-answer list:
  //   - the negative list was defeated by paraphrase again and again (no evidence -> no evidence
  //     found -> no new evidence -> no supporting evidence -> the same in other languages), and every
  //     tightening misfired on legitimate citations ("evidence provided above" was read as none);
  //   - a positive requirement is language-independent: empty talk contains no digits in any language;
  //   - it applies ONLY to approving votes: a rejection stands without citing a number.
  // Honest boundary: a digit does NOT make the evidence true - an auditor can invent one. This gate
  // guarantees only that something concrete was cited; whether it is correct is for the other side
  // and the reader to check. ADVISORY WARNINGS are the only remaining use of the closed-vocabulary
  // heuristic: flag a suspicious field for a HUMAN, never participate in converged. Incomplete by
  const advisories = []
  // The full text of every demoted P0 goes to a human: they do not block, but they must NOT vanish.
  // From the caller's side, a silently dropped P0 and a silently absent reviewer are the same event.
  for (const d of demotedP0s) {
    advisories.push(`[ADVISORY] ${d.kind} raised a P0 that does NOT block (${d.why}): "${String(d.text).slice(0, 160)}" - the panel does not hold convergence for it; it is still a finding for a human to read, it simply does not qualify to stop the flow.`)
  }
  for (const a of valid) {
    for (const w of (a.parsed.format_warnings || []))
      advisories.push('[ADVISORY] ' + a.kind + ' verdict format: ' + w)
    for (const u of (a.parsed.unparsed_lines || []))
      advisories.push('[ADVISORY] ' + a.kind + ' verdict had a line the parser did not recognise as a field (kept for the reader, NOT counted): ' + String(u).slice(0, 120))
    if (looksLikeNonAnswerAdvisory(a.parsed.delta)) {
      advisories.push(`[ADVISORY] ${a.kind} DELTA reads like a non-answer ("${String(a.parsed.delta).slice(0, 60)}") - the panel does NOT block on this; a human should judge whether it says anything.`)
    }
    if (looksLikeNonAnswerAdvisory(a.parsed.evidence)) {
      advisories.push(`[ADVISORY] ${a.kind} EVIDENCE reads like a non-answer ("${String(a.parsed.evidence).slice(0, 60)}") - advisory only, not a blocker.`)
    }
  }
  // \p{Nd} (any decimal digit) rather than [0-9]: fullwidth and non-Latin digits are equally valid concrete citations, and insisting on ASCII is a pointless false rejection.
  const unanchoredEvidence = valid.filter(a => a.parsed.approves &&
    !/\p{Nd}/u.test(stripInvisible(a.parsed.evidence == null ? '' : a.parsed.evidence)))
  if (unanchoredEvidence.length) blockers.push(`${unanchoredEvidence.length} approving verdict(s) give no structured evidence reference (EVIDENCE must cite a concrete line number / count / figure - a digit is required)`)

  // code gate: BOTH Codex(static/contract) and Claude(run) sides VERIFIED:pass, none fail.
  let codeGap = null
  if (codeRelevant) {
    const anyFail = valid.some(a => a.parsed.verified === 'fail')
    const codexPass = valid.some(a => a.kind === 'codex' && a.parsed.verified === 'pass')
    const claudePass = valid.some(a => a.kind === 'claude' && a.parsed.verified === 'pass')
    if (anyFail) codeGap = 'code dry-run/smoke-test FAILED (VERIFIED:fail)'
    // 🔴 In `codex_only` there are no Claude seats by construction (runClaudeRound dispatches an
    // empty spec list), so demanding a passing Claude verdict is a condition nothing can satisfy:
    // measured, codex_only+code and codex_only+mixed could NEVER converge and emitted that
    // impossibility as their sole blocker, which reads like a finding about the code under review.
    // A gate that cannot be satisfied is not a gate, it is a deadlock with a misleading label.
    // Single-seat mode converges on the static reading alone — and says so, loudly, rather than
    // letting the absence of a run seat pass unmentioned.
    else if (MODE === 'codex_only') {
      if (!codexPass) codeGap = 'code not verified by codex (static/contract)'
      else advisories.push('[ADVISORY] SINGLE SEAT: this run had NO Claude run seat, so nothing was executed — '
        + 'the code was read statically and never run. "VERIFIED: pass" here means the static/contract reading passed, '
        + 'NOT that a dry-run or smoke-test succeeded.')
    }
    else if (!(codexPass && claudePass)) codeGap = 'code not independently verified by BOTH Codex(static/contract) and Claude(run)'
    if (codeGap) blockers.push(codeGap)
  }

  // biology gate: every valid auditor must ANCHOR:anchored and report no unanchored claims, else escalate
  const unanchored = []
  let claimGap = false
  if (claimMode && valid.length) {
    for (const a of valid) { if (a.parsed.anchor !== 'anchored') claimGap = true; if (a.parsed.unanchored) unanchored.push(...a.parsed.unanchored) }
    if (unanchored.length) claimGap = true
    if (claimGap) blockers.push('substantive claims not fully anchored (ANCHOR!=anchored or unanchored claims) -> needs human expert sign-off')
  }

  const converged = blockers.length === 0
  const carry = newP0s.slice()
  // An anchor blocker MUST enter carry. When it only reaches blockers, nothing in the next round's
  // prompt tells the auditor to supply concrete line numbers, so it simply writes the same thing again.
  if (unanchoredEvidence.length) carry.push('EVIDENCE must cite a CONCRETE locator (line number / count / figure). ' +
    unanchoredEvidence.length + ' approving verdict(s) gave none this round - restate the evidence with the actual numbers you read.')
  if (codeGap) carry.push(codeGap)
  if (claimGap) carry.push('Anchor these to a decisive cross-validated evidence chain or explicitly mark as inference needing human sign-off: ' + (unanchored.length ? unanchored.join('; ') : 'all biological claims'))
  // codes: stable identifiers so MACHINES AND TESTS can tell which gate fired. Never embed them in
  // the blockers/carry prose - the prose is written for humans and is expected to change, while carry
  // flows into the next round's prompt, where a marker is just noise.
  // ⚠️ Cross-round carry (a hole found by probe): if this note is written only into THIS round's
  // advisories it never reaches the user in full-run mode, because the driver returns only the last
  // panel result while this typically fires in R1. Same fix as demoted_p0_log: remember which rounds
  const timingRounds = (Array.isArray(priorTimingRounds) ? priorTimingRounds : []).slice()
  if (runFindingsConditional && !timingRounds.includes(n)) timingRounds.push(n)
  if (runFindingsConditional) {
    advisories.push(`[ADVISORY] SEQUENCING: the logic seat raised ${logicSeatP0} P0(s) at the method/reasoning level while the run seat raised ${runSeatP0} at the line/behaviour level. If the method really has to change, the run seat findings may be invalidated along with the rewrite - settle the logic first, then look at the code. The panel does NOT filter or demote anything on this basis (it cannot tell whether the method must change; that is a human judgement), it only names the sequencing. Next time: if the design is in doubt, submit the design alone first (no code targets), then the implementation.`)
  } else if (timingRounds.length) {
    advisories.push(`[ADVISORY] SEQUENCING (raised in round ${timingRounds.join('/')}, carried forward to here): in that round the logic seat and the run seat raised P0s AT THE SAME TIME. If the method-level opinion held, the run seat line-level findings may already have been invalidated by the rewrite - confirm they still point at something real before delivering. The panel does not filter or demote any of them.`)
  }
  // 🔴 Independent of the if/else chain above: when seat identity is broken, say so WHETHER OR NOT the
  // sequencing note fired. The first version made this an else-if and a probe refuted it immediately -
  // when roles is truncated to half-right, the surviving half makes runFindingsConditional true by
  if (!rolesUsable && (logicSeatP0 + runSeatP0) > 0) {
    advisories.push(`[ADVISORY] Seat identity was lost or misaligned in transit (prior_state.claude_roles missing / length disagrees with the verdict array / all empty). The seat attribution of this round's ${logicSeatP0 + runSeatP0} P0(s) is NOT trustworthy - the sequencing check cannot be made this round, which is not the same as "there is no sequencing problem". Read them yourself to tell method-level from line-level.`)
  }
  // findings: the P0s THEMSELVES. carry is findings PLUS directives written for the next round's
  // prompt, and those embed round-varying text (a count of approving verdicts, the auditor's own
  // claim list), so they can never rematch and get marked not_restated while the gate that
  // produced them is still firing. A directive is not a finding; the ledger takes findings only.
  // One-off observation vs regenerated every round. SEQUENCING is recomputed from
  // timing_advisory_rounds, so carrying it as well makes it appear TWICE -- and E-carry asserts
  // exactly one, which is how the previous attempt at this repair broke it. Everything else here
  // is a one-off reading of the verdict being adjudicated: not carried, it dies with its round.
  // SEQUENCING is not the only advisory recomputed every round. The seat-identity one is too,
  // and it embeds `${logicSeatP0 + runSeatP0}` -- so the carried copy never string-equals the
  // regenerated one, exact-string dedup misses it, and a terminal ended up with several lines
  // all reading "this round's N P0(s)" for different N, none saying which round it meant.
  const REGENERATED_EVERY_ROUND = /^\[ADVISORY\] (SEQUENCING|Seat identity was lost)/
  const advisoriesOneOff = advisories.filter(a => !REGENERATED_EVERY_ROUND.test(String(a)))
  return { advisories, advisoriesOneOff, converged, carry, findings: newP0s.slice(), demoted: demotedP0s, p0Count: newP0s.length, unanchored, litConflicts, claimGap, codeGap, blockers, codes: [], runFindingsConditional, timingRounds }
}

// ============================ MAIN: two-phase, one round per invocation ============================
let resultBase = {
  task: TASK, project: PROJECT || null, kind: KIND, risk: RISK, mode: MODE,
  rounds_allowed: roundsAllowed, codex_mode: CODEX_MODE, task_fingerprint: TASK_FP, run_id: RUN_ID || null,
  findings_ledger: [],   // replaced once this round's gate has adjudicated the previous round
}

// ---- fail-closed: refuse a prior_state that does not belong to THIS audit (cross-project guard) ----
// Absent fingerprint = pre- state OR hand-assembled: cannot be proven to belong here, so it is
// refused too (silently trusting it is exactly the failure mode this guard exists to stop). Mismatch =
// the main loop threaded another project's/task's state in. Either way: abort, do NOT merge, do NOT converge.
// ---- fail-closed input-shape guards, BEFORE the identity guard ----
// Each of these previously degraded OPEN (silently ignored) rather than closed.
// Findings demoted in earlier rounds: the shapeAbort terminal states occur BEFORE demotedLog is
// declared (several hundred lines below), so they cannot reach it - the field is therefore ABSENT
// on those terminals. In JSON an absent field and an empty list are indistinguishable, so a reader
// concludes "nothing was demoted in earlier rounds", which is false.
// ⚠️ Carried ONLY AFTER IDENTITY IS CONFIRMED. On terminals reached BEFORE the fingerprint / run_id
// gates, prior may not belong to this audit at all - mixing another audit's demoted residue into this
const priorDemotedSeed = (prior && Array.isArray(prior.demoted_p0_log)) ? prior.demoted_p0_log.slice() : []
// The ledger's whole purpose is that a finding is never lost, so its own load path must not be the
// one place that loses it. Every neighbouring prior_state field is fail-closed; this one degraded
// OPEN, and an absent or non-array value silently discarded the entire prior ledger, restarted ids
// at F1, and let the run reach a terminal that positively asserts nothing was ever recorded.
//   - non-array  = a corrupt state. REFUSED, like every other malformed prior_state field.
//   - absent     = a state written before this field existed. Legitimate, but it CANNOT be proven
//                  complete, so the result says so instead of presenting an empty ledger as a fact.
const priorLedgerRaw = prior ? prior.findings_ledger : undefined
const priorLedgerMalformed = !!prior && priorLedgerRaw !== undefined && !Array.isArray(priorLedgerRaw)
const priorLedgerAbsent = !!prior && priorLedgerRaw === undefined
const priorLedgerSeed = Array.isArray(priorLedgerRaw) ? priorLedgerRaw.slice() : []
const priorAdvisoryCarry = (prior && Array.isArray(prior.advisory_carry)) ? prior.advisory_carry.slice() : []
let advisoryCarry = priorAdvisoryCarry.slice()
// Once incomplete, always incomplete: a later round cannot restore what an earlier state never carried.
const ledgerIncomplete = priorLedgerAbsent || (!!prior && prior.ledger_incomplete === true)
let identityOk = false
const shapeAbort = (statusName, why, fix) => ({
  ...resultBase, rounds_run: priorRound, converged: false,
  audit_stage: 'escalate_to_user', convergence_status: statusName,
  needs_expert_signoff: false,
  // 🔴 AUDIT panel-self-triage-0819 — refusing a corrupt state is right: having just declared
  // it untrustworthy, re-parsing another part of it would be worse.  But saying NOTHING about
  // what it carried lets the reader conclude nothing was ever found.  Count them without
  // trusting their content: a count is not an adjudication.
  blockers: [why].concat((() => {
    try {
      const raw = (prior && Array.isArray(prior.claude_verdicts_raw)) ? prior.claude_verdicts_raw : []
      const all = raw.concat(prevCodexRaw ? [prevCodexRaw] : [])
      if (!all.length) return []
      // Count VERDICTS, which needs no parsing and therefore cannot be wrong. The previous
      // version counted P0-DECLARING verdicts with /^P0:/, which misses `**P0**:`, a full-width
      // colon, and an indent -- shapes test_panel.mjs:48-55 catalogues precisely because naming
      // them one at a time is how four earlier fixes in this file went wrong. It also read 0 in
      // codex_only by construction, where claude_verdicts_raw is empty. So: an exact count is a
      // claim this code cannot support; a floor that says it is a floor is one it can.
      // Same prefix tolerance as BULLET_FIELD at :858 -- indent, bullet, digit, space before the
      // colon -- because those are exactly the shapes the panel's own parser RECORDS as real
      // blocking findings. A counter stricter than the parser reports "nothing declared" about a
      // verdict the parser already read as a blocker.
      const atLeast = all.reduce((k, t) => k + (/^\s*[-*\u2022>\d.)\]]*\s*P0\s*[:：]\s*(?!none\b)\S/mi.test(String(t)) ? 1 : 0), 0)
      return [`⚠️ the refused state carried ${all.length} verdict(s), NOT adjudicated and NOT reproduced here (this state could not be trusted). At least ${atLeast} of them declare a P0 — that is a FLOOR, not a count: a blocker written with another prefix shape is not matched. Read them yourself.`]
    } catch (e) { return ['⚠️ could not read what the refused state carried — assume it carried findings.'] }
  })()),
  unresolved_p0: (prior && prior.open_p0s) || [],
  ...(identityOk ? { demoted_p0: priorDemotedSeed } : {}),
  ...(identityOk ? { findings_ledger: priorLedgerSeed } : {}),
  // Also on the MALFORMED refusal: that terminal is precisely where the ledger cannot be
  // proven complete, and it was the one refusal that did not say so.
  ...(identityOk && (ledgerIncomplete || priorLedgerMalformed) ? { ledger_incomplete: true } : {}),
  agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
  recommended_next_action: fix,
})
if (priorPresent && !priorUsable) {
  log('ABORT: prior_state present but not a usable object')
  return shapeAbort('prior_state_malformed',
    `prior_state was supplied but is not a plain object (got ${Array.isArray(input.prior_state) ? 'an array' : typeof input.prior_state}). It is NOT treated as "no prior state": doing that would silently discard the codex verdict, reopen Round 1, erase the unresolved-P0 ledger and reset the cumulative budget, and could then declare convergence on that fresh round.`,
    'Pass prior_state as the OBJECT the panel returned, not a JSON string / array / scalar. If it was serialized in transit, parse it back before re-invoking. Do not "fix" this by dropping prior_state — that restarts the audit and loses every unresolved P0.')
}
if (!prior && prevCodexRaw) {
  log('ABORT: codex verdict supplied with no prior_state (orphan)')
  return shapeAbort('orphan_codex_verdict',
    'a codex verdict was supplied but prior_state is absent. A verdict answers a specific round of a specific audit, so there is no legitimate first-round call that carries one — this means the state was lost or mis-threaded. Accepting it would silently start a NEW audit and merge a verdict that answered a different round.',
    'Recover the prior_state object emitted by the previous invocation and pass it together with the verdict. If it is truly lost, restart the audit from round 1 with NO codex verdict — do not carry an orphan verdict forward.')
}
if (prior && !priorRoundValid) {
  log('ABORT: prior_state.round missing/invalid')
  return shapeAbort('prior_state_round_invalid',
    `prior_state.round is not an integer in 1..${MAX_ROUNDS} (got ${JSON.stringify(prior.round)}). The expected AUDIT-ID is derived from the round number, so an unusable round would silently expect "_r0" and reject an otherwise perfectly valid verdict under a misleading "identity mismatch" diagnosis.`,
    'Restore prior_state.round from the panel output of the previous round. Do not hand-edit the round number to make the check pass.')
}
if (prior) {
  const priorRunIdRaw = prior.run_id == null ? '' : String(prior.run_id).trim()
  if (priorRunIdRaw !== RUN_ID) {
    log('ABORT: run_id mismatch between prior_state and this invocation')
    return shapeAbort('prior_state_run_id_mismatch',
      `prior_state.run_id is "${priorRunIdRaw || '(none)'}" but this invocation passed "${RUN_ID || '(none)'}". This is checked INDEPENDENTLY of the fingerprint: a state whose fingerprint matches while its run_id does not is self-contradictory, and checking run_id only inside the fingerprint-mismatch branch let exactly that state through (reproduced live).`,
      'Pass the SAME run_id on every round of the same audit (the panel echoes it back in prior_state.run_id). If you are running two audits with identical args, give them DIFFERENT run_id values and keep each consistent across its own rounds.')
  }
}
if (prior) {
  const priorFp = (prior.task_fingerprint == null ? '' : String(prior.task_fingerprint)).trim()
  if (priorFp !== TASK_FP) {
    // Distinguish the most likely OPERATOR error from a genuine foreign state: run_id is part of the
    // fingerprint, so dropping/changing it between rounds makes an audit reject its OWN prior_state. Saying
    // "belongs to a DIFFERENT audit" there would send the operator hunting the wrong problem.
    const priorRunId = (prior.run_id == null ? '' : String(prior.run_id)).trim()
    const why = !priorFp
      ? `prior_state carries NO task_fingerprint, so it cannot be proven to belong to this audit`
      : (priorRunId !== RUN_ID
        ? `run_id drift: this prior_state was produced with run_id "${priorRunId || '(none)'}" but this invocation passed "${RUN_ID || '(none)'}". run_id is part of the audit fingerprint, so the SAME run_id must be passed on EVERY round of the SAME audit — this is almost certainly a threading mistake, not a foreign state`
        : `prior_state belongs to a DIFFERENT audit (its fingerprint ${priorFp} != this task's ${TASK_FP}); task/project/contextPack/user_context_raw all feed the fingerprint, so check whether any of those args changed between rounds`)
    log(`ABORT: ${why}`)
    return {
      ...resultBase, rounds_run: 0, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'prior_state_identity_mismatch',
      needs_expert_signoff: false,
      blockers: [`${why} — refusing to merge it. Merging a foreign state would cross-contaminate two projects' verdicts/frozen-R1/budget with NO visible symptom. This is fail-closed, not a transient error.`],
      recommended_next_action: `Do NOT retry with the same prior_state and do NOT hand-edit its fingerprint. Confirm which audit this state came from (its task/project), then either re-invoke with the CORRECT prior_state for task "${TASK}"${PROJECT ? ` / project "${PROJECT}"` : ''}, or restart this audit from round 1 with NO prior_state.`,
    }
  }
}

// Identity confirmed (both the fingerprint gate and the run_id gate passed): from here on a terminal
// can prove prior belongs to THIS audit, so prior.demoted_p0_log may be carried. The position of
identityOk = true
if (priorLedgerMalformed) return shapeAbort('prior_state_findings_ledger_malformed',
  'prior_state.findings_ledger is present but is not an array — the ledger cannot be proven complete, and silently treating it as empty is exactly the erasure this field exists to prevent',
  'thread the prior_state returned by the previous call verbatim; do not hand-assemble it')

// ---- deep content checks, AFTER identity is established ----
// Ordering matters: prove the state BELONGS to this audit first, then be picky about its fields. Reversed,
// a foreign state gets a "budget invalid" diagnosis and sends the operator hunting the wrong problem.
if (prior && !cumulativeValid) {
  log('ABORT: prior_state.cumulative_used invalid')
  return shapeAbort('prior_state_budget_invalid',
    `prior_state.cumulative_used is ${JSON.stringify(cumulativeRaw)}, which is not an integer in 0..${HARD_TOTAL_CEILING}. This number is what the ${HARD_TOTAL_CEILING}-agent fail-closed cap is enforced against, so a negative or absurd value launders the cross-invocation budget. It is rejected rather than clamped, because clamping is exactly what hid the tampering.`,
    'Restore cumulative_used from the panel output of the previous round. Do not hand-edit it.')
}
// The Claude side must actually BE THERE. "Validate only if the key exists" let a state omit it entirely, so
// a round could converge on the CODEX verdict alone — a "dual" audit with one side is not a dual audit.
// Not just "is an array": an EMPTY array meant the Claude side contributed nothing and a lone codex APPROVE
// converged — single-sided again. Require at least one entry that actually PARSES as a verdict block.
// Count must match what the panel EMITTED. "At least one valid" let a truncated array through, silently
// dropping the missing auditor's P0 list along with it (independent review). The emitted state
// carries claude_verdicts_count; when present it is authoritative.
const claudeArr = prior && Array.isArray(prior.claude_verdicts_raw) ? prior.claude_verdicts_raw : null
// Presence is decided by OWN-PROPERTY EXISTENCE, not by `!= null`. An explicit `claude_verdicts_count: null`
// is JSON-legal corrupted state; treating it as "old format, field absent" reopened exactly the fail-open
// path this check exists to close (independent review). Once the key exists it must be a strict
// integer — null/undefined/boolean/Symbol are rejected structurally rather than coerced (Number(null)===0)
// or thrown on (Number(Symbol()) throws TypeError).
const hasClaudeCountKey = !!(prior && Object.prototype.hasOwnProperty.call(prior, 'claude_verdicts_count'))
const claudeCountRaw = hasClaudeCountKey ? prior.claude_verdicts_count : undefined
const claudeCountValid = !hasClaudeCountKey || (typeof claudeCountRaw === 'number' && Number.isInteger(claudeCountRaw) && claudeCountRaw >= 0)
const claudeCountDeclared = (hasClaudeCountKey && claudeCountValid) ? claudeCountRaw : null
// 🔴 codex_only: a Claude side is absent BY DESIGN, so "non-empty" cannot be required of it.
//    This check exists to catch a Claude side that was TRUNCATED or silently dropped — its own
//    message names the danger: "the round is decided by the codex verdict alone (not a dual
//    audit)". Under codex_only that is not a degradation, it is the mode the caller asked for.
//    The exemption is safe to scope this narrowly because `mode` is part of the audit
//    fingerprint: a prior_state produced by a dual-mode run is a DIFFERENT audit and is refused
//    by the identity check long before reaching here, so no other mode can borrow this path.
//    ⚠️ Everything else still applies — an array that is present must still parse and must still
//    match its declared count. Only the emptiness requirement is lifted, and only here.
const claudeSideOptional = (MODE === 'codex_only')
const claudeVerdictsOk = !prior ? true : (
  (claudeSideOptional && claudeArr && claudeArr.length === 0 &&
    claudeCountValid && (claudeCountDeclared === null || claudeCountDeclared === 0))
  || !!(claudeArr &&
    claudeArr.length > 0 &&
    claudeArr.some(v => typeof v === 'string' && parseSentinel(v).valid) &&
    claudeCountValid &&
    (claudeCountDeclared === null || claudeArr.length === claudeCountDeclared)))
// HARD CUT: after workers were removed this panel's state no longer carries worker_output /
// worker_parsed. A prior_state containing any worker field comes from the pre-removal panel and is
// schema-incompatible - report an explicit error and require a fresh run rather than silently
// accepting it. Silent cross-schema reuse is exactly how false convergence breeds. `in` is used
// rather than hasOwnProperty so a worker field placed on the PROTOTYPE is caught too: hasOwnProperty
// sees own properties only, and a probe injecting the field on the prototype converged=true. Review
// later showed the driver's JSON.parse handoff strips prototypes, making that unreachable in
const hasLegacyWorkerField = !!prior && (('worker_output' in prior) || ('worker_parsed' in prior))
if (hasLegacyWorkerField) {
  log('ABORT: prior_state is legacy (pre-worker-removal) format')
  return shapeAbort('prior_state_legacy_worker_format',
    `prior_state carries worker_output/worker_parsed — it was emitted by a PRE-worker-removal panel and is schema-incompatible with the current pure-review panel. Re-run the audit from round 1; do NOT silently reuse a cross-schema state (silent reuse is a false-convergence hazard).`,
    'Re-run from round 1 without the legacy prior_state (or pass a prior_state emitted by the current pure-review panel).')
}
if (prior && !claudeVerdictsOk) {
  log('ABORT: prior_state.claude_verdicts_raw is not an array')
  return shapeAbort('prior_state_schema_invalid',
    `prior_state.claude_verdicts_raw is unusable: it must be a non-empty array, contain at least one string that PARSES as a valid verdict block, and (when claude_verdicts_count is present) have exactly that many entries. Got ${claudeArr ? 'an array of ' + claudeArr.length : (prior.claude_verdicts_raw === undefined ? 'nothing at all' : typeof prior.claude_verdicts_raw)}${claudeCountDeclared !== null ? ', declared count ' + claudeCountDeclared : ''}. An empty, unparseable or TRUNCATED Claude side means the round is decided by the codex verdict alone (not a dual audit) or silently drops a missing auditor's P0 list.`,
    'Restore prior_state from the panel output verbatim; do not reshape or re-serialize its fields.')
}
// R2+ MUST carry the frozen R1 verdicts. This was only checked on the "not converged, prepare next round"
// path, so an R2 state with frozen_r1 missing could go straight to converged_r2 with the R1 freeze unproven.
// BOTH sides of R1 must be frozen and NON-EMPTY. Accepting {claude:[]} with no codex side let an R2 proceed
// while proving nothing was frozen — the freeze is what makes "R1 independent, R2 cross-examine" mean anything.
// The frozen R1 must PARSE as verdicts on both sides. "Non-empty" was satisfied by the literal string
// 'garbage', which proves nothing was frozen (independent review).
// The frozen CODEX verdict must also prove it belongs to THIS audit's round 1. Parseability alone let a
// foreign (or fabricated) frozen verdict with no AUDIT-ID at all be treated as the frozen R1 for cross-
// examination (independent review).
const frozenCodexCarriesR1Id = (raw) => {
  const parsedFrozen = parseSentinel(String(raw == null ? '' : raw))
  const blk = parsedFrozen.blockRaw
  if (!blk) return false
  const want = auditIdFor(1)
  // First merge in every spelling the parser already recognises (including bullet and numbered-prefix
  // lines), then add this function's own line scan. When two scanners have different coverage, only
  const ids = parsedFrozen.audit_ids.slice()
  for (const L of splitLines(blk)) {
    const mm = L.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '').match(/^\s*AUDIT[-_ ]?ID\s*:\s*(.*)$/i)
    if (mm) ids.push(mm[1].trim())
  }
  return ids.length > 0 && ids.every(x => x === want)
}
const frozenOk = !(prior && priorRoundValid && priorRound >= 2) ? true : !!(prior.frozen_r1 &&
  Array.isArray(prior.frozen_r1.claude) &&
  prior.frozen_r1.claude.some(v => typeof v === 'string' && parseSentinel(v).valid) &&
  typeof prior.frozen_r1.codex === 'string' && parseSentinel(prior.frozen_r1.codex).valid &&
  frozenCodexCarriesR1Id(prior.frozen_r1.codex) &&
  // ...and the frozen Claude array must be COMPLETE. Without a count it could be truncated to one entry,
  // silently discarding the other R1 auditor's position before cross-examination even starts.
  (!Object.prototype.hasOwnProperty.call(prior.frozen_r1, 'claude_count') ||
    (typeof prior.frozen_r1.claude_count === 'number' &&
     Number.isInteger(prior.frozen_r1.claude_count) &&
     prior.frozen_r1.claude.length === prior.frozen_r1.claude_count)))
if (prior && priorRoundValid && priorRound >= 2 && !frozenOk) {
  log('ABORT: round>=2 but frozen_r1 missing/invalid')
  return shapeAbort('prior_state_frozen_r1_missing',
    `prior_state.round is ${priorRound} but frozen_r1 does not carry BOTH sides' round-1 verdicts as PARSEABLE verdict blocks (need at least one valid block in frozen_r1.claude, AND a valid frozen_r1.codex block that carries THIS audit's round-1 AUDIT-ID ${auditIdFor(1)}). A non-empty string like 'garbage' passes an emptiness test while proving nothing was frozen, and a parseable verdict with no AUDIT-ID could have come from any audit at all. Round 1 verdicts must be frozen and carried forward: without them the panel cannot show that R2+ cross-examined a fixed R1 rather than quietly re-deriving it, so a convergence declared here would be unproven.`,
    'Re-invoke with the prior_state emitted by the previous round (it contains frozen_r1). If it is lost, restart the audit from round 1.')
}

// --- STEP A: if a previous round's codex verdict is in, FIRST evaluate that round's convergence ---
let openP0s = [], shared = null, startRound = 1, allLit = []
let findingsLedger = []
// ⚠️ demotedLog must be declared HERE, at the top level, not inside the STEP A branch below: the
// handoff return lives OUTSIDE that branch, where a block-scoped let is invisible - probed, it fell
// back to an empty array every round, so the whole "demoted items survive across rounds" chain
// silently failed while every test stayed green (the convergence path can see it from inside the
// branch). Seeded from the value already accumulated in prior: the codex-unavailable and
// budget-exhausted terminals occur BEFORE the gate, when this round has produced no new demotions
let demotedLog = priorDemotedSeed.slice()   // same source as the shapeAbort terminals; do not compute it twice
// resultBase is spread by every return below this point, and the real ledger is only computed once
// the gate has adjudicated the previous round — several terminal exits sit ABOVE that. They used to
// emit the literal empty array declared with resultBase while prior_state held entries, i.e. a
// positive assertion that nothing was ever recorded, on exactly the paths where the panel is
// admitting it could not finish. Seed it here, after identity is confirmed.
// Copied, not aliased: measured, result.findings_ledger === prior_state.findings_ledger was
// true, so the returned object and the state it came from were one array. Nothing mutates it
// today, which is the kind of "safe for now" that stops being true without anything failing.
resultBase.findings_ledger = priorLedgerSeed.map(e => (e && typeof e === 'object') ? { ...e } : e)
// Same reasoning for the carried advisories, one level up: a return that gives up reaches the
// reader through `...resultBase` and nothing else, so seeding it here covers every such exit at
// once. A path that computes real advisories overrides this by setting the key after the spread.
resultBase.advisories = advisoryCarry.slice()
if (ledgerIncomplete) resultBase.ledger_incomplete = true
let timingRounds = (prior && Array.isArray(prior.timing_advisory_rounds)) ? prior.timing_advisory_rounds.slice() : []
let priorConvergenceNote = null
// ---- false-death handling: codex did NOT produce a trustworthy verdict for prior.round
// (empty stdout OR nonzero exit OR a MISSING/malformed exit code alongside complete-looking stdout — see A2:
// absence of an exit code is absence of evidence, not evidence of success). Do NOT parse stale stdout, do NOT silently
// reopen R1 (loses R2 cross-examine progress), do NOT re-run the Claude side (burns budget). Hold the round;
// ask the main loop to RE-RUN codex on the SAME brief; escalate as 'codex unavailable' after MAX_CODEX_UNAVAIL.
if (codexUnavailable) {
  const streak = Math.max(0, parseInt(prior.codex_unavailable_streak, 10) || 0) + 1
  // String() (not JSON.stringify) so an exotic non-JSON exit value (BigInt / cyclic object) can't THROW here —
  // such values are already classified unavailable (non-scalar) and must escalate cleanly, never crash the panel.
  // A2 follow-up: distinguish ABSENT from BAD. Reporting a missing exit code as "bad/nonzero ... undefined"
  // sends the operator off diagnosing a codex crash when the real fix is "capture and pass $?".
  const why = !prevCodexRaw ? 'empty stdout'
    : (codexExitAbsent ? 'codex_exit_code was NOT supplied — it is mandatory whenever a codex verdict is passed (a killed/timed-out run can still leave a complete-looking APPROVE on stdout); capture $? and pass it, or re-run codex'
      : `bad/nonzero codex exit code ${(() => { try { return String(input.codex_exit_code) } catch (e) { return '[unprintable]' } })()}`)
  if (streak >= MAX_CODEX_UNAVAIL) {
    log(`ESCALATE: codex unavailable ${streak}x (${why}) for round ${priorRound}`)
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'codex_unavailable',
      // Carried advisories must survive HERE too. This terminal is reached without running the
      // gate, so the merge that happens inside it never runs, and the driver only ever reads the
      // LAST result: an advisory raised in round 1 and carried into round 2 vanished completely
      // if round 2's codex then failed twice. The path that gives up is the path a reader most
      // needs the earlier warnings on.
      advisories: advisoryCarry.slice(),
      demoted_p0: demotedLog,
      needs_expert_signoff: false,
      blockers: [`codex produced no trustworthy verdict ${streak}x (${why}) for round ${priorRound} — cannot complete the independent dual-audit; do NOT treat the absence/kill as a pass. Surface to the user (codex may be down: timeout too tight / auth / sqlite lock / network).`],
      unresolved_p0: prior.open_p0s || [],
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
      recommended_next_action: 'Codex is repeatedly unavailable. Do NOT fabricate or infer its verdict and do NOT declare converged. Diagnose codex (raise the timeout your codex wrapper reads - that variable belongs to the WRAPPER, not to the panel, and the two deployments name it differently; check auth / logs_2.sqlite lock / network), then either re-run on the same brief or surface the unresolved issues to the user.',
    }
  }
  if (!prior.last_codex_brief) {
    // Telling the operator to re-run "the SAME brief" while handing back codex_brief:null pushes them into
    // hand-rebuilding the brief — which would also mean hand-writing the AUDIT-ID, forging the very evidence
    // the identity guard exists for.
    log('ABORT: codex unavailable but prior_state.last_codex_brief is missing')
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'prior_state_missing_brief',
      needs_expert_signoff: false,
      blockers: [`codex produced no trustworthy verdict (${why}) for round ${priorRound}, and prior_state.last_codex_brief is missing so the exact brief it should re-answer cannot be recovered.`],
      unresolved_p0: prior.open_p0s || [],
      demoted_p0: demotedLog,
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
      recommended_next_action: 'Restart this round from a clean state (re-invoke with the prior_state from the round BEFORE this one, or from round 1 if unavailable). Do NOT hand-rebuild the brief and do NOT hand-write the AUDIT-ID — a hand-written id defeats the identity check entirely.',
    }
  }
  log(`codex unavailable (${why}) for round ${priorRound}, attempt ${streak}/${MAX_CODEX_UNAVAIL} — holding round, retry codex (NOT advancing, NOT re-running Claude side)`)
  return {
    ...resultBase, rounds_run: priorRound, converged: false,
    audit_stage: 'codex_retry_pending', convergence_status: `r${priorRound}_codex_unavailable_retry`,
    demoted_p0: demotedLog,
    codex_brief: prior.last_codex_brief || null,
    codex_brief_tag: prior.last_codex_brief_tag || null,
    blockers: [`codex has no TRUSTWORTHY verdict (${why}) for round ${priorRound} — retrying codex on the SAME brief, NOT advancing the round, NOT re-running the Claude side`],
    prior_state: Object.assign({}, prior, { codex_unavailable_streak: streak }),  // unchanged EXCEPT streak++
    agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
    recommended_next_action: [
      `Codex has no trustworthy verdict for round ${priorRound} (${why}); attempt ${streak}/${MAX_CODEX_UNAVAIL}.`,
      `RE-RUN codex on the SAME brief: take the brief VERBATIM from prior_state.last_codex_brief (threaded above). Do NOT guess a path — the brief file is PER-RUN UNIQUE (mktemp) and there is NO deterministic /tmp/dual-audit/brief_<tag>.md; assuming one would fail, or worse read a STALE brief from another task. Write it to a FRESH unique file, then run: mkdir -p /tmp/dual-audit ; B=$(mktemp --suffix=.md /tmp/dual-audit/brief_${prior.last_codex_brief_tag || 'retry'}.XXXXXX) ; write the brief VERBATIM into "$B" ; ~/bin/codex-audit exec --sandbox read-only --skip-git-repo-check -o "$B.codex.txt" - < "$B" ; VERIFY EXIT=0. The -o output file MUST be unique-per-run like this (derived from the mktemp $B): redirecting to a FIXED shared path is a documented cross-task contamination route (see ACCEPTED_BOUNDARIES in ~/bin/codex-audit).`,
      `Then re-invoke the panel with the SAME task args + { codex_prev_verdict_raw: <output>, codex_exit_code: <exit>, prior_state: <the prior_state above> }.`,
      `Do NOT fabricate a verdict, do NOT treat an empty/killed run, a MISSING exit code, or any value that is not a clean all-zeros string|number (e.g. [0] / {} / true / 'EXIT=0' / '0x0' / NaN) as a pass. If a slow xhigh audit keeps timing out, raise the timeout your codex wrapper reads before retrying (check that wrapper's own documented variables - naming a fixed one here would be wrong in half the deployments). After ${MAX_CODEX_UNAVAIL} failed attempts the panel escalates to the user.`,
    ].join('\n'),
  }
}
// ---- fail-closed: the codex verdict must PROVE it answered THIS audit's brief (cross-project guard) ----
// prior_state is fingerprint-bound, but codex_prev_verdict_raw arrives as a SEPARATE free-form string with
// nothing tying it to this audit. The independent Codex audit DEMONSTRATED the hole: a valid
// APPROVE produced for ANOTHER project's brief, paired with this audit's correct prior_state, parsed and
// merged straight to converged_r1. Every brief now carries `AUDIT-ID: <fp>_r<round>` and REQUIRES the
// auditor to echo it, so a foreign verdict is detectable instead of silently authoritative.
if (prevCodexRaw && prior) {
  const expectedAuditId = auditIdFor(priorRound)
  // Scope the check to the LAST VERDICT..END block and compare WHOLE tokens. A bare `includes` was too weak
  // (independent audit): it accepted an id echoed AFTER END, accepted a block carrying SEVERAL ids
  // (one right + one foreign), and accepted a SUPERSTRING of the right id (`..._r1` matching `..._r10`).
  // STRICT, field-anchored, whole-value comparison. The previous regex was fail-OPEN in three ways, each
  // demonstrated by the independent audit: it was not anchored to the start of the field
  // (`NOT-AUDIT-ID: <right id>` matched), it stripped trailing punctuation (`<right id>,` passed), and it
  // captured only the first \S+ (`<right id> <foreign id>` passed). Now: the TRIMMED line must BEGIN with
  // the exact field name, and the ENTIRE remainder of that line must equal the expected id verbatim.
  const parsedPrevCodex = parseSentinel(prevCodexRaw)
  const idBlock = parsedPrevCodex.blockRaw || ''
  // Recognize the field BROADLY, compare the value STRICTLY. Narrow recognition was itself a hiding place: a
  // foreign id written with any other colon variant, a space before the colon, a fancy hyphen or an invisible
  // zero-width char was skipped entirely, so it stayed inside the block yet invisible to the all-must-match
  // rule (independent review). Normalizing first forces such a line to be SEEN and rejected.
  // Field detection uses NFKC (which folds full-width letters/colons and many look-alikes) plus removal of
  // invisible format characters; the VALUE is taken from the RAW line and compared verbatim. A hand-maintained
  // character table was whack-a-mole (full-width `AUDIT-ID:`, U+2009 thin space etc. still slipped through),
  // and normalizing the whole line meant a zero-width char INSIDE the id was silently deleted and then
  // accepted — contradicting the "entire value compared verbatim" contract (independent review).
  const INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff\u00ad]/g
  const nfkc = (s) => { try { return s.normalize('NFKC') } catch (e) { return s } }
  // shape of an audit id: fp_<base36>_<base36>_r<round>
  const LOOKS_LIKE_AUDIT_ID = /^fp_[a-z0-9]+_[a-z0-9]+_r[0-9]+$/i
  // Optimal String Alignment (restricted Damerau): an ADJACENT TRANSPOSITION costs 1, not 2.
  // The transposition rule MUST be applied inside the DP loop — computing it as a post-pass over a finished
  // Levenshtein table does not propagate the improvement to later cells, so a name with two transpositions
  // (`UADITDI` vs `AUDITID`) still scored 4 instead of 2. My own double-transposition test caught that the
  // post-pass version was wrong (and that a mutation "removing" it was only spuriously killed).
  const editDist = (a, b) => {
    const m = a.length, k = b.length
    const d = []
    for (let i = 0; i <= m; i++) { const row = new Array(k + 1).fill(0); row[0] = i; d.push(row) }
    for (let j = 0; j <= k; j++) d[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= k; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
        }
      }
    }
    return d[m][k]
  }
  const isColonChar = (ch) => nfkc(ch) === ':'
  const blockIds = []
  let suspiciousIdLine = null
  for (const line of splitLines(idBlock)) {
    let ci = -1
    for (let i = 0; i < line.length; i++) { if (isColonChar(line[i])) { ci = i; break } }
    if (ci < 0) continue
    const nameRaw = nfkc(line.slice(0, ci)).replace(INVISIBLE_RE, '')
    // Strip only ASCII separators. A blanket "remove every non-alphanumeric" made `AUDIT ID <CJK>:` collapse
    // to AUDITID and falsely REJECT a legitimate line — a fix that caused harm.
    const letters = nameRaw.toUpperCase().replace(/[-_\s.]/g, '')
    if (letters === 'AUDITID') {
      // RAW remainder, only trimmed: an invisible char INSIDE the value must fail the comparison, not be
      // normalized away into a match.
      blockIds.push(line.slice(ci + 1).trim())
      continue
    }
    // Not an exact match. Distinguish a non-ASCII character MASQUERADING as part of the field name (en/em
    // dash separator, Greek homoglyph letter) from a genuinely DIFFERENT field that merely begins with the
    // same words (`AUDIT ID NOTES:`, `AUDIT ID <CJK>:`). Walk collecting ASCII alnum: a non-ASCII char BEFORE
    // 'AUDITID' completes means the name is spelled with disguised characters -> suspicious, fail the block
    // CLOSED. Non-ASCII only AFTER a complete 'AUDITID' is extra wording -> a different field, leave it be.
    // Enumerating look-alike characters is unwinnable; refusing the ambiguous line is not.
    // Only a name that actually RESEMBLES 'AUDITID' counts as disguised. The previous rule flagged ANY
    // non-ASCII before completion, so an unrelated non-ASCII field name killed the whole block — a
    // guard causing harm (independent review).
    const asciiOnly = letters.replace(/[^A-Z0-9]/g, '')
    const hasNonAscii = asciiOnly.length !== letters.length
    // A name that STARTS with a complete 'AUDITID' and then continues is a DIFFERENT field
    // (`AUDIT ID NOTES:`, `AUDIT ID <CJK> A:`) — never suspicious, regardless of what follows.
    // "A different field that merely starts the same way" comes in two shapes, BOTH of which must be left
    // alone: extra ASCII after a complete AUDITID (`AUDIT ID NOTES:` -> AUDITIDNOTES), and extra NON-ASCII
    // after a complete AUDITID (`AUDIT ID <CJK>:` -> asciiOnly is exactly AUDITID, so a length test alone
    // misses it — the discriminator is WHERE the non-ASCII sits relative to the completed name).
    const isOtherFieldAscii = asciiOnly.indexOf('AUDITID') === 0 && asciiOnly.length > 7
    let nonAsciiTrailsCompleteName = false
    if (hasNonAscii && asciiOnly === 'AUDITID') {
      const idx = letters.search(/[^A-Z0-9]/)
      nonAsciiTrailsCompleteName = letters.slice(0, idx).replace(/[^A-Z0-9]/g, '').length >= 7
    }
    if (!isOtherFieldAscii && !nonAsciiTrailsCompleteName) {
      if (hasNonAscii && asciiOnly === 'AUDITID') {
        // non-ASCII interspersed WITHIN the name = separator masquerade (en/em dash, zero-width, ...)
        suspiciousIdLine = nameRaw.trim()
      } else if (asciiOnly.length >= 5 && asciiOnly.length <= 9 && editDist(asciiOnly, 'AUDITID') <= 2 &&
                 LOOKS_LIKE_AUDIT_ID.test(line.slice(ci + 1).trim())) {
        // A near-miss name is treated as an imitation only when its VALUE actually looks like an audit id.
        // That pairing is what makes the line a hiding place. Keying on the value fixes both directions at
        // once: an ordinary `AUDITED: pass` (one edit from AUDITID) is no longer falsely rejected, while the
        // transposed `AUIDT-ID: fp_..._r1` no longer slips through. Discriminator suggested by the
        // independent review; the distance bound is Damerau, so transpositions count as 1.
        suspiciousIdLine = nameRaw.trim()
      }
    }
  }
  // Union: this scanner is good at spotting DISGUISED field names (AUIDT-ID and friends), the parser
  // is good at spotting LEGITIMATE field lines carrying a prefix. Use one alone and the other class is
  const allIds = blockIds.concat(parsedPrevCodex.audit_ids)
  const idOk = allIds.length > 0 && allIds.every(x => x === expectedAuditId) && !suspiciousIdLine
  if (!idOk) {
    const seen = suspiciousIdLine
      ? `a line whose field name imitates AUDIT-ID with disguised characters ("${suspiciousIdLine}") — refused as ambiguous`
      : (allIds.length ? allIds.join(', ')
        : ((parsedPrevCodex.ambiguous_block_count || 0) > 1
          ? `(could not be read - the output contains ${parsedPrevCodex.ambiguous_block_count} VERDICT..END blocks WITH DIFFERENT CONTENT, and the panel refuses to guess which one is the verdict, so no field was read at all. This is NOT "AUDIT-ID missing": the id may well be inside one of them. Have the auditor emit exactly one verdict block and re-run)`
          : '(none inside the VERDICT..END block)'))
    log(`ABORT: codex verdict audit-id mismatch — expected ${expectedAuditId}, block carried: ${seen}`)
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'codex_verdict_identity_mismatch',
      needs_expert_signoff: false,
      blockers: [`the supplied codex verdict's VERDICT..END block does not carry this audit's AUDIT-ID. Expected ${expectedAuditId}; block carried: ${seen}. It cannot be proven to answer THIS audit's round-${priorRound} brief — REFUSED, not merged, because merging it would silently import another project's APPROVE/REJECT into this audit. NOTE the honest limit of this check: it detects MIS-THREADING (the realistic failure), not forgery — an auditor that copies the id can still assert anything, so it is an identity check, not a proof of provenance.`],
      unresolved_p0: (prior.open_p0s || []),
      demoted_p0: demotedLog,
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
      recommended_next_action: `Do NOT paste the AUDIT-ID in by hand — that forges the very proof this check exists for. Re-run codex on THIS audit's brief (prior_state.last_codex_brief already contains the AUDIT-ID line) via ~/bin/codex-audit, capture its output to a UNIQUE file, and pass that verdict back with its exit code.`,
    }
  }
}
if (prevCodexRaw && prior) {
  const codexParsed = parseSentinel(prevCodexRaw)
  const codexInvalid = !codexParsed.valid
  ledger.totalUsed += 1   // P0-3 fix: the main-loop codex pass that produced prevCodexRaw counts toward the cap
  // fail-closed BEFORE any converged return: an over-ceiling result is not trustworthy even if both sides approve
  if (ledger.totalUsed > HARD_TOTAL_CEILING) {
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'not_converged',
      blockers: [`HARD_TOTAL_CEILING (${HARD_TOTAL_CEILING}) exceeded (total_used=${ledger.totalUsed}) — fail-closed before declaring any result`],
      demoted_p0: demotedLog,
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
      recommended_next_action: 'Agent budget ceiling exceeded; do NOT trust an over-budget result. Surface unresolved issues to the user.',
    }
  }
  // reconstruct the prior claude round shape from carried raw verdicts
  const priorClaudeRound = {
    n: priorRound, anyNull: !!prior.any_null,
    // Pure review panel: no worker to reconstruct across the handoff.
    // P0 (whole-flow audit): recover `invalid` from the re-parse — hardcoding invalid:false dropped a
    // dispatch-failed/garbage auditor across the handoff (its flag was never persisted in prior_state), letting a
    // round converge while silently ignoring an auditor that never produced a valid verdict. fail-closed instead.
    // role is recovered from prior.claude_roles BY POSITION (see the note at the emitting end).
    // ⚠️ SHAPE CHECK: these two arrays are aligned by position only, and nothing guarantees they are
    // the same length or hold the right values. With the key missing or truncated, role becomes an
    // empty string - every seat is then counted as the logic seat, runSeatP0 stays 0, and the
    // sequencing note NEVER FIRES while nothing in the log looks wrong.
    // 🔴 An earlier version of this comment claimed "misalignment also silently yields empty strings".
    //    That was wrong and was written without checking. Misalignment (e.g. ['ABCL','D1D2']) produces
    //    NO empty string; it shows up as the two seats' P0 counts being swapped. Misalignment is now
    //    caught by the per-position content check below, not by an empty string.
    // WHY NOT FAIL-CLOSED: this note sets no gate, filters nothing and demotes nothing, so rejecting
    auditors: (prior.claude_verdicts_raw || []).map((r, i) => { const p = parseSentinel(r); return { kind: 'claude', role: (prior.claude_roles || [])[i] || '', invalid: !p.valid, skipped: false, parsed: p, raw: r } }),
    // ⚠️ Upgraded from a LENGTH check to a PER-POSITION CONTENT check. Length alone misses three
    // EQUAL-LENGTH bad shapes, all of which measurably fell back to total silence:
    //   ['','ABCL']     one empty, one correct   -> neither warning fires
    //   ['RUN','LOGIC'] both non-empty, both wrong -> neither warning fires
    //   ['ABCL','D1D2'] order reversed             -> the note still fires, but the two seats' P0
    //                                                 counts are SWAPPED and nothing warns.
    rolesUsable: (() => {
      const vs = prior.claude_verdicts_raw || []
      const rs = Array.isArray(prior.claude_roles) ? prior.claude_roles : null
      if (!vs.length) return true                        // nothing to classify, so usability is moot
      if (!rs || rs.length !== vs.length) return false    // missing key / truncated
      if (rs.length !== SEAT_ROLES.length) return false   // seat count disagrees with this task's seat configuration
      return rs.every((x, i) => String(x == null ? '' : x).trim() === SEAT_ROLES[i])
    })(),
  }
  const gate = evaluateConvergence(priorRound, priorClaudeRound, codexParsed, codexInvalid, prior.timing_advisory_rounds)
  findingsLedger = buildFindingsLedger(priorRound, priorLedgerSeed, gate.findings)
  // 🔴 AUDIT panel-self-0818 (P0 #1/#2/#7) — an advisory generated while adjudicating an earlier
  // round reached only that round's result, and the driver returns only the last one.  Measured:
  // the blocker-smuggling advisory ("a real blocker is written in EVIDENCE while the gating field
  // says none — a human should look") was generated at call 2 and was GONE by call 3.
  // Carry the one-off ones; the regenerated SEQUENCING note is excluded at the source, because
  // carrying it too made it appear twice and broke E-carry (which asserts exactly one).
  const ADVISORY_CARRY_CAP = 200
  for (const a of (gate.advisoriesOneOff || [])) if (!advisoryCarry.includes(a)) advisoryCarry.push(a)
  if (advisoryCarry.length > ADVISORY_CARRY_CAP) {
    // Two bugs, one shape -- the notice is itself an entry and was not accounted for.
    //   slice(CAP) then unshift produced CAP+1, so the stated cap was never the real one.
    //   The next truncation sliced the previous notice away, resetting the tally to only what
    //   THIS pass dropped -- so a long run under-reported its own losses, which is the silent
    //   truncation the notice exists to prevent.
    let prevDropped = 0
    advisoryCarry = advisoryCarry.filter(a => {
      const m = /^\[ADVISORY\] (\d+) earlier advisory line\(s\) dropped/.exec(String(a))
      if (m) { prevDropped += Number(m[1]) || 0; return false }
      return true
    })
    const keep = ADVISORY_CARRY_CAP - 1          // the notice occupies one slot: CAP means CAP
    const dropped = prevDropped + Math.max(0, advisoryCarry.length - keep)
    advisoryCarry = advisoryCarry.slice(-keep)
    advisoryCarry.unshift(`[ADVISORY] ${dropped} earlier advisory line(s) dropped at the ${ADVISORY_CARRY_CAP} cap — cumulative across truncations, said out loud so it is never silent.`)
  }
  gate.advisories = gate.advisories.concat(advisoryCarry.filter(a => !gate.advisories.includes(a)))

  // A finding that stops being restated does not block, but it must not be silently absent from what
  // a human reads. Without this the ledger has NO reader anywhere -- not the driver, not the triage
  // reminder -- while the terminal says "safe to apply". This is the advisory channel the demoted
  // P0s already use, NOT a gate: the panel cannot tell "refuted on the merits" from "nobody
  // mentioned it again", and blocking on the difference would stall ordinary runs.
  for (const e of findingsLedger) {
    if (e.status !== 'not_restated') continue
    // Says what the matcher can actually establish. Measured: rewording "at line 44" to "on
    // line 44" produced BOTH a duplicate entry AND this line asserting the finding was "NO
    // LONGER restated" -- while it was restated immediately below, in different words. The
    // matcher compares normalised text, so a paraphrase and a silence are the same event to it.
    gate.advisories.push(`[ADVISORY] a P0 first raised in round ${e.round_raised} was not restated IN MATCHING WORDS this round, and was never explicitly resolved: "${String(e.text).slice(0, 160)}" - matching is by normalised text, so a REPHRASED restatement looks identical to a silence here; check whether it was reworded before concluding it was dropped. The panel does not hold convergence for it either way; a human must decide.`)
  }
  // .map, not the array itself: prior_state below is handed `findingsLedger` too, and assigning the
  // same reference to both made result.findings_ledger === prior_state.findings_ledger -- one array
  // reachable through two names that are supposed to be a result and the state that produced it.
  resultBase.findings_ledger = findingsLedger.map(e => (e && typeof e === 'object') ? { ...e } : e)   // resultBase is spread by every return below this point
  timingRounds = gate.timingRounds || timingRounds
  allLit = allLit.concat(prior.lit_conflicts || [], gate.litConflicts || [])
  // Demoted items accumulate across rounds. The cap of 200 exists purely to stop state bloat; when it
  // truncates it SAYS how many were dropped and never drops silently - a silently dropped P0 and a
  const demotedPrev = Array.isArray(prior.demoted_p0_log) ? prior.demoted_p0_log : []
  demotedLog = demotedPrev.concat((gate.demoted || []).map(d => ({ ...d, round: priorRound })))
  // The cap of 200 stops state bloat. ⚠️ Three traps, all found by independent review and fixed:
  //   1. slice(0,200) followed by pushing the note line gives 201 entries - keep 199 plus 1 note.
  //   2. The previous round's note line would be carried in as an ordinary entry - strip it first, or
  //      the reported total shrinks with every consecutive truncation.
  const TRUNC_MARK = '__demoted_truncation_note__'
  const prevNote = demotedLog.find(d => d && d.why === TRUNC_MARK)
  const prevDropped = prevNote ? (Number(prevNote.dropped) || 0) : 0
  demotedLog = demotedLog.filter(d => !(d && d.why === TRUNC_MARK))
  if (demotedLog.length + (prevDropped ? 1 : 0) > 200) {
    const keep = 199
    const dropped = prevDropped + (demotedLog.length - keep)
    demotedLog = demotedLog.slice(0, keep)
    demotedLog.push({ kind: 'panel', round: priorRound, dropped, why: TRUNC_MARK,
      text: `(${dropped} further demoted items are not listed, cumulatively, because of the state size cap - they DID exist, they were simply not carried one by one)` })
  } else if (prevDropped) {
    demotedLog.push({ kind: 'panel', round: priorRound, dropped: prevDropped, why: TRUNC_MARK,
      text: `(${prevDropped} further demoted items are not listed, cumulatively, because of the state size cap)` })
  }
  // P1-d mechanical anti-false-convergence: codex is the continuous independent model, so a flip from a
  // non-approving stance to APPROVE is only legitimate if the DELTA field is actually FILLED IN and is not
  // an explicit non-answer. (The panel cannot judge whether the content is real new evidence — the reader does.)
  // A bare flip (no DELTA / "unchanged") is fail-closed — caving to the other side does not count.
  if (priorRound >= 2 && prior.frozen_r1 && gate.converged) {
    const codexR1 = parseSentinel(prior.frozen_r1.codex || '')
    // Comparing against the FROZEN R1 alone is not enough: on APPROVE -> REJECT -> APPROVE both R1 and
    // R3 are APPROVE, so the flip is never recognised and R3 converges with no DELTA. Reproduced on
    // both sides. So the stance of the IMMEDIATELY PRECEDING round is compared as well; that stance
    // was not persisted before and is now carried in prior_state.prev_round_stance.
    const prevStance = prior.prev_round_stance
    // round must equal priorRound-1 EXACTLY. Checking only the two booleans lets a stance from two
    // rounds back, or one whose round was edited, pass as valid, and back-flip detection stops working
    // (probed: both {round:99} and a missing round reproduced converged=true).
    // Honest boundary: this stops MISWIRED OR STALE state, not a deliberately forged boolean - the
    // state is handed back manually by the main loop and the panel cannot authenticate its origin.
    // Preventing forgery would need the harness to store or sign the state, which is outside this
    const triState = (v) => typeof v === 'boolean' || v === null
    const prevStanceUsable = !!(prevStance && typeof prevStance === 'object' &&
      triState(prevStance.claude) && triState(prevStance.codex) &&
      prevStance.round === priorRound - 1)
    // Moved earlier, to R2+: the new convergence guarantee depends ENTIRELY on the freshFlip computed
    // against the immediately preceding round, so if R2 lacks a usable prev_round_stance then a
    // REJECT -> APPROVE flip cannot be recognised and passes straight through.
    if (priorRound >= 2 && !prevStanceUsable) {
      gate.converged = false
      gate.blockers.push('prior_state.prev_round_stance missing/malformed at round>=2 - cannot verify a stance change against the immediately-prior round, fail-closed')
      gate.carry.push('re-invoke from a prior_state emitted by this panel version (it always carries prev_round_stance at R2+)')
    }
    // Compared against the FROZEN R1 only. The other half - comparing against the immediately
    // preceding round - is carried independently by the freshFlip gate above, and duplicating it here
    const codexFlippedUp = codexParsed.approves &&
      ((!codexR1.approves) || (prevStanceUsable && prevStance.codex === false))
    // normalize: collapse ALL ASCII+CJK/full-width punctuation (incl. slash + ASCII/CJK quotes) to spaces
    // so trivial values written as "none;" / "unchanged." / "n.a." / "n/a" / "N/A" / '"none"' / "none；" /
    // "（none）" / "none, see above" are still caught. The slash matters: "n/a" is a very common way to write
    // An explicit non-answer normalises onto the token list; a delta with real content does not match as a whole, so it passes.
    const deltaMissingOrExplicitlyUnchanged = isTrivialDelta(codexParsed.delta)   // shares one definition with the Claude side below
    // ======== Flip stability gate: the actual defence against false convergence ========
    // A FRESH FLIP = a change from non-approving to approving RELATIVE TO THE IMMEDIATELY PRECEDING
    // ROUND. Such a round may not declare convergence: the approval must survive one more round of
    // independent review. If the rounds run out while still in a fresh flip -> no convergence,
    // escalate to the user. A last-minute change of heart in the final round is precisely the case a
    // human should look at, so it fails closed.
    // WHY THE PRECEDING ROUND AND NOT THE FROZEN R1: on REJECT -> APPROVE -> APPROVE, R3 always counts
    // as a flip relative to R1, and gating on that would make the panel NEVER able to converge. R3 is
    // not a flip relative to R2, so it can.
    // Honest boundary: this guarantees "the flip held for two rounds", not "the flip was justified" -
    // the panel cannot judge the latter and no longer pretends to.
    // THIS USES === false, NOT !== true, and the comment must describe what the code does rather than
    const codexFreshFlip = codexParsed.approves && prevStanceUsable && prevStance.codex === false
    if (codexParsed.approves && prevStanceUsable && prevStance.codex === null) {
      gate.advisories.push('[ADVISORY] codex had NO valid verdict last round (stance=null) and approves now - not treated as a stance flip, but the absence of a prior trustworthy position is worth a look.')
    }
    // NO EXEMPTION FOR THE LAST ROUND. It was once written as priorRound < roundsAllowed (the final
    // round downgraded to an advisory) on the grounds that "failing to converge in the last round only
    // forces human involvement". That contradicted this gate's own blocker text ("if this was the LAST
    // allowed round, the panel does NOT converge and escalates to the user") and pointed the wrong way:
    const codexFreshFlipHard = codexFreshFlip   // every risk level, no longer high only
    // (There used to be an "warn when not blocked" branch here. Once the hard gate applied at every
    //  risk level that condition was permanently false, i.e. dead code, so it was deleted not commented.)
    if (codexFreshFlipHard) {
      gate.converged = false
      gate.codes.push('FLIP-GATE:codex')
      gate.blockers.push('codex flipped to APPROVE since the immediately-prior round - a fresh flip cannot converge in the same round (fail-closed). If rounds remain, the approval must survive one MORE independent round to count as stable; if this was the LAST allowed round, the panel does NOT converge and escalates to the user instead - a last-round change of heart is exactly what a human should look at.')
      gate.carry.push('codex changed its stance to APPROVE this round. Re-examine independently: if the approval still holds next round it converges; state WHY it held, not merely that it did.')
    }
    if (codexFlippedUp && deltaMissingOrExplicitlyUnchanged) {
      gate.converged = false
      gate.codes.push('DELTA-GATE:codex')
      gate.blockers.push('codex flipped to APPROVE vs its frozen R1 stance AND/OR vs its stance in the immediately-prior round (both are checked) without a DELTA (the field is empty or an explicit non-answer like "unchanged"/"n/a") — possible false convergence, fail-closed. NOTE: the panel only checks the field is FILLED and not an explicit non-answer; whether it contains real new evidence is for the reader to judge.')
      gate.carry.push('codex must FILL IN DELTA (what changed + the new evidence) to justify flipping from its R1 OR immediately-prior-round stance, or hold that position. The panel only mechanically checks the field is non-empty and not an explicit non-answer; the other side must judge whether the content is real.')
    }
    // A4 (independent review, REPRODUCED): the anti-flip gate checked ONLY codex. The Claude side
    // could flip its frozen R1 REJECT to APPROVE with NO DELTA at all and the round still converged
    // (converged=true, reproduced with a probe). "Changing a verdict only because the other side was more
    // confident does NOT count as convergence" has to bind BOTH sides or it binds neither — a one-sided gate
    // just moves the cave-in to the unguarded side. Symmetric, same trivial-DELTA test.
    const claudeR1Valid = (prior.frozen_r1.claude || []).map(r => parseSentinel(r)).filter(p => p.valid)
    const claudeNowValid = priorClaudeRound.auditors.filter(a => a.parsed && a.parsed.valid)
    // Only a KNOWN R1 stance can be flipped: with no parseable frozen R1 claude verdict there is nothing to
    // compare against, and the separate frozen_r1 guards already cover an unusable freeze.
    const claudeR1Approved = claudeR1Valid.length > 0 && claudeR1Valid.every(p => p.approves)
    const claudeNowApproves = claudeNowValid.length > 0 && claudeNowValid.every(a => a.parsed.approves)
    // As above: the half that compares against the immediately preceding round is carried by freshFlip; only the frozen-R1 comparison remains here.
    const claudeFlippedUp = claudeNowApproves &&
      ((claudeR1Valid.length > 0 && !claudeR1Approved) || (prevStanceUsable && prevStance.claude === false))
    // ======== Every auditor voting to approve must endorse THIS round's approval THEMSELVES ========
    // The old rule was side-level (.some: at least one person wrote a DELTA), which left a hole: the
    // one who actually changed their mind could hide behind a colleague's DELTA - A rejected last
    // round, approves this round and writes nothing, B approved both rounds carrying an old DELTA, and
    //
    // WHY NOT PAIR SEAT BY SEAT BY AUDITOR IDENTITY (a design review once rejected that)
    // ⚠️ The reason given then IS NOW VOID - it said "the width returns 1 in R1 and at least 2 in R2+,
    // so the seat set necessarily turns over completely between R1 and R2, and seat-by-seat pairing
    // has nothing to match against at the most important step". The width knob is gone and seats are
    // now fixed, unchanged across three rounds, so seat-by-seat pairing is technically POSSIBLE.
    // The rule is kept anyway, for a different reason: it is stricter (every approver must speak for
    //
    // THE RULE: when a whole side returns from non-approving to approving, EVERY currently valid
    // auditor must supply a non-empty, non-structural-non-answer DELTA - whoever changed their mind
    // says what changed, and whoever did not says "position unchanged, but re-verified this round
    // against X". No cross-round identity needed, no prior_state change, immune to width changes, and
    //
    // THE HONEST LIMIT: this guarantees that every approver spoke, not that what they said is true.
    // Anaphoric filler ("same as above") is not stopped by the structural gate (deliberately - the hard
    // gate judges structure only, to avoid whack-a-mole false rejections) and only raises an advisory.
    const claudeGaveNonEmptyDelta = claudeNowValid.length > 0 &&
      claudeNowValid.every(a => !isTrivialDelta(a.parsed.delta))
    // Symmetric with the codex side. A gate on one side only moves the collapse to the undefended side.
    // Same reasoning as the codex side: null (no trustworthy verdict last round) cannot count as "already approved".
    const claudeFreshFlip = claudeNowApproves && prevStanceUsable && prevStance.claude === false
    if (claudeNowApproves && prevStanceUsable && prevStance.claude === null) {
      gate.advisories.push('[ADVISORY] the claude side had NO valid verdict last round (stance=null) and approves now - not treated as a stance flip.')
    }
    // MUST BE SYMMETRIC with the codex side. An earlier fix removed the last-round exemption on the
    // codex side only and left the collapse in place on the Claude side (measured: high risk, APPROVE
    // -> REJECT -> APPROVE with a non-empty DELTA, converged=true). The comment right here already said
    const claudeFreshFlipHard = claudeFreshFlip   // every risk level, no longer high only
    if (claudeFreshFlipHard) {
      gate.converged = false
      gate.codes.push('FLIP-GATE:claude')
      gate.blockers.push('claude side flipped to APPROVE since the immediately-prior round - a fresh flip cannot converge in the same round (fail-closed). If rounds remain, the approval must survive one MORE independent round to count as stable; if this was the LAST allowed round, the panel does NOT converge and escalates to the user instead - a last-round change of heart is exactly what a human should look at.')
      gate.carry.push('the claude auditor(s) changed stance to APPROVE this round. Re-examine independently next round: state WHY the approval holds, not merely that it does.')
    }
    if (claudeFlippedUp && !claudeGaveNonEmptyDelta) {
      gate.converged = false
      gate.codes.push('DELTA-GATE:claude')
      gate.blockers.push('claude side moved TO approval vs its frozen R1 stance AND/OR vs the immediately-prior round, and at least one CURRENTLY-APPROVING auditor left DELTA empty or wrote an explicit non-answer ("unchanged"/"n/a"). When a side recovers to approval, EVERY approving auditor must underwrite that approval itself — either what changed, or the basis on which it re-verified this round. Otherwise the auditor who actually changed its mind can hide behind a colleague\'s DELTA, which is exactly the "changed only because the other side sounded confident" case the panel refuses. Fail-closed. HONEST LIMIT: the panel only checks each field is filled and is not a structural non-answer — whether the content is real is for the other side and the reader to judge.')
      gate.carry.push('EVERY claude auditor that approves must fill in its OWN DELTA next round: if you changed your verdict, say what changed and on what evidence; if your position did not change, say so AND state the basis on which you re-verified it THIS round (e.g. "position unchanged; re-ran the regression, 462/0, see :1191"). A bare "unchanged" is not enough while the side is moving to approval, and you may not rely on another auditor\'s DELTA.')
    }
  }
  if (gate.converged) {
    log(`Round ${priorRound} CONVERGED (both sides). Done.`)
    return {
      ...resultBase, rounds_run: priorRound, converged: true, advisories: gate.advisories, gate_codes: gate.codes,
      audit_stage: `converged_r${priorRound}`,
      // 🔴 AUDIT panel-self-triage-0819 — a single-seat run used to emit the SAME
      // convergence_status as a dual audit, so `converged`/`terminal_state` were
      // machine-identical and a downstream consumer branching on them drew a stronger
      // conclusion than one reviewer with no cross-examination can support.  The prose
      // said "single seat"; nothing that branches reads prose.
      convergence_status: MODE === 'codex_only' ? 'converged_single_seat' : 'converged',
      demoted_p0: demotedLog,   // findings demoted in earlier rounds: they do not block, but they must reach a human with the terminal
      needs_expert_signoff: false,
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed, codex_in_main_loop: priorRound },
      literature_conflicts: allLit,
      // 🔴 AUDIT panel-self-0818 (P0 #4/#6/#10) — this sentence used to be emitted verbatim for
      // `codex_only` too, a mode that dispatches ZERO Claude seats by design.  The reader was told
      // "both sides cleared" about a round only one side ever saw, and "safe to apply" about code
      // nobody ran.  The mode is deliberate (single-seat review of a simple question); the sentence
      // was not.  What a single seat bought must be stated as what a single seat bought.
      recommended_next_action: MODE === 'codex_only'
        ? 'CONVERGED (SINGLE SEAT): codex reviewed this alone — zero Claude seats were dispatched, so there was no run seat and NO independent second reading. This is one reviewer with no cross-examination; treat it as such, not as a dual audit.'
        : 'CONVERGED: both Claude and Codex sides cleared this round with zero P0 (claims anchored AND code dual-verified where applicable). Safe to pass to the next chain link / apply.',
    }
  }
  // not converged this round -> escalate to next round if budget/rounds allow
  if (priorRound >= roundsAllowed) {
    const needsSignoff = gate.claimGap
    log(`ESCALATE TO USER after round ${priorRound}: ${needsSignoff ? 'claims unanchored' : 'not converged within cap'}`)
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'not_converged',
      demoted_p0: demotedLog,
      needs_expert_signoff: needsSignoff,
      blockers: gate.blockers, advisories: gate.advisories, gate_codes: gate.codes, unresolved_p0: gate.carry,
      // Field renamed unanchored_biology_claims -> unanchored_claims. The old name is kept for one
      // release because the command documentation and existing artefacts still read it - silently
      // renaming a field makes downstream read undefined without an error, which is the failure mode
      unanchored_claims: needsSignoff ? gate.unanchored : [],
      unanchored_biology_claims: needsSignoff ? gate.unanchored : [],
      literature_conflicts: allLit,
      agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed, codex_in_main_loop: priorRound },
      recommended_next_action: needsSignoff
        ? 'THIS NEEDS YOUR EXPERT SIGN-OFF: AI agreed but key claims are not anchored to a decisive cross-validated evidence chain. Review unanchored_claims + literature_conflicts + evidence; AI agreement != truth.'
        : 'NOT converged within cap (see blockers/unresolved_p0). Surface to the user; do NOT pass unverified output down the chain.',
    }
  }
  // continue into the cross-examination round
  openP0s = gate.carry
  // ⚠️ gate.split / gate.p0Count used to be stored into prevSplit / prevP0Count and passed to the next
  // runClaudeRound. Their only reader was the deleted width function ("widen when the sides disagree,
  // or when the previous round raised 3 or more P0s"). With seats fixed nobody reads them, and a knob
  startRound = priorRound + 1
  // P0-2 fix: preserve the TRUE frozen R1 verdicts across ALL rounds (set once at R1, threaded unchanged).
  // Without this, at R3 `shared.claudeR1Raw` would carry R2's verdicts mislabeled as R1.
  let frozenR1
  if (priorRound === 1) {
    frozenR1 = { claude: (prior.claude_verdicts_raw || []), codex: prevCodexRaw }
  } else if (prior.frozen_r1 && Array.isArray(prior.frozen_r1.claude)) {
    frozenR1 = prior.frozen_r1
  } else {
    // P1 hardening (codex re-audit): malformed prior_state at R>=2 without frozen_r1 -> fail-closed.
    // Do NOT silently substitute the immediately-prior round as R1 (that would re-open the P0-2 freeze bug).
    return {
      ...resultBase, rounds_run: priorRound, converged: false,
      audit_stage: 'escalate_to_user', convergence_status: 'not_converged',
      blockers: ['malformed prior_state: round>=2 but frozen_r1 missing/invalid — cannot guarantee R1 freeze, fail-closed'],
      recommended_next_action: 'Re-invoke from a clean prior_state that carries frozen_r1 (the panel always emits it at R2+). Do not hand-edit prior_state.',
    }
  }
  // This round's final side-level stance -> used next round to detect a back-flip.
  // THREE STATES, not a boolean: true = approved / false = explicitly not approved / null = CANNOT BE
  // DECIDED (that side has no valid verdict). Collapsing to two states turns "invalid" into "did not
  // approve", so APPROVE -> (APPROVE but missing EVIDENCE, hence invalid) -> (fixed, still APPROVE,
  // "unchanged" per the contract) is falsely rejected as a back-flip. Reproduced.
  const thisRoundClaudeApproves = (() => {
    const v = priorClaudeRound.auditors.filter(a => a.parsed && a.parsed.valid)
    return v.length === 0 ? null : v.every(a => a.parsed.approves)
  })()
  shared = {
    prevStance: { round: priorRound, claude: thisRoundClaudeApproves, codex: codexParsed.valid ? !!codexParsed.approves : null },
    claudeR1Raw: frozenR1.claude,                 // FROZEN round-1 verdicts (never overwritten)
    codexR1Raw: frozenR1.codex,
    prevRound: priorRound,                          // immediately-prior round (== R1 when starting R2)
    prevClaudeRaw: (prior.claude_verdicts_raw || []),
    prevCodexRaw: prevCodexRaw,
    frozenR1,
  }
  // advisories used to be returned only on the "converged" and "final escalation" paths, so they were
  // lost entirely when freshFlip continued to another round - which is exactly the moment a reader most
  priorConvergenceNote = { round: priorRound, blockers: gate.blockers, advisories: gate.advisories, codes: gate.codes, p0Count: gate.p0Count }
}

// --- STEP B: run ONE Claude-side round (startRound), emit the per-round codex brief, hand off ---
const n = startRound
if (n > roundsAllowed) {
  return { ...resultBase, error: `start round ${n} exceeds rounds_allowed ${roundsAllowed}`, converged: false, audit_stage: 'escalate_to_user' }
}
if (ledger.totalUsed >= HARD_TOTAL_CEILING) {   // P0-3 fail-closed: do NOT open another round / emit another brief over the cap
  return {
    ...resultBase, rounds_run: priorRound, converged: false,
    audit_stage: 'escalate_to_user', convergence_status: 'not_converged',
    // THIS ROUND'S GATE OUTPUT MUST COME ALONG. This path used to replace blockers wholesale with the
    // budget message, so when "a gate fired but the budget happened to run out" the gate's blockers,
    // advisories and codes all vanished and the reader saw only "budget exhausted" without knowing
    // what was actually blocking. Note the scope: gate is not visible here, but priorConvergenceNote
    demoted_p0: demotedLog,
    blockers: [`HARD_TOTAL_CEILING (${HARD_TOTAL_CEILING}) reached — fail-closed, no further rounds`]
      .concat((priorConvergenceNote && priorConvergenceNote.blockers) || []),
    advisories: (priorConvergenceNote && priorConvergenceNote.advisories) || [],
    gate_codes: (priorConvergenceNote && priorConvergenceNote.codes) || [],
    prior_round_note: priorConvergenceNote,
    unresolved_p0: openP0s,
    agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
    recommended_next_action: 'Agent budget ceiling reached (fail-closed). Do NOT spawn more agents or run more codex passes; surface unresolved_p0 + evidence to the user.',
  }
}
// P0 (whole-flow audit): fail-closed if a high-risk R1 has NO real independent source to read —
// running an "independent" Codex audit over an empty allowlist is vacuous and must not be allowed to converge.
// NOT limited to risk:high any more. At normal risk the codex allowlist could be EMPTY, so the "independent"
// R1 read nothing and the round still converged with needs_expert_signoff:false (reproduced).
// An independent round over an empty allowlist is vacuous at ANY risk level.
if (n === 1 && !hasIndependentR1Source) {
  return {
    ...resultBase, rounds_run: 0, converged: false,
    audit_stage: 'escalate_to_user', convergence_status: 'not_converged',
    blockers: ['no independent R1 source: every raw_source/canonical_doc was absent or Claude-generated (provenance-filtered) and the project has no canonical docs — the independent Codex would have nothing real to read, so R1 independence is vacuous (fail-closed)'],
    agent_budget: { total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed },
    recommended_next_action: 'Provide at least one NON-Claude-generated source (absolute path) in contextPack.raw_sources or canonical_docs, or use a known project with canonical docs, or mark needs_expert_signoff. Cannot run a meaningful independent R1 with no real source.',
  }
}
phase(n === 1 ? 'Round 1 (independent)' : `Round ${n} (cross-examine)`)
const claudeRound = await runClaudeRound(n, openP0s, shared)
// 🔴 AUDIT panel-self-0818 (P0 #3/#5/#8) — a finding raised THIS round lived only in
// prior_state.claude_verdicts_raw until the NEXT invocation adjudicated it.  Every terminal
// reached before that (codex unavailable, retry, ceiling) therefore reported unresolved_p0
// from the incoming carry, which at round 1 is empty, and the finding's text was absent from
// every reader-visible field.  Measured: a Claude seat returning a fully-formed blocking
// finding ended as codex_unavailable with the text present ONLY inside prior_state.
// The ledger records what was RAISED; it does not wait for adjudication.  markAbsent=false
// because absence from one round's own verdict list says nothing about earlier entries.
findingsLedger = buildFindingsLedger(n, findingsLedger.length ? findingsLedger : priorLedgerSeed,
  (claudeRound.auditors || []).flatMap(a => (a.parsed && a.parsed.p0) || []), false)
resultBase.findings_ledger = findingsLedger.map(e => (e && typeof e === 'object') ? { ...e } : e)
const codexBrief = (n === 1)
  ? rawSourceBrief()
  : sharedCodexBrief(n, shared, openP0s)

const tag = `${(PROJECT || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_r${n}`
return {
  ...resultBase,
  rounds_run: n,
  audit_stage: n === 1 ? 'r1_independent' : 'cross_examine',
  // Renamed: the old r${n}_pending_codex read as "the second reviewer is absent" when it actually
  // means a handoff, and that misreading happened three times. The driver accepts both names, so old
  convergence_status: `r${n}_handoff_to_codex`,
  converged: false,                 // never converged until the main loop runs codex for THIS round
  codex_independent_r1: n === 1,    // true => the codex brief is raw-source independent (no Claude digest)
  codex_brief: codexBrief,
  codex_brief_tag: tag,
  claude_side: {
    round: n,
    auditor_count: claudeRound.auditors.length,
    any_invalid: claudeRound.auditors.some(a => a.invalid),
    any_null: claudeRound.anyNull,
  },
  // prior_state: pass this back VERBATIM (plus codex_prev_verdict_raw) to advance to the next round
  prior_state: {
    task_fingerprint: TASK_FP,   // binds this state to THIS (project, task, full contextPack, run_id)
    claude_verdicts_count: claudeRound.auditors.length,   // truncation of the array below is then detectable
    run_id: RUN_ID || null,      // pass back UNCHANGED; it is part of the fingerprint
    round: n,
    cumulative_used: ledger.totalUsed,
    claude_verdicts_raw: claudeRound.auditors.map(a => a.raw),
    // ⚠️ A seat's lens string must cross the bridge together with its verdict. R2 REBUILDS the previous
    // claudeRound FROM prior_state, and the rebuild only has the verdict text - role was lost right
    // there, so every downstream "which seat raised this P0" decision failed in R2 (probed: the
    // conditional note never fired once, because every seat's role was undefined).
    // The order corresponds strictly to claude_verdicts_raw. The whole prior_state key is inside the
    claude_roles: claudeRound.auditors.map(a => a.role || ''),
    // frozen R1 carries its own claude_count so a later truncation of the array is detectable
    frozen_r1: shared ? (shared.frozenR1 && Array.isArray(shared.frozenR1.claude)
      ? Object.assign({}, shared.frozenR1, { claude_count: shared.frozenR1.claude.length })
      : shared.frozenR1) : null,
    any_null: claudeRound.anyNull,
    // The immediately preceding round's side-level stance, so the next round can detect a walk-away-and-return back-flip (see the anti-flip gate).
    prev_round_stance: (shared && shared.prevStance) ? shared.prevStance : null,
    // P0s demoted in earlier rounds MUST travel across rounds. Written only into this round's
    // advisories they evaporate the moment this round does not converge, and once a later round does
    demoted_p0_log: demotedLog,
    // Which rounds raised the sequencing note. Same reason as demoted_p0_log: written only into this
    // round's advisories it is absent from the final result in full-run mode, because the driver
    timing_advisory_rounds: timingRounds,
    lit_conflicts: allLit,
    open_p0s: openP0s,                              // surfaced if codex goes unavailable (false-death escalate path)
    findings_ledger: findingsLedger,                // monotonic: an entry is marked, never removed
    advisory_carry: advisoryCarry,                  // one-off advisories, or they die with their round
    // Threaded like demoted_p0_log and timing_advisory_rounds, and for the same reason: written
    // only onto this round's result it survives exactly ONE invocation, and the next round then
    // presents a ledger it cannot prove complete as complete.
    ...(ledgerIncomplete ? { ledger_incomplete: true } : {}),
    last_codex_brief: codexBrief,                   // false-death retry: re-run codex on THIS exact brief, no Claude re-run
    last_codex_brief_tag: tag,
    codex_unavailable_streak: 0,                     // reset: codex DID produce output to reach this round
  },
  prior_round_note: priorConvergenceNote,
  agent_budget: { claude_used: ledger.claudeUsed, codex_deferred: ledger.codexDeferred, total_used: ledger.totalUsed, hard_ceiling: HARD_TOTAL_CEILING, cumulative_in: cumulativeUsed, invalid_results: ledger.invalid },
  recommended_next_action: [
    `ROUND ${n} ${n === 1 ? 'INDEPENDENT' : 'CROSS-EXAMINE'} — Claude side done; codex pending (HYBRID). MAIN-LOOP next:`,
    `1) write codex_brief to a PER-RUN UNIQUE file (avoid clobber by a parallel same-project panel): mkdir -p /tmp/dual-audit ; B=$(mktemp --suffix=.md /tmp/dual-audit/brief_${tag}.XXXXXX) ; echo "$B" — then write codex_brief VERBATIM into THAT exact printed path (readable ${tag} prefix kept; mktemp suffix makes it collision-free). The brief CONTENT is also threaded in prior_state.last_codex_brief, so a false-death re-run just re-writes it to a fresh unique path.`,
    `2) run codex via the wrapper (structurally avoids stdin-hang / skill-preamble / sqlite-lock), using the SAME $B from step 1: ~/bin/codex-audit exec --sandbox read-only --skip-git-repo-check -o "$B.codex.txt" - < "$B" ; echo "EXIT=$?"`,
    `3) CAPTURE the exit code. re-invoke dual-audit-panel with the SAME task args (INCLUDING run_id unchanged \u2014 it is part of the audit fingerprint) PLUS { codex_prev_verdict_raw: <codex output>, codex_exit_code: <the exit code>, prior_state: <the prior_state object above> }`,
    `NOTE on run_id: if you are running TWO panels concurrently whose task+project+contextPack are byte-identical, you MUST give them DIFFERENT run_id values \u2014 that is the only thing that separates their fingerprints. Different tasks/projects/context do not need it.`,
    `IMPORTANT (false-death guard): codex_exit_code is MANDATORY whenever a codex verdict is passed. ABSENT counts as unavailable, and so does ANY value that is not a clean all-zeros string|number ([0] / {} / true / 'EXIT=0' / '0x0' / NaN) — note booleans are primitives but still rejected: only string|number of all zeros counts as 'ok'. A nonzero exit (124 timeout / 137 kill / 99 lock) means codex did NOT produce a trustworthy verdict even if stdout looks complete — the panel will fail-closed and ask you to re-run codex on the SAME brief (not re-run the Claude side), and escalate after ${MAX_CODEX_UNAVAIL} failures. NEVER fabricate a verdict or treat a kill/empty as a pass.`,
    `The panel will evaluate round ${n} convergence (both sides) and either declare converged or open round ${n + 1}. Cap: ${HARD_TOTAL_CEILING} agents across all invocations (fail-closed).`,
    n === 1 ? 'R1 codex brief is RAW-SOURCE INDEPENDENT: it contains NO Claude digest/verdict, only the task + bounded raw-source allowlist.' : 'R2+ codex brief SHARES both sides\' frozen R1 verdicts for cross-examination.',
  ].join('\n'),
}
