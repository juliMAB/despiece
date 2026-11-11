/**
 * Servidor MCP de Despiece (F3), por stdio.
 *
 * Uso típico: un cliente MCP (Claude Desktop, Cursor, Codex, DSH) lanza este
 * proceso y habla JSON-RPC por stdin/stdout. Las herramientas son los comandos
 * del editor; las respuestas viajan al servidor del modo agente por HTTP y de
 * ahí a la página abierta, que es la fuente de verdad.
 *
 * Si no hay ningún servidor de agentes corriendo, levanta uno embebido (misma
 * app + WebSocket) salvo que se pase DESPIECE_AUTOSTART=0.
 *
 * Variables:
 *   DESPIECE_URL       por defecto http://127.0.0.1:8790
 *   DESPIECE_TOKEN     si falta, se lee .despiece-token
 *   DESPIECE_AUTOSTART "0" desactiva el servidor embebido
 *
 * Importante: stdout es exclusivamente el canal del protocolo; los mensajes
 * humanos van a stderr.
 */

import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { crearServidorMCP } from "./mcp-core.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")).version;
const URL_SERVIDOR = process.env.DESPIECE_URL ?? "http://127.0.0.1:8790";
const AUTOSTART = process.env.DESPIECE_AUTOSTART !== "0";

const registrar = (...partes) => process.stderr.write(partes.join(" ") + "\n");

function leerTokenDeArchivo() {
  try {
    const archivo = join(RAIZ, ".despiece-token");
    return existsSync(archivo) ? readFileSync(archivo, "utf8").trim() : "";
  } catch {
    return "";
  }
}

let token = process.env.DESPIECE_TOKEN ?? leerTokenDeArchivo();
let servidorEmbebido = null;

/* ── cliente HTTP ────────────────────────────────────────────────────────── */

function crearClienteHTTP() {
  const cabeceras = () => ({
    "X-Despiece-Token": token,
    "Content-Type": "application/json",
  });

  async function pedir(ruta, opciones = {}) {
    return fetch(URL_SERVIDOR + ruta, {
      ...opciones,
      headers: { ...cabeceras(), ...(opciones.headers ?? {}) },
    });
  }

  async function leerJson(ruta, opciones = {}) {
    const respuesta = await pedir(ruta, opciones);
    const cuerpo = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
      throw new Error(cuerpo?.error?.mensaje ?? `HTTP ${respuesta.status} en ${ruta}`);
    }
    return cuerpo;
  }

  return {
    url: URL_SERVIDOR,
    async comando(nombre, argumentos) {
      return leerJson("/api/comando", {
        method: "POST",
        body: JSON.stringify({ nombre, argumentos }),
      });
    },
    estado: () => leerJson("/api/estado"),
    despiece: () => leerJson("/api/despiece"),
    async captura() {
      const respuesta = await pedir("/api/captura.png");
      if (!respuesta.ok) {
        const cuerpo = await respuesta.json().catch(() => null);
        throw new Error(cuerpo?.error?.mensaje ?? `HTTP ${respuesta.status} en /api/captura.png`);
      }
      return Buffer.from(await respuesta.arrayBuffer());
    },
    async salud() {
      try {
        const respuesta = await fetch(URL_SERVIDOR + "/api/salud");
        return await respuesta.json();
      } catch (error) {
        return { ok: false, url: URL_SERVIDOR, error: error.message, paginaConectada: false };
      }
    },
  };
}

/* ── arranque del servidor si hace falta ─────────────────────────────────── */

async function asegurarServidor() {
  if (!AUTOSTART) return;

  try {
    const respuesta = await fetch(URL_SERVIDOR + "/api/salud");
    if (respuesta.ok) {
      const salud = await respuesta.json();
      registrar(`[despiece] conectado a ${URL_SERVIDOR} (versión ${salud.motor})`);
      return;
    }
  } catch {
    /* seguimos: no hay servidor */
  }

  const url = new URL(URL_SERVIDOR);
  const puerto = Number(url.port || 80);
  try {
    const { crearServidorAgente } = await import("./agent-server.mjs");
    servidorEmbebido = crearServidorAgente({ token: token || undefined });
    token = token || servidorEmbebido.token;
    const direccion = await servidorEmbebido.escuchar({ puerto, host: url.hostname });
    registrar(`[despiece] servidor embebido en ${direccion}`);
    registrar(`[despiece] abrí la app en el navegador para que el agente se conecte.`);
    registrar(`[despiece] token: ${token}`);
  } catch (error) {
    registrar(
      `[despiece] no se pudo iniciar el servidor en ${URL_SERVIDOR} (${error.message}). ` +
        "Corré `npm run agent` en otra terminal y abrí la app.",
    );
  }
}

await asegurarServidor();

/* ── stdio ───────────────────────────────────────────────────────────────── */

const cliente = crearClienteHTTP();
const { procesar } = crearServidorMCP({ cliente, version: VERSION });

const escribir = (mensaje) => {
  process.stdout.write(JSON.stringify(mensaje) + "\n");
};

const entrada = createInterface({ input: process.stdin, crlfDelay: Infinity });

entrada.on("line", async (linea) => {
  const texto = linea.trim();
  if (!texto) return;

  let mensaje;
  try {
    mensaje = JSON.parse(texto);
  } catch {
    escribir({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
    return;
  }

  try {
    const respuesta = await procesar(mensaje);
    if (respuesta) escribir(respuesta);
  } catch (error) {
    escribir({
      jsonrpc: "2.0",
      id: mensaje?.id ?? null,
      error: { code: -32603, message: error?.message ?? "Error interno" },
    });
  }
});

const cerrar = async () => {
  try {
    entrada.close();
  } catch {
    /* ignorar */
  }
  if (servidorEmbebido) {
    await servidorEmbebido.cerrar().catch(() => {});
  }
  process.exit(0);
};

entrada.on("close", cerrar);
process.on("SIGINT", cerrar);
process.on("SIGTERM", cerrar);
