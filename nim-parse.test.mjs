// Tests del parseo de respuestas de NVIDIA NIM (node:test, 0 deps, sin red).
// Protegen la invariante: un fallo de NIM SIEMPRE explica el porqué con evidencia
// (cuerpo del error, timeout, no-JSON), nunca el "revisa API key o rate-limit" a ciegas.
import { test } from "node:test";
import assert from "node:assert";
import { parseNvidiaResponse } from "./nim-parse.mjs";

test("respuesta OK con choices → devuelve el contenido", () => {
  const body = JSON.stringify({ choices: [{ message: { content: "hola" }, finish_reason: "stop" }] });
  const r = parseNvidiaResponse(body, 0);
  assert.equal(r.ok, true);
  assert.equal(r.content, "hola");
  assert.equal(r.finishReason, "stop");
});

test("finish_reason=length se propaga (para avisar de truncado)", () => {
  const body = JSON.stringify({ choices: [{ message: { content: "a…" }, finish_reason: "length" }] });
  const r = parseNvidiaResponse(body, 0);
  assert.equal(r.ok, true);
  assert.equal(r.finishReason, "length");
});

test("error de API estilo {detail} (429) → reason con el mensaje real", () => {
  const body = JSON.stringify({ detail: "Rate limit exceeded for this API key" });
  const r = parseNvidiaResponse(body, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Rate limit exceeded/);
});

test("error de API estilo {error:{message}} (401) → reason con el mensaje real", () => {
  const body = JSON.stringify({ error: { message: "Invalid API key" } });
  const r = parseNvidiaResponse(body, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Invalid API key/);
});

test("stdout vacío → apunta a timeout/kill, no a la API key", () => {
  const r = parseNvidiaResponse("", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /vacía/i);
});

test("curl exit 28 (--max-time) → reason de timeout explícita", () => {
  const r = parseNvidiaResponse("", 28);
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout/i);
});

test("no-JSON (HTML de un gateway) → reason con la cabecera del cuerpo", () => {
  const r = parseNvidiaResponse("<html>502 Bad Gateway</html>", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no-JSON/);
  assert.match(r.reason, /502/);
});

test("JSON sin choices ni mensaje de error conocido → enseña el cuerpo igualmente", () => {
  const r = parseNvidiaResponse(JSON.stringify({ status: "queued" }), 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /queued/);
});
