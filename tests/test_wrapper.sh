#!/usr/bin/env bash
# Guard tests for the read-only Codex wrapper.
#
# These exercise ONLY the refusal paths and the exit-code injector, so no reviewer is
# ever launched, no credentials are used and no tokens are spent. Every case asserts a
# specific exit code, because "it printed an error" is not the same as "it refused".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Both the wrapper under test and its environment-variable prefix are overridable, so this ONE suite
# can also be pointed at a separately deployed build of the same wrapper that uses different names.
# Without it the suite only ever covered the copy beside it, and the other build could drift with
# nothing watching — which is exactly how a budget guard ended up living in one copy and not the other.
#   DUAL_AUDIT_WRAPPER=/path/to/other-wrapper DUAL_AUDIT_ENVP=OTHER_PREFIX bash tests/test_wrapper.sh
W="${DUAL_AUDIT_WRAPPER:-$HERE/../runtime/codex-auditor/dual-audit-codex}"
EP="${DUAL_AUDIT_ENVP:-DUAL_AUDIT}"
RCM="${DUAL_AUDIT_RC_MARKER:-DUAL_AUDIT_RC}"   # the marker the wrapper injects, without the leading __
# Keep every artefact of this test out of the user's real runtime directory.
TESTDIR="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-test.XXXXXX")" || exit 2
# Exported under the prefix the wrapper under test actually reads, so the throwaway directory is
# honoured no matter which build is being exercised. Getting this wrong would not fail loudly — it
# would quietly write into the user's real runtime directory.
export "${EP}_RUNTIME_DIR=$TESTDIR"
export "${EP}_TELEMETRY="
trap 'rm -rf "$TESTDIR"' EXIT

pass=0; fail=0
want() { # want <expected-rc> <description> <command...>
  local exp="$1" desc="$2"; shift 2
  local out rc
  out="$("$@" </dev/null 2>&1)"; rc=$?
  if [ "$rc" = "$exp" ]; then pass=$((pass+1)); echo "  PASS rc=$rc  $desc"
  else fail=$((fail+1)); echo "  FAIL rc=$rc want=$exp  $desc :: $(printf '%s' "$out" | head -1)"; fi
}

echo "=== Argument and environment guards (all fail-closed) ==="
want 8 'an unrecognised MODE is refused, not silently treated as isolated' \
     env "${EP}_MODE=bogus" "$W" exec --sandbox read-only -
want 8 'a safety switch with a malformed value is refused, never failed open to off' \
     env "${EP}_BATCH=x" "$W" exec --sandbox read-only -
want 8 'a leading-zero number is refused (the shell would read it as octal)' \
     env "${EP}_TIMEOUT=0700" "$W" exec --sandbox read-only -
want 8 'a value above the ceiling is refused rather than silently clamped' \
     env "${EP}_LOCK_WAIT=999999" "$W" exec --sandbox read-only -
want 9 'the concurrency cap clamps down instead of refusing (less concurrency is the safe direction)' \
     env "${EP}_MAX_PAR=64" "$W" exec --sandbox read-only --skip-git-repo-check -
want 8 'a directory-change flag is refused in its attached form' \
     "$W" exec -C/tmp --sandbox read-only -
want 8 '--batch combined with serial mode is refused (it would bypass batch admission)' \
     "$W" exec --serial --batch --sandbox read-only -
want 8 '--preflight carrying an exec payload is refused (it would discard the review and return 0)' \
     "$W" --preflight exec --sandbox read-only -
# Fully-valid arguments on purpose: a build with a stricter argument gate would otherwise refuse this
# for the missing flag and never reach the stdin check, so the case would report a pass for the wrong
# reason — the same trap the teeth check below guards against.
want 9 'a zero-byte brief is refused before any slot is taken' \
     "$W" exec --sandbox read-only --skip-git-repo-check --emit-rc -

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
ser_out="$(printf 'a brief\n' | env "${EP}_STATE_DIR=$SER_STATE" "${EP}_CODEX_BIN=$SER_BIN/codex" \
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
n_marks="$(printf '%s\n' "$inj" | grep -c "^__${RCM}=137\$")"
if [ "$n_marks" = 2 ]; then pass=$((pass+1)); echo "  PASS the marker is injected into EVERY block, so duplicate blocks stay byte-identical and foldable"
else fail=$((fail+1)); echo "  FAIL expected 2 markers, got $n_marks"; fi

before_end="$(printf '%s\n' "$inj" | grep -A1 "^__${RCM}=137\$" | grep -c '^END$')"
if [ "$before_end" = 2 ]; then pass=$((pass+1)); echo "  PASS every marker sits INSIDE the block, immediately before its END"
else fail=$((fail+1)); echo "  FAIL markers are not positioned before END (found $before_end)"; fi

noblock="$(printf 'reviewer crashed, no verdict\n' \
          | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 137")"
if printf '%s\n' "$noblock" | grep -q "^__${RCM}=137\$"; then
  pass=$((pass+1)); echo "  PASS with no verdict block at all the marker is still appended, so the exit code always lands somewhere"
else fail=$((fail+1)); echo "  FAIL no marker when there is no verdict block"; fi

standalone="$(printf 'END\nsome prose\n' \
             | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 0")"
if [ "$(printf '%s\n' "$standalone" | grep -c "^__${RCM}=")" = 1 ] && \
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
echo "=== The outer-budget guard: refuse LOUDLY rather than be killed into silence ==="
# WHY: this wrapper's own timeout used to sit ABOVE the ceiling the calling tool enforces, so the
# caller killed it first — its trap never ran and stdout came back empty. An audit that died and an
# audit that found nothing then look identical, which is the single failure this project most needs
# not to have. The guard measures how much of the caller's budget is already gone and either tightens
# its own timeout or refuses outright; either way something is SAID.
# Nothing below launches a reviewer: the guard fires before the dispatch, so no token is spent.
want_in() { # want_in <expected-rc> <description> <command...> ; feeds a non-empty brief on stdin
  local exp="$1" desc="$2"; shift 2
  local out rc
  out="$(printf 'review this\n' | "$@" 2>&1)"; rc=$?
  if [ "$rc" = "$exp" ]; then pass=$((pass+1)); echo "  PASS rc=$rc  $desc"
  else fail=$((fail+1)); echo "  FAIL rc=$rc want=$exp  $desc :: $(printf '%s' "$out" | head -1)"; fi
}

# A fully-valid invocation: a build may enforce flags the others do not, and a run rejected for a
# MISSING FLAG never reaches the guard at all — it just returns some other refusal code.
OKARGS=(exec --sandbox read-only --skip-git-repo-check --emit-rc -)

brc=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || brc=$?
if [ "$brc" = 97 ]; then pass=$((pass+1)); echo "  PASS rc=97  an already-spent outer budget refuses before dispatch instead of starting a doomed run"
else fail=$((fail+1)); echo "  FAIL rc=$brc want=97  the guard did not refuse"; fi

# 🔴 The serial path specifically. An earlier version of this guard ran only before the ISOLATED
#    reviewer started, and serial forks off before that point — so the most common caller, which is
#    downgraded to serial whenever the token is short, kept the exact failure the guard was written
#    for. One path fixed, the other silently not: that is worse than no fix, because the guard now
#    looks present.
src=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "${EP}_MODE=serial" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || src=$?
if [ "$src" = 97 ]; then pass=$((pass+1)); echo "  PASS rc=97  the serial path is covered too, not just the isolated one"
else fail=$((fail+1)); echo "  FAIL rc=$src want=97  the serial path bypasses the guard"; fi

# Teeth: with the pre-dispatch call removed the same input must NOT come back 97.
# 🔴 This check is only meaningful if the UNMUTATED run actually reached 97. Without that condition a
#    run rejected earlier for an unrelated reason (a missing flag, say) returns "not 97" and the teeth
#    check congratulates itself — a false clean kill, which is worse than no check because it reports
#    confidence it has not earned. That is not hypothetical: this suite did exactly that the first time
#    it was pointed at a build with a stricter argument gate.
MUT="$TESTDIR/mutant-wrapper"
# Every call site must go. Removing only one leaves the others still refusing, which makes the mutant
# EQUIVALENT — and an equivalent mutant reads as 'the assertion has no teeth' when the real story is
# 'this build defends the same thing twice'. Measured: one build has three call sites, another two.
sed -E 's/^([[:space:]]*)_clamp_timeout .*$/\1: # mutated away/' "$W" > "$MUT" && chmod +x "$MUT"
if [ "$brc" != 97 ]; then
  fail=$((fail+1)); echo "  FAIL [mut] skipped: the unmutated run never reached 97, so nothing here can prove the guard has teeth"
elif ! grep -qE '^[[:space:]]*: # mutated away' "$MUT"; then
  fail=$((fail+1)); echo "  FAIL the mutation anchor did not match — the mutant is a no-op, so the teeth check proves nothing"
else
  mrc=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "$MUT" "${OKARGS[@]}" >/dev/null 2>&1 || mrc=$?
  if [ "$mrc" != 97 ]; then pass=$((pass+1)); echo "  PASS rc=$mrc  [mut] removing the pre-dispatch call stops the refusal (the assertion has teeth)"
  else fail=$((fail+1)); echo "  FAIL the mutant still refuses with 97 — the two cases above are not testing this guard"; fi
fi

# The defaults must be internally consistent: the wrapper's own ceiling, plus the grace period and the
# slack reserved for what happens after a timeout, has to fit INSIDE the caller's budget. This is the
# original defect stated as an arithmetic invariant, so raising the timeout back over the ceiling fails
# here instead of being discovered by an audit coming back empty months later.
dflt() { grep -oP "^_numenv\s+$1\s+\S+\s+\K[0-9]+" "$W" | head -1; }
_to=$(dflt TIMEOUT); _ka=$(dflt KILL_AFTER); _ob=$(dflt OUTER_BUDGET)
_slack=$(grep -oP '^BUDGET_SLACK=\K[0-9]+' "$W" | head -1)
if [ -n "$_to" ] && [ -n "$_ka" ] && [ -n "$_ob" ] && [ -n "$_slack" ] && [ $((_to + _ka + _slack)) -le "$_ob" ]; then
  pass=$((pass+1)); echo "  PASS the default timeout+grace+slack ($((_to + _ka + _slack))s) fits inside the default outer budget (${_ob}s)"
else
  fail=$((fail+1)); echo "  FAIL defaults do not fit: timeout=$_to grace=$_ka slack=$_slack budget=$_ob — the wrapper would be killed before its own timeout fires"
fi

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
