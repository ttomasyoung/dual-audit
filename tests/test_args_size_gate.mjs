// Calibration for the driver's handling of oversized / absent arguments.
//
// It evaluates THE REAL DRIVER FILE, wrapped so its top-level `return` and workflow globals
// resolve. Restating the logic here would test the restatement, not the driver.
//
// WHAT IS BEING PROTECTED. An oversized argument object can be dropped WHOLE by the host before the
// driver runs. What surfaces then is not "too big" but "a required field is missing", which sends
// the caller off to ADD arguments — growing the payload that was already the problem. So these
// assertions are about WHICH CAUSE THE MESSAGE NAMES, not about something being refused.
//
// AND THE OTHER DIRECTION, WHICH MATTERS JUST AS MUCH. An earlier version of this patch refused
// anything over 2048 UTF-16 units. It was dropped before release: the size is measured in UTF-16
// units, which equal bytes for Latin text but about one third of them for CJK (measured 2.95x), so
// one threshold meant two different things depending on the caller; and the cliff itself was never
// reproduced by an independent reviewer, nor was its unit established. A refusal like that cannot be
// shown to prevent the failure it names but will certainly block callers who did nothing wrong.
// The large-payload cases below exist to keep it dropped — they FAIL if a hard refusal comes back
// without new measurement behind it.
//
// Assertions match two phrasings on purpose. There are two deployments of this driver and they have
// drifted apart in both directions before. One suite that runs against either is the cheapest
// defence. The non-English alternates are that other deployment's literal message text, which is
// why those lines carry an explicit scanner allowance instead of being reworded away.
import fs from 'node:fs'

// Defaults to the copy in THIS repository; DRIVER overrides it to point at an installed deployment.
const HERE = new URL('.', import.meta.url).pathname
const SRC = process.env.DRIVER || HERE + '../runtime/claude-controller/dual-audit-run.js'
const body = fs.readFileSync(SRC, 'utf8').replace(/^export const meta/m, 'const meta')

const SENTINEL = '__REACHED_PANEL__'
async function run(argsValue) {
  const fn = new Function('args', 'phase', 'log', 'workflow', 'budget',
    `return (async () => {\n${body}\n})()`)
  return fn(argsValue,
    () => {}, () => {},
    async () => { throw new Error(SENTINEL) },
    { total: null, spent: () => 0, remaining: () => Infinity })
}

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  PASS  ' + m) }
const no = (m) => { fail++; console.log('  FAIL  ' + m) }
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

async function check(name, argsValue, assertFn) {
  let r, err = null
  try { r = await run(argsValue) } catch (e) { err = e }
  try { assertFn(r, err); ok(name) } catch (e) { no(`${name} -> ${e.message}`) }
}

const SAYS_SIZE = /failed to parse|too large|整包没解析|太大/  // sanitize-scan:allow  message text from the other deployment, not prose
const SAYS_MISSING_TASK = /^(missing `task`|缺少 task)/  // sanitize-scan:allow  message text from the other deployment, not prose
const SAYS_BRIEF = /brief file|BRIEF\.md/
const SAYS_NO_MORE_ARGS = /Do NOT add more arguments|不要补参数/  // sanitize-scan:allow  message text from the other deployment, not prose
const SAYS_SIZE_NUMBER = /UTF-16 units|字符/  // sanitize-scan:allow  message text from the other deployment, not prose
const SAYS_SOFT = /UTF-16 units \(\d+\+\)|字符（超 \d+）/  // sanitize-scan:allow  message text from the other deployment, not prose

// The driver catches a panel failure and returns INFRASTRUCTURE_BLOCKED, so "reached the panel" is
// evidenced by the sentinel inside `blockers`, not by a throw. The first version of this assertion
// expected a throw and failed two good cases — the assertion was wrong, not the code.
const reachedPanel = (r) => r && Array.isArray(r.blockers)
  && r.blockers.some(b => String(b).includes(SENTINEL))

console.log('=== A payload that never arrived must not be reported as a missing field ===')
await check('args=undefined names size, not a missing field', undefined, (r) => {
  must(r && r.terminal_state === 'INVALID_AUDIT', 'did not return INVALID_AUDIT')
  must(SAYS_SIZE.test(r.error), `error does not name size: ${r.error}`)
  must(!SAYS_MISSING_TASK.test(r.error), 'whole-payload loss was reported as a missing task again')
  must(SAYS_BRIEF.test(r.error), 'does not say to move the material into a brief file')
  must(SAYS_NO_MORE_ARGS.test(r.error), 'does not close off the "add more arguments" path')
})

console.log('=== A genuinely missing task still says so, and carries the measured size ===')
await check('empty object reports a missing task, with size attached', {}, (r) => {
  must(SAYS_MISSING_TASK.test(r.error), `this message should not have been rewritten: ${r.error}`)
  must(SAYS_SIZE_NUMBER.test(r.error), 'the size of this call was not attached')
})

console.log('=== Good input must not be blocked — including input that is merely large ===')
await check('a small payload reaches the panel',
  { task: 'review X', risk: 'low' }, (r) => {
    must(reachedPanel(r), `never reached the panel call: ${JSON.stringify(r)}`)
  })
await check('1.4KB passes and is noted in the trace',
  { task: 'x', pad: 'A'.repeat(1400) }, (r) => {
    must(reachedPanel(r), 'a payload of this size must not be blocked')
    must((r.driver_trace || []).some(t => SAYS_SOFT.test(t)),
      'the advisory note never reached driver_trace')
  })
// These two are the regression guard for the dropped hard refusal. If someone reinstates a limit
// without establishing the unit and reproducing the drop, this is where it shows up.
await check('3KB is NOT refused (the withdrawn 2048 limit must stay withdrawn)',
  { task: 'x', pad: 'A'.repeat(3000) }, (r) => {
    must(reachedPanel(r), `refused a 3KB payload — a hard limit came back: ${JSON.stringify(r)}`)
  })
await check('a large CJK payload is NOT refused either',
  // 2000 CJK characters: ~2000 UTF-16 units but ~6000 bytes. Whichever unit a future limit is
  // written in, this case and the ASCII one above cannot both pass under a 2048 refusal.
  { task: 'x', pad: '审'.repeat(2000) }, (r) => {  // sanitize-scan:allow  CJK filler for a size test, not prose
    must(reachedPanel(r), `refused a large CJK payload: ${JSON.stringify(r)}`)
  })

console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
