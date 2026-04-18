#!/bin/sh
# Post-install patches for Baileys v7.0.0-rc.9
# Fixes known bugs in the release version

set -e

BAILEYS_DIR="node_modules/@whiskeysockets/baileys"

if [ ! -d "$BAILEYS_DIR" ]; then
    echo "Baileys not found in node_modules, skipping patches"
    exit 0
fi

echo "Applying Baileys patches..."

# Patch 1: Remove lidDbMigrated from login payload (doesn't exist in WA protocol)
if grep -q "lidDbMigrated.*false" "$BAILEYS_DIR/lib/Utils/validate-connection.js" 2>/dev/null || \
   grep -q "lidDbMigrated.*false" "$BAILEYS_DIR/dist/Utils/validate-connection.js" 2>/dev/null; then
    echo "Patch 1: Removing lidDbMigrated from validate-connection"
    sed -i.bak '/lidDbMigrated.*false/d' "$BAILEYS_DIR/lib/Utils/validate-connection.js" 2>/dev/null || true
    sed -i.bak '/lidDbMigrated.*false/d' "$BAILEYS_DIR/dist/Utils/validate-connection.js" 2>/dev/null || true
fi

# Patch 2: Fix noise.finishInit() timing (remove await to prevent race condition)
if grep -q "await noise\.finishInit()" "$BAILEYS_DIR/lib/Socket/socket.js" 2>/dev/null || \
   grep -q "await noise\.finishInit()" "$BAILEYS_DIR/dist/Socket/socket.js" 2>/dev/null; then
    echo "Patch 2: Fixing noise.finishInit() timing"
    sed -i.bak 's/await noise\.finishInit();/noise.finishInit();/g' "$BAILEYS_DIR/lib/Socket/socket.js" 2>/dev/null || true
    sed -i.bak 's/await noise\.finishInit();/noise.finishInit();/g' "$BAILEYS_DIR/dist/Socket/socket.js" 2>/dev/null || true
fi

# Patch 3: Change platform from WEB to MACOS (WEB is deprecated by WA)
if grep -q "Platform.WEB" "$BAILEYS_DIR/lib/Utils/validate-connection.js" 2>/dev/null || \
   grep -q "Platform.WEB" "$BAILEYS_DIR/dist/Utils/validate-connection.js" 2>/dev/null; then
    echo "Patch 3: Changing platform from WEB to MACOS"
    sed -i.bak 's/Platform\.WEB/Platform.MACOS/g' "$BAILEYS_DIR/lib/Utils/validate-connection.js" 2>/dev/null || true
    sed -i.bak 's/Platform\.WEB/Platform.MACOS/g' "$BAILEYS_DIR/dist/Utils/validate-connection.js" 2>/dev/null || true
fi

echo "Baileys patches applied successfully"
