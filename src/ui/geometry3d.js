/**
 * Geometría para el visor 3D (sin dependencias, testeable en Node).
 *
 * El motor entrega las piezas con posición y tamaño, pero cada medida puede
 * ir en distintos ejes según la orientación del panel. Acá se traducen a cajas
 * (ancho, alto y fondo en los ejes X, Y, Z) y se resuelve la cámara, la
 * proyección en perspectiva y el sombreado de caras.
 *
 * Convenciones del motor:
 *   - X: a lo ancho (centrado en 0)
 *   - Y: a lo alto (0 = piso)
 *   - Z: hacia el fondo (negativo atrás)
 *
 * `orientation` indica qué medida del panel va en qué eje:
 *   - vertical-yz   → width en Z, height en Y, thickness en X
 *   - horizontal-xz → width en X, height en Z, thickness en Y
 *   - vertical-xy   → width en X, height en Y, thickness en Z
 */

export const ARRIBA = Object.freeze({ x: 0, y: 1, z: 0 });

/** Convierte una pieza del motor en una caja alineada a los ejes. */
export function partToBox(part) {
  const { width, height, thickness } = part.size;
  let x;
  let y;
  let z;

  switch (part.orientation) {
    case "vertical-yz":
      x = thickness;
      y = height;
      z = width;
      break;
    case "horizontal-xz":
      x = width;
      y = thickness;
      z = height;
      break;
    case "vertical-xy":
    default:
      x = width;
      y = height;
      z = thickness;
      break;
  }

  return {
    key: part.key,
    role: part.role,
    center: { x: part.position.x, y: part.position.y, z: part.position.z },
    size: { x, y, z },
  };
}

/** Caja exterior que contiene a todas las cajas. */
export function boxesBounds(boxes) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const box of boxes) {
    for (const eje of ["x", "y", "z"]) {
      min[eje] = Math.min(min[eje], box.center[eje] - box.size[eje] / 2);
      max[eje] = Math.max(max[eje], box.center[eje] + box.size[eje] / 2);
    }
  }

  if (!Number.isFinite(min.x)) {
    return { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  }
  return { min, max };
}

/* ── vectores ────────────────────────────────────────────────────────────── */

export const sumar = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const restar = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const escalar = (v, factor) => ({ x: v.x * factor, y: v.y * factor, z: v.z * factor });
export const punto = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cruz = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export function normalizar(v) {
  const largo = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / largo, y: v.y / largo, z: v.z / largo };
}

/* ── cámara ──────────────────────────────────────────────────────────────── */

/**
 * Distancia necesaria para que un mueble de radio `radio` entre en cuadro.
 * @param {number} radio
 * @param {number} fovDeg
 * @param {number} zoom
 */
export function distanciaParaEncuadrar(radio, fovDeg = 38, zoom = 1) {
  const medio = (fovDeg * Math.PI) / 360;
  return (radio / Math.tan(medio)) * 1.12 / Math.max(0.05, zoom);
}

/**
 * Cámara en órbita alrededor de un objetivo.
 *
 * @param {{target: object, yaw: number, pitch: number, distance: number, viewport: {width:number,height:number}, fovDeg?: number}} opciones
 */
export function crearCamara({ target, yaw, pitch, distance, viewport, fovDeg = 38 }) {
  const direccion = {
    x: Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.cos(yaw),
  };
  const eye = sumar(target, escalar(direccion, distance));
  const forward = normalizar(escalar(direccion, -1));
  const right = normalizar(cruz(forward, ARRIBA));
  const up = cruz(right, forward);
  const focal = (viewport.height / 2) / Math.tan((fovDeg * Math.PI) / 360);

  return {
    eye,
    forward,
    right,
    up,
    focal,
    center: { x: viewport.width / 2, y: viewport.height / 2 },
    near: 0.02,
  };
}

/**
 * Proyecta un punto 3D a coordenadas de pantalla.
 * Devuelve null si el punto está detrás de la cámara.
 */
export function proyectarPunto(point, camara) {
  const v = restar(point, camara.eye);
  const profundidad = punto(v, camara.forward);
  if (profundidad < camara.near) return null;

  return {
    x: camara.center.x + (punto(v, camara.right) / profundidad) * camara.focal,
    y: camara.center.y - (punto(v, camara.up) / profundidad) * camara.focal,
    profundidad,
  };
}

/* ── caras y sombreado ───────────────────────────────────────────────────── */

/** Las 6 caras de una caja: normal y 4 vértices relativos (±1). */
export const CARAS = Object.freeze([
  { normal: { x: 1, y: 0, z: 0 }, vertices: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { normal: { x: -1, y: 0, z: 0 }, vertices: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { normal: { x: 0, y: 1, z: 0 }, vertices: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: { x: 0, y: -1, z: 0 }, vertices: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: { x: 0, y: 0, z: 1 }, vertices: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
  { normal: { x: 0, y: 0, z: -1 }, vertices: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
]);

/** Vértice del mundo para un vértice relativo de una caja. */
export function verticeDeCaja(box, relativo) {
  return {
    x: box.center.x + (relativo[0] * box.size.x) / 2,
    y: box.center.y + (relativo[1] * box.size.y) / 2,
    z: box.center.z + (relativo[2] * box.size.z) / 2,
  };
}

/** Centro de una cara de la caja. */
export function centroDeCara(box, normal) {
  return {
    x: box.center.x + (normal.x * box.size.x) / 2,
    y: box.center.y + (normal.y * box.size.y) / 2,
    z: box.center.z + (normal.z * box.size.z) / 2,
  };
}

/** Indica si la cara mira hacia la cámara. */
export function caraVisible(box, cara, ojo) {
  const centro = centroDeCara(box, cara.normal);
  return punto(cara.normal, restar(ojo, centro)) > 0;
}

/** Luz fija: desde arriba, algo de frente y de costado. */
export const LUZ = Object.freeze(
  (() => {
    const v = { x: 0.35, y: 0.9, z: 0.42 };
    const largo = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / largo, y: v.y / largo, z: v.z / largo };
  })(),
);

/**
 * Intensidad de sombreado de una cara (0.5 a 1). Las caras que miran a la luz
 * se ven más claras; las que miran al piso, más oscuras.
 */
export function intensidadSombra(normal) {
  return 0.5 + 0.5 * Math.max(0, punto(normal, LUZ));
}

/** Convierte un color hex "#rrggbb" a componentes. */
export function hexARgb(hex) {
  const n = Number.parseInt(String(hex).replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Aplica sombreado a un color y devuelve "rgb(...)". */
export function colorSombreado(hex, intensidad) {
  const { r, g, b } = hexARgb(hex);
  const aplicar = (valor) => Math.min(255, Math.max(0, Math.round(valor * intensidad)));
  return `rgb(${aplicar(r)}, ${aplicar(g)}, ${aplicar(b)})`;
}

/* ── matrices 4×4 en column-major (formato de WebGL) ─────────────────────── */

/**
 * Multiplica dos matrices 4×4 en column-major: resultado = a × b.
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 */
export function multiplicarMatrices(a, b) {
  const salida = new Float32Array(16);
  for (let columna = 0; columna < 4; columna++) {
    for (let fila = 0; fila < 4; fila++) {
      let suma = 0;
      for (let k = 0; k < 4; k++) suma += a[k * 4 + fila] * b[columna * 4 + k];
      salida[columna * 4 + fila] = suma;
    }
  }
  return salida;
}

/**
 * Matriz de vista: lleva el mundo al espacio de la cámara
 * (la cámara mira hacia -Z).
 */
export function matrizVista(camara) {
  const { eye, right, up, forward } = camara;
  return new Float32Array([
    right.x, up.x, -forward.x, 0,
    right.y, up.y, -forward.y, 0,
    right.z, up.z, -forward.z, 0,
    -punto(right, eye), -punto(up, eye), punto(forward, eye), 1,
  ]);
}

/** Matriz de proyección en perspectiva. */
export function matrizPerspectiva({ fovDeg = 38, aspect = 1, near = 0.005, far = 100 }) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const rango = far / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, rango, -1,
    0, 0, rango * near, 0,
  ]);
}

/** Aplica una matriz 4×4 a un punto (devuelve coordenadas homogéneas). */
export function transformarPunto(m, p) {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    w: m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  };
}
