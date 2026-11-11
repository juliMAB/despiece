/**
 * Servidor local del modo agente de Despiece (F2).
 *
 * Levanta:
 *   - la app estática (igual que `npm run serve`),
 *   - un WebSocket en /ws para hablar con la página abierta,
 *   - una API HTTP para que un agente (o un script) edite el mueble en vivo.
 *
 * La página es la fuente de verdad: este proceso solo transporta comandos y
 * devuelve los resultados. Seguridad: escucha en 127.0.0.1 y exige token.
 *
 * Uso:
 *   node dev/agent-server.mjs [--puerto 8790] [--abrir]
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

import { crearGestorUpgrade } from "./ws-lite.mjs";
import { compileFurniture } from "../src/engine/compile.js";
import { buildCutlist, summarize } from "../src/engine/cutlist.js";
import { normalizarDiseno } from "../src/app/design.js";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")).version;
const PUERTO_INICIAL = 8790;
const TIEMPO_MAXIMO = 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/* ── token ───────────────────────────────────────────────────────────────── */

function leerOGuardarToken(raiz) {
  const archivo = join(raiz, ".despiece-token");
  try {
    if (existsSync(archivo)) {
      const guardado = readFileSync(archivo, "utf8").trim();
      if (guardado.length >= 16) return guardado;
    }
  } catch {
    /* si no se puede leer, se genera uno nuevo */
  }
  const token = randomBytes(24).toString("hex");
  try {
    writeFileSync(archivo, token + "\n", "utf8");
  } catch {
    /* si no se puede guardar, el token vive solo en memoria */
  }
  return token;
}

function mismoToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/* ── estáticos ───────────────────────────────────────────────────────────── */

function servirEstatico(raiz, request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  let ruta = decodeURIComponent(url.pathname);
  if (ruta.endsWith("/")) ruta += "index.html";

  const archivo = resolve(join(raiz, normalize(ruta)));
  if (!archivo.startsWith(raiz)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Prohibido");
    return;
  }

  let info;
  try {
    info = statSync(archivo);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("No encontrado: " + ruta);
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("No encontrado");
    return;
  }

  const tipo = MIME[extname(archivo).toLowerCase()] ?? "application/octet-stream";
  let cuerpo = readFileSync(archivo);

  // En la app servida por el modo agente se inyecta el token para que la
  // página se conecte sola al WebSocket (solo en localhost).
  if (ruta.endsWith("index.html")) {
    cuerpo = Buffer.from(
      cuerpo
        .toString("utf8")
        .replace(
          "</head>",
          `<script>window.__DESPIECE_AGENTE__ = ${JSON.stringify({
            token: request.despieceToken,
            entrada: "/ws",
            version: VERSION,
          })};</script>\n</head>`,
        ),
      "utf8",
    );
  }

  response.writeHead(200, {
    "Content-Type": tipo,
    "Content-Length": cuerpo.length,
    "Cache-Control": "no-store",
  });
  response.end(cuerpo);
}

/* ── servidor ────────────────────────────────────────────────────────────── */

/**
 * Crea el servidor del modo agente (sin escuchar todavía).
 *
 * @param {{ raiz?: string, token?: string, puerto?: number }} [opciones]
 */
export function crearServidorAgente(opciones = {}) {
  const raiz = resolve(opciones.raiz ?? RAIZ);
  const token = opciones.token ?? leerOGuardarToken(raiz);

  /** @type {import("./ws-lite.mjs").ConexionWS | null} */
  let pagina = null;
  let estadoPagina = null; // { revision, design, resumen, avisos }
  let ultimaCaptura = null; // Buffer PNG
  let contador = 0;

  /** @type {Map<string, { resolver: Function, temporizador: NodeJS.Timeout }>} */
  const resultadosPendientes = new Map();
  /** @type {Map<string, { resolver: Function, temporizador: NodeJS.Timeout }>} */
  const capturasPendientes = new Map();

  const esTokenValido = (recibido) => mismoToken(recibido, token);

  function resolverResultado(id, mensaje) {
    const pendiente = resultadosPendientes.get(id);
    if (!pendiente) return;
    clearTimeout(pendiente.temporizador);
    resultadosPendientes.delete(id);
    pendiente.resolver(mensaje);
  }

  function resolverCaptura(id, png) {
    const pendiente = capturasPendientes.get(id);
    if (!pendiente) return;
    clearTimeout(pendiente.temporizador);
    capturasPendientes.delete(id);
    pendiente.resolver(png);
  }

  function rechazarPendientes(codigo, mensaje) {
    for (const [id, pendiente] of resultadosPendientes) {
      clearTimeout(pendiente.temporizador);
      resultadosPendientes.delete(id);
      pendiente.resolver({ ok: false, error: { codigo, mensaje } });
    }
    for (const [id, pendiente] of capturasPendientes) {
      clearTimeout(pendiente.temporizador);
      capturasPendientes.delete(id);
      pendiente.resolver(null);
    }
  }

  function enviarAPagina(mensaje) {
    if (!pagina || !pagina.viva) return false;
    return pagina.enviar(mensaje);
  }

  /* ── WebSocket: la página ─────────────────────────────────────────────── */

  const alConectar = (conexion) => {
    if (pagina && pagina.viva) {
      pagina.enviar({ type: "error", codigo: "reemplazada", mensaje: "Otra página tomó el control." });
      pagina.cerrar(4000);
    }
    pagina = conexion;
    conexion.onMensaje = (_, texto) => alMensajeDePagina(texto);
    conexion.onCierre = () => {
      if (pagina === conexion) {
        pagina = null;
        estadoPagina = null;
        rechazarPendientes("sin_pagina", "La página se desconectó.");
      }
    };
    conexion.enviar({
      type: "hola",
      version: VERSION,
      revision: estadoPagina?.revision ?? null,
    });
  };

  function alMensajeDePagina(texto) {
    let mensaje;
    try {
      mensaje = JSON.parse(texto);
    } catch {
      return;
    }
    if (!mensaje || typeof mensaje.type !== "string") return;

    if (mensaje.type === "resultado") {
      resolverResultado(mensaje.id, {
        ok: Boolean(mensaje.ok),
        revision: mensaje.revision,
        ...(mensaje.ok
          ? { resultado: mensaje.resultado ?? null }
          : { error: mensaje.error ?? { codigo: "error_desconocido", mensaje: "La página no devolvió el error." } }),
      });
      return;
    }

    if (mensaje.type === "estado") {
      estadoPagina = {
        revision: mensaje.revision,
        design: mensaje.design,
        resumen: mensaje.resumen,
        avisos: mensaje.avisos ?? [],
      };
      return;
    }

    if (mensaje.type === "captura") {
      resolverCaptura(mensaje.id, typeof mensaje.png === "string" ? mensaje.png : null);
      return;
    }

    if (mensaje.type === "presencia") {
      return;
    }
  }

  /* ── API ──────────────────────────────────────────────────────────────── */

  function json(response, codigo, cuerpo) {
    const texto = JSON.stringify(cuerpo);
    response.writeHead(codigo, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(texto),
      "Cache-Control": "no-store",
    });
    response.end(texto);
  }

  const error = (codigo, mensaje, sugerencia) => ({ codigo, mensaje, sugerencia });

  function leerJson(request) {
    return new Promise((resolver, rechazar) => {
      let datos = "";
      const limite = 2 * 1024 * 1024;
      request.on("data", (chunk) => {
        datos += chunk;
        if (datos.length > limite) {
          rechazar(new Error("El cuerpo del pedido es demasiado grande."));
          request.destroy();
        }
      });
      request.on("end", () => {
        try {
          resolver(datos ? JSON.parse(datos) : {});
        } catch {
          rechazar(new Error("El cuerpo no es JSON válido."));
        }
      });
      request.on("error", rechazar);
    });
  }

  /** Encola un comando a la página y espera la respuesta. */
  function enviarComando(nombre, argumentos = {}) {
    return new Promise((resolver) => {
      if (!pagina || !pagina.viva) {
        resolver({
          ok: false,
          revision: estadoPagina?.revision ?? null,
          error: error(
            "sin_pagina",
            "No hay ninguna página de Despiece conectada.",
            "Abrí la app servida por este servidor en el navegador (o usá --abrir).",
          ),
        });
        return;
      }

      const id = `cmd-${++contador}`;
      const temporizador = setTimeout(() => {
        resultadosPendientes.delete(id);
        resolver({
          ok: false,
          revision: estadoPagina?.revision ?? null,
          error: error("tiempo_agotado", "La página no respondió a tiempo.", "Probá de nuevo; si sigue fallando, recargá la app."),
        });
      }, TIEMPO_MAXIMO);

      resultadosPendientes.set(id, { resolver, temporizador });
      const enviado = enviarAPagina({ type: "comando", id, nombre, argumentos });
      if (!enviado) {
        clearTimeout(temporizador);
        resultadosPendientes.delete(id);
        resolver({
          ok: false,
          revision: null,
          error: error("sin_pagina", "No hay ninguna página conectada.", "Abrí la app en el navegador."),
        });
      }
    });
  }

  /** Pide una captura a la página y devuelve el PNG como Buffer. */
  function pedirCaptura(ancho, alto) {
    return new Promise((resolver) => {
      if (!pagina || !pagina.viva) {
        resolver(null);
        return;
      }
      const id = `cap-${++contador}`;
      const temporizador = setTimeout(() => {
        capturasPendientes.delete(id);
        resolver(null);
      }, TIEMPO_MAXIMO);

      capturasPendientes.set(id, { resolver, temporizador });
      enviarAPagina({ type: "captura_solicitud", id, ancho, alto });
    });
  }

  async function manejarApi(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const ruta = url.pathname;
    const recibido = request.headers["x-despiece-token"] ?? url.searchParams.get("token");

    if (ruta === "/api/salud") {
      json(response, 200, {
        ok: true,
        motor: VERSION,
        paginaConectada: Boolean(pagina && pagina.viva),
        revision: estadoPagina?.revision ?? null,
      });
      return true;
    }

    const rutasProtegidas = ["/api/estado", "/api/despiece", "/api/comando", "/api/captura.png"];
    if (!rutasProtegidas.includes(ruta)) return false;

    if (!esTokenValido(recibido)) {
      json(response, 401, {
        ok: false,
        error: error("token_invalido", "Falta el token o no es correcto.", "Mandá el header X-Despiece-Token con el token del servidor."),
      });
      return true;
    }

    if (ruta === "/api/estado") {
      if (!estadoPagina) {
        json(response, 409, {
          ok: false,
          error: error("sin_pagina", "No hay estado todavía: abrí la app en el navegador."),
        });
        return true;
      }
      json(response, 200, { ok: true, ...estadoPagina });
      return true;
    }

    if (ruta === "/api/despiece") {
      if (!estadoPagina) {
        json(response, 409, {
          ok: false,
          error: error("sin_pagina", "No hay estado todavía: abrí la app en el navegador."),
        });
        return true;
      }
      try {
        const design = normalizarDiseno(estadoPagina.design);
        const resultado = compileFurniture(design);
        json(response, 200, {
          ok: true,
          lineas: buildCutlist(resultado.parts),
          resumen: summarize(resultado),
          avisos: resultado.issues,
        });
      } catch (excepcion) {
        json(response, 500, {
          ok: false,
          error: error("estado_invalido", "El estado de la página no compila: " + excepcion.message),
        });
      }
      return true;
    }

    if (ruta === "/api/comando") {
      if (request.method !== "POST") {
        json(response, 405, { ok: false, error: error("metodo_invalido", "Usá POST para /api/comando.") });
        return true;
      }
      let cuerpo;
      try {
        cuerpo = await leerJson(request);
      } catch (excepcion) {
        json(response, 400, { ok: false, error: error("cuerpo_invalido", excepcion.message) });
        return true;
      }
      if (!cuerpo || typeof cuerpo.nombre !== "string") {
        json(response, 400, {
          ok: false,
          error: error("comando_faltante", "Falta el nombre del comando.", 'Mandá { "nombre": "agregar_columna", "argumentos": { ... } }.'),
        });
        return true;
      }
      const respuesta = await enviarComando(cuerpo.nombre, cuerpo.argumentos ?? {});
      json(response, 200, respuesta);
      return true;
    }

    if (ruta === "/api/captura.png") {
      if (!pagina || !pagina.viva) {
        json(response, 409, {
          ok: false,
          error: error("sin_pagina", "No hay página conectada para capturar."),
        });
        return true;
      }
      const ancho = Number(url.searchParams.get("ancho") ?? 0) || undefined;
      const alto = Number(url.searchParams.get("alto") ?? 0) || undefined;
      const dataUrl = await pedirCaptura(ancho, alto);
      if (!dataUrl) {
        json(response, 504, {
          ok: false,
          error: error("sin_captura", "La página no devolvió la captura.", "Probá de nuevo."),
        });
        return true;
      }
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const png = Buffer.from(base64, "base64");
      ultimaCaptura = png;
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "no-store",
      });
      response.end(png);
      return true;
    }

    return false;
  }

  const servidor = createServer((request, response) => {
    request.despieceToken = token;
    Promise.resolve()
      .then(() => manejarApi(request, response))
      .then((manejado) => {
        if (!manejado) servirEstatico(raiz, request, response);
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Error interno");
        }
      });
  });

  servidor.on(
    "upgrade",
    crearGestorUpgrade({
      ruta: "/ws",
      validarToken: (recibido) => esTokenValido(recibido),
      onConexion: alConectar,
    }),
  );

  return {
    servidor,
    token,
    raiz,
    get paginaConectada() {
      return Boolean(pagina && pagina.viva);
    },
    get estadoPagina() {
      return estadoPagina;
    },
    get ultimaCaptura() {
      return ultimaCaptura;
    },
    /** Empieza a escuchar y devuelve la URL. */
    async escuchar({ puerto = opciones.puerto ?? PUERTO_INICIAL, host = "127.0.0.1" } = {}) {
      await new Promise((resolver, rechazar) => {
        const alError = (excepcion) => rechazar(excepcion);
        servidor.once("error", alError);
        servidor.listen(puerto, host, () => {
          servidor.off("error", alError);
          resolver();
        });
      });
      const direccion = servidor.address();
      return `http://${host}:${direccion.port}`;
    },
    async cerrar() {
      rechazarPendientes("servidor_apagado", "El servidor del modo agente se cerró.");
      if (pagina) pagina.destruir();
      pagina = null;
      await new Promise((resolver) => servidor.close(() => resolver()));
    },
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const argumentos = process.argv.slice(2);
const indicePuerto = argumentos.findIndex((arg) => arg === "--puerto" || arg === "-p");
const puerto = indicePuerto >= 0 ? Number(argumentos[indicePuerto + 1]) : PUERTO_INICIAL;
const abrir = argumentos.includes("--abrir");

const esPrincipal =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (esPrincipal) {
  const servidorAgente = crearServidorAgente({ puerto: Number.isFinite(puerto) ? puerto : PUERTO_INICIAL });
  servidorAgente
    .escuchar()
    .then((url) => {
      console.log("");
      console.log("  Despiece — modo agente");
      console.log("  ─────────────────────────────────────────────");
      console.log(`  App:      ${url}`);
      console.log(`  Token:    ${servidorAgente.token}`);
      console.log(`  Estado:   ${url}/api/estado`);
      console.log(`  Comandos: POST ${url}/api/comando`);
      console.log(`  Captura:  ${url}/api/captura.png`);
      console.log("  ─────────────────────────────────────────────");
      console.log("  Abrí la app en el navegador para conectar el agente.");
      console.log("  Ctrl+C para cortar.");
      console.log("");
      if (abrir) {
        const comando =
          process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : process.platform === "darwin"
              ? ["open", [url]]
              : ["xdg-open", [url]];
        try {
          spawn(comando[0], comando[1], { detached: true, stdio: "ignore" }).unref();
        } catch {
          /* si no se puede abrir, el usuario entra a mano */
        }
      }
    })
    .catch((excepcion) => {
      console.error("No se pudo iniciar el modo agente:", excepcion.message);
      process.exit(1);
    });

  const cerrar = () => {
    servidorAgente.cerrar().finally(() => process.exit(0));
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
}
