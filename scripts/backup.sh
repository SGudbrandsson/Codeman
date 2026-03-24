#!/bin/bash
# Codeman backup script — backs up all persistent data
# Run via cron: 0 3 * * * /home/siggi/sources/Codeman/scripts/backup.sh

set -euo pipefail

CODEMAN_DIR="$HOME/.codeman"
BACKUP_DIR="$CODEMAN_DIR/backups"
DATE=$(date +%Y%m%d)
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

# 1. SQLite backup (uses better-sqlite3 .backup() for safe concurrent copy)
if [ -f "$CODEMAN_DIR/work-items.db" ]; then
  node -e "
    const db = require('better-sqlite3')('$CODEMAN_DIR/work-items.db', {readonly:true});
    db.backup('$BACKUP_DIR/work-items.db.$DATE').then(() => { db.close(); console.log('[backup] work-items.db done'); }).catch(e => { console.error('[backup] work-items.db FAILED:', e.message); process.exit(1); });
  "
fi

# 2. State JSON (atomic copy)
if [ -f "$CODEMAN_DIR/state.json" ]; then
  cp "$CODEMAN_DIR/state.json" "$BACKUP_DIR/state.json.$DATE"
  echo "[backup] state.json done"
fi

# 3. Vault data (tar the whole vaults directory)
if [ -d "$CODEMAN_DIR/vaults" ]; then
  tar -czf "$BACKUP_DIR/vaults.$DATE.tar.gz" -C "$CODEMAN_DIR" vaults/
  echo "[backup] vaults/ done"
fi

# 4. Clean up old backups
find "$BACKUP_DIR" -name "work-items.db.*" -not -name "*.log" -mtime +$KEEP_DAYS -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "state.json.*" -mtime +$KEEP_DAYS -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "vaults.*.tar.gz" -mtime +$KEEP_DAYS -delete 2>/dev/null || true
echo "[backup] Cleaned backups older than $KEEP_DAYS days"

echo "[backup] Done: $(date)"
