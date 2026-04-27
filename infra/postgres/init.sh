#!/usr/bin/env bash
# Postgres init script — runs once on first boot of orbit-postgres.
# Creates the `keycloak` database used by the Keycloak server.
# (The main `orbit` database is auto-created from POSTGRES_DB env.)

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  SELECT 'CREATE DATABASE keycloak'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
  GRANT ALL PRIVILEGES ON DATABASE keycloak TO $POSTGRES_USER;
EOSQL

echo "[init] keycloak database ready"
