/**
 * Tests del motor de despiece.
 *
 * Los snapshots son la salida congelada del motor: el motor fue validado
 * pieza por pieza contra el motor original (dev/compare-oracle.mjs), así que
 * si un cambio rompe una medida, estos tests lo detectan.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileFurniture, computeCells } from "../src/engine/compile.js";
import { DEFAULT_CONFIG } from "../src/engine/config.js";
import { ALACENA, COMODA, CONFIG_PERSONALIZADA, DESIGNS, INVALIDO } from "./fixtures/designs.mjs";

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__");
const snapshotOf = (name) => JSON.parse(readFileSync(join(snapshotsDir, `${name}.json`), "utf8"));

const byRole = (parts, role) => parts.filter((part) => part.role === role);

/* ──────────────────────────────────────────────────────────────────────────
 * Snapshots: cualquier cambio de medida tiene que ser deliberado
 * ──────────────────────────────────────────────────────────────────────── */

describe("snapshots", () => {
  for (const [name, design] of Object.entries(DESIGNS)) {
    test(`${name}: igual al snapshot`, () => {
      assert.deepEqual(compileFurniture(design), snapshotOf(name));
    });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Medidas calculadas a mano (una alacena de 0,60 × 0,80, placa de 18 mm)
 * ──────────────────────────────────────────────────────────────────────── */

describe("alacena de 0,60 × 0,80", () => {
  const result = compileFurniture(ALACENA);
  const config = DEFAULT_CONFIG;

  test("medidas exteriores", () => {
    assert.deepEqual(result.bounds, { width: 0.6, height: 0.84, depth: 0.45 });
  });

  test("laterales: profundidad × (alto + voladizo)", () => {
    const sides = byRole(result.parts, "vertical-side");
    assert.equal(sides.length, 2);
    for (const side of sides) {
      assert.equal(side.size.width, 0.45); // profundidad
      assert.equal(side.size.height, 0.84); // 0,80 + 2 × 0,02
      assert.equal(side.size.thickness, 0.018);
      assert.equal(side.orientation, "vertical-yz");
      // el lateral se centra en el alto de la columna y después sube el voladizo
      assert.equal(side.position.y, 0.42);
    }
  });

  test("estantes: ancho de columna menos placa y luces", () => {
    const decks = byRole(result.parts, "horizontal-deck");
    assert.equal(decks.length, 2);
    // 0,60 − 0,018 − 2 × 0,002
    assert.equal(decks[0].size.width, 0.578);
    // profundidad + medio voladizo
    assert.equal(decks[0].size.height, 0.45 + config.sidePanelOverhang / 2);
  });

  test("fondo: celda interior más media ranura de cada lado", () => {
    const [back] = byRole(result.parts, "back-panel");
    // celda: 0,578 × 0,778 → + 2 × (0,018 × 0,25)
    assert.equal(back.size.width, 0.587);
    assert.equal(back.size.height, 0.787);
    assert.equal(back.size.thickness, 0.004);
  });

  test("puertas: dos hojas iguales con su luz en el medio", () => {
    const doors = byRole(result.parts, "door-front");
    assert.equal(doors.length, 2);
    for (const door of doors) {
      // (frente interior − 2 × luz) / 2 = (0,574 − 0,004) / 2
      assert.equal(door.size.width, 0.285);
      assert.equal(door.size.height, 0.774);
    }
    assert.ok(doors[0].position.x < 0 && doors[1].position.x > 0, "una hoja a cada lado");
  });

  test("un tirador por hoja, de Ø 25 mm", () => {
    const holes = result.operations.filter((op) => op.operationType === "through-hole");
    assert.equal(holes.length, 2);
    for (const hole of holes) {
      assert.equal(hole.diameter, 0.025);
      assert.equal(hole.face, "front");
      assert.equal(hole.through, true);
    }
  });

  test("cuatro ranuras de fondo (2 laterales + 2 estantes)", () => {
    const rails = result.operations.filter((op) => op.operationType === "rail-cut");
    assert.equal(rails.length, 4);
    const targets = rails.map((op) => op.targetPanelKey).sort();
    assert.deepEqual(targets, ["horizontal:0:0", "horizontal:0:1", "vertical:0", "vertical:1"]);
  });

  test("no hay avisos", () => {
    assert.deepEqual(result.issues, []);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Cómoda con 3 cajones
 * ──────────────────────────────────────────────────────────────────────── */

describe("cómoda con 3 cajones", () => {
  const result = compileFurniture(COMODA);
  const config = DEFAULT_CONFIG;

  test("cantidad de piezas", () => {
    // 2 laterales + 2 estantes + 1 fondo + 3 × (frente + 2 laterales + trasera + fondo)
    assert.equal(result.parts.length, 20);
    assert.equal(byRole(result.parts, "drawer-front").length, 3);
    assert.equal(byRole(result.parts, "drawer-side").length, 6);
    assert.equal(byRole(result.parts, "drawer-bottom").length, 3);
  });

  test("alto del frente de cada cajón", () => {
    const cellHeight = 0.75 - config.panelThickness - 2 * config.panelJointClearance; // 0,728
    const expected = (cellHeight - config.frontClearance * 4) / 3; // 0,24
    for (const front of byRole(result.parts, "drawer-front")) {
      assert.equal(front.size.height, Math.round(expected * 1000) / 1000);
    }
  });

  test("seis perforaciones: dos por cajón", () => {
    assert.equal(result.operations.filter((op) => op.operationType === "through-hole").length, 6);
  });

  test("la caja del cajón respeta la reserva de corredera", () => {
    const side = byRole(result.parts, "drawer-side")[0];
    // profundidad de celda = profundidad − luces − retiro y espesor del fondo
    const cellDepth =
      config.depth - 2 * config.panelJointClearance - config.backPanelInset - config.backPanelThickness;
    // el lateral del cajón descuenta la reserva de corredera y las dos placas
    const expected =
      cellDepth - config.drawerSlidesReserve - 2 * config.panelThickness - 2 * config.panelJointClearance;
    assert.equal(side.size.width, Math.round(expected * 1000) / 1000);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Configuración personalizada
 * ──────────────────────────────────────────────────────────────────────── */

describe("configuración personalizada", () => {
  const result = compileFurniture(CONFIG_PERSONALIZADA);

  test("respeta espesores, profundidad y voladizo", () => {
    const [side] = byRole(result.parts, "vertical-side");
    assert.equal(side.size.thickness, 0.025);
    assert.equal(side.size.height, 0.96); // 0,90 + 2 × 0,03
    assert.equal(side.size.width, 0.6); // profundidad configurada
    assert.equal(result.bounds.depth, 0.6);

    const [back] = byRole(result.parts, "back-panel");
    assert.equal(back.size.thickness, 0.006);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Validaciones
 * ──────────────────────────────────────────────────────────────────────── */

describe("validaciones", () => {
  test("cajones que no entran generan aviso", () => {
    const result = compileFurniture(INVALIDO);
    const codes = result.issues.map((item) => item.code);
    assert.ok(codes.includes("drawer-band-too-short"), `avisos: ${codes.join(", ")}`);
    assert.ok(result.issues.every((item) => item.severity === "error"));
  });

  test("un diseño descabellado también avisa", () => {
    const result = compileFurniture({
      columns: [{ width: 0.2, modules: [{ id: "x", type: "doors", height: 2.5 }] }],
      config: { depth: 0.05, backPanelInset: 0.03, backPanelThickness: 0.03 },
    });
    assert.ok(result.issues.length > 0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Contrato del motor
 * ──────────────────────────────────────────────────────────────────────── */

describe("contrato", () => {
  test("un diseño vacío devuelve estructura válida", () => {
    const result = compileFurniture({ columns: [] });
    assert.deepEqual(result.parts, []);
    assert.deepEqual(result.operations, []);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.bounds, { width: 0, height: 0, depth: DEFAULT_CONFIG.depth });
  });

  test("no muta la entrada", () => {
    const design = structuredClone(ALACENA);
    compileFurniture(design);
    assert.deepEqual(design, ALACENA);
  });

  test("las piezas tienen las claves esperadas", () => {
    const result = compileFurniture(ALACENA);
    for (const part of result.parts) {
      assert.equal(part.kind, "panel");
      assert.equal(typeof part.key, "string");
      assert.ok(["vertical-side", "horizontal-deck", "back-panel", "door-front"].includes(part.role));
      assert.equal(typeof part.position.x, "number");
      assert.equal(typeof part.size.width, "number");
      assert.ok(["vertical-yz", "vertical-xy", "horizontal-xz"].includes(part.orientation));
    }
    for (const op of result.operations) {
      assert.equal(op.kind, "operation");
      assert.ok(["through-hole", "rail-cut"].includes(op.operationType));
      assert.ok(partByKey(result.parts, op.targetPanelKey), `target inexistente: ${op.targetPanelKey}`);
    }
  });

  test("computeCells coincide con lo que usa el motor", () => {
    const cells = computeCells(ALACENA.columns, DEFAULT_CONFIG);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].length, 1);
    assert.equal(cells[0][0].width, 0.578);
    assert.equal(cells[0][0].height, 0.778);
  });
});

function partByKey(parts, key) {
  return parts.find((part) => part.key === key);
}
