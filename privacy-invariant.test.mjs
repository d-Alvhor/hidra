// ─────────────────────────────────────────────────────────────────────────────
// THE SECURITY CONTRACT.
//
// This test IS the contract. If it breaks, the system leaks.
//
// Invariant: a task classified privacy=sensitive may ONLY be routed to a local
// backend. If no local backend is available, the router MUST abort (exit 3) —
// it must never fall back to a cloud model, never ask, never fail silently.
//
// The router is executed with a stripped PATH so that no local model runtime
// (ollama) can be found: that simulates "no local backend available" without
// touching the machine's real installation.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIDRA = join(dirname(fileURLToPath(import.meta.url)), "hidra.mjs");

// PATH sin homebrew/usr-local: el binario `ollama` deja de existir para el router.
const NO_LOCAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("Security contract — fail-closed sovereignty", () => {
  test("sensitive + no local backend available → ABORT with exit 3 (never cloud)", () => {
    const r = spawnSync(
      process.execPath,
      [HIDRA, "--privacy", "sensitive", "--intent", "code-edit", "--complexity", "hard",
       "analyze this record containing personal data"],
      { encoding: "utf8", env: { ...process.env, PATH: NO_LOCAL_PATH } },
    );
    assert.strictEqual(r.status, 3, `expected exit 3 (abort), got ${r.status}`);
    const out = (r.stderr || "") + (r.stdout || "");
    assert.match(out, /ABORTO|ABORT/i, "abort must be explicit and human-readable");
    assert.doesNotMatch(out, /ejecuta\s*:.*(openrouter|nvidia|claude|codex|gemini)/i,
      "no cloud backend may ever be executed for sensitive data");
  });

  test("sensitive + local available → routes to local tier, cloud candidates filtered out", () => {
    const r = spawnSync(
      process.execPath,
      [HIDRA, "--route-only", "--privacy", "sensitive", "--intent", "reason", "--complexity", "medium",
       "summarize this private document"],
      // declare a local runtime as present; the ABORT case above deliberately declares nothing
      { encoding: "utf8", env: { ...process.env, HIDRA_ASSUME_AVAILABLE: "ollama" } },
    );
    const out = (r.stderr || "") + (r.stdout || "");
    assert.match(out, /tier=local/);
    assert.match(out, /ollama/);
  });
});
