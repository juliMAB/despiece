/**
 * Visor 3D del mueble.
 *
 * Usa **WebGL 2 con z-buffer real** (depth test), así las piezas se ocluyen
 * correctamente desde cualquier ángulo. Si el navegador no tiene WebGL 2, cae
 * a un renderer 2D por software para que la app siga funcionando.
 *
 * Interacción:
 *   - arrastrar: rotar
 *   - rueda: zoom
 *   - doble click: volver a la vista inicial
 *   - click en una puerta o cajón: abrirlo / cerrarlo
 *   - pasar el mouse: identifica la pieza (para mostrar sus medidas)
 */

import {
  partToBox,
  boxesBounds,
  crearCamara,
  proyectarPunto,
  distanciaParaEncuadrar,
  CARAS,
  verticeDeCaja,
  centroDeCara,
  intensidadSombra,
  hexARgb,
  punto,
  restar,
  matrizVista,
  matrizPerspectiva,
  multiplicarMatrices,
  transformacionesDeApertura,
  grupoDeApertura,
  rotarPuntoY,
  rotarNormalY,
  trasladarPunto,
  rayoDesdePixel,
  piezaEnRayo,
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
const VELOCIDAD_ANIMACION = 90; // ms; menor = más rápido

const parteVisible = (parte, mostrarFrentes) =>
  mostrarFrentes || !ROLES_FRENTE.has(parte.role);

/** Cámara y piezas para el estado actual. */
function calcularVista(estado, ancho, alto, aperturaDeParte) {
  const partes = estado.partes.filter((parte) => parteVisible(parte, estado.mostrarFrentes));
  const transformaciones = transformacionesDeApertura(partes, aperturaDeParte);
  const piezas = partes.map((parte) => ({
    clave: parte.key,
    parte,
    caja: partToBox(parte),
    transformacion: transformaciones.get(parte.key) ?? null,
  }));

  const cajas = piezas.map((pieza) => pieza.caja);
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

  return { piezas, cajas, camara, min, max, radio, ancho, alto, resaltada: estado.resaltada, resaltadas: estado.resaltadas };
}

/** Color RGB (0..1) de una pieza: resalta la del mouse y las que tocó el agente. */
function colorRgb(caja, vista) {
  const base = hexARgb(PALETA_3D[caja.role] ?? PALETA_3D.group);
  const mezcla = (a, b, t) => (a + (b - a) * t) / 255;

  if (vista.resaltada === caja.key) {
    return [mezcla(base.r, 255, 0.45), mezcla(base.g, 255, 0.45), mezcla(base.b, 255, 0.45)];
  }
  if (vista.resaltadas?.has(caja.key)) {
    // celeste: piezas que cambiaron con el último comando del agente
    const acento = hexARgb("#38bdf8");
    return [
      mezcla(base.r, acento.r, 0.55),
      mezcla(base.g, acento.g, 0.55),
      mezcla(base.b, acento.b, 0.55),
    ];
  }
  return [base.r / 255, base.g / 255, base.b / 255];
}

/** Aplica una transformación a un vértice. */
function transformarVertice(vertice, transformacion) {
  if (!transformacion) return vertice;
  if (transformacion.tipo === "giro") {
    return rotarPuntoY(vertice, transformacion.angulo, transformacion.pivote);
  }
  return trasladarPunto(vertice, transformacion.delta);
}

/** Aplica una transformación a una normal. */
function transformarNormal(normal, transformacion) {
  if (!transformacion) return normal;
  if (transformacion.tipo === "giro") return rotarNormalY(normal, transformacion.angulo);
  return normal;
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
  const atributosLineas = { posicion: gl.getAttribLocation(programaLineas, "aPosicion") };
  const uniformesLineas = {
    mvp: gl.getUniformLocation(programaLineas, "uMVP"),
    color: gl.getUniformLocation(programaLineas, "uColor"),
  };

  const bufferPosiciones = gl.createBuffer();
  const bufferNormales = gl.createBuffer();
  const bufferColores = gl.createBuffer();
  const bufferLineas = gl.createBuffer();

  function dibujar(vista) {
    const dpr = window.devicePixelRatio || 1;
    const anchoPx = Math.round(vista.ancho * dpr);
    const altoPx = Math.round(vista.alto * dpr);
    if (canvas.width !== anchoPx || canvas.height !== altoPx) {
      canvas.width = anchoPx;
      canvas.height = altoPx;
    }
    gl.viewport(0, 0, anchoPx, altoPx);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const vistaMatriz = matrizVista(vista.camara);
    const proyeccion = matrizPerspectiva({
      fovDeg: FOV,
      aspect: vista.ancho / vista.alto,
      near: 0.005,
      far: 100,
    });
    const mvp = multiplicarMatrices(proyeccion, vistaMatriz);

    // Geometría
    const posiciones = [];
    const normales = [];
    const colores = [];
    for (const { caja, transformacion } of vista.piezas) {
      const color = colorRgb(caja, vista);
      for (const cara of CARAS) {
        const normal = transformarNormal(cara.normal, transformacion);
        const vertices = cara.vertices.map((relativo) =>
          transformarVertice(verticeDeCaja(caja, relativo), transformacion),
        );
        for (const orden of [[0, 1, 2], [0, 2, 3]]) {
          for (const indice of orden) {
            posiciones.push(vertices[indice].x, vertices[indice].y, vertices[indice].z);
            normales.push(normal.x, normal.y, normal.z);
            colores.push(color[0], color[1], color[2]);
          }
        }
      }
    }

    if (posiciones.length > 0) {
      gl.useProgram(programaLleno);
      gl.uniformMatrix4fv(uniformesLleno.mvp, false, mvp);
      gl.uniform3fv(uniformesLleno.luz, new Float32Array([LUZ.x, LUZ.y, LUZ.z]));

      gl.bindBuffer(gl.ARRAY_BUFFER, bufferPosiciones);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posiciones), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(atributosLleno.posicion);
      gl.vertexAttribPointer(atributosLleno.posicion, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufferNormales);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normales), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(atributosLleno.normal);
      gl.vertexAttribPointer(atributosLleno.normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufferColores);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colores), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(atributosLleno.color);
      gl.vertexAttribPointer(atributosLleno.color, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, posiciones.length / 3);
    }

    // Grilla del piso
    const { min, max } = vista;
    const paso = vista.radio > 1.2 ? 0.4 : 0.2;
    const desdeX = Math.floor(min.x / paso) * paso;
    const hastaX = Math.ceil(max.x / paso) * paso;
    const desdeZ = Math.floor(min.z / paso) * paso;
    const hastaZ = Math.ceil(max.z / paso) * paso;
    const lineas = [];
    for (let x = desdeX; x <= hastaX + 1e-9; x += paso) lineas.push(x, 0, desdeZ, x, 0, hastaZ);
    for (let z = desdeZ; z <= hastaZ + 1e-9; z += paso) lineas.push(desdeX, 0, z, hastaX, 0, z);

    gl.useProgram(programaLineas);
    gl.uniformMatrix4fv(uniformesLineas.mvp, false, mvp);
    gl.uniform4fv(uniformesLineas.color, new Float32Array([0.62, 0.6, 0.58, 0.22]));
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferLineas);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineas), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(atributosLineas.posicion);
    gl.vertexAttribPointer(atributosLineas.posicion, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, lineas.length / 3);
  }

  return {
    dibujar,
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

  function dibujarPiso(vista, camara) {
    const paso = vista.radio > 1.2 ? 0.4 : 0.2;
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
    const desdeX = Math.floor(vista.min.x / paso) * paso;
    const hastaX = Math.ceil(vista.max.x / paso) * paso;
    const desdeZ = Math.floor(vista.min.z / paso) * paso;
    const hastaZ = Math.ceil(vista.max.z / paso) * paso;
    for (let x = desdeX; x <= hastaX + 1e-9; x += paso) trazar({ x, y: 0, z: desdeZ }, { x, y: 0, z: hastaZ });
    for (let z = desdeZ; z <= hastaZ + 1e-9; z += paso) trazar({ x: desdeX, y: 0, z }, { x: hastaX, y: 0, z });
  }

  function dibujar(vista) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(vista.ancho * dpr);
    canvas.height = Math.round(vista.alto * dpr);
    contexto.setTransform(dpr, 0, 0, dpr, 0, 0);
    contexto.clearRect(0, 0, vista.ancho, vista.alto);

    dibujarPiso(vista, vista.camara);

    const caras = [];
    for (const { caja, transformacion } of vista.piezas) {
      const [r, g, b] = colorRgb(caja, vista);
      for (const cara of CARAS) {
        const normal = transformarNormal(cara.normal, transformacion);
        const centro = transformarVertice(centroDeCara(caja, cara.normal), transformacion);
        if (punto(normal, restar(vista.camara.eye, centro)) <= 0) continue;

        const puntos = [];
        let profundidad = 0;
        let fuera = false;
        for (const relativo of cara.vertices) {
          const vertice = transformarVertice(verticeDeCaja(caja, relativo), transformacion);
          const proyectado = proyectarPunto(vertice, vista.camara);
          if (!proyectado) {
            fuera = true;
            break;
          }
          puntos.push(proyectado);
          profundidad += proyectado.profundidad;
        }
        if (fuera || puntos.length !== 4) continue;
        const luz = intensidadSombra(normal);
        caras.push({
          puntos,
          profundidad: profundidad / 4,
          relleno: `rgb(${Math.round(r * 255 * luz)}, ${Math.round(g * 255 * luz)}, ${Math.round(b * 255 * luz)})`,
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

  return { dibujar, destruir() {} };
}

/* ── visor (interacción compartida) ──────────────────────────────────────── */

/**
 * Crea el visor sobre un canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{mostrarFrentes?: boolean, alDibujar?: (vista: object) => void}} [opciones]
 */
export function crearVisor3D(canvas, opciones = {}) {
  const estado = {
    partes: [],
    yaw: VISTA_INICIAL.yaw,
    pitch: VISTA_INICIAL.pitch,
    zoom: VISTA_INICIAL.zoom,
    mostrarFrentes: opciones.mostrarFrentes ?? true,
    resaltada: null,
    resaltadas: new Set(),
    arrastrando: false,
    ultimoX: 0,
    ultimoY: 0,
  };

  // Apertura por grupo (cada puerta y cada cajón se abren independientes).
  const aperturas = new Map();
  const objetivos = new Map();

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
  canvas.dataset.resaltadas = "0";

  let pedido = 0;
  let animacion = 0;
  let ultimaVista = null;

  const aperturaDeParte = (parte) => {
    const grupo = grupoDeApertura(parte);
    return grupo ? aperturas.get(grupo) ?? 0 : 0;
  };

  function dibujarAhora() {
    const ancho = canvas.clientWidth || 0;
    const alto = canvas.clientHeight || 0;
    if (!ancho || !alto) return;

    const vista = calcularVista(estado, ancho, alto, aperturaDeParte);
    ultimaVista = vista;
    backend.dibujar(vista);

    let maximo = 0;
    let abiertos = 0;
    for (const valor of aperturas.values()) {
      if (valor > 0.5) abiertos++;
      if (valor > maximo) maximo = valor;
    }
    canvas.dataset.abiertos = String(abiertos);
    canvas.dataset.apertura = maximo.toFixed(2);
    opciones.alDibujar?.(vista);
  }

  function dibujar() {
    cancelAnimationFrame(pedido);
    pedido = requestAnimationFrame(dibujarAhora);
  }

  /* animación de apertura */
  function animar() {
    cancelAnimationFrame(animacion);
    let ultimo = performance.now();
    const paso = (ahora) => {
      const dt = Math.min(64, ahora - ultimo);
      ultimo = ahora;
      let animando = false;

      for (const [grupo, objetivo] of objetivos) {
        const actual = aperturas.get(grupo) ?? 0;
        const factor = 1 - Math.exp(-dt / VELOCIDAD_ANIMACION);
        const nuevo = actual + (objetivo - actual) * factor;
        if (Math.abs(objetivo - nuevo) < 0.004) {
          aperturas.set(grupo, objetivo);
        } else {
          aperturas.set(grupo, nuevo);
          animando = true;
        }
      }

      dibujarAhora();
      if (animando) animacion = requestAnimationFrame(paso);
    };
    animacion = requestAnimationFrame(paso);
  }

  function gruposExistentes() {
    const grupos = new Set();
    for (const parte of estado.partes) {
      const grupo = grupoDeApertura(parte);
      if (grupo) grupos.add(grupo);
    }
    return grupos;
  }

  /** Abre o cierra todas las puertas y cajones. */
  function setApertura(objetivo) {
    const valor = Math.max(0, Math.min(1, Number(objetivo) || 0));
    for (const grupo of gruposExistentes()) objetivos.set(grupo, valor);
    animar();
  }

  /** Abre o cierra un grupo puntual (una puerta o un cajón). */
  function alternarGrupo(grupo) {
    if (!grupo) return;
    const objetivo = (objetivos.get(grupo) ?? 0) > 0.5 ? 0 : 1;
    objetivos.set(grupo, objetivo);
    animar();
  }

  /** Identifica qué pieza hay bajo un pixel del canvas. */
  function piezaEnPixel(xCss, yCss) {
    if (!ultimaVista) return null;
    const rayo = rayoDesdePixel(xCss, yCss, ultimaVista.ancho, ultimaVista.alto, ultimaVista.camara, FOV);
    return piezaEnRayo(rayo, ultimaVista.piezas);
  }

  /** Abre/cierra la pieza que está bajo un pixel. Devuelve el grupo o null. */
  function alternarPiezaEnPixel(xCss, yCss) {
    const elegida = piezaEnPixel(xCss, yCss);
    if (!elegida) return null;
    const grupo = grupoDeApertura(elegida.parte);
    if (!grupo) return null;
    alternarGrupo(grupo);
    return grupo;
  }

  /** Proyecta un punto 3D a píxeles CSS del canvas (o null si está detrás). */
  function proyectar(punto3d) {
    if (!ultimaVista) return null;
    return proyectarPunto(punto3d, ultimaVista.camara);
  }

  /* interacción */
  const alPresionar = (evento) => {
    estado.arrastrando = true;
    estado.ultimoX = evento.clientX;
    estado.ultimoY = evento.clientY;
    estado.inicioX = evento.clientX;
    estado.inicioY = evento.clientY;
    estado.inicioTiempo = performance.now();
    try {
      canvas.setPointerCapture?.(evento.pointerId);
    } catch {
      /* algunos entornos no tienen puntero activo (eventos sintéticos) */
    }
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
    try {
      canvas.releasePointerCapture?.(evento.pointerId);
    } catch {
      /* ignorar: puede no haber captura activa */
    }
    canvas.style.cursor = "grab";

    // Si fue un click (sin arrastrar), abrir/cerrar la pieza bajo el cursor.
    const movido = Math.hypot(
      (evento.clientX ?? estado.inicioX) - estado.inicioX,
      (evento.clientY ?? estado.inicioY) - estado.inicioY,
    );
    const rapido = performance.now() - estado.inicioTiempo < 500;
    if (movido < 5 && rapido) {
      const caja = canvas.getBoundingClientRect();
      alternarPiezaEnPixel(evento.clientX - caja.left, evento.clientY - caja.top);
    }
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
    /** Actualiza las piezas y redibuja (mantiene las aperturas). */
    actualizar(partes) {
      estado.partes = Array.isArray(partes) ? partes : [];
      // limpiar grupos que ya no existen
      const existentes = gruposExistentes();
      for (const grupo of [...aperturas.keys()]) if (!existentes.has(grupo)) aperturas.delete(grupo);
      for (const grupo of [...objetivos.keys()]) if (!existentes.has(grupo)) objetivos.delete(grupo);
      dibujar();
    },
    redimensionar: dibujar,
    reiniciarCamara,
    setMostrarFrentes(valor) {
      estado.mostrarFrentes = Boolean(valor);
      dibujar();
    },
    /** Resalta una pieza (o ninguna con null). */
    setResaltada(clave) {
      const nueva = clave ?? null;
      if (estado.resaltada === nueva) return;
      estado.resaltada = nueva;
      dibujar();
    },
    /** Resalta varias piezas (las que cambió el agente). */
    setResaltadas(claves) {
      const nuevas = new Set(Array.isArray(claves) ? claves : []);
      const iguales =
        nuevas.size === estado.resaltadas.size &&
        [...nuevas].every((clave) => estado.resaltadas.has(clave));
      if (iguales) return;
      estado.resaltadas = nuevas;
      canvas.dataset.resaltadas = String(estado.resaltadas.size);
      dibujar();
    },
    limpiarResaltadas() {
      if (estado.resaltadas.size === 0) return;
      estado.resaltadas = new Set();
      canvas.dataset.resaltadas = "0";
      dibujar();
    },
    /** Abre (1) o cierra (0) todo, con animación. */
    setApertura,
    /** Abre/cierra un grupo puntual con un valor entre 0 y 1. */
    setAperturaGrupo(grupo, valor) {
      if (!grupo) return;
      objetivos.set(grupo, Math.max(0, Math.min(1, Number(valor) || 0)));
      animar();
    },
    /** Apertura actual de un grupo (0 a 1). */
    getAperturaGrupo(grupo) {
      return aperturas.get(grupo) ?? 0;
    },
    /** Mueve la cámara directamente. */
    setCamara({ yaw, pitch, zoom }) {
      if (Number.isFinite(yaw)) estado.yaw = yaw;
      if (Number.isFinite(pitch)) estado.pitch = Math.max(-1.45, Math.min(1.45, pitch));
      if (Number.isFinite(zoom)) estado.zoom = Math.max(0.35, Math.min(4, zoom));
      dibujar();
    },
    alternarGrupo,
    piezaEnPixel,
    alternarPiezaEnPixel,
    proyectar,
    get vista() {
      return ultimaVista;
    },
    get estado() {
      return estado;
    },
    get renderer() {
      return canvas.dataset.renderer;
    },
    destruir() {
      cancelAnimationFrame(pedido);
      cancelAnimationFrame(animacion);
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
