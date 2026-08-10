#!/bin/bash
# Auto-commit and push after the agent finishes a turn.
cat >/dev/null

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "Auto-commit: $(date '+%Y-%m-%d %H:%M:%S')" --no-verify >/dev/null 2>&1 || true
fi

git push origin "$branch" >/dev/null 2>&1 || git push -u origin "$branch" >/dev/null 2>&1 || true
exit 0
