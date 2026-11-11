/**
 * Visor 3D del mueble.
 *
 * Usa **WebGL 2 con z-buffer real** (depth test), así las piezas se ocluyen
 * correctamente desde cualquier ángulo: no hay artefactos de ordenamiento.
 * Si el navegador no tiene WebGL 2, cae a un renderer 2D por software (más
 * lento y con ordenamiento aproximado) para que la app siga funcionando.
 *
 * Interacción:
 *   - arrastrar: rotar
 *   - rueda: zoom
 *   - doble click: volver a la vista inicial
 */

import {
  partToBox,
  boxesBounds,
  crearCamara,
  proyectarPunto,
  distanciaParaEncuadrar,
  CARAS,
  verticeDeCaja,
  caraVisible,
  intensidadSombra,
  colorSombreado,
  hexARgb,
  matrizVista,
  matrizPerspectiva,
  multiplicarMatrices,
  LUZ,
} from "./geometry3d.js";

/** Paleta por tipo de pieza: cada rol se distingue de un vistazo. */
export const PALETA_3D = Object.freeze({
  "vertical-side": "#3b82f6", // azul
  "horizontal-deck": "#22c55e", // verde
  "back-panel": "#94a3b8", // gris azulado
  "door-front": "#f59e0b", // ámbar
  "drawer-front": "#fbbf24", // ámbar claro
  "drawer-side": "#f97316", // naranja
  "drawer-back": "#ea580c",
  "drawer-bottom": "#c2410c",
  group: "#8a8580",
});

const ROLES_FRENTE = new Set(["door-front", "drawer-front"]);
const FOV = 38;
const VISTA_INICIAL = Object.freeze({ yaw: 0.62, pitch: 0.42, zoom: 1 });

const parteVisible = (parte, mostrarFrentes) =>
  mostrarFrentes || !ROLES_FRENTE.has(parte.role);

/** Cajas a dibujar, según si se muestran los frentes o no. */
function cajasVisibles(estado) {
  return estado.partes
    .filter((parte) => parteVisible(parte, estado.mostrarFrentes))
    .map(partToBox);
}

/** Datos de cámara para el estado actual. */
function cámaraActual(estado, cajas, ancho, alto) {
  const { min, max } = boxesBounds(cajas);
  const target = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
  const radio = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2 || 1;
  const camara = crearCamara({
    target,
    yaw: estado.yaw,
    pitch: estado.pitch,
    distance: distanciaParaEncuadrar(radio, FOV, estado.zoom),
    viewport: { width: ancho, height: alto },
    fovDeg: FOV,
  });
  return { camara, target, radio, min, max };
}

/* ── backend WebGL 2 (z-buffer real) ─────────────────────────────────────── */

const VERTICE_SOLIDO = `#version 300 es
in vec3 aPosicion;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uMVP;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uMVP * vec4(aPosicion, 1.0);
}`;

const FRAGMENTO_SOLIDO = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vColor;
out vec4 salida;
uniform vec3 uLuz;
void main() {
  vec3 normal = normalize(vNormal);
  float difusa = max(dot(normal, uLuz), 0.0);
  float luz = 0.54 + 0.46 * difusa;
  salida = vec4(vColor * luz, 1.0);
}`;

const VERTICE_LINEAS = `#version 300 es
in vec3 aPosicion;
uniform mat4 uMVP;
void main() {
  gl_Position = uMVP * vec4(aPosicion, 1.0);
}`;

const FRAGMENTO_LINEAS = `#version 300 es
precision mediump float;
out vec4 salida;
uniform vec4 uColor;
void main() {
  salida = uColor;
}`;

function compilar(gl, tipo, fuente) {
  const shader = gl.createShader(tipo);
  gl.shaderSource(shader, fuente);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader: " + error);
  }
  return shader;
}

function crearPrograma(gl, fuenteVertice, fuenteFragmento) {
  const programa = gl.createProgram();
  const vertice = compilar(gl, gl.VERTEX_SHADER, fuenteVertice);
  const fragmento = compilar(gl, gl.FRAGMENT_SHADER, fuenteFragmento);
  gl.attachShader(programa, vertice);
  gl.attachShader(programa, fragmento);
  gl.linkProgram(programa);
  if (!gl.getProgramParameter(programa, gl.LINK_STATUS)) {
    throw new Error("Programa: " + gl.getProgramInfoLog(programa));
  }
  return programa;
}

function crearBackendWebGL(canvas, gl) {
  const programaLleno = crearPrograma(gl, VERTICE_SOLIDO, FRAGMENTO_SOLIDO);
  const programaLineas = crearPrograma(gl, VERTICE_LINEAS, FRAGMENTO_LINEAS);

  const atributosLleno = {
    posicion: gl.getAttribLocation(programaLleno, "aPosicion"),
    normal: gl.getAttribLocation(programaLleno, "aNormal"),
    color: gl.getAttribLocation(programaLleno, "aColor"),
  };
  const uniformesLleno = {
    mvp: gl.getUniformLocation(programaLleno, "uMVP"),
    luz: gl.getUniformLocation(programaLleno, "uLuz"),
  };
  const atributosLineas = {
    posicion: gl.getAttribLocation(programaLineas, "aPosicion"),
  };
  const uniformesLineas = {
    mvp: gl.getUniformLocation(programaLineas, "uMVP"),
    color: gl.getUniformLocation(programaLineas, "uColor"),
  };

  const bufferPosiciones = gl.createBuffer();
  const bufferNormales = gl.createBuffer();
  const bufferColores = gl.createBuffer();
  const bufferLineas = gl.createBuffer();
  let cantidadVertices = 0;
  let cantidadLineas = 0;
  let sucio = true;

  function reconstruir(estado) {
    const cajas = cajasVisibles(estado);
    const posiciones = [];
    const normales = [];
    const colores = [];

    for (const caja of cajas) {
      const rgb = hexARgb(PALETA_3D[caja.role] ?? PALETA_3D.group);
      const color = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
      for (const cara of CARAS) {
        const vertices = cara.vertices.map((relativo) => verticeDeCaja(caja, relativo));
        for (const orden of [[0, 1, 2], [0, 2, 3]]) {
          for (const indice of orden) {
            posiciones.push(vertices[indice].x, vertices[indice].y, vertices[indice].z);
            normales.push(cara.normal.x, cara.normal.y, cara.normal.z);
            colores.push(color[0], color[1], color[2]);
          }
        }
      }
    }

    cantidadVertices = posiciones.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferPosiciones);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posiciones), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferNormales);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normales), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferColores);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colores), gl.STATIC_DRAW);

    // Grilla del piso
    const { min, max } = boxesBounds(cajas);
    const radio = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2 || 1;
    const paso = radio > 1.2 ? 0.4 : 0.2;
    const desdeX = Math.floor(min.x / paso) * paso;
    const hastaX = Math.ceil(max.x / paso) * paso;
    const desdeZ = Math.floor(min.z / paso) * paso;
    const hastaZ = Math.ceil(max.z / paso) * paso;
    const lineas = [];
    for (let x = desdeX; x <= hastaX + 1e-9; x += paso) {
      lineas.push(x, 0, desdeZ, x, 0, hastaZ);
    }
    for (let z = desdeZ; z <= hastaZ + 1e-9; z += paso) {
      lineas.push(desdeX, 0, z, hastaX, 0, z);
    }
    cantidadLineas = lineas.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferLineas);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineas), gl.STATIC_DRAW);

    sucio = false;
  }

  function dibujar(estado) {
    const dpr = window.devicePixelRatio || 1;
    const ancho = canvas.clientWidth || 640;
    const alto = canvas.clientHeight || 360;
    if (ancho === 0 || alto === 0) return;

    const anchoPx = Math.round(ancho * dpr);
    const altoPx = Math.round(alto * dpr);
    if (canvas.width !== anchoPx || canvas.height !== altoPx) {
      canvas.width = anchoPx;
      canvas.height = altoPx;
    }
    gl.viewport(0, 0, anchoPx, altoPx);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cajas = cajasVisibles(estado);
    if (cajas.length === 0) return;
    if (sucio) reconstruir(estado);

    const { camara } = cámaraActual(estado, cajas, ancho, alto);
    const vista = matrizVista(camara);
    const proyeccion = matrizPerspectiva({
      fovDeg: FOV,
      aspect: ancho / alto,
      near: 0.005,
      far: 100,
    });
    const mvp = multiplicarMatrices(proyeccion, vista);

    // Sólidos
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(programaLleno);
    gl.uniformMatrix4fv(uniformesLleno.mvp, false, mvp);
    gl.uniform3fv(uniformesLleno.luz, new Float32Array([LUZ.x, LUZ.y, LUZ.z]));

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferPosiciones);
    gl.enableVertexAttribArray(atributosLleno.posicion);
    gl.vertexAttribPointer(atributosLleno.posicion, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferNormales);
    gl.enableVertexAttribArray(atributosLleno.normal);
    gl.vertexAttribPointer(atributosLleno.normal, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferColores);
    gl.enableVertexAttribArray(atributosLleno.color);
    gl.vertexAttribPointer(atributosLleno.color, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, cantidadVertices);

    // Grilla (con profundidad, para que el mueble la tape)
    gl.useProgram(programaLineas);
    gl.uniformMatrix4fv(uniformesLineas.mvp, false, mvp);
    gl.uniform4fv(uniformesLineas.color, new Float32Array([0.62, 0.6, 0.58, 0.22]));
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferLineas);
    gl.enableVertexAttribArray(atributosLineas.posicion);
    gl.vertexAttribPointer(atributosLineas.posicion, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, cantidadLineas);
  }

  return {
    dibujar,
    marcarSucio() {
      sucio = true;
    },
    destruir() {
      gl.deleteBuffer(bufferPosiciones);
      gl.deleteBuffer(bufferNormales);
      gl.deleteBuffer(bufferColores);
      gl.deleteBuffer(bufferLineas);
      gl.deleteProgram(programaLleno);
      gl.deleteProgram(programaLineas);
    },
  };
}

/* ── backend de respaldo (canvas 2D, sin WebGL) ──────────────────────────── */

function crearBackendCanvas2D(canvas) {
  const contexto = canvas.getContext("2d");

  function dibujar(estado) {
    const dpr = window.devicePixelRatio || 1;
    const ancho = canvas.clientWidth || 640;
    const alto = canvas.clientHeight || 360;
    if (ancho === 0 || alto === 0) return;

    canvas.width = Math.round(ancho * dpr);
    canvas.height = Math.round(alto * dpr);
    contexto.setTransform(dpr, 0, 0, dpr, 0, 0);
    contexto.clearRect(0, 0, ancho, alto);

    const cajas = cajasVisibles(estado);
    if (cajas.length === 0) return;

    const { camara, min, max, radio } = cámaraActual(estado, cajas, ancho, alto);

    // grilla
    const paso = radio > 1.2 ? 0.4 : 0.2;
    contexto.strokeStyle = "rgba(168, 162, 158, 0.16)";
    contexto.lineWidth = 1;
    const trazar = (a, b) => {
      const inicio = proyectarPunto(a, camara);
      const fin = proyectarPunto(b, camara);
      if (!inicio || !fin) return;
      contexto.beginPath();
      contexto.moveTo(inicio.x, inicio.y);
      contexto.lineTo(fin.x, fin.y);
      contexto.stroke();
    };
    const desdeX = Math.floor(min.x / paso) * paso;
    const hastaX = Math.ceil(max.x / paso) * paso;
    const desdeZ = Math.floor(min.z / paso) * paso;
    const hastaZ = Math.ceil(max.z / paso) * paso;
    for (let x = desdeX; x <= hastaX + 1e-9; x += paso) trazar({ x, y: 0, z: desdeZ }, { x, y: 0, z: hastaZ });
    for (let z = desdeZ; z <= hastaZ + 1e-9; z += paso) trazar({ x: desdeX, y: 0, z }, { x: hastaX, y: 0, z });

    // caras ordenadas por profundidad
    const caras = [];
    for (const caja of cajas) {
      const colorBase = PALETA_3D[caja.role] ?? PALETA_3D.group;
      for (const cara of CARAS) {
        if (!caraVisible(caja, cara, camara.eye)) continue;
        const puntos = [];
        let profundidad = 0;
        let fuera = false;
        for (const relativo of cara.vertices) {
          const proyectado = proyectarPunto(verticeDeCaja(caja, relativo), camara);
          if (!proyectado) {
            fuera = true;
            break;
          }
          puntos.push(proyectado);
          profundidad += proyectado.profundidad;
        }
        if (fuera || puntos.length !== 4) continue;
        caras.push({
          puntos,
          profundidad: profundidad / 4,
          relleno: colorSombreado(colorBase, intensidadSombra(cara.normal)),
        });
      }
    }
    caras.sort((a, b) => b.profundidad - a.profundidad);

    contexto.lineJoin = "round";
    contexto.lineWidth = 1;
    contexto.strokeStyle = "rgba(0, 0, 0, 0.4)";
    for (const cara of caras) {
      contexto.beginPath();
      contexto.moveTo(cara.puntos[0].x, cara.puntos[0].y);
      for (let i = 1; i < 4; i++) contexto.lineTo(cara.puntos[i].x, cara.puntos[i].y);
      contexto.closePath();
      contexto.fillStyle = cara.relleno;
      contexto.fill();
      contexto.stroke();
    }
  }

  return { dibujar, marcarSucio() {}, destruir() {} };
}

/* ── visor (interacción compartida) ──────────────────────────────────────── */

/**
 * Crea el visor sobre un canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{mostrarFrentes?: boolean}} [opciones]
 */
export function crearVisor3D(canvas, opciones = {}) {
  const estado = {
    partes: [],
    yaw: VISTA_INICIAL.yaw,
    pitch: VISTA_INICIAL.pitch,
    zoom: VISTA_INICIAL.zoom,
    mostrarFrentes: opciones.mostrarFrentes ?? true,
    arrastrando: false,
    ultimoX: 0,
    ultimoY: 0,
  };

  let gl = null;
  try {
    gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
  } catch {
    gl = null;
  }

  const backend = gl ? crearBackendWebGL(canvas, gl) : crearBackendCanvas2D(canvas);
  canvas.dataset.renderer = gl ? "webgl2" : "canvas2d";

  let pedido = 0;
  const dibujar = () => {
    cancelAnimationFrame(pedido);
    pedido = requestAnimationFrame(() => backend.dibujar(estado));
  };

  /* interacción */
  const alPresionar = (evento) => {
    estado.arrastrando = true;
    estado.ultimoX = evento.clientX;
    estado.ultimoY = evento.clientY;
    canvas.setPointerCapture?.(evento.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const alMover = (evento) => {
    if (!estado.arrastrando) return;
    estado.yaw -= (evento.clientX - estado.ultimoX) * 0.009;
    estado.pitch = Math.max(
      -1.45,
      Math.min(1.45, estado.pitch + (evento.clientY - estado.ultimoY) * 0.009),
    );
    estado.ultimoX = evento.clientX;
    estado.ultimoY = evento.clientY;
    dibujar();
  };
  const alSoltar = (evento) => {
    if (!estado.arrastrando) return;
    estado.arrastrando = false;
    canvas.releasePointerCapture?.(evento.pointerId);
    canvas.style.cursor = "grab";
  };
  const alGirarRueda = (evento) => {
    evento.preventDefault();
    estado.zoom = Math.max(0.35, Math.min(4, estado.zoom * Math.exp(-evento.deltaY * 0.0012)));
    dibujar();
  };
  const reiniciarCamara = () => {
    estado.yaw = VISTA_INICIAL.yaw;
    estado.pitch = VISTA_INICIAL.pitch;
    estado.zoom = VISTA_INICIAL.zoom;
    dibujar();
  };

  canvas.addEventListener("pointerdown", alPresionar);
  canvas.addEventListener("pointermove", alMover);
  canvas.addEventListener("pointerup", alSoltar);
  canvas.addEventListener("pointercancel", alSoltar);
  canvas.addEventListener("wheel", alGirarRueda, { passive: false });
  canvas.addEventListener("dblclick", reiniciarCamara);
  canvas.style.cursor = "grab";

  let observador = null;
  if (typeof ResizeObserver !== "undefined") {
    observador = new ResizeObserver(() => dibujar());
    observador.observe(canvas);
  }

  return {
    /** Actualiza las piezas y redibuja. */
    actualizar(partes) {
      estado.partes = Array.isArray(partes) ? partes : [];
      backend.marcarSucio();
      dibujar();
    },
    redimensionar: dibujar,
    reiniciarCamara,
    setMostrarFrentes(valor) {
      estado.mostrarFrentes = Boolean(valor);
      backend.marcarSucio();
      dibujar();
    },
    get estado() {
      return estado;
    },
    get renderer() {
      return canvas.dataset.renderer;
    },
    destruir() {
      cancelAnimationFrame(pedido);
      observador?.disconnect();
      canvas.removeEventListener("pointerdown", alPresionar);
      canvas.removeEventListener("pointermove", alMover);
      canvas.removeEventListener("pointerup", alSoltar);
      canvas.removeEventListener("pointercancel", alSoltar);
      canvas.removeEventListener("wheel", alGirarRueda);
      canvas.removeEventListener("dblclick", reiniciarCamara);
      backend.destruir();
    },
  };
}
