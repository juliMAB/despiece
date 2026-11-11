/**
 * Tests del núcleo MCP: herramientas, recursos y errores, con un cliente falso.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { crearServidorMCP, HERRAMIENTAS } from "../dev/mcp-core.mjs";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function clienteFalso(opciones = {}) {
  const llamadas = [];
  return {
    llamadas,
    comando: async (nombre, argumentos) => {
      llamadas.push({ nombre, argumentos });
      if (opciones.comando) return opciones.comando(nombre, argumentos);
      return { ok: true, revision: 1, resultado: { comando: nombre } };
    },
    estado: async () => opciones.estado?.() ?? { ok: true, revision: 3, design: { columns: [] } },
    despiece: async () =>
      opciones.despiece?.() ?? {
        ok: true,
        lineas: [
          { label: "Lateral", quantity: 2, widthMm: 450, heightMm: 840, thicknessMm: 18, areaM2: 0.756 },
        ],
      },
    captura: async () => Buffer.from(PNG_1X1, "base64"),
    salud: async () => opciones.salud?.() ?? { ok: true, paginaConectada: true, revision: 3 },
  };
}

const mcp = (cliente) => crearServidorMCP({ cliente, version: "0.0.0-test" });
const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

test("initialize negocia versión y anuncia capacidades", async () => {
  const servidor = mcp(clienteFalso());
  const respuesta = await servidor.procesar(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
  assert.equal(respuesta.result.protocolVersion, "2025-06-18");
  assert.equal(respuesta.result.serverInfo.name, "despiece");
  assert.ok(respuesta.result.capabilities.tools);
  assert.ok(respuesta.result.capabilities.resources);
  assert.match(respuesta.result.instructions, /npm run agent/);

  const desconocida = await servidor.procesar(rpc(2, "initialize", { protocolVersion: "1999-01-01" }));
  assert.equal(desconocida.result.protocolVersion, "2024-11-05");
});

test("ping responde vacío", async () => {
  const respuesta = await mcp(clienteFalso()).procesar(rpc(1, "ping"));
  assert.deepEqual(respuesta.result, {});
});

test("tools/list expone una herramienta por comando", async () => {
  const respuesta = await mcp(clienteFalso()).procesar(rpc(1, "tools/list"));
  const nombres = respuesta.result.tools.map((herramienta) => herramienta.name);
  assert.ok(nombres.includes("despiece_agregar_columna"));
  assert.ok(nombres.includes("despiece_obtener_despiece"));
  assert.ok(nombres.includes("despiece_capturar_vista"));
  assert.ok(nombres.includes("despiece_salud"));
  assert.equal(nombres.length, HERRAMIENTAS.length);
  for (const herramienta of respuesta.result.tools) {
    assert.ok(herramienta.name.startsWith("despiece_"));
    assert.ok(herramienta.description.length > 10);
    assert.equal(herramienta.inputSchema.type, "object");
  }
});

test("tools/call ejecuta el comando y devuelve su respuesta", async () => {
  const cliente = clienteFalso();
  const respuesta = await mcp(cliente).procesar(
    rpc(1, "tools/call", { name: "despiece_agregar_columna", arguments: { ancho: 0.5 } }),
  );
  assert.deepEqual(cliente.llamadas[0], { nombre: "agregar_columna", argumentos: { ancho: 0.5 } });
  assert.equal(respuesta.result.isError, undefined);
  const contenido = JSON.parse(respuesta.result.content[0].text);
  assert.equal(contenido.ok, true);
  assert.equal(contenido.resultado.comando, "agregar_columna");
});

test("un error de comando llega como isError con sugerencia", async () => {
  const cliente = clienteFalso({
    comando: async () => ({
      ok: false,
      revision: 0,
      error: { codigo: "indice_fuera_de_rango", mensaje: "No existe la columna 9.", sugerencia: "Usá 0 o 1." },
    }),
  });
  const respuesta = await mcp(cliente).procesar(
    rpc(1, "tools/call", { name: "despiece_quitar_columna", arguments: { indice: 9 } }),
  );
  assert.equal(respuesta.result.isError, true);
  assert.match(respuesta.result.content[0].text, /indice_fuera_de_rango/);
  assert.match(respuesta.result.content[0].text, /Usá 0 o 1/);
});

test("si el servidor no responde, la herramienta explica qué hacer", async () => {
  const cliente = clienteFalso({
    comando: async () => {
      throw new Error("fetch failed");
    },
  });
  const respuesta = await mcp(cliente).procesar(
    rpc(1, "tools/call", { name: "despiece_obtener_estado", arguments: {} }),
  );
  assert.equal(respuesta.result.isError, true);
  assert.match(respuesta.result.content[0].text, /npm run agent/);
});

test("herramienta desconocida devuelve error JSON-RPC", async () => {
  const respuesta = await mcp(clienteFalso()).procesar(
    rpc(1, "tools/call", { name: "despiece_hacer_magia", arguments: {} }),
  );
  assert.equal(respuesta.error.code, -32602);
  assert.match(respuesta.error.message, /Herramienta desconocida/);
});

test("despiece_salud informa el estado sin pedir diseño", async () => {
  const cliente = clienteFalso();
  const respuesta = await mcp(cliente).procesar(
    rpc(1, "tools/call", { name: "despiece_salud", arguments: {} }),
  );
  assert.equal(respuesta.result.isError, undefined);
  assert.equal(JSON.parse(respuesta.result.content[0].text).paginaConectada, true);
  assert.equal(cliente.llamadas.length, 0);
});

test("capturar_vista devuelve texto e imagen", async () => {
  const cliente = clienteFalso({
    comando: async () => ({ ok: true, revision: 1, resultado: { png: `data:image/png;base64,${PNG_1X1}` } }),
  });
  const respuesta = await mcp(cliente).procesar(
    rpc(1, "tools/call", { name: "despiece_capturar_vista", arguments: {} }),
  );
  const imagen = respuesta.result.content.find((parte) => parte.type === "image");
  assert.ok(imagen);
  assert.equal(imagen.mimeType, "image/png");
  assert.equal(Buffer.from(imagen.data, "base64").toString("base64"), PNG_1X1);
});

test("resources/list y resources/read", async () => {
  const servidor = mcp(clienteFalso());
  const lista = await servidor.procesar(rpc(1, "resources/list"));
  const uris = lista.result.resources.map((recurso) => recurso.uri);
  assert.deepEqual(uris, ["despiece://estado", "despiece://despiece", "despiece://captura"]);

  const estado = await servidor.procesar(rpc(2, "resources/read", { uri: "despiece://estado" }));
  const contenidoEstado = estado.result.contents[0];
  assert.equal(contenidoEstado.mimeType, "application/json");
  assert.equal(JSON.parse(contenidoEstado.text).revision, 3);

  const despiece = await servidor.procesar(rpc(3, "resources/read", { uri: "despiece://despiece" }));
  assert.equal(despiece.result.contents[0].mimeType, "text/csv");
  assert.match(despiece.result.contents[0].text, /Lateral/);

  const captura = await servidor.procesar(rpc(4, "resources/read", { uri: "despiece://captura" }));
  assert.equal(captura.result.contents[0].mimeType, "image/png");
  assert.equal(captura.result.contents[0].blob, PNG_1X1);
});

test("recurso desconocido devuelve error", async () => {
  const respuesta = await mcp(clienteFalso()).procesar(
    rpc(1, "resources/read", { uri: "despiece://otro" }),
  );
  assert.equal(respuesta.error.code, -32602);
  assert.match(respuesta.error.message, /Recurso desconocido/);
});

test("las notificaciones no generan respuesta", async () => {
  const servidor = mcp(clienteFalso());
  assert.equal(await servidor.procesar({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await servidor.procesar({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), null);
});

test("un método desconocido con id devuelve -32601", async () => {
  const respuesta = await mcp(clienteFalso()).procesar(rpc(1, "metodo/raro"));
  assert.equal(respuesta.error.code, -32601);
});

test("un mensaje sin method devuelve -32600", async () => {
  const respuesta = await mcp(clienteFalso()).procesar({ jsonrpc: "2.0", id: 1 });
  assert.equal(respuesta.error.code, -32600);
});
