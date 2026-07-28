#!/usr/bin/env bash
# Installation, doctor and removal tests. Everything happens inside a throwaway HOME -- which means
# HOME *and* every other variable that can redirect a write out of it: the XDG directories and the
# DUAL_AUDIT_* location overrides. Pinning HOME alone was not enough, and the difference only showed
# up on a machine that had XDG_CONFIG_HOME set.
#
# Exit codes are captured directly from the command under test, never from the tail of a pipe:
# a pipeline reports the LAST command's status, so `install.sh | tail` would report tail's 0 and
# a refusal would silently look like a success.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

T="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-home.XXXXXX")"
trap 'rm -rf "$T"' EXIT
export HOME="$T"
# A throwaway HOME is only throwaway if nothing else points out of it. install.sh honours
# XDG_CONFIG_HOME, XDG_DATA_HOME and the DUAL_AUDIT_* location overrides -- correctly; that is the
# convention -- so on a machine where any of them is set, this suite installed into the REAL
# configuration directory, and the purge test then deleted a real profile. The header above claimed
# this "can never touch the real one", and that claim was false. Reproduced with a single
# `XDG_CONFIG_HOME=/tmp/whatever bash tests/test_install.sh`.
export XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" XDG_STATE_HOME="$T/.local/state"
unset CLAUDE_CONFIG_DIR DUAL_AUDIT_BIN_DIR DUAL_AUDIT_SHARE_DIR DUAL_AUDIT_CONFIG_DIR
# A guard, not a comment. If the pinning above is ever dropped, this stops the run instead of quietly
# writing outside the temporary directory again.
for _v in HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME; do
  case "${!_v}" in "$T"|"$T"/*) ;;
    *) echo "FATAL: $_v=${!_v} points outside the throwaway home $T; refusing to run" >&2; exit 2 ;;
  esac
done
unset _v
export PATH="$T/.local/bin:$PATH"     # doctor treats a missing ~/.local/bin as a real problem
export DUAL_AUDIT_TELEMETRY=""

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS $*"; }
bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected $2, got $1)"; fi; }

BIN="$T/.local/bin"
PANEL="$T/.claude/workflows/dual-audit-panel.js"
RUN="$T/.claude/workflows/dual-audit-run.js"
AGENT="$T/.claude/agents/dual-audit-codex-readonly.md"
SKILL="$T/.claude/skills/dual-audit/SKILL.md"
PROFILE="$T/.config/dual-audit/profile.yaml"
MANIFEST="$T/.local/share/dual-audit/manifest.json"

echo "=== A. Fresh install ==="
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 0 "install.sh succeeds in a clean HOME"
for f in "$PANEL" "$RUN" "$AGENT" "$SKILL" "$BIN/dual-audit" "$BIN/dual-audit-codex" "$BIN/dual-audit-lint" "$PROFILE" "$MANIFEST"; do
  [ -f "$f" ] && ok "installed ${f#$T}" || bad "missing ${f#$T}"
done
[ -x "$BIN/dual-audit-codex" ] && ok "the wrapper is executable" || bad "the wrapper is not executable"

echo "=== B. Placeholders are resolved at install time ==="
if grep -q '__DUAL_AUDIT_PANEL_PATH__\|__DUAL_AUDIT_RUN_PATH__\|__DUAL_AUDIT_PROFILE_PATH__' "$RUN" "$SKILL" 2>/dev/null; then
  bad "an unresolved placeholder remains"
else ok "no unresolved placeholders in the driver or the skill"; fi
grep -q "scriptPath: '$PANEL'" "$RUN" && ok "the driver points at the installed panel by absolute path" \
  || bad "the driver does not reference the installed panel path"
grep -q "$PROFILE" "$SKILL" && ok "the skill points at the user profile" || bad "the skill has no profile path"

echo "=== C. doctor ==="
"$BIN/dual-audit" doctor >/dev/null 2>&1; rc=$?
check "$rc" 0 "doctor passes on a fresh install"

echo "=== C2. The routing table is reachable ==="
# The skill routes on `routing.*`, but a user profile inherits that table from its base and does not
# repeat it — so reading the profile file alone shows no routing keys, which reads as "there are no
# triggers" rather than "they live one level up". `profile show` cannot fill the gap either: it
# prints what is compiled into the panel, and routing deliberately is not.
out="$("$BIN/dual-audit" profile routing 2>&1)"; rc=$?
check "$rc" 0 "dual-audit profile routing succeeds"
printf '%s' "$out" | grep -q 'full_audit_triggers' && ok "it prints the inherited routing table" \
  || bad "the merged routing table is not reachable"
grep -q 'routing' "$PROFILE" && ok "(the user profile does mention routing, in a comment)" \
  || ok "the user profile itself carries no routing block — which is why the command exists"

echo "=== D. A changed profile is reported as stale, not silently ignored ==="
python3 - "$PROFILE" <<'EDIT'
import sys
p = sys.argv[1]
s = open(p).read().replace(
    'critical_areas: []',
    'critical_areas:\n  - name: "Release"\n    keywords: ["deploy", "release"]\n    route: full',
    1)
open(p, 'w').write(s)
EDIT
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails while the compiled profile is out of date"
printf '%s' "$out" | grep -q 'PROFILE_STALE' && ok "doctor names the problem PROFILE_STALE" || bad "doctor did not report PROFILE_STALE"

"$BIN/dual-audit" profile apply >/dev/null 2>&1; rc=$?
check "$rc" 0 "profile apply recompiles"
"$BIN/dual-audit" doctor >/dev/null 2>&1; rc=$?
check "$rc" 0 "doctor passes again after apply"
grep -q '"Release"' "$PANEL" 2>/dev/null && bad "routing data leaked into the panel (only projects and the brief note belong there)" \
  || ok "routing stays with the controller; only panel-relevant fields are compiled in"

echo "=== E. A malformed profile fails loudly ==="
cp "$PROFILE" "$T/profile.good"
printf 'projects:\n  - id: "x"\n\tdocs: "tab indented"\n' >> "$PROFILE"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor rejects a profile indented with a tab"
printf '%s' "$out" | grep -qi 'tab' && ok "the error names the tab" || bad "the error does not explain the problem"
cp "$T/profile.good" "$PROFILE"

echo "=== F. Re-install refuses to overwrite a modified file ==="
before="$(sha256sum "$AGENT" | cut -d' ' -f1)"
echo "a local edit" >> "$AGENT"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "install.sh refuses when a package file was modified"
printf '%s' "$out" | grep -q 'modified since' && ok "it says WHICH file and why" || bad "the refusal does not identify the file"
grep -q 'a local edit' "$AGENT" && ok "the modified file was left untouched" || bad "the modified file was overwritten anyway"

echo "=== G. --force backs up before replacing ==="
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
check "$rc" 0 "install.sh --force proceeds"
[ -f "$AGENT.bak-dual-audit" ] && ok "the previous version was backed up" || bad "no backup was made"
after="$(sha256sum "$AGENT" | cut -d' ' -f1)"
[ "$after" = "$before" ] && ok "the package version was restored" || bad "the file does not match the package version"

echo "=== H. A file we do not own is never touched ==="
echo "not ours" > "$T/.claude/workflows/someone-elses.js"
"$REPO/install.sh" >/dev/null 2>&1
grep -q 'not ours' "$T/.claude/workflows/someone-elses.js" && ok "an unrelated file in the same directory is untouched" \
  || bad "an unrelated file was modified"

echo "=== H2. The manifest is not truncated without being examined ==="
"$REPO/uninstall.sh" >/dev/null 2>&1
mkdir -p "$(dirname "$MANIFEST")"
echo "someone else's data" > "$MANIFEST"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "install.sh refuses when the manifest path holds a file it did not write"
grep -q "someone else's data" "$MANIFEST" && ok "that file was left intact" || bad "the unexamined file was destroyed"
rm -f "$MANIFEST"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== H3. Hostile paths and dangling symlinks ==="
# A DANGLING symlink makes [ -e ] false, so an -e-first guard would skip the check entirely and the
# redirection would follow the link and create its target.
"$REPO/uninstall.sh" >/dev/null 2>&1
mkdir -p "$(dirname "$MANIFEST")"
ln -sfn "$T/victim-manifest" "$MANIFEST"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "install.sh refuses a DANGLING symlink at the manifest path"
[ ! -e "$T/victim-manifest" ] && ok "the symlink target was not created" || bad "the write followed a dangling symlink"
rm -f "$MANIFEST"

# A home directory containing a quote would corrupt the single-quoted path literal in the driver.
# The installer must either survive it or fail loudly — never report success with a broken driver.
T2="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit home'quote.XXXXXX")"
out="$(HOME="$T2" "$REPO/install.sh" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  if HOME="$T2" node -e '
    const fs=require("fs");
    const AF=Object.getPrototypeOf(async function(){}).constructor;
    const src=fs.readFileSync(process.argv[1],"utf8").replace("export const meta","const meta");
    new AF("args","agent","parallel","log","phase","budget","workflow",src);
  ' "$T2/.claude/workflows/dual-audit-run.js" 2>/dev/null; then
    ok "a path containing a quote installs and the driver still parses"
  else
    bad "install reported success but the driver does not parse"
  fi
else
  ok "a path containing a quote is refused loudly rather than installed broken"
fi
rm -rf "$T2"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== H4. A dangling symlink at an ORDINARY destination ==="
# Same class as H3, at a different code path. The conflict scan used to test -e before -L, so a
# DANGLING symlink (where -e is false) was skipped entirely: it never entered the conflict list, no
# refusal was printed, and the cp further down followed the link and created its target.
"$REPO/uninstall.sh" >/dev/null 2>&1
mkdir -p "$(dirname "$AGENT")"
ln -sfn "$T/victim-agent" "$AGENT"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "install.sh refuses a DANGLING symlink at an ordinary destination"
[ ! -e "$T/victim-agent" ] && ok "the symlink target was not created" || bad "the write followed a dangling symlink"
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
check "$rc" 1 "--force does not override the symlink refusal either"
[ ! -e "$T/victim-agent" ] && ok "--force still did not create the target" || bad "--force wrote through a dangling symlink"
rm -f "$AGENT"

echo "=== H5. --force never overwrites a file this package did not write ==="
# --force means "discard MY OWN edits to files you installed". It must not mean "destroy whatever
# happens to sit at that path" — on a machine that also runs a private copy of the same tool, those
# paths hold the live private installation.
echo "a stranger's file" > "$AGENT"
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
check "$rc" 1 "install.sh --force refuses a destination it does not own"
grep -q "a stranger's file" "$AGENT" && ok "the unowned file is intact after --force" || bad "--force destroyed an unowned file"
printf '%s' "$out" | grep -q 'not ours to replace' && ok "the refusal explains that --force does not apply" || bad "the refusal does not explain itself"
rm -f "$AGENT"

echo "=== H6. --force does not truncate a foreign manifest either ==="
mkdir -p "$(dirname "$MANIFEST")"
echo "someone else's data" > "$MANIFEST"
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
check "$rc" 1 "install.sh --force refuses a foreign file at the manifest path"
grep -q "someone else's data" "$MANIFEST" && ok "the foreign manifest is intact after --force" || bad "--force truncated an unexamined file"
rm -f "$MANIFEST"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== H7. The 'mutable' panel is verified, not exempted ==="
# `profile apply` rewrites the generated block, so the panel's whole-file hash legitimately changes.
# Exempting it from verification entirely meant doctor reported "unmodified" without looking, and
# uninstall deleted it however much had been changed. Only the block is exempt; the rest is checked.
echo "// an edit outside the generated block" >> "$PANEL"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when the panel is edited outside the generated block"
printf '%s' "$out" | grep -q 'outside the generated profile block' && ok "doctor names what changed" || bad "doctor does not say what changed"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
[ -f "$PANEL" ] && ok "uninstall KEEPS a panel that was edited outside the block" || bad "uninstall deleted an edited panel"
rm -f "$PANEL"
"$REPO/install.sh" >/dev/null 2>&1
"$BIN/dual-audit" doctor >/dev/null 2>&1; rc=$?
check "$rc" 0 "doctor passes again on a clean reinstall"

echo "=== H8. An unreadable manifest fails loudly, and destroys nothing ==="
# The manifest is the only record of what belongs to this package. Both commands used to swallow a
# parse failure: doctor's integrity check redirected stderr, so an empty result read as "no
# findings" and it reported every file present and unmodified without having looked at one; and
# uninstall read the entries through a process substitution, which hides the exit status, then
# deleted the manifest and exited 0. "I cannot tell" must not come out as "all clear".
cp "$MANIFEST" "$T/manifest.good"
echo '{ this is not valid json' > "$MANIFEST"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails on an unreadable manifest"
printf '%s' "$out" | grep -q 'unreadable or malformed' && ok "doctor says the manifest is the problem" || bad "doctor did not name the manifest"
printf '%s' "$out" | grep -q 'all installed files present' && bad "doctor still claimed the files were verified" \
  || ok "doctor does NOT claim the files were verified"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
check "$rc" 1 "uninstall fails on an unreadable manifest"
[ -f "$MANIFEST" ] && ok "the unreadable manifest is left in place" || bad "uninstall deleted the manifest it could not read"
[ -f "$PANEL" ] && ok "nothing was removed" || bad "files were removed without a readable manifest"
cp "$T/manifest.good" "$MANIFEST"

echo "=== H9. An installed file replaced by a symlink is a finding ==="
# existsSync and readFileSync both follow links, so a package file swapped for a link to something
# else reported as present, and — if the link resolved to identical bytes — unmodified.
mv "$AGENT" "$T/agent.real"
ln -s "$T/agent.real" "$AGENT"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when an installed file is a symlink"
printf '%s' "$out" | grep -q 'not a regular file' && ok "doctor says it is not a regular file" || bad "doctor did not report the symlink"
rm -f "$AGENT"; mv "$T/agent.real" "$AGENT"
"$BIN/dual-audit" doctor >/dev/null 2>&1; rc=$?
check "$rc" 0 "doctor passes again once the real file is back"

echo "=== H10. The manifest cannot claim a file this package does not install ==="
# The manifest is a file, and a file can say anything. Trusting the paths inside it made the
# ownership record self-certifying: a stale or hand-written manifest could name any file on the
# machine and have it verified as ours — or deleted. The allowed set is computed from code.
echo "not yours to delete" > "$T/outside.txt"
node -e '
  const fs=require("fs"), crypto=require("crypto");
  const p=process.argv[1], victim=process.argv[2];
  const m=JSON.parse(fs.readFileSync(p,"utf8"));
  m.files.push({path:victim, sha256:crypto.createHash("sha256").update(fs.readFileSync(victim)).digest("hex"), mutable:false});
  fs.writeFileSync(p, JSON.stringify(m,null,2));
' "$MANIFEST" "$T/outside.txt"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor rejects a manifest claiming a path outside the install set"
printf '%s' "$out" | grep -q 'does not install' && ok "doctor names the foreign claim" || bad "doctor did not name the foreign claim"
out="$("$REPO/uninstall.sh" 2>&1)"
[ -f "$T/outside.txt" ] && ok "uninstall does NOT delete a file the manifest merely claims" \
  || bad "uninstall deleted a file outside the install set"
printf '%s' "$out" | grep -q 'does not install' && ok "it says the manifest named paths it ignored" \
  || bad "the ignored entries are not reported"
rm -f "$T/outside.txt"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== H11. An existing backup is never overwritten ==="
# The FIRST backup holds the pristine original. Overwriting it on a second --force would replace it
# with the copy this installer wrote last time, destroying the thing the flag promises to preserve.
echo "the pristine original" > "$AGENT.bak-dual-audit"
echo "a local edit" >> "$AGENT"
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
check "$rc" 1 "install.sh --force refuses when a backup already exists"
[ "$(cat "$AGENT.bak-dual-audit")" = "the pristine original" ] && ok "the earlier backup is intact" \
  || bad "the earlier backup was overwritten"
rm -f "$AGENT.bak-dual-audit"
"$REPO/install.sh" --force >/dev/null 2>&1

echo "=== H12. A dangling symlink at the profile destination ==="
"$REPO/uninstall.sh" >/dev/null 2>&1
rm -f "$PROFILE"
mkdir -p "$(dirname "$PROFILE")"
ln -sfn "$T/victim-profile" "$PROFILE"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "install.sh refuses a symlinked profile destination"
[ ! -e "$T/victim-profile" ] && ok "the symlink target was not created" || bad "the profile was written through the link"
rm -f "$PROFILE"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== H13. A manifest cannot confer ownership on a file we never wrote ==="
# The deepest version of the ownership question. A manifest is a side file that anything can write,
# so letting it answer "is this ours" made ownership self-certifying: a hand-written, shape-valid
# manifest naming a planned destination and its CURRENT hash made the installer treat a stranger's
# file as its own untouched copy — and overwrite it silently, without --force, reporting success.
# Ownership is now decided by a marker INSIDE the file being replaced, which no manifest can confer.
forge_home() { # forge_home -> prints a HOME whose manifest falsely claims the panel destination
  local h; h="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-forge.XXXXXX")"
  local v="$h/.claude/workflows/dual-audit-panel.js"
  mkdir -p "$(dirname "$v")" "$h/.local/share/dual-audit"
  printf 'SOMEONE ELSE FILE\n' > "$v"
  printf '{ "package": "dual-audit", "version": "0.1.0", "files": [ {"path": "%s", "sha256": "%s", "mutable": false} ] }\n' \
    "$v" "$(sha256sum "$v" | cut -d' ' -f1)" > "$h/.local/share/dual-audit/manifest.json"
  echo "$h"
}
for flags in "" "--force"; do
  fh="$(forge_home)"
  out="$(HOME="$fh" PATH="$fh/.local/bin:$PATH" "$REPO/install.sh" $flags 2>&1)"; rc=$?
  label="${flags:-no flag}"
  check "$rc" 1 "a forged manifest is refused ($label)"
  grep -q 'SOMEONE ELSE FILE' "$fh/.claude/workflows/dual-audit-panel.js" \
    && ok "the foreign file is intact ($label)" || bad "the foreign file was overwritten ($label)"
  printf '%s' "$out" | grep -q 'ownership marker' && ok "the refusal names the missing marker ($label)" \
    || bad "the refusal does not explain itself ($label)"
  rm -rf "$fh"
done
# And the marker must not reject our own files, or the check above proves only that it rejects
# everything.
grep -q 'dual-audit:package-file' "$PANEL" && ok "an installed file does carry the marker" \
  || bad "our own installed file has no marker — the check would refuse every upgrade"

# The package field is the second layer, and it carries on its own where the marker cannot help:
# uninstall reads the manifest to decide what to REMOVE, so a manifest that does not name this
# package must not be acted on at all.
"$REPO/install.sh" >/dev/null 2>&1
node -e '
  const fs=require("fs"); const p=process.argv[1];
  const m=JSON.parse(fs.readFileSync(p,"utf8")); delete m.package;
  fs.writeFileSync(p, JSON.stringify(m,null,2));
' "$MANIFEST"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
check "$rc" 1 "uninstall refuses a manifest that does not name this package"
[ -f "$PANEL" ] && ok "nothing was removed on that refusal" || bad "files were removed from an unattributed manifest"
# Reinstalling does NOT repair an unrecognised manifest, and should not: the installer cannot tell a
# damaged manifest of ours from somebody else's data sitting at that path, and it truncates that
# file. Refusing is the fail-closed answer; the documented recovery is to move it aside.
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 1 "reinstalling does not truncate an unrecognised manifest"
printf '%s' "$out" | grep -q 'Move it aside' && ok "it says to move the file aside" || bad "the refusal is unclear"
# Recovery: move the unrecognised manifest away and reinstall. This must NOT need --force — the
# installed files are untouched, so the installer has nothing to overwrite but their own contents.
rm -f "$MANIFEST"
out="$("$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 0 "reinstalling after removing the manifest works without --force"

echo "=== H14. Removal also asks the file, not the manifest ==="
# The manifest passes every structural check here — it names this package and only paths this
# package installs — and it records the CORRECT hash of the file sitting at that path. All of that
# is satisfiable by whoever wrote the manifest. Only the file itself can say it came from us, and
# uninstall deletes things, so it has to ask.
"$REPO/install.sh" >/dev/null 2>&1
printf 'NOT OURS — no ownership marker\n' > "$PANEL"
node -e '
  const fs=require("fs"), crypto=require("crypto");
  const p=process.argv[1], target=process.argv[2];
  const m=JSON.parse(fs.readFileSync(p,"utf8"));
  const e=m.files.find(f=>f.path===target);
  e.sha256=crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  delete e.mutable;
  fs.writeFileSync(p, JSON.stringify(m,null,2));
' "$MANIFEST" "$PANEL"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when an installed path holds a file without the marker"
printf '%s' "$out" | grep -q 'ownership marker' && ok "doctor names the missing marker" \
  || bad "doctor accepted a foreign file because the manifest hash matched"

out="$("$REPO/uninstall.sh" 2>&1)"
grep -q 'NOT OURS' "$PANEL" && ok "a file whose hash the manifest matches is still KEPT without the marker" \
  || bad "uninstall deleted a foreign file on the manifest's word alone"
printf '%s' "$out" | grep -q 'not a path this package installs\|KEPT' && ok "it reports keeping it" || bad "the decision is not reported"
rm -f "$PANEL" "$MANIFEST"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== I. The bypass linter accepts our own installed tree ==="
"$BIN/dual-audit-lint" >/dev/null 2>&1; rc=$?
check "$rc" 0 "dual-audit-lint reports no bypass in the installed agents and skills"

echo "=== K. doctor cannot report a pass it did not earn ==="
# Every case here produced "all installed files present; every byte outside the generated profile
# block still matches the manifest" and exit 0 before it was fixed. A checker whose green light
# survives the thing it checks being removed is worse than no checker: it is a false assurance
# printed in the same words as a real one.
cp "$MANIFEST" "$T/manifest.keep"
cp "$PANEL" "$T/panel.keep"
"$BIN/dual-audit" doctor >/dev/null 2>&1
check "$?" 0 "the good case still passes, so the cases below are not passing for the wrong reason"

# K1 — an emptied file list used to mean an empty findings list, which read as "nothing wrong".
node -e 'const f=process.argv[1],m=require(f);m.files=[];require("fs").writeFileSync(f,JSON.stringify(m))' "$MANIFEST"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when the manifest claims none of the installed files"
printf '%s' "$out" | grep -q 'does not cover' && ok "it names the uncovered file" || bad "the uncovered file is not named"
cp "$T/manifest.keep" "$MANIFEST"

# K2 — a malformed entry crashed the checker; with its stderr discarded, the crash was indistinguishable
# from a clean run with nothing to report.
node -e 'const f=process.argv[1],m=require(f);m.files.push(null);require("fs").writeFileSync(f,JSON.stringify(m))' "$MANIFEST"
"$BIN/dual-audit" doctor >/dev/null 2>&1
check "$?" 1 "doctor fails on a malformed manifest entry rather than reading the crash as silence"
cp "$T/manifest.keep" "$MANIFEST"

# K3 — with no panel_path the staleness check was skipped without a word, in the situation where the
# compiled profile is least likely to be trustworthy.
node -e 'const f=process.argv[1],m=require(f);delete m.panel_path;require("fs").writeFileSync(f,JSON.stringify(m))' "$MANIFEST"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when it cannot locate the panel at all"
printf '%s' "$out" | grep -q 'could not be checked' && ok "it says the check did not happen" || bad "the skipped check is not reported"
cp "$T/manifest.keep" "$MANIFEST"

# K4 — the whole point of recording base_sha256: a decoy start marker above the real block widens the
# span the hash ignores, leaving the base hash unchanged while injected code runs inside the panel.
node -e '
  const fs=require("fs"), lib=require(process.argv[2]);
  const p=process.argv[1], s=fs.readFileSync(p,"utf8"), i=s.indexOf(lib.MARK_START);
  fs.writeFileSync(p, s.slice(0,i) + lib.MARK_START + "\nglobalThis.__INJECTED__=1\n" + s.slice(i));
' "$PANEL" "$T/.local/share/dual-audit/lib/profile.js"
out="$("$BIN/dual-audit" doctor 2>&1)"; rc=$?
check "$rc" 1 "doctor fails when code is injected into the panel behind a decoy marker"
printf '%s' "$out" | grep -q 'modified outside the generated profile block' && ok "it names the panel as modified" || bad "the injected panel is not reported"
cp "$T/panel.keep" "$PANEL"
"$BIN/dual-audit" doctor >/dev/null 2>&1
check "$?" 0 "doctor passes again once everything is restored"

echo "=== L. A manifest cannot steer the removal at a file it never classified ==="
# The classifier runs in node and its answer used to reach bash as newline-separated, tab-delimited
# text — a format the DATA could split. A manifest path containing a newline arrived as two records,
# the first with no state at all, and the `case` reading them had no default branch: the empty state
# fell through to `rm -f`. That deleted a path which had never been classified, bypassing the
# installTargets check, the ownership marker and the hash in one step.
VICTIM_DIR="$T/not-ours"; mkdir -p "$VICTIM_DIR"
echo "a file that has nothing to do with this package" > "$VICTIM_DIR/important.txt"
node -e '
  const f=process.argv[1], victim=process.argv[2], m=require(f);
  m.files.push({ path: victim + "\n/nonexistent/tail", sha256: "0", mutable: false });
  require("fs").writeFileSync(f, JSON.stringify(m));
' "$MANIFEST" "$VICTIM_DIR/important.txt"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
[ -f "$VICTIM_DIR/important.txt" ] && ok "a path smuggled in through a newline is not deleted" \
  || bad "an unclassified path was deleted"
printf '%s' "$out" | grep -q 'does not install' && ok "it is counted among the entries that were ignored" \
  || bad "the smuggled entry is not reported as ignored"
# The path itself is deliberately NOT echoed. It is never examined either: what gets removed comes
# from the installed-file list in the code, so a path only the manifest knows about is not something
# this run has an opinion about — it is something this run never looks at.
check "$rc" 0 "the removal still completes"
rm -rf "$VICTIM_DIR"
"$REPO/install.sh" >/dev/null 2>&1

# The same attack wearing the delimiter that replaced the newline. A filesystem path cannot hold a
# NUL, but a path in a JSON manifest can — "\u0000" is a legal escape and the manifest is data, not
# a path. Such a string closes its own record and opens another, so one entry could carry
# "<harmless>NULmatchNUL/some/victim" and have the reader delete something nothing classified.
echo "another file that has nothing to do with this package" > "$T/victim2.txt"
node -e '
  const fs=require("fs"); const [p, victim] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.files.push({ path: "X\u0000match\u0000" + victim, sha256: "0", mutable: false });
  fs.writeFileSync(p, JSON.stringify(m));
' "$MANIFEST" "$T/victim2.txt"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
[ -f "$T/victim2.txt" ] && ok "a record forged with a NUL inside a manifest path is not acted on" \
  || bad "a forged record deleted a path nothing had classified"
check "$rc" 0 "the removal still completes after refusing a forged record"
rm -f "$T/victim2.txt"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== L2. A backup that could not be written stops the replacement ==="
# `cp -p` had no `|| fail`, and `set -e` is not in effect, so a failed backup did not stop the very
# next line from replacing the file. --force reported success having destroyed the edits it promises
# to preserve. A read-only directory holding a writable file reproduces it exactly: the backup needs
# to CREATE a file (refused), while overwriting the existing one does not.
# The leftover backup from an earlier section has to go first: the pre-flight refuses to overwrite an
# existing backup, and that refusal would make this section pass without the backup write ever being
# reached — a green light for a guard that is not there. The message assertion pins the reason too.
rm -f "$BIN/dual-audit-lint.bak-dual-audit"
echo "an edit worth keeping" >> "$BIN/dual-audit-lint"
cp "$BIN/dual-audit-lint" "$T/edited.keep"
chmod 555 "$BIN"
out="$("$REPO/install.sh" --force 2>&1)"; rc=$?
chmod 755 "$BIN"
check "$rc" 1 "install refuses when the backup cannot be written"
printf '%s' "$out" | grep -q 'could not back up' && ok "it fails for that reason, not another one" \
  || bad "the failure is not attributed to the backup"
cmp -s "$BIN/dual-audit-lint" "$T/edited.keep" && ok "the edited file is left exactly as it was" \
  || bad "the edited file was replaced even though its backup failed"
rm -f "$BIN/dual-audit-lint.bak-dual-audit"
"$REPO/install.sh" --force >/dev/null 2>&1
rm -f "$BIN/dual-audit-lint.bak-dual-audit"

echo "=== L3. The install layout has one definition ==="
# The panel and driver destinations were also written out by hand near the top of install.sh, so
# moving a file in `installTargets` left them pointing at the old path and the driver shipped with a
# scriptPath nothing installs. Both are now read back out of the same plan.
grep -q 'PANEL_DST="\$CLAUDE_DIR' "$REPO/install.sh" && bad "the panel destination is spelled out a second time" \
  || ok "the panel destination is not spelled out a second time"
grep -q "scriptPath: '$PANEL'" "$RUN" && ok "the driver still points at the installed panel" \
  || bad "the driver no longer points at the installed panel"

echo "=== J. Uninstall ==="
echo "user edit" >> "$BIN/dual-audit-lint"
out="$("$REPO/uninstall.sh" 2>&1)"; rc=$?
check "$rc" 0 "uninstall.sh succeeds"
[ -f "$BIN/dual-audit-lint" ] && ok "a file modified after installation is KEPT" || bad "a modified file was deleted"
# The record of a kept file has to outlive the removal, or nothing can tell that file apart from one
# of the user's own afterwards: doctor could not check it, and a second run reported "nothing to do"
# while it sat on disk.
[ -f "$MANIFEST" ] && ok "the manifest is kept while any file it describes is still installed" \
  || bad "the manifest was deleted while a file it describes is still installed"
printf '%s' "$out" | grep -q 'has been kept' && ok "it says why the manifest was left behind" \
  || bad "keeping the manifest is not explained"
printf '%s' "$out" | grep -q 'KEPT' && ok "it reports what it kept" || bad "kept files are not reported"
[ ! -f "$PANEL" ] && ok "the panel was removed" || bad "the panel was left behind"
[ ! -f "$RUN" ] && ok "the driver was removed" || bad "the driver was left behind"
# (Whether the manifest survives is asserted above, and depends on whether any of OUR files are
# still installed. It is removed only when nothing it describes is left — a manifest that outlives
# every file it names is litter, and one that dies before them takes their identity with it.)
[ -f "$PROFILE" ] && ok "your profile survives an ordinary uninstall" || bad "the profile was deleted without being asked"
grep -q 'not ours' "$T/.claude/workflows/someone-elses.js" && ok "the unrelated file still survives" || bad "the unrelated file was removed"

echo "=== J2. --purge-profile is bounded ==="
# This is the only recursive delete in the package, and its target comes from an environment
# variable, so it must prove the target IS a profile directory before running. Both halves are
# asserted: a guard that refuses everything would pass the first check and prove nothing.
# J left a deliberately-modified file behind with no manifest to vouch for it, so a plain reinstall
# would (correctly) refuse it. Clear it first: this section is about the purge guard, not that one.
rm -f "$BIN/dual-audit-lint"
"$REPO/install.sh" >/dev/null 2>&1 || bad "setup: reinstall before the purge tests failed"
DECOY="$T/not-a-profile-dir"
mkdir -p "$DECOY"; echo "valuable" > "$DECOY/important.txt"
out="$(DUAL_AUDIT_CONFIG_DIR="$DECOY" "$REPO/uninstall.sh" --purge-profile 2>&1)"
[ -f "$DECOY/important.txt" ] && ok "--purge-profile refuses a directory holding no profile.yaml" \
  || bad "--purge-profile recursively deleted an unrelated directory"
printf '%s' "$out" | grep -q 'refusing to purge' && ok "the refusal says why" || bad "the refusal is silent"

# "It holds a file called profile.yaml" is not the same question as "it is OUR profile directory",
# and only the second licenses a recursive delete. Any directory on the machine can satisfy the
# first — reproduced by pointing the variable at an unrelated directory that happened to contain
# one, and watching everything else in it go with it.
# The check above ran a full removal, which took the manifest with it. Without reinstalling, the run
# below would exit at "no manifest — nothing to do" and never reach the purge guard at all: the
# directory would survive for the wrong reason and the assertion would pass having tested nothing.
"$REPO/install.sh" >/dev/null 2>&1 || bad "setup: reinstall before the second purge test failed"
DECOY2="$T/foreign-profile-dir"
mkdir -p "$DECOY2"; printf 'version: 1\n' > "$DECOY2/profile.yaml"; echo "valuable" > "$DECOY2/important.txt"
out="$(DUAL_AUDIT_CONFIG_DIR="$DECOY2" "$REPO/uninstall.sh" --purge-profile 2>&1)"
[ -f "$DECOY2/important.txt" ] && ok "--purge-profile refuses a profile.yaml this package did not write" \
  || bad "--purge-profile deleted a directory whose profile.yaml was not ours"
printf '%s' "$out" | grep -q 'ownership marker' && ok "the refusal names the missing marker" \
  || bad "the refusal does not explain which check failed"
rm -rf "$DECOY2"

# The marker check above proves the FILE is ours. It cannot prove the DIRECTORY is, because the
# installer PLANTS that marker: it mkdir -p's whatever CONFIG_DIR names, existing or not, and copies
# a template whose first line carries the marker into it. Point the variable at a directory holding
# your own configuration and the package seeds its own authorisation there. Reproduced before the
# fix: an entire config directory recursively deleted, exit 0.
OWNDIR="$T/my-own-config"; mkdir -p "$OWNDIR/nvim"
echo "my editor config" > "$OWNDIR/nvim/init.lua"
echo "another application" > "$OWNDIR/other-app.conf"
DUAL_AUDIT_CONFIG_DIR="$OWNDIR" "$REPO/install.sh" >/dev/null 2>&1
grep -q 'dual-audit:package-file' "$OWNDIR/profile.yaml" 2>/dev/null \
  && ok "setup: the installer did plant its marker in a directory it did not create" \
  || bad "setup: no profile was installed, so this proves nothing"
out="$(DUAL_AUDIT_CONFIG_DIR="$OWNDIR" "$REPO/uninstall.sh" --purge-profile 2>&1)"
[ -f "$OWNDIR/nvim/init.lua" ] && [ -f "$OWNDIR/other-app.conf" ] \
  && ok "--purge-profile leaves everything that is not the profile" \
  || bad "--purge-profile deleted files it did not install"
[ ! -f "$OWNDIR/profile.yaml" ] && ok "it does remove the profile itself" || bad "the profile was not removed"
rm -rf "$OWNDIR"

# A single trailing slash defeated BOTH symlink guards at once: `[ -L "x/" ]` is false for a link to
# a directory, and `find "x/" -maxdepth 1 -type l` searches the TARGET rather than the link. The
# recursive delete then followed the link and emptied the directory it pointed at.
REALDIR="$T/real-dotfiles"; mkdir -p "$REALDIR"
echo "a file worth keeping" > "$REALDIR/notes.txt"
LINKDIR="$T/linked-config"; ln -sfn "$REALDIR" "$LINKDIR"
DUAL_AUDIT_CONFIG_DIR="$LINKDIR/" "$REPO/install.sh" >/dev/null 2>&1
DUAL_AUDIT_CONFIG_DIR="$LINKDIR/" "$REPO/uninstall.sh" --purge-profile >/dev/null 2>&1
[ -f "$REALDIR/notes.txt" ] && ok "a trailing slash cannot make the purge reach through a symlink" \
  || bad "the purge followed a symlink and deleted the target's contents"
rm -rf "$REALDIR"; rm -f "$LINKDIR"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== J3. The record outlives the files it describes ==="
# The library that computes "what this package installs" is itself one of the installed files, so a
# check that consults it AFTER the removal asks a question the run has already destroyed the answer
# to. That made an ordinary two-run sequence delete the manifest run one had deliberately kept: run
# one keeps an edited panel and removes the library, run two can no longer see what is ours.
# It takes TWO runs to show, which is why one run looked fine: run one keeps the edited panel and
# removes the library as an ordinary match, and only run two finds the library gone.
echo "// an edit of my own" >> "$PANEL"
"$REPO/uninstall.sh" >/dev/null 2>&1
[ -f "$PANEL" ] && ok "run one keeps the edited panel" || bad "run one deleted the edited panel"
[ -f "$MANIFEST" ] && ok "run one keeps the manifest that identifies it" \
  || bad "run one deleted the manifest while the file it describes is still installed"
[ ! -f "$T/.local/share/dual-audit/lib/profile.js" ] \
  && ok "run one removed the library, which is what run two then cannot read" \
  || bad "setup: the library is still there, so run two proves nothing"

"$REPO/uninstall.sh" >/dev/null 2>&1
[ -f "$PANEL" ] && ok "run two still keeps the edited panel" || bad "run two deleted the edited panel"
[ -f "$MANIFEST" ] && ok "run two does not destroy the record run one deliberately preserved" \
  || bad "run two deleted the manifest while the panel it describes is still installed"

rm -f "$PANEL" "$MANIFEST"
"$REPO/install.sh" >/dev/null 2>&1

"$REPO/install.sh" >/dev/null 2>&1
[ -f "$PROFILE" ] || bad "setup: no profile to purge"
"$REPO/uninstall.sh" --purge-profile >/dev/null 2>&1
[ ! -f "$PROFILE" ] && ok "--purge-profile does remove a real profile when explicitly asked" \
  || bad "--purge-profile did not remove the profile it is for"

echo "=== M. A delimiter character in an install directory does not collapse destinations ==="
# `rel` and `mode` come from this package, but `dst` is built from directories the caller names in
# the environment, and a path may hold any byte but NUL and '/'. While the plan was '|'-joined, a
# '|' in one of those directories truncated the destination at that character and handed the rest to
# the mode: four different source files were written to the SAME truncated path, each overwriting
# the last, and the run still reported success.
MSHARE="$T/sh|re"
out="$(DUAL_AUDIT_SHARE_DIR="$MSHARE" "$REPO/install.sh" 2>&1)"; rc=$?
check "$rc" 0 "install.sh succeeds with a '|' in the share directory"
mcount=0
for f in "$MSHARE/lib/profile.js" "$MSHARE/profiles/default.yaml" \
         "$MSHARE/profiles/research.yaml" "$MSHARE/profiles/user.example.yaml"; do
  [ -f "$f" ] && mcount=$((mcount+1))
done
check "$mcount" 4 "all four share-directory files land at their own full path"
[ -e "$T/sh" ] && bad "a truncated destination was created at ${T#$T}/sh" \
  || ok "nothing was written to the path truncated at the delimiter"
out="$(DUAL_AUDIT_SHARE_DIR="$MSHARE" "$REPO/uninstall.sh" 2>&1)"; rc=$?
check "$rc" 0 "uninstall.sh succeeds with the same directory"
[ -e "$MSHARE/lib/profile.js" ] && bad "removal left the library behind" \
  || ok "removal reaches the same paths the installer wrote"
rm -rf "$MSHARE"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== N. The list of paths to remove is computed once, not twice ==="
# It was derived twice — once into $TARGETS before anything is removed, and again inside the
# classifier — and the only thing comparing the two was their LENGTH. Two same-length lists of
# different paths therefore passed: the run deleted the second set while deciding "nothing of ours
# is left" from the first, and then removed the manifest identifying the files still on disk.
LIB="$T/.local/share/dual-audit/lib/profile.js"
cp "$LIB" "$T/real-profile.js"
COUNTER="$T/installTargets.calls"; rm -f "$COUNTER"
cat > "$LIB" <<EOF
// dual-audit:package-file (test stub — counts how many processes ask for the install list)
const real = require('$T/real-profile.js');
module.exports = Object.assign({}, real, {
  installTargets(o) {
    const fs = require('fs');
    let n = 0; try { n = parseInt(fs.readFileSync('$COUNTER', 'utf8'), 10) || 0 } catch (e) {}
    fs.writeFileSync('$COUNTER', String(n + 1));
    if (n >= 1) throw new Error('installTargets was consulted a second time');
    return real.installTargets(o);
  },
});
EOF
"$REPO/uninstall.sh" >/dev/null 2>&1; rc=$?
check "$rc" 0 "uninstall.sh completes when the install list may be asked for only once"
check "$(cat "$COUNTER" 2>/dev/null || echo 0)" 1 "it asked exactly once"
# The stub IS one of the installed files, so it is correctly kept as modified — and the manifest
# with it. What proves the run reached its work is that every other file went.
[ -e "$PANEL" ] && bad "the removal did not reach the panel" || ok "the removal reached its work"
[ -f "$LIB" ] && ok "the edited library itself is kept, as any edited file is" \
  || bad "the removal deleted a file that no longer matches its hash"
cp "$T/real-profile.js" "$LIB"
"$REPO/install.sh" >/dev/null 2>&1

echo "=== O. An empty installed-file list is refused, not treated as 'nothing to do' ==="
# Everything downstream is driven by that list, INCLUDING the check that decides whether the
# manifest may be deleted. An empty list sails through the count comparison, finds no leftovers
# because it looked at nothing, and destroys the record of files that are all still installed.
cp "$LIB" "$T/real-profile2.js"
cat > "$LIB" <<EOF
// dual-audit:package-file (test stub — reports that this package installs nothing)
const real = require('$T/real-profile2.js');
module.exports = Object.assign({}, real, { installTargets() { return [] } });
EOF
"$REPO/uninstall.sh" >/dev/null 2>&1; rc=$?
check "$rc" 1 "uninstall.sh refuses an empty installed-file list"
[ -f "$MANIFEST" ] && ok "the manifest is left in place" \
  || bad "the manifest was deleted while every file it describes is still installed"
[ -f "$PANEL" ] && ok "the files it describes are indeed still there" || bad "setup: the panel is gone"
cp "$T/real-profile2.js" "$LIB"

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
