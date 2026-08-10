#!/bin/bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/post-commit"

cat >"$hook" <<'EOF'
#!/bin/bash
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
git push origin "$branch" >/dev/null 2>&1 || git push -u origin "$branch" >/dev/null 2>&1 || true
EOF

chmod +x "$hook"
echo "Installed post-commit hook at $hook"
