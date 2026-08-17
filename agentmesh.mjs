#!/usr/bin/env node
/**
 * agentmesh — enruta cada tarea al agente/modelo/máquina más barato CAPAZ y DISPONIBLE.
 *
 *   1) CLASIFICAR  -> Ollama local (gratis) infiere {intent,complexity,privacy}. O por flags.
 *   2) ENRUTAR     -> reglas de policy.json (0 tokens) eligen un TIER.
 *   3) DISPONIBLE  -> dentro del tier, usa el primer backend instalado/logueado. Si pagas uno
 *                     este mes (`mesh use codex|gemini|openrouter`), se prioriza. Si no, cae al siguiente.
 *   4) EJECUTAR    -> en mac (local) o torre (ssh). 5) LOG.
 *
 *   mesh "<tarea>"            mesh --dry "<tarea>"        mesh --route-only "<tarea>"
 *   mesh --intent X --complexity hard --machine torre "<tarea>"   mesh --privacy sensitive "<tarea>"
 *   mesh status              mesh use codex|gemini|openrouter|none
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { parseNvidiaResponse } from "./nim-parse.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// HIDRA_POLICY: la config es del OPERADOR, no del código. El repo trae una policy de
// referencia (la de la demo); cada máquina apunta la suya por env sin ensuciar el clon.
const policy = JSON.parse(readFileSync(process.env.HIDRA_POLICY || join(HERE, "policy.json"), "utf8"));
const LOG = join(HERE, "agentmesh.log");
const ACTIVE = join(HERE, "active.json");
const WIN = process.platform === "win32";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const expand = (p) => p.replace(/^~/, HOME);

// ---------- disponibilidad (sin gastar) ----------
function cmdExists(c) { return spawnSync(WIN ? "where" : "which", [c], { encoding: "utf8", shell: WIN }).status === 0; }
// Ollama es ON-DEMAND (no servicio): solo "disponible" si su servidor responde AHORA.
function ollamaUp() {
  try { return (spawnSync("curl", ["-s", "--max-time", "2", "http://localhost:11434/api/version"], { encoding: "utf8" }).stdout || "").includes("version"); }
  catch { return false; }
}
// HIDRA_ASSUME_AVAILABLE: backends declarados disponibles por env, para poder testear la
// POLÍTICA de routing en cualquier máquina (CI, el portátil de un revisor) sin instalar
// cada runtime. No relaja la soberanía: solo declara qué backends existen; el filtro de
// sensitive sigue eligiendo únicamente candidatos locales. (Portado de hidra.mjs.)
const ASSUMED = new Set((process.env.HIDRA_ASSUME_AVAILABLE || "").split(",").map((x) => x.trim()).filter(Boolean));

function available(backend) {
  if (ASSUMED.has(backend)) return true;
  const a = policy.availability[backend];
  if (!a) return false;
  if (a.cmd && !cmdExists(a.cmd)) return false;
  if (a.anyOf) {
    const ok = a.anyOf.some((c) => (c.env && process.env[c.env]) || (c.file && existsSync(expand(c.file))));
    if (!ok) return false;
  }
  // Ollama: disponible si el binario existe. NO se excluye por estar dormido — se DESPIERTA
  // on-demand al ejecutar (así una tarea privada va a local, no se filtra a la nube).
  return true;
}
// Despierta Ollama si está dormido. Devuelve true si fuimos NOSOTROS quienes lo arrancamos.
function ensureOllama() {
  if (ollamaUp()) return false;
  console.error("→ despertando Ollama (on-demand)…");
  spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 25 && !ollamaUp(); i++) spawnSync("sleep", ["1"]);
  return true;
}
// Clasificador heurístico de coste CERO (cuando Ollama no está corriendo).
function heuristic(t) {
  const s = t.toLowerCase(); const has = (...k) => k.some((x) => s.includes(x));
  let intent = "reason", complexity = "medium", privacy = "normal";
  if (has("contraseñ", "password", "secreto", "privad", "token", "api key")) privacy = "sensitive";
  if (has("resume", "resúme", "summary", "tldr")) intent = "summarize";
  else if (has("traduce", "translate")) intent = "translate";
  else if (has("email", "correo", "redacta")) intent = "email";
  else if (has("código", "funcion", "función", "endpoint", "script", "refactor", " test", "bug", "componente")) intent = "code-edit";
  else if (has("arquitectura", "diseña", "diseño", "plan", "estrategia")) { intent = "architecture"; complexity = "hard"; }
  else if (has("investiga", "busca", "mercado", "research", "competidor")) intent = "research";
  else if (has("formatea", "clasifica", "extrae", "renombra")) { intent = "format"; complexity = "trivial"; }
  if (has("difícil", "complejo", "optimiz", "depura", "race condition")) complexity = "hard";
  return { intent, complexity, privacy };
}
function getPaid() {
  if (process.env[policy.paidEnv]) return process.env[policy.paidEnv];
  if (existsSync(ACTIVE)) { try { return JSON.parse(readFileSync(ACTIVE, "utf8")).paid || "none"; } catch {} }
  return "none";
}
// Auto-carga del vault age (HIDRA V2 Fase 0): si una API key de pago no está en el entorno pero SÍ
// en el vault cifrado, la inyecta en process.env (una vez). Así openrouter/deepseek funcionan SIN
// 'loadsecrets' manual. Silencioso y a prueba de fallos: sin vault / sin sops / sin clave age → no-op.
function loadVault() {
  if (process.env.OPENROUTER_API_KEY) return;            // ya cargado (p.ej. por loadsecrets en la shell)
  const f = expand("~/mac-setup/secrets/ojolote.env.sops");
  if (!existsSync(f)) return;
  try {
    const env = { ...process.env };
    const keyFile = expand("~/.config/sops/age/keys.txt");
    if (existsSync(keyFile)) env.SOPS_AGE_KEY_FILE = keyFile;
    const r = spawnSync("sops", ["-d", "--input-type", "dotenv", "--output-type", "dotenv", f], { encoding: "utf8", timeout: 10000, env });
    if (r.status !== 0 || !r.stdout) return;
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadVault();

// ---------- subcomandos ----------
const argv = process.argv.slice(2);
if (argv[0] === "use") {
  const paid = (argv[1] || "none").toLowerCase();
  writeFileSync(ACTIVE, JSON.stringify({ paid }, null, 2) + "\n");
  console.log(`✓ Backend de pago del mes: ${paid}. (agentmesh lo priorizará donde aplique).`);
  process.exit(0);
}
if (argv[0] === "status") {
  console.log("Backends disponibles ahora:");
  for (const b of Object.keys(policy.availability)) console.log(`  ${available(b) ? "✅" : "❌"} ${b}`);
  console.log(`Backend de pago del mes: ${getPaid()}`);
  console.log("\nQué usaría cada tier ahora:");
  for (const [t, cands] of Object.entries(policy.tiers)) {
    const pick = resolve(cands);
    console.log(`  ${t.padEnd(9)} -> ${pick ? pick.backend + "/" + pick.model : "(ninguno disponible)"}`);
  }
  process.exit(0);
}
if (argv[0] === "doctor") {
  console.log("agentmesh doctor — diagnóstico (sin gastar):\n");
  for (const [b, a] of Object.entries(policy.availability)) {
    let st;
    if (a.cmd && !cmdExists(a.cmd)) st = `❌ falta el binario '${a.cmd}'`;
    else if (a.anyOf && !a.anyOf.some((c) => (c.env && process.env[c.env]) || (c.file && existsSync(expand(c.file)))))
      st = `⚠️  binario OK, sin auth → necesita: ${a.anyOf.map((c) => c.env || c.file).join(" o ")}`;
    else if (b === "claude") {
      // El binario puede existir con el CLI DESLOGUEADO (visto 2026-07-29: un mes caído y la
      // cascada tapándolo en silencio). "claude auth status" es gratis y lo destapa. El token
      // CLAUDE_CODE_OAUTH_TOKEN en el entorno (vault) también vale y no necesita keychain.
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) st = "✅ usable (token de entorno)";
      else {
        let logged = false;
        try { logged = JSON.parse(spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 20000 }).stdout || "{}").loggedIn === true; } catch {}
        st = logged ? "✅ usable (logueado)" : "❌ CLI deslogueado → corre: claude auth login   (la cascada lo salta EN SILENCIO)";
      }
    }
    else st = "✅ usable";
    console.log(`  ${b.padEnd(11)} ${st}`);
  }
  console.log(`\nBackend de pago del mes: ${getPaid()}`);
  console.log("Regla dura: privacy=sensitive va SIEMPRE a 'local' (ollama), nunca a la nube.");
  process.exit(0);
}

// ---------- observabilidad de ACIERTO del routing (no coste): ¿degradó en silencio? ----------
if (argv[0] === "health" || argv[0] === "salud") {
  const days = parseInt(argv[1], 10) || 0; // 0 = todo el historial
  let L = [];
  try { L = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  if (days > 0) { const cut = Date.now() - days * 86400000; L = L.filter((e) => e.ts && Date.parse(e.ts) >= cut); }
  const n = L.length;
  if (!n) { console.log("agentmesh health — el log está vacío todavía (nada que auditar)."); process.exit(0); }
  const HARD = new Set(["reason", "architecture", "debug-hard", "plan", "strategy"]);
  const isHard = (e) => e.complexity === "hard" || HARD.has(e.intent);
  const fb = L.filter((e) => e.fellBack);
  // Un fallback DUELE solo si una tarea NO mecánica (tier≠local) acabó en el modelo más débil
  // (llama3.1:8b) por caer toda la cascada de nube. El resto es sustituto capaz (codex→sonnet…): benigno.
  const fbPainful = fb.filter((e) => e.tier !== "local" && e.model === "llama3.1:8b");
  const fbBenign = fb.length - fbPainful.length;
  const frontierNoOpus = L.filter((e) => e.tier === "frontier" && e.model !== "opus");
  const hardOutFrontier = L.filter((e) => isHard(e) && e.tier !== "frontier");
  const sensLeak = L.filter((e) => e.privacy === "sensitive" && e.backend !== "ollama");
  const sensTotal = L.filter((e) => e.privacy === "sensitive").length;
  const fails = L.filter((e) => e.exit != null && e.exit !== 0);
  const byTier = {}, byBackend = {};
  for (const e of L) { byTier[e.tier] = (byTier[e.tier] || 0) + 1; byBackend[(e.backend) + "/" + (e.model)] = (byBackend[(e.backend) + "/" + (e.model)] || 0) + 1; }
  const pct = (x) => Math.round((100 * x) / n);
  console.log(`agentmesh health — ¿el router decidió BIEN? (lee agentmesh.log, coste 0)`);
  console.log(`Periodo: ${days ? "últimos " + days + "d" : "todo el historial"} · ${n} decisiones\n`);
  console.log(`Fallbacks (la cascada usó el 2º candidato):  ${fb.length}/${n} (${pct(fb.length)}%)`);
  if (fb.length) {
    console.log(`   ├─ benignos: ${fbBenign}  (sustituto capaz: codex→sonnet, sonnet→flash… cero pérdida real)`);
    if (fbPainful.length) console.log(`   └─ 🔴 que DUELEN: ${fbPainful.length}  (tarea no-mecánica cayó al 8B local por fallar toda la nube) → ${[...new Set(fbPainful.map((e) => e.intent + "/" + e.complexity))].join(", ")}`);
    else console.log(`   └─ ✓ que duelen: 0  (ningún fallback degradó la calidad real — todos a un sustituto capaz)`);
  }
  if (frontierNoOpus.length) console.log(`⚠  FRONTIER sin Opus: ${frontierNoOpus.length} tarea(s) dura(s) NO corrieron en Opus → usaron ${[...new Set(frontierNoOpus.map((e) => e.backend + "/" + e.model))].join(", ")}  (¿Opus caído / rate-limit?)`);
  else console.log(`✓  Frontier: toda tarea dura corrió en Opus (juicio sin recortar).`);
  if (hardOutFrontier.length) console.log(`ℹ  ${hardOutFrontier.length} tarea(s) de intención dura (architecture/reason/strategy…) corrieron en modelo no-frontier porque la clasificación les dio complejidad media/trivial (eso es la policy funcionando, no un fallo). Sin oráculo de "correcto": si crees que alguna merecía Opus, es la señal para afinar la clasificación.`);
  if (sensLeak.length) console.log(`🔴 PRIVACIDAD: ${sensLeak.length} tarea(s) sensible(s) NO en local (fuga a nube): ${[...new Set(sensLeak.map((e) => e.backend))].join(", ")}`);
  else console.log(`✓  Privacidad: ${sensTotal} sensible(s), todas en local (0 fugas).`);
  if (fails.length) console.log(`⚠  Fallos de ejecución (exit≠0): ${fails.length}`);
  // CANARIO DE MISLABEL (HIDRA V2): el clasificador es el ÚNICO gate de fail-closed. Una tarea cloud
  // marcada privacy=normal es justo el punto donde un error de clasificación filtraría datos a la nube.
  const cloudNormal = L.filter((e) => e.mode === "run" && e.privacy === "normal" && e.backend !== "ollama");
  if (cloudNormal.length) console.log(`ℹ  ${cloudNormal.length} ejecución(es) cloud con privacy=normal — el clasificador es el único gate de fail-closed (V2 lo endurece: heurística-OR + default sensitive).`);
  const durs = L.filter((e) => e.mode === "run" && typeof e.durMs === "number").map((e) => e.durMs);
  if (durs.length) console.log(`ℹ  Latencia media (mode=run, ${durs.length} muestra(s)): ${Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)}ms  (instrumentada, peso 0 en el routing)`);
  console.log(`\nPor tier:    ${Object.entries(byTier).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ":" + v).join("  ")}`);
  console.log(`Por modelo:  ${Object.entries(byBackend).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ":" + v).join("  ")}`);
  console.log(`\n(Lo verde = el router hizo lo correcto. Lo ⚠/🔴 = revisa: una tarea importante corrió en un modelo peor de lo debido.)`);
  process.exit(0);
}

// ---------- resolver candidatos del tier al primer disponible ----------
// onlyMachine: un candidato gateado solo cuenta si su máquina coincide (p.ej. MoE solo en torre).
function forMachine(cands, machine) {
  return cands.filter((c) => !c.onlyMachine || c.onlyMachine === machine);
}
function resolve(cands, machine = "mac") {
  const paid = getPaid();
  const ordered = forMachine(cands, machine).sort((a, b) => (b.backend === paid) - (a.backend === paid)); // pago al frente
  return ordered.find((c) => available(c.backend)) || null;
}
// Lista ORDENADA de candidatos disponibles (para fallback en cascada).
function resolveAll(cands, machine = "mac") {
  const paid = getPaid();
  return forMachine(cands, machine).sort((a, b) => (b.backend === paid) - (a.backend === paid)).filter((c) => available(c.backend));
}
// Ventana de inactividad de Ollama: en vez de matarlo tras cada tarea, se queda caliente
// y un watchdog único lo duerme tras IDLE seg sin uso (reset-on-use). Eficiente + lean.
const OLLAMA_IDLE = 300;
const OLU = join(HOME, ".cache", "agentmesh-ollama-lastuse");
const OPID = join(HOME, ".cache", "agentmesh-ollama-watchdog.pid");
function touchOllamaUse() { try { mkdirSync(join(HOME, ".cache"), { recursive: true }); writeFileSync(OLU, String(Math.floor(Date.now() / 1000))); } catch {} }
function scheduleOllamaSleep() {
  if (existsSync(OPID)) { try { process.kill(Number(readFileSync(OPID, "utf8")), 0); return; } catch {} } // ya hay watchdog vivo
  const sh = `while true; do sleep 60; last=$(cat "${OLU}" 2>/dev/null || echo 0); now=$(date +%s); if [ $((now-last)) -gt ${OLLAMA_IDLE} ]; then pkill -f "ollama serve"; rm -f "${OPID}"; exit 0; fi; done`;
  try { const w = spawn("bash", ["-c", sh], { detached: true, stdio: "ignore" }); w.unref(); writeFileSync(OPID, String(w.pid)); } catch {}
}

// ---------- args de tarea ----------
const opt = { dry: false, routeOnly: false, classifyOnly: false, stdin: false, intent: null, complexity: null, machine: null, privacy: null, fusion: false, fusionPro: false };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry") opt.dry = true;
  else if (a === "--route-only") opt.routeOnly = true;
  else if (a === "--classify-only") opt.classifyOnly = true;
  else if (a === "--stdin") opt.stdin = true;
  else if (a === "--fusion") opt.fusion = true;            // OpenRouter Fusion, panel BARATO (on-demand)
  else if (a === "--fusion-pro") opt.fusionPro = true;     // OpenRouter Fusion, panel PREMIUM (máx. rendimiento)
  else if (a === "--intent") opt.intent = argv[++i];
  else if (a === "--complexity") opt.complexity = argv[++i];
  else if (a === "--machine") opt.machine = argv[++i];
  else if (a === "--privacy") opt.privacy = argv[++i];
  else rest.push(a);
}
let task = rest.join(" ").trim();
if (opt.stdin) { try { task = readFileSync(0, "utf8").trim(); } catch {} }
if (!task) { console.error('Uso: mesh [--dry] [--intent X] [--complexity ..] [--machine mac|torre] [--fusion|--fusion-pro] "<tarea>"   |   mesh status   |   mesh use <backend>'); process.exit(1); }

// OpenRouter Fusion (panel multi-modelo + juez). ON-DEMAND, FUERA del routing automático:
// --fusion = panel BARATO (nivel ~frontier por céntimos); --fusion-pro = panel PREMIUM (máx. rendimiento).
// Cuesta ~4-5x una llamada (N modelos + juez); el tope $10/key de OpenRouter te protege. --dry lo previsualiza.
if (opt.fusion || opt.fusionPro) runFusion(task, opt.fusionPro, opt.dry);

// ---------- 1) clasificar (Ollama local) ----------
function classify(t) {
  const h = heuristic(t);                  // SIEMPRE (coste 0): base + detección de keywords sensibles
  if (!ollamaUp()) return h;               // lean: sin Ollama corriendo → heurística instantánea, 0 recursos
  const prompt = `Clasifica esta tarea. Devuelve SOLO JSON compacto con claves "intent","complexity","privacy".
intent ∈ [format,classify,extract,translate,rename,local-bulk,summarize,draft,email,research,search,market,code-edit,code-review,refactor,tests,bugfix,reason,architecture,debug-hard,plan,strategy]
complexity ∈ [trivial,medium,hard]; privacy ∈ [normal,sensitive].
Tarea: """${t}"""
JSON:`;
  let llm = null;
  try {
    const r = spawnSync("ollama", ["run", "llama3.1:8b"], { input: prompt, encoding: "utf8", timeout: 60000 });
    const m = (r.stdout || "").match(/\{[\s\S]*?\}/);
    if (m) llm = JSON.parse(m[0]);
  } catch {}
  // FAIL-CLOSED de privacidad (HIDRA V2, 2026-06-21): si el LLM no parsea o no trae privacy explícito
  // → "sensitive" (no "normal"). Y privacy final = UNIÓN (OR) con la heurística de keywords: si
  // CUALQUIERA marca sensitive, gana sensitive (nunca un override que rebaje). El clasificador es el
  // ÚNICO gate de la regla dura; ante la duda, los datos se quedan en local.
  const llmPriv = (llm && (llm.privacy === "sensitive" || llm.privacy === "normal")) ? llm.privacy : "sensitive";
  const privacy = (llmPriv === "sensitive" || h.privacy === "sensitive") ? "sensitive" : "normal";
  return { intent: (llm && llm.intent) || h.intent, complexity: (llm && llm.complexity) || h.complexity, privacy };
}
let meta = { intent: opt.intent, complexity: opt.complexity, privacy: opt.privacy };
if (!meta.intent || !meta.complexity || !meta.privacy) {
  const c = classify(task) || {};
  meta.intent ??= c.intent || "reason";
  meta.complexity ??= c.complexity || "medium";
  meta.privacy ??= c.privacy || "sensitive";   // fail-closed: ante la duda, local (era "normal")
}
if (opt.classifyOnly) { console.log(JSON.stringify(meta)); process.exit(0); }

// ---------- 2) enrutar a un tier ----------
function firstMatch(rules, m) {
  for (const r of rules) {
    if (r.default) continue;
    const w = r.when || {};
    if (Object.keys(w).every((k) => (Array.isArray(w[k]) ? w[k] : [w[k]]).includes(m[k]))) return r;
  }
  return rules.find((r) => r.default);
}
const route = firstMatch(policy.routes, meta);
const tierName = route.use || route.default;

// ---------- 3) elegir backend disponible dentro del tier ----------
// La máquina se decide ANTES de resolver candidatos: un candidato con onlyMachine solo
// cuenta si coincide con la máquina de ejecución (p.ej. el MoE qwen3:30b-a3b solo en torre).
const mrule = firstMatch(policy.machineRules, meta);
let machine = opt.machine || mrule.machine || mrule.default || "mac";
const preferred = forMachine(policy.tiers[tierName], machine)[0];
let candidates = resolveAll(policy.tiers[tierName], machine);
// FAIL-CLOSED de privacidad (condición de cierre HIDRA, 2026-06-21): los datos sensibles NUNCA
// salen a la nube. Si privacy=sensitive, solo backends LOCALES (ollama). Si no hay local disponible
// -> ABORTA, jamás cae a un backend cloud por timeout/fallback. Tapar esta trampilla es la regla dura.
if (meta.privacy === "sensitive") {
  candidates = candidates.filter((c) => c.backend === "ollama");
  if (!candidates.length) { console.error("✗ privacy=sensitive y sin backend LOCAL disponible (¿Ollama caído?). ABORTO: los datos sensibles NUNCA salen a la nube. Arranca Ollama y reintenta."); process.exit(3); }
}
if (!candidates.length) { console.error(`✗ Ningún backend disponible para el tier '${tierName}'. Haz login en alguno o pon su API key.`); process.exit(2); }
const pick = candidates[0]; // preferido disponible; si falla en ejecución, se prueba el siguiente (cascada)
const fellBack = pick.backend !== preferred.backend;

// ---------- prompts tersos ----------
const WRAP = {
  summarize: (t) => `Resume en máximo 5 viñetas, sin introducción:\n${t}`,
  email: (t) => `Redacta solo el email pedido, sin explicaciones:\n${t}`,
  classify: (t) => `Clasifica y responde solo la categoría:\n${t}`,
  extract: (t) => `Extrae lo pedido en JSON, sin texto extra:\n${t}`,
  translate: (t) => `Traduce, solo el resultado:\n${t}`,
  research: (t) => `Investiga y responde conciso, con fuentes:\n${t}`,
};
const prompt = (WRAP[meta.intent] || ((t) => t))(task);

// ---------- decisión ----------
console.error("── agentmesh ──");
console.error(`tarea     : ${task.slice(0, 80)}${task.length > 80 ? "…" : ""}`);
console.error(`clasifica : intent=${meta.intent} complexity=${meta.complexity} privacy=${meta.privacy}`);
console.error(`enruta    : tier=${tierName} → ${pick.backend}/${pick.model} @ ${machine}` + (fellBack ? `  (fallback: ${preferred.backend} no disponible)` : ""));
console.error(`motivo    : ${route.why}`);
// Fusion: el repartidor AUTO-LANZA el panel BARATO (~½¢) en intents donde gana claro (research),
// SIN preguntar (Álvaro lo pidió). En decisiones difíciles solo SUGIERE. --fusion-pro NUNCA es
// automático (caro). NUNCA con datos sensibles (Fusion va a la nube; la regla dura es local).
if (!opt.fusion && !opt.fusionPro && meta.privacy !== "sensitive") {
  const HARD = new Set(["reason", "architecture", "debug-hard", "plan", "strategy"]);
  const RESEARCHY = new Set(["research", "search", "market"]);
  const autoCheap = (policy.fusion && policy.fusion.autoCheapIntents) || [];
  const isAuto = autoCheap.includes(meta.intent);
  if (isAuto && !opt.routeOnly && !opt.dry) {
    console.error(`→ auto-fusion barato (intent '${meta.intent}', ~½¢): el repartidor lo usa solo. (desactivar: quita '${meta.intent}' de policy.json → fusion.autoCheapIntents)`);
    runFusion(task, false, false);   // ejecuta el panel barato y sale
  }
  if (isAuto) console.error(`💡 (dry/route-only) intent '${meta.intent}' → en real se AUTO-lanzaría con Fusion barato.`);
  else if (tierName === "frontier" || (meta.complexity === "hard" && HARD.has(meta.intent)))
    console.error(`💡 candidato a Fusion (decisión difícil) — sin lanzarlo solo:  mesh --fusion-pro "…" (~15¢)  ·  mesh --fusion "…" (~½¢)`);
  else if (RESEARCHY.has(meta.intent) && meta.complexity !== "trivial")
    console.error(`💡 candidato a Fusion (research) — barato ~nivel frontier:  mesh --fusion "…"`);
}
let runStart = 0; // se fija justo antes del bucle de ejecución; durMs solo en mode=run
const log = (mode, exit, used) => appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), mode, ...meta, tier: tierName, backend: (used || pick).backend, model: (used || pick).model, machine, fellBack, exit, durMs: (mode === "run" && runStart) ? Date.now() - runStart : undefined, why: route.why }) + "\n");

if (opt.routeOnly || opt.dry) {
  if (opt.dry) { console.error("── prompt (dry, NO ejecutado, coste 0) ──"); console.error(prompt); }
  log(opt.dry ? "dry" : "route");
  process.exit(0);
}

// ---------- DeepSeek (API) ----------
// Devuelve {exit,out}. Una respuesta de API con error (sin saldo, key mala) NO es éxito,
// aunque curl salga 0 — antes se reportaba como éxito y rompía la cascada.
function runDeepseek(model, p) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) { console.error("✗ DEEPSEEK_API_KEY no está en el entorno."); return { exit: 1, out: "" }; }
  const body = JSON.stringify({ model, messages: [{ role: "user", content: p }], stream: false });
  const r = spawnSync("curl", ["-s", "https://api.deepseek.com/chat/completions", "-H", `Authorization: Bearer ${key}`, "-H", "Content-Type: application/json", "-d", body], { encoding: "utf8", timeout: 180000 });
  if (r.error) { console.error("✗ no se pudo invocar curl para DeepSeek."); return { exit: 1, out: "" }; }
  try {
    const content = JSON.parse(r.stdout).choices[0].message.content;
    console.log(content);
    return { exit: 0, out: content || "" };
  } catch {
    console.error("✗ DeepSeek no devolvió contenido usable (revisa API key, saldo o modelo).");
    return { exit: 1, out: "" };
  }
}

// ---------- OpenRouter (API, OpenAI-compatible) ----------
// Backend de fallback multi-modelo: un solo OPENROUTER_API_KEY con tope de gasto por key.
function runOpenrouter(model, p) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("✗ OPENROUTER_API_KEY no está en el entorno."); return { exit: 1, out: "" }; }
  const body = JSON.stringify({ model, messages: [{ role: "user", content: p }], stream: false });
  const r = spawnSync("curl", ["-s", "https://openrouter.ai/api/v1/chat/completions", "-H", `Authorization: Bearer ${key}`, "-H", "Content-Type: application/json", "-H", "X-Title: agentmesh", "-d", body], { encoding: "utf8", timeout: 180000 });
  if (r.error) { console.error("✗ no se pudo invocar curl para OpenRouter."); return { exit: 1, out: "" }; }
  try {
    const j = JSON.parse(r.stdout);
    const content = j.choices[0].message.content;
    console.log(content);
    if (j.usage && j.usage.cost != null) console.error(`(openrouter coste: $${j.usage.cost})`); // contabilidad real
    return { exit: 0, out: content || "" };
  } catch {
    console.error("✗ OpenRouter no devolvió contenido usable (revisa API key, saldo o modelo).");
    return { exit: 1, out: "" };
  }
}

// ---------- NVIDIA NIM (API, OpenAI-compatible) ----------
// Tier cloud-gratis: 80+ modelos hosteados gratis con rate-limit (~40 req/min), uso dev/eval
// (no producción). Mismo shape que OpenRouter (endpoint OpenAI-compatible). Añadido 2026-07-04.
function runNvidia(model, p) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) { console.error("✗ NVIDIA_API_KEY no está en el entorno."); return { exit: 1, out: "" }; }
  // max_tokens acota la generación: el tier gratis va lento (~17-27 tok/s, con cola) y sin tope
  // una respuesta larga rebasa el kill de 180s y muere sin evidencia (visto 2026-07-29: corridas
  // reales de 124s ya en el log). --max-time 170 < timeout 180000 para que curl salga limpio
  // (exit 28) en vez de morir por SIGKILL con stdout vacío.
  const body = JSON.stringify({ model, messages: [{ role: "user", content: p }], stream: false, max_tokens: 2048 });
  const r = spawnSync("curl", ["-s", "--max-time", "170", "https://integrate.api.nvidia.com/v1/chat/completions", "-H", `Authorization: Bearer ${key}`, "-H", "Content-Type: application/json", "-d", body], { encoding: "utf8", timeout: 180000 });
  if (r.error) { console.error("✗ no se pudo invocar curl para NVIDIA NIM."); return { exit: 1, out: "" }; }
  const parsed = parseNvidiaResponse(r.stdout, r.status ?? 0);
  if (!parsed.ok) { console.error(`✗ NVIDIA NIM falló: ${parsed.reason}`); return { exit: 1, out: "" }; }
  if (parsed.finishReason === "length") console.error("⚠ (nvidia) respuesta truncada por max_tokens=2048 — si pasa a menudo, sube el tope o usa otro tier.");
  console.log(parsed.content);
  console.error("(nvidia: tier gratis, coste $0)");
  return { exit: 0, out: parsed.content };
}

// ---------- OpenRouter Fusion (panel multi-modelo + juez) ----------
// On-demand (mesh --fusion / --fusion-pro), NUNCA en el routing automático.
//  --fusion     -> panel BARATO configurable (policy.fusion.cheap): nivel ~frontier por céntimos.
//  --fusion-pro -> preset Quality de OpenRouter (Opus + GPT + Gemini Pro): máximo rendimiento.
// Coste = suma de las llamadas del panel + juez (~4-5x una llamada). El tope $10/key de OpenRouter protege.
function runFusion(task, pro, dry) {
  loadVault();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("✗ OPENROUTER_API_KEY no disponible (¿vault/age?). No puedo lanzar Fusion."); process.exit(1); }
  const fc = policy.fusion || {};
  const body = { model: "openrouter/fusion", messages: [{ role: "user", content: task }], stream: false };
  let label;
  if (pro) {
    const panel = (fc.pro && fc.pro.analysis_models) || ["anthropic/claude-opus-4.8", "google/gemini-2.5-pro", "deepseek/deepseek-r1"];
    const judge = (fc.pro && fc.pro.judge) || "anthropic/claude-opus-4.8";
    body.plugins = [{ id: "fusion", analysis_models: panel, model: judge }];
    label = "PRO — " + panel.join(" + ") + "  (juez: " + judge + ")";
  } else {
    const panel = (fc.cheap && fc.cheap.analysis_models) || ["deepseek/deepseek-chat", "google/gemini-2.5-flash", "moonshotai/kimi-k2.6"];
    const judge = (fc.cheap && fc.cheap.judge) || "deepseek/deepseek-chat";
    body.plugins = [{ id: "fusion", analysis_models: panel, model: judge }];
    label = "barato — " + panel.join(" + ") + "  (juez: " + judge + ")";
  }
  console.error("── agentmesh fusion ──");
  console.error(`tarea     : ${task.slice(0, 80)}${task.length > 80 ? "…" : ""}`);
  console.error(`panel     : ${label}`);
  console.error(`coste     : ~4-5x una llamada (panel + juez). Tope OpenRouter: $10/key.`);
  if (dry) { console.error("── (dry: NO ejecutado, coste 0) cuerpo que se enviaría ──"); console.log(JSON.stringify(body, null, 2)); process.exit(0); }
  console.error("──────────────");
  let exit = 1;
  const r = spawnSync("curl", ["-s", "--max-time", "290", "https://openrouter.ai/api/v1/chat/completions", "-H", `Authorization: Bearer ${key}`, "-H", "Content-Type: application/json", "-H", "X-Title: agentmesh-fusion", "-d", JSON.stringify(body)], { encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || !r.stdout) { console.error("✗ Fusion: sin respuesta (¿timeout o red?)."); }
  else {
    // OpenRouter rellena con espacios/keep-alive ANTES del JSON en peticiones lentas (Fusion premium).
    // Por eso parseamos desde la primera '{', no el stdout crudo.
    const raw = r.stdout.trim();
    const start = raw.indexOf("{");
    try {
      const j = JSON.parse(start >= 0 ? raw.slice(start) : raw);
      if (j.error) { console.error(`✗ Fusion error: ${j.error.message || JSON.stringify(j.error)}`); }
      else {
        const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (content && content.trim()) { console.log(content); exit = 0; }
        else console.error("✗ Fusion no devolvió contenido usable.");
        if (j.usage && j.usage.cost != null) console.error(`(fusion coste: $${j.usage.cost})`);
      }
    } catch {
      console.error("✗ Fusion no devolvió JSON usable. Respuesta cruda (inicio):");
      console.error(raw.slice(0, 300) || "(vacía)");
    }
  }
  try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), mode: "fusion", intent: pro ? "fusion-pro" : "fusion", backend: "openrouter", model: "openrouter/fusion", exit }) + "\n"); } catch {}
  process.exit(exit);
}

// ---------- 4) ejecutar (con fallback en cascada) ----------
// SSH endurecido: si la torre está apagada (estado por defecto, lean), falla en ~4s en vez de
// colgar 2 min, y BatchMode evita que pida contraseña y deje al agente esperando.
const SSH_OPTS = ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes"];
const MAXBUF = 16 * 1024 * 1024;
// status==null (proceso no arrancado / matado por señal) o r.error => fallo real, NO éxito.
const realExit = (r) => (r.error ? 1 : (r.status == null ? 1 : r.status));
// Limpia secuencias ANSI/spinner (ej. el spinner de `ollama run`) de la salida capturada.
const stripAnsi = (s) => (s || "").replace(/\x1B\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "");
function runOne(cand) {
  const b = policy.backends[cand.backend];
  const argvList = b.argv.map((x) => x.replace("{model}", cand.model).replace("{prompt}", prompt));
  const mc = policy.machines[machine] || { type: "local" };
  if (cand.backend === "ollama" && mc.type !== "ssh") { ensureOllama(); touchOllamaUse(); } // despierta si hace falta
  let exit, out = "";
  if (cand.backend === "deepseek") {
    const dr = runDeepseek(cand.model, prompt); exit = dr.exit; out = dr.out;
  } else if (cand.backend === "openrouter") {
    const or = runOpenrouter(cand.model, prompt); exit = or.exit; out = or.out;
  } else if (cand.backend === "nvidia") {
    const nv = runNvidia(cand.model, prompt); exit = nv.exit; out = nv.out;
  } else if (mc.type === "ssh" && b.remoteOk && b.stdin) {
    const r = spawnSync("ssh", [...SSH_OPTS, mc.host, ...argvList], { input: prompt, encoding: "utf8", maxBuffer: MAXBUF });
    exit = realExit(r); out = stripAnsi(r.stdout || "");
    if (out) process.stdout.write(out); if (r.stderr) process.stderr.write(r.stderr);
  } else {
    if (mc.type === "ssh") console.error(`(aviso) ${cand.backend} no soporta ejecución remota por stdin → ejecuto en mac.`);
    const r = spawnSync(argvList[0], argvList.slice(1), { input: b.stdin ? prompt : undefined, encoding: "utf8", shell: WIN, maxBuffer: MAXBUF });
    exit = realExit(r); out = stripAnsi(r.stdout || "");
    if (out) process.stdout.write(out); if (r.stderr) process.stderr.write(r.stderr);
  }
  if (cand.backend === "ollama" && mc.type !== "ssh") scheduleOllamaSleep(); // ventana de inactividad, no kill inmediato
  // Éxito REAL = exit 0 Y salida no vacía. Un backend sin login suele salir 0 sin escribir nada;
  // sin este chequeo la cascada lo daba por bueno y NO caía a Ollama/Sonnet (bug crítico en cada rotación).
  if (exit === 0 && out.trim().length === 0) { console.error(`✗ ${cand.backend} no produjo salida (¿sin login / sin saldo?).`); return 1; }
  return exit;
}

// Preflight: si la ruta apunta a una máquina SSH que no responde, no cuelgues: cae a mac.
// Usa ssh (resuelve el alias de ~/.ssh/config) con ConnectTimeout, no nc (no resolvería 'torre').
function hostReachable(host) {
  if (WIN) return true;
  try { return spawnSync("ssh", [...SSH_OPTS, host, "exit"], { timeout: 6000 }).status === 0; }
  catch { return true; }
}
if (machine !== "mac" && (policy.machines[machine] || {}).type === "ssh") {
  const host = policy.machines[machine].host;
  if (host && !hostReachable(host)) { console.error(`(aviso) ${machine} (${host}) no responde → ejecuto en mac.`); machine = "mac"; }
}

let exit = 1, used = null;
runStart = Date.now(); // instrumentación de latencia (peso 0 en el routing; solo se loguea)
for (let i = 0; i < candidates.length; i++) {
  const cand = candidates[i];
  console.error(`ejecuta   : ${cand.backend}/${cand.model} @ ${machine}${i > 0 ? "  (fallback en cascada)" : ""}`);
  console.error("──────────────");
  exit = runOne(cand); used = cand;
  if (exit === 0) break;
  if (i < candidates.length - 1) console.error(`✗ ${cand.backend} falló (exit ${exit}). Reintentando con el siguiente…`);
}
log("run", exit, used);
process.exit(exit);
