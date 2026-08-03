#!/usr/bin/env bash
# The reviewer agent definition declares a timeout contract. This checks that the declaration is
# still there AND still agrees with the wrapper's own limits.
#
# 🔴 WHY THIS FILE REPLACED TWO grep CALLS. The first version asserted that the strings `580000` and
#    `120000` appeared somewhere in the definition. An independent review took it apart in one move:
#    rewrite the paragraph to say "the default of 120000 ms is applied automatically… the historical
#    advice to pass 580000 has been withdrawn" and both greps still print PASS. Worse, one of the two
#    figures occurs in incidental prose about the tool maximum, so simply DELETING the operative
#    sentence already leaves both numbers in the file. A gate that reads as present and is not is
#    worse than no gate, because it is what the next person checks instead of the document.
#
# What is checked instead: a structured contract line, plus a CROSS-FILE invariant against the
# wrapper's real defaults. That second half is the part no rewording can satisfy — if someone raises
# the wrapper's own timeout past what the definition tells seats to ask for, the arithmetic stops
# holding and this goes red, whatever the prose says.
#
# ⚠️ HONEST BOUNDARY, stated because the previous version's failure was overclaiming: this proves the
#    DOCUMENT declares a coherent timeout. It cannot prove a seat obeyed it. The value is a parameter
#    chosen by whichever model runs the seat, and no code in this repository is on that path. The
#    mechanical half of that problem is handled elsewhere — the wrapper's launch marker makes a seat
#    that was killed report `LAUNCHED_BUT_NO_VERDICT` instead of looking like one that found nothing.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTDEF="${DUAL_AUDIT_AGENTDEF:-$HERE/../runtime/codex-auditor/dual-audit-codex-readonly.md}"
WRAPPER="${DUAL_AUDIT_WRAPPER:-$HERE/../runtime/codex-auditor/dual-audit-codex}"
# 🔴 The caller's real limits live HERE, not in the document being graded. Second review finding:
#    conditions (1) and (3) read tool_default_ms and tool_max_ms out of the very file under test, so
#    they compared the document to itself. A marker saying `tool_max_ms=9999999 tool_default_ms=1`
#    with matching prose passed, although the real maximum is 600000. A checker that lets the thing
#    it grades supply the standard is not a checker.
TOOL_DEFAULT_MS=120000   # Claude Code Bash tool: default when the call omits `timeout`
TOOL_MAX_MS=600000       # Claude Code Bash tool: the largest value it accepts
D="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-agentdef.XXXXXX")" || exit 2
trap 'rm -rf "$D"' EXIT
pass=0; fail=0

# check_contract <agentdef> <wrapper> -> 0 ok, 1 refused (reason on stderr)
check_contract() {
  local ad="$1" wr="$2" line req dflt max to ka budget
  line="$(grep -o 'dual-audit:bash-timeout-contract[^>]*' "$ad" | head -1)"
  [ -n "$line" ] || { echo "no bash-timeout-contract marker in $ad" >&2; return 1; }
  req="$(printf '%s' "$line"  | sed -n 's/.*required_ms=\([0-9]\+\).*/\1/p')"
  dflt="$(printf '%s' "$line" | sed -n 's/.*tool_default_ms=\([0-9]\+\).*/\1/p')"
  max="$(printf '%s' "$line"  | sed -n 's/.*tool_max_ms=\([0-9]\+\).*/\1/p')"
  [ -n "$req" ] && [ -n "$dflt" ] && [ -n "$max" ] || { echo "contract marker does not carry all three integers" >&2; return 1; }

  to="$(grep -oP "^_numenv\s+TIMEOUT\s+\S+\s+\K[0-9]+" "$wr" | head -1)"
  ka="$(grep -oP "^_numenv\s+KILL_AFTER\s+\S+\s+\K[0-9]+" "$wr" | head -1)"
  [ -n "$to" ] && [ -n "$ka" ] || { echo "could not read TIMEOUT/KILL_AFTER from $wr" >&2; return 1; }
  budget=$(( (to + ka) * 1000 ))

  # (0) The declared tool limits must match the ones this checker knows independently. Without this
  #     the document sets its own bar, and (1) and (3) below become tautologies.
  [ "$max" = "$TOOL_MAX_MS" ] || { echo "the marker declares tool_max_ms=$max but the tool's real maximum is $TOOL_MAX_MS" >&2; return 1; }
  [ "$dflt" = "$TOOL_DEFAULT_MS" ] || { echo "the marker declares tool_default_ms=$dflt but the tool's real default is $TOOL_DEFAULT_MS" >&2; return 1; }
  # (1) Cannot ask for more than the caller's tool actually allows (the anchor, not the claim).
  [ "$req" -le "$TOOL_MAX_MS" ] || { echo "required_ms=$req exceeds the tool maximum $TOOL_MAX_MS — a seat cannot ask for it" >&2; return 1; }
  # (2) The wrapper must reach its OWN limit first, or it is killed into silence instead of failing loudly.
  [ "$req" -gt "$budget" ] || { echo "required_ms=$req does not exceed the wrapper's own TIMEOUT+KILL_AFTER (${budget}ms) — the wrapper would be killed before it could fail loudly" >&2; return 1; }
  # (3) The instruction only earns its place if the tool default is genuinely too short. Should the
  #     wrapper ever become fast enough to fit inside the default, this fires and says so, rather
  #     than leaving a stale requirement nobody rechecks.
  [ "$TOOL_DEFAULT_MS" -lt "$budget" ] || { echo "the tool default ${TOOL_DEFAULT_MS}ms already covers the wrapper's ${budget}ms — the stated requirement is obsolete, not merely unnecessary" >&2; return 1; }
  # (4) The prose a human reads and the contract a machine reads must agree on the number.
  grep -q "timeout: $req" "$ad" || { echo "the prose does not show the copy-pasteable form 'timeout: $req'" >&2; return 1; }
  return 0
}

echo "=== The shipped definition satisfies its own contract ==="
if check_contract "$AGENTDEF" "$WRAPPER" 2>"$D/err"; then
  pass=$((pass+1)); echo "  PASS the declared timeout is arithmetically coherent with the wrapper and the tool's real limits"
  echo "        (NOT proven: that any seat obeyed it, nor that the prose still instructs it — see the KNOWN GAP below)"
else
  fail=$((fail+1)); echo "  FAIL $(cat "$D/err")"
fi

echo "=== Deleting the operative sentence must be refused ==="
# One of the two figures lives in incidental prose about the tool maximum, so removing just the
# imperative line used to leave the original grep-based gate green.
grep -v 'timeout: 580000' "$AGENTDEF" > "$D/nosentence.md"
if check_contract "$D/nosentence.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL removing the copy-pasteable instruction still passes"
else
  pass=$((pass+1)); echo "  PASS removing the copy-pasteable instruction is refused"
fi

echo "=== The cross-file invariant: raising the wrapper's timeout must break a stale contract ==="
# The realistic future failure, and the one no rewording can fake: the wrapper gets a longer budget
# and the definition silently stops being right.
sed -E 's/^(_numenv[[:space:]]+TIMEOUT[[:space:]]+\S+[[:space:]]+)[0-9]+/\1900/' "$WRAPPER" > "$D/slow-wrapper"
if ! grep -qE '^_numenv[[:space:]]+TIMEOUT[[:space:]]+\S+[[:space:]]+900' "$D/slow-wrapper"; then
  fail=$((fail+1)); echo "  FAIL the fixture did not actually raise TIMEOUT — this case proves nothing"
elif check_contract "$AGENTDEF" "$D/slow-wrapper" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a wrapper whose own timeout now exceeds what seats are told to ask for still passes"
else
  pass=$((pass+1)); echo "  PASS a wrapper timeout raised past the declared requirement is caught"
fi

# Its mirror: asking for LESS than the wrapper needs. Without this, condition (2) is only tested in
# one direction and would pass a check that fires on everything above some floor.
sed 's/required_ms=580000/required_ms=560000/' "$AGENTDEF" | sed 's/timeout: 580000/timeout: 560000/' > "$D/toosmall.md"
if check_contract "$D/toosmall.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL required_ms below the wrapper's own TIMEOUT+KILL_AFTER passes — the wrapper would be killed before it could fail loudly"
else
  pass=$((pass+1)); echo "  PASS required_ms below the wrapper's own budget is refused"
fi

echo "=== The document may not declare its own standard ==="
# 🔴 Second review finding, reproduced as fixtures. Conditions (1) and (3) used to read the tool's
#    limits out of the file being graded, so a marker could move the goalposts and pass. Neither of
#    these had a fixture, and deleting either condition left the suite fully green — "five negative
#    fixtures" covered two conditions with teeth, not four.
# ⚠️ ONE knob per fixture. The first version moved tool_max_ms AND required_ms together, so the two
#    conditions covered each other: delete either and the other still caught the fixture, and a
#    per-condition mutation showed BOTH reading as untested. A fixture that trips two guards at once
#    proves neither.
sed 's/tool_max_ms=600000/tool_max_ms=9999999/' "$AGENTDEF" > "$D/movedbar.md"
if check_contract "$D/movedbar.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a document that overstates the tool maximum passes (it may not declare its own standard)"
else
  pass=$((pass+1)); echo "  PASS a document that overstates the tool maximum is refused"
fi

sed 's/required_ms=580000/required_ms=900000/' "$AGENTDEF" | sed 's/timeout: 580000/timeout: 900000/' > "$D/overmax.md"
if check_contract "$D/overmax.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a requirement above the tool's real maximum passes — no seat could ever ask for it"
else
  pass=$((pass+1)); echo "  PASS a requirement above the tool's real maximum is refused"
fi

sed 's/tool_default_ms=120000/tool_default_ms=1/' "$AGENTDEF" > "$D/tinydefault.md"
if check_contract "$D/tinydefault.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a document may misstate the tool default"
else
  pass=$((pass+1)); echo "  PASS a document that misstates the tool default is refused"
fi

echo "=== A requirement that is no longer needed must be reported, not left standing ==="
# The only way condition (3) can fire: a wrapper fast enough to finish inside the tool's default.
# Without this fixture that condition read as untested — deleting it left the suite fully green.
sed -E 's/^(_numenv[[:space:]]+TIMEOUT[[:space:]]+\S+[[:space:]]+)[0-9]+/\130/' "$WRAPPER" \
  | sed -E 's/^(_numenv[[:space:]]+KILL_AFTER[[:space:]]+\S+[[:space:]]+)[0-9]+/\15/' > "$D/fast-wrapper"
if ! grep -qE '^_numenv[[:space:]]+TIMEOUT[[:space:]]+\S+[[:space:]]+30' "$D/fast-wrapper"; then
  fail=$((fail+1)); echo "  FAIL the fixture did not actually lower TIMEOUT — this case proves nothing"
elif check_contract "$AGENTDEF" "$D/fast-wrapper" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a wrapper that now fits inside the tool default still passes — the instruction is obsolete and nothing says so"
else
  pass=$((pass+1)); echo "  PASS a wrapper that fits inside the tool default makes the standing requirement report as obsolete"
fi

echo "=== A missing contract marker is refused ==="
sed 's/^<!-- dual-audit:bash-timeout-contract.*$//' "$AGENTDEF" > "$D/nomarker.md"
if check_contract "$D/nomarker.md" "$WRAPPER" 2>/dev/null; then
  fail=$((fail+1)); echo "  FAIL a definition with no contract marker passes"
else
  pass=$((pass+1)); echo "  PASS a definition with no contract marker is refused"
fi

echo "=== KNOWN GAP, printed every run so nobody mistakes silence for coverage ==="
# 🔴 DO NOT convert this into a PASS. Two independent reviewers demonstrated it: append
#    "the advice to pass `timeout: 580000` has been withdrawn, do not set a timeout" to an OTHERWISE
#    UNTOUCHED definition and every condition above is still satisfied — the marker is intact, the
#    arithmetic holds, the copy-pasteable form is present. The previous fixture claimed to cover this
#    and did not: it deleted the marker as well, so it was testing "marker missing" instead.
#    This is NOT fixable here. Deciding whether a paragraph still INSTRUCTS something, as opposed to
#    reporting that it once did, is exactly the natural-language judgement this project concluded
#    cannot be done lexically (see the non-answer detection in the panel: an enumerated phrase list
#    was broken in four consecutive reviews and was replaced by a structural test).
#    The mechanical backstop for the underlying risk lives elsewhere and does not depend on prose:
#    the wrapper's launch marker makes a seat that was killed report LAUNCHED_BUT_NO_VERDICT rather
#    than looking like a reviewer that found nothing.
cp "$AGENTDEF" "$D/withdrawn.md"
cat >> "$D/withdrawn.md" <<'EOF'
The advice to pass `timeout: 580000` has been withdrawn; do not set a timeout.
EOF
if check_contract "$D/withdrawn.md" "$WRAPPER" 2>/dev/null; then
  echo "  GAP   prose that WITHDRAWS the requirement while leaving the marker intact is NOT detected."
  echo "        Undecidable lexically; not counted as a pass or a failure. Backstop: LAUNCHED_BUT_NO_VERDICT."
else
  fail=$((fail+1)); echo "  FAIL the known gap no longer reproduces — this note is stale and must be re-derived before it is trusted"
fi

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
