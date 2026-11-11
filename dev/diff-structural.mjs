/**
 * Diagnóstico fino: encuentra la primera diferencia estructural (incluyendo
 * claves con valor undefined, que JSON.stringify no muestra).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFurniture } from "../src/engine/compile.js";
import { DESIGNS } from "../test/fixtures/designs.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function firstDifference(a, b, path = "") {
  if (a === b) return null;
  const typeA = typeof a;
  const typeB = typeof b;
  if (typeA !== typeB) return `${path}: tipo ${typeA} vs ${typeB}`;
  if (typeA !== "object" || a === null || b === null) {
    return `${path}: ${String(a)} vs ${String(b)}`;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  for (const key of keysA) {
    if (!keysB.includes(key)) return `${path}.${key}: existe solo en el actual`;
    const diff = firstDifference(a[key], b[key], `${path}.${key}`);
    if (diff) return diff;
  }
  for (const key of keysB) {
    if (!keysA.includes(key)) return `${path}.${key}: existe solo en el snapshot`;
  }
  if (Array.isArray(a) && a.length !== b.length) return `${path}: array ${a.length} vs ${b.length}`;
  return null;
}

for (const [name, design] of Object.entries(DESIGNS)) {
  const snapshot = JSON.parse(readFileSync(join(here, "..", "test", "__snapshots__", `${name}.json`), "utf8"));
  const now = compileFurniture(design);
  const diff = firstDifference(now, snapshot);
  console.log(`${name.padEnd(22)} ${diff ?? "OK"}`);
}
