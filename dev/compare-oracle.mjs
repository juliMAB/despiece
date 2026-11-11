/**
 * Comparación contra el ORÁCULO (solo para desarrollo, no se publica).
 * --------------------------------------------------------------------
 * Corre el motor original archivado (en el repo privado de restauración) en un
 * Chrome headless y lo compara pieza por pieza contra nuestro motor.
 *
 * El oráculo NO forma parte de Despiece: es una herramienta de verificación
 * durante la reescritura. Vive fuera del repo público y necesita:
 *   - el repo privado madera-app-restauracion servible en http://127.0.0.1:8791
 *   - Chrome instalado
 *
 * Uso:
 *   node dev/compare-oracle.mjs [--designs <dir>] [--url <url>]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { compileFurniture } from "../src/engine/compile.js";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const DESIGNS_DIR = argOf(
  "--designs",
  "C:/Repos/Madera-app/restauracion/public/herramienta/disenos",
);
const APP_URL = argOf("--url", "http://127.0.0.1:8791/");
const CHROME_PORT = Number(argOf("--chrome-port", "9333"));
const CHROME_PATH =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const r3 = (value) => Math.round(Number(value) * 1000) / 1000;

/* ── normalización ──────────────────────────────────────────────────────── */

function partSignature(part) {
  return [
    part.role,
    r3(part.position.x), r3(part.position.y), r3(part.position.z),
    r3(part.size.width), r3(part.size.height), r3(part.size.thickness),
    part.orientation,
  ].join("|");
}

function operationSignature(op, partsByKey) {
  const target = partsByKey.get(op.targetPanelKey);
  const targetSignature = target ? partSignature(target) : op.targetPanelKey;
  const fields = [op.operationType, op.face, targetSignature, r3(op.center.x), r3(op.center.y)];
  if (op.diameter != null) fields.push(`d=${r3(op.diameter)}`);
  if (op.width != null) fields.push(`w=${r3(op.width)}`);
  if (op.length != null) fields.push(`l=${r3(op.length)}`);
  if (op.depth != null) fields.push(`depth=${r3(op.depth)}`);
  if (op.rotation != null) fields.push(`rot=${r3(op.rotation)}`);
  if (op.through != null) fields.push(`through=${op.through}`);
  return fields.join("|");
}

function normalize(result) {
  const parts = result.parts ?? [];
  const partsByKey = new Map(parts.map((part) => [part.key, part]));
  return {
    parts: parts.map(partSignature).sort(),
    operations: (result.operations ?? [])
      .map((op) => operationSignature(op, partsByKey))
      .sort(),
    bounds: {
      width: r3(result.bounds?.width),
      height: r3(result.bounds?.height),
      depth: r3(result.bounds?.depth),
    },
    issues: (result.issues ?? []).map((item) => item.code).sort(),
  };
}

function diffArrays(label, expected, actual) {
  const problems = [];
  if (expected.length !== actual.length) {
    problems.push(`  ${label}: cantidad ${actual.length} vs ${expected.length}`);
  }
  const count = (list) => list.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
  const expectedCount = count(expected);
  const actualCount = count(actual);

  for (const [item, times] of expectedCount) {
    const got = actualCount.get(item) ?? 0;
    if (got !== times) problems.push(`  ${label} FALTA (${times - got}/${times}): ${item}`);
  }
  for (const [item, times] of actualCount) {
    const wanted = expectedCount.get(item) ?? 0;
    if (gotDifference(times, wanted)) problems.push(`  ${label} SOBRA (${times - wanted}): ${item}`);
  }
  return problems;
}

function gotDifference(times, wanted) {
  return times - wanted > 0;
}

/* ── Chrome / CDP ───────────────────────────────────────────────────────── */

async function chromeReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureChrome() {
  if (await chromeReady()) return null;

  const profile = join(process.env.TEMP ?? ".", `despiece-oracle-${Date.now()}`);
  const child = spawn(
    CHROME_PATH,
    [
      "--headless=new", "--no-sandbox", "--disable-gpu",
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1200,800",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await chromeReady()) return child.pid;
    await sleep(500);
  }
  throw new Error("Chrome no arrancó en el puerto " + CHROME_PORT);
}

async function evaluateInPage(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("No hay pestaña de Chrome");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let messageId = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++messageId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: APP_URL });
  await sleep(3500);

  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  socket.close();

  if (result.result?.exceptionDetails) {
    throw new Error(
      "Error en el navegador: " +
        (result.result.exceptionDetails.exception?.description ??
          result.result.exceptionDetails.text),
    );
  }
  return result.result?.result?.value;
}

/* ── ejecución ──────────────────────────────────────────────────────────── */

function loadDesigns() {
  return readdirSync(DESIGNS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(DESIGNS_DIR, name), "utf8"));
      return { name, design: raw.data ?? raw };
    });
}

async function main() {
  const designs = loadDesigns();
  console.log(`Oráculo: ${APP_URL}`);
  console.log(`Diseños: ${designs.length} en ${DESIGNS_DIR}\n`);

  const spawnedPid = await ensureChrome();
  let failures = 0;

  try {
    for (const { name, design } of designs) {
      const oracleResult = await evaluateInPage(`
        (async () => {
          const module = await import('/_nuxt/Dt_x5Iy5.js');
          const design = ${JSON.stringify(design)};
          return module.c(design.columns, design.config);
        })()
      `);

      const ours = normalize(compileFurniture(design));
      const oracle = normalize(oracleResult);

      const problems = [
        ...diffArrays("pieza", oracle.parts, ours.parts),
        ...diffArrays("mecanizado", oracle.operations, ours.operations),
        ...diffArrays("aviso", oracle.issues, ours.issues),
      ];

      const boundsOk =
        oracle.bounds.width === ours.bounds.width &&
        oracle.bounds.height === ours.bounds.height &&
        oracle.bounds.depth === ours.bounds.depth;

      const status = problems.length === 0 && boundsOk ? "OK  " : "DIFF";
      if (status === "DIFF") failures++;

      console.log(
        `${status} ${name.padEnd(22)} piezas ${String(ours.parts.length).padStart(3)}/${String(oracle.parts.length).padEnd(3)}` +
          ` mecanizados ${String(ours.operations.length).padStart(3)}/${String(oracle.operations.length).padEnd(3)}` +
          ` bounds ${ours.bounds.width}×${ours.bounds.height}×${ours.bounds.depth}` +
          (boundsOk ? "" : " ⚠ bounds"),
      );

      for (const problem of problems.slice(0, 12)) console.log(problem);
      if (problems.length > 12) console.log(`  … y ${problems.length - 12} diferencias más`);
    }
  } finally {
    if (spawnedPid) {
      try {
        process.kill(spawnedPid);
      } catch {
        /* ignorar */
      }
    }
  }

  console.log(
    failures === 0
      ? `\n✔ Los ${designs.length} diseños coinciden exactamente con el oráculo.`
      : `\n✗ ${failures} de ${designs.length} diseños con diferencias.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("FALLO:", error.message);
  process.exitCode = 1;
});
