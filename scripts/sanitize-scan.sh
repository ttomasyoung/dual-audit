#!/usr/bin/env bash
# sanitize-scan.sh — refuse to ship anything carrying private content.
#
# Scans the whole working tree (tracked or not) for credentials, personal
# paths, e-mail addresses, and internal design/incident history, and for
# non-English source text outside the sanctioned translated documents.
#
#   exit 0 = clean, 1 = findings, 2 = scanner could not run
#
# A line may be exempted with the marker  sanitize-scan:allow  — use it only
# where a pattern is deliberately being *named as forbidden* (this file, and
# the tests that prove the scanner works).
#
# Packagers who fork this project usually also have a private vocabulary that
# must never ship (internal code names, host names, customer names). Put one
# extended-regex per line in a file and point EXTRA_PATTERNS at it; the file
# itself is never read into the repository:
#
#   EXTRA_PATTERNS=.private-terms scripts/sanitize-scan.sh
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MARK='sanitize-scan:allow'
RPT="$(mktemp "${TMPDIR:-/tmp}/dual-audit-sanitize.XXXXXX")" || exit 2
trap 'rm -f "$RPT"' EXIT

GREP_OPTS=(-rInE --binary-files=without-match
           --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.tmp
           --exclude=.private-terms)   # a packager's local vocabulary file is never shipped

scan() { # scan <label> <extended-regex>
  local label="$1" re="$2"
  grep "${GREP_OPTS[@]}" -- "$re" "$ROOT" 2>/dev/null \
    | grep -vF "$MARK" \
    | sed "s#^#[$label] #" >> "$RPT" || true
}

# 1. Credentials and secrets. The provider-specific shapes are here because a generic
#    "api_key = ..." rule does not match them: a GitHub token is a bare word with no assignment
#    next to it, and an AWS key id looks like ordinary uppercase text to every rule above.
scan secret '(-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_/+-]{16,}|"refresh_token"[[:space:]]*:[[:space:]]*"[^"]+"|sk-[A-Za-z0-9]{20,})'
scan secret-provider '(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)'

# 2. Personal home directories. Installed paths must be derived at runtime.
#    /root and the Windows shapes are included because "a path that identifies a machine or an
#    account" is the category, not "a path under /home".
scan personal-path '(/home/[a-z][a-z0-9_-]+/|/Users/[a-z][a-z0-9_-]+/|/root/[a-zA-Z0-9._-]|[Cc]:\\Users\\[A-Za-z0-9._-]+|\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+)'

# 3. E-mail addresses.
scan email '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

# 4. Internal design and incident history. Public documentation describes how
#    the system behaves, not the dated review log that produced it.
scan history '(20[0-9]{2}-[01][0-9]-[0-3][0-9]|round [0-9]+ of the internal|incident log)'   # sanitize-scan:allow

# 5. Non-English source text outside the sanctioned translated documents.
grep -rInP '[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}\x{ac00}-\x{d7af}]' \
     --binary-files=without-match \
     --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.tmp \
     --exclude='*.zh-CN.md' --exclude='.private-terms' \
     -- "$ROOT" 2>/dev/null \
  | grep -vF "$MARK" \
  | sed 's#^#[non-english-outside-translated-doc] #' >> "$RPT" || true

# 6. Optional private vocabulary supplied by the packager.
if [ -n "${EXTRA_PATTERNS:-}" ]; then
  if [ ! -r "$EXTRA_PATTERNS" ]; then
    echo "sanitize-scan: EXTRA_PATTERNS='$EXTRA_PATTERNS' is not readable" >&2
    exit 2
  fi
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    scan private-term "$pat"
  done < "$EXTRA_PATTERNS"
fi

# 7. Git metadata. Publishing a repository publishes its HISTORY, and everything above is blind to
#    it by construction: .git is excluded from every scan, so a real name and e-mail in every commit
#    stayed invisible while the file contents came back clean. Fail closed — publishing under your
#    own name is a fine decision, but it has to be a decision.
#
#    To record that decision, list the identities that may ship, separated by '|':
#      DUAL_AUDIT_ALLOW_GIT_IDENTITY='Jane Doe <jane@example.org>' scripts/sanitize-scan.sh   # sanitize-scan:allow (an example naming the pattern it is about)
if [ -e "$ROOT/.git" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[git-identity] $ROOT/.git exists but git is not installed — commit metadata could NOT be checked" >> "$RPT"
  else
    git_ids="$(git -C "$ROOT" log --all --format='%an <%ae>%n%cn <%ce>' 2>/dev/null | sort -u)"
    git_n="$(git -C "$ROOT" rev-list --all --count 2>/dev/null || echo 0)"
    if [ "${git_n:-0}" -gt 0 ] && [ -z "$git_ids" ]; then
      echo "[git-identity] could not read commit metadata from $ROOT/.git — treat this as UNCHECKED, not clean" >> "$RPT"
    fi
    while IFS= read -r who; do
      [ -z "$who" ] && continue
      case "|${DUAL_AUDIT_ALLOW_GIT_IDENTITY:-}|" in
        *"|$who|"*) continue ;;
      esac
      echo "[git-identity] commit metadata carries: $who  (set DUAL_AUDIT_ALLOW_GIT_IDENTITY if this is intended)" >> "$RPT"
    done <<< "$git_ids"

    # 7b. The history's CONTENT, not just who wrote it. A file removed in a later commit is still in
    #     the repository and still published; so is every commit MESSAGE. Checking the working tree
    #     and the author line together still leaves both of those unread — which is exactly where a
    #     rewritten history leaves its traces.
    #
    #     Deliberately narrower than the working-tree rules: history is checked for the categories
    #     that cannot be argued with — credentials and personal paths. Prose rules like the date
    #     pattern would fire on every ordinary commit message that mentions a date.
    HIST_RE='(-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|/home/[a-z][a-z0-9_-]+/|/Users/[a-z][a-z0-9_-]+/|/root/[a-zA-Z0-9._-])'
    #     The exemption marker applies here too — a fixture that must contain a forbidden pattern is
    #     just as exempt in history as in the working tree — and the commit hash is stripped before
    #     de-duplicating, so a line present in twenty commits is reported once rather than twenty
    #     times. Without that the real finding would be buried in its own repetitions.
    git -C "$ROOT" rev-list --all 2>/dev/null > "$RPT.revs" || : > "$RPT.revs"
    if [ -s "$RPT.revs" ]; then
      mapfile -t _revs < "$RPT.revs"
      git -C "$ROOT" grep -InE --no-color -e "$HIST_RE" "${_revs[@]}" 2>/dev/null \
        | grep -vF "$MARK" \
        | sed -E 's#^[0-9a-f]{7,40}:##' \
        | sort -u | head -50 \
        | sed 's#^#[git-history-content] #' >> "$RPT" || true
    fi
    rm -f "$RPT.revs"
    git -C "$ROOT" log --all --format='%B' 2>/dev/null \
      | grep -E -- "$HIST_RE" 2>/dev/null | grep -vF "$MARK" \
      | sort -u | head -20 | sed 's#^#[git-history-message] #' >> "$RPT" || true
  fi
fi

# The exemption marker is a whole-line escape, so a silent count of it is a place private content
# can hide in plain sight. Every marked line is listed, whether or not anything else was found.
ALLOWED="$(grep -rIn --binary-files=without-match \
           --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.tmp \
           -F "$MARK" -- "$ROOT" 2>/dev/null || true)"
allowed_n="$(printf '%s' "$ALLOWED" | grep -c . || true)"

report_allowed() {
  [ "${allowed_n:-0}" -gt 0 ] || return 0
  echo ""
  echo "NOTE: $allowed_n line(s) are exempt via '$MARK'. The marker exempts the WHOLE line,"
  echo "      so read them rather than trusting this summary:"
  printf '%s\n' "$ALLOWED" | sed 's/^/      /'
}

n="$(wc -l < "$RPT" | tr -d ' ')"
if [ "${n:-0}" -gt 0 ]; then
  echo "FAIL sanitize-scan: $n finding(s) — this tree is not safe to publish"
  echo "------------------------------------------------------------------"
  cat "$RPT"
  echo "------------------------------------------------------------------"
  echo "Fix the lines above, or mark a line that legitimately names a forbidden"
  echo "pattern with: $MARK"
  report_allowed
  exit 1
fi
echo "OK sanitize-scan: no secrets, personal paths, e-mail addresses, internal history,"
echo "   non-English source text, or unapproved commit identities found${EXTRA_PATTERNS:+ (private vocabulary list applied)}"
report_allowed
exit 0
