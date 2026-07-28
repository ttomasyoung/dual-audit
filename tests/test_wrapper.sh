#!/usr/bin/env bash
# Guard tests for the read-only Codex wrapper.
#
# These exercise ONLY the refusal paths and the exit-code injector, so no reviewer is
# ever launched, no credentials are used and no tokens are spent. Every case asserts a
# specific exit code, because "it printed an error" is not the same as "it refused".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$HERE/../runtime/codex-auditor/dual-audit-codex"
# Keep every artefact of this test out of the user's real runtime directory.
export DUAL_AUDIT_RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-test.XXXXXX")"
export DUAL_AUDIT_TELEMETRY=""
trap 'rm -rf "$DUAL_AUDIT_RUNTIME_DIR"' EXIT

pass=0; fail=0
want() { # want <expected-rc> <description> <command...>
  local exp="$1" desc="$2"; shift 2
  local out rc
  out="$("$@" </dev/null 2>&1)"; rc=$?
  if [ "$rc" = "$exp" ]; then pass=$((pass+1)); echo "  PASS rc=$rc  $desc"
  else fail=$((fail+1)); echo "  FAIL rc=$rc want=$exp  $desc :: $(printf '%s' "$out" | head -1)"; fi
}

echo "=== Argument and environment guards (all fail-closed) ==="
want 8 'unrecognised DUAL_AUDIT_MODE is refused, not silently treated as isolated' \
     env DUAL_AUDIT_MODE=bogus "$W" exec --sandbox read-only -
want 8 'a safety switch with a malformed value is refused, never failed open to off' \
     env DUAL_AUDIT_BATCH=x "$W" exec --sandbox read-only -
want 8 'a leading-zero number is refused (the shell would read it as octal)' \
     env DUAL_AUDIT_TIMEOUT=0700 "$W" exec --sandbox read-only -
want 8 'a value above the ceiling is refused rather than silently clamped' \
     env DUAL_AUDIT_LOCK_WAIT=999999 "$W" exec --sandbox read-only -
want 9 'the concurrency cap clamps down instead of refusing (less concurrency is the safe direction)' \
     env DUAL_AUDIT_MAX_PAR=64 "$W" exec --sandbox read-only -
want 8 'a directory-change flag is refused in its attached form' \
     "$W" exec -C/tmp --sandbox read-only -
want 8 '--batch combined with serial mode is refused (it would bypass batch admission)' \
     "$W" exec --serial --batch --sandbox read-only -
want 8 '--preflight carrying an exec payload is refused (it would discard the review and return 0)' \
     "$W" --preflight exec --sandbox read-only -
want 9 'a zero-byte brief is refused before any slot is taken' \
     "$W" exec --sandbox read-only --emit-rc -

echo "=== Read-only is enforced here, not left to the caller ==="
# The documented guarantee is that a review cannot write. Passing the sandbox mode straight through
# would make that true only for callers who already meant it — which is not a guarantee at all.
want 8 'a write-enabled sandbox is refused (separate-argument form)' \
     "$W" exec --sandbox danger-full-access -
want 8 'a write-enabled sandbox is refused (attached form)' \
     "$W" exec --sandbox=workspace-write -
want 8 '--sandbox with no value is refused rather than read as the payload' \
     "$W" exec --sandbox
want 8 'an explicit sandbox-removal flag is refused' \
     "$W" exec --dangerously-bypass-approvals-and-sandbox --sandbox read-only -
want 8 'an exec request with NO sandbox flag is refused (the real CLI default is not our promise to make)' \
     "$W" exec -

echo "=== The serial credential home is guarded before anything is written ==="
# Serial mode is the one path that writes a credential to a long-lived location, and both mkdir -p
# and cp -f follow a symlink. A FAKE codex binary is supplied so nothing real is ever launched and
# no tokens are spent; the guard must fire before the copy either way.
SER_STATE="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-state.XXXXXX")"
SER_VICTIM="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-victim.XXXXXX")"
SER_BIN="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-bin.XXXXXX")"
printf '#!/bin/sh\nexit 0\n' > "$SER_BIN/codex"; chmod +x "$SER_BIN/codex"
echo "victim data" > "$SER_VICTIM/auth.json"
ln -sfn "$SER_VICTIM" "$SER_STATE/serial-codex-home"
ser_out="$(printf 'a brief\n' | env DUAL_AUDIT_STATE_DIR="$SER_STATE" DUAL_AUDIT_CODEX_BIN="$SER_BIN/codex" \
           "$W" exec --serial --sandbox read-only - 2>&1)"; ser_rc=$?
if [ "$ser_rc" = 8 ]; then pass=$((pass+1)); echo "  PASS rc=8  a symlinked serial credential home is refused"
else fail=$((fail+1)); echo "  FAIL rc=$ser_rc want=8  symlinked serial home :: $(printf '%s' "$ser_out" | head -1)"; fi
if [ "$(cat "$SER_VICTIM/auth.json" 2>/dev/null)" = "victim data" ]; then
  pass=$((pass+1)); echo "  PASS no credential was written through the link"
else fail=$((fail+1)); echo "  FAIL the file behind the symlink was overwritten"; fi
rm -rf "$SER_STATE" "$SER_VICTIM" "$SER_BIN"

echo "=== Exit-code injection ==="
inj="$(printf 'noise\nVERDICT: APPROVE\nP0: none\nEND\nVERDICT: APPROVE\nP0: none\nEND\n' \
      | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 137")"
n_marks="$(printf '%s\n' "$inj" | grep -c '^__DUAL_AUDIT_RC=137$')"
if [ "$n_marks" = 2 ]; then pass=$((pass+1)); echo "  PASS the marker is injected into EVERY block, so duplicate blocks stay byte-identical and foldable"
else fail=$((fail+1)); echo "  FAIL expected 2 markers, got $n_marks"; fi

before_end="$(printf '%s\n' "$inj" | grep -A1 '^__DUAL_AUDIT_RC=137$' | grep -c '^END$')"
if [ "$before_end" = 2 ]; then pass=$((pass+1)); echo "  PASS every marker sits INSIDE the block, immediately before its END"
else fail=$((fail+1)); echo "  FAIL markers are not positioned before END (found $before_end)"; fi

noblock="$(printf 'reviewer crashed, no verdict\n' \
          | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 137")"
if printf '%s\n' "$noblock" | grep -q '^__DUAL_AUDIT_RC=137$'; then
  pass=$((pass+1)); echo "  PASS with no verdict block at all the marker is still appended, so the exit code always lands somewhere"
else fail=$((fail+1)); echo "  FAIL no marker when there is no verdict block"; fi

standalone="$(printf 'END\nsome prose\n' \
             | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 0")"
if [ "$(printf '%s\n' "$standalone" | grep -c '^__DUAL_AUDIT_RC=')" = 1 ] && \
   [ "$(printf '%s\n' "$standalone" | head -1)" = 'END' ]; then
  pass=$((pass+1)); echo "  PASS a standalone END in prose does not attract a marker (only a real block does)"
else fail=$((fail+1)); echo "  FAIL prose END was treated as a block terminator"; fi

# The README states exactly which fields telemetry writes. A promise about what is NOT recorded is
# only worth as much as the thing that keeps it current: a field added later would quietly make the
# documented list wrong, and a privacy claim that has drifted is worse than none. This pins the set —
# add a field and this fails until the README is updated with it.
TELEMETRY_FIELDS="batch_id exec_ms http_signal mode serial_lock_wait_ms slot slot_wait_ms timeout_s token_status"
actual="$(grep -oE '"[a-z_]+":' "$HERE/../runtime/codex-auditor/dual-audit-codex" \
          | tr -d '":' | sort -u | grep -vxE 'batch|none' | tr '\n' ' ')"
expected="$(printf '%s\n' $TELEMETRY_FIELDS | sort -u | tr '\n' ' ')"
if [ "$actual" = "$expected" ]; then
  pass=$((pass+1)); echo "  PASS telemetry writes exactly the fields the README lists"
else
  fail=$((fail+1)); echo "  FAIL telemetry fields drifted from the documented set"
  echo "       documented: $expected"
  echo "       in the code: $actual"
fi

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
