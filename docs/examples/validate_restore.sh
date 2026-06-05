#!/usr/bin/env bash
# Simple restore validation script for hamlive
# Usage: ./validate_restore.sh <MONGO_URI> <DB>

set -euo pipefail
MONGO_URI="$1"
DB="$2"

echo "Validating restore for DB: $DB"

# helper to run a JS snippet via mongosh
run_js() {
  local js="$1"
  mongosh "$MONGO_URI/$DB" --quiet --eval "$js"
}

# 1) list collections
echo "Collections:" 
run_js 'JSON.stringify(db.getCollectionNames())'

# 2) counts for critical collections
for coll in LiveNets NetProfile StationInteraction UserProfile FlexOptions; do
  echo -n "Count $coll: "
  run_js "db.getCollection('$coll').count()"
done

# 3) show FlexOptions sample
echo "FlexOptions sample:" 
run_js "JSON.stringify(db.getCollection('FlexOptions').findOne() || {})"

# 4) basic query to ensure indexes work (example)
echo "Sample LiveNet query (limit 1):"
run_js "JSON.stringify(db.getCollection('LiveNets').find({}).limit(1).toArray())"

echo "Validation complete."
