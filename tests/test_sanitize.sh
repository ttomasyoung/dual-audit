#!/usr/bin/env bash
# Tests for the pre-publication scanner.
#
# A scanner that never fires is worse than no scanner, because it produces confidence without
# evidence. So each case plants ONE forbidden pattern in a throwaway tree and requires the
# scanner to find it, and a clean tree must pass. The repository itself is scanned last.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SCAN="$REPO/scripts/sanitize-scan.sh"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS $*"; }
bad() { fail=$((fail+1)); echo "  FAIL $*"; }

plant() { # plant <filename> <content>; returns the scanner's exit code
  local d; d="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-scan.XXXXXX")"
  printf '%s\n' "$2" > "$d/$1"
  bash "$SCAN" "$d" >/dev/null 2>&1
  local rc=$?
  rm -rf "$d"
  return $rc
}

echo "=== The scanner catches each forbidden pattern ==="
plant a.md '/home/somebody/secret/path.txt' && bad "a personal home path was NOT caught" || ok "a personal home path is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant b.md 'contact: someone@example.com'   && bad "an e-mail address was NOT caught"   || ok "an e-mail address is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant c.md 'fixed on 2026-07-24 after round three' && bad "an internal dated history note was NOT caught" || ok "a dated history note is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant d.md '这是一段中文说明'                && bad "non-English source text was NOT caught" || ok "non-English source text is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)

# The release date. A changelog heading is the one place a date belongs in a public repository, and
# every release produces one — so it is exempt by shape AND by file. Both halves are tested: the
# exemption was written shape-only first, and a date dressed as a version heading then passed in any
# file at all. A relaxation without its own bad case is how a gate quietly stops being one.
plant CHANGELOG.md '## [0.1.0] — 2026-07-28' && ok "a changelog release heading is allowed" || bad "the release heading a real changelog needs is refused"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant CHANGELOG.md 'Fixed on 2026-07-24 after the third review round.' && bad "a dated prose line in the changelog was NOT caught" || ok "a dated line elsewhere in the changelog is still caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant docs.md '## [9.9.9] — 2026-07-24' && bad "a version heading in another file was NOT caught" || ok "the exemption does not apply outside the changelog"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant e.md 'api_key = A1b2C3d4E5f6G7h8J9k0LmNo' && bad "an API key was NOT caught" || ok "an API-key assignment is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant f.md '-----BEGIN RSA PRIVATE KEY-----'  && bad "a private key was NOT caught"  || ok "a private key block is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)

# Provider-shaped credentials. A generic "api_key = ..." rule does not match any of these: a token
# is a bare word with no assignment beside it, and an access key id looks like ordinary uppercase
# text. The fixtures below are syntactically valid shapes and deliberately not real credentials.
plant j.md 'ghp_0123456789abcdefghijklmnopqrstuvwx' && bad "a token was NOT caught" || ok "a provider token shape is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant k.md 'AKIAIOSFODNN7EXAMPLE'                  && bad "an access key id was NOT caught" || ok "an access key id shape is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)

# "A path that identifies a machine or an account" is the category. It was only ever /home and
# /Users, so the account whose home is /root, and every Windows path, went straight through.
plant l.md 'see /root/notes.txt for the rest'      && bad "a /root path was NOT caught" || ok "a root home path is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
plant m.md 'C:\Users\Someone\Desktop\notes.txt'    && bad "a Windows user path was NOT caught" || ok "a Windows user path is caught"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)

echo "=== The scanner does NOT misfire ==="
plant g.md 'A perfectly ordinary English sentence about review protocols.' && ok "a clean file passes" || bad "a clean file was rejected"
plant h.md 'This line mentions /home/user/ deliberately. sanitize-scan:allow' && ok "an explicitly marked line is exempt" || bad "the exemption marker does not work"

echo "=== History is content too, not just an author line ==="
# One identity for all three throwaway fixture repositories. It lives in a variable because the
# lines that use it are continuations, and the exemption marker has to sit at the end of a line.
FIXTURE_NAME='Test'
FIXTURE_EMAIL='test@example.invalid'   # sanitize-scan:allow (a throwaway fixture repository needs an identity)
FIXTURE_ID="$FIXTURE_NAME <$FIXTURE_EMAIL>"
# Publishing a repository publishes every commit in it. A secret deleted in a later commit is still
# there, and so is every commit message — so a scan of the working tree plus the author line reports
# a clean repository while both remain readable to anyone who clones it. This is exactly where a
# rewritten history leaves its traces.
hd="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-hist.XXXXXX")"
git -C "$hd" init -q 2>/dev/null
git -C "$hd" config user.name "$FIXTURE_NAME"; git -C "$hd" config user.email "$FIXTURE_EMAIL"
printf 'ghp_0123456789abcdefghijklmnopqrstuvwx\n' > "$hd/leak.txt"   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
git -C "$hd" add -A >/dev/null 2>&1; git -C "$hd" commit -qm "add notes" >/dev/null 2>&1
rm -f "$hd/leak.txt"
printf 'nothing to see\n' > "$hd/clean.txt"
git -C "$hd" add -A >/dev/null 2>&1; git -C "$hd" commit -qm "remove notes" >/dev/null 2>&1
# The working tree is now clean; only history still holds it.
grep -rq 'ghp_' "$hd" --exclude-dir=.git 2>/dev/null && bad "setup: the secret is still in the working tree" \
  || ok "setup: the working tree no longer contains the secret"
DUAL_AUDIT_ALLOW_GIT_IDENTITY="$FIXTURE_ID" bash "$SCAN" "$hd" >/dev/null 2>&1 \
  && bad "a secret surviving only in history was NOT caught" || ok "a secret surviving only in history is caught"

# And a commit MESSAGE is published just as surely as a file.
hd2="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-hist2.XXXXXX")"
git -C "$hd2" init -q 2>/dev/null
git -C "$hd2" config user.name "$FIXTURE_NAME"; git -C "$hd2" config user.email "$FIXTURE_EMAIL"
printf 'ordinary content\n' > "$hd2/a.txt"
git -C "$hd2" add -A >/dev/null 2>&1
git -C "$hd2" commit -qm "copied from /home/someone/private/tree" >/dev/null 2>&1   # sanitize-scan:allow (the fixture must contain the forbidden pattern)
DUAL_AUDIT_ALLOW_GIT_IDENTITY="$FIXTURE_ID" bash "$SCAN" "$hd2" >/dev/null 2>&1 \
  && bad "a personal path in a commit message was NOT caught" || ok "a personal path in a commit message is caught"

# The good direction: an ordinary history must still pass, or the two checks above would be
# satisfied by a scanner that simply rejects every repository.
hd3="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-hist3.XXXXXX")"
git -C "$hd3" init -q 2>/dev/null
git -C "$hd3" config user.name "$FIXTURE_NAME"; git -C "$hd3" config user.email "$FIXTURE_EMAIL"
printf 'an ordinary file\n' > "$hd3/a.txt"
git -C "$hd3" add -A >/dev/null 2>&1; git -C "$hd3" commit -qm "add an ordinary file" >/dev/null 2>&1
DUAL_AUDIT_ALLOW_GIT_IDENTITY="$FIXTURE_ID" bash "$SCAN" "$hd3" >/dev/null 2>&1 \
  && ok "an ordinary history passes" || bad "an ordinary history was rejected"
rm -rf "$hd" "$hd2" "$hd3"

echo "=== A private vocabulary list can be supplied out of tree ==="
d="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-scan.XXXXXX")"
printf 'Project Umbrella is our internal name\n' > "$d/i.md"
bash "$SCAN" "$d" >/dev/null 2>&1 && ok "an internal code name is not caught by the generic patterns alone" \
  || bad "the generic patterns misfire on ordinary words"
printf 'Project Umbrella\n' > "$d/patterns.txt"
EXTRA_PATTERNS="$d/patterns.txt" bash "$SCAN" "$d" >/dev/null 2>&1 \
  && bad "the supplied vocabulary was NOT applied" || ok "a supplied private vocabulary is applied"
rm -rf "$d"

echo "=== Commit metadata is checked, not assumed ==="
# Publishing a repository publishes its history, and every content scan excludes .git by
# construction — so an author name and e-mail in every commit stayed invisible while the files came
# back clean. Both directions are asserted: an unapproved identity must be reported, and an approved
# one must not, or the check is either useless or unusable.
g="$(mktemp -d "${TMPDIR:-/tmp}/dual-audit-git.XXXXXX")"
git -C "$g" init -q 2>/dev/null
git -C "$g" config user.name "Test Person"
git -C "$g" config user.email "test.person@example.invalid"   # sanitize-scan:allow (the fixture must carry an address for the check to have anything to find)
echo "nothing private here" > "$g/a.md"
git -C "$g" add -A && git -C "$g" -c commit.gpgsign=false commit -qm "x"
out="$(bash "$SCAN" "$g" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'git-identity'; then
  ok "an unapproved commit identity is reported even though the files are clean"
else bad "commit metadata was not checked (rc=$rc)"; fi
approved='Test Person <test.person@example.invalid>'   # sanitize-scan:allow (an approval string necessarily contains the address it approves)
DUAL_AUDIT_ALLOW_GIT_IDENTITY="$approved" bash "$SCAN" "$g" >/dev/null 2>&1 \
  && ok "an explicitly approved identity passes" || bad "an approved identity is still reported"
rm -rf "$g"

echo "=== The exemption marker is never silent ==="
out="$(bash "$SCAN" "$REPO" 2>&1)"
printf '%s' "$out" | grep -q "line(s) are exempt via" \
  && ok "every exempted line is listed rather than silently skipped" \
  || bad "exempted lines are not reported"

echo "=== The repository itself has no CONTENT findings ==="
# The commit-identity decision is deliberately NOT settled here — it is the packager's, and the
# release gate is `scripts/sanitize-scan.sh` with no allowance set, which stays red until they make
# it. This assertion covers everything else, so a content leak cannot hide behind that pending
# decision.
ids="$(git -C "$REPO" log --all --format='%an <%ae>%n%cn <%ce>' 2>/dev/null | sort -u | paste -sd'|' -)"
if DUAL_AUDIT_ALLOW_GIT_IDENTITY="$ids" bash "$SCAN" "$REPO" >/dev/null 2>&1; then
  ok "this repository has no content findings"
else bad "this repository has findings — run scripts/sanitize-scan.sh to see them"; fi

echo ""
echo "=== RESULT: $pass passed / $fail failed ==="
[ "$fail" -eq 0 ]
