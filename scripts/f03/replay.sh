#!/usr/bin/env bash
#
# F-03 disposable-database migration replay harness.
#
# Applies supabase/migrations/*.sql to a throwaway database on a LOCAL
# PostgreSQL cluster and reports, per run, exactly what was applied, adapted,
# or skipped. No hosted Supabase project is ever contacted by this script.
#
# Usage:
#   replay.sh <dbname> [options]
#
#   --resolve-aliases   Honour config/migration-provenance-manifest.json: for
#                       each declared logical migration apply only the alias
#                       the manifest records as APPLIED, and skip the alias it
#                       records as unapplied in every environment. This models
#                       the lineage the real ledgers carry rather than the
#                       double-apply a naive `ls | sort` would perform. Every
#                       skip that actually matched a file in the tree is
#                       printed as ALIAS_SKIP -- nothing is dropped silently.
#
#   --historical-order  Reconstruct the order in which the Watchlist push-token
#                       lineage was ACTUALLY built, rather than the order the
#                       current filenames imply. Concretely: hold
#                       20260830190000_watchlist_push_token_actor_isolation.sql
#                       back from its filename position and apply it directly
#                       after 20260830212508_user_device_push_tokens.sql, under
#                       its true staging ledger version 20260830214752. Use
#                       this to build an "existing upgraded database" fixture.
#
#   --until <version>   Stop after the file whose version is <version>
#                       (inclusive), so a fixture can be cut at an exact point.
#   --after <version>   Skip every file at or before <version>.
#   --only <file>       Apply exactly one migration file, by basename.
#   --keep              Do not drop/recreate the database; apply onto whatever
#                       is already there. Required to upgrade a fixture.
#   --exclude <file>    Skip one file by basename (repeatable).
#
# Exits non-zero on the first migration that fails, printing the failing file
# and the server error verbatim.
#
# ENGINE NOTE. This tree targets PostgreSQL 17: ten migrations REVOKE the
# PG17-only MAINTAIN privilege (see the comment in
# 20260712020000_harden_app_role_privileges.sql). When the harness cluster is
# older than 17, MAINTAIN is stripped from GRANT/REVOKE privilege lists before
# the file is applied, and every adapted file is reported as ENGINE_SHIM. The
# shim never edits the file on disk, never removes a statement, and does not
# reach the Watchlist push-token region F-03 certifies: it strikes one
# privilege keyword out of blanket REVOKE-from-client-roles statements, which
# can only ever loosen the harness's assertion, never the repair's.

set -uo pipefail

PGROOT="${F03_PGROOT:-/var/lib/postgresql/f03}"
PGBIN="${F03_PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${F03_PGPORT:-5433}"
PGUSER_ADMIN="${F03_PGUSER:-supabase_admin}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
BOOTSTRAP="$REPO_ROOT/scripts/f03/supabase-bootstrap.sql"

# The out-of-order pair F-03 is about, and the hardening file's true staging
# ledger identity (config/migration-authority-manifest.json, entry 20260830212508).
DEPENDENT_FILE="20260830190000_watchlist_push_token_actor_isolation.sql"
DEPENDENCY_FILE="20260830212508_user_device_push_tokens.sql"
DEPENDENT_LEDGER_VERSION="20260830214752"

WORKDIR="$(mktemp -d)"; chmod a+rx "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

DB=""; UNTIL=""; AFTER=""; ONLY=""
RESOLVE_ALIASES=0; HISTORICAL=0; KEEP=0
EXCLUDES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --until)            UNTIL="$2"; shift 2 ;;
    --after)            AFTER="$2"; shift 2 ;;
    --only)             ONLY="$2"; shift 2 ;;
    --exclude)          EXCLUDES+=("$2"); shift 2 ;;
    --resolve-aliases)  RESOLVE_ALIASES=1; shift ;;
    --historical-order) HISTORICAL=1; shift ;;
    --keep)             KEEP=1; shift ;;
    -*)                 echo "unknown option: $1" >&2; exit 2 ;;
    *)                  DB="$1"; shift ;;
  esac
done
[[ -z "$DB" ]] && { echo "usage: replay.sh <dbname> [options]" >&2; exit 2; }

run_psql() { su postgres -c "$PGBIN/psql -h $PGROOT -p $PGPORT -U $PGUSER_ADMIN -d '$DB' $*"; }

if [[ $KEEP -eq 0 ]]; then
  su postgres -c "$PGBIN/dropdb -h $PGROOT -p $PGPORT -U $PGUSER_ADMIN --if-exists '$DB'" >/dev/null 2>&1
  su postgres -c "$PGBIN/createdb -h $PGROOT -p $PGPORT -U $PGUSER_ADMIN '$DB'" || exit 1
  run_psql "-q -f '$BOOTSTRAP'" 2>&1 | grep -vE 'already exists|NOTICE' | sed 's/^/  bootstrap: /'
fi

# ── which files the provenance manifest says to skip ────────────────────────
ALIAS_SKIPS=()
if [[ $RESOLVE_ALIASES -eq 1 ]]; then
  while IFS= read -r f; do
    [[ -f "$MIGRATIONS_DIR/$f" ]] || continue   # manifest may name a relocated file
    ALIAS_SKIPS+=("$f")
    echo "ALIAS_SKIP  $f (manifest: unapplied in every environment; its applied twin carries the same SQL)" >&2
  done < <(node -e '
    const m = require(process.argv[1]);
    for (const lm of m.logicalMigrations)
      for (const a of lm.aliases)
        if (a.status !== "applied") console.log(a.filename);
  ' "$REPO_ROOT/config/migration-provenance-manifest.json")
fi

SERVER_MAJOR="$(su postgres -c "$PGBIN/psql -h $PGROOT -p $PGPORT -U $PGUSER_ADMIN -d postgres -tAc 'show server_version_num'" | cut -c1-2)"
SHIM_MAINTAIN=0; [[ "$SERVER_MAJOR" -lt 17 ]] && SHIM_MAINTAIN=1

applied=0; shimmed=0; failed_file=""; first_file=""; last_file=""

apply_file() {   # apply_file <basename> <ledger-version>
  local file="$1" version="$2" path="$MIGRATIONS_DIR/$1" apply_path out rc
  apply_path="$path"
  if [[ $SHIM_MAINTAIN -eq 1 ]] && grep -qiE '(grant|revoke)[^;]*\bmaintain\b' "$path"; then
    apply_path="$WORKDIR/$file"
    sed -E 's/\bmaintain\b, ?//gI; s/, ?maintain\b//gI' "$path" > "$apply_path"
    chmod a+r "$apply_path"
    echo "ENGINE_SHIM  $file (PG17 MAINTAIN stripped for a PG$SERVER_MAJOR harness cluster)" >&2
    shimmed=$((shimmed + 1))
  fi
  out="$(run_psql "-q -v ON_ERROR_STOP=1 --single-transaction -f '$apply_path'" 2>&1)"; rc=$?
  if [[ $rc -ne 0 ]]; then
    failed_file="$file"
    echo "FAIL  $file"
    echo "$out" | sed 's/^/      /'
    return 1
  fi
  run_psql "-q -c \"insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$file') on conflict (version) do nothing\"" >/dev/null 2>&1
  applied=$((applied + 1))
  [[ -z "$first_file" ]] && first_file="$file"
  last_file="$file"
  return 0
}

for path in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  file="$(basename "$path")"; version="${file%%_*}"

  if [[ -n "$ONLY" ]]; then
    [[ "$file" == "$ONLY" ]] || continue
    apply_file "$file" "$version" || break
    continue
  fi

  skip=0
  for ex in ${EXCLUDES+"${EXCLUDES[@]}"};    do [[ "$file" == "$ex" ]] && skip=1; done
  for al in ${ALIAS_SKIPS+"${ALIAS_SKIPS[@]}"}; do [[ "$file" == "$al" ]] && skip=1; done
  [[ -n "$AFTER" && ! "$version" > "$AFTER" ]] && skip=1
  # In historical order the dependent is held back from its filename position
  # and re-applied immediately after its dependency, below.
  [[ $HISTORICAL -eq 1 && "$file" == "$DEPENDENT_FILE" ]] && skip=1
  [[ $skip -eq 1 ]] && continue

  apply_file "$file" "$version" || break

  if [[ $HISTORICAL -eq 1 && "$file" == "$DEPENDENCY_FILE" ]]; then
    echo "HISTORICAL_ORDER  $DEPENDENT_FILE applied after $DEPENDENCY_FILE as ledger version $DEPENDENT_LEDGER_VERSION" >&2
    apply_file "$DEPENDENT_FILE" "$DEPENDENT_LEDGER_VERSION" || break
  fi

  [[ -n "$UNTIL" && "$version" == "$UNTIL" ]] && break
done

echo "REPLAY_DB=$DB"
echo "MIGRATIONS_APPLIED=$applied"
echo "ENGINE_SHIMMED=$shimmed"
echo "ALIAS_SKIPPED=${#ALIAS_SKIPS[@]}"
echo "FIRST_MIGRATION=${first_file:-none}"
echo "LAST_MIGRATION=${last_file:-none}"
if [[ -n "$failed_file" ]]; then
  echo "FAILED_MIGRATION=$failed_file"; echo "REPLAY=FAIL"; exit 1
fi
echo "FAILED_MIGRATION=none"
echo "REPLAY=PASS"
