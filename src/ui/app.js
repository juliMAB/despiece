/**
 * Despiece — aplicación web
 * =========================
 *
 * Editor de muebles paramétrico con despiece en vivo. Todo el cálculo ocurre
 * en el navegador: no hay backend, no hay cuentas y no se envía nada a ningún
 * servidor.
 *
 * Todos los cambios del DISEÑO pasan por la capa de comandos
 * (`src/app/commands.js`), que mantiene el historial y las revisiones. La UI
 * solo dispara comandos y vuelve a dibujar. El estado de vista (2D/3D, medidas,
 * frentes, cámara) no entra al historial: es parte de la interfaz.
 *
 * Estructura de la interfaz:
 *   - barra superior: nombre del proyecto y acciones
 *   - barra lateral: plantillas y proyectos guardados
 *   - panel central: vista 3D/2D, edición de módulos y configuración
 *   - panel derecho: resumen, avisos, despiece y mecanizados
 */

import {
  buildCutlist,
  cutlistToCsv,
  summarize,
  withDefaults,
  ROLE_LABELS,
  compileFurniture,
} from "../index.js";
import { TEMPLATES } from "../../templates/index.js";
import { el, mount, metros, milimetros } from "./dom.js";
import { renderDiagram } from "./render2d.js";
import { crearVisor3D } from "./render3d.js";
import { proyectarPunto } from "./geometry3d.js";
import { crearSesion } from "../app/commands.js";
import {
  LIMITES,
  TIPOS_MODULO,
  normalizarDiseno,
  numero,
  proyectoDesdePlantilla,
} from "../app/design.js";
import * as storage from "./storage.js";

/* ── configuración (solo etiquetas y pasos de la UI) ─────────────────────── */

const CAMPOS_CONFIG = [
  ["depth", "Profundidad", 0.3, 0.9, 0.005],
  ["panelThickness", "Espesor de placa", 0.006, 0.04, 0.001],
  ["backPanelThickness", "Espesor del fondo", 0.002, 0.02, 0.001],
  ["sidePanelOverhang", "Voladizo del lateral", 0, 0.08, 0.005],
  ["panelJointClearance", "Luz de armado", 0, 0.01, 0.001],
  ["frontClearance", "Luz del frente", 0, 0.01, 0.001],
  ["drawerSlidesReserve", "Reserva de corredera", 0, 0.03, 0.001],
  ["backPanelInset", "Retiro del fondo", 0, 0.06, 0.001],
  ["drawerBottomInset", "Retiro fondo de cajón", 0, 0.05, 0.001],
  ["pullHoleDiameter", "Ø del tirador", 0.01, 0.06, 0.001],
  ["pullHoleEdgeInset", "Tirador al borde", 0.01, 0.2, 0.005],
  ["pullHolePairGap", "Separación de tirador", 0.02, 0.2, 0.005],
  ["backPanelGrooveClearance", "Holgura de ranura", 0, 0.005, 0.001],
];

/* ── estado ──────────────────────────────────────────────────────────────── */

const state = {
  sesion: null, // capa de comandos + historial
  resultado: null, // salida del motor
  vista: "despiece", // despiece | mecanizados
  vista3d: storage.leerVista3d(), // true = 3D, false = 2D
  medidas: "hover", // hover | todas | sin
};

/** Proyecto actual (copia del estado de la sesión). */
const proyecto = () => state.sesion.estado;

const $ = (id) => document.getElementById(id);

const refs = {
  nombre: $("nombre-proyecto"),
  listaPlantillas: $("lista-plantillas"),
  listaProyectos: $("lista-proyectos"),
  diagrama: $("diagrama"),
  lienzo2d: document.querySelector("#diagrama .diagram-2d"),
  canvas3d: document.querySelector("#diagrama .diagram-3d"),
  capaMedidas: $("capa-medidas"),
  tooltip: $("tooltip-pieza"),
  selMedidas: $("sel-medidas"),
  chkFrentes: $("chk-frentes"),
  btnAbrir: $("btn-abrir"),
  btnPantalla: $("btn-pantalla"),
  tabsVista: [...document.querySelectorAll(".tab-vista")],
  medidas: $("medidas-exteriores"),
  controles: $("controles"),
  config: $("config"),
  resumen: $("resumen"),
  avisos: $("avisos"),
  tabla: $("tabla"),
  estado: $("estado-guardado"),
  nota: $("nota-tabla"),
  menu: $("menu-panel"),
};

/* ── utilidades ──────────────────────────────────────────────────────────── */

const slug = (texto) =>
  (texto || "mueble")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mueble";

let temporizadorEstado = null;
function anunciar(texto) {
  refs.estado.textContent = texto;
  clearTimeout(temporizadorEstado);
  temporizadorEstado = setTimeout(() => {
    refs.estado.textContent = "";
  }, 4000);
}

let temporizadorGuardado = null;
function autoguardar() {
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(() => {
    storage.guardarActual(proyecto());
    anunciar(
      "Guardado automático " +
        new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
    );
  }, 500);
}

/* ── capa de comandos ────────────────────────────────────────────────────── */

/**
 * Ejecuta un comando y refresca la UI según el tipo de cambio.
 *
 * @param {string} nombre
 * @param {object} [argumentos]
 * @param {{refresco?: "todo"|"salidas"|"ninguno"}} [opciones]
 */
function ejecutar(nombre, argumentos = {}, opciones = {}) {
  const respuesta = state.sesion.aplicar(nombre, argumentos);
  if (!respuesta.ok) {
    anunciar(`No se pudo: ${respuesta.error.mensaje} ${respuesta.error.sugerencia ?? ""}`);
    return respuesta;
  }

  const refresco = opciones.refresco ?? "salidas";
  if (refresco === "todo") {
    refs.nombre.value = proyecto().name;
    compilar();
    renderTodo();
  } else if (refresco === "salidas") {
    compilar();
    renderSalidas();
  } else {
    compilar();
  }
  return respuesta;
}

/* ── acciones de proyecto ────────────────────────────────────────────────── */

/** Carga un proyecto guardado o importado (reinicia la sesión y el historial). */
function abrirProyecto(nuevoProyecto) {
  state.sesion.reiniciar(nuevoProyecto);
  refs.nombre.value = proyecto().name;
  storage.guardarActual(proyecto());
  compilar();
  renderTodo();
  anunciar(`Abierto: ${proyecto().name}`);
}

function abrirPlantilla(template) {
  const respuesta = ejecutar("cargar_plantilla", { plantillaId: template.id }, { refresco: "todo" });
  if (respuesta.ok) {
    storage.guardarActual(proyecto());
    anunciar(`Abierto: ${proyecto().name}`);
  }
}

function abrirEnBlanco() {
  const respuesta = ejecutar("crear_proyecto", {}, { refresco: "todo" });
  if (respuesta.ok) {
    storage.guardarActual(proyecto());
    anunciar("Mueble nuevo");
  }
}

function guardarProyecto() {
  storage.guardarProyecto(proyecto());
  renderProyectos();
  anunciar("Proyecto guardado");
}

function borrarProyectoActual() {
  const { id, name } = proyecto();
  if (!window.confirm(`¿Borrar "${name}"? Esta acción no se puede deshacer.`)) return;
  storage.borrarProyecto(id);
  abrirEnBlanco();
  anunciar("Proyecto borrado");
}

function deshacer() {
  const respuesta = ejecutar("deshacer", {}, { refresco: "todo" });
  if (respuesta.ok) {
    storage.guardarActual(proyecto());
    anunciar("Se deshizo el último cambio");
  }
}

function rehacer() {
  const respuesta = ejecutar("rehacer", {}, { refresco: "todo" });
  if (respuesta.ok) {
    storage.guardarActual(proyecto());
    anunciar("Se rehizo el cambio");
  }
}

function exportarCsv() {
  const resultado = state.resultado ?? compilar();
  const filas = buildCutlist(resultado.parts);
  if (filas.length === 0) {
    anunciar("No hay piezas para exportar");
    return;
  }
  descargar(
    `despiece-${slug(proyecto().name)}.csv`,
    "\uFEFF" + cutlistToCsv(filas),
    "text/csv;charset=utf-8",
  );
  anunciar("CSV descargado");
}

function exportarJson() {
  const contenido = {
    format: "despiece-design",
    version: 1,
    name: proyecto().name,
    design: proyecto().design,
    exportedAt: new Date().toISOString(),
  };
  descargar(
    `despiece-${slug(proyecto().name)}.json`,
    JSON.stringify(contenido, null, 2),
    "application/json",
  );
  anunciar("Diseño exportado");
}

async function importarJson(archivo) {
  try {
    const texto = await archivo.text();
    const data = JSON.parse(texto);
    const design = normalizarDiseno(data);
    const nombre = typeof data?.name === "string" && data.name.trim()
      ? data.name.trim()
      : archivo.name.replace(/\.json$/i, "");
    abrirProyecto({ id: undefined, name: nombre, design });
    anunciar("Diseño importado");
  } catch (error) {
    window.alert("No se pudo importar el archivo:\n" + error.message);
  }
}

function descargar(nombre, contenido, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── motor ───────────────────────────────────────────────────────────────── */

function compilar() {
  state.resultado = compileFurniture(proyecto().design);
  return state.resultado;
}

/* ── visor 3D ────────────────────────────────────────────────────────────── */

let visor3d = null;

/** Crea el visor la primera vez que se necesita. */
function asegurarVisor() {
  if (!visor3d) {
    visor3d = crearVisor3D(refs.canvas3d, {
      mostrarFrentes: refs.chkFrentes.checked,
      alDibujar: (vista) => {
        renderMedidas(vista);
        sincronizarBotonAbrir();
      },
    });
  }
  return visor3d;
}

/** Servicios que la capa de comandos puede usar para la vista. */
function serviciosDeComandos() {
  return {
    get visor() {
      return visor3d;
    },
    fijarVista: (pedido) => aplicarVistaPedida(pedido),
    capturarVista: () => refs.canvas3d.toDataURL("image/png"),
  };
}

/** Aplica un pedido de vista (viene del comando `fijar_vista`). */
function aplicarVistaPedida(pedido) {
  if (pedido.modo) {
    state.vista3d = pedido.modo === "3d";
    storage.guardarVista3d(state.vista3d);
    aplicarVista();
  }
  if (pedido.medidas) {
    state.medidas = pedido.medidas;
    refs.selMedidas.value = pedido.medidas;
    if (state.medidas === "sin") {
      ocultarTooltip();
      asegurarVisor().setResaltada(null);
    }
    renderMedidas(asegurarVisor().vista);
  }
  if (pedido.frentes !== undefined) {
    refs.chkFrentes.checked = pedido.frentes;
    asegurarVisor().setMostrarFrentes(pedido.frentes);
  }
}

/* ── medidas sobre el modelo ─────────────────────────────────────────────── */

/** Medidas de corte de una pieza, en milímetros. */
function dimensionesPieza(parte) {
  const mm = (metros) => Math.round(metros * 1000 * 10) / 10;
  return `${mm(parte.size.width)} × ${mm(parte.size.height)} × ${mm(parte.size.thickness)} mm`;
}

/** Dibuja las cotas generales y/o las etiquetas de cada pieza. */
function renderMedidas(vista) {
  if (!vista || state.medidas === "sin") {
    refs.capaMedidas.replaceChildren();
    return;
  }

  const capa = refs.capaMedidas;
  const nodos = [];
  const crearCota = (contenido, x, y, esPieza) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const nodo = el("div", {
      class: "cota" + (esPieza ? " cota--pieza" : ""),
      style: `left:${x}px; top:${y}px`,
    });
    if (typeof contenido === "string") nodo.textContent = contenido;
    else nodo.append(...contenido);
    return nodo;
  };

  const medidas = state.resultado?.bounds ?? {
    width: vista.max.x - vista.min.x,
    height: vista.max.y - vista.min.y,
    depth: vista.max.z - vista.min.z,
  };
  const centro = {
    x: (vista.min.x + vista.max.x) / 2,
    y: (vista.min.y + vista.max.y) / 2,
    z: (vista.min.z + vista.max.z) / 2,
  };
  const margenLateral = Math.max(0.06, (vista.max.x - vista.min.x) * 0.14);
  const ancho = proyectarPunto({ x: centro.x, y: 0, z: vista.max.z }, vista.camara);
  const alto = proyectarPunto(
    { x: vista.min.x - margenLateral, y: centro.y, z: vista.max.z },
    vista.camara,
  );
  const fondo = proyectarPunto({ x: vista.max.x, y: 0, z: centro.z }, vista.camara);

  nodos.push(
    crearCota(`ancho ${metros(medidas.width)} m`, ancho?.x, (ancho?.y ?? 0) + 18, false),
    crearCota(`alto ${metros(medidas.height)} m`, alto?.x, alto?.y, false),
    crearCota(`fondo ${metros(medidas.depth)} m`, (fondo?.x ?? 0) + 42, (fondo?.y ?? 0) + 10, false),
  );

  if (state.medidas === "todas") {
    const entradas = [];
    for (const pieza of vista.piezas) {
      const p = proyectarPunto(pieza.caja.center, vista.camara);
      if (!p) continue;
      const etiqueta = ROLE_LABELS[pieza.parte.role] ?? pieza.parte.role;
      entradas.push({
        x: p.x,
        y: p.y,
        etiqueta,
        detalle: dimensionesPieza(pieza.parte),
        texto: etiqueta + dimensionesPieza(pieza.parte),
      });
    }

    const anchoEtiqueta = (texto) => Math.max(80, texto.length * 5.8 + 18);
    const colocadas = [];
    for (const entrada of entradas.sort((a, b) => a.y - b.y)) {
      for (let intento = 0; intento < 12; intento++) {
        const choque = colocadas.some(
          (otra) =>
            Math.abs(otra.x - entrada.x) < (otra.ancho + anchoEtiqueta(entrada.texto)) / 2 + 4 &&
            Math.abs(otra.y - entrada.y) < 30,
        );
        if (!choque) break;
        entrada.y += 30;
      }
      colocadas.push({ x: entrada.x, y: entrada.y, ancho: anchoEtiqueta(entrada.texto) });
      nodos.push(
        crearCota(
          [el("b", { text: entrada.etiqueta }), el("br"), document.createTextNode(entrada.detalle)],
          entrada.x,
          entrada.y,
          true,
        ),
      );
    }
  }

  capa.replaceChildren(...nodos.filter(Boolean));
}

function mostrarTooltip(parte, x, y) {
  if (state.medidas === "sin") {
    ocultarTooltip();
    return;
  }
  refs.tooltip.replaceChildren(
    el("b", { text: ROLE_LABELS[parte.role] ?? parte.role }),
    el("br"),
    document.createTextNode(dimensionesPieza(parte)),
  );
  refs.tooltip.style.left = `${x}px`;
  refs.tooltip.style.top = `${y}px`;
  refs.tooltip.hidden = false;
}

function ocultarTooltip() {
  refs.tooltip.hidden = true;
}

/** Mantiene el botón Abrir/Cerrar en sincronía con lo que está abierto. */
let abiertosPrevios = 0;
function sincronizarBotonAbrir() {
  const abiertos = Number(refs.canvas3d.dataset.abiertos ?? 0);
  if (abiertos === abiertosPrevios) return;
  abiertosPrevios = abiertos;
  refs.btnAbrir.textContent = abiertos > 0 ? "Cerrar" : "Abrir";
  refs.btnAbrir.setAttribute("aria-pressed", String(abiertos > 0));
}

/** Aplica el modo de vista (3D o 2D) a la interfaz. */
function aplicarVista() {
  refs.diagrama.classList.toggle("is-3d", state.vista3d);
  for (const tab of refs.tabsVista) {
    const es3d = tab.dataset.vista3d === "3d";
    tab.classList.toggle("is-active", es3d === state.vista3d);
  }
  if (state.vista3d) {
    requestAnimationFrame(() => asegurarVisor().redimensionar());
  }
}

/* ── pantalla completa del visor ─────────────────────────────────────────── */

const tarjetaVista = refs.diagrama.closest(".canvas-card");

function pantallaCompleta(activar) {
  const activa = activar ?? !tarjetaVista.classList.contains("pantalla-completa");
  tarjetaVista.classList.toggle("pantalla-completa", activa);
  document.body.classList.toggle("sin-scroll", activa);
  refs.btnPantalla.setAttribute("aria-pressed", String(activa));
  refs.btnPantalla.textContent = activa ? "✕ Salir" : "⛶ Pantalla";
  requestAnimationFrame(() => asegurarVisor().redimensionar());
}

/* ── renders ─────────────────────────────────────────────────────────────── */

function renderTodo() {
  renderPlantillas();
  renderProyectos();
  renderControles();
  renderConfig();
  renderSalidas();
  actualizarBotonesHistorial();
}

function renderPlantillas() {
  mount(
    refs.listaPlantillas,
    el("button", { class: "chip", type: "button", onclick: abrirEnBlanco }, [
      el("strong", { text: "Empezar de cero" }),
      el("span", { text: "un cuerpo con puertas" }),
    ]),
    TEMPLATES.map((template) =>
      el("button", {
        class: "chip",
        type: "button",
        title: template.description,
        onclick: () => abrirPlantilla(template),
      }, [el("strong", { text: template.name }), el("span", { text: template.description })])
    ),
  );
}

function renderProyectos() {
  const proyectos = storage.listarProyectos();
  if (proyectos.length === 0) {
    mount(
      refs.listaProyectos,
      el("p", { class: "muted", style: "font-size:12px", text: "Todavía no guardaste ninguno." }),
    );
    return;
  }

  const actual = proyecto().id;
  mount(
    refs.listaProyectos,
    proyectos.map((guardado) =>
      el("div", { class: "project-item" + (guardado.id === actual ? " is-active" : "") }, [
        el("button", {
          class: "load",
          type: "button",
          onclick: () => abrirProyecto({
            id: guardado.id,
            name: guardado.name,
            design: structuredClone(guardado.design),
          }),
        }, [
          el("strong", { text: guardado.name }),
          el("span", { text: storage.fechaCorta(guardado.updatedAt) }),
        ]),
        el("button", {
          class: "del",
          type: "button",
          title: "Borrar",
          onclick: () => {
            if (!window.confirm(`¿Borrar "${guardado.name}"?`)) return;
            storage.borrarProyecto(guardado.id);
            if (guardado.id === proyecto().id) abrirEnBlanco();
            else renderProyectos();
          },
        }, "✕"),
      ])
    ),
  );
}

function campoNumero({ valor, min, max, step, sufijo, onInput, ancho = 70 }) {
  return el("span", { class: "field" }, [
    el("input", {
      type: "number",
      value: Number(valor).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
      min, max, step,
      style: `width:${ancho}px`,
      oninput: (event) => {
        const n = numero(event.target.value, Number.NaN);
        if (!Number.isFinite(n)) return;
        onInput(Math.min(max, Math.max(min, n)));
      },
    }),
    sufijo ? el("em", { text: sufijo }) : null,
  ]);
}

function renderControles() {
  const { columns } = proyecto().design;

  mount(
    refs.controles,
    columns.map((column, columnIndex) => {
      const alto = column.modules.reduce((total, mod) => total + mod.height, 0);
      return el("div", { class: "column-card" }, [
        el("div", { class: "column-head" }, [
          el("strong", { text: `Columna ${columnIndex + 1}` }),
          campoNumero({
            valor: column.width,
            min: LIMITES.anchoColumna.min,
            max: LIMITES.anchoColumna.max,
            step: 0.01,
            sufijo: "m",
            ancho: 64,
            onInput: (valor) =>
              ejecutar("fijar_ancho_columna", { indice: columnIndex, ancho: valor }),
          }),
          el("span", { class: "column-total", text: `alto ${metros(alto)} m` }),
          el("button", {
            class: "mini-btn danger",
            type: "button",
            title: "Eliminar columna",
            onclick: () => ejecutar("quitar_columna", { indice: columnIndex }, { refresco: "todo" }),
          }, "Eliminar"),
        ]),

        column.modules.length === 0
          ? el("p", { class: "muted", style: "font-size:12px", text: "Sin módulos." })
          : null,

        column.modules.map((mod, moduleIndex) =>
          el("div", { class: "module-row" }, [
            el("select", {
              "aria-label": "Tipo de módulo",
              onchange: (evento) =>
                ejecutar(
                  "editar_modulo",
                  { columna: columnIndex, modulo: moduleIndex, tipo: evento.target.value },
                  { refresco: "todo" },
                ),
            }, TIPOS_MODULO.map(([tipo, etiqueta]) =>
              el("option", { value: tipo, selected: mod.type === tipo, text: etiqueta })
            )),

            campoNumero({
              valor: mod.height,
              min: LIMITES.altoModulo.min,
              max: LIMITES.altoModulo.max,
              step: 0.01,
              sufijo: "m alto",
              onInput: (valor) =>
                ejecutar("editar_modulo", { columna: columnIndex, modulo: moduleIndex, alto: valor }),
            }),

            mod.type === "drawer"
              ? el("span", { class: "field" }, [
                  el("input", {
                    type: "number",
                    value: mod.drawerCount ?? 2,
                    min: LIMITES.cajones.min,
                    max: LIMITES.cajones.max,
                    step: 1,
                    style: "width:52px",
                    oninput: (evento) => {
                      const cajones = Math.round(numero(evento.target.value, Number.NaN));
                      if (!Number.isFinite(cajones)) return;
                      ejecutar("editar_modulo", {
                        columna: columnIndex,
                        modulo: moduleIndex,
                        cajones,
                      });
                    },
                  }),
                  el("em", { text: "cajones" }),
                ])
              : null,

            el("div", { class: "row-actions" }, [
              el("button", {
                class: "mini-btn",
                type: "button",
                title: "Quitar módulo",
                onclick: () =>
                  ejecutar(
                    "quitar_modulo",
                    { columna: columnIndex, modulo: moduleIndex },
                    { refresco: "todo" },
                  ),
              }, "✕"),
            ]),
          ])
        ),

        el("button", {
          class: "add-btn",
          type: "button",
          style: "margin-top:7px",
          onclick: () =>
            ejecutar(
              "agregar_modulo",
              { columna: columnIndex, tipo: "doors", alto: 0.4 },
              { refresco: "todo" },
            ),
        }, "+ módulo"),
      ]);
    }),
  );
}

function renderConfig() {
  const config = withDefaults(proyecto().design.config);
  mount(
    refs.config,
    CAMPOS_CONFIG.map(([clave, etiqueta, min, max, step]) =>
      el("div", { class: "config-field" }, [
        el("label", { for: `cfg-${clave}`, text: `${etiqueta} (m)` }),
        el("input", {
          id: `cfg-${clave}`,
          type: "number",
          value: Number(config[clave]).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
          min, max, step,
          oninput: (evento) => {
            const valor = numero(evento.target.value, Number.NaN);
            if (!Number.isFinite(valor)) return;
            ejecutar("fijar_config", { valores: { [clave]: valor } });
          },
        }),
      ])
    ),
  );
}

function renderSalidas() {
  const resultado = state.resultado ?? compilar();

  const diagrama = renderDiagram(proyecto().design);
  mount(
    refs.lienzo2d,
    diagrama ?? el("p", { class: "vacio", text: "Agregá una columna para ver el mueble." }),
  );

  const visor = asegurarVisor();
  visor.actualizar(resultado.parts);
  if (state.vista3d) requestAnimationFrame(() => visor.redimensionar());

  refs.medidas.textContent =
    `${metros(resultado.bounds.width)} × ${metros(resultado.bounds.height)} × ${metros(resultado.bounds.depth)} m`;

  renderResumen();
  renderAvisos();
  renderTabla();
  autoguardar();
}

function renderResumen() {
  const resultado = state.resultado;
  const resumen = summarize(resultado);
  const kpis = [
    ["Ancho", `${metros(resumen.width)} m`],
    ["Alto", `${metros(resumen.height)} m`],
    ["Fondo", `${metros(resumen.depth)} m`],
    ["Piezas", String(resumen.parts)],
    ["Líneas", String(resumen.cutRows)],
    ["Mecanizados", String(resumen.operations)],
    ["Paneles", `${resumen.areaM2.toFixed(2).replace(".", ",")} m²`],
    ["Módulos", String(resumen.modules)],
  ];

  mount(
    refs.resumen,
    kpis.map(([etiqueta, valor]) =>
      el("div", { class: "kpi" }, [el("span", { text: etiqueta }), el("b", { text: valor })])
    ),
  );
}

function renderAvisos() {
  const avisos = state.resultado.issues;
  mount(
    refs.avisos,
    avisos.map((aviso) =>
      el("div", { class: "aviso" }, [
        el("strong", { text: aviso.message }),
        el("br"),
        el("code", { text: aviso.code }),
      ])
    ),
  );
}

function renderTabla() {
  if (state.vista === "mecanizados") {
    renderTablaMecanizados();
    return;
  }

  const filas = buildCutlist(state.resultado.parts);
  refs.nota.textContent = "Medidas en milímetros · superficie del panel en m²";
  if (filas.length === 0) {
    mount(refs.tabla, el("p", { class: "tabla-vacia", text: "Sin piezas todavía." }));
    return;
  }

  mount(
    refs.tabla,
    el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Pieza" }),
          el("th", { class: "num", text: "Cant." }),
          el("th", { class: "num", text: "Ancho" }),
          el("th", { class: "num", text: "Alto" }),
          el("th", { class: "num", text: "Espesor" }),
          el("th", { class: "num", text: "m²" }),
        ]),
      ]),
      el("tbody", {}, filas.map((fila) =>
        el("tr", {}, [
          el("td", { text: fila.label }),
          el("td", { class: "num", text: String(fila.quantity) }),
          el("td", { class: "num", text: milimetros(fila.widthMm) }),
          el("td", { class: "num", text: milimetros(fila.heightMm) }),
          el("td", { class: "num", text: milimetros(fila.thicknessMm) }),
          el("td", { class: "num", text: fila.areaM2.toFixed(3).replace(".", ",") }),
        ])
      )),
    ]),
  );
}

function renderTablaMecanizados() {
  const partes = new Map(state.resultado.parts.map((parte) => [parte.key, parte]));
  const operaciones = state.resultado.operations;
  refs.nota.textContent = "Medidas en milímetros · posición desde el centro del panel";

  if (operaciones.length === 0) {
    mount(refs.tabla, el("p", { class: "tabla-vacia", text: "Este mueble no tiene mecanizados." }));
    return;
  }

  const tipo = { "through-hole": "Perforación", "rail-cut": "Ranura" };
  const cara = { front: "frente", back: "atrás" };

  mount(
    refs.tabla,
    el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Pieza" }),
          el("th", { text: "Mecanizado" }),
          el("th", { text: "Cara" }),
          el("th", { class: "num", text: "Ø / ancho" }),
          el("th", { class: "num", text: "Largo" }),
          el("th", { class: "num", text: "X / Y" }),
        ]),
      ]),
      el("tbody", {}, operaciones.map((operacion) => {
        const destino = partes.get(operacion.targetPanelKey);
        return el("tr", {}, [
          el("td", { text: destino ? (ROLE_LABELS[destino.role] ?? destino.role) : operacion.targetPanelKey }),
          el("td", { text: tipo[operacion.operationType] ?? operacion.operationType }),
          el("td", { text: cara[operacion.face] ?? operacion.face }),
          el("td", { class: "num", text: operacion.diameter != null ? `Ø ${milimetros(operacion.diameter * 1000)}` : milimetros((operacion.width ?? 0) * 1000) }),
          el("td", { class: "num", text: operacion.length != null ? milimetros(operacion.length * 1000) : "—" }),
          el("td", { class: "num", text: `${milimetros(operacion.center.x * 1000)} / ${milimetros(operacion.center.y * 1000)}` }),
        ]);
      })),
    ]),
  );
}

/** Habilita/deshabilita las acciones del menú que dependen del historial. */
function actualizarBotonesHistorial() {
  const deshacerBtn = document.querySelector('[data-accion="deshacer"]');
  const rehacerBtn = document.querySelector('[data-accion="rehacer"]');
  if (deshacerBtn) deshacerBtn.disabled = !state.sesion.puedeDeshacer;
  if (rehacerBtn) rehacerBtn.disabled = !state.sesion.puedeRehacer;
}

/* ── eventos ─────────────────────────────────────────────────────────────── */

function conectarEventos() {
  $("btn-guardar").addEventListener("click", guardarProyecto);
  $("btn-csv").addEventListener("click", exportarCsv);

  $("btn-agregar-columna").addEventListener("click", () =>
    ejecutar(
      "agregar_columna",
      { ancho: 0.6, modulo: { tipo: "doors", alto: 0.8 } },
      { refresco: "todo" },
    ),
  );

  // el nombre se confirma al salir del campo (Enter/blur), no en cada tecla
  refs.nombre.addEventListener("change", (evento) => {
    const respuesta = ejecutar("renombrar_proyecto", { nombre: evento.target.value }, { refresco: "ninguno" });
    if (!respuesta.ok) {
      refs.nombre.value = proyecto().name;
      return;
    }
    refs.nombre.value = proyecto().name;
    autoguardar();
  });
  refs.nombre.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") refs.nombre.blur();
  });

  // Menú de acciones
  const botonMenu = $("btn-menu");
  botonMenu.addEventListener("click", (evento) => {
    evento.stopPropagation();
    const abierto = refs.menu.hidden;
    refs.menu.hidden = !abierto;
    botonMenu.setAttribute("aria-expanded", String(abierto));
    actualizarBotonesHistorial();
  });
  document.addEventListener("click", (evento) => {
    if (!refs.menu.hidden && !refs.menu.contains(evento.target) && evento.target !== botonMenu) {
      refs.menu.hidden = true;
      botonMenu.setAttribute("aria-expanded", "false");
    }
  });
  refs.menu.addEventListener("click", (evento) => {
    const accion = evento.target.closest("[data-accion]")?.dataset.accion;
    if (!accion) return;
    refs.menu.hidden = true;
    botonMenu.setAttribute("aria-expanded", "false");
    if (accion === "json") exportarJson();
    if (accion === "importar") $("archivo-importar").click();
    if (accion === "deshacer") deshacer();
    if (accion === "rehacer") rehacer();
    if (accion === "borrar-proyecto") borrarProyectoActual();
  });

  $("archivo-importar").addEventListener("change", (evento) => {
    const archivo = evento.target.files?.[0];
    if (archivo) importarJson(archivo);
    evento.target.value = "";
  });

  for (const tab of document.querySelectorAll(".tab:not(.tab-vista)")) {
    tab.addEventListener("click", () => {
      state.vista = tab.dataset.vista;
      for (const otro of document.querySelectorAll(".tab:not(.tab-vista)")) {
        otro.classList.toggle("is-active", otro === tab);
      }
      renderTabla();
    });
  }

  for (const tab of refs.tabsVista) {
    tab.addEventListener("click", () =>
      ejecutar(
        "fijar_vista",
        { modo: tab.dataset.vista3d },
        { refresco: "ninguno" },
      ),
    );
  }

  refs.chkFrentes.addEventListener("change", (evento) =>
    ejecutar("fijar_vista", { frentes: evento.target.checked }, { refresco: "ninguno" }),
  );

  refs.btnAbrir.addEventListener("click", () => {
    const hayAbiertos = Number(refs.canvas3d.dataset.abiertos ?? 0) > 0;
    ejecutar("abrir_todo", { abierto: !hayAbiertos }, { refresco: "ninguno" });
  });

  refs.selMedidas.addEventListener("change", (evento) =>
    ejecutar("fijar_vista", { medidas: evento.target.value }, { refresco: "ninguno" }),
  );

  refs.canvas3d.addEventListener("pointermove", (evento) => {
    if (!state.vista3d || state.medidas === "sin") return;
    const visor = asegurarVisor();
    if (visor.estado.arrastrando) return;
    const caja = refs.canvas3d.getBoundingClientRect();
    const x = evento.clientX - caja.left;
    const y = evento.clientY - caja.top;
    const elegida = visor.piezaEnPixel(x, y);
    if (!elegida) {
      visor.setResaltada(null);
      ocultarTooltip();
      return;
    }
    visor.setResaltada(elegida.parte.key);
    mostrarTooltip(elegida.parte, x, y);
  });

  refs.canvas3d.addEventListener("pointerleave", () => {
    asegurarVisor().setResaltada(null);
    ocultarTooltip();
  });

  refs.btnPantalla.addEventListener("click", () => pantallaCompleta());

  document.addEventListener("keydown", (evento) => {
    const enCampo = ["INPUT", "SELECT", "TEXTAREA"].includes(evento.target?.tagName);
    if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === "z" && !enCampo) {
      evento.preventDefault();
      if (evento.shiftKey) rehacer();
      else deshacer();
      return;
    }
    if (evento.key === "Escape" && tarjetaVista.classList.contains("pantalla-completa")) {
      pantallaCompleta(false);
    }
  });
}

/* ── arranque ────────────────────────────────────────────────────────────── */

function arrancar() {
  const guardado = storage.leerActual();
  let inicial;
  try {
    inicial = guardado
      ? { id: guardado.id, name: guardado.name, design: normalizarDiseno(guardado.design) }
      : proyectoDesdePlantilla(TEMPLATES[0]);
  } catch {
    inicial = proyectoDesdePlantilla(TEMPLATES[0]);
  }

  state.sesion = crearSesion({
    estadoInicial: inicial,
    servicios: serviciosDeComandos(),
  });
  refs.nombre.value = proyecto().name;

  if (!storage.hayAlmacenamiento()) {
    anunciar("Sin almacenamiento local: los cambios no se guardarán al cerrar");
  }

  conectarEventos();
  compilar();
  renderTodo();
  aplicarVista();
}

arrancar();
