// retencion.mjs — retención (TTL) compartida de la red HIDRA. 0 deps, 0 daemons.
//
// PROBLEMA (auditoría 2026-08-17): endurecer permisos evita que OTRO usuario lea la cola, pero no
// evita que la tarea y la salida en claro sigan ahí seis meses después. Un backup a la nube, un
// disco robado o un `grep` distraído las encuentran igual. La única copia que no se filtra es la
// que ya no existe: por eso la promesa de "retención" tenía que existir de verdad, no en un README.
//
// DISEÑO LEAN: no hay daemon, ni launchd, ni cron. La limpieza se engancha al ARRANQUE de meshnet y
// meshflow, que son los dos únicos comandos que escriben en esos directorios. Quien ensucia, barre.
// Coste: un readdir por directorio (decenas de entradas) — invisible al lado de arrancar un modelo.
//
// CONFIG: HIDRA_RETENCION_DIAS (default 7).
//   · <= 0        -> retención DESACTIVADA (decisión explícita del operador).
//   · no numérico -> default 7 (fail-safe: una typo no debe apagar la retención para siempre).
//
// CONSERVADOR A PROPÓSITO: solo toca ficheros cuyo NOMBRE encaja con un id de la red (j-… de la cola
// de meshnet, run-… de la caché de meshflow). Cualquier otra cosa que haya en esos directorios —un
// fichero del usuario, una nota, lo que sea— se queda donde está. Un barredor de seguridad que borra
// de más es un incidente, no una mejora.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const DIAS_DEFECTO = 7;
const DIA_MS = 24 * 60 * 60 * 1000;

// j-<base36>-<base36>.task|.out|.done|.json   ·   run-<base36>.json|.jsonl|.dir
const ID_RE = /^((?:j|run)-[A-Za-z0-9_-]+?)(?:\.[A-Za-z0-9]+)?$/;

export function ttlMs(env = process.env) {
  const raw = String(env.HIDRA_RETENCION_DIAS ?? "").trim();
  if (raw === "") return DIAS_DEFECTO * DIA_MS;
  const d = Number(raw);
  if (!Number.isFinite(d)) return DIAS_DEFECTO * DIA_MS;
  if (d <= 0) return null;                       // desactivada a propósito
  return d * DIA_MS;
}

// mtime del fichero, o el MÁS RECIENTE del árbol si es un directorio (el .dir de un run de meshflow
// puede tener un mtime viejo y salidas escritas hace un minuto).
function mtimeMax(p) {
  let t = 0;
  try {
    const st = statSync(p);
    t = st.mtimeMs;
    if (st.isDirectory()) for (const f of readdirSync(p)) t = Math.max(t, mtimeMax(join(p, f)));
  } catch {}
  return t;
}

function limpiarDir(dir, corte) {
  if (!dir || !existsSync(dir)) return 0;
  let entradas = [];
  try { entradas = readdirSync(dir); } catch { return 0; }

  // Un job/run es UNA unidad: .task + .out + .done + .json (o .json + .jsonl + .dir) van juntos.
  const grupos = new Map();
  for (const e of entradas) {
    const m = ID_RE.exec(e);
    if (!m) continue;
    const g = grupos.get(m[1]) || [];
    g.push(e);
    grupos.set(m[1], g);
  }

  let borrados = 0;
  for (const ficheros of grupos.values()) {
    // Se juzga por el fichero MÁS RECIENTE del grupo: si el .out se escribió ayer, el .task de hace
    // ocho días no se va solo dejando un resultado huérfano sin contexto.
    const ultimo = Math.max(...ficheros.map((f) => mtimeMax(join(dir, f))));
    if (!(ultimo > 0) || ultimo >= corte) continue;
    for (const f of ficheros) {
      try { rmSync(join(dir, f), { recursive: true, force: true }); borrados++; } catch {}
    }
  }

  // 'latest' (meshflow) apuntando a un run ya barrido: se queda colgado y 'meshflow watch' sin
  // argumentos moriría con "run no encontrado". Se limpia el puntero, no el historial.
  const lat = join(dir, "latest");
  try {
    if (existsSync(lat)) {
      const id = readFileSync(lat, "utf8").trim();
      if (id && !existsSync(join(dir, id + ".json"))) { rmSync(lat, { force: true }); borrados++; }
    }
  } catch {}
  return borrados;
}

export function limpiarRetencion({ dirs = [], ahora = Date.now(), env = process.env } = {}) {
  const ttl = ttlMs(env);
  if (ttl === null) return { desactivado: true, borrados: 0 };
  const corte = ahora - ttl;
  let borrados = 0;
  for (const d of dirs) { try { borrados += limpiarDir(d, corte); } catch {} }
  return { desactivado: false, borrados };
}

// Enganche estándar de arranque: pase lo que pase, NUNCA puede tumbar al comando que la llama.
// La retención es higiene, no una precondición para trabajar.
export function limpiezaAlArrancar(dirs) {
  try { return limpiarRetencion({ dirs }); } catch { return { desactivado: false, borrados: 0 }; }
}
