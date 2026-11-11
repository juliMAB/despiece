/**
 * Despiece — aplicación web
 * =========================
 *
 * Editor de muebles paramétrico con despiece en vivo. Todo el cálculo ocurre
 * en el navegador: no hay backend, no hay cuentas y no se envía nada a ningún
 * servidor.
 *
 * Estructura de la interfaz:
 *   - barra superior: nombre del proyecto y acciones
 *   - barra lateral: plantillas y proyectos guardados
 *   - panel central: diagrama 2D, edición de módulos y configuración
 *   - panel derecho: resumen, avisos, despiece y mecanizados
 */

import {
  compileFurniture,
  buildCutlist,
  cutlistToCsv,
  summarize,
  DEFAULT_CONFIG,
  withDefaults,
  ROLE_LABELS,
} from "../index.js";
import { TEMPLATES } from "../../templates/index.js";
import { el, mount, metros, milimetros } from "./dom.js";
import { renderDiagram } from "./render2d.js";
import { crearVisor3D } from "./render3d.js";
import * as storage from "./storage.js";

/* ── tipos de módulo ─────────────────────────────────────────────────────── */

const TIPOS_MODULO = [
  ["doors", "Puertas (par)"],
  ["left-door", "Puerta izq."],
  ["right-door", "Puerta der."],
  ["drawer", "Cajones"],
  ["shelf", "Estante"],
];

const TIPOS_VALIDOS = new Set(TIPOS_MODULO.map(([tipo]) => tipo));

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
  project: null, // { id, name, design }
  resultado: null, // salida del motor
  vista: "despiece", // despiece | mecanizados
  vista3d: storage.leerVista3d(), // true = 3D, false = 2D
};

const $ = (id) => document.getElementById(id);

const refs = {
  nombre: $("nombre-proyecto"),
  listaPlantillas: $("lista-plantillas"),
  listaProyectos: $("lista-proyectos"),
  diagrama: $("diagrama"),
  lienzo2d: document.querySelector("#diagrama .diagram-2d"),
  canvas3d: document.querySelector("#diagrama .diagram-3d"),
  chkFrentes: $("chk-frentes"),
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

const numero = (valor, porDefecto = 0) => {
  const n = Number.parseFloat(String(valor).replace(",", "."));
  return Number.isFinite(n) ? n : porDefecto;
};

const limitar = (valor, minimo, maximo) => Math.min(maximo, Math.max(minimo, valor));

const idModulo = () =>
  "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

const slug = (texto) =>
  (texto || "mueble")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mueble";

const pedirId = () => storage.nuevoId();

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
    storage.guardarActual(state.project);
    anunciar("Guardado automático " + new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }));
  }, 500);
}

/* ── normalización de diseños (import / storage) ─────────────────────────── */

function normalizarDiseno(entrada) {
  const base = entrada?.design ?? entrada;
  if (!base || !Array.isArray(base.columns)) {
    throw new Error("El archivo no parece un diseño de Despiece (falta columns).");
  }

  const columns = base.columns.map((column) => {
    const width = limitar(numero(column?.width, 0.6), 0.1, 2.5);
    const modules = (Array.isArray(column?.modules) ? column.modules : []).map((mod) => {
      const tipo = TIPOS_VALIDOS.has(mod?.type) ? mod.type : "doors";
      const normalizado = {
        id: typeof mod?.id === "string" && mod.id ? mod.id : idModulo(),
        type: tipo,
        height: limitar(numero(mod?.height, 0.4), 0.05, 3),
      };
      if (tipo === "drawer") {
        normalizado.drawerCount = limitar(Math.round(numero(mod?.drawerCount, 2)), 1, 8);
      }
      return normalizado;
    });
    return { width, modules };
  });

  const config = {};
  if (base.config && typeof base.config === "object") {
    for (const [clave] of CAMPOS_CONFIG) {
      const valor = numero(base.config[clave], Number.NaN);
      if (Number.isFinite(valor)) config[clave] = valor;
    }
  }

  return Object.keys(config).length > 0 ? { columns, config } : { columns };
}

function proyectoDePlantilla(template) {
  return {
    id: pedirId(),
    name: template.name,
    design: {
      columns: template.columns.map((column) => ({
        width: column.width,
        modules: column.modules.map((mod) => ({
          ...mod,
          id: idModulo(),
        })),
      })),
      ...(template.config ? { config: { ...template.config } } : {}),
    },
  };
}

function proyectoEnBlanco() {
  return {
    id: pedirId(),
    name: "Mueble nuevo",
    design: {
      columns: [
        {
          width: 0.6,
          modules: [{ id: idModulo(), type: "doors", height: 0.8 }],
        },
      ],
    },
  };
}

/* ── acciones ────────────────────────────────────────────────────────────── */

function abrirProyecto(project) {
  state.project = project;
  refs.nombre.value = project.name;
  storage.guardarActual(project);
  compilar();
  renderTodo();
  anunciar(`Abierto: ${project.name}`);
}

function abrirPlantilla(template) {
  abrirProyecto(proyectoDePlantilla(template));
}

function abrirEnBlanco() {
  abrirProyecto(proyectoEnBlanco());
}

function guardarProyecto() {
  storage.guardarProyecto(state.project);
  renderProyectos();
  anunciar("Proyecto guardado");
}

function borrarProyectoActual() {
  const { id, name } = state.project;
  if (!window.confirm(`¿Borrar "${name}"? Esta acción no se puede deshacer.`)) return;
  storage.borrarProyecto(id);
  abrirEnBlanco();
  anunciar("Proyecto borrado");
}

function exportarCsv() {
  const resultado = state.resultado ?? compilar();
  const filas = buildCutlist(resultado.parts);
  if (filas.length === 0) {
    anunciar("No hay piezas para exportar");
    return;
  }
  descargar(
    `despiece-${slug(state.project.name)}.csv`,
    "\uFEFF" + cutlistToCsv(filas),
    "text/csv;charset=utf-8",
  );
  anunciar("CSV descargado");
}

function exportarJson() {
  const contenido = {
    format: "despiece-design",
    version: 1,
    name: state.project.name,
    design: state.project.design,
    exportedAt: new Date().toISOString(),
  };
  descargar(
    `despiece-${slug(state.project.name)}.json`,
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
    abrirProyecto({ id: pedirId(), name: nombre, design });
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
  state.resultado = compileFurniture(state.project.design);
  return state.resultado;
}

/* ── visor 3D ────────────────────────────────────────────────────────────── */

let visor3d = null;

/** Crea el visor la primera vez que se necesita. */
function asegurarVisor() {
  if (!visor3d) {
    visor3d = crearVisor3D(refs.canvas3d, { mostrarFrentes: refs.chkFrentes.checked });
  }
  return visor3d;
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
}

function renderPlantillas() {
  mount(
    refs.listaPlantillas,
    el("button", {
      class: "chip",
      type: "button",
      onclick: abrirEnBlanco,
    }, [el("strong", { text: "Empezar de cero" }), el("span", { text: "un cuerpo con puertas" })]),
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

  mount(
    refs.listaProyectos,
    proyectos.map((proyecto) =>
      el("div", {
        class: "project-item" + (proyecto.id === state.project.id ? " is-active" : ""),
      }, [
        el("button", {
          class: "load",
          type: "button",
          onclick: () => abrirProyecto({
            id: proyecto.id,
            name: proyecto.name,
            design: structuredClone(proyecto.design),
          }),
        }, [
          el("strong", { text: proyecto.name }),
          el("span", { text: storage.fechaCorta(proyecto.updatedAt) }),
        ]),
        el("button", {
          class: "del",
          type: "button",
          title: "Borrar",
          onclick: () => {
            if (!window.confirm(`¿Borrar "${proyecto.name}"?`)) return;
            storage.borrarProyecto(proyecto.id);
            if (proyecto.id === state.project.id) abrirEnBlanco();
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
        onInput(limitar(n, min, max));
      },
    }),
    sufijo ? el("em", { text: sufijo }) : null,
  ]);
}

function renderControles() {
  const { columns } = state.project.design;

  mount(
    refs.controles,
    columns.map((column, columnIndex) => {
      const alto = column.modules.reduce((total, mod) => total + mod.height, 0);
      return el("div", { class: "column-card" }, [
        el("div", { class: "column-head" }, [
          el("strong", { text: `Columna ${columnIndex + 1}` }),
          campoNumero({
            valor: column.width, min: 0.1, max: 2.5, step: 0.01, sufijo: "m",
            ancho: 64,
            onInput: (valor) => {
              column.width = valor;
              compilar();
              renderSalidas();
            },
          }),
          el("span", { class: "column-total", text: `alto ${metros(alto)} m` }),
          el("button", {
            class: "mini-btn danger", type: "button", title: "Eliminar columna",
            onclick: () => {
              if (columns.length === 1) {
                anunciar("Tiene que haber al menos una columna");
                return;
              }
              columns.splice(columnIndex, 1);
              compilar();
              renderTodo();
            },
          }, "Eliminar"),
        ]),

        column.modules.length === 0
          ? el("p", { class: "muted", style: "font-size:12px", text: "Sin módulos." })
          : null,

        column.modules.map((mod, moduleIndex) =>
          el("div", { class: "module-row" }, [
            el("select", {
              "aria-label": "Tipo de módulo",
              onchange: (event) => {
                mod.type = event.target.value;
                if (mod.type === "drawer" && !mod.drawerCount) mod.drawerCount = 2;
                compilar();
                renderTodo();
              },
            }, TIPOS_MODULO.map(([tipo, etiqueta]) =>
              el("option", {
                value: tipo,
                selected: mod.type === tipo,
                text: etiqueta,
              })
            )),

            campoNumero({
              valor: mod.height, min: 0.05, max: 3, step: 0.01, sufijo: "m alto",
              onInput: (valor) => {
                mod.height = valor;
                compilar();
                renderSalidas();
              },
            }),

            mod.type === "drawer"
              ? el("span", { class: "field" }, [
                  el("input", {
                    type: "number", value: mod.drawerCount ?? 2, min: 1, max: 8, step: 1,
                    style: "width:52px",
                    oninput: (event) => {
                      mod.drawerCount = limitar(Math.round(numero(event.target.value, 2)), 1, 8);
                      compilar();
                      renderSalidas();
                    },
                  }),
                  el("em", { text: "cajones" }),
                ])
              : null,

            el("div", { class: "row-actions" }, [
              el("button", {
                class: "mini-btn", type: "button", title: "Quitar módulo",
                onclick: () => {
                  column.modules.splice(moduleIndex, 1);
                  compilar();
                  renderTodo();
                },
              }, "✕"),
            ]),
          ])
        ),

        el("button", {
          class: "add-btn", type: "button", style: "margin-top:7px",
          onclick: () => {
            column.modules.push({ id: idModulo(), type: "doors", height: 0.4 });
            compilar();
            renderTodo();
          },
        }, "+ módulo"),
      ]);
    }),
  );
}

function renderConfig() {
  const config = withDefaults(state.project.design.config);
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
          oninput: (event) => {
            const valor = numero(event.target.value, Number.NaN);
            if (!Number.isFinite(valor)) return;
            state.project.design.config = {
              ...(state.project.design.config ?? {}),
              [clave]: limitar(valor, min, max),
            };
            compilar();
            renderSalidas();
          },
        }),
      ])
    ),
  );
}

function renderSalidas() {
  const resultado = state.resultado ?? compilar();

  // vista 2D (se dibuja siempre; el CSS decide cuál se ve)
  const diagrama = renderDiagram(state.project.design);
  mount(
    refs.lienzo2d,
    diagrama ?? el("p", { class: "vacio", text: "Agregá una columna para ver el mueble." }),
  );

  // vista 3D
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

/* ── eventos ─────────────────────────────────────────────────────────────── */

function conectarEventos() {
  $("btn-guardar").addEventListener("click", guardarProyecto);
  $("btn-csv").addEventListener("click", exportarCsv);
  $("btn-agregar-columna").addEventListener("click", () => {
    state.project.design.columns.push({
      width: 0.6,
      modules: [{ id: idModulo(), type: "doors", height: 0.8 }],
    });
    compilar();
    renderTodo();
  });

  refs.nombre.addEventListener("input", (event) => {
    state.project.name = event.target.value.slice(0, 80) || "Sin título";
    autoguardar();
  });

  // Menú de acciones
  const botonMenu = $("btn-menu");
  botonMenu.addEventListener("click", (event) => {
    event.stopPropagation();
    const abierto = refs.menu.hidden;
    refs.menu.hidden = !abierto;
    botonMenu.setAttribute("aria-expanded", String(abierto));
  });
  document.addEventListener("click", (event) => {
    if (!refs.menu.hidden && !refs.menu.contains(event.target) && event.target !== botonMenu) {
      refs.menu.hidden = true;
      botonMenu.setAttribute("aria-expanded", "false");
    }
  });
  refs.menu.addEventListener("click", (event) => {
    const accion = event.target.closest("[data-accion]")?.dataset.accion;
    if (!accion) return;
    refs.menu.hidden = true;
    botonMenu.setAttribute("aria-expanded", "false");
    if (accion === "json") exportarJson();
    if (accion === "importar") $("archivo-importar").click();
    if (accion === "borrar-proyecto") borrarProyectoActual();
  });

  $("archivo-importar").addEventListener("change", (event) => {
    const archivo = event.target.files?.[0];
    if (archivo) importarJson(archivo);
    event.target.value = "";
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
    tab.addEventListener("click", () => {
      state.vista3d = tab.dataset.vista3d === "3d";
      storage.guardarVista3d(state.vista3d);
      aplicarVista();
    });
  }

  refs.chkFrentes.addEventListener("change", (evento) => {
    asegurarVisor().setMostrarFrentes(evento.target.checked);
  });

  refs.btnPantalla.addEventListener("click", () => pantallaCompleta());

  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && tarjetaVista.classList.contains("pantalla-completa")) {
      pantallaCompleta(false);
    }
  });
}

/* ── arranque ────────────────────────────────────────────────────────────── */

function arrancar() {
  const guardado = storage.leerActual();
  let proyecto;
  try {
    proyecto = guardado
      ? { id: guardado.id ?? pedirId(), name: guardado.name ?? "Proyecto", design: normalizarDiseno(guardado.design) }
      : proyectoDePlantilla(TEMPLATES[0]);
  } catch {
    proyecto = proyectoDePlantilla(TEMPLATES[0]);
  }

  state.project = proyecto;
  refs.nombre.value = proyecto.name;

  if (!storage.hayAlmacenamiento()) {
    anunciar("Sin almacenamiento local: los cambios no se guardarán al cerrar");
  }

  conectarEventos();
  compilar();
  renderTodo();
  aplicarVista();
}

arrancar();
