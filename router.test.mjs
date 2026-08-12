// Tests del router de agentmesh (node:test, 0 deps). Protegen las invariantes DURAS:
// privacy=sensitive -> SIEMPRE local; por defecto NUNCA Opus; intents mapeados a su tier.
// Enganchados al pre-commit. Ejecutan --route-only (no gastan, no llaman a modelos).
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AM = join(dirname(fileURLToPath(import.meta.url)), "hidra.mjs");
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

// Prueba directa del filtro fail-closed en hidra.mjs (no solo del policy.json): aunque nvidia
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
