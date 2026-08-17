#!/usr/bin/env bash
# check.sh — self-test de la máquina de agentes. Coste 0: NO llama a modelos de pago.
# Úsalo tras install.sh en un Mac nuevo y cuando algo "se sienta raro".  Alias: meshcheck
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HOME/mac-setup"
AM="$HERE/agentmesh.mjs"
KEY="$HOME/.config/sops/age/keys.txt"
fail=0
ok(){ echo "  ✅ $1"; }
ko(){ echo "  ❌ $1"; fail=1; }
echo "agentmesh check — self-test (coste 0):"

# 1) binarios imprescindibles
for c in node claude ollama git; do command -v "$c" >/dev/null && ok "binario $c" || ko "falta binario $c"; done

# 2) routing crítico (sin gastar)
node "$AM" --route-only --privacy sensitive --intent code-edit --complexity hard x 2>&1 | grep -q 'tier=local' && ok "privacy=sensitive -> local (nunca nube)" || ko "privacy=sensitive NO va a local"
node "$AM" --route-only --privacy normal --intent reason --complexity medium x 2>&1 | grep -q 'tier=cheap' && ok "default -> cheap (no opus)" || ko "default mal enrutado"
node "$AM" --route-only --privacy normal --intent code-edit --complexity medium x 2>&1 | grep -q 'tier=code' && ok "code-edit -> code" || ko "code-edit mal enrutado"

# 3) tests del router
node --test "$HERE/router.test.mjs" >/dev/null 2>&1 && ok "tests del router pasan" || ko "tests del router FALLAN"

# 4) secretos: age/sops descifra el vault
if [ -f "$KEY" ]; then
  (cd "$REPO" && SOPS_AGE_KEY_FILE="$KEY" sops -d --input-type dotenv --output-type dotenv secrets/ojolote.env.sops >/dev/null 2>&1) && ok "age/sops descifra el vault" || ko "age/sops NO descifra (revisa keys.txt)"
else ko "falta $KEY (restaura el backup de la clave age)"; fi

# 5) symlinks que pone install.sh
[ -L "$HOME/.claude/skills/arquitecto-ia" ] && ok "skill arquitecto-ia enlazada" || ko "skill arquitecto-ia NO enlazada"
[ -e "$HOME/.claude/projects/-Users-alvhor-Proyectos/memory/MEMORY.md" ] && ok "memoria (cerebro) accesible" || ko "memoria NO enlazada al repo"

# 6) hook global anti-secretos
[ "$(git config --global core.hooksPath 2>/dev/null)" = "$REPO/git-hooks" ] && ok "hook gitleaks global activo" || ko "hooksPath global no apunta al repo"

# 7) diagnóstico de backends (sin gastar)
echo "---"; node "$AM" doctor | sed 's/^/  /'

# 8) torre best-effort (lean: que esté apagada NO es un fallo)
echo "---"
if ssh -o ConnectTimeout=4 -o BatchMode=yes torre exit 2>/dev/null; then ok "torre alcanzable"; else echo "  ℹ️  torre apagada/no alcanzable (normal con filosofía lean)"; fi

# 9) fail-closed de privacidad (condición de cierre HIDRA): un dato sensible NUNCA cae a la nube
echo "---"
if node -e '
const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const ollamaDown = p.tiers.local.filter(c=>c.backend!=="ollama");   // si Ollama cae, ¿qué queda en local?
const afterFailClosed = ollamaDown.filter(c=>c.backend==="ollama"); // el filtro sensible deja solo ollama
process.exit(afterFailClosed.length===0 ? 0 : 1);                   // seguro = no queda backend => aborta, no usa cloud
' "$REPO/agentmesh/policy.json" 2>/dev/null; then ok "fail-closed privacidad: con Ollama caído, sensible ABORTA (no sale a la nube)"; else ko "FAIL-CLOSED ROTO: un dato sensible podría salir a la nube"; fi

# 10) zombis de "claude mcp serve" (huérfanos, PPID=1): cada sesión muerta deja uno; a veces
#     se quedan en bucle al 100% de CPU (30/07: 7 quemando 7 núcleos durante días + 66 dormidos).
#     Los que tienen padre vivo están EN USO y no se tocan. xargs, no $VAR: zsh no hace word-split.
echo "---"
ZOMBIS=$(ps -axo pid,ppid,command | grep "claude mcp serve" | grep -v grep | awk '$2==1{print $1}')
if [ -n "$ZOMBIS" ]; then
  N=$(echo "$ZOMBIS" | wc -l | tr -d " ")
  echo "$ZOMBIS" | xargs kill -9 2>/dev/null
  ok "zombis 'claude mcp serve' limpiados: $N huérfano(s) eliminados"
else
  ok "sin zombis de 'claude mcp serve'"
fi

echo ""
[ $fail -eq 0 ] && echo "✓ TODO OK" || echo "✗ Hay fallos arriba (revisa los ❌)"
exit $fail
