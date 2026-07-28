#!/usr/bin/env bash
# Tests for the bypass linter.
#
# The linter exists to catch reviewer calls that skip the hardened wrapper, because those can
# silently review the wrong task. Each case builds a throwaway configuration tree containing
# exactly one shape and asserts the verdict, so a linter that stopped matching would be caught.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LINT="$REPO/runtime/codex-auditor/dual-audit-lint"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS $*"; }
bad() { fail=$((fail+1)); echo "  FAIL $*"; }

check() { # check <expect 0|1> <description> <file content>
  local want="$1" desc="$2" content="$3"
  local d; d="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-lint-test.XXXXXX")"
  mkdir -p "$d/agents"
  printf '%s\n' "$content" > "$d/agents/a.md"
  bash "$LINT" "$d/agents" >/dev/null 2>&1
  local rc=$?
  rm -rf "$d"
  if [ "$rc" = "$want" ]; then ok "$desc"; else bad "$desc (expected exit $want, got $rc)"; fi
}

echo "=== Bypasses are caught ==="
check 1 'a bare reviewer call reading a fixed file through command substitution' \
      'codex exec --sandbox read-only "$(cat /tmp/task.txt)"'
check 1 'a shared, predictable brief path' \
      'write the brief to /tmp/codex_review_task.txt first'
check 1 'a bare reviewer call redirecting from a fixed temporary file' \
      'codex exec --sandbox read-only - < /tmp/brief.md'
check 1 'a reviewer call that drops the read-only sandbox' \
      'codex exec --sandbox workspace-write -'

echo "=== Legitimate usage is not flagged ==="
check 0 'the supported wrapper form' \
      "dual-audit-codex exec --sandbox read-only --skip-git-repo-check --emit-rc - < brief.md"
check 0 'prose that merely mentions the reviewer' \
      'This document explains how the codex reviewer is invoked by the wrapper.'
check 0 'a line that names the forbidden pattern but is explicitly marked' \
      'codex exec --sandbox read-only "$(cat /tmp/x.txt)"   # dual-audit-lint:ignore'

echo "=== The shipped agent definition passes its own linter ==="
d="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-lint-test.XXXXXX")"
mkdir -p "$d/agents"
cp "$REPO/runtime/codex-auditor/dual-audit-codex-readonly.md" "$d/agents/"
if bash "$LINT" "$d/agents" >/dev/null 2>&1; then ok "the shipped reviewer agent is clean"
else bad "the shipped reviewer agent trips its own linter"; fi
rm -rf "$d"

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
