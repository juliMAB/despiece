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
