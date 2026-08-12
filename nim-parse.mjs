// Parseo puro de la respuesta de NVIDIA NIM (OpenAI-compat). Vive separado de
// agentmesh.mjs para poder testearlo sin red (agentmesh.mjs es un script con
// efectos al importarse). Contrato: SIEMPRE explica el fallo con la evidencia
// real (cuerpo del error, timeout, no-JSON) — el catch genérico anterior tiraba
// el cuerpo y solo decía "revisa API key o rate-limit", que no ayudó a nadie
// cuando el 2026-07-29 una generación larga murió por el kill de 180s.
export function parseNvidiaResponse(stdout, curlStatus = 0) {
  if (curlStatus === 28) return { ok: false, reason: "timeout de curl (--max-time): la generación no terminó a tiempo" };
  if (curlStatus !== 0) return { ok: false, reason: `curl salió con código ${curlStatus}` };
  const s = (stdout || "").trim();
  if (!s) return { ok: false, reason: "respuesta vacía (¿proceso matado por timeout?)" };
  let j;
  try { j = JSON.parse(s); } catch { return { ok: false, reason: `no-JSON: ${s.slice(0, 200)}` }; }
  const choice = j?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.length) {
    return { ok: true, content, finishReason: choice.finish_reason };
  }
  const errMsg = j?.detail || j?.error?.message || j?.title || j?.message;
  if (errMsg) return { ok: false, reason: `la API respondió: ${String(errMsg).slice(0, 200)}` };
  return { ok: false, reason: `JSON sin choices: ${s.slice(0, 200)}` };
}
