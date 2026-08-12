#!/usr/bin/env bash
# HIDRA — 2-minute interview demo. Prints routing decisions only (no tokens, no keys).
set -euo pipefail
NODE="$(command -v node)"        # capture node's absolute path BEFORE we strip PATH
# Cases 1-2 demonstrate ROUTING POLICY, so we declare every backend as present —
# the decision must be identical on any machine. Case 3 declares nothing on purpose:
# it demonstrates real availability, and must abort for real.
export HIDRA_ASSUME_AVAILABLE="ollama,claude,codex,gemini,openrouter,nvidia"
HIDRA="$(cd "$(dirname "$0")" && pwd)/hidra.mjs"
line() { printf '\n\033[1;34m$ %s\033[0m\n' "$1"; }

line "hidra --route-only --intent format --complexity trivial --privacy normal \"reformat a file\""
"$NODE" "$HIDRA" --route-only --intent format --complexity trivial --privacy normal "reformat a file" 2>&1 | grep -E "classify|route "
echo "  → trivial mechanical work runs on a FREE local model. Zero tokens spent."

line "hidra --route-only --intent architecture --complexity hard --privacy normal \"refactor the billing engine\""
"$NODE" "$HIDRA" --route-only --intent architecture --complexity hard --privacy normal "refactor the billing engine" 2>&1 | grep -E "classify|route "
echo "  → hard architecture is escalated to the frontier tier BY POLICY — the developer never chose it."

line "PATH stripped of local runtime  +  --privacy sensitive   (the sovereignty contract)"
set +e
env -u HIDRA_ASSUME_AVAILABLE PATH="/usr/bin:/bin" "$NODE" "$HIDRA" --intent code-edit --complexity hard --privacy sensitive "analyze a record containing personal data" 2>&1 | tail -1
CODE=${PIPESTATUS[0]:-$?}
set -e
echo "  → exit code: $CODE"
echo "  → sensitive data, no local model available: the system ABORTS. It does not fall back to the cloud,"
echo "    does not ask, does not fail silently. Exit 3 — traceable in any CI pipeline."
echo
echo "  This invariant has a contract test (privacy-invariant.test.mjs) that breaks the build if anyone removes it."
