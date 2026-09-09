#!/usr/bin/env bash
# Applies src/db/migrations/*.sql in filename order, each one exactly once,
# recorded in the _migration table. Safe to run more than once.
#
# Usage: scripts/migrate.sh [--local] [--remote]     (default: --local)
set -euo pipefail
cd "$(dirname "$0")/.."

D1_NAME=wardrobe
DIR=src/db/migrations

LOCAL=0
REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --local)  LOCAL=1 ;;
    --remote) REMOTE=1 ;;
    *) echo "usage: $0 [--local] [--remote]" >&2; exit 2 ;;
  esac
done
[ "$LOCAL" -eq 1 ] || [ "$REMOTE" -eq 1 ] || LOCAL=1

# `d1 execute <name>` resolves the name through the binding in wrangler.jsonc, so
# the real database id has to be in there already. scripts/setup.sh writes it.
# --yes keeps every call unattended.
sql() {
  local target=$1
  shift
  npx wrangler d1 execute "$D1_NAME" "$target" --yes "$@"
}

applied() {
  npx wrangler d1 execute "$D1_NAME" "$1" --yes --json \
    --command "SELECT name FROM _migration ORDER BY name" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j = JSON.parse(s);
      for (const row of (Array.isArray(j) ? j[0] : j).results) console.log(row.name);
    })'
}

migrate() {
  local target=$1
  local out ledger count file name
  echo "==> ${target#--}"

  out=""
  if ! out=$(sql "$target" --command "CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))" 2>&1); then
    echo "$out" >&2
    echo "migrate: could not create the _migration ledger on ${target#--}" >&2
    exit 1
  fi

  ledger=""
  ledger=$(applied "$target")

  count=0
  for file in "$DIR"/*.sql; do
    [ -e "$file" ] || continue
    name=$(basename "$file")
    case "
$ledger
" in
      *"
$name
"*) continue ;;
    esac

    out=""
    if ! out=$(sql "$target" --file="$file" 2>&1); then
      echo "$out" >&2
      echo "migrate: $name failed on ${target#--}. Nothing was recorded for it, and no later migration ran." >&2
      exit 1
    fi

    out=""
    if ! out=$(sql "$target" --command "INSERT OR IGNORE INTO _migration (name) VALUES ('$name')" 2>&1); then
      echo "$out" >&2
      echo "migrate: $name ran on ${target#--} but could not be recorded. Record it by hand before running again." >&2
      exit 1
    fi

    echo "    applied $name"
    count=$((count + 1))
  done

  [ "$count" -gt 0 ] || echo "    nothing to do, already up to date"
}

[ "$LOCAL" -eq 0 ]  || migrate --local
[ "$REMOTE" -eq 0 ] || migrate --remote
