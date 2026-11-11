/**
 * Cliente del modo agente (lado página).
 *
 * Se conecta al WebSocket del servidor local (`npm run agent`), aplica los
 * comandos que llegan usando la misma capa que la interfaz y devuelve el
 * resultado. También manda el estado después de cada cambio y responde a los
 * pedidos de captura.
 *
 * Solo se activa si la página fue servida por el servidor de agentes, que
 * inyecta `window.__DESPIECE_AGENTE__` con el token.
 */

const MAXIMO_REINTENTOS = 5;

/**
 * @param {{
 *   aplicar: (nombre: string, argumentos: object) => object,
 *   obtenerEstado: () => { revision: number, design: object, resumen: object, avisos: object[] },
 *   capturar: () => Promise<string> | string,
 *   alEstadoConexion?: (estado: "conectando"|"conectado"|"reconectando"|"desconectado") => void,
 *   alActividad?: (estado: "editando"|"libre", comando?: string) => void,
 * }} opciones
 */
export function conectarAgente({
  aplicar,
  obtenerEstado,
  capturar,
  alEstadoConexion,
  alActividad,
}) {
  const config = globalThis.__DESPIECE_AGENTE__;
  if (!config?.token) return null;

  let socket = null;
  let reintentos = 0;
  let cerrado = false;
  let temporizador = null;

  const url = () => {
    const protocolo = location.protocol === "https:" ? "wss:" : "ws:";
    const entrada = config.entrada ?? "/ws";
    return `${protocolo}//${location.host}${entrada}?token=${encodeURIComponent(config.token)}`;
  };

  const abierta = () => socket?.readyState === WebSocket.OPEN;

  function enviar(mensaje) {
    if (!abierta()) return false;
    try {
      socket.send(JSON.stringify(mensaje));
      return true;
    } catch {
      return false;
    }
  }

  function enviarEstado() {
    if (!abierta()) return false;
    try {
      return enviar({ type: "estado", ...obtenerEstado() });
    } catch {
      return false;
    }
  }

  function alMensaje(evento) {
    let mensaje;
    try {
      mensaje = JSON.parse(evento.data);
    } catch {
      return;
    }
    if (!mensaje || typeof mensaje.type !== "string") return;

    if (mensaje.type === "comando") {
      // Se avisa "editando" y se aplica en el próximo frame: así la interfaz
      // llega a pintar el estado antes de que el comando cambie el mueble.
      alActividad?.("editando", mensaje.nombre);
      requestAnimationFrame(() => {
        let respuesta;
        try {
          respuesta = aplicar(mensaje.nombre, mensaje.argumentos ?? {});
        } catch (error) {
          respuesta = {
            ok: false,
            revision: null,
            error: { codigo: "error_pagina", mensaje: error.message ?? "Error al aplicar el comando." },
          };
        }
        enviar({ type: "resultado", id: mensaje.id, ...respuesta });
        if (respuesta.ok) enviarEstado();
        alActividad?.("libre");
      });
      return;
    }

    if (mensaje.type === "captura_solicitud") {
      Promise.resolve()
        .then(() => capturar())
        .then((png) => enviar({ type: "captura", id: mensaje.id, png: png ?? null }))
        .catch(() => enviar({ type: "captura", id: mensaje.id, png: null }));
    }
  }

  function programarReintento() {
    if (cerrado) return;
    if (reintentos >= MAXIMO_REINTENTOS) {
      alEstadoConexion?.("desconectado");
      return;
    }
    const espera = Math.min(1000 * 2 ** reintentos, 15000);
    reintentos += 1;
    temporizador = setTimeout(conectar, espera);
  }

  function conectar() {
    if (cerrado) return;
    clearTimeout(temporizador);
    alEstadoConexion?.("conectando");

    try {
      socket = new WebSocket(url());
    } catch {
      programarReintento();
      return;
    }

    socket.addEventListener("open", () => {
      reintentos = 0;
      alEstadoConexion?.("conectado");
      enviar({ type: "presencia", pagina: true });
      enviarEstado();
    });

    socket.addEventListener("message", alMensaje);

    socket.addEventListener("close", () => {
      socket = null;
      if (cerrado) return;
      alEstadoConexion?.("reconectando");
      programarReintento();
    });

    socket.addEventListener("error", () => {
      try {
        socket?.close();
      } catch {
        /* ignorar */
      }
    });
  }

  conectar();

  return {
    enviarEstado,
    get conectado() {
      return abierta();
    },
    reconectar() {
      cerrado = false;
      reintentos = 0;
      conectar();
    },
    desconectar() {
      cerrado = true;
      clearTimeout(temporizador);
      try {
        socket?.close();
      } catch {
        /* ignorar */
      }
      socket = null;
      alEstadoConexion?.("desconectado");
    },
  };
}
