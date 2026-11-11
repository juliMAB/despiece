/**
 * Diagnóstico: compara la salida actual del motor con los snapshots.
 * Uso: node dev/diff-snapshots.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFurniture } from "../src/engine/compile.js";
import { DESIGNS } from "../test/fixtures/designs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const name of Object.keys(DESIGNS)) {
  const snapshot = JSON.parse(readFileSync(join(here, "..", "test", "__snapshots__", `${name}.json`), "utf8"));
  const now = compileFurniture(DESIGNS[name]);

  const partsOk = eq(snapshot.parts, now.parts);
  const opsOk = eq(snapshot.operations, now.operations);
  console.log(`\n=== ${name} ===`);
  console.log(`piezas: ${partsOk ? "OK" : "DIFF"} (${now.parts.length}) | mecanizados: ${opsOk ? "OK" : "DIFF"} (${now.operations.length})`);
  console.log(`bounds snapshot: ${JSON.stringify(snapshot.bounds)}`);
  console.log(`bounds ahora   : ${JSON.stringify(now.bounds)}`);
  console.log(`issues snapshot: ${JSON.stringify(snapshot.issues)}`);
  console.log(`issues ahora   : ${JSON.stringify(now.issues)}`);
  console.log(`claves snapshot: ${Object.keys(snapshot).join(",")} | ahora: ${Object.keys(now).join(",")}`);

  if (!partsOk) {
    for (let index = 0; index < Math.max(snapshot.parts.length, now.parts.length); index++) {
      if (!eq(snapshot.parts[index], now.parts[index])) {
        console.log(`  pieza #${index}:`);
        console.log(`    snapshot: ${JSON.stringify(snapshot.parts[index])}`);
        console.log(`    ahora   : ${JSON.stringify(now.parts[index])}`);
        break;
      }
    }
  }
  if (!opsOk) {
    for (let index = 0; index < Math.max(snapshot.operations.length, now.operations.length); index++) {
      if (!eq(snapshot.operations[index], now.operations[index])) {
        console.log(`  operacion #${index}:`);
        console.log(`    snapshot: ${JSON.stringify(snapshot.operations[index])}`);
        console.log(`    ahora   : ${JSON.stringify(now.operations[index])}`);
        break;
      }
    }
  }
}
