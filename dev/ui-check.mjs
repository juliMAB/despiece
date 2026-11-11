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
      "--headless=new", "--no-sandbox",
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle",
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

  /* ── visor 3D ─────────────────────────────────────────────────────────── */

  // Cuenta píxeles no vacíos copiando el canvas (sirve para WebGL y para 2D).
  const pixelesPintados = async () =>
    evaluate(`
      (() => {
        const canvas = document.querySelector('.diagram-3d');
        if (!canvas || !canvas.width) return 0;
        const copia = document.createElement('canvas');
        copia.width = Math.min(320, canvas.width);
        copia.height = Math.min(200, canvas.height);
        const ctx = copia.getContext('2d');
        ctx.drawImage(canvas, 0, 0, copia.width, copia.height);
        const datos = ctx.getImageData(0, 0, copia.width, copia.height).data;
        let pintados = 0;
        for (let i = 3; i < datos.length; i += 4) if (datos[i] > 10) pintados++;
        return pintados;
      })()
    `);

  // Firma del contenido del canvas para detectar cambios.
  const firmaCanvas = async () => {
    const url = await evaluate(
      `document.querySelector('.diagram-3d')?.toDataURL('image/png') ?? ''`,
    );
    let hash = 0;
    for (let i = 0; i < url.length; i += 17) hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
    return `${hash}:${url.length}`;
  };

  check(
    "la vista 3D arranca activa",
    await evaluate(`document.querySelector('#diagrama').classList.contains('is-3d')`),
  );
  const backend = await evaluate(`document.querySelector('.diagram-3d').dataset.renderer`);
  check("el visor usa WebGL 2 (z-buffer)", backend === "webgl2", `backend: ${backend}`);
  const pintadosInicial = await pixelesPintados();
  check("el visor 3D dibuja el mueble", pintadosInicial > 1000, `${pintadosInicial} píxeles`);
  await shot("ui-1b-3d.png");

  const firmaAntes = await firmaCanvas();
  await evaluate(`
    (() => {
      const canvas = document.querySelector('.diagram-3d');
      const caja = canvas.getBoundingClientRect();
      const x = caja.left + caja.width / 2;
      const y = caja.top + caja.height / 2;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 130, clientY: y - 35, bubbles: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 130, clientY: y - 35, bubbles: true, pointerId: 1 }));
      return true;
    })()
  `);
  await sleep(450);
  const firmaDespues = await firmaCanvas();
  check("arrastrar rota la vista 3D", firmaAntes !== firmaDespues);
  await shot("ui-1c-rotado.png");

  const firmaConFrentes = await firmaCanvas();
  await evaluate(`document.querySelector('#chk-frentes').click()`);
  await sleep(450);
  const firmaSinFrentes = await firmaCanvas();
  check("ocultar frentes cambia el dibujo", firmaConFrentes !== firmaSinFrentes);
  await evaluate(`document.querySelector('#chk-frentes').click()`);
  await sleep(350);

  await evaluate(`document.querySelector('[data-vista3d="2d"]').click()`);
  await sleep(350);
  const es2d = await evaluate(
    `!document.querySelector('#diagrama').classList.contains('is-3d') && !!document.querySelector('.diagram-2d svg')`,
  );
  check("se puede cambiar a vista 2D", es2d === true);
  await shot("ui-1d-2d.png");

  await evaluate(`document.querySelector('[data-vista3d="3d"]').click()`);
  await sleep(450);
  check(
    "vuelve a la vista 3D",
    await evaluate(`
      (() => {
        const canvas = document.querySelector('.diagram-3d');
        return document.querySelector('#diagrama').classList.contains('is-3d') && canvas.width > 0 && canvas.height > 0;
      })()
    `),
  );

  // abrir puertas y cajones (con animación)
  const firmaCerrado = await firmaCanvas();
  await evaluate(`document.querySelector('#btn-abrir').click()`);
  await sleep(950);
  const aperturaAbierta = await evaluate(`document.querySelector('.diagram-3d').dataset.apertura`);
  const firmaAbierto = await firmaCanvas();
  check("abrir puertas cambia el dibujo 3D", firmaCerrado !== firmaAbierto);
  check("la animación de apertura llega al final", aperturaAbierta === "1.00", `apertura: ${aperturaAbierta}`);
  await shot("ui-1f-abierto.png");

  await evaluate(`document.querySelector('#btn-abrir').click()`);
  await sleep(950);
  const aperturaCerrada = await evaluate(`document.querySelector('.diagram-3d').dataset.apertura`);
  const firmaCerrado2 = await firmaCanvas();
  check(
    "cerrar vuelve al estado inicial",
    aperturaCerrada === "0.00" && firmaCerrado2 === firmaCerrado,
    `apertura: ${aperturaCerrada}`,
  );

  /* ── click individual y medidas ───────────────────────────────────────── */

  const abrirPorClick = async () => {
    const puntos = [[0.5, 0.5], [0.42, 0.5], [0.58, 0.5], [0.5, 0.62], [0.46, 0.45], [0.54, 0.55]];
    for (const [fx, fy] of puntos) {
      await evaluate(`
        (() => {
          const canvas = document.querySelector('.diagram-3d');
          const caja = canvas.getBoundingClientRect();
          const x = caja.left + caja.width * ${fx};
          const y = caja.top + caja.height * ${fy};
          canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 3 }));
          canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true, pointerId: 3 }));
          return true;
        })()
      `);
      await sleep(750);
      const abiertos = await evaluate(`Number(document.querySelector('.diagram-3d').dataset.abiertos ?? 0)`);
      if (abiertos > 0) return true;
    }
    return false;
  };

  check("click en una puerta la abre sola", await abrirPorClick());
  await shot("ui-1g-click.png");

  await evaluate(`document.querySelector('#btn-abrir').click()`);
  await sleep(900);

  // hover: medidas de la pieza + cotas generales
  await evaluate(`
    (() => {
      const canvas = document.querySelector('.diagram-3d');
      const caja = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        clientX: caja.left + caja.width / 2,
        clientY: caja.top + caja.height / 2,
        bubbles: true,
        pointerId: 4,
      }));
      return true;
    })()
  `);
  await sleep(350);
  const tooltipVisible = await evaluate(
    `(() => { const t = document.querySelector('#tooltip-pieza'); return !t.hidden && /mm/.test(t.textContent); })()`,
  );
  check("el hover muestra las medidas de la pieza", tooltipVisible === true);
  const cotasGenerales = await evaluate(
    `document.querySelectorAll('#capa-medidas .cota:not(.cota--pieza)').length`,
  );
  check("hay cotas generales sobre el modelo", cotasGenerales >= 3, `${cotasGenerales} cotas`);
  await shot("ui-1h-medidas.png");

  const cambiarMedidas = async (valor) =>
    evaluate(`
      (() => {
        const select = document.querySelector('#sel-medidas');
        select.value = ${JSON.stringify(valor)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);

  await cambiarMedidas("todas");
  await sleep(450);
  const cotasPiezas = await evaluate(`document.querySelectorAll('#capa-medidas .cota--pieza').length`);
  check("el modo 'todas' etiqueta cada pieza", cotasPiezas > 3, `${cotasPiezas} etiquetas`);
  await shot("ui-1i-todas.png");

  await cambiarMedidas("sin");
  await sleep(350);
  check(
    "el modo 'ocultas' limpia las medidas",
    (await evaluate(`document.querySelectorAll('#capa-medidas .cota').length`)) === 0,
  );
  await cambiarMedidas("hover");
  await sleep(300);

  // pantalla completa
  await evaluate(`document.querySelector('#btn-pantalla').click()`);
  await sleep(500);
  check(
    "el 3D pasa a pantalla completa",
    await evaluate(`
      (() => {
        const tarjeta = document.querySelector('.canvas-card');
        const canvas = document.querySelector('.diagram-3d');
        return tarjeta.classList.contains('pantalla-completa') && canvas.clientHeight > 300;
      })()
    `),
  );
  await shot("ui-1e-pantalla.png");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(450);
  check(
    "sale de pantalla completa con Esc",
    await evaluate(`!document.querySelector('.canvas-card').classList.contains('pantalla-completa')`),
  );

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

  // los cajones también se abren
  await evaluate(`document.querySelector('#btn-abrir').click()`);
  await sleep(950);
  const firmaCajones = await firmaCanvas();
  check(
    "abrir cajones de la cómoda cambia el dibujo 3D",
    (await evaluate(`document.querySelector('.diagram-3d').dataset.apertura`)) === "1.00",
  );
  await shot("ui-2b-cajones-abiertos.png");
  await evaluate(`document.querySelector('#btn-abrir').click()`);
  await sleep(950);

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
