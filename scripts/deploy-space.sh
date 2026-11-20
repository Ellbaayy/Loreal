#!/usr/bin/env bash
# Deploy the current tree to the Hugging Face Space (origin).
#
# Hugging Face rejects any push whose history adds binary files, and this repo
# has docs/*.png from GitHub. So the Space receives one squashed snapshot of
# HEAD's tree with docs/ (screenshots only) removed. Git history stays on GitHub;
# that push is done separately and only after the Space is verified.
#
# Usage: npm run deploy:space      (working tree must be clean)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-space: working tree is dirty — commit first" >&2
  exit 1
fi

head=$(git rev-parse HEAD)
subject=$(git log -1 --format=%s)
parent=$(git rev-parse origin/main)

index=$(mktemp -u)
rm -f "$index"
export GIT_INDEX_FILE="$index"
git read-tree "$head^{tree}"
git rm -r --cached -q docs 2>/dev/null || true
tree=$(git write-tree)
unset GIT_INDEX_FILE
rm -f "$index"

snapshot=$(git commit-tree "$tree" \
  -p "$parent" \
  -m "deploy: $subject" \
  -m "Snapshot of $head for the Space; docs/ omitted because Hugging Face
rejects binary files in git history. Git history lives on GitHub.")

echo "deploy-space: HEAD $head -> snapshot ${snapshot:0:10}"
git push origin "$snapshot:main"
