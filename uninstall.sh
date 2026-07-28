#!/usr/bin/env bash
# uninstall.sh — remove the files this package installed, and nothing else.
#
#   ./uninstall.sh                  remove unmodified package files
#   ./uninstall.sh --dry-run        show what would be removed, change nothing
#   ./uninstall.sh --purge-profile  ALSO delete ~/.config/dual-audit (your profile)
#
# It works from the installation manifest and removes a file only when its hash still matches
# what was installed. A file you edited is kept and reported: uninstalling must not be a way to
# lose your own work. Your profile is never removed unless you explicitly ask for it, because it
# is the one file here that is genuinely yours.
set -uo pipefail

DRY=0; PURGE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --purge-profile) PURGE=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "uninstall.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN_DIR="${DUAL_AUDIT_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${DUAL_AUDIT_SHARE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/dual-audit}"
CONFIG_DIR="${DUAL_AUDIT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/dual-audit}"
MANIFEST="$SHARE_DIR/manifest.json"

[ -r "$MANIFEST" ] || { echo "uninstall.sh: no manifest at $MANIFEST — nothing to do" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "uninstall.sh: node is required to read the manifest" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "uninstall.sh: sha256sum is required" >&2; exit 1; }

# Classification happens in one place, in node, because the "mutable" case needs the same
# block-stripping the installer used. A mutable file is NOT exempt from verification: its whole-file
# hash may differ (that is the generated profile block being rewritten), but everything OUTSIDE that
# block must still match `base_sha256`. Exempting it was how "removes only what still matches"
# became "removes the panel unconditionally, however much you had changed it".
#
# Every failure path here resolves to `modified`, which means KEEP: an unreadable file, a symlink
# that appeared after installation, a missing or damaged library, a manifest with no base hash. Not
# being able to prove a file is ours is a reason to leave it alone, not a reason to delete it.

# The manifest is the ONLY record of what belongs to this package. If it cannot be read, this
# script does not know what it owns, and "I do not know" must not come out as "there was nothing to
# remove". A process substitution hides the exit status of the command inside it, so the parse is
# run once on its own first, where its failure is visible.
if ! node -e 'const m=require(process.argv[1]); if(m.package!=="dual-audit"||!Array.isArray(m.files)) process.exit(1)' "$MANIFEST" 2>/dev/null; then
  echo "uninstall.sh: $MANIFEST is not readable as an installation manifest." >&2
  echo "  Nothing has been removed, and the manifest has been left in place." >&2
  echo "  Without it this script cannot tell which files are ours, and deleting on a guess is worse" >&2
  echo "  than leaving the files behind. Restore it, or remove the installed files by hand." >&2
  exit 1
fi

# Records are NUL-delimited, state first. Every path crossing this boundary is one of the twelve
# this package installs, built by installTargets from environment variables — and an environment
# variable cannot contain a NUL, so the framing cannot be split by its own content.
#
# That was not true while the paths came from the manifest, which is a JSON file where a NUL has a
# legal escape. Two rounds of review were spent on it: first a newline broke a newline-delimited
# format, then an escaped NUL broke the NUL-delimited one that replaced it. The framing is safe now
# because of where the paths come from, not because of what is filtered out of them.
#
# Captured to a file rather than through a process substitution, because a process substitution
# hides the exit status of the command inside it: a classifier that died half way through produced
# a short list that read as a complete one, and the files it never got to were left behind while
# the manifest that records them was deleted.
CLASSIFY="$(mktemp "${TMPDIR:-/tmp}/dual-audit-uninstall.XXXXXX")" || {
  echo "uninstall.sh: could not create a temporary file; nothing has been removed." >&2; exit 1; }
# The trap is installed after the FIRST temporary file and covers the second by name, so a failure
# of the second mktemp still cleans up the first. Installing it after both leaked $CLASSIFY on
# exactly the path that reports it could not continue.
TARGETS=""
trap 'rm -f "$CLASSIFY" ${TARGETS:+"$TARGETS"}' EXIT
TARGETS="$(mktemp "${TMPDIR:-/tmp}/dual-audit-targets.XXXXXX")" || {
  echo "uninstall.sh: could not create a temporary file; nothing has been removed." >&2; exit 1; }

# The list of paths this package installs, captured BEFORE anything is removed. The library that
# computes it is itself one of those paths, so asking for the list afterwards asks a question the
# run has already destroyed the answer to: the check that decides whether to keep the manifest read
# as "nothing of ours is left" precisely because it could no longer see what ours was.
if ! node -e '
  const lib=require(process.argv[1]);
  const t=lib.installTargets({claudeDir:process.argv[2],binDir:process.argv[3],shareDir:process.argv[4]});
  for (const x of t) process.stdout.write(x.dst + "\0");
' "$SHARE_DIR/lib/profile.js" "$CLAUDE_DIR" "$BIN_DIR" "$SHARE_DIR" > "$TARGETS" 2>/dev/null; then
  echo "uninstall.sh: cannot read $SHARE_DIR/lib/profile.js, so the set of paths this package owns" >&2
  echo "  cannot be computed. Nothing has been removed and the manifest has been left in place." >&2
  exit 1
fi

node -e '
  const fs=require("fs"), crypto=require("crypto");
  const lib=require(process.argv[2]);
  const baseSha = lib.baseSha;

  // ===================================================================================
  // THE LOOP RUNS OVER THE PATHS THIS PACKAGE INSTALLS, WHICH COME FROM CODE.
  // The manifest is consulted only BY KEY, to answer "what did I write at this known path".
  // ===================================================================================
  //
  // It used to be the other way round — the loop ran over the manifest — and that one decision
  // produced every serious defect this file has had. The manifest is a plain JSON file that anything
  // can write, so letting it supply the paths created a route from untrusted data straight to rm,
  // and each round of review found a new way along it: a path containing a newline split one record
  // into two, and a path containing an escaped NUL did the same to the NUL-delimited format that
  // replaced it. Each fix rejected the input that had just been demonstrated, and the next review
  // demonstrated another.
  //
  // With the iteration inverted those attacks are not blocked, they cannot be expressed. A path
  // never leaves the manifest, so it cannot be smuggled, cannot close its own record, and cannot
  // name anything outside the install set. Five guards went with the defect: an entry-shape check,
  // a control-character rejection, an install-set membership test, a declared record count, and the
  // "foreign" state itself.
  //
  // The list is READ, not recomputed. Deriving it a second time here made the set of paths this run
  // acts on a different object from the set it later checks and cleans up against, and the only
  // thing comparing the two was their length: replace the library between the two calls with one
  // that returns the same NUMBER of different paths, and the run deletes the second set while
  // deciding "nothing of ours is left" from the first — then removes the manifest that identified
  // the files still sitting on disk. One computation cannot disagree with itself.
  // Decoded as UTF-8, which is a real (small) limitation rather than an oversight: a byte sequence
  // in one of the install directories that is not valid UTF-8 becomes U+FFFD here, so this side
  // classifies a name that is not quite the name on disk. It resolves safely — the mangled path
  // cannot be read, so it lands in `modified`, which keeps the file, and the leftovers check in the
  // shell reads $TARGETS byte-exactly and therefore keeps the manifest too. Worth knowing about,
  // not worth carrying Buffer paths through every comparison below to avoid.
  const targets = fs.readFileSync(process.argv[3], "utf8").split("\0").slice(0, -1);
  if (targets.length === 0) { process.stderr.write("empty target list\n"); process.exit(1) }

  // The manifest, reduced to a lookup table. Nothing in it is ever acted on by itself: an entry is
  // only found by asking for a path we already know we install.
  const m=require(process.argv[1]);
  const recorded = Object.create(null);
  if (Array.isArray(m.files)) {
    for (const f of m.files) if (f && typeof f.path === "string") recorded[f.path] = f;
  }

  const sha=(b)=>crypto.createHash("sha256").update(b).digest("hex");
  // state FIRST, both fields NUL-terminated. Paths now reach here from the environment by way of
  // installTargets, and an environment variable cannot contain a NUL, so the framing holds.
  const out=(state, path)=>process.stdout.write(state + "\0" + String(path) + "\0");

  for (const dst of targets) {
    const rec = recorded[dst];
    // We install this path but the manifest does not describe it: there is no recorded hash to
    // compare against, so nothing could justify removing it.
    if (!rec) { out("unrecorded", dst); continue }
    // Ownership is decided by the FILE. A manifest is a side file that anything can write, so a path
    // must still prove from its own contents that this package wrote it. "unmarked" stays distinct
    // from "modified" because an installed file whose marker comment you edited away is still one of
    // ours, and its record has to survive the removal.
    try { if (!fs.readFileSync(dst,"utf8").includes(process.argv[4])) { out("unmarked", dst); continue } }
    catch (e) { out("modified", dst); continue }
    let st=null; try { st=fs.lstatSync(dst) } catch (e) { st=null }
    if (!st) { out("gone", dst); continue }
    if (st.isSymbolicLink() || !st.isFile()) { out("modified", dst); continue }
    let buf=null; try { buf=fs.readFileSync(dst) } catch (e) { out("modified", dst); continue }
    if (sha(buf)===rec.sha256) { out("match", dst); continue }
    if (rec.mutable && typeof rec.base_sha256==="string") {
      let ok=false; try { ok = baseSha(dst)===rec.base_sha256 } catch (e) { ok=false }
      if (ok) { out("match", dst); continue }
    }
    out("modified", dst);
  }

  // Paths the manifest names that this package does not install are never examined and never acted
  // on. They are counted so the user is told they are there rather than left to wonder.
  let extra = 0;
  for (const k of Object.keys(recorded)) if (!targets.includes(k)) extra++;
  out("__ignored__", String(extra));
' "$MANIFEST" "$SHARE_DIR/lib/profile.js" "$TARGETS" 'dual-audit:package-file' > "$CLASSIFY"
crc=$?
if [ "$crc" -ne 0 ]; then
  echo "uninstall.sh: the classifier exited $crc — it did not finish deciding what belongs to this" >&2
  echo "  package. Nothing has been removed and the manifest has been left in place; acting on a" >&2
  echo "  partial list would delete some files, leave others, and destroy the record of both." >&2
  exit 1
fi

# READ EVERYTHING FIRST, ACT AFTERWARDS. Deleting inside the read loop meant the count check below
# could only ever be a post-mortem: by the time a miscount was noticed, the deletions it was meant to
# prevent had already happened.
STATES=(); PATHS=(); ignored=""
while IFS= read -r -d '' state && IFS= read -r -d '' path; do
  if [ "$state" = "__ignored__" ]; then ignored="$path"; continue; fi
  STATES+=("$state"); PATHS+=("$path")
done < "$CLASSIFY"

# One record per path this package installs, no more and no fewer. The expected number is not
# declared by the classifier and taken on trust: both sides now read the SAME captured list, so this
# reader already knows it from $TARGETS. A short stream means the classifier stopped early; a long
# one means something was added to it.
expected="$(tr -cd '\0' < "$TARGETS" | wc -c)"
# An empty list is not "nothing to do". Everything downstream is driven by this list — including the
# check that decides whether the manifest may be deleted — so zero entries would sail through the
# comparison below, find no leftovers because it looked at nothing, and delete the record of files
# that are all still on disk.
if [ "$expected" -eq 0 ]; then
  echo "uninstall.sh: the installed-file list came back empty, which cannot be right — this package" >&2
  echo "  installs a fixed set of files. Nothing has been removed and the manifest has been left in" >&2
  echo "  place." >&2
  exit 1
fi
if [ "${#STATES[@]}" -ne "$expected" ]; then
  echo "uninstall.sh: expected $expected classification(s), one per file this package installs," >&2
  echo "  but ${#STATES[@]} arrived. Nothing has been removed and the manifest has been left in" >&2
  echo "  place: a list that is not the right length is not a list to delete files from." >&2
  exit 1
fi

removed=0; kept=0; absent=0; kept_ours=0
for i in ${STATES+"${!STATES[@]}"}; do
  state="${STATES[$i]}"; path="${PATHS[$i]}"
  # DELETION IS THE ONLY CASE SPELLED OUT. Every other state, including one this script has never
  # heard of, keeps the file. The previous shape was the other way round — three keep states and an
  # unguarded fall-through to `rm -f` — so any state the reader failed to recognise, including the
  # empty string produced by a malformed record, resolved to deletion.
  case "$state" in
    match)
      if [ "$DRY" -eq 1 ]; then echo "  would remove $path"; removed=$((removed+1))
      elif rm -f "$path"; then echo "  removed  $path"; removed=$((removed+1))
      else
        # Counting a failed removal as a removal is how "the file is still there" became "and its
        # record has been deleted too". A file we could not remove is a file we are keeping.
        echo "  KEPT     $path (it could not be removed)"; kept=$((kept+1)); kept_ours=$((kept_ours+1))
      fi ;;
    gone)     echo "  gone     $path"; absent=$((absent+1)) ;;
    modified) echo "  KEPT     $path (modified since installation)"; kept=$((kept+1)); kept_ours=$((kept_ours+1)) ;;
    unmarked) echo "  KEPT     $path (one of ours by path, but it no longer carries the ownership marker)"
              kept=$((kept+1)); kept_ours=$((kept_ours+1)) ;;
    unrecorded) echo "  KEPT     $path (this package installs it, but the manifest does not record it)"
              kept=$((kept+1)); kept_ours=$((kept_ours+1)) ;;
    *)        echo "  KEPT     $path (unrecognised classification \"$state\" — refusing to act on it)"
              kept=$((kept+1)) ;;
  esac
done

if [ -n "$ignored" ] && [ "$ignored" != "0" ]; then
  echo ""
  echo "  note     the manifest also names $ignored path(s) this package does not install."
  echo "           They were not examined and not touched: what gets removed comes from the"
  echo "           installed-file list in the code, never from the manifest."
fi

# WHETHER ANY OF OUR FILES ARE STILL ON DISK — asked of the filesystem, against the list captured
# before the removal began. The counter version was gated on states that some outcomes never
# incremented, so a run in which every entry came back "foreign" deleted the ownership record while
# our files sat there. Asking the library again afterwards is no better: the library is one of the
# files this run deletes, so the question destroys its own answer.
leftovers=0
while IFS= read -r -d '' t; do
  if [ -e "$t" ] || [ -L "$t" ]; then leftovers=1; break; fi
done < "$TARGETS"

if [ "$DRY" -eq 0 ] && [ "$leftovers" -eq 1 ]; then
  # Files are still here, so the record of what they are has to stay too. Deleting it left those
  # files with nothing to verify them against: doctor could no longer check them, a second run of
  # this script said "no manifest — nothing to do" while they sat on disk, and the removal reported
  # success either way.
  echo ""
  echo "$MANIFEST has been kept, because at least one file this package installs is still on disk."
  echo "It is what identifies them; without it nothing can tell them apart from your own files."
fi

if [ "$DRY" -eq 0 ] && [ "$leftovers" -eq 0 ]; then
  rm -f "$MANIFEST" || echo "  NOTE     $MANIFEST could not be removed" >&2
  # Remove only directories we created, and only when they are empty.
  for d in "$SHARE_DIR/lib" "$SHARE_DIR/profiles" "$SHARE_DIR"; do rmdir "$d" 2>/dev/null || true; done
  for d in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/dual-audit" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/light-audit"; do
    rmdir "$d" 2>/dev/null || true
  done
fi

PROFILE_FILE="${CONFIG_DIR%/}/profile.yaml"
if [ "$PURGE" -eq 1 ]; then
  # THERE IS NO RECURSIVE DELETE HERE ANY MORE, and that is the fix rather than a stronger guard.
  #
  # The previous version did `rm -rf "$CONFIG_DIR"` behind a series of checks, and every one of those
  # checks turned out to answer a question next to the one that mattered:
  #
  #  - "its profile.yaml carries our ownership marker" proves the FILE is ours. It does not prove the
  #    DIRECTORY is. install.sh does `mkdir -p` on whatever CONFIG_DIR names, whether or not it
  #    already existed, and copies the marker-bearing template into it — so pointing the variable at
  #    a directory full of your own configuration made the installer plant the very criterion the
  #    purge then accepted. Reproduced: an entire config directory deleted, exit 0.
  #  - the two symlink guards were both defeated by a single trailing slash: `[ -L "x/" ]` is false
  #    for a link to a directory, and `find "x/" -maxdepth 1 -type l` searches the TARGET rather than
  #    the link. Reproduced: rm -rf followed the link and emptied the directory it pointed at.
  #
  # A guard that has to be right about the difference between a directory and a link to one, in a
  # string that came from the environment, is a guard that will be wrong again. So the operation is
  # narrowed to what the flag actually promises: delete the profile FILE, then remove the directory
  # only if that left it empty. `rmdir` cannot take anything with it, and it refuses a symlink.
  purge_refuse=""
  case "${CONFIG_DIR%/}" in
    ""|"/"|"$HOME") purge_refuse="it is not a profile directory" ;;
    /*) ;;
    *) purge_refuse="it is not an absolute path" ;;
  esac
  if [ -z "$purge_refuse" ] && [ ! -f "$PROFILE_FILE" ]; then
    purge_refuse="there is no profile.yaml there to remove"
  fi
  # The marker still earns its place: it proves this FILE is the profile this package wrote, which is
  # exactly the claim being made about the file being deleted. It is no longer asked to prove
  # anything about the directory, which is what it could never do.
  if [ -z "$purge_refuse" ] && ! grep -qF 'dual-audit:package-file' "$PROFILE_FILE" 2>/dev/null; then
    purge_refuse="$PROFILE_FILE does not carry this package's ownership marker"
  fi
  if [ -n "$purge_refuse" ]; then
    echo "  KEPT     ${CONFIG_DIR%/} (refusing to purge: $purge_refuse)"
  elif [ "$DRY" -eq 1 ]; then
    echo "  would remove $PROFILE_FILE (your profile)"
    echo "  would remove ${CONFIG_DIR%/} as well, but only if removing the profile leaves it empty"
  else
    if rm -f "$PROFILE_FILE"; then
      echo "  removed  $PROFILE_FILE (your profile)"
      if rmdir "${CONFIG_DIR%/}" 2>/dev/null; then
        echo "  removed  ${CONFIG_DIR%/} (nothing else was in it)"
      else
        echo "  KEPT     ${CONFIG_DIR%/} (something else is in it — this command removes your profile, not a directory)"
      fi
    else
      echo "  KEPT     $PROFILE_FILE (it could not be removed)"
    fi
  fi
else
  [ -d "$CONFIG_DIR" ] && echo "  KEPT     ${CONFIG_DIR%/} (your profile — remove with --purge-profile)"
fi

echo ""
echo "Removed $removed, kept $kept modified, $absent already gone."
[ "$kept" -gt 0 ] && echo "Files marked KEPT were changed after installation and were left in place."
exit 0
