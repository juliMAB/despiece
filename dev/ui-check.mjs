/**
 * Prueba automatizada de la interfaz con Chrome (CDP).
 *
 * Abre la app, la maneja como un usuario y verifica que:
 *   - cargue sin errores de consola;
 *   - las plantillas se abran y cambien el despiece;
 *   - editar medidas recalcule el resumen;
 *   - guardar persista en localStorage y sobreviva a un recargado;
 *   - las pestañas Despiece / Mecanizados muestren datos.
 *
 * Uso: node dev/ui-check.mjs [url] [chrome-port]
 * Requiere Chrome instalado.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "..", ".shots");
mkdirSync(shots, { recursive: true });

const APP_URL = process.argv[2] ?? "http://127.0.0.1:8080/";
const PORT = Number(process.argv[3] ?? "9334");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
};

async function chromeReady() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function main() {
  const profile = join(process.env.TEMP ?? ".", `despiece-ui-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new", "--no-sandbox", "--disable-gpu",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,980",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  for (let attempt = 0; attempt < 40 && !(await chromeReady()); attempt++) await sleep(500);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consola = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consola.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    } else if (message.method === "Runtime.exceptionThrown") {
      consola.push(message.params.exceptionDetails.exception?.description ?? "excepción");
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
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        String(
          response.result.exceptionDetails.exception?.description ??
            response.result.exceptionDetails.text,
        ),
      );
    }
    return response.result?.result?.value;
  };

  const shot = async (name) => {
    const response = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(shots, name), Buffer.from(response.result.data, "base64"));
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  // 1) carga inicial
  const titulo = await evaluate("document.querySelector('.brand-text h1')?.textContent");
  check("la app carga", titulo === "Despiece", `título: ${titulo}`);
  const kpisIniciales = await evaluate(
    "[...document.querySelectorAll('.kpi b')].map((nodo) => nodo.textContent)",
  );
  check("hay resumen con datos", Array.isArray(kpisIniciales) && kpisIniciales.length > 5);
  const filasIniciales = await evaluate("document.querySelectorAll('#tabla tbody tr').length");
  check("hay despiece inicial", filasIniciales > 0, `${filasIniciales} líneas`);
  await shot("ui-1-inicial.png");

  // 2) abrir una plantilla (cómoda)
  await evaluate(`
    (() => {
      const chip = [...document.querySelectorAll('#lista-plantillas .chip')]
        .find((boton) => /Cómoda/.test(boton.textContent));
      chip.click();
      return true;
    })()
  `);
  await sleep(600);
  const kpisComoda = await evaluate(
    "[...document.querySelectorAll('.kpi b')].map((nodo) => nodo.textContent)",
  );
  check("cambia de plantilla", JSON.stringify(kpisComoda) !== JSON.stringify(kpisIniciales));
  await shot("ui-2-comoda.png");

  // 3) editar la profundidad y ver que cambie el alto/profundidad del resumen
  const antesProfundidad = await evaluate(
    `document.querySelector('#cfg-depth').value`,
  );
  await evaluate(`
    (() => {
      const input = document.querySelector('#cfg-depth');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '0.60');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const textoMedidas = await evaluate("document.querySelector('#medidas-exteriores').textContent");
  check("editar profundidad recalcula", textoMedidas.includes("0,600"), textoMedidas);

  // 4) agregar una columna
  const anchoAntes = await evaluate("document.querySelector('#medidas-exteriores').textContent");
  await evaluate(`document.querySelector('#btn-agregar-columna').click()`);
  await sleep(500);
  const anchoDespues = await evaluate("document.querySelector('#medidas-exteriores').textContent");
  check("agregar columna cambia el ancho", anchoAntes !== anchoDespues, `${anchoAntes} → ${anchoDespues}`);
  await shot("ui-3-columna.png");

  // 5) pestaña de mecanizados
  await evaluate(`document.querySelector('[data-vista="mecanizados"]').click()`);
  await sleep(400);
  const filasMec = await evaluate("document.querySelectorAll('#tabla tbody tr').length");
  check("pestaña mecanizados muestra filas", filasMec > 0, `${filasMec} filas`);
  await shot("ui-4-mecanizados.png");

  // 6) guardar y verificar localStorage
  const nombre = "Prueba automática";
  await evaluate(`
    (() => {
      const input = document.querySelector('#nombre-proyecto');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(nombre)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-guardar').click();
      return true;
    })()
  `);
  await sleep(700);
  const proyectos = await evaluate(
    "JSON.parse(localStorage.getItem('despiece:proyectos:v1') ?? '[]').map((p) => p.name)",
  );
  check("guardar agrega el proyecto", Array.isArray(proyectos) && proyectos.includes(nombre), JSON.stringify(proyectos));
  const enLista = await evaluate(
    `[...document.querySelectorAll('#lista-proyectos .project-item strong')].some((n) => n.textContent === ${JSON.stringify(nombre)})`,
  );
  check("el proyecto aparece en la barra lateral", enLista === true);

  // 7) recargar y comprobar persistencia
  const anchoGuardado = await evaluate("document.querySelector('#medidas-exteriores').textContent");
  await send("Page.reload");
  await sleep(2500);
  const nombreTrasRecarga = await evaluate("document.querySelector('#nombre-proyecto').value");
  const anchoTrasRecarga = await evaluate("document.querySelector('#medidas-exteriores').textContent");
  check("persiste el nombre tras recargar", nombreTrasRecarga === nombre, nombreTrasRecarga);
  check("persiste el diseño tras recargar", anchoTrasRecarga === anchoGuardado, `${anchoGuardado} / ${anchoTrasRecarga}`);
  await shot("ui-5-recargado.png");

  // 8) sin errores de consola
  check("sin errores de consola", consola.length === 0, consola.join(" | ").slice(0, 300));

  socket.close();
  try {
    process.kill(child.pid);
  } catch {
    /* ignorar */
  }

  const fallos = results.filter((result) => !result.ok);
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
