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
# The wrapper resolves its reviewer model from a models cache and refuses (96) without one. The suite
# must not depend on the machine it runs on having that cache — a clean CI runner has none, and every
# case that expects a later guard (97, 9, 8 ...) would meet 96 first. So the whole file points the
# wrapper at a fixture; the model cases below override it per call.
printf '{"models":[{"slug":"gpt-6-sol","visibility":"list","supported_reasoning_levels":[{"effort":"high"}]}]}' \
  > "$TESTDIR/default-models-cache.json"
export "${EP}_MODELS_CACHE=$TESTDIR/default-models-cache.json"
export "${EP}_TELEMETRY="
trap 'rm -rf "$TESTDIR"' EXIT

pass=0; fail=0; skip=0
# 🔴 SKIPs are COUNTED and reported. A skipped case is honest, but "27 passed / 0 failed" reads as full
# coverage to anyone checking the release gate, and two load-bearing cases skip routinely: the
# launch-marker group when this environment cannot reach a reviewer, and the post-lock budget case
# when the build under test pins its lock to a fixed global path (which the deployed build does, so
# that assertion has never run against it here). An independent sweep found both, shape 5.
# The exit status is deliberately NOT changed: a skip is not a failure, and making it one would turn
# the live-parity run red for a difference that is already recorded and accepted. What changes is that
# the number is now impossible to miss.
# $1 = message, $2 = how many CASES this one skip stands for (default 1). An independent review
# measured the difference: with an empty HOME the suite printed 7 skips while 12 cases had not run,
# because one SKIP line covers the whole launch-marker group. A count that under-reports what was not
# covered is the same failure as not reporting it.
skipped() { skip=$((skip + ${2:-1})); echo "  SKIP  $1${2:+  (covers $2 cases)}"; }
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
  skipped "[mut] the teeth check needs to REACH the reviewer, which this environment cannot do"
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

echo "=== The caller's ceiling is modelled, not assumed ==="
# The Bash tool of the harness that usually calls this wrapper caps one call at max(BASH_MAX_TIMEOUT_MS,
# 120000) ms — 600000 while that variable is unset (read from the CLI binary, not from documentation).
# A declared outer budget above that cap is a promise the caller cannot keep: the run would start and be
# killed into silence. So the wrapper must refuse such a budget BEFORE dispatch — but only when the
# caller IS that harness (it exports CLAUDECODE=1); a terminal or cron caller has no cap, and a
# legitimate long review from there must go through.
# The launch counter is the observable: a refusal reaches the stub ZERO times, a pass reaches it once.
cap_case() { # cap_case <refuse|launch> <description> <env assignments / -u names ...>
  local exp="$1" desc="$2"; shift 2
  local before after rc=0
  before=$(wc -l < "$STUB_LOG")
  printf 'review this\n' | env "$@" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || rc=$?
  after=$(wc -l < "$STUB_LOG")
  if [ "$exp" = refuse ]; then
    if [ "$rc" = 8 ] && [ "$after" = "$before" ]; then pass=$((pass+1)); echo "  PASS rc=8   $desc"
    else fail=$((fail+1)); echo "  FAIL rc=$rc want=8 launches $before->$after  $desc"; fi
  else
    if [ "$CAN_LAUNCH" != 1 ]; then skipped "$desc (this environment cannot reach a reviewer launch)"; return 0; fi
    if [ "$rc" != 8 ] && [ "$after" = $((before + 1)) ]; then pass=$((pass+1)); echo "  PASS rc=$rc   $desc"
    else fail=$((fail+1)); echo "  FAIL rc=$rc launches $before->$after  $desc"; fi
  fi
}
cap_case refuse 'under the harness with both variables unset, a budget above 600000 ms is refused before dispatch' \
  -u BASH_MAX_TIMEOUT_MS -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 "${EP}_OUTER_BUDGET=2460"
cap_case refuse 'under the harness, a budget above a raised-but-still-too-small cap is refused' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 BASH_MAX_TIMEOUT_MS=1800000 "${EP}_OUTER_BUDGET=2460"
# 🔴 The CLI trims and then falls back to parseInt, so the first two ARE honoured by it. Refusing them
# was an over-refusal of a budget the caller could actually grant, and the previous version of this
# case asserted that mistake as correct behaviour.
cap_case launch 'a trailing .0 is honoured by the CLI parser, so it must not read as unset' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 BASH_MAX_TIMEOUT_MS=3600000.0 "${EP}_OUTER_BUDGET=2460"
cap_case launch 'surrounding whitespace is trimmed, as the CLI trims it' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 "BASH_MAX_TIMEOUT_MS= 3600000 " "${EP}_OUTER_BUDGET=2460"
cap_case refuse 'a value with no leading digits is ignored by the CLI too, so the cap stays at its default' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 BASH_MAX_TIMEOUT_MS=abc "${EP}_OUTER_BUDGET=2460"
# Where parseInt and Number disagree the model takes the SMALLER answer on purpose: 1 and 3, not
# 1800000 and 3600000. Under-reading the cap over-refuses loudly; over-reading it gets a run killed silently.
cap_case refuse 'a thousands-separated value reads as its leading digits, the fail-closed answer' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 BASH_MAX_TIMEOUT_MS=1,800,000 "${EP}_OUTER_BUDGET=2460"
# The harness variable is tested for non-empty: a review showed CLAUDECODE=true slipping past an exact '= 1'.
cap_case refuse 'the harness marker is any non-empty value, not exactly 1 (CLAUDECODE=true still guards)' \
  -u BASH_MAX_TIMEOUT_MS -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=true "${EP}_OUTER_BUDGET=2460"
# The binary folds BASH_DEFAULT_TIMEOUT_MS into the cap as well: cap = max(MAX, DEFAULT).
cap_case refuse 'a raised DEFAULT that is still below the budget does not open the gate' \
  -u BASH_MAX_TIMEOUT_MS CLAUDECODE=1 BASH_DEFAULT_TIMEOUT_MS=650000 "${EP}_OUTER_BUDGET=2460"
cap_case launch 'a raised DEFAULT alone (MAX unset) raises the cap exactly as the binary does' \
  -u BASH_MAX_TIMEOUT_MS CLAUDECODE=1 BASH_DEFAULT_TIMEOUT_MS=2500000 "${EP}_OUTER_BUDGET=2460"
cap_case launch 'under the harness with the cap raised far enough, the same budget goes through to the reviewer' \
  -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 BASH_MAX_TIMEOUT_MS=3600000 "${EP}_OUTER_BUDGET=2460"
cap_case launch 'the default budget under the harness with both variables unset goes through (600000 <= 600000)' \
  -u BASH_MAX_TIMEOUT_MS -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1
cap_case launch 'outside the harness (no CLAUDECODE) there is no cap, so a long budget goes through' \
  -u CLAUDECODE -u BASH_MAX_TIMEOUT_MS -u BASH_DEFAULT_TIMEOUT_MS "${EP}_OUTER_BUDGET=2460"
# Teeth: with the guard removed, the over-cap run must REACH the reviewer — the same observable as above.
CAPMUT="$TESTDIR/mutant-cap"
sed -E 's/^if \[ -n "\$\{CLAUDECODE:-\}" \]; then$/if false; then/' "$W" > "$CAPMUT" && chmod +x "$CAPMUT"
if [ "$CAN_LAUNCH" != 1 ]; then
  skipped "[mut] the teeth check needs to REACH the reviewer, which this environment cannot do"
elif ! grep -q '^if false; then$' "$CAPMUT"; then
  fail=$((fail+1)); echo "  FAIL the cap-guard mutation anchor did not match — the mutant is a no-op, so this proves nothing"
else
  before=$(wc -l < "$STUB_LOG"); mrc=0
  printf 'review this\n' | env -u BASH_MAX_TIMEOUT_MS -u BASH_DEFAULT_TIMEOUT_MS CLAUDECODE=1 "${EP}_OUTER_BUDGET=2460" "$CAPMUT" "${OKARGS[@]}" >/dev/null 2>&1 || mrc=$?
  after=$(wc -l < "$STUB_LOG")
  if [ "$mrc" != 8 ] && [ "$after" = $((before + 1)) ]; then
    pass=$((pass+1)); echo "  PASS rc=$mrc  [mut] with the cap guard removed the over-cap run REACHES the reviewer (the guard was the only thing stopping it)"
  else
    fail=$((fail+1)); echo "  FAIL rc=$mrc launches $before->$after  [mut] the mutant was stopped by something else, so this proves nothing"
  fi
fi
: > "$STUB_LOG"   # every launch above is accounted for; later cases start from zero again

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
    skipped "lock path '$LOCKPATH' is outside the throwaway dir; refusing to contend with real runs"
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
  skipped "every case here must reach the launch point; this environment refuses during bootstrap" 6
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

echo "=== The reviewer model: the family is pinned, the version is the newest listed, never a fallback ==="
# Each case points the wrapper at its own models-cache fixture through ${EP}_MODELS_CACHE. The stub
# records the model line of the config it was handed, so resolving to the WRONG version is observable,
# not just "the run did not fail": a wrong version is exactly as quiet as a right one.
MSTUB="$STUB_DIR/model-stub"
printf '#!/bin/sh\necho "MODEL $(sed -n "s/^model = //p" "$CODEX_HOME/config.toml")" >> "%s"\nexit 0\n' "$STUB_LOG" > "$MSTUB"
chmod +x "$MSTUB"
mcache() { # mcache <file> <slug[:visibility|EMPTY|NONE[:effort,effort]]>...
  local f="$1"; shift
  python3 -c '
import json, sys
out = []
for spec in sys.argv[2:]:
    p = spec.split(":")
    levels = p[2].split(",") if len(p) > 2 and p[2] else ["low", "high"]
    vis = p[1] if len(p) > 1 and p[1] else "list"
    m = {"slug": p[0], "supported_reasoning_levels": [{"effort": e} for e in levels]}
    if vis != "NONE":                       # NONE = no visibility key at all
        m["visibility"] = "" if vis == "EMPTY" else vis
    out.append(m)
json.dump({"models": out}, open(sys.argv[1], "w"))
' "$f" "$@"
}
model_case() { # model_case <expected slug | refuse> <description> <cache file> [env assignments...]
  local want="$1" desc="$2" cache="$3"; shift 3
  local rc=0 before after got
  before=$(wc -l < "$STUB_LOG")
  printf 'review this\n' | env "${EP}_CODEX_BIN=$MSTUB" "${EP}_MODELS_CACHE=$cache" "$@" "$W" "${OKARGS[@]}" >/dev/null 2>&1 || rc=$?
  after=$(wc -l < "$STUB_LOG")
  if [ "$want" = refuse ]; then
    if [ "$rc" = 96 ] && [ "$after" = "$before" ]; then
      pass=$((pass+1)); echo "  PASS rc=96  $desc (the reviewer was never launched)"
    else
      fail=$((fail+1)); echo "  FAIL rc=$rc, $((after - before)) launch(es); want rc=96 and none  $desc"
    fi
  elif [ "$CAN_LAUNCH" != 1 ]; then
    skipped "$desc — needs to reach the reviewer to read the model it was handed"
  else
    got=$(tail -n 1 "$STUB_LOG" | sed -n 's/^MODEL //p')
    if [ "$after" = $((before + 1)) ] && [ "$got" = "\"$want\"" ]; then
      pass=$((pass+1)); echo "  PASS $desc -> $want"
    else
      fail=$((fail+1)); echo "  FAIL got ${got:-nothing} after $((after - before)) launch(es); want \"$want\"  $desc"
    fi
  fi
}
MC="$TESTDIR/models-cache"; mkdir -p "$MC"
mcache "$MC/newest.json" gpt-5.6-sol gpt-6-sol gpt-6-luna
model_case gpt-6-sol "the newest version of the family wins; other families do not count" "$MC/newest.json"
model_case gpt-6-sol "serial mode fills the same model into its own config" "$MC/newest.json" "${EP}_MODE=serial"
mcache "$MC/numeric.json" gpt-9-sol gpt-10-sol
model_case gpt-10-sol "versions compare as numbers (10 > 9), not as strings" "$MC/numeric.json"
mcache "$MC/skip.json" gpt-6-sol gpt-7-sol:hide gpt-8-sol::low
model_case gpt-6-sol "a hidden newer version and one without high effort are both skipped" "$MC/skip.json"
mcache "$MC/none.json" gpt-6-luna gpt-5.5
model_case refuse "no listed version of the family: refuse, never fall back to another model" "$MC/none.json"
model_case refuse "a models cache that cannot be read: refuse" "$MC/does-not-exist.json"
: > "$STUB_LOG"

echo "=== The brief fingerprint: what the reviewer was fed, hashed where the driver can check it ==="
# Expected values come from an independent implementation (python hashlib over the same canonical form),
# never from the function under test.
canon_sha() { python3 -c '
import hashlib, sys
lines = [l.rstrip(" \t\r") for l in sys.stdin.buffer.read().decode("utf-8").split("\n")]
while lines and lines[-1] == "": lines.pop()
while lines and lines[0] == "": lines.pop(0)
print(hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest())'; }

two="$(printf 'VERDICT: APPROVE\nEND\nVERDICT: APPROVE\nEND\n' \
      | bash -c "source <(sed -n '/^_emit_rc_inject()/,/^}/p' '$W'); _emit_rc_inject 0 abc123")"
if [ "$(printf '%s\n' "$two" | grep -c '^__BRIEF_SHA256=abc123$')" = 2 ] && \
   [ "$(printf '%s\n' "$two" | grep -A1 '^__BRIEF_SHA256=abc123$' | grep -c "^__${RCM}=0\$")" = 2 ]; then
  pass=$((pass+1)); echo "  PASS every block carries the fingerprint, right above its exit-code marker (duplicate blocks stay identical)"
else fail=$((fail+1)); echo "  FAIL the fingerprint is not in every block directly above the exit-code marker"; fi

BF="$TESTDIR/brief-canon.txt"
printf '\n  \nTASK: café — naïve check\t \r\nsecond line  \n\n\n' > "$BF"
got_sha="$(bash -c "source <(sed -n '/^_brief_sha()/,/^}/p' '$W'); _brief_sha '$BF'")"
want_sha="$(canon_sha < "$BF")"
if [ -n "$got_sha" ] && [ "$got_sha" = "$want_sha" ]; then
  pass=$((pass+1)); echo "  PASS the canonical form drops trailing blanks, CR and blank edge lines exactly as the driver does"
else fail=$((fail+1)); echo "  FAIL _brief_sha=$got_sha, independent=$want_sha"; fi

printf 'line one\rstill line one\nsecond\n' > "$BF"
got_sha="$(bash -c "source <(sed -n '/^_brief_sha()/,/^}/p' '$W'); _brief_sha '$BF'")"
want_sha="$(canon_sha < "$BF")"
if [ -n "$got_sha" ] && [ "$got_sha" = "$want_sha" ]; then
  pass=$((pass+1)); echo "  PASS a lone CR inside a line is kept, not translated to a newline (the driver keeps it too)"
else fail=$((fail+1)); echo "  FAIL lone CR: _brief_sha=$got_sha, independent=$want_sha"; fi

VSTUB="$STUB_DIR/verdict-stub"
printf '#!/bin/sh\ncat > /dev/null\necho "LAUNCH" >> "%s"\nprintf "VERDICT: APPROVE\\nP0: none\\nEND\\n"\nexit 0\n' "$STUB_LOG" > "$VSTUB"
chmod +x "$VSTUB"
SHA_WANT="$(printf 'review this\n' | canon_sha)"
sha_case() { # sha_case <description> <wrapper> [env assignments...]
  local desc="$1" wrapper="$2"; shift 2
  local out
  out="$(printf 'review this\n' | env "${EP}_CODEX_BIN=$VSTUB" "$@" "$wrapper" "${OKARGS[@]}" 2>/dev/null)"
  printf '%s\n' "$out" | sed -n '/^VERDICT:/,/^END$/p' | grep -qx "__BRIEF_SHA256=$SHA_WANT"
}
if [ "$CAN_LAUNCH" != 1 ]; then
  skipped "the fingerprint of a real dispatch needs to reach the reviewer" 3
else
  if sha_case "isolated" "$W"; then pass=$((pass+1)); echo "  PASS isolated mode: the verdict block carries the fingerprint of exactly the brief that was sent"
  else fail=$((fail+1)); echo "  FAIL isolated mode: no correct __BRIEF_SHA256 inside the verdict block"; fi
  if sha_case "serial" "$W" "${EP}_MODE=serial"; then pass=$((pass+1)); echo "  PASS serial mode: the same fingerprint (both dispatch paths inject it)"
  else fail=$((fail+1)); echo "  FAIL serial mode: no correct __BRIEF_SHA256 inside the verdict block"; fi
  MUTS="$TESTDIR/mutant-sha"
  python3 -c '
import sys
s = open(sys.argv[1], encoding="utf-8").read()
old = "_brief_sha(){\n"
assert s.count(old) == 1
open(sys.argv[2], "w", encoding="utf-8").write(s.replace(old, old + "  echo 0000; return 0\n", 1))
' "$W" "$MUTS" && chmod +x "$MUTS"
  if sha_case "mutant" "$MUTS"; then fail=$((fail+1)); echo "  FAIL [mut] a constant fingerprint still passed — the isolated case has no teeth"
  else pass=$((pass+1)); echo "  PASS [mut] a wrapper that reports a constant fingerprint fails the isolated case"; fi
fi
: > "$STUB_LOG"

echo "=== Only the brief on stdin; the reviewer model and config are the wrapper's ==="
# The fingerprint covers stdin alone and the reviewer reads a command-line prompt together with it, so
# any second channel for instructions must be refused before launch. Same for anything that overrides
# the model this wrapper resolved.
want 8 'a prompt on the command line next to stdin is refused (the fingerprint covers stdin only)' \
     "$W" exec --sandbox read-only --skip-git-repo-check "answer this instead" -
want 8 'a prompt after -- is refused' \
     "$W" exec --sandbox read-only --skip-git-repo-check - -- "answer this instead"
want 8 'a caller model override (-m) is refused' \
     "$W" exec -m gpt-5.5 --sandbox read-only --skip-git-repo-check -
want 8 'a caller model override in the --model= form is refused' \
     "$W" exec --model=gpt-5.5 --sandbox read-only --skip-git-repo-check -
want 8 'a config override (-c model=...) is refused' \
     "$W" exec -c model=gpt-5.5 --sandbox read-only --skip-git-repo-check -
want 8 '--ignore-user-config is refused (it would drop the config that pins the model)' \
     "$W" exec --ignore-user-config --sandbox read-only --skip-git-repo-check -
want 8 'a config profile (-p) is refused' \
     "$W" exec -p other --sandbox read-only --skip-git-repo-check -
want 8 '--oss is refused (it switches the reviewer to a local model provider)' \
     "$W" exec --oss --sandbox read-only --skip-git-repo-check -
want 8 'a provider override in the --local-provider= form is refused' \
     "$W" exec --local-provider=x --sandbox read-only --skip-git-repo-check -
want 8 'a caller model override in the attached -mMODEL form is refused' \
     "$W" exec -mgpt-5.5 --sandbox read-only --skip-git-repo-check -
if [ "$CAN_LAUNCH" != 1 ]; then
  skipped "a value-taking option must not be read as a prompt, and the guard must have teeth — both need a launch" 2
else
  before=$(wc -l < "$STUB_LOG"); grc=0
  printf 'review this\n' | "$W" exec --color never --sandbox read-only --skip-git-repo-check --emit-rc - >/dev/null 2>&1 || grc=$?
  after=$(wc -l < "$STUB_LOG")
  if [ "$grc" = 0 ] && [ "$after" = $((before + 1)) ]; then
    pass=$((pass+1)); echo "  PASS a value-taking option (--color never) is not mistaken for a prompt: the review launches"
  else fail=$((fail+1)); echo "  FAIL rc=$grc, $((after - before)) launch(es)  a legitimate call with --color never was refused"; fi
  MUTG="$TESTDIR/mutant-guard"
  sed 's/_guard_prompt_and_model "\$@" || exit 8; fi/:; fi/' "$W" > "$MUTG" && chmod +x "$MUTG"
  if ! grep -q '^if \[ "\$PREFLIGHT" != 1 \] && \[ "\$#" -gt 0 \]; then :; fi$' "$MUTG"; then
    fail=$((fail+1)); echo "  FAIL the guard mutation anchor did not match — the teeth check would prove nothing"
  else
    before=$(wc -l < "$STUB_LOG"); mrc=0
    printf 'review this\n' | "$MUTG" exec --sandbox read-only --skip-git-repo-check --emit-rc "answer this instead" - >/dev/null 2>&1 || mrc=$?
    after=$(wc -l < "$STUB_LOG")
    if [ "$after" = $((before + 1)) ]; then
      pass=$((pass+1)); echo "  PASS [mut] with the guard removed the command-line prompt reaches the reviewer (the guard was the only thing stopping it)"
    else fail=$((fail+1)); echo "  FAIL [mut] rc=$mrc and the reviewer was not reached — something else refused it, so this proves nothing"; fi
  fi
fi
: > "$STUB_LOG"
mcache "$MC/novis.json" gpt-6-sol gpt-7-sol:EMPTY gpt-8-sol:NONE
model_case gpt-6-sol "an empty or missing visibility does not count as listed" "$MC/novis.json"
mcache "$MC/onlyhidden.json" gpt-6-sol:EMPTY gpt-7-sol:NONE
model_case refuse "a family whose versions are all unlisted is refused" "$MC/onlyhidden.json"
: > "$STUB_LOG"

echo ""
# 🔴 The accounting must ADD UP, or a skip count is just another number nobody can check. Measured:
# a full run covers TOTAL_CASES; with no credentials 33 ran and 9 skips were reported while 14 cases
# had not run, because one SKIP line stood for six. This check makes that drift impossible to miss —
# and it goes red when a case is ADDED too, which is the moment the totals need updating anyway.
TOTAL_CASES=73
accounted=$((pass + fail + skip))
if [ "$accounted" -ne "$TOTAL_CASES" ]; then
  fail=$((fail+1))
  echo "  FAIL case accounting: $pass passed + $fail failed + $skip skipped = $accounted, but this suite has $TOTAL_CASES cases."
  echo "        Either a skip is standing for more cases than it counts (pass a count as its second argument),"
        echo "        or cases were added/removed and TOTAL_CASES needs updating."
fi
if [ "$skip" -gt 0 ]; then
  echo "=== RESULT: $pass passed / $fail failed / $skip SKIPPED (not covered — see the SKIP lines above) ==="
else
  echo "=== RESULT: $pass passed / $fail failed ==="
fi
[ "$fail" -eq 0 ]
