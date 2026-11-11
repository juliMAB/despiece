/**
 * Tests de la geometría del visor 3D (puros, sin DOM).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  partToBox,
  boxesBounds,
  crearCamara,
  proyectarPunto,
  distanciaParaEncuadrar,
  CARAS,
  caraVisible,
  centroDeCara,
  verticeDeCaja,
  intensidadSombra,
  colorSombreado,
  normalizar,
  punto,
  restar,
} from "../src/ui/geometry3d.js";

/* ── traducción de piezas a cajas ────────────────────────────────────────── */

describe("piezas a cajas", () => {
  const base = (orientation, size) => ({
    key: "k",
    role: "vertical-side",
    orientation,
    position: { x: 0, y: 0.5, z: 0 },
    size,
  });

  test("vertical-yz: ancho va en Z y espesor en X", () => {
    const caja = partToBox(base("vertical-yz", { width: 0.55, height: 1.8, thickness: 0.018 }));
    assert.equal(caja.size.x, 0.018);
    assert.equal(caja.size.y, 1.8);
    assert.equal(caja.size.z, 0.55);
  });

  test("horizontal-xz: ancho en X y alto en Z", () => {
    const caja = partToBox(base("horizontal-xz", { width: 0.58, height: 0.46, thickness: 0.018 }));
    assert.equal(caja.size.x, 0.58);
    assert.equal(caja.size.y, 0.018);
    assert.equal(caja.size.z, 0.46);
  });

  test("vertical-xy: ancho en X, alto en Y y espesor en Z", () => {
    const caja = partToBox(base("vertical-xy", { width: 0.285, height: 0.774, thickness: 0.018 }));
    assert.equal(caja.size.x, 0.285);
    assert.equal(caja.size.y, 0.774);
    assert.equal(caja.size.z, 0.018);
  });

  test("conserva posición y rol", () => {
    const caja = partToBox(base("vertical-xy", { width: 0.2, height: 0.3, thickness: 0.01 }));
    assert.deepEqual(caja.center, { x: 0, y: 0.5, z: 0 });
    assert.equal(caja.role, "vertical-side");
  });

  test("una orientación desconocida no rompe", () => {
    const caja = partToBox(base("rara", { width: 0.2, height: 0.3, thickness: 0.01 }));
    assert.deepEqual(caja.size, { x: 0.2, y: 0.3, z: 0.01 });
  });
});

/* ── caja contenedora ────────────────────────────────────────────────────── */

describe("caja contenedora", () => {
  test("calcula el volumen exterior de las piezas", () => {
    const cajas = [
      { center: { x: -0.3, y: 0.5, z: 0 }, size: { x: 0.02, y: 1, z: 0.45 } },
      { center: { x: 0.3, y: 0.5, z: 0 }, size: { x: 0.02, y: 1, z: 0.45 } },
    ];
    const { min, max } = boxesBounds(cajas);
    assert.equal(min.x, -0.31);
    assert.equal(max.x, 0.31);
    assert.equal(max.y, 1);
    assert.equal(max.z, 0.225);
  });

  test("sin cajas devuelve un volumen por defecto", () => {
    const { min, max } = boxesBounds([]);
    assert.equal(min.x, -1);
    assert.equal(max.y, 1);
  });
});

/* ── cámara y proyección ─────────────────────────────────────────────────── */

describe("cámara", () => {
  test("mira hacia el objetivo", () => {
    const camara = crearCamara({
      target: { x: 0, y: 1, z: 0 },
      yaw: 0.6,
      pitch: 0.4,
      distance: 4,
      viewport: { width: 800, height: 400 },
    });
    const haciaObjetivo = normalizar(restar({ x: 0, y: 1, z: 0 }, camara.eye));
    assert.ok(punto(haciaObjetivo, camara.forward) > 0.999);
  });

  test("la base es ortonormal", () => {
    const camara = crearCamara({
      target: { x: 0, y: 0, z: 0 },
      yaw: 1.1,
      pitch: 0.3,
      distance: 3,
      viewport: { width: 800, height: 400 },
    });
    for (const [a, b] of [
      [camara.forward, camara.right],
      [camara.forward, camara.up],
      [camara.right, camara.up],
    ]) {
      assert.ok(Math.abs(punto(a, b)) < 1e-9);
    }
  });

  test("el objetivo se proyecta en el centro", () => {
    const camara = crearCamara({
      target: { x: 0.2, y: 1, z: -0.1 },
      yaw: 0.5,
      pitch: 0.35,
      distance: 4,
      viewport: { width: 800, height: 400 },
    });
    const proyectado = proyectarPunto({ x: 0.2, y: 1, z: -0.1 }, camara);
    assert.ok(Math.abs(proyectado.x - 400) < 1e-6);
    assert.ok(Math.abs(proyectado.y - 200) < 1e-6);
  });

  test("un punto detrás de la cámara no se proyecta", () => {
    const camara = crearCamara({
      target: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      distance: 2,
      viewport: { width: 800, height: 400 },
    });
    assert.equal(proyectarPunto({ x: 0, y: 0, z: 10 }, camara), null);
  });

  test("el zoom acerca la cámara", () => {
    const cerca = distanciaParaEncuadrar(1, 38, 2);
    const lejos = distanciaParaEncuadrar(1, 38, 1);
    assert.ok(cerca < lejos);
  });
});

/* ── caras y sombreado ───────────────────────────────────────────────────── */

describe("caras", () => {
  const caja = {
    center: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
  };
  const caraFrontal = CARAS.find((cara) => cara.normal.z === 1);
  const caraTrasera = CARAS.find((cara) => cara.normal.z === -1);

  test("se ve la cara que mira a la cámara", () => {
    assert.equal(caraVisible(caja, caraFrontal, { x: 0, y: 0, z: 5 }), true);
    assert.equal(caraVisible(caja, caraTrasera, { x: 0, y: 0, z: 5 }), false);
  });

  test("el centro de cara queda sobre el borde", () => {
    const centro = centroDeCara(caja, caraFrontal.normal);
    assert.deepEqual(centro, { x: 0, y: 0, z: 0.5 });
  });

  test("los vértices respetan el tamaño de la caja", () => {
    const vertice = verticeDeCaja(caja, [1, 1, 1]);
    assert.deepEqual(vertice, { x: 0.5, y: 0.5, z: 0.5 });
  });

  test("la cara de arriba se ilumina más que la de abajo", () => {
    const arriba = CARAS.find((cara) => cara.normal.y === 1);
    const abajo = CARAS.find((cara) => cara.normal.y === -1);
    assert.ok(intensidadSombra(arriba.normal) > intensidadSombra(abajo.normal));
    assert.ok(intensidadSombra(abajo.normal) >= 0.5);
    assert.ok(intensidadSombra(arriba.normal) <= 1);
  });

  test("el color sombreado respeta el rango", () => {
    const color = colorSombreado("#f59e0b", 0.5);
    assert.match(color, /^rgb\(\d+, \d+, \d+\)$/);
    const [r, g, b] = color.match(/\d+/g).map(Number);
    assert.ok(r <= 255 && g <= 255 && b <= 255);
    assert.ok(r < 245 || g < 158 || b < 11, "el sombreado oscurece el color base");
  });
});
