#!/usr/bin/env bash
# Deploy the current tree to the Hugging Face Space (origin).
#
# Two things differ between the repos, and this script applies both:
#
#   1. Hugging Face rejects any push whose history adds binary files, and the
#      repository carries docs/*.png screenshots. The Space therefore receives a
#      squashed snapshot of HEAD's tree with docs/ removed.
#   2. A Space needs YAML front matter (sdk, app_port) in README.md, but the
#      same front matter renders as a table on GitHub. It is injected into the
#      snapshot only; the repository README stays clean.
#
# Git history stays on GitHub; that push is done separately, after the Space is
# verified. Usage: npm run deploy:space   (working tree must be clean)
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
trap 'rm -f "$index"' EXIT

git read-tree "$head^{tree}"
git rm -r --cached -q docs 2>/dev/null || true

# README with the Space front matter on top -> new blob -> index.
blob=$(
  {
    printf '%s\n' '---'
    printf '%s\n' 'title: LORE-AI'
    printf '%s\n' 'emoji: 🧴'
    printf '%s\n' 'colorFrom: purple'
    printf '%s\n' 'colorTo: gray'
    printf '%s\n' 'sdk: docker'
    printf '%s\n' 'app_port: 7860'
    printf '%s\n' 'pinned: false'
    printf '%s\n' '---'
    git show "$head:README.md"
  } | git hash-object -w --stdin
)
git update-index --add --cacheinfo "100644,$blob,README.md"

tree=$(git write-tree)
unset GIT_INDEX_FILE

snapshot=$(git commit-tree "$tree" \
  -p "$parent" \
  -m "deploy: $subject" \
  -m "Snapshot of $head for the Space. docs/ omitted (Hugging Face rejects
binary files in git history) and README.md carries the Space front matter.
Git history lives on GitHub.")

echo "deploy-space: HEAD $head -> snapshot ${snapshot:0:10}"
git push origin "$snapshot:main"
