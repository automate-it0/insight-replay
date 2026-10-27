#!/usr/bin/env bash
# scripts/setup-git.sh — one-time git configuration for Insight Replay.
#
# Idempotent: safe to re-run. Sets repo-local config only (no --global),
# so it never touches the developer's other projects.
#
# What it does:
#   1. Wires .gitmessage as the commit message template.
#   2. Forces LF line endings (autocrlf = input) — prevents CRLF pollution
#      on cross-platform checkouts.
#   3. Sets pull.rebase = true so `git pull` rebases instead of merging
#      (keeps history linear; matches the trunk-based workflow in
#      docs/git-workflow.md).
#   4. Sets push.default = current so `git push` pushes the current branch
#      to its same-name remote without extra arguments.
#   5. Enables rerere (reuse recorded resolution) to remember how merge
#      conflicts were resolved — fewer re-conflicts on rebase.
#   6. Enables color UI + helpful aliases for the conventional-commit flow.
#
# Run from the repo root:  bash scripts/setup-git.sh

set -euo pipefail

# Resolve the repo root from the script location so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Sanity checks ----------------------------------------------------------
if [ ! -f "$REPO_ROOT/.gitmessage" ]; then
  echo "ERROR: .gitmessage not found at $REPO_ROOT/.gitmessage" >&2
  echo "       Run this script from the repo root: bash scripts/setup-git.sh" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO_ROOT is not a git repository." >&2
  echo "       Run 'git init' first, then re-run this script." >&2
  exit 1
fi

cd "$REPO_ROOT"

# --- Repo-local config (no --global anywhere) -------------------------------
# git resolves commit.template relative to the repository root, so a bare
# `.gitmessage` works no matter where the developer runs `git commit` from.
git config commit.template .gitmessage

# Line endings: keep LF in the repo, let git convert to CRLF on checkout
# only on Windows. `input` is the safe cross-platform default.
git config core.autocrlf input

# Pull strategy: rebase. Keeps `git pull` from creating merge commits
# on main; matches the trunk-based workflow.
git config pull.rebase true

# Push default: current. `git push` pushes the current branch to a branch
# of the same name on the remote — no surprises.
git config push.default current

# Remember conflict resolutions across rebases.
git config rerere.enabled true

# Helpful UI defaults.
git config color.ui auto

# Conventional-commit-friendly aliases. Optional, but they make the
# workflow in docs/git-workflow.md one keystroke away.
git config alias.lg "log --oneline --graph --decorate -20"
git config alias.unstage "reset HEAD --"
git config alias.serve "status -sb"

# --- Confirmation -----------------------------------------------------------
echo "✓ git workflow configured for Insight Replay (repo-local only)."
echo
echo "  commit.template    = $(git config commit.template)"
echo "  core.autocrlf      = $(git config core.autocrlf)"
echo "  pull.rebase        = $(git config pull.rebase)"
echo "  push.default       = $(git config push.default)"
echo "  rerere.enabled     = $(git config rerere.enabled)"
echo
echo "  Aliases:"
echo "    git lg           — short decorated log"
echo "    git unstage <f>  — unstage a file"
echo "    git serve        — short branch status"
echo
echo "Next: commit messages will now open with the .gitmessage template."
echo "See docs/git-workflow.md for branching + PR conventions."
