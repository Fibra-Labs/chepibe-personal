#!/bin/sh
set -e

# Fix ownership of mounted data directory
if [ -d "/data" ]; then
  chown -R nodejs:nodejs /data
fi

# Drop to non-root user and exec the main process
exec gosu nodejs "$@"