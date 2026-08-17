// Tests del router de agentmesh (node:test, 0 deps). Protegen las invariantes DURAS:
// privacy=sensitive -> SIEMPRE local; por defecto NUNCA Opus; intents mapeados a su tier.
// Enganchados al pre-commit. Ejecutan --route-only (no gastan, no llaman a modelos).
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, chmodSync, statSync, existsSync, readdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// En CI no hay ningún runtime instalado: se declaran los backends por env (la misma
// técnica que demo.sh) para que la POLÍTICA sea testeable en cualquier máquina. Las
// guardas de sensitive-remoto no dependen de esto: abortan antes de mirar disponibilidad.
process.env.HIDRA_ASSUME_AVAILABLE ||= "ollama,claude,codex,gemini,openrouter,nvidia";

const HERE = dirname(fileURLToPath(import.meta.url));
const AM = join(HERE, "agentmesh.mjs");
const MESHNET = join(HERE, "meshnet.mjs");
const MESHFLOW = join(HERE, "meshflow.mjs");
function route(flags) {
  const r = spawnSync("node", [AM, "--route-only", ...flags, "tarea de prueba"], { encoding: "utf8" });
  return (r.stderr || "") + (r.stdout || "");
}
function routeTask(task, flags) {
  const r = spawnSync("node", [AM, "--route-only", ...flags, task], { encoding: "utf8" });
  return (r.stderr || "") + (r.stdout || "");
}

test("privacy=sensitive va SIEMPRE a local (nunca a la nube)", () => {
  const o = route(["--privacy", "sensitive", "--intent", "code-edit", "--complexity", "hard"]);
  assert.match(o, /tier=local/);
});

test("por defecto cae en cheap, NUNCA en frontier/opus", () => {
  const o = route(["--privacy", "normal", "--intent", "reason", "--complexity", "medium"]);
  assert.match(o, /tier=cheap/);
  assert.doesNotMatch(o, /opus/);
});

test("code-edit enruta a code", () => {
  const o = route(["--privacy", "normal", "--intent", "code-edit", "--complexity", "medium"]);
  assert.match(o, /tier=code/);
});

test("format/trivial enruta a local (mecánico gratis)", () => {
  const o = route(["--privacy", "normal", "--intent", "format", "--complexity", "trivial"]);
  assert.match(o, /tier=local/);
});

test("razonamiento difícil va a frontier", () => {
  const o = route(["--privacy", "normal", "--intent", "architecture", "--complexity", "hard"]);
  assert.match(o, /tier=frontier/);
});

// HIDRA V2 (2026-06-21): fail-closed de clasificación. Sin --privacy, classify decide; la heurística
// de keywords corre SIEMPRE y se UNE (OR) al LLM, así que una tarea con 'password/secreto/token'
// acaba sensitive → local, aunque el intent/complexity la mandarían a la nube. Determinista sobre el
// tier (la unión fuerza sensitive); rápido si Ollama está dormido (estado lean por defecto).
test("keyword sensible sin --privacy → local (unión heurística fail-closed)", () => {
  const o = routeTask("guarda el password secreto y el token de la api en el repo", ["--intent", "code-edit", "--complexity", "hard"]);
  assert.match(o, /tier=local/);
});

// NVIDIA NIM (2026-07-04): tier cloud-gratis. Se probó con env NVIDIA_API_KEY forzado (dummy,
// --route-only no llama a la API real) para no depender de si el vault ya lo tiene cargado.
test("con NVIDIA_API_KEY presente, un intent barato/trivial puede elegir nvidia", () => {
  const r = spawnSync("node", [AM, "--route-only", "--privacy", "normal", "--intent", "summarize", "--complexity", "trivial", "tarea de prueba"], { encoding: "utf8", env: { ...process.env, NVIDIA_API_KEY: "test-key-dummy" } });
  const o = (r.stderr || "") + (r.stdout || "");
  assert.match(o, /tier=cheap/);
  assert.match(o, /nvidia\//);
});

// Prueba directa del filtro fail-closed en agentmesh.mjs (no solo del policy.json): aunque nvidia
// ahora sea candidato del tier 'local', privacy=sensitive debe seguir resolviendo a ollama en
// concreto (no solo tier=local) incluso con NVIDIA_API_KEY presente. Esto es lo que hace innecesario
// un tier 'private' aparte: el filtro es de código, no depende de qué haya en la lista del tier.
test("privacy=sensitive sigue resolviendo a ollama en concreto, aunque NVIDIA_API_KEY esté presente", () => {
  const r = spawnSync("node", [AM, "--route-only", "--privacy", "sensitive", "--intent", "code-edit", "--complexity", "hard", "tarea de prueba"], { encoding: "utf8", env: { ...process.env, NVIDIA_API_KEY: "test-key-dummy" } });
  const o = (r.stderr || "") + (r.stdout || "");
  assert.match(o, /tier=local/);
  assert.match(o, /→ ollama\//);
  assert.doesNotMatch(o, /→ nvidia\//);
});

// ─────────────────────────────────────────────────────────────────────────────
// meshnet / meshflow (2026-08-17). Hallazgo de la review adversarial: el fail-closed vivía SOLO en
// agentmesh.mjs. meshnet devolvía privacy="normal" cuando el clasificador fallaba y escribía tarea,
// metadatos y salida EN CLARO (0644) en ~/agentmesh-queue; meshflow persistía las salidas igual.
// Estos tests fijan las tres invariantes nuevas. Ninguno llama a un modelo ni gasta:
//   · clasificador roto  -> se simula rompiendo el PATH del hijo (meshnet arranca con la ruta
//     absoluta de node, pero su spawnSync("node", …) interno ya no resuelve => ENOENT).
//   · permisos y cola    -> se corren con un HOME de usar y tirar (mkdtemp), nunca sobre el real.
// ─────────────────────────────────────────────────────────────────────────────
function tmpHome() {
  const h = mkdtempSync(join(tmpdir(), "hidra-test-"));
  return { home: h, queue: join(h, "agentmesh-queue"), env: { ...process.env, HOME: h } };
}
function meshnet(args, env) {
  // process.execPath (node absoluto) para poder pasar un PATH roto sin dejar de arrancar meshnet.
  return spawnSync(process.execPath, [MESHNET, ...args], { encoding: "utf8", env });
}
const modo = (p) => statSync(p).mode & 0o777;

test("meshnet: clasificador roto/caído → privacy=sensitive (fail-closed), NUNCA normal", () => {
  const { home, env } = tmpHome();
  // PATH inservible: el clasificador (`node agentmesh.mjs --classify-only`) no arranca.
  const r = meshnet(["send", "torre", "una tarea cualquiera sin pistas"], { ...env, PATH: "/nonexistent-hidra" });
  const o = (r.stderr || "") + (r.stdout || "");
  assert.match(o, /privacy=sensitive/, "sin clasificador la privacidad debe caer a sensitive");
  assert.doesNotMatch(o, /privacy=normal/);
  assert.strictEqual(r.status, 3, "sensitive + destino remoto ⇒ aborta con 3");
  rmSync(home, { recursive: true, force: true });
});

test("meshnet: envío remoto de una tarea sensitive se RECHAZA (send/fan/post)", () => {
  const { home, queue, env } = tmpHome();
  const sens = ["--privacy", "sensitive", "--intent", "reason", "--complexity", "medium"];

  const send = meshnet(["send", "torre", ...sens, "datos con el password del cliente"], env);
  assert.strictEqual(send.status, 3);
  assert.match(send.stderr, /ABORTO el envío a \[torre\]/);

  const fan = meshnet(["fan", ...sens, "datos con el password del cliente"], env);
  assert.strictEqual(fan.status, 3, "fan incluye la torre ⇒ también se aborta");

  // post remoto: se rechaza ANTES de tocar disco (ni .task ni .json ni .out en la cola).
  const post = meshnet(["post", "torre", ...sens, "datos con el password del cliente"], env);
  assert.strictEqual(post.status, 3);
  assert.ok(!existsSync(queue) || readdirSync(queue).length === 0, "un post remoto rechazado no deja nada en la cola");
  rmSync(home, { recursive: true, force: true });
});

test("meshnet: la cola se crea 0700 y sus ficheros 0600 (y endurece una cola ya existente)", () => {
  const { home, queue, env } = tmpHome();
  mkdirSync(queue, { recursive: true });
  chmodSync(queue, 0o777);                       // cola vieja world-writable, como la real (0755)
  // Tarea NORMAL a la máquina local: camino feliz, sin regresión (debe encolar y salir 0).
  const r = meshnet(["post", "mac", "--privacy", "normal", "--intent", "format", "--complexity", "trivial", "tarea inocua"], env);
  assert.strictEqual(r.status, 0, "una tarea normal en local se sigue encolando igual que antes");
  assert.strictEqual(modo(queue), 0o700, "el directorio de la cola debe quedar 0700");
  const ficheros = readdirSync(queue);
  assert.ok(ficheros.some((f) => f.endsWith(".task")) && ficheros.some((f) => f.endsWith(".json")), "encoló .task y .json");
  for (const f of ficheros.filter((x) => /\.(task|json|out)$/.test(x)))
    assert.strictEqual(modo(join(queue, f)), 0o600, `${f} debe ser 0600`);
  // La tarea normal SÍ se sigue indexando en claro (el listado de 'meshnet jobs' no cambia).
  const meta = JSON.parse(readFileSync(join(queue, ficheros.find((f) => f.endsWith(".json"))), "utf8"));
  assert.strictEqual(meta.task, "tarea inocua");
  assert.strictEqual(meta.taskRedacted, false);
  rmSync(home, { recursive: true, force: true });
});

test("meshnet: un post sensitive a la máquina local sí se permite, pero redactado y a 0600", () => {
  const { home, queue, env } = tmpHome();
  const r = meshnet(["post", "mac", "--privacy", "sensitive", "--intent", "reason", "--complexity", "medium", "el token de la api es abc123"], env);
  assert.strictEqual(r.status, 0);
  const metaFile = readdirSync(queue).find((f) => f.endsWith(".json"));
  const meta = JSON.parse(readFileSync(join(queue, metaFile), "utf8"));
  assert.strictEqual(meta.task, null, "el índice no duplica el texto sensible");
  assert.strictEqual(meta.taskRedacted, true);
  assert.strictEqual(modo(join(queue, metaFile)), 0o600);
  rmSync(home, { recursive: true, force: true });
});

test("meshflow: su caché nace 0700/0600 y un lote sensible no persiste ni la etiqueta", () => {
  const { home, env } = tmpHome();
  // --dry: agentes falsos, 0 coste, 0 red. Basta para fijar permisos y redacción.
  const r = spawnSync(process.execPath, [MESHFLOW, "run", "--dry", "--no-watch", "--privacy", "sensitive", "el token de la api es abc123"], { encoding: "utf8", env });
  assert.strictEqual(r.status, 0, (r.stderr || "").slice(0, 300));
  const cache = join(home, ".cache", "meshflow");
  assert.strictEqual(modo(cache), 0o700, "~/.cache/meshflow debe ser 0700");
  const runId = readFileSync(join(cache, "latest"), "utf8").trim();
  for (const f of ["latest", runId + ".json", runId + ".jsonl"])
    assert.strictEqual(modo(join(cache, f)), 0o600, `${f} debe ser 0600`);
  assert.strictEqual(modo(join(cache, runId + ".dir")), 0o700, "el directorio de salidas debe ser 0700");
  const persistido = readFileSync(join(cache, runId + ".json"), "utf8") + readFileSync(join(cache, runId + ".jsonl"), "utf8");
  assert.doesNotMatch(persistido, /abc123/, "ni la etiqueta del lote sensible toca el disco");
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// RONDA 2 (2026-08-17). La auditoría final encontró que el parche anterior tapaba solo la mitad:
//   · meshflow redactaba la etiqueta SOLO con --privacy sensitive EXPLÍCITO. Pero el caso normal es
//     que la sensibilidad la descubra el CLASIFICADOR, ya dentro de agentmesh: para entonces la
//     etiqueta llevaba rato escrita en el journal y en el índice. Se borraba el .out y el journal
//     seguía cantando el texto. En un journal append-only no se puede redactar a posteriori ⇒ la
//     etiqueta se persiste redactada POR DEFECTO y solo un --privacy normal humano la libera.
//   · la "retención" prometida no existía: tarea y salida en claro se quedaban en disco para siempre.
// ─────────────────────────────────────────────────────────────────────────────
function meshflow(args, env) {
  return spawnSync(process.execPath, [MESHFLOW, ...args], { encoding: "utf8", env });
}
// Todo lo que meshflow deja escrito del último run: índice + journal.
function persistidoDelUltimoRun(home) {
  const cache = join(home, ".cache", "meshflow");
  const runId = readFileSync(join(cache, "latest"), "utf8").trim();
  return readFileSync(join(cache, runId + ".json"), "utf8") + readFileSync(join(cache, runId + ".jsonl"), "utf8");
}

test("meshflow: la etiqueta del journal va REDACTADA por defecto (sin ningún --privacy)", () => {
  const { home, env } = tmpHome();
  // Tarea sin pistas obvias: justo el caso en que la etiqueta se escribía en claro ANTES de que el
  // clasificador pudiera decir nada. --dry ⇒ 0 coste, 0 red.
  const r = meshflow(["run", "--dry", "--no-watch", "extractos banco Acme SL"], env);
  assert.strictEqual(r.status, 0, (r.stderr || "").slice(0, 300));
  const texto = persistidoDelUltimoRun(home);
  assert.doesNotMatch(texto, /Acme/i, "por defecto la etiqueta real NO toca el disco");
  assert.match(texto, /tarea #0/, "en su lugar se persiste la POSICIÓN, no el contenido");
  rmSync(home, { recursive: true, force: true });
});

test("meshflow: la etiqueta real se persiste SOLO con --privacy normal explícito del operador", () => {
  const { home, env } = tmpHome();
  const r = meshflow(["run", "--dry", "--no-watch", "--privacy", "normal", "extractos banco Acme SL"], env);
  assert.strictEqual(r.status, 0, (r.stderr || "").slice(0, 300));
  const texto = persistidoDelUltimoRun(home);
  assert.match(texto, /extractos banco Acme SL/, "el humano AFIRMÓ que no es sensible ⇒ se guarda");
  rmSync(home, { recursive: true, force: true });
});

test("retención: al arrancar se borra lo viejo, se respeta lo nuevo y el TTL es configurable por env", () => {
  const { home, queue, env } = tmpHome();
  const cache = join(home, ".cache", "meshflow");
  mkdirSync(queue, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const escribir = (p, s) => { writeFileSync(p, s); return p; };
  const viejoSeg = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;

  // Un job de la cola YA CONSUMIDO (tiene .done) y un run de meshflow con su .dir de salidas.
  const antiguos = [
    escribir(join(queue, "j-viejo.task"), "el iban del cliente"),
    escribir(join(queue, "j-viejo.out"), "salida en claro de hace un mes"),
    escribir(join(queue, "j-viejo.done"), ""),
    escribir(join(queue, "j-viejo.json"), JSON.stringify({ id: "j-viejo", machine: "mac", task: "vieja" })),
    escribir(join(cache, "run-viejo.json"), JSON.stringify({ runId: "run-viejo", total: 1 })),
    escribir(join(cache, "run-viejo.jsonl"), ""),
  ];
  mkdirSync(join(cache, "run-viejo.dir"));
  antiguos.push(escribir(join(cache, "run-viejo.dir", "0.out"), "salida vieja en claro"));
  antiguos.push(join(cache, "run-viejo.dir"));
  for (const p of antiguos) utimesSync(p, viejoSeg, viejoSeg);

  // Recientes + un fichero que NO es de la red: la limpieza es conservadora y no lo mira siquiera.
  const intocables = [
    escribir(join(queue, "j-nuevo.task"), "tarea de hoy"),
    escribir(join(queue, "j-nuevo.json"), JSON.stringify({ id: "j-nuevo", machine: "mac", task: "de hoy" })),
    escribir(join(cache, "notas-mias.txt"), "esto no es un job de la red"),
  ];

  // (1) TTL largo por env: 30 días aún no caducan.
  assert.strictEqual(meshnet(["jobs"], { ...env, HIDRA_RETENCION_DIAS: "90" }).status, 0);
  assert.ok(existsSync(join(queue, "j-viejo.task")), "con HIDRA_RETENCION_DIAS=90 nada de 30 días caduca");

  // (2) default (7 días): cae el GRUPO entero de cada job/run viejo, .dir de salidas incluido.
  assert.strictEqual(meshnet(["jobs"], env).status, 0);
  for (const p of antiguos) assert.ok(!existsSync(p), `${p} debería haber caducado`);
  for (const p of intocables) assert.ok(existsSync(p), `${p} es reciente o ajeno: NO se toca`);
  rmSync(home, { recursive: true, force: true });
});

test("meshnet: leer el result de un job terminado borra su .task (la tarea en claro)", () => {
  const { home, queue, env } = tmpHome();
  mkdirSync(queue, { recursive: true });
  for (const [f, c] of [["j-x.task", "el iban del cliente"], ["j-x.out", "resultado"], ["j-x.done", ""]])
    writeFileSync(join(queue, f), c);
  const r = meshnet(["result", "j-x"], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /resultado/, "el resultado se sigue mostrando igual que antes");
  assert.ok(!existsSync(join(queue, "j-x.task")), "job consumido ⇒ el .task ya no tiene razón de existir");
  assert.ok(existsSync(join(queue, "j-x.out")), "el .out se queda hasta que caduque por TTL");
  rmSync(home, { recursive: true, force: true });
});
