#!/usr/bin/env bash
# Despliega/actualiza el cerebro agentmesh en la torre Windows (vía SSH/Tailscale).
# Reejecutar tras editar policy.json o los .mjs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -o ConnectTimeout=6 -o BatchMode=yes)
SCP=(scp -o ConnectTimeout=6 -o BatchMode=yes)
if ! "${SSH[@]}" torre 'exit' 2>/dev/null; then
  echo "✗ La torre no responde (¿encendida? ¿Tailscale activo?). Enciéndela y reintenta." >&2
  exit 1
fi
"${SSH[@]}" torre 'New-Item -ItemType Directory -Force agentmesh | Out-Null'
"${SCP[@]}" "$HERE/agentmesh.mjs" "$HERE/policy.json" "$HERE/meshnet.mjs" torre:agentmesh/
echo "✓ agentmesh desplegado en la torre. Estado:"
"${SSH[@]}" torre 'node agentmesh/agentmesh.mjs status'

# MCP de Baserow en la torre (la torre no tiene el vault; la URL viaja desde el vault del Mac)
BMCP=$(SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt" sops -d --input-type dotenv --output-type dotenv "$HOME/mac-setup/secrets/baserow.env.sops" 2>/dev/null | sed -n 's/^BASEROW_MCP_URL=//p')
if [ -n "$BMCP" ]; then
  "${SSH[@]}" torre "claude mcp remove baserow-crm 2>\$null; claude mcp add --scope user --transport sse baserow-crm $BMCP" >/dev/null 2>&1 && echo "✓ MCP baserow-crm conectado en la torre"
fi

# Paridad de "cerebro": skills + CLAUDE.md (routing) en la torre. Su Claude Code (backend de
# agentmesh y/o tú por RDP) conoce así las mismas convenciones y skills que el Mac.
# OJO: los paths internos de las skills (~/Proyectos/OjoLote, ~/mac-setup) son del Mac; en la
# torre (Windows) esas referencias a ficheros no resuelven salvo que se clonen los repos allí.
REPO="$(dirname "$HERE")"
"${SSH[@]}" torre 'New-Item -ItemType Directory -Force .claude\skills | Out-Null'
"${SCP[@]}" -r "$REPO"/skills/* torre:.claude/skills/ >/dev/null 2>&1 && echo "✓ skills sincronizadas en la torre"
"${SCP[@]}" "$REPO/claude/CLAUDE.md" torre:.claude/CLAUDE.md >/dev/null 2>&1 && echo "✓ CLAUDE.md (routing/convenciones) en la torre"
"${SCP[@]}" "$REPO/claude/ROUTING.md" torre:.claude/ROUTING.md >/dev/null 2>&1 || true
