#!/bin/bash
cd "$(dirname "$0")/.."
node workers/github-ops.js &
node workers/coding.js &
node workers/research.js &
node workers/dev-ops.js &
echo "All workers started"
