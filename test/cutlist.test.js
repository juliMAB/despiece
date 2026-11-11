/**
 * Tests del despiece agrupado y su exportación.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { compileFurniture } from "../src/engine/compile.js";
import { buildCutlist, cutlistToCsv, summarize, ROLE_LABELS } from "../src/engine/cutlist.js";
import { ALACENA, COMODA } from "./fixtures/designs.mjs";

describe("lista de corte", () => {
  test("agrupa piezas iguales y cuenta cantidades", () => {
    const rows = buildCutlist(compileFurniture(ALACENA).parts);
    // laterales (2), estantes (2), fondo (1), puertas (2)
    assert.equal(rows.length, 4);

    const laterales = rows.find((row) => row.role === "vertical-side");
    assert.equal(laterales.quantity, 2);
    assert.equal(laterales.widthMm, 450);
    assert.equal(laterales.heightMm, 840);
    assert.equal(laterales.thicknessMm, 18);
    assert.equal(laterales.label, "Lateral");
  });

  test("las piezas del cajón no se mezclan con las estructurales", () => {
    const rows = buildCutlist(compileFurniture(COMODA).parts);
    const roles = new Set(rows.map((row) => row.role));
    assert.ok(roles.has("drawer-front"));
    assert.ok(roles.has("drawer-side"));
    assert.ok(roles.has("drawer-bottom"));
    assert.equal(rows.find((row) => row.role === "drawer-front").quantity, 3);
  });

  test("calcula superficie de cada línea", () => {
    const rows = buildCutlist(compileFurniture(ALACENA).parts);
    const puertas = rows.find((row) => row.role === "door-front");
    // 0,285 × 0,774 × 2
    assert.equal(Number(puertas.areaM2.toFixed(4)), 0.4412);
  });

  test("ordena con las piezas estructurales primero", () => {
    const rows = buildCutlist(compileFurniture(COMODA).parts);
    assert.equal(rows[0].role, "vertical-side");
    assert.equal(rows.at(-1).role, "drawer-bottom");
  });

  test("todas las piezas tienen etiqueta legible", () => {
    const rows = buildCutlist(compileFurniture(COMODA).parts);
    for (const row of rows) {
      assert.equal(row.label, ROLE_LABELS[row.role]);
      assert.ok(row.label.length > 0);
    }
  });
});

describe("exportación CSV", () => {
  const rows = buildCutlist(compileFurniture(ALACENA).parts);
  const csv = cutlistToCsv(rows);

  test("tiene encabezado y una línea por grupo", () => {
    const lines = csv.split("\r\n");
    assert.equal(lines.length, rows.length + 1);
    assert.equal(lines[0], "Pieza;Cantidad;Ancho (mm);Alto (mm);Espesor (mm);Superficie (m2)");
  });

  test("usa coma decimal y punto y coma como separador", () => {
    assert.ok(csv.includes("450"), "ancho del lateral");
    assert.ok(csv.includes("0,441"), "superficie con coma decimal");
    assert.ok(!csv.includes("450.0"), "no debe haber punto decimal");
  });

  test("se puede cambiar el separador", () => {
    const otro = cutlistToCsv(rows, { separator: ",", decimal: "." });
    assert.ok(otro.includes("Pieza,Cantidad"));
    assert.ok(otro.includes("0.441"));
  });
});

describe("resumen", () => {
  test("cuenta piezas, líneas y mecanizados", () => {
    const result = compileFurniture(ALACENA);
    const summary = summarize(result);
    assert.equal(summary.parts, 7);
    assert.equal(summary.cutRows, 4);
    assert.equal(summary.operations, 6);
    assert.equal(summary.modules, 1);
    assert.equal(summary.issues, 0);
    assert.equal(summary.width, 0.6);
  });

  test("la superficie total es la suma de piezas", () => {
    const result = compileFurniture(ALACENA);
    const esperado = result.parts.reduce(
      (total, part) => total + part.size.width * part.size.height,
      0,
    );
    assert.equal(Number(summarize(result).areaM2.toFixed(6)), Number(esperado.toFixed(6)));
  });
});
