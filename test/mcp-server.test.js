/**
 * Test de integración del servidor MCP por stdio (F3).
 *
 * Levanta el servidor de agentes, conecta una "página" simulada y habla con
 * `dev/mcp-server.mjs` como lo haría un cliente MCP real: JSON por stdin/stdout.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { crearServidorAgente } from "../dev/agent-server.mjs";
import { crearSesion } from "../src/app/commands.js";
import { proyectoDesdePlantilla } from "../src/app/design.js";
import { TEMPLATES } from "../templates/index.js";
import { compileFurniture } from "../src/engine/compile.js";
import { summarize } from "../src/engine/cutlist.js";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "mcp-test-token-123456";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let servidor;
let url;
let clienteMCP;
let pagina;

/* ── cliente MCP por stdio ───────────────────────────────────────────────── */

function crearClienteMCP(entorno) {
  const proceso = spawn(process.execPath, [join(RAIZ, "dev", "mcp-server.mjs")], {
    env: { ...process.env, ...entorno },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pendientes = new Map();
  const errores = [];
  let siguienteId = 0;

  createInterface({ input: proceso.stdout }).on("line", (linea) => {
    let mensaje;
    try {
      mensaje = JSON.parse(linea);
    } catch {
      return;
    }
    const pendiente = pendientes.get(mensaje.id);
    if (pendiente) {
      pendientes.delete(mensaje.id);
      pendiente(mensaje);
    }
  });
  createInterface({ input: proceso.stderr }).on("line", (linea) => errores.push(linea));

  const rpc = (method, params = {}) =>
    new Promise((resolver, rechazar) => {
      const id = ++siguienteId;
      const temporizador = setTimeout(() => {
        pendientes.delete(id);
        rechazar(new Error(`Sin respuesta MCP a ${method} en 8s. stderr: ${errores.slice(-3).join(" | ")}`));
      }, 8000);
      pendientes.set(id, (mensaje) => {
        clearTimeout(temporizador);
        resolver(mensaje);
      });
      proceso.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return {
    rpc,
    errores,
    cerrar() {
      try {
        proceso.stdin.end();
        proceso.kill();
      } catch {
        /* ignorar */
      }
    },
  };
}

/* ── página simulada ─────────────────────────────────────────────────────── */

async function conectarPagina() {
  const sesion = crearSesion({
    estadoInicial: proyectoDesdePlantilla(TEMPLATES[0]),
    servicios: {
      visor: {
        estado: { yaw: 0.6, pitch: 0.4, zoom: 1 },
        setApertura() {},
        setAperturaGrupo() {},
        getAperturaGrupo: () => 0,
        reiniciarCamara() {},
        setCamara() {},
      },
      fijarVista: () => {},
      capturarVista: () => `data:image/png;base64,${PNG_1X1}`,
    },
  });

  const estado = () => {
    const resultado = compileFurniture(sesion.estado.design);
    return {
      revision: sesion.revision,
      design: sesion.estado.design,
      resumen: summarize(resultado),
      avisos: resultado.issues,
    };
  };

  const socket = new WebSocket(`${url.replace("http", "ws")}/ws?token=${encodeURIComponent(TOKEN)}`);
  await new Promise((resolver, rechazar) => {
    socket.addEventListener("open", resolver, { once: true });
    socket.addEventListener("error", () => rechazar(new Error("No se pudo conectar la página")), { once: true });
  });

  socket.send(JSON.stringify({ type: "presencia", pagina: true }));
  socket.send(JSON.stringify({ type: "estado", ...estado() }));

  socket.addEventListener("message", (evento) => {
    const mensaje = JSON.parse(evento.data);
    if (mensaje.type === "comando") {
      const respuesta = sesion.aplicar(mensaje.nombre, mensaje.argumentos ?? {});
      socket.send(JSON.stringify({ type: "resultado", id: mensaje.id, ...respuesta }));
      if (respuesta.ok) socket.send(JSON.stringify({ type: "estado", ...estado() }));
    }
    if (mensaje.type === "captura_solicitud") {
      socket.send(JSON.stringify({ type: "captura", id: mensaje.id, png: `data:image/png;base64,${PNG_1X1}` }));
    }
  });

  return { sesion, socket, cerrar: () => socket.close() };
}

const esperar = async (condicion, tiempo = 4000) => {
  const inicio = Date.now();
  while (Date.now() - inicio < tiempo) {
    if (await condicion()) return true;
    await new Promise((resolver) => setTimeout(resolver, 50));
  }
  return false;
};

before(async () => {
  servidor = crearServidorAgente({ token: TOKEN });
  url = await servidor.escuchar({ puerto: 0 });
  pagina = await conectarPagina();
  await esperar(async () => (await (await fetch(url + "/api/salud")).json()).paginaConectada === true);

  clienteMCP = crearClienteMCP({
    DESPIECE_URL: url,
    DESPIECE_TOKEN: TOKEN,
    DESPIECE_AUTOSTART: "0",
  });
});

after(async () => {
  clienteMCP?.cerrar();
  pagina?.cerrar();
  await servidor?.cerrar();
});

/* ── tests ───────────────────────────────────────────────────────────────── */

test("initialize, tools/list y una edición real por MCP", async () => {
  const inicializacion = await clienteMCP.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(inicializacion.result.serverInfo.name, "despiece");

  const lista = await clienteMCP.rpc("tools/list");
  const nombres = lista.result.tools.map((herramienta) => herramienta.name);
  assert.ok(nombres.includes("despiece_agregar_columna"));

  const antes = pagina.sesion.estado.design.columns.length;
  const llamada = await clienteMCP.rpc("tools/call", {
    name: "despiece_agregar_columna",
    arguments: { ancho: 0.55 },
  });
  assert.equal(llamada.result.isError, undefined);
  const respuesta = JSON.parse(llamada.result.content[0].text);
  assert.equal(respuesta.ok, true);
  assert.equal(respuesta.revision, 1);
  assert.equal(pagina.sesion.estado.design.columns.length, antes + 1);

  const estado = await (await fetch(url + "/api/estado", { headers: { "X-Despiece-Token": TOKEN } })).json();
  assert.equal(estado.revision, 1);
  assert.equal(estado.design.columns.length, antes + 1);
});

test("los recursos devuelven estado y despiece", async () => {
  const estado = await clienteMCP.rpc("resources/read", { uri: "despiece://estado" });
  const contenido = JSON.parse(estado.result.contents[0].text);
  assert.ok(Array.isArray(contenido.design.columns));

  const despiece = await clienteMCP.rpc("resources/read", { uri: "despiece://despiece" });
  assert.match(despiece.result.contents[0].text, /Lateral/);
});

test("deshacer también funciona por MCP", async () => {
  const respuesta = await clienteMCP.rpc("tools/call", { name: "despiece_deshacer", arguments: {} });
  const cuerpo = JSON.parse(respuesta.result.content[0].text);
  assert.equal(cuerpo.ok, true);
  assert.equal(pagina.sesion.estado.design.columns.length, 1);
});

test("un comando inválido llega como error accionable", async () => {
  const respuesta = await clienteMCP.rpc("tools/call", {
    name: "despiece_editar_modulo",
    arguments: { columna: 0, modulo: 99, alto: 0.5 },
  });
  assert.equal(respuesta.result.isError, true);
  assert.match(respuesta.result.content[0].text, /indice_fuera_de_rango/);
  assert.match(respuesta.result.content[0].text, /Usá un índice entre/);
});

test("despiece_salud informa página conectada", async () => {
  const respuesta = await clienteMCP.rpc("tools/call", { name: "despiece_salud", arguments: {} });
  const salud = JSON.parse(respuesta.result.content[0].text);
  assert.equal(salud.ok, true);
  assert.equal(salud.paginaConectada, true);
});
