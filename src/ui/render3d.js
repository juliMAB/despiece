/**
 * Visor 3D del mueble (canvas 2D, sin dependencias).
 *
 * Renderer propio: proyecta en perspectiva, descarta caras traseras, ordena
 * por profundidad (painter's algorithm) y sombrea cada cara según su normal.
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
} from "./geometry3d.js";

/** Paleta propia de Despiece: ámbar para los frentes, madera para la estructura. */
export const PALETA_3D = Object.freeze({
  "vertical-side": "#7c5c3e",
  "horizontal-deck": "#96714b",
  "back-panel": "#5b5049",
  "door-front": "#f59e0b",
  "drawer-front": "#fbbf24",
  "drawer-side": "#b45309",
  "drawer-back": "#9a3412",
  "drawer-bottom": "#7c2d12",
  group: "#8a8580",
});

const ROLES_FRENTE = new Set(["door-front", "drawer-front"]);
const FOV = 38;
const VISTA_INICIAL = Object.freeze({ yaw: 0.62, pitch: 0.42, zoom: 1 });

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

  const contexto = canvas.getContext("2d");
  let observador = null;
  let pedido = 0;

  const partesVisibles = () =>
    estado.mostrarFrentes
      ? estado.partes
      : estado.partes.filter((parte) => !ROLES_FRENTE.has(parte.role));

  function dibujar() {
    cancelAnimationFrame(pedido);
    pedido = requestAnimationFrame(dibujarAhora);
  }

  function dibujarAhora() {
    const dpr = window.devicePixelRatio || 1;
    const ancho = canvas.clientWidth || 640;
    const alto = canvas.clientHeight || 360;
    if (ancho === 0 || alto === 0) return;

    canvas.width = Math.round(ancho * dpr);
    canvas.height = Math.round(alto * dpr);
    contexto.setTransform(dpr, 0, 0, dpr, 0, 0);
    contexto.clearRect(0, 0, ancho, alto);

    const cajas = partesVisibles().map(partToBox);
    if (cajas.length === 0) {
      contexto.fillStyle = "#78716c";
      contexto.font = "13px ui-sans-serif, system-ui, sans-serif";
      contexto.textAlign = "center";
      contexto.fillText("Sin piezas para mostrar", ancho / 2, alto / 2);
      return;
    }

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

    dibujarPiso(min, max, camara, radio);

    // Caras visibles de todas las cajas, ordenadas de atrás hacia adelante.
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
    contexto.strokeStyle = "rgba(0, 0, 0, 0.45)";
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

  function dibujarPiso(min, max, camara, radio) {
    const paso = radio > 1.2 ? 0.4 : 0.2;
    const desdeX = Math.floor(min.x / paso) * paso;
    const hastaX = Math.ceil(max.x / paso) * paso;
    const desdeZ = Math.floor(min.z / paso) * paso;
    const hastaZ = Math.ceil(max.z / paso) * paso;

    contexto.strokeStyle = "rgba(168, 162, 158, 0.16)";
    contexto.lineWidth = 1;

    const trazar = (a, b) => {
      const inicio = proyectarPunto({ x: a.x, y: 0, z: a.z }, camara);
      const fin = proyectarPunto({ x: b.x, y: 0, z: b.z }, camara);
      if (!inicio || !fin) return;
      contexto.beginPath();
      contexto.moveTo(inicio.x, inicio.y);
      contexto.lineTo(fin.x, fin.y);
      contexto.stroke();
    };

    for (let x = desdeX; x <= hastaX + 1e-9; x += paso) {
      trazar({ x, z: desdeZ }, { x, z: hastaZ });
    }
    for (let z = desdeZ; z <= hastaZ + 1e-9; z += paso) {
      trazar({ x: desdeX, z }, { x: hastaX, z });
    }
  }

  /* ── interacción ───────────────────────────────────────────────────────── */

  function alPresionar(evento) {
    estado.arrastrando = true;
    estado.ultimoX = evento.clientX;
    estado.ultimoY = evento.clientY;
    canvas.setPointerCapture?.(evento.pointerId);
    canvas.style.cursor = "grabbing";
  }

  function alMover(evento) {
    if (!estado.arrastrando) return;
    estado.yaw -= (evento.clientX - estado.ultimoX) * 0.009;
    estado.pitch = Math.max(
      -1.45,
      Math.min(1.45, estado.pitch + (evento.clientY - estado.ultimoY) * 0.009),
    );
    estado.ultimoX = evento.clientX;
    estado.ultimoY = evento.clientY;
    dibujar();
  }

  function alSoltar(evento) {
    if (!estado.arrastrando) return;
    estado.arrastrando = false;
    canvas.releasePointerCapture?.(evento.pointerId);
    canvas.style.cursor = "grab";
  }

  function alGirarRueda(evento) {
    evento.preventDefault();
    estado.zoom = Math.max(0.35, Math.min(4, estado.zoom * Math.exp(-evento.deltaY * 0.0012)));
    dibujar();
  }

  function reiniciarCamara() {
    estado.yaw = VISTA_INICIAL.yaw;
    estado.pitch = VISTA_INICIAL.pitch;
    estado.zoom = VISTA_INICIAL.zoom;
    dibujar();
  }

  canvas.addEventListener("pointerdown", alPresionar);
  canvas.addEventListener("pointermove", alMover);
  canvas.addEventListener("pointerup", alSoltar);
  canvas.addEventListener("pointercancel", alSoltar);
  canvas.addEventListener("wheel", alGirarRueda, { passive: false });
  canvas.addEventListener("dblclick", reiniciarCamara);
  canvas.style.cursor = "grab";

  if (typeof ResizeObserver !== "undefined") {
    observador = new ResizeObserver(() => dibujar());
    observador.observe(canvas);
  }

  return {
    /** Actualiza las piezas y redibuja. */
    actualizar(partes) {
      estado.partes = Array.isArray(partes) ? partes : [];
      dibujar();
    },
    redimensionar: dibujar,
    reiniciarCamara,
    setMostrarFrentes(valor) {
      estado.mostrarFrentes = Boolean(valor);
      dibujar();
    },
    get estado() {
      return estado;
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
    },
  };
}
