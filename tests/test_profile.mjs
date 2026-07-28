// Tests for the profile parser, validator and compiler.
//
// The parser accepts a deliberately small YAML subset. The point of these tests is not that it
// parses valid input — it is that every unsupported construct fails LOUDLY. A profile parser that
// quietly misreads a list as a string, or silently drops a duplicated key, turns a user's routing
// rules into something they never wrote and gives them false confidence.
//
// Run: node tests/test_profile.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const P = require(resolve(HERE, '../runtime/core/profile.js'))

const TMP = mkdtempSync(resolve(tmpdir(), 'dual-audit-profile-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })

let pass = 0, fail = 0
const ok = (c, name, why) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${name}${c ? '' : '  << ' + why}`) }

const parse = (text) => P.parseYamlSubset(text, 'test.yaml')
const throws = (text, re) => {
  try { parse(text); return null } catch (e) { return re.test(e.message) ? true : e.message }
}
const write = (name, text) => { const f = resolve(TMP, name); writeFileSync(f, text); return f }

console.log('=== A. The supported subset parses correctly ===')

const doc = parse(`
version: 1
customized: true
base: research
critical_areas:
  - name: "Release"
    keywords: ["deploy", "release", "cut a tag"]
    route: full
  - name: Numbers
    keywords:
      - headline figure
      - final table
    route: light
projects:
  - id: my-service
    docs: "/srv/docs/contract.md"
evidence:
  brief_note: "anchor it"
empty_list: []
`)
ok(doc.version === 1 && doc.customized === true && doc.base === 'research', 'scalars, booleans and integers', JSON.stringify(doc).slice(0, 120))
ok(Array.isArray(doc.critical_areas) && doc.critical_areas.length === 2, 'a list of maps', JSON.stringify(doc.critical_areas))
ok(Array.isArray(doc.critical_areas[0].keywords) && doc.critical_areas[0].keywords.length === 3 &&
   doc.critical_areas[0].keywords[2] === 'cut a tag', 'a flow list, including a quoted item with a space',
   JSON.stringify(doc.critical_areas[0].keywords))
ok(Array.isArray(doc.critical_areas[1].keywords) && doc.critical_areas[1].keywords[0] === 'headline figure',
   'a block list of scalars', JSON.stringify(doc.critical_areas[1].keywords))
ok(doc.evidence.brief_note === 'anchor it', 'a nested map', JSON.stringify(doc.evidence))
ok(Array.isArray(doc.empty_list) && doc.empty_list.length === 0, 'an empty flow list', JSON.stringify(doc.empty_list))

ok(parse('a: "value # not a comment"  # this is one').a === 'value # not a comment',
   'a "#" inside a quoted string is not a comment', JSON.stringify(parse('a: "value # not a comment"  # this is one')))
ok(parse('# only a comment\nb: 2').b === 2, 'full-line comments and blank lines are skipped', '')

console.log('=== B. Unsupported or ambiguous input fails LOUDLY ===')

ok(throws('a:\n\tb: 1', /tab/i) === true, 'a tab used for indentation is refused', throws('a:\n\tb: 1', /tab/i))

// A flow list used to drop empty items, so `[a, , b]` and `[a, b, ]` both came back with a length
// the author never wrote. Handing back a shorter list than the one on the page is precisely the
// quiet misreading this parser exists to prevent, however harmless the individual case looks.
ok(throws('a: [x, , y]', /empty item/i) === true, 'a gap in a flow list is refused rather than dropped',
   throws('a: [x, , y]', /empty item/i))
ok(throws('a: [x, y, ]', /empty item/i) === true, 'a trailing comma in a flow list is refused rather than dropped',
   throws('a: [x, y, ]', /empty item/i))
// The good example must still parse, or the two assertions above would be satisfied by a parser
// that simply rejects every flow list.
ok(JSON.stringify(parse('a: [x, y]').a) === '["x","y"]', 'an ordinary flow list is unaffected',
   JSON.stringify(parse('a: [x, y]').a))

// The compiled profile is embedded in the panel as a JavaScript object LITERAL, where `"__proto__":`
// sets the prototype instead of adding a property. On a plain object the key also vanished at parse
// time with no error at all, so the profile that reached the panel was not the profile that was
// validated — in either direction, silently.
ok(throws('__proto__:\n  x: 1', /__proto__/) === true, 'a "__proto__" key is refused rather than silently dropped',
   throws('__proto__:\n  x: 1', /__proto__/))
ok(throws('a: 1\na: 2', /duplicate key/i) === true, 'a duplicated key is refused, never silently last-wins',
   throws('a: 1\na: 2', /duplicate key/i))
ok(throws('a: |\n  multi\n  line', /unsupported YAML syntax/i) === true, 'a block scalar is refused rather than misread',
   throws('a: |\n  multi\n  line', /unsupported YAML syntax/i))
ok(throws('a: &anchor x', /unsupported YAML syntax/i) === true, 'an anchor is refused', throws('a: &anchor x', /unsupported/i))
ok(throws('a: [1, 2', /unterminated flow list/i) === true, 'an unterminated flow list is refused', throws('a: [1, 2', /unterminated/i))
// A value that opens with a quote and never closes it used to fall through to the plain-scalar
// branch and become the string `"abc`. That is a fail-open with a real consequence: a project
// whose `docs` is a non-empty string satisfies the high-risk anchor requirement, so an audit could
// converge while the independent reviewer had nothing readable to read.
ok(throws('docs: "abc', /unterminated quoted string/i) === true, 'a value opening with a quote must close with it',
   throws('docs: "abc', /unterminated/i))
ok(throws("docs: 'abc", /unterminated quoted string/i) === true, 'the same applies to single quotes',
   throws("docs: 'abc", /unterminated/i))
// `"/x\"` ENDS with a quote character, but that quote is escaped, so the value is still
// unterminated. Accepting it would return a silently truncated path that passes every later check.
ok(throws('docs: "/x\\"', /unterminated quoted string/i) === true,
   'a closing quote that is itself escaped does not terminate the string',
   throws('docs: "/x\\"', /unterminated/i))
ok(parse('docs: "/x\\\\"').docs === '/x\\',
   'an escaped BACKSLASH followed by a real closing quote is still valid', JSON.stringify(parse('docs: "/x\\\\"')))
ok(throws('a: 1\n---\nb: 2', /multiple YAML documents/i) === true,
   'a second document is refused rather than silently merged', throws('a: 1\n---\nb: 2', /multiple/i))
ok(throws('a: [[1], 2]', /nested flow/i) === true, 'a nested flow collection is refused', throws('a: [[1], 2]', /nested/i))
ok(throws('not a mapping line', /expected "key: value"/) === true, 'a line that is neither a key nor a list item is refused',
   throws('not a mapping line', /expected/))

console.log('=== C. Schema validation ===')

const v = (o) => P.validate(o, 'test.yaml')
ok(v({ version: 2 }).errors.some(e => /version/.test(e)), 'the wrong version is an error', '')
ok(v({ version: 1, customized: 'yes' }).errors.some(e => /customized/.test(e)), '"customized" must be a boolean, not the string yes', '')
ok(v({ version: 1, base: 'whatever' }).errors.some(e => /base/.test(e)), 'an unknown base profile is an error', '')
ok(v({ version: 1, critical_areas: [{ name: 'x', keywords: [] }] }).errors.some(e => /non-empty/.test(e)),
   'an area with no keywords is an error (it could never match)', '')
ok(v({ version: 1, critical_areas: [{ name: 'x', keywords: ['*'] }] }).errors.some(e => /matches everything/.test(e)),
   'the keyword "*" is an error, because it would route everything to a full audit', '')
ok(v({ version: 1, critical_areas: [{ name: 'x', keywords: ['ab'] }] }).warnings.some(w => /very short/.test(w)),
   'a two-character keyword is a warning about over-matching', '')
ok(v({ version: 1, critical_areas: [{ name: 'x', keywords: ['deploy'], route: 'panel' }] }).errors.some(e => /route/.test(e)),
   'an unknown route value is an error', '')
ok(v({ version: 1, projects: [{ id: 'A' }, { id: 'a' }] }).errors.some(e => /duplicate project id/.test(e)),
   'two project ids differing only in case collide, because matching is case-insensitive', '')
ok(v({ version: 1, projects: [{ id: 'a' }] }).warnings.some(w => /no "docs" pointer/.test(w)),
   'a project with no docs pointer is a warning: a high-risk audit still needs an anchor the reviewer can read', '')
// `docs` is what satisfies the high-risk anchor requirement, so prose with no path in it is an
// ERROR, not a warning: the reviewer runs from a neutral directory where it would resolve to
// nothing, and a reviewer that silently read nothing still returns a confident verdict.
ok(v({ version: 1, projects: [{ id: 'a', docs: 'see the internal wiki' }] }).errors.some(e => /no absolute path/.test(e)),
   'a docs pointer with no absolute path is an error', JSON.stringify(v({ version: 1, projects: [{ id: 'a', docs: 'see the wiki' }] }).errors))
ok(v({ version: 1, projects: [{ id: 'a', docs: 'Read these: /srv/docs/contract.md' }] }).errors.length === 0,
   'a docs pointer containing an absolute path is accepted', '')
ok(v({ version: 1, evidence: { brief_note: 5 } }).errors.some(e => /brief_note/.test(e)), 'a non-string brief note is an error', '')
ok(v({ version: 1, critical_areas: [{ name: 'x', keywords: ['deploy'], route: 'full' }], projects: [] }).errors.length === 0,
   'a well-formed profile produces no errors', JSON.stringify(v({ version: 1, critical_areas: [{ name: 'x', keywords: ['deploy'], route: 'full' }] }).errors))

console.log('=== D. Compilation ===')

const baseDir = TMP
write('default.yaml', 'version: 1\nname: default\nevidence:\n  brief_note: ""\n')
write('research.yaml', 'version: 1\nname: research\nevidence:\n  brief_note: "ANCHOR EVERYTHING"\n')

const userPlain = write('u1.yaml', 'version: 1\nbase: default\ncustomized: false\nprojects: []\nevidence:\n  brief_note: ""\n')
const c1 = P.compile(userPlain, baseDir).profile
ok(c1.evidence.brief_note === '', 'the default base contributes no extra brief text', JSON.stringify(c1.evidence))
ok(/^[0-9a-f]{64}$/.test(c1.profile_sha256), 'the compiled profile records a hash of its source', c1.profile_sha256)
ok(c1.customized === false, 'customized is carried through', String(c1.customized))

const userResearch = write('u2.yaml', 'version: 1\nbase: research\ncustomized: true\nevidence:\n  brief_note: ""\n')
const c2 = P.compile(userResearch, baseDir).profile
ok(c2.evidence.brief_note === 'ANCHOR EVERYTHING', 'the research base contributes its evidence note', JSON.stringify(c2.evidence))
ok(c2.name === 'research', 'the chosen base is recorded', c2.name)

const userOwn = write('u3.yaml', 'version: 1\nbase: research\nevidence:\n  brief_note: "MY OWN NOTE"\n')
ok(P.compile(userOwn, baseDir).profile.evidence.brief_note === 'MY OWN NOTE', "the user's own note overrides the base", '')

const userProj = write('u4.yaml', 'version: 1\nprojects:\n  - id: svc\n    rules: "conclusions"\n    docs: "/a/b.md"\ncritical_areas:\n  - name: R\n    keywords: ["deploy"]\n')
const c4 = P.compile(userProj, baseDir).profile
ok(c4.projects.length === 1 && c4.projects[0].rules === 'conclusions' && c4.projects[0].docs === '/a/b.md',
   'projects are compiled with rules and docs kept separate', JSON.stringify(c4.projects))
ok(!('critical_areas' in c4) && !('routing' in c4),
   'routing data is NOT compiled into the panel — the controller owns routing, the panel owns review',
   JSON.stringify(Object.keys(c4)))

console.log('=== E. Writing the block into an installed panel ===')

const panelFile = write('panel.js', `const a = 1
${P.MARK_START}
const PROFILE = {"version":1,"projects":[],"profile_sha256":null}
${P.MARK_END}
const b = 2
`)
P.writeIntoPanel(panelFile, c4)
const after = readFileSync(panelFile, 'utf8')
ok(after.startsWith('const a = 1\n') && after.trimEnd().endsWith('const b = 2'),
   'code outside the markers is preserved exactly', after.slice(0, 40))
ok(after.includes('"id":"svc"'), 'the new profile is present inside the block', '')
ok((after.match(/const PROFILE = /g) || []).length === 1, 'exactly one PROFILE declaration remains', '')
ok(P.installedSha(panelFile) === c4.profile_sha256, 'the installed hash can be read back for staleness checks', String(P.installedSha(panelFile)))

const noMarkers = write('panel-bad.js', 'const a = 1\n')
let threw = false
try { P.writeIntoPanel(noMarkers, c4) } catch (e) { threw = /generated profile block/.test(e.message) }
ok(threw === true, 'a panel without the markers is refused rather than silently appended to', String(threw))

// ---- The exempt span must be UNIQUE, not merely "the first pair of markers" ----------------
// Locating the block with indexOf alone takes the FIRST start and the FIRST end. A decoy start
// placed above the real block widens the exempt span to swallow everything between them. Because
// every byte before the decoy is untouched, the base hash does not move: the panel verified clean
// while injected code sat inside the widened span. Reproduced against a real installation before
// this was fixed — 156 injected bytes, identical base hash, `dual-audit doctor` exit 0.
const goodPanel = write('panel-span-ok.js', `const a = 1\n${P.MARK_START}\nconst PROFILE = {}\n${P.MARK_END}\nconst b = 2\n`)
const baseGood = P.baseSha(goodPanel)
const decoyPanel = write('panel-span-decoy.js',
  `const a = 1\n${P.MARK_START}\nglobalThis.__INJECTED__ = 1\n${P.MARK_START}\nconst PROFILE = {}\n${P.MARK_END}\nconst b = 2\n`)
ok(P.baseSha(decoyPanel) !== baseGood,
   'a second, earlier start marker cannot widen the span the base hash ignores', P.baseSha(decoyPanel).slice(0, 12))

const dupEndPanel = write('panel-span-dupend.js',
  `const a = 1\n${P.MARK_START}\nconst PROFILE = {}\n${P.MARK_END}\nglobalThis.__INJECTED__ = 1\n${P.MARK_END}\nconst b = 2\n`)
ok(P.baseSha(dupEndPanel) !== baseGood,
   'a second end marker cannot widen the span the base hash ignores', P.baseSha(dupEndPanel).slice(0, 12))

// The good example must still be exempted, or the check above would "pass" by verifying nothing.
const goodRewritten = write('panel-span-ok2.js', `const a = 1\n${P.MARK_START}\nconst PROFILE = {"different":true}\n${P.MARK_END}\nconst b = 2\n`)
ok(P.baseSha(goodRewritten) === baseGood,
   'rewriting only the generated block still leaves the base hash unchanged', P.baseSha(goodRewritten).slice(0, 12))

let dupThrew = false
try { P.writeIntoPanel(decoyPanel, c4) } catch (e) { dupThrew = /generated profile block/.test(e.message) }
ok(dupThrew === true, 'a panel with duplicated markers is refused rather than spliced on a guess', String(dupThrew))

console.log('=== F. A docs anchor must actually anchor something ===')

// `docs` is what satisfies the high-risk anchor requirement. "Starts with a slash" is not the same
// as "names something": a path built entirely from "/", "." and ".." resolves to a directory that
// holds no evidence, so accepting one clears the anchor gate with nothing behind it — the same
// fail-open as an unreadable path, spelled differently.
const docsProfile = (p) => `version: 1\nname: t\ncustomized: true\nprojects:\n  - id: x\n    docs: "${p}"\n`
for (const bad of ['//', '/..', '/../..', '/.']) {
  const r = P.validate(P.parseYamlSubset(docsProfile(bad)))
  ok(r.errors.some(e => /degenerate/.test(e)),
     `a docs value of ${JSON.stringify(bad)} is refused as degenerate`, JSON.stringify(r.errors))
}
// The good case must still pass, or the check above proves only that the validator says no to
// everything.
ok(P.validate(P.parseYamlSubset(docsProfile('/etc/hostname'))).errors.length === 0,
   'an ordinary absolute path is still accepted', '')

// Lexically fine, useless in practice. Only the filesystem can tell these apart, and the panel has
// no filesystem — so this layer is the last one that can see it.
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: '/dev/null' }] }).some(s => /not a regular file/.test(s)),
   'a docs path that exists but yields nothing (/dev/null) is reported', '')
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: '/no/such/path/here' }] }).some(s => /does not exist/.test(s)),
   'a docs path that is not there is reported', '')
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: '/etc/hostname' }] }).length === 0,
   'a real file produces no finding', '')

// stat() answers "is something there", not "can the reviewer read it" — it succeeds on a mode-000
// file, because it needs permission on the parent directory and none on the file. Checking only the
// type therefore admitted the exact anchors this layer exists to reject: present, yielding nothing,
// and counted by the high-risk anchor gate as satisfied.
const emptyFile = write('anchor-empty.md', '')
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: emptyFile }] }).some(s => /empty file/.test(s)),
   'a docs path that is an empty file is reported', '')

const emptyDir = resolve(TMP, 'anchor-empty-dir')
mkdirSync(emptyDir, { recursive: true })
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: emptyDir }] }).some(s => /empty directory/.test(s)),
   'a docs path that is an empty directory is reported', '')

const filledDir = resolve(TMP, 'anchor-filled-dir')
mkdirSync(filledDir, { recursive: true })
writeFileSync(resolve(filledDir, 'note.md'), 'something to read\n')
ok(P.docsFsIssues({ projects: [{ id: 'x', docs: filledDir }] }).length === 0,
   'a directory with something in it produces no finding', '')

// Skipped when running as root, where the permission bits do not apply and the check would be
// asserting something untrue about the environment rather than about the code.
if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  const unreadable = write('anchor-unreadable.md', 'secret\n')
  chmodSync(unreadable, 0o000)
  ok(P.docsFsIssues({ projects: [{ id: 'x', docs: unreadable }] }).some(s => /not readable/.test(s)),
     'a docs path that exists but cannot be read is reported', '')
  chmodSync(unreadable, 0o644)
} else {
  ok(true, 'a docs path that exists but cannot be read is reported (skipped: running as root)', '')
}

// baseSha must ignore the generated block and NOTHING else, or "mutable" silently becomes
// "unverifiable" for the whole file.
const bs1 = write('base1.js', `const a = 1\n${P.MARK_START}\nconst PROFILE = {"v":1}\n${P.MARK_END}\nconst b = 2\n`)
const bs2 = write('base2.js', `const a = 1\n${P.MARK_START}\nconst PROFILE = {"v":2,"x":"different"}\n${P.MARK_END}\nconst b = 2\n`)
const bs3 = write('base3.js', `const a = 1\n${P.MARK_START}\nconst PROFILE = {"v":1}\n${P.MARK_END}\nconst b = 999\n`)
ok(P.baseSha(bs1) === P.baseSha(bs2), 'a rewritten profile block does not change the base hash', '')
ok(P.baseSha(bs1) !== P.baseSha(bs3), 'a change OUTSIDE the block does change the base hash', '')

console.log(`\n=== RESULT: ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
