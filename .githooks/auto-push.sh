#!/bin/bash
# Commit any uncommitted changes and push the current branch to GitHub.
set -e
cd "$(git rev-parse --show-toplevel)"

branch=$(git rev-parse --abbrev-ref HEAD)

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "Auto-save: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
fi

git push -u origin "$branch"
