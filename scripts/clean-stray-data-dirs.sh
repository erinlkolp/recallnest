#!/bin/bash
# Remove stray sidecar data/ dirs that older RecallNest builds left in other repos.
#
# Before the RECALLNEST_DATA_DIR fix, activity-counter/distill-lock/audit-log/
# retention-policy defaulted to a cwd-relative "data/", so the MCP server
# created one in whichever repo the agent launched it from.
#
# Only the four known artifacts are deleted, and a data/ dir is removed only if
# it is empty afterwards — directories holding real project files are kept.
#
# Usage:
#   scripts/clean-stray-data-dirs.sh [root]           # dry run (default)
#   scripts/clean-stray-data-dirs.sh [root] --apply   # actually delete
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ROOT="${HOME}/workspace"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) ROOT="$arg" ;;
  esac
done

if [ ! -d "$ROOT" ]; then
  echo "root not found: $ROOT" >&2
  exit 2
fi

ARTIFACTS=(activity-stats.json distill.lock audit.jsonl)
if [ "$APPLY" -eq 0 ]; then echo "DRY RUN — re-run with --apply to delete"; fi
echo "scanning: $ROOT"
echo "skipping install dir: $INSTALL_DIR"
echo

removed_files=0
removed_dirs=0
kept_dirs=0
skipped_files=0

while IFS= read -r dir; do
  # Never touch the live store in the install dir.
  case "$dir" in
    "$INSTALL_DIR"/*|"$INSTALL_DIR") continue ;;
  esac

  repo="$(dirname "$dir")"

  # A committed artifact is that repo's business — removing it would leave an
  # uncommitted deletion behind. Report it and move on.
  tracked_in_git() {
    git -C "$repo" ls-files --error-unmatch "data/$1" >/dev/null 2>&1
  }

  hits=()
  skipped=()
  for name in "${ARTIFACTS[@]}" retention; do
    if [ "$name" = "retention" ]; then
      if [ ! -d "$dir/retention" ]; then continue; fi
      entry="retention/"
    else
      if [ ! -f "$dir/$name" ]; then continue; fi
      entry="$name"
    fi
    if tracked_in_git "$name"; then
      skipped+=("$entry")
    else
      hits+=("$entry")
    fi
  done
  if [ ${#hits[@]} -eq 0 ] && [ ${#skipped[@]} -eq 0 ]; then continue; fi

  echo "$dir"
  for name in "${skipped[@]}"; do
    echo "    SKIP $name — tracked in git, remove it in that repo yourself"
    skipped_files=$((skipped_files + 1))
  done
  for name in "${hits[@]}"; do
    echo "    rm $name"
    if [ "$APPLY" -eq 1 ]; then
      rm -rf -- "${dir:?}/${name%/}"
    fi
    removed_files=$((removed_files + 1))
  done

  # Report what a real run would leave behind, using the post-delete state
  # under --apply and a simulated one during the dry run.
  leftover=""
  while IFS= read -r entry; do
    base="$(basename "$entry")"
    keep=1
    if [ "$APPLY" -eq 0 ]; then
      for name in "${hits[@]}"; do
        if [ "$base" = "${name%/}" ]; then keep=0; fi
      done
    fi
    if [ "$keep" -eq 1 ]; then leftover+="$base "; fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null | sort)

  if [ -z "$leftover" ]; then
    echo "    rmdir data/ (empty)"
    if [ "$APPLY" -eq 1 ]; then
      rmdir -- "$dir"
    fi
    removed_dirs=$((removed_dirs + 1))
  else
    echo "    keeping data/ — still holds: $leftover"
    kept_dirs=$((kept_dirs + 1))
  fi
  echo
done < <(find "$ROOT" -maxdepth 3 -type d -name data -not -path "*/node_modules/*" 2>/dev/null | sort)

echo "artifacts: $removed_files   dirs removed: $removed_dirs   dirs kept: $kept_dirs   skipped (git-tracked): $skipped_files"
if [ "$APPLY" -eq 0 ]; then echo "(nothing was deleted — dry run)"; fi
