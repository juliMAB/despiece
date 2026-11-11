/**
 * Regenera los snapshots de los tests.
 *
 * Los snapshots son la salida congelada del motor para los diseños de prueba
 * propios. El motor fue validado pieza por pieza contra el motor original
 * (ver dev/compare-oracle.mjs), así que congelar su salida es una garantía de
 * que un cambio futuro no altere medidas sin querer.
 *
 * Uso: node dev/update-snapshots.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFurniture } from "../src/engine/compile.js";
import { DESIGNS } from "../test/fixtures/designs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = join(here, "..", "test", "__snapshots__");
mkdirSync(snapshotsDir, { recursive: true });

for (const [name, design] of Object.entries(DESIGNS)) {
  const result = compileFurniture(design);
  const file = join(snapshotsDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1) + "\n", "utf8");
  console.log(
    `✔ ${name.padEnd(22)} ${result.parts.length} piezas, ${result.operations.length} mecanizados, ${result.issues.length} avisos`,
  );
}
