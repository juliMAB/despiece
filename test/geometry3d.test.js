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
  multiplicarMatrices,
  matrizVista,
  matrizPerspectiva,
  transformarPunto,
  rotarPuntoY,
  rotarNormalY,
  transformacionesDeApertura,
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

/* ── matrices para WebGL ─────────────────────────────────────────────────── */

describe("matrices", () => {
  const IDENTIDAD = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  test("multiplicar por la identidad no cambia", () => {
    const resultado = multiplicarMatrices(IDENTIDAD, IDENTIDAD);
    assert.deepEqual([...resultado], [...IDENTIDAD]);
  });

  test("la matriz de vista lleva el ojo al origen", () => {
    const camara = crearCamara({
      target: { x: 0.2, y: 1, z: -0.1 },
      yaw: 0.5,
      pitch: 0.35,
      distance: 4,
      viewport: { width: 800, height: 400 },
    });
    const enCamara = transformarPunto(matrizVista(camara), camara.eye);
    assert.ok(Math.abs(enCamara.x) < 1e-6);
    assert.ok(Math.abs(enCamara.y) < 1e-6);
    assert.ok(Math.abs(enCamara.z) < 1e-6);
    assert.ok(Math.abs(enCamara.w - 1) < 1e-6);
  });

  test("la matriz de vista deja el objetivo delante de la cámara", () => {
    const camara = crearCamara({
      target: { x: 0, y: 0.5, z: 0 },
      yaw: 0.8,
      pitch: 0.4,
      distance: 3,
      viewport: { width: 800, height: 400 },
    });
    const objetivo = transformarPunto(matrizVista(camara), { x: 0, y: 0.5, z: 0 });
    assert.ok(Math.abs(objetivo.x) < 1e-6);
    assert.ok(Math.abs(objetivo.y) < 1e-6);
    assert.ok(objetivo.z < 0, "la cámara mira hacia -Z");
  });

  test("la proyección deja el objetivo en el centro de la pantalla", () => {
    const camara = crearCamara({
      target: { x: 0, y: 0.5, z: 0 },
      yaw: 0.7,
      pitch: 0.35,
      distance: 3,
      viewport: { width: 800, height: 400 },
    });
    const vista = matrizVista(camara);
    const proyeccion = matrizPerspectiva({ fovDeg: 38, aspect: 2, near: 0.01, far: 50 });
    const mvp = multiplicarMatrices(proyeccion, vista);
    const clip = transformarPunto(mvp, { x: 0, y: 0.5, z: 0 });
    assert.ok(Math.abs(clip.x / clip.w) < 1e-6);
    assert.ok(Math.abs(clip.y / clip.w) < 1e-6);
    assert.ok(clip.z / clip.w > -1 && clip.z / clip.w < 1);
  });
});

/* ── transformaciones de apertura ────────────────────────────────────────── */

describe("apertura de puertas y cajones", () => {
  test("rotar alrededor de un eje vertical", () => {
    // -90° manda el borde libre (+X) hacia adelante (+Z)
    const girado = rotarPuntoY({ x: 1, y: 0, z: 0 }, -Math.PI / 2, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(girado.x) < 1e-9);
    assert.ok(Math.abs(girado.z - 1) < 1e-9);
    // +90° lo manda hacia atrás
    const alReves = rotarPuntoY({ x: 1, y: 0, z: 0 }, Math.PI / 2, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(alReves.z + 1) < 1e-9);
  });

  test("el punto de la bisagra no se mueve", () => {
    const pivote = { x: -0.3, y: 0.5, z: 0.2 };
    const quieto = rotarPuntoY(pivote, -Math.PI / 2, pivote);
    assert.deepEqual(quieto, pivote);
  });

  test("las normales giran junto con la hoja", () => {
    const normal = rotarNormalY({ x: 0, y: 0, z: 1 }, -Math.PI / 2);
    assert.ok(Math.abs(normal.x + 1) < 1e-9);
    assert.ok(Math.abs(normal.z) < 1e-9);
  });

  test("cerrado no hay transformaciones", () => {
    const mapa = transformacionesDeApertura(
      [{ key: "a", role: "door-front", doorHinge: "left", position: { x: 0, y: 0, z: 0.2 }, size: { width: 0.3 } }],
      0,
    );
    assert.equal(mapa.size, 0);
  });

  test("una puerta con bisagra izquierda gira hacia afuera", () => {
    const puerta = {
      key: "puerta",
      role: "door-front",
      doorHinge: "left",
      position: { x: 0, y: 0.5, z: 0.22 },
      size: { width: 0.3 },
    };
    const mapa = transformacionesDeApertura([puerta], 1);
    const transformacion = mapa.get("puerta");
    assert.equal(transformacion.tipo, "giro");
    assert.ok(transformacion.angulo < 0);
    // el pivote queda en el borde izquierdo de la hoja
    assert.ok(Math.abs(transformacion.pivote.x + 0.15) < 1e-9);
  });

  test("las 5 piezas de un cajón avanzan juntas hacia adelante", () => {
    const piezas = [
      { key: "f", role: "drawer-front", sourceModuleId: "m1", drawerIndex: 0, size: { width: 0.5 } },
      { key: "l", role: "drawer-side", sourceModuleId: "m1", drawerIndex: 0, size: { width: 0.4 } },
      { key: "r", role: "drawer-side", sourceModuleId: "m1", drawerIndex: 0, size: { width: 0.4 } },
      { key: "b", role: "drawer-back", sourceModuleId: "m1", drawerIndex: 0, size: { width: 0.5 } },
      { key: "d", role: "drawer-bottom", sourceModuleId: "m1", drawerIndex: 0, size: { width: 0.4 } },
    ];
    const mapa = transformacionesDeApertura(piezas, 1);
    assert.equal(mapa.size, 5);
    const avance = mapa.get("f").delta.z;
    assert.ok(avance > 0.2 && avance < 0.5, `avance inesperado: ${avance}`);
    for (const pieza of piezas) {
      assert.ok(Math.abs(mapa.get(pieza.key).delta.z - avance) < 1e-9, "todos avanzan lo mismo");
    }
    // a mitad de apertura avanza la mitad
    const medio = transformacionesDeApertura(piezas, 0.5);
    assert.ok(Math.abs(medio.get("f").delta.z - avance / 2) < 1e-9);
  });
});
