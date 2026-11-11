/**
 * Núcleo del adaptador MCP de Despiece (F3).
 *
 * Traduce el protocolo MCP (JSON-RPC 2.0) a la API del servidor de agentes.
 * Es independiente del transporte: `dev/mcp-server.mjs` lo conecta a stdio y
 * los tests lo usan en memoria con un cliente falso.
 *
 * Herramientas: una por comando de la capa de comandos (`despiece_<comando>`),
 * más `despiece_salud`. Recursos: estado, despiece en CSV y captura del visor.
 */

import { COMANDOS, ESQUEMAS } from "../src/app/commands.js";
import { cutlistToCsv } from "../src/engine/cutlist.js";

const VERSIONES_MCP = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_MCP_POR_DEFECTO = "2024-11-05";

const INSTRUCCIONES = [
  "Servidor MCP de Despiece: edita un mueble paramétrico en una app abierta en el navegador.",
  "Antes de editar, usá despiece_obtener_estado o despiece_obtener_diseno para conocer el diseño actual.",
  "Los comandos de edición devuelven { ok, revision, resultado } o { ok:false, error:{codigo,mensaje,sugerencia} }.",
  "Si una herramienta devuelve 'sin_pagina', pedile al usuario que abra la app con `npm run agent`.",
  "Usá despiece_capturar_vista para ver el resultado y despiece_obtener_despiece para la lista de corte.",
].join(" ");

/** Herramientas expuestas: una por comando, más salud del servidor. */
export const HERRAMIENTAS = [
  ...Object.entries(COMANDOS).map(([nombre, comando]) => ({
    name: `despiece_${nombre}`,
    description: `${comando.descripcion} Argumentos: ${comando.argumentos}`,
    inputSchema: ESQUEMAS[nombre] ?? { type: "object", properties: {}, additionalProperties: false },
    comando: nombre,
  })),
  {
    name: "despiece_salud",
    description:
      "Estado del servidor del modo agente: versión, si hay una página conectada y la revisión actual. Sirve para diagnosticar antes de editar.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    especial: "salud",
  },
];

const RECURSOS = [
  {
    uri: "despiece://estado",
    name: "Estado del diseño",
    description: "Diseño actual (columnas, módulos y configuración) con su revisión y resumen.",
    mimeType: "application/json",
  },
  {
    uri: "despiece://despiece",
    name: "Lista de corte",
    description: "Despiece agrupado en CSV: pieza, cantidad, medidas y superficie.",
    mimeType: "text/csv",
  },
  {
    uri: "despiece://captura",
    name: "Captura del visor",
    description: "Imagen PNG del visor 3D con el mueble actual.",
    mimeType: "image/png",
  },
];

const respuestaTexto = (texto, isError = false) => ({
  content: [{ type: "text", text: texto }],
  ...(isError ? { isError: true } : {}),
});

const jsonTexto = (valor) => JSON.stringify(valor, null, 2);

function errorConexion(error) {
  return respuestaTexto(
    [
      "No se pudo conectar con el servidor del modo agente.",
      `Detalle: ${error?.message ?? error}`,
      "Iniciá el servidor con `npm run agent` y abrí la app en el navegador para que se conecte.",
    ].join("\n"),
    true,
  );
}

/**
 * Crea el procesador MCP.
 *
 * @param {{
 *   cliente: {
 *     comando: (nombre: string, argumentos: object) => Promise<object>,
 *     estado: () => Promise<object>,
 *     despiece: () => Promise<object>,
 *     captura: () => Promise<Buffer>,
 *     salud: () => Promise<object>,
 *     url?: string,
 *   },
 *   version?: string,
 * }} opciones
 */
export function crearServidorMCP({ cliente, version = "0.0.0" }) {
  async function llamarHerramienta(herramienta, argumentos) {
    try {
      if (herramienta.especial === "salud") {
        return respuestaTexto(jsonTexto(await cliente.salud()));
      }

      const respuesta = await cliente.comando(herramienta.comando, argumentos ?? {});
      if (!respuesta || respuesta.ok !== true) {
        return respuestaTexto(
          [
            "El comando falló.",
            jsonTexto(respuesta?.error ?? respuesta ?? {}),
            respuesta?.error?.sugerencia ?? "",
          ]
            .filter(Boolean)
            .join("\n"),
          true,
        );
      }

      if (herramienta.comando === "capturar_vista" && respuesta.resultado?.png) {
        const base64 = String(respuesta.resultado.png).replace(/^data:image\/png;base64,/, "");
        return {
          content: [
            { type: "text", text: "Captura actual del mueble." },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }

      return respuestaTexto(jsonTexto(respuesta));
    } catch (error) {
      return errorConexion(error);
    }
  }

  async function leerRecurso(uri) {
    try {
      if (uri === "despiece://estado") {
        const estado = await cliente.estado();
        return { contents: [{ uri, mimeType: "application/json", text: jsonTexto(estado) }] };
      }
      if (uri === "despiece://despiece") {
        const despiece = await cliente.despiece();
        const csv = cutlistToCsv(despiece.lineas ?? []);
        return { contents: [{ uri, mimeType: "text/csv", text: csv }] };
      }
      if (uri === "despiece://captura") {
        const png = await cliente.captura();
        return {
          contents: [{ uri, mimeType: "image/png", blob: Buffer.from(png).toString("base64") }],
        };
      }
      throw new Error(`Recurso desconocido: ${uri}`);
    } catch (error) {
      if (error?.message?.startsWith("Recurso desconocido")) throw error;
      throw new Error(
        `No se pudo leer ${uri}: ${error?.message ?? error}. Revisá que el servidor esté activo (npm run agent).`,
      );
    }
  }

  /**
   * Procesa un mensaje JSON-RPC.
   * @param {object} mensaje
   * @returns {Promise<object|null>} respuesta o null si es una notificación.
   */
  async function procesar(mensaje) {
    const id = mensaje?.id;
    const esNotificacion = id === undefined || id === null;
    const responder = (resultado) => (esNotificacion ? null : { jsonrpc: "2.0", id, result: resultado });
    const fallar = (codigo, texto) =>
      esNotificacion ? null : { jsonrpc: "2.0", id, error: { code: codigo, message: texto } };

    const metodo = mensaje?.method;
    if (typeof metodo !== "string") {
      return fallar(-32600, "Pedido inválido: falta method.");
    }

    const parametros = mensaje.params ?? {};

    if (metodo === "initialize") {
      const pedida = parametros.protocolVersion;
      const versionNegociada = VERSIONES_MCP.includes(pedida) ? pedida : VERSION_MCP_POR_DEFECTO;
      return responder({
        protocolVersion: versionNegociada,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "despiece", version },
        instructions: INSTRUCCIONES,
      });
    }

    if (metodo === "ping") return responder({});

    if (metodo === "tools/list") {
      return responder({
        tools: HERRAMIENTAS.map(({ comando, especial, ...herramienta }) => herramienta),
      });
    }

    if (metodo === "tools/call") {
      const nombre = parametros.name;
      const herramienta = HERRAMIENTAS.find((item) => item.name === nombre);
      if (!herramienta) {
        return fallar(-32602, `Herramienta desconocida: ${nombre}. Usá tools/list.`);
      }
      return responder(await llamarHerramienta(herramienta, parametros.arguments));
    }

    if (metodo === "resources/list") {
      return responder({ resources: RECURSOS });
    }

    if (metodo === "resources/read") {
      const uri = parametros.uri;
      if (typeof uri !== "string") return fallar(-32602, "Falta el uri del recurso.");
      try {
        return responder(await leerRecurso(uri));
      } catch (error) {
        return fallar(-32602, error.message);
      }
    }

    // notificaciones del cliente (initialized, cancelled, …)
    if (metodo.startsWith("notifications/")) return null;

    return fallar(-32601, `Método no soportado: ${metodo}`);
  }

  return { procesar, herramientas: HERRAMIENTAS, recursos: RECURSOS, instrucciones: INSTRUCCIONES };
}
