#!/usr/bin/env bash
# install.sh — install dual-audit into user-local locations. Never needs sudo.
#
#   ./install.sh                 install or upgrade
#   ./install.sh --dry-run       show exactly what would happen, change nothing
#   ./install.sh --force         replace files this package installed and you have edited since
#                                (each is backed up first). It does NOT, and cannot, overwrite a
#                                file this package does not own.
#
# What it installs, and where:
#   ~/.claude/workflows/dual-audit-panel.js         the review protocol
#   ~/.claude/workflows/dual-audit-run.js           the driver that runs every round
#   ~/.claude/agents/dual-audit-codex-readonly.md   the read-only second reviewer
#   ~/.claude/skills/dual-audit/SKILL.md            full panel
#   ~/.claude/skills/light-audit/SKILL.md           one independent second opinion
#   ~/.local/bin/dual-audit                         CLI (doctor, profile)
#   ~/.local/bin/dual-audit-codex                   hardened read-only reviewer wrapper
#   ~/.local/bin/dual-audit-lint                    bypass linter
#   ~/.local/share/dual-audit/                      libraries, base profiles, manifest
#   ~/.config/dual-audit/profile.yaml               YOUR profile — created once, never
#                                                   overwritten, never deleted by uninstall
#
# Every path honours the usual environment overrides (HOME, XDG_*, CLAUDE_CONFIG_DIR), which
# is what makes an install into a temporary HOME possible for testing.
set -uo pipefail

VERSION="1.0.0"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN_DIR="${DUAL_AUDIT_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${DUAL_AUDIT_SHARE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/dual-audit}"
CONFIG_DIR="${DUAL_AUDIT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/dual-audit}"
MANIFEST="$SHARE_DIR/manifest.json"
PROFILE="$CONFIG_DIR/profile.yaml"

fail() { echo "install.sh: $*" >&2; exit 1; }
note() { echo "  $*"; }

# ---------------------------------------------------------------------------
# 1. Dependencies. Missing ones are reported together rather than one per run.
# ---------------------------------------------------------------------------
echo "Checking prerequisites"
missing=()
for u in bash node flock mktemp timeout awk sed grep find sha256sum; do
  command -v "$u" >/dev/null 2>&1 || missing+=("$u")
done
[ "${#missing[@]}" -gt 0 ] && fail "missing required tools: ${missing[*]}"
node_major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
[ "$node_major" -ge 18 ] || fail "node 18 or newer is required (found $(node --version 2>/dev/null || echo none))"
note "node $(node --version), bash ${BASH_VERSION%%(*}"

if command -v codex >/dev/null 2>&1 || [ -x "${DUAL_AUDIT_CODEX_BIN:-$HOME/.local/bin/codex}" ]; then
  note "codex CLI found"
else
  note "WARNING: no codex CLI found. Everything installs, but the second reviewer cannot run"
  note "         until you install it or set DUAL_AUDIT_CODEX_BIN."
fi
if [ -d "$CLAUDE_DIR" ]; then note "Claude Code config directory: $CLAUDE_DIR"
else note "NOTE: $CLAUDE_DIR does not exist yet; it will be created."; fi

# ---------------------------------------------------------------------------
# 2. Plan. Nothing is written before every target has been checked, so a refusal
#    cannot leave a half-installed tree behind.
# ---------------------------------------------------------------------------
# Three fields per entry, each NUL-terminated, held in three parallel arrays.
# The installation plan comes from ONE place — profile.js `targets` — which uninstall and doctor
# also use to decide what this package may own. A plan maintained separately here could drift from
# that list, and a destination missing from the list is a destination nothing will ever clean up.
#
# The fields are NUL-terminated rather than joined with a printable delimiter. `rel` and `mode` come
# from this package, but `dst` is built from directories the CALLER names in the environment, and a
# path is allowed to contain any byte except NUL and '/'. With '|' as the delimiter, a directory
# containing one truncated the destination at that character and handed the remainder to the mode —
# reproduced: DUAL_AUDIT_SHARE_DIR='/tmp/s|x' collapsed four different source files onto the single
# destination /tmp/s, each overwriting the last. This is the same defect class the uninstaller had
# twice; it is closed the same way, by a framing whose delimiter cannot occur in the data.
#
# Read from a file rather than a command substitution: $( ) DISCARDS NUL bytes (with a warning that
# nothing reads), so the framing would be destroyed by the very capture meant to preserve it, and a
# process substitution hides the exit status of the command inside it — an empty plan would read as
# "nothing to install".
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/dual-audit-plan.XXXXXX")" \
  || fail "could not create a temporary file for the installation plan"
trap 'rm -f "$PLAN_FILE"' EXIT
node "$SRC/runtime/core/profile.js" targets "$CLAUDE_DIR" "$BIN_DIR" "$SHARE_DIR" > "$PLAN_FILE" \
  || fail "could not compute the installation plan (is this checkout complete?)"
PLAN_REL=(); PLAN_DST=(); PLAN_MODE=()
while IFS= read -r -d '' _rel && IFS= read -r -d '' _dst && IFS= read -r -d '' _mode; do
  PLAN_REL+=("$_rel"); PLAN_DST+=("$_dst"); PLAN_MODE+=("$_mode")
done < "$PLAN_FILE"
unset _rel _dst _mode
[ "${#PLAN_REL[@]}" -gt 0 ] || fail "the installation plan is empty — this checkout looks incomplete"
# Everything that was written must have been read. The loop above stops at the first incomplete
# triple and silently keeps the entries it already had, which is a short plan that reads as a
# complete one — and a short plan installs some files while the manifest records only those, so the
# rest are never cleaned up. Counting delimiters answers this directly; checking only that the FILE
# holds whole triples would miss a loop that stopped early over a well-formed file.
# The second half is not redundant: a fragment cut mid-FIELD carries no delimiter at all, so the
# count still balances and only the final byte shows that the stream stopped somewhere other than a
# record boundary. Verified by probe — the count alone did not fire on exactly that case.
[ "$(tr -cd '\0' < "$PLAN_FILE" | wc -c)" -eq "$(( ${#PLAN_REL[@]} * 3 ))" ] \
  && [ "$(tail -c 1 "$PLAN_FILE" | tr -cd '\0' | wc -c)" -eq 1 ] \
  || fail "the installation plan was not read in full — this checkout looks incomplete"

# The two destinations that also get written INTO other files (the driver names the panel, the
# skills name the driver) are read back out of the same plan rather than spelled out again here.
# Spelling them out was a second definition of the install layout: changing `installTargets` moved
# the file but left these pointing at the old path, and the driver would then be published with a
# scriptPath nothing installs.
plan_dst_for() { # plan_dst_for <source-relative-path>
  local rel="$1" i
  for i in "${!PLAN_REL[@]}"; do
    [ "${PLAN_REL[$i]}" = "$rel" ] && { printf '%s\n' "${PLAN_DST[$i]}"; return 0; }
  done
  return 1
}
PANEL_DST="$(plan_dst_for runtime/core/dual-audit-panel.js)" \
  || fail "the installation plan does not contain the panel — this checkout looks incomplete"
RUN_DST="$(plan_dst_for runtime/claude-controller/dual-audit-run.js)" \
  || fail "the installation plan does not contain the driver — this checkout looks incomplete"

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Literal (non-regex, non-sed) placeholder substitution.
subst() { # subst <file> <placeholder> <replacement> [js]
  node -e '
    const fs=require("fs");
    const [f,ph,rep,mode]=process.argv.slice(1);
    // When the placeholder sits inside a single-quoted JavaScript literal, the replacement has to
    // be escaped for that literal. A home directory containing a quote, a backslash or a newline
    // would otherwise produce a syntactically broken file that still passes a "no placeholder
    // left" check — the installer would report success and the driver would never load.
    const value = mode === "js"
      ? rep.replace(/\\/g, "\\\\").replace(/'"'"'/g, "\\'"'"'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
      : rep;
    const src=fs.readFileSync(f,"utf8");
    fs.writeFileSync(f, src.split(ph).join(value));
  ' "$1" "$2" "$3" "${4-}" || fail "could not substitute $2 in $1"
}

# The ownership marker every file this package installs carries. Ownership is decided by the
# DESTINATION FILE, not by the manifest — see the long note at "Checking destinations" below.
PKG_MARK='dual-audit:package-file'
is_ours() { grep -qF "$PKG_MARK" "$1" 2>/dev/null; }

# Is the manifest one WE could have written? A manifest is a plain file that anything can create,
# so before a single value inside it is trusted it must name this package and must not claim a path
# outside the fixed install set. Without this, a hand-written manifest naming a planned destination
# and its current hash was accepted as proof of ownership.
manifest_is_ours() {
  [ -r "$MANIFEST" ] || return 1
  node -e '
    const m=require(process.argv[1]);
    if (m.package !== "dual-audit") process.exit(1);
    if (!Array.isArray(m.files) || typeof m.version !== "string") process.exit(1);
    const lib=require(process.argv[2]);
    const ok=new Set(lib.installTargets({claudeDir:process.argv[3],binDir:process.argv[4],shareDir:process.argv[5]}).map(t=>t.dst));
    for (const f of m.files) if (!ok.has(f && f.path)) process.exit(1);
  ' "$MANIFEST" "$SRC/runtime/core/profile.js" "$CLAUDE_DIR" "$BIN_DIR" "$SHARE_DIR" 2>/dev/null
}

# Does the destination already hold exactly what we would install? Four of the twelve files are
# transformed on the way in — three carry substituted placeholders and the panel carries a generated
# profile block — so comparing them against the source in the checkout reports a difference that is
# not one. The transformations are applied through the SAME `subst` the installer uses, so this
# cannot drift from what actually gets written; the panel is compared outside its generated block,
# which is the only region allowed to differ.
would_match() { # would_match <rel> <destination>
  local rel="$1" dst="$2" tmp a b
  if [ "$rel" = "runtime/core/dual-audit-panel.js" ]; then
    a="$(node "$SRC/runtime/core/profile.js" base-sha "$dst" 2>/dev/null)" || return 1
    b="$(node "$SRC/runtime/core/profile.js" base-sha "$SRC/$rel" 2>/dev/null)" || return 1
    [ -n "$a" ] && [ "$a" = "$b" ]
    return
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/dual-audit-cmp.XXXXXX")" || return 1
  cp "$SRC/$rel" "$tmp" || { rm -f "$tmp"; return 1; }
  case "$rel" in
    runtime/claude-controller/dual-audit-run.js)
      subst "$tmp" __DUAL_AUDIT_PANEL_PATH__ "$PANEL_DST" js ;;
    skills/dual-audit/SKILL.md)
      subst "$tmp" __DUAL_AUDIT_RUN_PATH__ "$RUN_DST"
      subst "$tmp" __DUAL_AUDIT_PROFILE_PATH__ "$PROFILE" ;;
    skills/light-audit/SKILL.md)
      # This lane now invokes the panel itself (at mode: quick), so it needs the run path too. It
      # did not before, when it dispatched a single reviewer with a hand-written brief.
      subst "$tmp" __DUAL_AUDIT_RUN_PATH__ "$RUN_DST"
      subst "$tmp" __DUAL_AUDIT_PROFILE_PATH__ "$PROFILE" ;;
  esac
  a="$(sha "$tmp")"; b="$(sha "$dst")"; rm -f "$tmp"
  [ "$a" = "$b" ]
}

# What we recorded for this destination last time. Only meaningful once the file itself has proved
# it is ours; it answers "did you edit it", never "is it yours".
prev_sha() { # prev_sha <destination>
  manifest_is_ours || return 1
  node -e '
    const m=require(process.argv[1]);
    const f=(m.files||[]).find(x=>x.path===process.argv[2]);
    if (!f) process.exit(1);
    console.log(f.sha256);
  ' "$MANIFEST" "$1" 2>/dev/null
}

echo ""
echo "Checking destinations"
# Two SEPARATE lists, because they have different rights.
#   unowned   — this package never wrote it. NOTHING may overwrite it, --force included.
#   conflicts — we installed it and you edited it since. --force may replace these.
# Collapsing them into one list is what let --force overwrite a stranger's file (or, on a machine
# that also runs a private installation of the same tool, that installation's live files).
unowned=()
conflicts=()
to_backup=()      # destinations that will be replaced, and therefore backed up first
for _i in "${!PLAN_REL[@]}"; do
  rel="${PLAN_REL[$_i]}"; dst="${PLAN_DST[$_i]}"; mode="${PLAN_MODE[$_i]}"
  [ -r "$SRC/$rel" ] || fail "source file missing from this checkout: $rel"
  # -L is tested BEFORE -e, exactly as at the manifest below: a DANGLING symlink makes -e false, so
  # an -e-first test skips the guard entirely, the destination never enters either list, and the cp
  # further down follows the link and creates its target — a write to a path nobody examined.
  if [ -L "$dst" ]; then unowned+=("$dst (a symlink — refusing to write through it)"); continue; fi
  [ -e "$dst" ] || continue
  # Belonging to somebody else is decided before anything about our own markers. A file another user
  # owns can still be writable by us — a group-writable shared directory is the ordinary case — and
  # replacing it would be destroying their file while reporting a successful install of ours.
  if [ ! -O "$dst" ]; then
    unowned+=("$dst (exists and is owned by another user)")
    continue
  fi
  # OWNERSHIP IS DECIDED BY THE FILE, NOT BY THE MANIFEST. The manifest is a side file that anything
  # can write, so letting it answer "is this ours" made ownership self-certifying: a hand-written,
  # shape-valid manifest naming a planned destination and its CURRENT hash made the installer treat
  # a stranger's file as its own, unmodified copy — and overwrite it silently, without --force and
  # while reporting success. The marker lives inside the file we are about to replace, so a
  # manifest cannot confer it. (Same-uid forgery is still possible; nothing without a secret can
  # prevent that. What this stops is the realistic case: a stale, copied or hand-made manifest.)
  if ! is_ours "$dst"; then
    unowned+=("$dst (exists and does not carry this package's ownership marker)")
    continue
  fi
  # Already identical to what we would write: replacing it changes nothing, so it is neither a
  # conflict nor worth a backup. This is the ordinary case after the manifest is lost or damaged —
  # without it, recovering from that needed --force AND no leftover backup files, which is a lot of
  # ceremony for overwriting a file with its own contents.
  would_match "$rel" "$dst" && continue
  if ! recorded="$(prev_sha "$dst")"; then
    # Ours by the marker, but nothing trustworthy records what we installed — so we cannot tell an
    # untouched copy from an edited one. Treated as edited: it needs --force and gets a backup.
    conflicts+=("$dst (ours, but no trustworthy manifest record — cannot tell whether you edited it)")
    to_backup+=("$dst")
  elif [ "$recorded" != "$(sha "$dst")" ]; then
    conflicts+=("$dst (installed by dual-audit but modified since)")
    to_backup+=("$dst")
  fi
done

# A backup is a write like any other, so its destination is checked HERE, before anything is
# copied. Checking it inside the install loop stopped a run half-way, with files already written
# and no manifest to own them — and the next install then refused every one of them as "not ours".
# The check is scoped to destinations that will actually be backed up: a leftover backup beside a
# file that is not being replaced is not this run's problem, and treating it as one made every
# later reinstall fail until the user deleted a file nobody had told them about.
needs_backup() { # needs_backup <destination> — the pre-flight scan's decision, asked rather than redone
  local d="$1" x
  for x in ${to_backup+"${to_backup[@]}"}; do [ "$x" = "$d" ] && return 0; done
  return 1
}

for dst in ${to_backup+"${to_backup[@]}"}; do
  if [ -L "$dst.bak-dual-audit" ]; then
    unowned+=("$dst.bak-dual-audit (a symlink — refusing to write a backup through it)")
  elif [ -e "$dst.bak-dual-audit" ]; then
    # The FIRST backup holds the pristine original. Replacing it on a second --force would destroy
    # exactly what the flag promises to preserve.
    unowned+=("$dst.bak-dual-audit (an earlier backup — refusing to overwrite it; move it aside)")
  fi
done

# The profile destination is checked HERE, with the others, and not at the point where it is
# written. That point is after all twelve files have been copied and before the manifest exists, so
# failing there left a half-installed tree that nothing owned — and the next install correctly
# refused every one of those files as "not ours". A destination is checked before anything is
# written, or the refusal costs more than the mistake.
# -L before -e, as everywhere else: a dangling symlink makes -e false.
if [ -L "$PROFILE" ]; then
  unowned+=("$PROFILE (a symlink — refusing to write your profile through it)")
fi

if [ "${#unowned[@]}" -gt 0 ]; then
  echo ""
  echo "These destinations are not ours to replace:"
  for c in "${unowned[@]}"; do echo "  - $c"; done
  echo ""
  echo "Refusing. Nothing has been changed."
  echo "--force does NOT override this. It only replaces files this installer wrote and you edited"
  echo "afterwards; a file dual-audit never installed is never overwritten. Move it aside first."
  exit 1
fi

if [ "${#conflicts[@]}" -gt 0 ]; then
  echo ""
  echo "These were installed by dual-audit and have been edited since:"
  for c in "${conflicts[@]}"; do echo "  - $c"; done
  if [ "$FORCE" -ne 1 ]; then
    echo ""
    echo "Refusing to discard your edits. Nothing has been changed."
    echo "Move them aside, or re-run with --force (each one is backed up as <file>.bak-dual-audit)."
    exit 1
  fi
  echo ""
  echo "--force given: each of these will be backed up to <file>.bak-dual-audit before being replaced."
fi

if [ "$DRY" -eq 1 ]; then
  echo ""
  echo "Dry run — the following would be installed:"
  for _i in "${!PLAN_DST[@]}"; do echo "  ${PLAN_DST[$_i]}"; done
  [ -e "$PROFILE" ] && echo "  $PROFILE (already exists — would be left untouched)" \
                    || echo "  $PROFILE (would be created from profiles/user.example.yaml)"
  echo "  $MANIFEST"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Install.
# ---------------------------------------------------------------------------
# The manifest itself is a destination too. It sits inside our own share directory, so in practice
# it is always ours — but "in practice" is not a check, and the file is TRUNCATED below. Refuse a
# symlink or a file that is not a manifest we wrote, rather than destroying something unexamined.
# -L is tested BEFORE -e on purpose: a DANGLING symlink makes -e false, so an -e-first check would
# skip the guard entirely and the final redirection would follow the link and create its target.
if [ -L "$MANIFEST" ]; then
  fail "$MANIFEST is a symlink; refusing to write through it"
fi
if [ -e "$MANIFEST" ]; then
  if ! manifest_is_ours; then
    # Not forcible. This file is about to be TRUNCATED, and it is not ours — the same rule as
    # every other unowned destination above. --force means "discard my own edits", never
    # "destroy a file this package did not write".
    fail "$MANIFEST exists but is not a dual-audit manifest; refusing to truncate it. Move it aside. (--force does not override this.)"
  fi
fi

echo ""
echo "Installing"
mkdir -p "$CLAUDE_DIR/workflows" "$CLAUDE_DIR/agents" "$CLAUDE_DIR/skills/dual-audit" \
         "$CLAUDE_DIR/skills/light-audit" "$BIN_DIR" "$SHARE_DIR/lib" "$SHARE_DIR/profiles" \
         "$CONFIG_DIR" || fail "could not create the target directories"

records=()
for _i in "${!PLAN_REL[@]}"; do
  rel="${PLAN_REL[$_i]}"; dst="${PLAN_DST[$_i]}"; mode="${PLAN_MODE[$_i]}"
  # WHETHER to back up was decided in the pre-flight scan, and this asks that decision rather than
  # re-deriving it. Re-deriving it here meant the two disagreed: a destination already identical to
  # what we would write leaves the scan early and never reaches `to_backup`, so the guards on the
  # backup path — a symlink there, an earlier backup holding the pristine original — did not cover
  # it, while this loop still went ahead and wrote a backup for it whenever the manifest was
  # missing. The result was that recovering from a lost manifest could overwrite the very file the
  # first backup existed to preserve, or follow a `.bak` symlink out of the install tree entirely.
  if needs_backup "$dst"; then
    # No `|| fail` here meant a failed backup did not stop anything: the script carries on to the
    # line below and replaces the file whose only copy just failed to be made. `set -e` is not in
    # effect, so this exited 0 having destroyed the edits that --force promises to preserve.
    cp -p "$dst" "$dst.bak-dual-audit" \
      || fail "could not back up $dst — refusing to replace a file whose backup could not be written"
  fi
  cp "$SRC/$rel" "$dst" || fail "could not write $dst"
  # Placeholders are resolved HERE rather than at run time, because a workflow launched by
  # absolute path cannot be handed a cached copy of itself, and the panel sandbox cannot read
  # a config file to find anything.
  # Substitution is done with a literal string replace, NOT sed: a path containing a character
  # that sed treats as special (`&`, the delimiter, a backslash) would otherwise be expanded into
  # something else, and the corrupted file would already be in place before anything noticed.
  case "$rel" in
    runtime/claude-controller/dual-audit-run.js)
      subst "$dst" __DUAL_AUDIT_PANEL_PATH__ "$PANEL_DST" js ;;
    skills/dual-audit/SKILL.md)
      subst "$dst" __DUAL_AUDIT_RUN_PATH__ "$RUN_DST"
      subst "$dst" __DUAL_AUDIT_PROFILE_PATH__ "$PROFILE" ;;
    skills/light-audit/SKILL.md)
      subst "$dst" __DUAL_AUDIT_RUN_PATH__ "$RUN_DST"
      subst "$dst" __DUAL_AUDIT_PROFILE_PATH__ "$PROFILE" ;;
  esac
  chmod "$mode" "$dst" || fail "could not set the mode on $dst"
  records+=("$dst")
  note "$dst"
done

if grep -q '__DUAL_AUDIT_[A-Z_]*__' "$RUN_DST" "$CLAUDE_DIR/skills/dual-audit/SKILL.md" \
        "$CLAUDE_DIR/skills/light-audit/SKILL.md" 2>/dev/null; then
  fail "a path placeholder was left unresolved — this installation is not usable"
fi

# "No placeholder left" does not prove the file still parses. Load the installed driver the way the
# runtime does, so a path that corrupted its source fails HERE, loudly, instead of at the first audit.
node -e '
  const fs=require("fs");
  const AF=Object.getPrototypeOf(async function(){}).constructor;
  const src=fs.readFileSync(process.argv[1],"utf8").replace("export const meta","const meta");
  new AF("args","agent","parallel","log","phase","budget","workflow",src);
' "$RUN_DST" || fail "the installed driver does not parse after path substitution — check whether your paths contain quotes, backslashes or newlines"


# The user profile is created once and never overwritten: it is the only file here that is
# genuinely theirs.
if [ -e "$PROFILE" ]; then
  note "$PROFILE (already present — left untouched)"
else
  # `cp && chmod` reported nothing when the copy failed: chmod was simply skipped, the install
  # carried on, and the profile the panel is about to be compiled from did not exist.
  cp "$SRC/profiles/user.example.yaml" "$PROFILE" || fail "could not create $PROFILE"
  chmod 644 "$PROFILE" || fail "could not set the mode on $PROFILE"
  note "$PROFILE (created — automatic routing stays OFF until you customise it)"
fi

# Compile the profile into the installed panel; the sandbox cannot read it at run time.
node "$SHARE_DIR/lib/profile.js" compile "$PROFILE" "$PANEL_DST" "$SHARE_DIR/profiles" >/dev/null \
  || fail "could not compile the profile into the installed panel"
note "profile compiled into the installed panel"

# ---------------------------------------------------------------------------
# 4. Ownership manifest. Uninstall removes ONLY files that still match these hashes.
# ---------------------------------------------------------------------------
# Generated by a JSON serialiser rather than by printf. The paths here come from environment
# variables, so they can hold a quote or a backslash; interpolating them into a hand-written JSON
# template produced a file that no longer parsed, while the install still reported success. The next
# uninstall then refused to read its own manifest and left every installed file behind.
node -e '
  const fs=require("fs"), crypto=require("crypto");
  const [out, version, installedAt, panelPath, profilePath, libPath, ...records] = process.argv.slice(1);
  let baseSha=null; try { baseSha=require(libPath).baseSha } catch (e) { baseSha=null }
  const sha=(p)=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const files=records.map(p => {
    // The panel is marked mutable: `dual-audit profile apply` rewrites its generated block, so a
    // changed whole-file hash there is expected. `base_sha256` covers everything OUTSIDE that block,
    // so "mutable" means "one known region may change", NOT "unverifiable" — the rest of the file is
    // still checked by uninstall and doctor.
    if (p === panelPath) {
      if (!baseSha) throw new Error("cannot compute the panel base hash: " + libPath + " is unreadable");
      return { path: p, sha256: sha(p), mutable: true, base_sha256: baseSha(p) };
    }
    return { path: p, sha256: sha(p), mutable: false };
  });
  fs.writeFileSync(out, JSON.stringify({
    package: "dual-audit", version, installed_at: installedAt,
    panel_path: panelPath, profile_path: profilePath, files,
  }, null, 2) + "\n");
' "$MANIFEST" "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PANEL_DST" "$PROFILE" \
  "$SRC/runtime/core/profile.js" ${records+"${records[@]}"} \
  || fail "could not write $MANIFEST"
note "$MANIFEST"

echo ""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "WARNING: $BIN_DIR is not on your PATH. The reviewer wrapper will not be found."
     echo "         Add this to your shell profile:  export PATH=\"$BIN_DIR:\$PATH\"" ; echo "" ;;
esac

echo "Installed dual-audit $VERSION."
echo ""
echo "Next:"
echo "  1. $BIN_DIR/dual-audit doctor          check the installation"
echo "  2. edit $PROFILE      describe what is critical in YOUR work"
echo "  3. $BIN_DIR/dual-audit profile apply   recompile it into the panel"
echo ""
echo "Until the profile says customized: true, nothing routes to a review automatically."
echo "Asking for a review explicitly works from the start."
