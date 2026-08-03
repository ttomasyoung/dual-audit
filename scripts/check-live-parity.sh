#!/usr/bin/env bash
# Compare this package's files against a separately deployed build of the same components, and run the
# regression suites against BOTH.
#
# WHY THIS EXISTS: the two copies are not a mirror — one is derived from the other and deliberately
# renames things — so `diff` is useless and nobody ran it. With nothing comparing them, they drifted in
# BOTH directions at once and neither side noticed: a whole terminal-state classification layer existed
# only here, while a budget guard that stops a review being killed into silence existed only there. Each
# was found by accident, months apart. A test suite that can only reach the copy sitting next to it is
# half a test, and a sync script that only carries one of four files is a quarter of a sync.
#
# WHAT IT CHECKS
#   1. Symbol parity: every function and top-level constant, after normalising the known renames, must
#      exist on both sides. This is what catches "an entire layer was never ported" — the failure that
#      prompted this script — and it needs no hand-maintained list of what to look for.
#   2. Behaviour: the panel, driver and wrapper suites are run against the OTHER build too, using the
#      override variables those suites accept.
#
# Usage:
#   bash scripts/check-live-parity.sh
#   LIVE_PANEL=... LIVE_DRIVER=... LIVE_WRAPPER=... LIVE_ENVP=... LIVE_RC=... bash scripts/check-live-parity.sh
#
# Exit: 0 = the two builds agree, 1 = they diverge (details printed), 2 = a file is missing.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LIVE_PANEL="${LIVE_PANEL:-$HOME/.claude/workflows/dual-audit-panel.js}"
LIVE_DRIVER="${LIVE_DRIVER:-$HOME/.claude/workflows/dual-audit-run.js}"
LIVE_WRAPPER="${LIVE_WRAPPER:-$HOME/bin/codex-audit}"
# The environment-variable prefix and exit-code marker the other build uses. These are the renames the
# normalisation below has to undo before the two sides can be compared at all.
LIVE_ENVP="${LIVE_ENVP:-CODEX_AUDIT}"
LIVE_RC="${LIVE_RC:-CODEX_RC}"

PKG_PANEL="$REPO/runtime/core/dual-audit-panel.js"
PKG_DRIVER="$REPO/runtime/claude-controller/dual-audit-run.js"
PKG_WRAPPER="$REPO/runtime/codex-auditor/dual-audit-codex"

fail=0
missing=0
for f in "$LIVE_PANEL" "$LIVE_DRIVER" "$LIVE_WRAPPER" "$PKG_PANEL" "$PKG_DRIVER" "$PKG_WRAPPER"; do
  [ -f "$f" ] || { echo "  MISSING $f"; missing=1; }
done
[ "$missing" = 0 ] || { echo "check-live-parity: a file under comparison does not exist; nothing was checked"; exit 2; }

# Undo the deliberate renames so that only REAL differences survive. Anything added here is a claim
# that a difference is intentional, so keep the list short and specific — a loose rule would erase
# exactly the divergence this script is meant to surface.
norm() {
  sed -e "s/${LIVE_ENVP}_/DUAL_AUDIT_/g" \
      -e "s/__${LIVE_RC}/__DUAL_AUDIT_RC/g" \
      -e 's/codex-audit-readonly/dual-audit-codex-readonly/g' \
      -e 's/dual-audit-codex/WRAPPERNAME/g' -e 's/codex-audit/WRAPPERNAME/g' "$1"
}

# Function and top-level constant names. Deliberately NOT a hand-written list of things to look for:
# the layer that went missing was one nobody thought to look for.
syms() {
  norm "$1" | grep -oE '^[[:space:]]*(function[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|const[[:space:]]+[A-Z_][A-Z0-9_]*|[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{)' \
    | sed -E 's/^[[:space:]]*//; s/^function[[:space:]]+//; s/^const[[:space:]]+//; s/\(\)[[:space:]]*\{$//' \
    | sort -u
}

# Differences that are known and accepted. Every entry needs a REASON, and every entry is printed on
# each run: an allowlist nobody reads becomes the place divergence goes to hide, which is the failure
# this whole script exists to prevent. A symbol may only be listed here once someone has looked at it
# and decided the other build is entitled to have it alone.
#   <symbol>|<reason>
KNOWN_OK=(
  "_usage|prints the exact correct command line when an argument guard refuses; the other build grew a stricter argument gate and needed the hint, this one refuses without it"
)
known_reason() {
  local s="$1" e
  for e in "${KNOWN_OK[@]}"; do [ "${e%%|*}" = "$s" ] && { printf '%s' "${e#*|}"; return 0; }; done
  return 1
}

echo "=== 1. Symbol parity (normalised for the known renames) ==="
for pair in "panel:$PKG_PANEL:$LIVE_PANEL" "driver:$PKG_DRIVER:$LIVE_DRIVER" "wrapper:$PKG_WRAPPER:$LIVE_WRAPPER"; do
  name="${pair%%:*}"; rest="${pair#*:}"; pkg="${rest%%:*}"; live="${rest#*:}"
  unexpected=""; accepted=""
  while read -r s; do
    [ -n "$s" ] || continue
    if r="$(known_reason "$s")"; then accepted="$accepted\n      accepted: $s — $r"
    else unexpected="$unexpected [only in this package] $s"; fi
  done < <(comm -23 <(syms "$pkg") <(syms "$live"))
  while read -r s; do
    [ -n "$s" ] || continue
    if r="$(known_reason "$s")"; then accepted="$accepted\n      accepted: $s — $r"
    else unexpected="$unexpected [only in the other build] $s"; fi
  done < <(comm -13 <(syms "$pkg") <(syms "$live"))
  if [ -z "$unexpected" ]; then echo "  OK   $name"; else fail=1; echo "  DIVERGED $name:$unexpected"; fi
  [ -n "$accepted" ] && printf '%b\n' "$accepted"
done

echo "=== 2. The regression suites, run against the other build ==="
run() { # run <label> <command...>
  local label="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  local line; line="$(printf '%s' "$out" | grep -E '^=== RESULT:' | tail -1)"
  if [ "$rc" = 0 ]; then echo "  OK   $label  ${line:-(no RESULT line)}"
  else fail=1; echo "  FAIL $label  ${line:-rc=$rc}"; printf '%s\n' "$out" | grep -E '^\s+(FAIL|✗)' | head -5; fi
}
run "panel"   env DUAL_AUDIT_PANEL="$LIVE_PANEL" node "$REPO/tests/test_panel.mjs"
run "driver"  env DUAL_AUDIT_DRIVER="$LIVE_DRIVER" DUAL_AUDIT_RC_MARKER="__$LIVE_RC" node "$REPO/tests/test_driver.mjs"
run "wrapper" env DUAL_AUDIT_WRAPPER="$LIVE_WRAPPER" DUAL_AUDIT_ENVP="$LIVE_ENVP" DUAL_AUDIT_RC_MARKER="$LIVE_RC" bash "$REPO/tests/test_wrapper.sh"

echo ""
if [ "$fail" = 0 ]; then echo "=== PARITY OK ==="; else echo "=== PARITY FAILED — the two builds have diverged ==="; fi
exit "$fail"
