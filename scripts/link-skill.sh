#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="${REPO_ROOT}/skills/camoufox-browser"
SKILL_NAME="camoufox-browser"

if [[ ! -d "${SKILL_SRC}" ]]; then
  echo "Skill directory not found: ${SKILL_SRC}" >&2
  exit 1
fi

targets=("${HOME}/.agents/skills")

if [[ "${1:-}" == "--all" ]]; then
  targets+=("${HOME}/.pi/agent/skills")
fi

for target_dir in "${targets[@]}"; do
  mkdir -p "${target_dir}"
  link_path="${target_dir}/${SKILL_NAME}"

  if [[ -e "${link_path}" && ! -L "${link_path}" ]]; then
    echo "Refusing to replace non-symlink path: ${link_path}" >&2
    echo "Move/remove it first, then run this script again." >&2
    exit 1
  fi

  ln -sfn "${SKILL_SRC}" "${link_path}"
  echo "Linked ${link_path} -> ${SKILL_SRC}"
done
