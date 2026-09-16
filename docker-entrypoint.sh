#!/bin/sh
# Start the Inventory service, applying database migrations first only when asked.
#
# RUN_MIGRATIONS=true runs `prisma migrate deploy` before the server starts. Off by default: the
# database is shared, and more than one container starting at once should not all try to change
# it. Turn it on for exactly one instance per release -- the same step Render's build runs today.
set -e

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "Applying database migrations..."
  npx --no-install prisma migrate deploy
fi

exec "$@"
