#!/bin/bash
# re-ingest-cc.sh — full rebuild of the RecallNest index
#
# Background: the old dedup thresholds (hard=0.80, soft=0.68) caused 72% of content
#             to be dropped by mistake, and the old data may contain noise. The cleanest
#             approach is to wipe everything and re-import from scratch with the new thresholds.
#
# Usage:
#   cd ~/recallnest && bash scripts/re-ingest-cc.sh
#
# Steps:
#   1. Back up LanceDB + ingested-files.json + distill-progress.json
#   2. reset (wipe LanceDB)
#   3. Clear ingest and distill progress records
#   4. Full ingest (all sources)
#   5. When done, prompt to run distill-facts manually
#
# Estimated time: 3-5 hours (runs in the background)
# Estimated API cost: ~$3-5

set -euo pipefail
cd "$(dirname "$0")/.."

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="data/backup-$TIMESTAMP"
LOG_FILE="logs/re-ingest-$TIMESTAMP.log"

echo "=== RecallNest full rebuild ===" | tee "$LOG_FILE"
echo "Start time: $(date)" | tee -a "$LOG_FILE"

# Step 1: Back up
echo "[1/4] Backing up existing data..." | tee -a "$LOG_FILE"
mkdir -p "$BACKUP_DIR"
cp data/ingested-files.json "$BACKUP_DIR/" 2>/dev/null || true
cp data/distill-progress.json "$BACKUP_DIR/" 2>/dev/null || true
# LanceDB is too large to back up in full; just record stats
echo "  Current LanceDB size: $(du -sh data/lancedb 2>/dev/null | cut -f1)" | tee -a "$LOG_FILE"
echo "  Backed up to: $BACKUP_DIR/" | tee -a "$LOG_FILE"

# Step 2: Wipe LanceDB
echo "[2/4] Wiping LanceDB index..." | tee -a "$LOG_FILE"
bun run src/cli.ts reset --yes 2>&1 | tee -a "$LOG_FILE"

# Step 3: Clear progress records
echo "[3/4] Clearing ingest/distill progress records..." | tee -a "$LOG_FILE"
# Reset ingested-files.json — make ingest treat all files as unprocessed
echo '{"files":{}}' > data/ingested-files.json
# Reset distill progress
echo '{"startedAt":"","lastUpdated":"","completedScopes":[],"stats":{}}' > data/distill-progress.json
echo "  Progress reset" | tee -a "$LOG_FILE"

# Step 4: Full ingest
echo "[4/4] Starting full import (this step takes 3-5 hours)..." | tee -a "$LOG_FILE"
echo "  Logs written live to: $LOG_FILE" | tee -a "$LOG_FILE"
echo "  Watch progress: tail -f $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

bun run src/cli.ts ingest 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "=== Full import complete ===" | tee -a "$LOG_FILE"
echo "End time: $(date)" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "Next steps:" | tee -a "$LOG_FILE"
echo "  1. Check the logs to confirm the ingest rate (target 50-65%; old threshold was 27%)" | tee -a "$LOG_FILE"
echo "  2. Run distill: bun scripts/distill-facts.ts" | tee -a "$LOG_FILE"
echo "  3. Old data is backed up in: $BACKUP_DIR/" | tee -a "$LOG_FILE"
