#!/usr/bin/env bash
# Database helper for LORE-AI, backed by the local XAMPP MySQL/MariaDB.
#
#   ./scripts/db.sh start    # sudo /opt/lampp/lampp startmysql, then wait
#   ./scripts/db.sh stop
#   ./scripts/db.sh status
#   ./scripts/db.sh init     # create schema + load the 50-perfume seed
#   ./scripts/db.sh reset    # drop the database, then init again
#   ./scripts/db.sh cli      # mysql shell on lore_ai_db
#
# XAMPP's own `lampp status` reports MySQL as stopped because it greps for
# `netstat`, which is not installed here; this script probes the server
# directly with mariadb-admin instead.
set -euo pipefail

XAMPP_DIR=${XAMPP_DIR:-/opt/lampp}
LAMPP="$XAMPP_DIR/lampp"
MYSQL="$XAMPP_DIR/bin/mysql"
ADMIN="$XAMPP_DIR/bin/mariadb-admin"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Use the same credentials as the app.
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

SOCKET=${LORE_DB_SOCKET:-$XAMPP_DIR/var/mysql/mysql.sock}
HOST=${DB_HOST:-127.0.0.1}
PORT=${DB_PORT:-3306}
USER=${DB_USER:-root}
PASS=${DB_PASSWORD:-}
DB=${DB_NAME:-lore_ai_db}

die() { echo "error: $*" >&2; exit 1; }

mysql_args=(-h"$HOST" -P"$PORT" -u"$USER")
[ -n "$PASS" ] && mysql_args+=(-p"$PASS")
admin_args=(-h"$HOST" -P"$PORT" -u"$USER")
[ -n "$PASS" ] && admin_args+=(-p"$PASS")

is_up() { "$ADMIN" "${admin_args[@]}" ping >/dev/null 2>&1; }

cmd_start() {
  is_up && { echo "MySQL already up on $HOST:$PORT"; return; }
  sudo "$LAMPP" startmysql
  for _ in $(seq 1 60); do
    is_up && { echo "MySQL up on $HOST:$PORT"; return; }
    sleep 0.5
  done
  die "MySQL did not come up; check $XAMPP_DIR/var/mysql/*.err"
}

cmd_stop() {
  is_up || { echo "MySQL not running"; return; }
  sudo "$LAMPP" stopmysql
}

cmd_status() {
  if is_up; then
    local n
    n=$("$MYSQL" "${mysql_args[@]}" -N -e "SELECT COUNT(*) FROM $DB.perfumes" 2>/dev/null || echo "?")
    echo "MySQL up on $HOST:$PORT — $DB.perfumes=$n"
  else
    echo "MySQL not running"
  fi
}

cmd_init() {
  is_up || die "start MySQL first: $0 start"
  "$MYSQL" "${mysql_args[@]}" < "$ROOT_DIR/schema.sql"
  "$MYSQL" "${mysql_args[@]}" -N -e "SELECT COUNT(*) FROM $DB.perfumes" | {
    read -r n
    if [ "$n" = "0" ]; then
      "$MYSQL" "${mysql_args[@]}" < "$ROOT_DIR/seed.sql"
      echo "seeded $("$MYSQL" "${mysql_args[@]}" -N -e "SELECT COUNT(*) FROM $DB.perfumes") perfumes"
    else
      echo "perfumes already present: $n (use '$0 reset' to reload)"
    fi
  }
}

cmd_reset() {
  is_up || die "start MySQL first: $0 start"
  "$MYSQL" "${mysql_args[@]}" -e "DROP DATABASE IF EXISTS $DB"
  "$MYSQL" "${mysql_args[@]}" < "$ROOT_DIR/schema.sql"
  "$MYSQL" "${mysql_args[@]}" < "$ROOT_DIR/seed.sql"
  echo "database reset: $("$MYSQL" "${mysql_args[@]}" -N -e "SELECT COUNT(*) FROM $DB.perfumes") perfumes"
}

cmd_cli() { exec "$MYSQL" "${mysql_args[@]}" "$DB"; }

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  init) cmd_init ;;
  reset) cmd_reset ;;
  cli) cmd_cli ;;
  *) echo "usage: $0 {start|stop|status|init|reset|cli}" >&2; exit 2 ;;
esac
