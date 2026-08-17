#!/usr/bin/env node
// meshflow.mjs — panel EN VIVO de N agentes en paralelo sobre HIDRA (agentmesh/meshnet).
// Hermano de mesh/meshnet: NO ejecuta modelos, orquesta procesos `node agentmesh.mjs` y los pinta.
// Estado por JOURNAL append-only en ~/.cache/meshflow/ (productor=run, consumidor=watch; desacoplados).
// NOTA: meshflow ve SOLO sus propios runs (meshflow run/fan). Los agentes que lanza Claude Code
//       (workflows) son OTRO sistema → para esos usa /workflows DENTRO de Claude Code, no meshflow.
// Ligero para 16GB: el panel pesa nada; el grueso de RAM vive en cloud/torre. Cap + guard de RAM local.
//
// Uso:
//   meshflow run "t1" "t2" ...           lanza N tareas en paralelo + panel en vivo
//   meshflow run -f tareas.txt           tareas desde fichero (1/línea, # = comentario)
//   meshflow run --concurrency 4 ...     tope de agentes a la vez (default 6)
//   meshflow run --machine torre ...     fuerza máquina · --intent/--complexity/--privacy pasan a agentmesh
//   meshflow run --no-watch ...          solo lanza (para CI/headless)
//   meshflow run --dry "a" "b" "c"       agentes FALSOS (0 coste, 0 red): prueba el panel
//   meshflow fan "tarea"                 la misma tarea en mac + torre, con panel
//   meshflow watch [run-id]              engancha el panel a un run (en curso o hecho); sin id = el último
//   meshflow result <run-id> <slot>      vuelca la salida completa de un agente
//
// Privacidad: la etiqueta que se GUARDA en disco va redactada ("tarea #N") salvo --privacy normal.
// Retención: al arrancar se purgan runs/jobs de más de HIDRA_RETENCION_DIAS días (default 7).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { homedir, freemem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { limpiezaAlArrancar } from "./retencion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTMESH = join(HERE, "agentmesh.mjs");

// ---------- endurecido de la caché (2026-08-17) ----------
// El journal, el índice del run y los .out guardan tareas y SALIDAS en claro. Dir 0700, ficheros
// 0600, con chmod EXPLÍCITO: 'mode' se filtra por el umask y no toca lo ya existente (la caché real
// de este Mac estaba en 0755/0644). El chmod de ficheros se hace una sola vez por ruta para no
// meter una syscall por cada chunk de stdout.
const M_DIR = 0o700, M_FILE = 0o600;
const yaAsegurado = new Set();
function ensureDirSecure(d) { mkdirSync(d, { recursive: true, mode: M_DIR }); try { chmodSync(d, M_DIR); } catch {} }
function chmodOnce(p) { if (yaAsegurado.has(p)) return; yaAsegurado.add(p); try { chmodSync(p, M_FILE); } catch {} }
function writeSecure(p, data) { writeFileSync(p, data, { mode: M_FILE }); yaAsegurado.delete(p); chmodOnce(p); }
function appendSecure(p, data) { appendFileSync(p, data, { mode: M_FILE }); chmodOnce(p); }

const CACHE = join(homedir(), ".cache", "meshflow");
ensureDirSecure(CACHE);

// ---------- retención (2026-08-17) ----------
// La promesa "esto no se guarda para siempre" no existía: solo había permisos. Quien ensucia, barre:
// al arrancar meshflow se purgan los runs/jobs viejos de los DOS directorios de la red (su caché y
// la cola de meshnet), sin daemon. Va aquí arriba, ANTES de crear el run nuevo, para no barrerlo.
limpiezaAlArrancar([CACHE, join(homedir(), "agentmesh-queue")]);

// ---------- ANSI (a mano, 0 deps) ----------
const isTTY = !!process.stdout.isTTY;
const HIDE = "\x1b[?25l", SHOW = "\x1b[?25h", CLR = "\x1b[2K\r";
const up = (n) => `\x1b[${n}A`;
const paint_ = (n) => (s) => (isTTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = paint_(2), bold = paint_(1), green = paint_(32), red = paint_(31), cyan = paint_(36), gray = paint_(90), yellow = paint_(33);
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------- helpers ----------
const now = () => Date.now();
function appendEvt(journal, evt) { appendSecure(journal, JSON.stringify({ ts: now(), ...evt }) + "\n"); }
function fmtDur(ms) { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; }
function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function padEndVis(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function readJSON(p, def) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return def; } }
function label(task) { return truncate(String(task).replace(/\s+/g, " ").trim(), 28); }

// ---------- estado: plegar el journal de eventos ----------
function loadState(runId, total, etiquetasEnVivo) {
  const journal = join(CACHE, runId + ".jsonl");
  const st = [];
  for (let i = 0; i < total; i++) st[i] = { slot: i, label: "?", status: "queued", backend: null, model: null, machine: null, startedAt: null, endedAt: null, exit: null, lastLine: "" };
  let events = [];
  try {
    events = readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  for (const e of events) {
    const s = st[e.slot]; if (!s) continue;
    if (e.type === "queued") { s.label = e.label; s.status = "queued"; }
    else if (e.type === "running") { s.status = "running"; s.startedAt = e.ts; }
    else if (e.type === "meta") { s.backend = e.backend; s.model = e.model; s.machine = e.machine; }
    else if (e.type === "tick") { s.lastLine = e.lastLine; }
    else if (e.type === "done") { s.status = "done"; s.endedAt = e.ts; s.exit = e.exit; }
    else if (e.type === "fail") { s.status = "fail"; s.endedAt = e.ts; s.exit = e.exit; }
  }
  // El journal guarda la etiqueta REDACTADA (ver 'etiquetaDisco'). El proceso que lanzó el lote sí
  // tiene la real en memoria y la enseña en el panel: eso es CONSOLA, no disco. Un 'meshflow watch'
  // posterior (u otra terminal) solo ve lo persistido — que es justo el punto.
  if (etiquetasEnVivo) for (let i = 0; i < total; i++) if (etiquetasEnVivo[i]) st[i].label = etiquetasEnVivo[i];
  return st;
}
const allTerminal = (st) => st.every((s) => s.status === "done" || s.status === "fail");

// ---------- render (TTY: panel in-place; no-TTY: log plano) ----------
let prevLines = 0;
function drawLines(st, frame, runId) {
  const cols = (process.stdout.columns || 100);
  const done = st.filter((s) => s.status === "done").length;
  const fail = st.filter((s) => s.status === "fail").length;
  const run = st.filter((s) => s.status === "running").length;
  const q = st.filter((s) => s.status === "queued").length;
  const tot = st.length;
  const out = [];
  out.push(`${bold("🐉 meshflow")} ${gray(runId)}  ${green(done + "/" + tot + " ✓")}${fail ? "  " + red(fail + " ✗") : ""}  ${dim(run + " corriendo · " + q + " en cola")}`);
  out.push("");
  for (const s of st) {
    const icon = s.status === "running" ? cyan(SPIN[frame % SPIN.length]) : s.status === "done" ? green("✓") : s.status === "fail" ? red("✗") : gray("·");
    const t = s.startedAt ? fmtDur((s.endedAt || now()) - s.startedAt) : "—";
    const be = s.backend ? dim(`${s.backend}/${s.model}@${s.machine}`) : gray("ruteando…");
    const tail = (s.status === "done" || s.status === "fail") ? (s.status === "fail" ? red(`exit ${s.exit}`) : "") : dim(truncate(s.lastLine, Math.max(10, cols - 70)));
    out.push(`  ${icon} ${padEndVis(s.label, 28)} ${padEndVis(s.backend ? `${s.backend}/${s.model}@${s.machine}` : "ruteando…", 34).replace(/.*/, (m) => dim(m))} ${gray(padEndVis(t, 7))} ${tail}`);
  }
  return out;
}
function paint(lines) {
  let out = "";
  if (prevLines > 0) out += up(prevLines);
  out += lines.map((l) => CLR + l).join("\n") + "\n";
  process.stdout.write(out);
  prevLines = lines.length;
}

// modo plano (sin TTY): una línea por transición terminal + metas
const announced = new Set();
function plainTick(st, runId) {
  for (const s of st) {
    const key = s.slot + ":" + s.status;
    if ((s.status === "done" || s.status === "fail") && !announced.has(key)) {
      announced.add(key);
      const be = s.backend ? `${s.backend}/${s.model}@${s.machine}` : "?";
      const t = s.startedAt ? fmtDur((s.endedAt || now()) - s.startedAt) : "—";
      const mark = s.status === "done" ? "✓" : "✗";
      console.log(`[${runId}] ${mark} #${s.slot} ${s.label}  ${be}  ${t}${s.status === "fail" ? " exit=" + s.exit : ""}`);
    }
  }
}

// ---------- workers ----------
function launchReal(slot, job, journal, outDir) {
  appendEvt(journal, { type: "running", slot, ts: now() });
  const flags = [];
  if (job.intent) flags.push("--intent", job.intent);
  if (job.complexity) flags.push("--complexity", job.complexity);
  if (job.privacy) flags.push("--privacy", job.privacy);
  if (job.machine) flags.push("--machine", job.machine);
  const outFile = join(outDir, `${slot}.out`);
  // PRIVACIDAD (2026-08-17): la salida de un job SENSIBLE no se persiste. Se sabe de dos formas:
  //  1) el operador lo declaró (--privacy sensitive) → nunca se escribe nada;
  //  2) lo decide el clasificador dentro de agentmesh, que imprime por stderr
  //     "clasifica : ... privacy=sensitive" ANTES de ejecutar el modelo → al verlo se borra lo poco
  //     que hubiera y se deja de escribir.
  // Se elige BORRAR (no cifrar ni rotar): es lo más simple y no deja llave que gestionar. El panel
  // en vivo sigue mostrando el estado; lo que desaparece es la copia en disco.
  let sensitive = false;
  const marcarSensible = () => {
    if (sensitive) return;
    sensitive = true;
    try { rmSync(outFile, { force: true }); } catch {}
    try { writeSecure(join(outDir, `${slot}.sensitive`), ""); } catch {}   // marcador VACÍO, solo para explicarlo en 'result'
  };
  if (job.privacy === "sensitive") marcarSensible();
  const p = spawn("node", [AGENTMESH, ...flags, job.task], { stdio: ["ignore", "pipe", "pipe"] });
  let metaSent = false, lastTick = 0;
  p.stdout.on("data", (d) => {
    const s = d.toString();
    if (!sensitive) { try { appendSecure(outFile, s); } catch {} }
    const line = s.split("\n").map((x) => stripAnsi(x).trim()).filter(Boolean).pop();
    const t = now();
    // el journal también es disco: en sensible el tick no lleva contenido, solo señal de vida.
    if (line && t - lastTick > 400) { lastTick = t; appendEvt(journal, { type: "tick", slot, lastLine: sensitive ? "(salida sensible — no se persiste)" : truncate(line, 120) }); }
  });
  p.stderr.on("data", (d) => {
    const s = stripAnsi(d.toString());
    if (/privacy=sensitive/.test(s)) marcarSensible();
    if (!sensitive) { try { appendSecure(outFile, s); } catch {} }
    if (!metaSent) {
      // agentmesh imprime: "enruta : tier=X → backend/model @ machine"  (model puede llevar '/')
      const m = s.match(/tier=\S+\s*→\s*(\S+)\s*@\s*(\S+)/);
      if (m) {
        const bm = m[1], i = bm.indexOf("/");
        metaSent = true;
        appendEvt(journal, { type: "meta", slot, backend: i > 0 ? bm.slice(0, i) : bm, model: i > 0 ? bm.slice(i + 1) : "", machine: m[2] });
      }
    }
  });
  return new Promise((res) => {
    p.on("close", (code) => { appendEvt(journal, { type: code === 0 ? "done" : "fail", slot, ts: now(), exit: code }); res(code); });
    p.on("error", () => { appendEvt(journal, { type: "fail", slot, ts: now(), exit: -1 }); res(-1); });
  });
}

function launchDry(slot, job, journal) {
  appendEvt(journal, { type: "running", slot, ts: now() });
  const fakes = [["openrouter", "deepseek/deepseek-chat", "mac"], ["ollama", "llama3.1:8b", "mac"], ["gemini", "gemini-2.5-flash", "mac"], ["claude", "sonnet", "mac"], ["ollama", "qwen3:30b-a3b", "torre"]];
  const f = fakes[slot % fakes.length];
  setTimeout(() => appendEvt(journal, { type: "meta", slot, backend: f[0], model: f[1], machine: f[2] }), 200 + Math.floor(Math.random() * 400));
  const dur = 1500 + Math.floor(Math.random() * 6000);
  const ticks = ["clasificando…", "ruteando al backend", "procesando entrada", "generando respuesta", "casi listo…"];
  let i = 0;
  const iv = setInterval(() => { if (i < ticks.length) appendEvt(journal, { type: "tick", slot, lastLine: ticks[i++] }); }, dur / 6);
  return new Promise((res) => setTimeout(() => { clearInterval(iv); const fail = Math.random() < 0.12; appendEvt(journal, { type: fail ? "fail" : "done", slot, ts: now(), exit: fail ? 2 : 0 }); res(0); }, dur));
}

// ---------- notificación + cierre ----------
function beep() { try { process.stdout.write("\x07"); } catch {} }
function notify(msg) { try { spawn("osascript", ["-e", `display notification "${msg.replace(/"/g, "")}" with title "meshflow"`], { stdio: "ignore" }).unref(); } catch {} }
function restoreCursor() { if (isTTY) try { process.stdout.write(SHOW); } catch {} }
process.on("SIGINT", () => { restoreCursor(); console.log("\n(meshflow interrumpido; los agentes en curso siguen su proceso)"); process.exit(130); });

// ---------- render loop (compartido por run y watch) ----------
function renderUntilDone(runId, total, etiquetasEnVivo) {
  return new Promise((resolve) => {
    let frame = 0;
    if (isTTY) process.stdout.write(HIDE);
    const iv = setInterval(() => {
      const st = loadState(runId, total, etiquetasEnVivo);
      if (isTTY) paint(drawLines(st, frame++, runId)); else plainTick(st, runId);
      if (allTerminal(st)) {
        clearInterval(iv);
        if (isTTY) paint(drawLines(st, frame, runId));
        restoreCursor();
        const done = st.filter((s) => s.status === "done").length, fail = st.filter((s) => s.status === "fail").length;
        console.log(`\n${bold("Resumen")}  ${green(done + " ✓")}  ${fail ? red(fail + " ✗") : "0 ✗"}  · salidas en ${gray(join(CACHE, runId + ".dir"))}`);
        beep(); notify(`${done}/${total} ✓${fail ? ", " + fail + " ✗" : ""}`);
        resolve();
      }
    }, isTTY ? 120 : 500);
  });
}

// ---------- scheduler (pool con cap + guard de RAM) ----------
async function runPool(jobs, opts) {
  const runId = "run-" + now().toString(36) + Math.random().toString(36).slice(2, 6);
  const journal = join(CACHE, runId + ".jsonl");
  const outDir = join(CACHE, runId + ".dir");
  ensureDirSecure(outDir);
  writeSecure(journal, "");
  // Al disco va SIEMPRE 'labelDisco' (redactada salvo --privacy normal explícito), nunca 'label'.
  writeSecure(join(CACHE, runId + ".json"), JSON.stringify({ runId, total: jobs.length, createdAt: now(), tasks: jobs.map((j) => j.labelDisco) }));
  writeSecure(join(CACHE, "latest"), runId);
  jobs.forEach((j, slot) => appendEvt(journal, { type: "queued", slot, label: j.labelDisco }));

  console.log(`${bold("🐉 meshflow")} ${gray(runId)} · ${jobs.length} agentes · cap ${opts.concurrency}${opts.dry ? gray(" · DRY (sin coste)") : ""}\n`);
  const render = opts.watch ? renderUntilDone(runId, jobs.length, jobs.map((j) => j.label)) : Promise.resolve();

  let next = 0, active = 0, finished = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (active < opts.concurrency && next < jobs.length) {
        // guard de RAM (16GB): no apilar trabajos locales si queda poca memoria (salvo dry)
        if (!opts.dry && active > 0 && freemem() < 3 * 1024 * 1024 * 1024) break;
        const slot = next++; active++;
        const p = opts.dry ? launchDry(slot, jobs[slot], journal) : launchReal(slot, jobs[slot], journal, outDir);
        p.then(() => { active--; finished++; (finished === jobs.length) ? resolve() : pump(); });
      }
    };
    pump();
    const gate = setInterval(() => { (finished === jobs.length) ? clearInterval(gate) : pump(); }, 800);
  });
  await render;
  return runId;
}

// ---------- parseo de args ----------
function parse(args) {
  const o = { concurrency: 6, watch: true, dry: false, intent: null, complexity: null, privacy: null, machine: null, file: null, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--concurrency" || a === "-c") o.concurrency = parseInt(args[++i], 10) || 6;
    else if (a === "--no-watch") o.watch = false;
    else if (a === "--dry") o.dry = true;
    else if (a === "-f" || a === "--file") o.file = args[++i];
    else if (a === "--intent") o.intent = args[++i];
    else if (a === "--complexity") o.complexity = args[++i];
    else if (a === "--privacy") o.privacy = args[++i];
    else if (a === "--machine") o.machine = args[++i];
    else o.rest.push(a);
  }
  return o;
}

// ---------- main ----------
const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  // 21 = final de la cabecera de comentario (línea 21 del fichero); pasarse cuela los 'import'.
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

if (cmd === "run" || cmd === "fan") {
  const o = parse(argv.slice(1));
  let tasks = o.rest;
  if (o.file) tasks = readFileSync(o.file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!tasks.length) { console.error("meshflow: no hay tareas. Uso: meshflow run \"t1\" \"t2\"  |  meshflow run -f tareas.txt"); process.exit(1); }

  // ETIQUETAS — REDACTADAS POR DEFECTO (2026-08-17, auditoría final).
  // El parche anterior solo redactaba con --privacy sensitive EXPLÍCITO. Pero la sensibilidad se
  // descubre casi siempre TARDE, dentro de agentmesh (el clasificador): para entonces meshflow ya
  // había escrito los 28 primeros caracteres de la tarea en el journal y en el índice del run. Se
  // borraba el .out y el journal seguía cantando "datos bancarios de Acme S…". Redactar tras el
  // hecho es imposible en un journal append-only, así que se invierte la carga de la prueba:
  //   · por defecto            -> al disco va "tarea #N" (posición, no contenido);
  //   · --privacy normal       -> el operador AFIRMA que no es sensible ⇒ se guarda la etiqueta real.
  // Solo una decisión HUMANA explícita autoriza persistir; una inferencia nunca. Mismo criterio que
  // el fail-closed de agentmesh/meshnet. Coste: 'meshflow runs/watch' de un run viejo enseña
  // "tarea #0" en vez del texto — a cambio, la etiqueta no puede filtrar por descubrimiento tardío.
  const normalExplicito = o.privacy === "normal";
  const mkJob = (slot, t, sufijo, machine) => ({
    task: t, machine,
    label: label(t) + sufijo,                                                        // EN VIVO (consola)
    labelDisco: normalExplicito ? label(t) + sufijo : `tarea #${slot}${sufijo}`,      // EN DISCO
    intent: o.intent, complexity: o.complexity, privacy: o.privacy,
  });
  let jobs;
  if (cmd === "fan") {
    const t = tasks.join(" ");
    jobs = [mkJob(0, t, "@mac", "mac"), mkJob(1, t, "@torre", "torre")];
  } else {
    jobs = tasks.map((t, i) => mkJob(i, t, "", o.machine));
  }
  const runId = await runPool(jobs, o);
  if (!o.watch) console.log(`lanzado ${runId} (${jobs.length} agentes). Panel:  meshflow watch ${runId}`);
  process.exit(0);
}

if (cmd === "runs" || cmd === "ls") {
  const ids = readdirSync(CACHE).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort().reverse();
  if (!ids.length) { console.log("(sin runs de meshflow todavía — lánzalos con: meshflow run \"t1\" \"t2\")"); process.exit(0); }
  console.log(bold("Runs de meshflow") + dim("  ·  (los agentes que lanza Claude NO son de aquí → mira /workflows dentro de Claude Code)"));
  for (const id of ids.slice(0, 12)) {
    const m = readJSON(join(CACHE, id + ".json"), null); if (!m) continue;
    const st = loadState(id, m.total);
    const done = st.filter((s) => s.status === "done").length, fail = st.filter((s) => s.status === "fail").length;
    const live = st.some((s) => s.status === "running" || s.status === "queued");
    console.log(`  ${live ? cyan("● vivo ") : gray("· hecho")}  ${id}  ${green(done + "✓")}${fail ? " " + red(fail + "✗") : ""} /${m.total}`);
  }
  process.exit(0);
}

if (cmd === "watch") {
  const runId = argv[1] || (existsSync(join(CACHE, "latest")) ? readFileSync(join(CACHE, "latest"), "utf8").trim() : null);
  if (!runId) { console.error("meshflow: no hay run de meshflow que ver.\n  · Lista tus runs:        meshflow runs\n  · Lánzalos:              meshflow run \"t1\" \"t2\"\n  · OJO: los agentes que lanza CLAUDE (workflows) NO son de meshflow → míralos con /workflows DENTRO de Claude Code."); process.exit(1); }
  const meta = readJSON(join(CACHE, runId + ".json"), null);
  if (!meta) { console.error(`meshflow: run '${runId}' no encontrado en ${CACHE}`); process.exit(1); }
  await renderUntilDone(runId, meta.total);
  process.exit(0);
}

if (cmd === "result") {
  const runId = argv[1], slot = argv[2];
  if (!runId || slot === undefined) { console.error("Uso: meshflow result <run-id> <slot>"); process.exit(1); }
  const f = join(CACHE, runId + ".dir", `${slot}.out`);
  if (!existsSync(f)) {
    // Distinguir "no hay nada" de "hubo salida pero era sensible y por política no se guardó".
    if (existsSync(join(CACHE, runId + ".dir", `${slot}.sensitive`)))
      console.error(`#${slot} de ${runId} se clasificó privacy=sensitive: su salida NO se persiste (regla dura HIDRA).\nRelánzala en primer plano si necesitas verla:  mesh --privacy sensitive "<tarea>"`);
    else console.error(`sin salida para ${runId} #${slot}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(f, "utf8"));
  process.exit(0);
}

console.error(`meshflow: comando desconocido '${cmd}'. Prueba: run | fan | watch | result | help`);
process.exit(1);
