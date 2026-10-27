#!/usr/bin/env bash
# The same gate .github/workflows/ci.yml defines, runnable where GitHub is not.
#
# This exists because push events have never started this repository's CI: the
# workflow was created by a push on 2026-10-22, and `gh api
# repos/.../actions/runs` reported total_count 0 until a manual dispatch on
# 2026-10-24 created the first run. An empty commit pushed on 2026-10-24
# (f818051) produced no run either, so the branch cannot rely on CI firing.
#
# Usage:
#   bash scripts/verify.sh                       # uses DATABASE_URL_TEST or a local default
#   DATABASE_URL_TEST=postgres://user@localhost:5432/cabinet_test bash scripts/verify.sh
#
# Steps mirror package.json (typecheck / lint / test / build) plus one step with no
# checking npm script of its own: `doc:facts --check` (running `pnpm doc:facts` would
# rewrite the README instead of failing), so a green run here still means what a
# green run in Actions means.
set -euo pipefail

BIN="./node_modules/.bin"
DB_URL="${DATABASE_URL_TEST:-postgres://localhost:5432/cabinet_test}"

export DATABASE_URL="${DATABASE_URL:-$DB_URL}"
export DATABASE_URL_TEST="$DB_URL"
export TZ="${TZ:-UTC}"
export AUTH_REQUIRED="${AUTH_REQUIRED:-false}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-only-secret-not-for-production}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:3000}"

if [ ! -x "$BIN/tsc" ] || [ ! -x "$BIN/tsx" ]; then
  echo "verify: $BIN/tsc or $BIN/tsx is missing — run pnpm install first" >&2
  exit 1
fi

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

# README 里的数字（route 数、表数、测试文件/用例数）是 `doc-facts --write` 生成的。
# 这里只比对不写：CI 里重写 README 等于把漂移藏起来，而数字过期是最便宜的一种失败
# ——不碰数据库、不读 env、亚秒级——所以放在创建临时库和 migrate 之前，
# 免得为了发现"README 说 47 个 route"先等一次 create database / drizzle migrate。
step "doc:facts" "$BIN/tsx" scripts/doc-facts.ts --check

# CI applies the migration chain to an empty postgres service container. A
# long-lived local database is normally built by `drizzle-kit push` (see
# package.json test:db:setup), which leaves drizzle.__drizzle_migrations empty;
# replaying 0000..0027 there dies on objects that already exist and says nothing
# about the migrations themselves. Verify against a throwaway database so this
# step fails only when the chain is genuinely broken.
BASE_URL="${PG_BASE_URL:-postgres://localhost:5432}"
ADMIN_URL="$BASE_URL/postgres"
MIGRATE_DB="cabinet_verify_$$"

drop_migrate_db() {
  psql "$ADMIN_URL" -q -c "drop database if exists \"$MIGRATE_DB\"" >/dev/null 2>&1 || true
}
trap drop_migrate_db EXIT

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "create database \"$MIGRATE_DB\""
step "db:migrate (fresh $MIGRATE_DB)" env DATABASE_URL="$BASE_URL/$MIGRATE_DB" "$BIN/drizzle-kit" migrate
step "typecheck" "$BIN/tsc" --noEmit
step "lint" "$BIN/eslint"
step "test" "$BIN/vitest" run --maxWorkers=1 --no-file-parallelism
step "build" "$BIN/next" build

printf '\nverify: ok\n'
