/**
 * Tests de la comparación de piezas (base del resaltado del modo agente).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { clavesCambiadas, cambioMasivo } from "../src/app/diff.js";
import { compileFurniture } from "../src/engine/compile.js";
import { proyectoDesdePlantilla } from "../src/app/design.js";
import { TEMPLATES } from "../templates/index.js";

const pieza = (clave, extra = {}) => ({
  key: clave,
  role: "horizontal-deck",
  position: { x: 0, y: 0, z: 0, ...(extra.position ?? {}) },
  size: { width: 0.5, height: 0.02, thickness: 0.45, ...(extra.size ?? {}) },
});

test("sin cambios no devuelve nada", () => {
  const partes = [pieza("a"), pieza("b")];
  assert.deepEqual(clavesCambiadas(partes, partes), []);
});

test("detecta una pieza movida", () => {
  const antes = [pieza("a"), pieza("b")];
  const despues = [pieza("a"), pieza("b", { position: { y: 0.3 } })];
  assert.deepEqual(clavesCambiadas(antes, despues), ["b"]);
});

test("detecta una pieza redimensionada", () => {
  const antes = [pieza("a")];
  const despues = [pieza("a", { size: { width: 0.9 } })];
  assert.deepEqual(clavesCambiadas(antes, despues), ["a"]);
});

test("detecta piezas nuevas y quitadas", () => {
  const antes = [pieza("a"), pieza("b")];
  const despues = [pieza("a"), pieza("c")];
  assert.deepEqual(clavesCambiadas(antes, despues).sort(), ["b", "c"]);
});

test("si cambia el rol, cuenta como cambio", () => {
  const antes = [pieza("a")];
  const despues = [{ ...pieza("a"), role: "vertical-side" }];
  assert.deepEqual(clavesCambiadas(antes, despues), ["a"]);
});

test("con el motor: cambiar el ancho de una columna resalta piezas", () => {
  const proyecto = proyectoDesdePlantilla(TEMPLATES[0]);
  const antes = compileFurniture(proyecto.design).parts;

  const design = structuredClone(proyecto.design);
  design.columns[0].width = 0.9;
  const despues = compileFurniture(design).parts;

  const cambiadas = clavesCambiadas(antes, despues);
  assert.ok(cambiadas.length > 0);
  for (const clave of cambiadas) {
    assert.ok(despues.some((parte) => parte.key === clave) || antes.some((parte) => parte.key === clave));
  }
});

test("cambioMasivo detecta cuando se tocó casi todo", () => {
  assert.equal(cambioMasivo(["a"], 10), false);
  assert.equal(cambioMasivo(Array.from({ length: 8 }, (_, i) => "k" + i), 10), true);
  assert.equal(cambioMasivo([], 0), false);
  assert.equal(cambioMasivo(null, 10), false);
});
