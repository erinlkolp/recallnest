#!/bin/bash
# Run the desktop ingest in the background so it isn't interrupted when the window closes
# Logs are written to data/desktop-ingest.log

cd "$(dirname "$0")/.."
LOG="data/desktop-ingest.log"

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting import of Desktop conversations..." > "$LOG"
bun run src/cli.ts ingest --source desktop >> "$LOG" 2>&1
echo "" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') Import complete" >> "$LOG"
