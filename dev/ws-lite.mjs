/**
 * Servidor WebSocket mínimo (RFC 6455) sin dependencias.
 *
 * Solo lo necesario para el modo agente de Despiece: handshake, texto, ping,
 * pong y cierre. Se implementa a mano porque el proyecto no usa dependencias y
 * Node todavía no trae un servidor WebSocket nativo.
 */

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAXIMO_MENSAJE = 4 * 1024 * 1024; // 4 MB

/* ── frames ──────────────────────────────────────────────────────────────── */

/**
 * Construye un frame de texto (sin máscara, como corresponde al servidor).
 * @param {string} texto
 * @returns {Buffer}
 */
export function construirFrameTexto(texto) {
  const payload = Buffer.from(texto, "utf8");
  const largo = payload.length;

  let encabezado;
  if (largo < 126) {
    encabezado = Buffer.from([0x81, largo]);
  } else if (largo < 65536) {
    encabezado = Buffer.alloc(4);
    encabezado[0] = 0x81;
    encabezado[1] = 126;
    encabezado.writeUInt16BE(largo, 2);
  } else {
    encabezado = Buffer.alloc(10);
    encabezado[0] = 0x81;
    encabezado[1] = 127;
    encabezado.writeBigUInt64BE(BigInt(largo), 2);
  }

  return Buffer.concat([encabezado, payload]);
}

/** Construye un frame de cierre con código. */
export function construirFrameCierre(codigo = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(codigo, 0);
  return Buffer.concat([Buffer.from([0x88, 2]), payload]);
}

/** Decodificador incremental de frames del cliente (vienen enmascarados). */
export class DecodificadorFrames {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragmentos = [];
    this.largoAcumulado = 0;
  }

  /**
   * Agrega datos al decodificador.
   * @param {Buffer} chunk
   * @returns {Array<{tipo: "texto"|"ping"|"pong"|"close", texto?: string, payload?: Buffer}>}
   */
  agregar(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const eventos = [];

    while (true) {
      const frame = this.leerFrame();
      if (!frame) break;

      if (frame.opcode === 0x8) {
        eventos.push({ tipo: "close" });
        break;
      }
      if (frame.opcode === 0x9) {
        eventos.push({ tipo: "ping", payload: frame.payload });
        continue;
      }
      if (frame.opcode === 0xa) {
        eventos.push({ tipo: "pong" });
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        this.fragmentos.push(frame.payload);
        this.largoAcumulado += frame.payload.length;
        if (this.largoAcumulado > MAXIMO_MENSAJE) {
          eventos.push({ tipo: "close" });
          break;
        }
        if (frame.fin) {
          eventos.push({ tipo: "texto", texto: Buffer.concat(this.fragmentos).toString("utf8") });
          this.fragmentos = [];
          this.largoAcumulado = 0;
        }
      }
    }

    return eventos;
  }

  leerFrame() {
    if (this.buffer.length < 2) return null;

    const primero = this.buffer[0];
    const segundo = this.buffer[1];
    const fin = (primero & 0x80) !== 0;
    const opcode = primero & 0x0f;
    const enmascarado = (segundo & 0x80) !== 0;
    let largo = segundo & 0x7f;
    let offset = 2;

    if (largo === 126) {
      if (this.buffer.length < 4) return null;
      largo = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (largo === 127) {
      if (this.buffer.length < 10) return null;
      const grande = this.buffer.readBigUInt64BE(2);
      if (grande > BigInt(MAXIMO_MENSAJE)) return null;
      largo = Number(grande);
      offset = 10;
    }

    const mascaraLargo = enmascarado ? 4 : 0;
    if (this.buffer.length < offset + mascaraLargo + largo) return null;

    let payload = this.buffer.subarray(offset + mascaraLargo, offset + mascaraLargo + largo);
    if (enmascarado) {
      const mascara = this.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mascara[i % 4];
    }

    this.buffer = this.buffer.subarray(offset + mascaraLargo + largo);
    return { fin, opcode, payload };
  }
}

/* ── conexión ────────────────────────────────────────────────────────────── */

export class ConexionWS {
  /**
   * @param {import("node:net").Socket} socket
   * @param {object} [opciones]
   */
  constructor(socket, opciones = {}) {
    this.socket = socket;
    this.viva = true;
    this.decodificador = new DecodificadorFrames();
    this.onMensaje = opciones.onMensaje ?? null;
    this.onCierre = opciones.onCierre ?? null;

    socket.on("data", (chunk) => this.alRecibir(chunk));
    socket.on("close", () => this.marcarCerrada());
    socket.on("error", () => this.marcarCerrada());
  }

  alRecibir(chunk) {
    let eventos;
    try {
      eventos = this.decodificador.agregar(chunk);
    } catch {
      this.cerrar(1002);
      return;
    }

    for (const evento of eventos) {
      if (evento.tipo === "texto") {
        try {
          this.onMensaje?.(this, evento.texto);
        } catch {
          /* el consumidor no debe romper la conexión */
        }
      } else if (evento.tipo === "ping") {
        this.enviarFrame(Buffer.concat([Buffer.from([0x8a, evento.payload.length]), evento.payload]));
      } else if (evento.tipo === "close") {
        this.cerrar(1000);
      }
    }
  }

  enviarFrame(frame) {
    if (!this.viva) return false;
    try {
      this.socket.write(frame);
      return true;
    } catch {
      this.marcarCerrada();
      return false;
    }
  }

  /** Envía un mensaje de texto JSON. */
  enviar(dato) {
    const texto = typeof dato === "string" ? dato : JSON.stringify(dato);
    return this.enviarFrame(construirFrameTexto(texto));
  }

  /** Cierra la conexión de forma ordenada. */
  cerrar(codigo = 1000) {
    if (!this.viva) return;
    this.enviarFrame(construirFrameCierre(codigo));
    this.viva = false;
    try {
      this.socket.end();
    } catch {
      /* ignorar */
    }
    this.marcarCerrada();
  }

  destruir() {
    this.viva = false;
    try {
      this.socket.destroy();
    } catch {
      /* ignorar */
    }
    this.marcarCerrada();
  }

  marcarCerrada() {
    if (!this.viva) {
      this.onCierre?.();
      return;
    }
    this.viva = false;
    this.onCierre?.();
  }
}

/* ── handshake ───────────────────────────────────────────────────────────── */

function aceptarHandshake(socket, key) {
  const aceptado = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${aceptado}`,
      "\r\n",
    ].join("\r\n"),
  );
}

/**
 * Crea el handler de `upgrade` de un servidor HTTP.
 *
 * @param {{ ruta?: string, validarToken?: (token: string|null) => boolean, onConexion: (conexion: ConexionWS) => void }} opciones
 */
export function crearGestorUpgrade({ ruta = "/ws", validarToken = () => true, onConexion }) {
  return (request, socket) => {
    const rechazar = (codigo, mensaje) => {
      try {
        socket.write(`HTTP/1.1 ${codigo} ${mensaje}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      } catch {
        /* ignorar */
      }
    };

    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      return rechazar(400, "Bad Request");
    }

    if (url.pathname !== ruta) return rechazar(404, "Not Found");
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return rechazar(400, "Bad Request");
    if (!validarToken(url.searchParams.get("token"))) return rechazar(401, "Unauthorized");

    const key = request.headers["sec-websocket-key"];
    if (!key) return rechazar(400, "Bad Request");

    aceptarHandshake(socket, key);
    const conexion = new ConexionWS(socket);
    onConexion(conexion);
  };
}
