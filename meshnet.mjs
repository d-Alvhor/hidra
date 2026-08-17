#!/usr/bin/env node
/**
 * meshnet — comunica las dos máquinas (Mac ↔ torre) sobre agentmesh.
 *
 *   meshnet send <mac|torre> "<tarea>"   → ejecuta en el cerebro de ESA máquina y espera el resultado
 *   meshnet fan "<tarea>"                → ejecuta en AMBAS a la vez (paralelo) y muestra las dos
 *   meshnet post <mac|torre> "<tarea>"   → ENCOLA la tarea en segundo plano (no espera) → devuelve un id
 *   meshnet jobs                         → lista los trabajos de la cola (running/done)
 *   meshnet result <id>                  → muestra el resultado de un trabajo terminado
 *
 * Coste mínimo: clasifica UNA vez en el Mac (Ollama, gratis) y reenvía la decisión por stdin.
 * La cola vive en el Mac (~/agentmesh-queue); cada job corre detached y deja su salida y un .done.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { limpiezaAlArrancar } from "./retencion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(HERE, "policy.json"), "utf8"));
const AM = join(HERE, "agentmesh.mjs");
const HOME = process.env.HOME || "";
const expand = (p) => p.replace(/^~/, HOME);
const QDIR = join(HOME, "agentmesh-queue");

// ---------- retención (2026-08-17) ----------
// Los permisos 0700/0600 evitan que otro usuario lea la cola; NO evitan que la tarea y la salida en
// claro sigan ahí dentro de un año (y en el backup). Quien ensucia, barre: al arrancar meshnet se
// purgan los jobs/runs viejos de los DOS directorios de la red. Sin daemon, sin cron, sin estado.
limpiezaAlArrancar(HOME ? [QDIR, join(HOME, ".cache", "meshflow")] : []);
// SSH endurecido: torre apagada (estado por defecto, lean) falla en ~4s, no cuelga ni pide pass.
const SSH_OPTS = ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes"];
const realExit = (r) => (r.error ? 1 : (r.status == null ? 1 : r.status));

// ---------- endurecido de la cola (2026-08-17) ----------
// La cola guarda tarea, metadatos y salida EN CLARO en disco. Mínimo indispensable: que solo el
// dueño pueda leerla. Se hace chmod EXPLÍCITO además de pasar 'mode' porque (a) mkdir/writeFile
// aplican el umask del proceso y (b) un directorio/fichero ya existente conserva sus permisos
// viejos y flojos (la cola real de este Mac estaba en 0755/0644, world-readable).
const M_DIR = 0o700, M_FILE = 0o600;
function ensureQueueDir() {
  mkdirSync(QDIR, { recursive: true, mode: M_DIR });
  try { chmodSync(QDIR, M_DIR); } catch {}
}
function writeSecure(p, data) {
  writeFileSync(p, data, { mode: M_FILE });
  try { chmodSync(p, M_FILE); } catch {}
}
// ¿el destino saca los datos de ESTA máquina? (ssh a la torre)
const isRemote = (m) => (policy.machines[m] || {}).type === "ssh";

const argv = process.argv.slice(2);
const sub = argv.shift();

// ---------- jobs / result (no necesitan tarea) ----------
if (sub === "jobs") {
  if (!existsSync(QDIR)) { console.log("(cola vacía)"); process.exit(0); }
  const metas = readdirSync(QDIR).filter((f) => f.endsWith(".json"));
  if (!metas.length) { console.log("(cola vacía)"); process.exit(0); }
  for (const f of metas.sort()) {
    const j = JSON.parse(readFileSync(join(QDIR, f), "utf8"));
    const done = existsSync(join(QDIR, j.id + ".done"));
    // Un job sensible NO duplica su texto en el .json (solo vive en el .task, 0600): el listado
    // tampoco lo escupe por pantalla/log. String(...) por si el .json es viejo y no trae task.
    const preview = j.taskRedacted ? "(tarea sensible — contenido no listado)" : String(j.task || "").slice(0, 50);
    console.log(`${done ? "✅ done   " : "⏳ running"} ${j.id}  [${j.machine}]  ${preview}`);
  }
  process.exit(0);
}
if (sub === "result") {
  const id = argv[0];
  const out = join(QDIR, (id || "") + ".out");
  if (!id || !existsSync(out)) { console.error(`No encuentro resultado para '${id}'. Usa 'meshnet jobs'.`); process.exit(1); }
  console.log(readFileSync(out, "utf8"));
  // CONSUMIDO: el resultado ya está en manos del operador ⇒ el .task (la tarea EN CLARO, la copia
  // más jugosa de la cola) deja de tener razón de existir. Se borra ya, sin esperar al TTL.
  // Solo si el job TERMINÓ: si aún corre, el wrapper de bash sigue alimentándose de ese fichero.
  // El .out y el .json se quedan (el operador puede querer releerlos) hasta que caduquen por TTL.
  try { if (existsSync(join(QDIR, id + ".done"))) rmSync(join(QDIR, id + ".task"), { force: true }); } catch {}
  process.exit(0);
}

// ---------- send / fan / post ----------
const opt = { intent: null, complexity: null, privacy: null };
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--intent") opt.intent = argv[++i];
  else if (a === "--complexity") opt.complexity = argv[++i];
  else if (a === "--privacy") opt.privacy = argv[++i];
  else positionals.push(a);
}
let machineName = null;
if (sub === "send" || sub === "post") machineName = positionals.shift();
const task = positionals.join(" ").trim();
const needMachine = sub === "send" || sub === "post";
if (!["send", "fan", "post"].includes(sub) || !task || (needMachine && !["mac", "torre"].includes(machineName))) {
  console.error('Uso: meshnet send|post <mac|torre> "<tarea>"  |  meshnet fan "<tarea>"  |  meshnet jobs  |  meshnet result <id>');
  process.exit(1);
}

// ---------- clasificar UNA vez en el Mac (gratis) ----------
// FAIL-CLOSED de privacidad (2026-08-17, hallazgo de la review adversarial): ANTES, si el
// clasificador fallaba o su salida no parseaba, meshnet devolvía privacy="normal" y la tarea podía
// acabar en la nube o cruzando el ssh a la torre. Ahora, ante CUALQUIER duda —proceso que no
// arranca, exit≠0, timeout, JSON roto, valor de privacy no reconocido— la respuesta es "sensitive".
// Mismo criterio que el fail-closed bueno de agentmesh.mjs. Un --privacy explícito del operador
// sigue mandando (es una decisión humana, no una inferencia).
function classifyLocal(t) {
  if (opt.intent && opt.complexity && opt.privacy) return opt;
  const FALLBACK = { intent: opt.intent || "reason", complexity: opt.complexity || "medium", privacy: opt.privacy || "sensitive" };
  // timeout: sin él, un clasificador colgado dejaba a meshnet esperando para siempre.
  const r = spawnSync("node", [AM, "--classify-only", "--stdin"], { input: t, encoding: "utf8", timeout: 90000 });
  if (r.error || r.status !== 0) return FALLBACK;
  let m = null;
  try { m = JSON.parse((r.stdout || "").trim()); } catch { return FALLBACK; }
  if (!m || typeof m !== "object") return FALLBACK;
  const priv = (m.privacy === "sensitive" || m.privacy === "normal") ? m.privacy : "sensitive";
  return {
    intent: opt.intent || m.intent || FALLBACK.intent,
    complexity: opt.complexity || m.complexity || FALLBACK.complexity,
    privacy: opt.privacy || priv,
  };
}
const meta = classifyLocal(task);
const flags = ["--intent", meta.intent, "--complexity", meta.complexity, "--privacy", meta.privacy, "--stdin"];

// comando (string para shell) que ejecuta el cerebro de una máquina leyendo la tarea por stdin
function shellCmd(machine, taskFile) {
  const m = policy.machines[machine];
  if (m.type === "ssh") return `ssh -o ConnectTimeout=4 -o BatchMode=yes ${m.host} node ${m.meshPath} ${flags.join(" ")} < "${taskFile}"`;
  return `node "${expand(m.meshPath)}" ${flags.join(" ")} < "${taskFile}"`;
}

console.error(`meshnet ${sub}: intent=${meta.intent} complexity=${meta.complexity} privacy=${meta.privacy} → ${sub === "fan" ? "mac + torre" : machineName}`);

// ---------- REGLA DURA: privacy=sensitive = SOLO LOCAL ----------
// Enviar una tarea sensible a la torre la escribiría en claro FUERA de esta máquina (el payload
// viaja por ssh y la salida acaba en el disco de la otra máquina). Coherente con la doctrina y con
// el filtro sensitive→solo-ollama de agentmesh.mjs: se ABORTA, no se degrada en silencio.
// Se comprueba ANTES de tocar la cola: un post rechazado no deja ni un byte en disco.
const targets = sub === "fan" ? ["mac", "torre"] : [machineName];
if (meta.privacy === "sensitive") {
  const remotos = targets.filter(isRemote);
  if (remotos.length) {
    console.error(`✗ privacy=sensitive: ABORTO el envío a [${remotos.join(", ")}]. Los datos sensibles NO salen de esta máquina`);
    console.error(`  (ni por ssh ni a la cola/disco de la otra). Ejecútalo en local:  meshnet ${sub === "fan" ? "send" : sub} mac "<tarea>"`);
    console.error(`  Si de verdad NO es sensible, dilo explícitamente:  --privacy normal`);
    process.exit(3);
  }
  console.error(`ℹ privacy=sensitive → solo local; la cola vive en ${QDIR} con permisos 0700/0600.`);
}

// ---------- SEND (síncrono) ----------
if (sub === "send") {
  const m = policy.machines[machineName];
  const args = m.type === "ssh" ? [...SSH_OPTS, m.host, "node", m.meshPath, ...flags] : [expand(m.meshPath), ...flags];
  const r = spawnSync(m.type === "ssh" ? "ssh" : "node", args, { input: task, stdio: ["pipe", "inherit", "inherit"] });
  process.exit(realExit(r));
}

// ---------- FAN (paralelo, ambas) ----------
if (sub === "fan") {
  const runCaptured = (machine) => new Promise((resolve) => {
    const m = policy.machines[machine];
    const cmd = m.type === "ssh" ? "ssh" : "node";
    const args = m.type === "ssh" ? [...SSH_OPTS, m.host, "node", m.meshPath, ...flags] : [expand(m.meshPath), ...flags];
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.write(task); p.stdin.end();
    p.on("close", (code) => resolve({ machine, code, out: out.trim(), err: err.trim() }));
  });
  const results = await Promise.all(["mac", "torre"].map(runCaptured));
  for (const r of results) {
    console.log(`\n┌─ [${r.machine}] ${"─".repeat(40)}`);
    console.log(r.out || "(sin salida)");
    if (r.code !== 0 && r.err) console.log(`└─ (exit ${r.code}) ${r.err.split("\n").slice(-1)[0]}`);
  }
  process.exit(0);
}

// ---------- POST (async, encola en segundo plano) ----------
if (sub === "post") {
  ensureQueueDir();   // 0700 SIEMPRE, también si la cola ya existía con permisos flojos
  const id = "j-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4).toString(36);
  const taskFile = join(QDIR, id + ".task");
  const outFile = join(QDIR, id + ".out");
  const doneFile = join(QDIR, id + ".done");
  const sensitive = meta.privacy === "sensitive";
  writeSecure(taskFile, task);
  // .out pre-creado a 0600: la redirección '>' de bash RESPETA el modo del inodo existente, así que
  // la salida nace protegida en vez de heredar el umask (era 0644).
  writeSecure(outFile, "");
  // El .json es solo índice: si la tarea es sensible NO se duplica su texto aquí (vive únicamente
  // en el .task). Menos copias en claro = menos superficie.
  writeSecure(join(QDIR, id + ".json"), JSON.stringify({ id, machine: machineName, task: sensitive ? null : task, taskRedacted: sensitive, meta, ts: new Date().toISOString() }, null, 2));
  // umask 077 en el job detached: el 'touch' del .done (y cualquier fichero que cree el wrapper)
  // también nace 0600.
  const wrapper = `umask 077; ( ${shellCmd(machineName, taskFile)} ) > "${outFile}" 2>&1; touch "${doneFile}"`;
  const child = spawn("bash", ["-c", wrapper], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`📮 encolado ${id} → ${machineName}. Verás el estado con 'meshnet jobs' y el resultado con 'meshnet result ${id}'.`);
  process.exit(0);
}
