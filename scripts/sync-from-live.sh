#!/usr/bin/env bash
# Copy the panel that actually runs on this machine back into the repository, and FORCE the compiled
# machine-local PROFILE back to the shipped empty value.
#
# 🔴 Why this must be a script and not "remember to edit it back":
#    The first time the live panel was copied in, runtime/core carried the compiled local PROFILE with
#    it — project names and absolute home paths — into a repository that has a public remote. Nothing
#    errors when that happens. A step that only a human remembers gets skipped eventually, and the
#    time it gets skipped is the time nobody notices.
#
# 🔴 Why the leak check delegates to sanitize-scan.sh instead of grepping here:
#    This script used to carry its own pattern list. It was strictly weaker than the scanner sitting
#    next to it in the same directory, and it scanned exactly ONE file — so it never read itself, and
#    it never read the rest of the tree. Measured on the same tree at the same moment: this gate
#    printed "clean" and exited 0 while scripts/sanitize-scan.sh exited 1, and one of the findings was
#    an absolute home path in this very file's own comment header. A gate whose stated job is "block
#    the commit if anything local leaked" returned a green light on a tree that was leaking.
#    There is exactly one scanner. This calls it. Do not reintroduce a second pattern list here:
#    two scanners means two answers, and the weaker one is the one that says yes.
#
# Usage: bash scripts/sync-from-live.sh [--check]
#   --check  only verify that the current tree is clean; do not sync (use before committing)

set -Eeuo pipefail

LIVE="${DUAL_AUDIT_LIVE_PANEL:-$HOME/.claude/workflows/dual-audit-panel.js}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="$REPO/runtime/core/dual-audit-panel.js"
SCANNER="$REPO/scripts/sanitize-scan.sh"
# Shipped PROFILE: no projects, customized=false. Matches what profiles/default.yaml compiles to.
SHIPPED='const PROFILE = {"version":1,"name":"default","customized":false,"projects":[],"evidence":{"brief_note":""},"profile_sha256":null}'

# The ownership marker install.sh and doctor look for on every file this package installs. The live
# panel does NOT carry it and must not: the marker means "this file was installed by the package",
# and the live copy is the hand-maintained upstream. Without the marker install.sh refuses to
# overwrite it, which is the correct protection for a working file.
#
# 🔴 So a plain `cp` strips it from the repository copy, and that is not cosmetic: 50 assertions in
#    tests/test_install.sh fail, doctor exits 127, and the failure reads "our own installed file has
#    no marker - the check would refuse every upgrade". Restore it here, on the derived copy only.
#    This is also why "byte-identical except the PROFILE line" was the wrong goal: the repository
#    copy is a DERIVED artefact, not a mirror. It differs by the PROFILE block and by this line.
PKG_MARK_LINE='// dual-audit:package-file (installed by dual-audit; ownership marker — do not remove)'

restore_pkg_mark() {
  # Fail loudly if the marker string in install.sh ever changes: a silently stale copy here would
  # reintroduce exactly the failure this function exists to prevent.
  local want; want="$(sed -n "s/^PKG_MARK='\(.*\)'/\1/p" "$REPO/install.sh" | head -1)"
  [ -n "$want" ] || { echo "  ✗ could not read PKG_MARK from install.sh"; return 1; }
  case "$PKG_MARK_LINE" in
    *"$want"*) : ;;
    *) echo "  ✗ PKG_MARK_LINE here does not contain install.sh's PKG_MARK ('$want') - update this script"; return 1 ;;
  esac
  if ! head -1 "$1" | grep -qF "$want"; then
    printf '%s\n' "$PKG_MARK_LINE" | cat - "$1" > "$1.tmp" && mv "$1.tmp" "$1"
    echo "  ownership marker restored (the live copy does not carry it, by design)"
  fi
}

reset_profile() {
  python3 - "$1" "$SHIPPED" <<'PY'
import re, sys
path, shipped = sys.argv[1], sys.argv[2]
t = open(path, encoding='utf-8').read()
pat = r'(>>> DUAL-AUDIT PROFILE[^\n]*>>>\n)const PROFILE = .*?\n(// <<< END DUAL-AUDIT PROFILE <<<)'
m = re.search(pat, t, re.S)
if not m:
    sys.exit("PROFILE marker block not found - the panel's structure changed. Update this script "
             "before syncing again; do not let it pass silently.")
open(path, 'w', encoding='utf-8').write(t[:m.start()] + m.group(1) + shipped + "\n" + m.group(2) + t[m.end():])
print("  PROFILE reset to the shipped empty value")
PY
}

# The one leak check. Whole tree, every rule, no local pattern list.
#   sanitize-scan.sh: 0 = clean, 1 = findings, 2 = could not run.
# Exit 2 is treated as failure on purpose: a scanner that cannot run has not said the tree is clean.
leak_scan() {
  [ -x "$SCANNER" ] || { echo "  ✗ scanner not found or not executable: $SCANNER"; return 1; }
  local rc=0
  "$SCANNER" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) echo "  ✗ sanitize-scan.sh reported findings (listed above)"
       # The commit-identity check is opt-in by design and CI approves it explicitly; a run without
       # that variable exported reports it as a finding, which is correct but easy to misread as a
       # content leak. Say which one it is instead of leaving the reader to guess.
       if [ -z "${DUAL_AUDIT_ALLOW_GIT_IDENTITY:-}" ]; then
         echo "    NOTE: if the only finding is [git-identity], export DUAL_AUDIT_ALLOW_GIT_IDENTITY"
         echo "          with the approved identity - .github/workflows/ci.yml sets exactly that."
       fi
       return 1 ;;
    *) echo "  ✗ sanitize-scan.sh could not run (exit $rc) - that is not a clean result"; return 1 ;;
  esac
}

if [ "${1:-}" = "--check" ]; then
  echo "Checking the working tree with $SCANNER ..."
  if leak_scan; then echo "  ✅ clean"; exit 0; else echo "  ✗ local content present - do not commit"; exit 1; fi
fi

[ -f "$LIVE" ] || { echo "live panel not found: $LIVE"; exit 2; }
echo "Syncing $LIVE -> $DST"
cp "$LIVE" "$DST"
restore_pkg_mark "$DST"
reset_profile "$DST"
node --check "$DST" || { echo "  ✗ syntax check failed after sync"; exit 1; }
if leak_scan; then
  echo "  ✅ clean"
else
  echo "  ✗ still not clean after the PROFILE reset - the leak is NOT in the PROFILE block."
  echo "    Find it by hand. Do not work around this check."
  exit 1
fi
echo "Sync complete. Now run tests/run-all.sh - it runs seven suites, not three."
