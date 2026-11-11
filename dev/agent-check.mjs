/**
 * Prueba de punta a punta del modo agente (F2) con Chrome.
 *
 * Levanta el servidor de agentes en un puerto libre, abre la app en Chrome y
 * maneja el mueble SOLO con HTTP, verificando que la página se actualice en
 * vivo (sin recargar), que el WebSocket esté conectado y que la captura llegue.
 *
 * Uso: node dev/agent-check.mjs [chrome-port]
 * Requiere Chrome instalado.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { crearServidorAgente } from "./agent-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "..", ".shots");
mkdirSync(shots, { recursive: true });

const PORT = Number(process.argv[2] ?? "9336");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TOKEN = "token-check-" + Math.random().toString(16).slice(2, 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (nombre, ok, detalle = "") => {
  results.push({ nombre, ok, detalle });
  console.log(`${ok ? "✔" : "✖"} ${nombre}${detalle ? " — " + detalle : ""}`);
};

async function chromeReady() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function main() {
  const servidor = crearServidorAgente({ token: TOKEN });
  const url = await servidor.escuchar({ puerto: 0 });
  console.log(`Servidor de agentes en ${url}`);

  const perfil = join(process.env.TEMP ?? ".", `despiece-agente-${Date.now()}`);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new", "--no-sandbox",
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${perfil}`,
      "--window-size=1440,980",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  chrome.unref();

  for (let intento = 0; intento < 40 && !(await chromeReady()); intento++) await sleep(500);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consola = [];

  socket.addEventListener("message", (event) => {
    const mensaje = JSON.parse(event.data);
    if (mensaje.id && pending.has(mensaje.id)) {
      pending.get(mensaje.id)(mensaje);
      pending.delete(mensaje.id);
    } else if (mensaje.method === "Runtime.consoleAPICalled" && mensaje.params.type === "error") {
      consola.push(mensaje.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    } else if (mensaje.method === "Runtime.exceptionThrown") {
      consola.push(mensaje.params.exceptionDetails.exception?.description ?? "excepción");
    }
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });

  const evaluate = async (expression) => {
    const respuesta = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (respuesta.result?.exceptionDetails) {
      throw new Error(
        String(respuesta.result.exceptionDetails.exception?.description ?? respuesta.result.exceptionDetails.text),
      );
    }
    return respuesta.result?.result?.value;
  };

  const captura = async (nombre) => {
    const respuesta = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(shots, nombre), Buffer.from(respuesta.result.data, "base64"));
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

  /** Cliente MCP por stdio, como lo haría Claude Desktop o Cursor. */
  const crearClienteMCP = () => {
    const proceso = spawn(process.execPath, [join(here, "mcp-server.mjs")], {
      env: { ...process.env, DESPIECE_URL: url, DESPIECE_TOKEN: TOKEN, DESPIECE_AUTOSTART: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pendientes = new Map();
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

    const rpc = (method, params = {}) =>
      new Promise((resolver, rechazar) => {
        const id = ++siguienteId;
        const temporizador = setTimeout(() => {
          pendientes.delete(id);
          rechazar(new Error(`MCP sin respuesta a ${method}`));
        }, 8000);
        pendientes.set(id, (mensaje) => {
          clearTimeout(temporizador);
          resolver(mensaje);
        });
        proceso.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    return {
      rpc,
      cerrar() {
        try {
          proceso.stdin.end();
          proceso.kill();
        } catch {
          /* ignorar */
        }
      },
    };
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await sleep(2500);

  const esperar = async (condicion, tiempo = 5000) => {
    const inicio = Date.now();
    while (Date.now() - inicio < tiempo) {
      if (await condicion()) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    const cargada = await esperar(async () => {
      try {
        return ((await evaluate("document.title")) ?? "").startsWith("Despiece");
      } catch {
        return false;
      }
    }, 10000);
    check("la app carga desde el servidor de agentes", cargada === true, String(await evaluate("document.title")));

    // el badge aparece y se conecta el WebSocket
    const badge = await esperar(() =>
      evaluate(
        `(() => { const b = document.querySelector('#estado-agente'); return b && !b.hidden && b.textContent; })()`,
      ).then((texto) => texto === "Agente conectado"),
    );
    check("la página muestra 'Agente conectado'", badge === true, String(await evaluate("document.querySelector('#estado-agente')?.textContent")));
    await captura("agente-1-conectado.png");

    const salud = await (await fetch(url + "/api/salud")).json();
    check("el servidor ve la página conectada", salud.paginaConectada === true);

    const estado = await (await pedir("/api/estado")).json();
    check("GET /api/estado devuelve el diseño", estado.ok === true && Array.isArray(estado.design.columns), `revisión ${estado.revision}`);

    // marca para detectar recargas
    await evaluate("window.__marcaAgente = 1234");

    const anchoAntes = await evaluate("document.querySelector('#medidas-exteriores').textContent");
    const ancho = await comando("fijar_ancho_columna", { indice: 0, ancho: 0.9 });
    const anchoDespues = await evaluate("document.querySelector('#medidas-exteriores').textContent");
    check("un comando HTTP cambia el mueble en vivo", ancho.ok === true && anchoDespues.includes("0,900"), `${anchoAntes} → ${anchoDespues}`);

    const columnasAntes = await evaluate("document.querySelectorAll('.column-card').length");
    const agregar = await comando("agregar_columna", { ancho: 0.5 });
    await sleep(300);
    const columnasDespues = await evaluate("document.querySelectorAll('.column-card').length");
    check("el agente agrega una columna", agregar.ok === true && columnasDespues === columnasAntes + 1, `${columnasAntes} → ${columnasDespues}`);

    const sinRecarga = await evaluate("window.__marcaAgente === 1234");
    check("la página no se recargó", sinRecarga === true);

    // abrir todo por comando (vista)
    const abrir = await comando("abrir_todo", { abierto: true });
    const apertura = await esperar(() => evaluate("document.querySelector('.diagram-3d').dataset.apertura === '1.00'"));
    check("un comando de vista abre puertas y cajones", abrir.ok === true && apertura === true);
    await captura("agente-2-abierto.png");

    // deshacer por comando
    const deshacer = await comando("deshacer", {});
    await sleep(350);
    const columnasTrasDeshacer = await evaluate("document.querySelectorAll('.column-card').length");
    check("deshacer funciona por comando", deshacer.ok === true && columnasTrasDeshacer === columnasAntes, `${columnasDespues} → ${columnasTrasDeshacer}`);

    // despiece desde el servidor
    const despiece = await (await pedir("/api/despiece")).json();
    check("GET /api/despiece trae las líneas de corte", despiece.ok === true && despiece.lineas.length > 0, `${despiece.lineas?.length} líneas`);

    // captura real del canvas
    const respuestaCaptura = await fetch(url + "/api/captura.png", { headers: { "X-Despiece-Token": TOKEN } });
    const png = Buffer.from(await respuestaCaptura.arrayBuffer());
    check(
      "GET /api/captura.png devuelve un PNG real",
      respuestaCaptura.status === 200 && png[0] === 0x89 && png[1] === 0x50 && png.length > 2000,
      `${png.length} bytes`,
    );

    // seguridad
    const sinToken = await fetch(url + "/api/comando", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: "obtener_estado" }),
    });
    check("sin token la API responde 401", sinToken.status === 401);

    const invalido = await comando("fijar_ancho_columna", { indice: 99, ancho: 0.5 });
    check("un comando inválido devuelve error accionable", invalido.ok === false && invalido.error.codigo === "indice_fuera_de_rango");

    // ── MCP por stdio, como un cliente real ────────────────────────────────
    const mcp = crearClienteMCP();
    try {
      const init = await mcp.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "despiece-check", version: "1" },
      });
      check("MCP: initialize negocia con el servidor", init.result?.serverInfo?.name === "despiece", JSON.stringify(init.result?.serverInfo));

      const herramientas = await mcp.rpc("tools/list");
      const nombresHerramientas = (herramientas.result?.tools ?? []).map((herramienta) => herramienta.name);
      check(
        "MCP: tools/list expone los comandos",
        nombresHerramientas.includes("despiece_agregar_columna") && nombresHerramientas.includes("despiece_deshacer"),
        `${nombresHerramientas.length} herramientas`,
      );

      const llamada = await mcp.rpc("tools/call", {
        name: "despiece_fijar_ancho_columna",
        arguments: { indice: 0, ancho: 1.05 },
      });
      await sleep(350);
      const medidasMCP = await evaluate("document.querySelector('#medidas-exteriores').textContent");
      check(
        "MCP: una tool edita el mueble en vivo",
        JSON.parse(llamada.result?.content?.[0]?.text ?? "{}").ok === true && medidasMCP.includes("1,050"),
        medidasMCP,
      );
      await captura("agente-3-mcp.png");

      const recurso = await mcp.rpc("resources/read", { uri: "despiece://estado" });
      const estadoRecurso = JSON.parse(recurso.result?.contents?.[0]?.text ?? "{}");
      check(
        "MCP: resources/read devuelve el estado",
        Array.isArray(estadoRecurso.design?.columns),
        `${estadoRecurso.design?.columns?.length ?? 0} columnas`,
      );

      const capturaMCP = await mcp.rpc("tools/call", { name: "despiece_capturar_vista", arguments: {} });
      const imagenMCP = capturaMCP.result?.content?.find((parte) => parte.type === "image");
      check(
        "MCP: capturar_vista devuelve una imagen",
        Boolean(imagenMCP) && imagenMCP.mimeType === "image/png",
        `${imagenMCP?.data?.length ?? 0} caracteres base64`,
      );

      const deshacerMCP = await mcp.rpc("tools/call", { name: "despiece_deshacer", arguments: {} });
      await sleep(300);
      const medidasTrasDeshacer = await evaluate("document.querySelector('#medidas-exteriores').textContent");
      check(
        "MCP: deshacer también funciona",
        JSON.parse(deshacerMCP.result?.content?.[0]?.text ?? "{}").ok === true && medidasTrasDeshacer.includes("0,900"),
        medidasTrasDeshacer,
      );
    } finally {
      mcp.cerrar();
    }

    // ── F4: log de comandos, resaltado y desconexión ───────────────────────
    const columnasF4 = await evaluate("document.querySelectorAll('.column-card').length");
    const comandoF4 = await comando("agregar_columna", { ancho: 0.4 });
    await sleep(500);
    const resaltadas = Number(await evaluate("document.querySelector('.diagram-3d').dataset.resaltadas ?? 0"));
    check(
      "F4: el agente resalta las piezas que cambió",
      comandoF4.ok === true && resaltadas > 0,
      `${resaltadas} piezas resaltadas`,
    );

    await evaluate(`document.querySelector('#estado-agente').click()`);
    await sleep(250);
    const panelVisible = await evaluate(`!document.querySelector('#agente-panel').hidden`);
    const entradasLog = await evaluate("document.querySelectorAll('#agente-log li').length");
    const logTexto = await evaluate("document.querySelector('#agente-log').textContent");
    check(
      "F4: el panel muestra el log del agente",
      panelVisible === true && entradasLog > 0 && /agregar columna/.test(logTexto),
      `${entradasLog} entradas`,
    );
    await captura("agente-4-log.png");

    await comando("deshacer", {});
    await sleep(350);
    check(
      "F4: el agente puede deshacer su propio cambio",
      (await evaluate("document.querySelectorAll('.column-card').length")) === columnasF4,
    );

    // desconectar y reconectar
    await evaluate(`document.querySelector('#btn-agente-desconectar').click()`);
    const desconectado = await esperar(() =>
      evaluate(`document.querySelector('#estado-agente')?.textContent ?? ""`).then((texto) =>
        texto.toLowerCase().includes("desconectado"),
      ),
    );
    check("F4: se puede desconectar el agente", desconectado === true, String(await evaluate("document.querySelector('#estado-agente')?.textContent")));

    await evaluate(`document.querySelector('#estado-agente').click()`);
    await sleep(200);
    await evaluate(`document.querySelector('#btn-agente-conectar').click()`);
    const reconectado = await esperar(() =>
      evaluate(`document.querySelector('#estado-agente')?.textContent ?? ""`).then((texto) =>
        texto.includes("Agente conectado"),
      ),
      10000,
    );
    check("F4: se puede reconectar el agente", reconectado === true, String(await evaluate("document.querySelector('#estado-agente')?.textContent")));
    const saludFinal = await (await fetch(url + "/api/salud")).json();
    check("F4: el servidor vuelve a ver la página", saludFinal.paginaConectada === true);

    check("sin errores de consola", consola.length === 0, consola.join(" | ").slice(0, 300));
  } finally {
    socket.close();
    try {
      process.kill(chrome.pid);
    } catch {
      /* ignorar */
    }
    await servidor.cerrar();
  }

  const fallos = results.filter((resultado) => !resultado.ok);
  console.log(
    fallos.length === 0
      ? `\n✔ ${results.length} verificaciones OK`
      : `\n✖ ${fallos.length} de ${results.length} fallaron`,
  );
  process.exitCode = fallos.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("FALLO:", error.message);
  process.exitCode = 1;
});
