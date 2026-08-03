#!/usr/bin/env bash
# Guard tests for the read-only Codex wrapper.
#
# **No REAL reviewer is ever launched, no credentials are used and no tokens are spent.** The
# reviewer binary is overridden file-wide to a local stub, and a launch counter enforces it: every
# refusal case must reach the stub ZERO times, and the cases that deliberately do reach it — the
# mutants, and the launch-marker group at the end — account for each launch and clear the log.
#
# ⚠️ The wording above was corrected by an independent review. It used to say "no reviewer is ever
# launched", which was false twice over: the mutant case reached the launch point by design, and
# before the override existed it got there with the REAL binary and the REAL credential. A header
# that overstates safety is worse than one that says nothing, because it is what a reader checks
# instead of the code.
#
# Every case asserts a specific exit code or a specific observable, because "it printed an error" is
# not the same as "it refused".
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

# 🔴 A STUB reviewer, and a hard assertion that it is the one that would run.
#    An independent review of the previous version of this block proved it launched the REAL
#    reviewer: the mutant case did not set the binary override, so with every guard removed the run
#    reached the launch point, resolved `command -v codex` to the real binary and copied the real
#    credential — while this file's own header said no reviewer is ever launched and no tokens spent.
#    That is the same shape as a gate test that can reach the thing the gate guards. So: the override
#    is exported for the WHOLE file (an earlier case set it in one place only), and the stub records
#    every launch so a later assertion can prove nothing else ran.
STUB_DIR="$TESTDIR/stub"; mkdir -p "$STUB_DIR"
STUB_LOG="$TESTDIR/launches.log"; : > "$STUB_LOG"
printf '#!/bin/sh\necho "LAUNCH $*" >> "%s"\nexit 0\n' "$STUB_LOG" > "$STUB_DIR/codex"
chmod +x "$STUB_DIR/codex"
export "${EP}_CODEX_BIN=$STUB_DIR/codex"

# 🔴 Can this environment reach a reviewer launch AT ALL? On a machine with no Codex credentials —
#    CI, a fresh clone — the wrapper refuses during bootstrap (rc=3) long before any guard under
#    test. Cases that must REACH the launch point cannot be constructed there, and the only honest
#    report is SKIP: not PASS (it proves nothing) and not FAIL (nothing is broken).
#    ⚠️ Decided by PROBING, never by an environment switch. A switch would also silence a real
#       regression on a machine that does have credentials, which is the failure mode this whole
#       file exists to prevent.
printf '#!/bin/sh\necho "PROBE" >> "%s"\nexit 0\n' "$STUB_LOG" > "$STUB_DIR/probe"
chmod +x "$STUB_DIR/probe"
: > "$STUB_LOG"
printf 'probe\n' | env "${EP}_CODEX_BIN=$STUB_DIR/probe" "$W" "${OKARGS[@]}" >/dev/null 2>&1
CAN_LAUNCH=0; [ "$(wc -l < "$STUB_LOG")" -ge 1 ] && CAN_LAUNCH=1
: > "$STUB_LOG"
[ "$CAN_LAUNCH" = 1 ] || echo "  NOTE  this environment cannot reach a reviewer launch (no credentials); launch-dependent cases will SKIP"

brc=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || brc=$?
if [ "$brc" = 97 ]; then pass=$((pass+1)); echo "  PASS rc=97  an already-spent outer budget refuses before dispatch instead of starting a doomed run"
else fail=$((fail+1)); echo "  FAIL rc=$brc want=97  the guard did not refuse"; fi

src=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "${EP}_MODE=serial" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || src=$?
# NOTE the wording: this proves both MODES reach the pre-dispatch guard. It does NOT prove the serial
# path is guarded after its lock wait — an earlier version of this block claimed that, and a reviewer
# showed the claim was re-testing the shared pre-dispatch line. The post-lock case below is the one
# with serial-specific teeth.
if [ "$src" = 97 ]; then pass=$((pass+1)); echo "  PASS rc=97  serial also reaches the pre-dispatch guard (not: that serial is guarded after its wait)"
else fail=$((fail+1)); echo "  FAIL rc=$src want=97  the serial path never reaches the pre-dispatch guard"; fi

MUT="$TESTDIR/mutant-wrapper"
sed -E 's/^([[:space:]]*)_clamp_timeout .*$/\1: # mutated away/' "$W" > "$MUT" && chmod +x "$MUT"
if [ "$CAN_LAUNCH" != 1 ]; then
  echo "  SKIP  [mut] the teeth check needs to REACH the reviewer, which this environment cannot do"
elif [ "$brc" != 97 ]; then
  fail=$((fail+1)); echo "  FAIL [mut] skipped: the unmutated run never reached 97, so nothing here can prove the guard has teeth"
elif ! grep -qE '^[[:space:]]*: # mutated away' "$MUT"; then
  fail=$((fail+1)); echo "  FAIL the mutation anchor did not match — the mutant is a no-op, so the teeth check proves nothing"
else
  # Snapshot first: every case so far must have refused WITHOUT reaching the reviewer.
  before=$(wc -l < "$STUB_LOG")
  if [ "$before" = 0 ]; then pass=$((pass+1)); echo "  PASS no unmutated case reached the reviewer"
  else fail=$((fail+1)); echo "  FAIL $before launch(es) before the mutant — a guard did not hold:"; sed 's/^/       /' "$STUB_LOG"; fi
  mrc=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=1" "$MUT" "${OKARGS[@]}" >/dev/null 2>&1 || mrc=$?
  after=$(wc -l < "$STUB_LOG")
  # 🔴 The teeth check asserts the LAUNCH POINT WAS REACHED, not merely that the code differs from 97.
  #    "rc != 97" is satisfied by any refusal at all — a missing flag, a bootstrap error, a machine
  #    with no reviewer installed — so a mutant could "pass" while never getting near the guarded
  #    action. Counting the launch is the observable that actually distinguishes "the guard was the
  #    only thing stopping it" from "something else stopped it earlier". This is also why the stub
  #    exists: without it, this very assertion would be a real reviewer call.
  if [ "$mrc" != 97 ] && [ "$after" = $((before + 1)) ]; then
    pass=$((pass+1)); echo "  PASS rc=$mrc  [mut] with every clamp removed the run REACHES the reviewer (the guard was the only thing stopping it)"
  elif [ "$mrc" = 97 ]; then
    fail=$((fail+1)); echo "  FAIL the mutant still refuses with 97 — the cases above are not testing this guard"
  else
    fail=$((fail+1)); echo "  FAIL rc=$mrc but the reviewer was never reached ($before -> $after) — the mutant was stopped by something else, so this proves nothing"
  fi
  : > "$STUB_LOG"   # the mutant's launch is accounted for; later cases start from zero again
fi

echo "=== The wait for the serial lock counts against the budget too ==="
# The gap a reviewer measured: the budget was checked BEFORE the lock wait and never again, so a run
# could wait out most of the caller's ceiling and then launch a full-length reviewer against what was
# left. Constructed here rather than argued: hold the lock, give a budget that is fine at dispatch and
# gone by the time the lock is released.
LOCKPATH="$(sed -n 's/^LOCK="\(.*\)".*/\1/p' "$W" | head -1)"
LOCKPATH="$(RUNTIME_DIR="$TESTDIR" eval echo "$LOCKPATH" 2>/dev/null)"
case "$LOCKPATH" in
  "$TESTDIR"/*)
    ( flock 9; sleep 12 ) 9>"$LOCKPATH" &
    HOLDER=$!
    sleep 1
    prc=0; printf 'review this\n' | env "${EP}_OUTER_BUDGET=45" "${EP}_LOCK_WAIT=20" "${EP}_MODE=serial" \
      "$W" "${OKARGS[@]}" >/dev/null 2>&1 || prc=$?
    if [ "$prc" = 97 ]; then pass=$((pass+1)); echo "  PASS rc=97  a budget exhausted BY THE LOCK WAIT is caught before launching"
    else fail=$((fail+1)); echo "  FAIL rc=$prc want=97  the wait was not counted — the reviewer would start on a spent budget"; fi
    wait "$HOLDER" 2>/dev/null
    ;;
  *)
    # Not a pass: a build whose lock lives at a fixed global path cannot be exercised here without
    # contending with real runs on this machine, and pretending otherwise would be a green light
    # bought by not looking.
    echo "  SKIP  lock path '$LOCKPATH' is outside the throwaway dir; refusing to contend with real runs"
    ;;
esac

echo "=== No unmutated case may have launched a reviewer ==="
# The belt-and-braces half of the stub. The mutant is EXPECTED to launch — that is its evidence, and
# it was counted and cleared above. Any launch from here means a guard on the real build did not hold,
# and without the stub that same launch would have spent a token against real credentials.
launches=$(wc -l < "$STUB_LOG" 2>/dev/null || echo 0)
if [ "$launches" = 0 ]; then pass=$((pass+1)); echo "  PASS no unmutated case reached the reviewer"
else fail=$((fail+1)); echo "  FAIL $launches launch(es) reached the reviewer:"; sed 's/^/       /' "$STUB_LOG"; fi

# The defaults must be internally consistent: the wrapper's own ceiling, plus the grace period and the
# slack reserved for what happens after a timeout, has to fit INSIDE the caller's budget. This is the
# original defect stated as an arithmetic invariant, so raising the timeout back over the ceiling fails
# here instead of being discovered by an audit coming back empty months later.
dflt() { grep -oP "^_numenv\s+$1\s+\S+\s+\K[0-9]+" "$W" | head -1; }
_to=$(dflt TIMEOUT); _ka=$(dflt KILL_AFTER); _ob=$(dflt OUTER_BUDGET); _lw=$(dflt LOCK_WAIT)
_slack=$(grep -oP '^BUDGET_SLACK=\K[0-9]+' "$W" | head -1)
if [ -z "$_to" ] || [ -z "$_ka" ] || [ -z "$_ob" ] || [ -z "$_lw" ] || [ -z "$_slack" ]; then
  fail=$((fail+1)); echo "  FAIL could not read all five defaults (timeout=$_to grace=$_ka wait=$_lw slack=$_slack budget=$_ob)"
else
  # (a) A run that waits for nothing must still fit.
  if [ $((_to + _ka + _slack)) -le "$_ob" ]; then
    pass=$((pass+1)); echo "  PASS timeout+grace+slack ($((_to + _ka + _slack))s) fits inside the outer budget (${_ob}s)"
  else
    fail=$((fail+1)); echo "  FAIL timeout=$_to grace=$_ka slack=$_slack exceed budget=$_ob — killed before its own timeout fires"
  fi
  # (b) 🔴 And the WAIT counts. The first version of this check summed only the three terms above and
  #     called itself an invariant; a reviewer pointed out it omitted LOCK_WAIT, so the shipped
  #     defaults (540+540+30+10 against 600) passed it while a serial run could wait out 90% of the
  #     ceiling before starting a full-length review. The comment beside the budget code says a SUM
  #     silently under-counts every time a stage is added — and this check was a sum that did exactly
  #     that. It is still a sum, because a static check has nothing to measure; what changed is that
  #     the omitted stage is now in it, and this note names the class so the next omission is looked for.
  if [ $((_lw + _to + _ka + _slack)) -le "$_ob" ]; then
    pass=$((pass+1)); echo "  PASS wait+timeout+grace+slack ($((_lw + _to + _ka + _slack))s) also fits (${_ob}s)"
  else
    fail=$((fail+1)); echo "  FAIL wait=$_lw pushes the chain to $((_lw + _to + _ka + _slack))s against budget=$_ob — a serial run can burn the ceiling queueing and then be refused"
  fi
fi

echo "=== A run killed from OUTSIDE must not look like a run that never started ==="
# 🔴 THE FAILURE THIS REPRODUCES, exactly as it happened. A caller enforced a wall-clock ceiling
#    nobody had declared to the wrapper. The reviewer started, worked, and was killed part-way. The
#    wrapper's own timeout and trap never ran, so the exit-code marker was never injected, and stdout
#    came back EMPTY — byte-identical to a run that never started, and indistinguishable from a
#    review that finished with nothing to say. Six identical retries followed, and the panel lost the
#    seat. Constructed here rather than argued: a stub that hangs, and an external kill.
#
# ⚠️ These cases DELIBERATELY reach the stub reviewer. That is the point — the marker is written at
#    the launch, so nothing that refuses earlier can exercise it. Every launch is counted and the log
#    is cleared afterwards, so the "no unmutated case launched" accounting above stays honest.
# Derived from RCM rather than hardcoded, for the same reason RCM itself is overridable: the two
# builds name their markers differently (..._RC / ..._LAUNCHED share a prefix), and a suite that
# hardcodes one build's spelling silently stops testing the other.
if [ "$CAN_LAUNCH" != 1 ]; then
  echo "  SKIP  every case here must reach the launch point; this environment refuses during bootstrap"
else
LAUNCH_MARK="__${RCM%_RC}_LAUNCHED="
printf '#!/bin/sh\necho "LAUNCH $*" >> "%s"\nsleep 30\n' "$STUB_LOG" > "$STUB_DIR/hang"
chmod +x "$STUB_DIR/hang"
printf '#!/bin/sh\necho "LAUNCH $*" >> "%s"\nprintf "VERDICT: APPROVE\\nEND\\n"\n' "$STUB_LOG" > "$STUB_DIR/quick"
chmod +x "$STUB_DIR/quick"

# 🔴 EACH case is bracketed by its own launch count. An aggregate "did anything launch?" was the
#    first version and an independent review demonstrated it hollow: case (B) is a NEGATIVE assertion
#    whose vacuous-pass mode is "never launched at all", and one shared counter cannot exclude that —
#    a wrapper copy that refuses non---emit-rc runs BEFORE the announcement recorded zero launches and
#    (B) still reported PASS. A negative assertion needs its own proof that it got as far as the thing
#    it is denying.
launched_by() {   # launched_by <label>; echoes the launch delta and resets the log for the next case
  local n; n=$(wc -l < "$STUB_LOG"); : > "$STUB_LOG"; printf '%s' "$n"
}
: > "$STUB_LOG"

# (A) killed from outside, WITH --emit-rc: the marker is the only thing that survives, and it must.
# ⚠️ Two signals, TERM and KILL, because they measure different things. The wrapper installs
#    `trap ... TERM`, and bash DEFERS a trap until the foreground command returns — measured: under
#    `timeout -s TERM 3` with a 60 s stub the wrapper exited after 60 s, not 3. So the TERM case is
#    really "signalled, stub then finished". KILL is untrappable and is the honest reproduction of
#    the original incident, where the caller took the command away mid-review.
outA=$(printf 'review this\n' | timeout -s TERM 5 env "${EP}_CODEX_BIN=$STUB_DIR/hang" \
        "$W" "${OKARGS[@]}" 2>/dev/null); : "${outA:=}"
nA=$(launched_by A)
if [ "$nA" -ge 1 ] && printf '%s' "$outA" | grep -qF "$LAUNCH_MARK"; then
  pass=$((pass+1)); echo "  PASS (A) a signalled run reached the launch point and still carries the marker"
elif [ "$nA" -lt 1 ]; then
  fail=$((fail+1)); echo "  FAIL (A) never reached the launch point — the assertion is vacuous"
else
  fail=$((fail+1)); echo "  FAIL (A) no launch marker — stdout was $(printf '%s' "$outA" | wc -c) bytes; this is the original defect"
fi

outK=$(printf 'review this\n' | timeout -s KILL 5 env "${EP}_CODEX_BIN=$STUB_DIR/hang" \
        "$W" "${OKARGS[@]}" 2>/dev/null); : "${outK:=}"
nK=$(launched_by K)
if [ "$nK" -ge 1 ] && printf '%s' "$outK" | grep -qF "$LAUNCH_MARK"; then
  pass=$((pass+1)); echo "  PASS (A2) an UNTRAPPABLE kill mid-review still leaves the marker (no exit handler runs at all)"
elif [ "$nK" -lt 1 ]; then
  fail=$((fail+1)); echo "  FAIL (A2) never reached the launch point — the assertion is vacuous"
else
  fail=$((fail+1)); echo "  FAIL (A2) SIGKILL mid-review returned no marker — stdout was $(printf '%s' "$outK" | wc -c) bytes"
fi

# (B) the same kill WITHOUT --emit-rc: other callers parse raw reviewer output, so their stdout must
#     stay untouched. The launch count is what stops this passing by never getting there.
NOEMIT=(exec --sandbox read-only --skip-git-repo-check -)
outB=$(printf 'review this\n' | timeout -s KILL 5 env "${EP}_CODEX_BIN=$STUB_DIR/hang" \
        "$W" "${NOEMIT[@]}" 2>/dev/null); : "${outB:=}"
nB=$(launched_by B)
if [ "$nB" -lt 1 ]; then
  fail=$((fail+1)); echo "  FAIL (B) never reached the launch point ($nB launches) — 'the marker is absent' would be true of any early refusal, so this proves nothing"
elif printf '%s' "$outB" | grep -qF "$LAUNCH_MARK"; then
  fail=$((fail+1)); echo "  FAIL (B) the marker appeared without --emit-rc — this rewrites the stdout of callers that never opted in"
else
  pass=$((pass+1)); echo "  PASS (B) reached the launch point and emitted no marker (callers that parse raw output are unaffected)"
fi

# (C) a normal completion must still parse: marker present AND the exit code inside the block.
outC=$(printf 'review this\n' | env "${EP}_CODEX_BIN=$STUB_DIR/quick" "$W" "${OKARGS[@]}" 2>/dev/null)
nC=$(launched_by C)
if [ "$nC" -ge 1 ] && printf '%s' "$outC" | grep -qF "$LAUNCH_MARK" \
   && printf '%s' "$outC" | grep -qE '^VERDICT:' \
   && printf '%s' "$outC" | grep -qE "^__${RCM}=0$"; then
  pass=$((pass+1)); echo "  PASS (C) a normal run reached the launch point and carries both the marker and the exit code inside the block"
elif [ "$nC" -lt 1 ]; then
  fail=$((fail+1)); echo "  FAIL (C) never reached the launch point — the assertion is vacuous"
else
  fail=$((fail+1)); echo "  FAIL (C) a normal run no longer parses; got: $(printf '%s' "$outC" | tr '\n' '|' | cut -c1-160)"
fi

# Teeth. Remove the announcement and (A) must go red; anything else means (A) was passing for some
# other reason. Both call sites are mutated: leaving one alive is an equivalent mutant, which is how
# a previous clamp mutation reported teeth it did not have.
MUTL="$TESTDIR/mutant-launch"
sed -E 's/^([[:space:]]*)_announce_launch([[:space:]].*)?$/\1: # mutated away/' "$W" > "$MUTL" && chmod +x "$MUTL"
if [ "$(grep -cE '^[[:space:]]*: # mutated away' "$MUTL")" -lt 2 ]; then
  fail=$((fail+1)); echo "  FAIL [mut] the mutation anchor matched fewer than both call sites — an equivalent mutant proves nothing"
else
  mbefore=$(wc -l < "$STUB_LOG")
  outM=$(printf 'review this\n' | timeout -s TERM 5 env "${EP}_CODEX_BIN=$STUB_DIR/hang" \
          "$MUTL" "${OKARGS[@]}" 2>/dev/null); : "${outM:=}"
  mafter=$(wc -l < "$STUB_LOG")
  if [ "$mafter" -le "$mbefore" ]; then
    fail=$((fail+1)); echo "  FAIL [mut] the mutant never reached the launch point — it was stopped by something else, so this is not a teeth check"
  elif printf '%s' "$outM" | grep -qF "$LAUNCH_MARK"; then
    fail=$((fail+1)); echo "  FAIL [mut] the marker is still there with the announcement removed — case (A) passes for some other reason"
  else
    pass=$((pass+1)); echo "  PASS [mut] with the announcement removed the killed run goes silent again — (A) has teeth"
  fi
  : > "$STUB_LOG"
fi
fi

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
