#!/usr/bin/env bash
# Run every test in this repository. No paid model is ever called: the reviewers are stubbed,
# and the wrapper tests exercise refusal paths only.
#
#   exit 0 = everything passed, 1 = at least one suite failed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO" || { echo "cannot enter $REPO" >&2; exit 2; }

failed=()
run() { # run <label> <command...>
  local label="$1"        # capture BEFORE the shift: afterwards $1 is the command, not the label
  shift
  echo ""
  echo "############ $label ############"
  "$@"
  local rc=$?
  [ "$rc" -ne 0 ] && failed+=("$label (exit $rc)")
  return 0
}

echo "############ static checks ############"
static_rc=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { echo "  FAIL node --check $f"; static_rc=1; }
done < <(find runtime tests -name '*.js' -o -name '*.mjs' | grep -v 'dual-audit-panel.js' | grep -v 'dual-audit-run.js')
# The panel and the driver are workflow bodies, not modules: they use top-level `return`, so
# `node --check` rejects them by design. Parse them the way the runtime does instead.
node -e '
  const fs=require("fs");
  const AF=Object.getPrototypeOf(async function(){}).constructor;
  for (const f of ["runtime/core/dual-audit-panel.js","runtime/claude-controller/dual-audit-run.js"]) {
    const src=fs.readFileSync(f,"utf8").replace("export const meta","const meta");
    try { new AF("args","agent","parallel","log","phase","budget","workflow",src); }
    catch(e){ console.log("  FAIL parse "+f+": "+e.message); process.exit(1); }
  }
' || static_rc=1
# The licence text must be the canonical one. A reflowed copy still reads as Apache-2.0 to a human
# and still fails a diff against the real thing, which is what anyone checking a dependency does.
# Checked by its exact indentation rather than a hash, so this needs no network and does not have to
# be updated when the copyright line changes: the canonical text indents section headings by three
# spaces and ordinary body text by six, and this file was shipped with every line one space short.
lic_rc=0
grep -q '^   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION$' LICENSE || lic_rc=1
grep -q '^   1. Definitions.$' LICENSE || lic_rc=1
grep -q '^      "License" shall mean the terms and conditions for use, reproduction,$' LICENSE || lic_rc=1
grep -q '^   Copyright ' LICENSE || lic_rc=1
[ "$(wc -l < LICENSE)" = 202 ] || lic_rc=1
[ "$lic_rc" -eq 0 ] || { echo "  FAIL LICENSE is not the canonical Apache-2.0 layout (see https://www.apache.org/licenses/LICENSE-2.0.txt)"; static_rc=1; }

for f in install.sh uninstall.sh runtime/core/dual-audit runtime/codex-auditor/dual-audit-codex \
         runtime/codex-auditor/dual-audit-lint scripts/sanitize-scan.sh tests/*.sh; do
  bash -n "$f" || { echo "  FAIL bash -n $f"; static_rc=1; }
done

if [ "$static_rc" -eq 0 ]; then echo "  PASS all scripts parse"; else failed+=("static checks"); fi

run "panel protocol"        node tests/test_panel.mjs
run "driver and terminal states" node tests/test_driver.mjs
run "args size gate"       node tests/test_args_size_gate.mjs
run "profile parser"        node tests/test_profile.mjs
run "reviewer wrapper"      bash tests/test_wrapper.sh
run "install and removal"   bash tests/test_install.sh
run "bypass linter"         bash tests/test_lint.sh
run "sanitisation scanner"  bash tests/test_sanitize.sh
run "agent definition contract" bash tests/test_agentdef.sh

echo ""
echo "#################################################"
if [ "${#failed[@]}" -eq 0 ]; then
  echo "ALL SUITES PASSED"
  exit 0
fi
echo "FAILED SUITES:"
for f in "${failed[@]}"; do echo "  - $f"; done
exit 1
