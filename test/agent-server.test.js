/**
 * Tests de integración del servidor del modo agente (F2).
 *
 * Simula la página con un cliente WebSocket que aplica comandos con la misma
 * capa de comandos del navegador. Verifica HTTP, WebSocket, token, estados,
 * despiece y capturas, sin necesidad de abrir Chrome.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { crearServidorAgente } from "../dev/agent-server.mjs";
import { crearSesion } from "../src/app/commands.js";
import { proyectoDesdePlantilla } from "../src/app/design.js";
import { TEMPLATES } from "../templates/index.js";
import { compileFurniture } from "../src/engine/compile.js";
import { summarize } from "../src/engine/cutlist.js";

const TOKEN = "token-de-prueba-123456";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let servidor;
let url;
let pagina;

/* ── página simulada ─────────────────────────────────────────────────────── */

class PaginaSimulada {
  constructor() {
    this.sesion = crearSesion({
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
    this.recibidos = [];
  }

  estado() {
    const resultado = compileFurniture(this.sesion.estado.design);
    return {
      revision: this.sesion.revision,
      design: this.sesion.estado.design,
      resumen: summarize(resultado),
      avisos: resultado.issues,
    };
  }

  conectar() {
    return new Promise((resolver, rechazar) => {
      this.ws = new WebSocket(`${url.replace("http", "ws")}/ws?token=${encodeURIComponent(TOKEN)}`);
      this.ws.addEventListener("open", () => {
        this.enviar({ type: "presencia", pagina: true });
        this.enviar({ type: "estado", ...this.estado() });
        resolver(this);
      });
      this.ws.addEventListener("error", (evento) => rechazar(new Error("WebSocket: " + evento.message)));
      this.ws.addEventListener("message", (evento) => this.alMensaje(evento));
    });
  }

  alMensaje(evento) {
    const mensaje = JSON.parse(evento.data);
    this.recibidos.push(mensaje);

    if (mensaje.type === "comando") {
      const respuesta = this.sesion.aplicar(mensaje.nombre, mensaje.argumentos ?? {});
      this.enviar({ type: "resultado", id: mensaje.id, ...respuesta });
      if (respuesta.ok) this.enviar({ type: "estado", ...this.estado() });
      return;
    }

    if (mensaje.type === "captura_solicitud") {
      this.enviar({ type: "captura", id: mensaje.id, png: `data:image/png;base64,${PNG_1X1}` });
    }
  }

  enviar(mensaje) {
    this.ws.send(JSON.stringify(mensaje));
  }

  cerrar() {
    try {
      this.ws?.close();
    } catch {
      /* ignorar */
    }
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const esperar = async (condicion, { tiempo = 3000, intervalo = 25 } = {}) => {
  const inicio = Date.now();
  while (Date.now() - inicio < tiempo) {
    if (await condicion()) return true;
    await new Promise((resolver) => setTimeout(resolver, intervalo));
  }
  return false;
};

const pedir = (ruta, opciones = {}) =>
  fetch(url + ruta, {
    ...opciones,
    headers: { "X-Despiece-Token": TOKEN, "Content-Type": "application/json", ...(opciones.headers ?? {}) },
  });

const comando = async (nombre, argumentos = {}) => {
  const respuesta = await pedir("/api/comando", {
    method: "POST",
    body: JSON.stringify({ nombre, argumentos }),
  });
  return respuesta.json();
};

before(async () => {
  servidor = crearServidorAgente({ token: TOKEN });
  url = await servidor.escuchar({ puerto: 0 });
});

after(async () => {
  pagina?.cerrar();
  await servidor?.cerrar();
});

/* ── tests ───────────────────────────────────────────────────────────────── */

test("sin página conectada: salud responde y los comandos avisan sin_pagina", async () => {
  const salud = await (await fetch(url + "/api/salud")).json();
  assert.equal(salud.ok, true);
  assert.equal(salud.paginaConectada, false);
  assert.equal(typeof salud.motor, "string");

  const respuesta = await comando("agregar_columna", {});
  assert.equal(respuesta.ok, false);
  assert.equal(respuesta.error.codigo, "sin_pagina");
  assert.match(respuesta.error.sugerencia, /navegador/);
});

test("la API exige token", async () => {
  const sinToken = await fetch(url + "/api/estado");
  assert.equal(sinToken.status, 401);
  const cuerpo = await sinToken.json();
  assert.equal(cuerpo.error.codigo, "token_invalido");

  const malToken = await fetch(url + "/api/comando", {
    method: "POST",
    headers: { "X-Despiece-Token": "otro-token", "Content-Type": "application/json" },
    body: JSON.stringify({ nombre: "obtener_estado" }),
  });
  assert.equal(malToken.status, 401);
});

test("la app servida inyecta el token del agente", async () => {
  const html = await (await fetch(url + "/")).text();
  assert.match(html, /__DESPIECE_AGENTE__/);
  assert.match(html, new RegExp(TOKEN));
});

test("con la página conectada los comandos se aplican en vivo", async () => {
  pagina = await new PaginaSimulada().conectar();
  assert.equal(await esperar(async () => (await (await fetch(url + "/api/salud")).json()).paginaConectada), true);

  const antes = pagina.sesion.estado.design.columns.length;
  const respuesta = await comando("agregar_columna", { ancho: 0.7 });
  assert.equal(respuesta.ok, true);
  assert.equal(respuesta.revision, 1);
  assert.equal(pagina.sesion.estado.design.columns.length, antes + 1);

  const estado = await (await pedir("/api/estado")).json();
  assert.equal(estado.ok, true);
  assert.equal(estado.revision, 1);
  assert.equal(estado.design.columns.length, antes + 1);
});

test("el despiece se calcula del lado del servidor", async () => {
  const respuesta = await pedir("/api/despiece");
  const cuerpo = await respuesta.json();
  assert.equal(cuerpo.ok, true);
  assert.ok(cuerpo.lineas.length > 0);
  assert.ok(cuerpo.resumen.parts > 0);
  assert.deepEqual(cuerpo.avisos, []);
});

test("los comandos inválidos devuelven el error de la capa de comandos", async () => {
  const respuesta = await comando("fijar_ancho_columna", { indice: 9, ancho: 0.5 });
  assert.equal(respuesta.ok, false);
  assert.equal(respuesta.error.codigo, "indice_fuera_de_rango");
  assert.match(respuesta.error.sugerencia, /índice/);
});

test("la captura llega como PNG desde la página", async () => {
  const respuesta = await fetch(url + "/api/captura.png", { headers: { "X-Despiece-Token": TOKEN } });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(servidor.ultimaCaptura.length > 0);
});

test("el token también se puede mandar por query", async () => {
  const respuesta = await fetch(`${url}/api/estado?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(respuesta.status, 200);
});

test("al desconectarse la página, el servidor queda sin página", async () => {
  pagina.cerrar();
  assert.equal(await esperar(async () => (await (await fetch(url + "/api/salud")).json()).paginaConectada === false), true);

  const estado = await fetch(url + "/api/estado", { headers: { "X-Despiece-Token": TOKEN } });
  assert.equal(estado.status, 409);

  const respuesta = await comando("obtener_estado");
  assert.equal(respuesta.ok, false);
  assert.equal(respuesta.error.codigo, "sin_pagina");

  const captura = await fetch(url + "/api/captura.png", { headers: { "X-Despiece-Token": TOKEN } });
  assert.equal(captura.status, 409);
});
