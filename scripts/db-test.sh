#!/usr/bin/env bash
# Applies all migrations to a scratch database and runs the SQL test suite.
# Needs PostgreSQL 16 with PostGIS. Usage: DATABASE_URL=postgres://... scripts/db-test.sh
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to an admin connection on a disposable server}"
cd "$(dirname "$0")/.."
db="lpm_test_$$"
psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "create database $db"
trap 'psql "$DATABASE_URL" -qAt -c "drop database if exists $db" >/dev/null' EXIT
url="${DATABASE_URL%/*}/$db"
run() { psql "$url" -qAt -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
run supabase/local/auth_shim.sql
for f in supabase/migrations/*.sql; do run "$f"; echo "applied $(basename "$f")"; done
for f in supabase/tests/*.sql; do
  psql "$url" -qAt -v ON_ERROR_STOP=1 -f "$f"
done
