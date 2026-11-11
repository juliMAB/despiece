/**
 * Tests de la capa de comandos y del historial (F1 del modo agente).
 *
 * Es la puerta por donde van a editar la interfaz, los scripts y (más
 * adelante) los agentes: cada comando tiene que validar, responder uniforme y
 * poder deshacerse.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { crearSesion, COMANDOS, ErrorComando, normalizarDiseno } from "../src/app/commands.js";
import { proyectoDesdePlantilla } from "../src/app/design.js";
import { TEMPLATES } from "../templates/index.js";
import { compileFurniture } from "../src/engine/compile.js";
import { buildCutlist } from "../src/engine/cutlist.js";

const DISENO = {
  columns: [
    { width: 0.6, modules: [{ id: "p1", type: "doors", height: 0.8 }] },
    { width: 0.8, modules: [{ id: "c1", type: "drawer", height: 0.6, drawerCount: 2 }] },
  ],
};

function visorFalso() {
  const estado = { yaw: 0.62, pitch: 0.42, zoom: 1, aperturas: new Map() };
  return {
    estado,
    setApertura(valor) {
      estado.aperturas.set("__todo", valor);
    },
    setAperturaGrupo(grupo, valor) {
      estado.aperturas.set(grupo, valor);
    },
    getAperturaGrupo(grupo) {
      return estado.aperturas.get(grupo) ?? 0;
    },
    reiniciarCamara() {
      estado.yaw = 0.62;
      estado.pitch = 0.42;
      estado.zoom = 1;
    },
    setCamara({ yaw, pitch, zoom }) {
      if (Number.isFinite(yaw)) estado.yaw = yaw;
      if (Number.isFinite(pitch)) estado.pitch = pitch;
      if (Number.isFinite(zoom)) estado.zoom = zoom;
    },
  };
}

function sesionCon({ servicios = {}, design = DISENO, name = "Prueba" } = {}) {
  return crearSesion({ estadoInicial: { name, design }, servicios });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Contrato general
 * ──────────────────────────────────────────────────────────────────────── */

describe("contrato de comandos", () => {
  test("la sesión arranca con el proyecto y revisión 0", () => {
    const sesion = sesionCon();
    assert.equal(sesion.revision, 0);
    assert.equal(sesion.estado.name, "Prueba");
    assert.equal(sesion.estado.design.columns.length, 2);
    assert.equal(sesion.puedeDeshacer, false);
    assert.equal(sesion.puedeRehacer, false);
  });

  test("un comando desconocido devuelve error accionable", () => {
    const respuesta = sesionCon().aplicar("hacer_magia");
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "comando_desconocido");
    assert.match(respuesta.error.sugerencia, /obtener_comandos/);
  });

  test("obtener_comandos lista el catálogo", () => {
    const respuesta = sesionCon().aplicar("obtener_comandos");
    assert.equal(respuesta.ok, true);
    const nombres = respuesta.resultado.map((comando) => comando.nombre);
    assert.ok(nombres.includes("agregar_columna"));
    assert.ok(nombres.includes("deshacer") === false, "deshacer no está en el catálogo de diseño");
    for (const comando of respuesta.resultado) {
      assert.ok(comando.descripcion.length > 0);
      assert.equal(typeof comando.argumentos, "string");
    }
  });

  test("el estado devuelto es una copia (no se puede mutar la sesión)", () => {
    const sesion = sesionCon();
    const copia = sesion.estado;
    copia.design.columns[0].width = 99;
    assert.equal(sesion.estado.design.columns[0].width, 0.6);
  });

  test("las consultas y la vista no suben la revisión", () => {
    const sesion = sesionCon({ servicios: { visor: visorFalso() } });
    for (const nombre of ["obtener_estado", "obtener_diseno", "obtener_despiece", "mover_camara", "abrir_todo"]) {
      const antes = sesion.revision;
      sesion.aplicar(nombre, { yaw: 0.2 });
      assert.equal(sesion.revision, antes, `${nombre} no debería cambiar la revisión`);
    }
  });

  test("normalizarDiseno rechaza formas inválidas", () => {
    assert.throws(() => normalizarDiseno({ hola: 1 }), /columns/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Proyecto
 * ──────────────────────────────────────────────────────────────────────── */

describe("comandos de proyecto", () => {
  test("crear_proyecto vacío", () => {
    const sesion = sesionCon();
    const respuesta = sesion.aplicar("crear_proyecto", { nombre: "Nuevo" });
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.name, "Nuevo");
    assert.equal(sesion.estado.design.columns.length, 1);
    assert.equal(sesion.revision, 1);
  });

  test("crear_proyecto desde plantilla", () => {
    const plantilla = TEMPLATES[0];
    const respuesta = sesionCon().aplicar("crear_proyecto", { plantillaId: plantilla.id });
    assert.equal(respuesta.ok, true);
    assert.equal(respuesta.resultado.nombre, plantilla.name);
  });

  test("plantilla desconocida da error con opciones", () => {
    const respuesta = sesionCon().aplicar("cargar_plantilla", { plantillaId: "no-existe" });
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "plantilla_desconocida");
    assert.match(respuesta.error.sugerencia, /alacena/);
  });

  test("cargar_plantilla reemplaza todo", () => {
    const sesion = sesionCon();
    const plantilla = TEMPLATES[1];
    sesion.aplicar("cargar_plantilla", { plantillaId: plantilla.id });
    assert.equal(sesion.estado.name, plantilla.name);
    assert.equal(sesion.estado.design.columns.length, plantilla.columns.length);
  });

  test("renombrar_proyecto recorta y valida", () => {
    const sesion = sesionCon();
    assert.equal(sesion.aplicar("renombrar_proyecto", { nombre: "  Placard  " }).ok, true);
    assert.equal(sesion.estado.name, "Placard");
    const vacio = sesion.aplicar("renombrar_proyecto", { nombre: "   " });
    assert.equal(vacio.ok, false);
    assert.equal(vacio.error.codigo, "nombre_invalido");
  });

  test("cargar_diseno normaliza y valida", () => {
    const sesion = sesionCon();
    const respuesta = sesion.aplicar("cargar_diseno", {
      design: { columns: [{ width: "0.9", modules: [{ type: "drawer", height: "0.5", drawerCount: 3 }] }] },
    });
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.design.columns[0].width, 0.9);
    assert.equal(sesion.estado.design.columns[0].modules[0].drawerCount, 3);
  });

  test("cargar_diseno inválido o vacío no rompe la sesión", () => {
    const sesion = sesionCon();
    const invalido = sesion.aplicar("cargar_diseno", { design: { hola: 1 } });
    assert.equal(invalido.ok, false);
    assert.equal(invalido.error.codigo, "diseno_invalido");

    const vacio = sesion.aplicar("cargar_diseno", { design: { columns: [] } });
    assert.equal(vacio.ok, false);
    assert.equal(vacio.error.codigo, "diseno_vacio");
    assert.equal(sesion.estado.design.columns.length, 2, "el diseño anterior sigue intacto");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Estructura
 * ──────────────────────────────────────────────────────────────────────── */

describe("comandos de estructura", () => {
  test("agregar_columna al final, con y sin módulo", () => {
    const sesion = sesionCon();
    let respuesta = sesion.aplicar("agregar_columna", { ancho: 0.7 });
    assert.equal(respuesta.ok, true);
    assert.equal(respuesta.resultado.indice, 2);
    assert.equal(sesion.estado.design.columns[2].width, 0.7);
    assert.equal(sesion.estado.design.columns[2].modules.length, 0);

    respuesta = sesion.aplicar("agregar_columna", { indice: 0, modulo: { tipo: "drawer", alto: 0.5, cajones: 3 } });
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.design.columns[0].modules[0].type, "drawer");
    assert.equal(sesion.estado.design.columns[0].modules[0].drawerCount, 3);
    assert.equal(sesion.estado.design.columns.length, 4);
  });

  test("agregar_columna valida índice y ancho", () => {
    const sesion = sesionCon();
    const indice = sesion.aplicar("agregar_columna", { indice: 9 });
    assert.equal(indice.ok, false);
    assert.equal(indice.error.codigo, "indice_fuera_de_rango");

    const ancho = sesion.aplicar("agregar_columna", { ancho: 99 });
    assert.equal(ancho.ok, true);
    assert.equal(sesion.estado.design.columns.at(-1).width, 2.5, "el ancho se limita");
  });

  test("quitar_columna no permite quedarse sin columnas", () => {
    const sesion = sesionCon();
    assert.equal(sesion.aplicar("quitar_columna", { indice: 0 }).ok, true);
    assert.equal(sesion.estado.design.columns.length, 1);
    const ultima = sesion.aplicar("quitar_columna", { indice: 0 });
    assert.equal(ultima.ok, false);
    assert.equal(ultima.error.codigo, "ultima_columna");
  });

  test("fijar_ancho_columna redondea a mm", () => {
    const sesion = sesionCon();
    const respuesta = sesion.aplicar("fijar_ancho_columna", { indice: 0, ancho: 0.61234 });
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.design.columns[0].width, 0.612);
  });

  test("agregar_modulo por tipo con cajones", () => {
    const sesion = sesionCon();
    const respuesta = sesion.aplicar("agregar_modulo", { columna: 0, tipo: "drawer", alto: 0.5, cajones: 4 });
    assert.equal(respuesta.ok, true);
    assert.equal(respuesta.resultado.indice, 1);
    const modulo = sesion.estado.design.columns[0].modules[1];
    assert.equal(modulo.type, "drawer");
    assert.equal(modulo.drawerCount, 4);
    assert.equal(modulo.height, 0.5);
  });

  test("agregar_modulo valida columna y tipo", () => {
    const sesion = sesionCon();
    assert.equal(sesion.aplicar("agregar_modulo", { columna: 5, tipo: "doors", alto: 0.5 }).error.codigo, "indice_fuera_de_rango");
    assert.equal(sesion.aplicar("agregar_modulo", { columna: 0, tipo: "heladera", alto: 0.5 }).error.codigo, "tipo_invalido");
  });

  test("editar_modulo cambia tipo, alto y cajones", () => {
    const sesion = sesionCon();
    sesion.aplicar("editar_modulo", { columna: 0, modulo: 0, tipo: "drawer" });
    let modulo = sesion.estado.design.columns[0].modules[0];
    assert.equal(modulo.type, "drawer");
    assert.equal(modulo.drawerCount, 2, "un cajón arranca con 2");

    sesion.aplicar("editar_modulo", { columna: 0, modulo: 0, cajones: 5, alto: 0.9 });
    modulo = sesion.estado.design.columns[0].modules[0];
    assert.equal(modulo.drawerCount, 5);
    assert.equal(modulo.height, 0.9);

    sesion.aplicar("editar_modulo", { columna: 0, modulo: 0, tipo: "shelf" });
    modulo = sesion.estado.design.columns[0].modules[0];
    assert.equal(modulo.type, "shelf");
    assert.equal(modulo.drawerCount, undefined);
  });

  test("editar_modulo sin cambios da error", () => {
    const respuesta = sesionCon().aplicar("editar_modulo", { columna: 0, modulo: 0 });
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "sin_cambios");
  });

  test("quitar_modulo permite dejar una columna vacía", () => {
    const sesion = sesionCon();
    assert.equal(sesion.aplicar("quitar_modulo", { columna: 0, modulo: 0 }).ok, true);
    assert.equal(sesion.estado.design.columns[0].modules.length, 0);
  });

  test("fijar_config valida claves y mezcla valores", () => {
    const sesion = sesionCon();
    const respuesta = sesion.aplicar("fijar_config", { valores: { depth: 0.55, panelThickness: 0.018 } });
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.design.config.depth, 0.55);

    const mala = sesion.aplicar("fijar_config", { valores: { profundidad: 0.55 } });
    assert.equal(mala.ok, false);
    assert.equal(mala.error.codigo, "clave_desconocida");
    assert.match(mala.error.sugerencia, /depth/);
  });

  test("un diseño editado sigue compilando", () => {
    const sesion = sesionCon();
    sesion.aplicar("agregar_columna", { modulo: { tipo: "doors", alto: 0.6 } });
    sesion.aplicar("fijar_config", { valores: { depth: 0.5 } });
    const resultado = compileFurniture(sesion.estado.design);
    assert.ok(resultado.parts.length > 0);
    assert.deepEqual(resultado.issues, []);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Consultas
 * ──────────────────────────────────────────────────────────────────────── */

describe("consultas", () => {
  const sesion = sesionCon();

  test("obtener_estado trae diseño y resumen", () => {
    const { resultado } = sesion.aplicar("obtener_estado");
    assert.equal(resultado.nombre, "Prueba");
    assert.equal(resultado.design.columns.length, 2);
    assert.equal(typeof resultado.resumen.parts, "number");
  });

  test("obtener_despiece coincide con el motor", () => {
    const { resultado } = sesion.aplicar("obtener_despiece");
    const compilado = compileFurniture(sesion.estado.design);
    assert.deepEqual(resultado.lineas, buildCutlist(compilado.parts));
    assert.equal(resultado.resumen.parts, compilado.parts.length);
  });

  test("obtener_mecanizados y obtener_avisos", () => {
    const mecanizados = sesion.aplicar("obtener_mecanizados").resultado;
    assert.ok(mecanizados.total > 0);
    assert.equal(mecanizados.operaciones.length, mecanizados.total);
    const avisos = sesion.aplicar("obtener_avisos").resultado;
    assert.equal(avisos.valido, true);
  });

  test("capturar_vista devuelve el PNG del servicio", () => {
    const sesionConCaptura = sesionCon({
      servicios: { capturarVista: () => "data:image/png;base64,AAA" },
    });
    assert.equal(sesionConCaptura.aplicar("capturar_vista").resultado.png, "data:image/png;base64,AAA");
  });

  test("sin servicio de captura devuelve error claro", () => {
    const respuesta = sesionCon().aplicar("capturar_vista");
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "sin_visor");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Vista (usa el visor como servicio)
 * ──────────────────────────────────────────────────────────────────────── */

describe("comandos de vista", () => {
  test("sin visor devuelven error accionable", () => {
    const respuesta = sesionCon().aplicar("abrir_todo", { abierto: true });
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "sin_visor");
    assert.match(respuesta.error.sugerencia, /cargue la app/);
  });

  test("abrir_todo y mover_camara usan el visor", () => {
    const visor = visorFalso();
    const sesion = sesionCon({ servicios: { visor } });
    sesion.aplicar("abrir_todo", { abierto: true });
    assert.equal(visor.estado.aperturas.get("__todo"), 1);
    sesion.aplicar("mover_camara", { yaw: 1.2, zoom: 2 });
    assert.equal(visor.estado.yaw, 1.2);
    assert.equal(visor.estado.zoom, 2);
    sesion.aplicar("reiniciar_camara");
    assert.equal(visor.estado.yaw, 0.62);
  });

  test("alternar_apertura abre el cajón indicado", () => {
    const visor = visorFalso();
    const sesion = sesionCon({ servicios: { visor } });
    const respuesta = sesion.aplicar("alternar_apertura", { columna: 1, modulo: 0, cajon: 1 });
    assert.equal(respuesta.ok, true);
    assert.equal(respuesta.resultado.abierto, true);
    assert.match(respuesta.resultado.grupo, /^drawer:c1:1$/);
    assert.equal(visor.estado.aperturas.get("drawer:c1:1"), 1);

    // segundo click lo cierra
    const segundo = sesion.aplicar("alternar_apertura", { columna: 1, modulo: 0, cajon: 1 });
    assert.equal(segundo.resultado.abierto, false);
  });

  test("alternar_apertura con puertas abre todas las hojas del módulo", () => {
    const visor = visorFalso();
    const sesion = sesionCon({ servicios: { visor } });
    const respuesta = sesion.aplicar("alternar_apertura", { columna: 0, modulo: 0 });
    assert.equal(respuesta.ok, true);
    assert.equal(respuesta.resultado.grupos.length, 2);
    for (const grupo of respuesta.resultado.grupos) assert.equal(visor.estado.aperturas.get(grupo), 1);
  });

  test("alternar_apertura valida módulos y cajones", () => {
    const visor = visorFalso();
    const sesion = sesionCon({ servicios: { visor } });
    assert.equal(sesion.aplicar("alternar_apertura", { columna: 9, modulo: 0 }).error.codigo, "indice_fuera_de_rango");
    assert.equal(sesion.aplicar("alternar_apertura", { columna: 1, modulo: 0, cajon: 9 }).error.codigo, "indice_fuera_de_rango");
  });

  test("fijar_vista delega en el servicio", () => {
    const pedidos = [];
    const sesion = sesionCon({ servicios: { fijarVista: (pedido) => pedidos.push(pedido) } });
    sesion.aplicar("fijar_vista", { modo: "2d", medidas: "todas", frentes: false });
    assert.deepEqual(pedidos.at(-1), { modo: "2d", medidas: "todas", frentes: false });
    assert.equal(sesion.aplicar("fijar_vista", { modo: "x" }).error.codigo, "modo_invalido");
    assert.equal(sesion.aplicar("fijar_vista", {}).error.codigo, "sin_cambios");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Historial
 * ──────────────────────────────────────────────────────────────────────── */

describe("deshacer y rehacer", () => {
  test("deshace cambios de estructura", () => {
    const sesion = sesionCon();
    sesion.aplicar("agregar_columna", { ancho: 0.5 });
    assert.equal(sesion.estado.design.columns.length, 3);
    const respuesta = sesion.aplicar("deshacer");
    assert.equal(respuesta.ok, true);
    assert.equal(sesion.estado.design.columns.length, 2);
    assert.equal(sesion.puedeRehacer, true);
  });

  test("rehacer vuelve a aplicar", () => {
    const sesion = sesionCon();
    sesion.aplicar("agregar_columna", { ancho: 0.5 });
    sesion.aplicar("deshacer");
    sesion.aplicar("rehacer");
    assert.equal(sesion.estado.design.columns.length, 3);
    assert.equal(sesion.estado.design.columns.at(-1).width, 0.5);
  });

  test("también deshace el nombre y la configuración", () => {
    const sesion = sesionCon();
    sesion.aplicar("renombrar_proyecto", { nombre: "Placard" });
    sesion.aplicar("fijar_config", { valores: { depth: 0.5 } });
    // un paso atrás: se va la config
    sesion.aplicar("deshacer");
    assert.equal(sesion.estado.design.config?.depth, undefined);
    // otro paso: se va el nombre
    sesion.aplicar("deshacer");
    assert.equal(sesion.estado.name, "Prueba");
  });

  test("un cambio nuevo borra el futuro", () => {
    const sesion = sesionCon();
    sesion.aplicar("agregar_columna", {});
    sesion.aplicar("deshacer");
    assert.equal(sesion.puedeRehacer, true);
    sesion.aplicar("agregar_columna", { ancho: 0.4 });
    assert.equal(sesion.puedeRehacer, false);
  });

  test("sin historial da error claro", () => {
    const sesion = sesionCon();
    assert.equal(sesion.aplicar("deshacer").error.codigo, "sin_cambios_para_deshacer");
    assert.equal(sesion.aplicar("rehacer").error.codigo, "sin_cambios_para_rehacer");
  });

  test("cada cambio sube la revisión, incluido deshacer", () => {
    const sesion = sesionCon();
    sesion.aplicar("agregar_columna", {});
    assert.equal(sesion.revision, 1);
    sesion.aplicar("deshacer");
    assert.equal(sesion.revision, 2);
    sesion.aplicar("rehacer");
    assert.equal(sesion.revision, 3);
  });

  test("el límite del historial es 100", () => {
    const sesion = sesionCon();
    for (let i = 0; i < 120; i++) sesion.aplicar("fijar_ancho_columna", { indice: 0, ancho: 0.3 + i / 1000 });
    let deshechos = 0;
    while (sesion.puedeDeshacer) {
      sesion.aplicar("deshacer");
      deshechos++;
    }
    assert.equal(deshechos, 100);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Plantillas y coherencia con el motor
 * ──────────────────────────────────────────────────────────────────────── */

describe("plantillas como punto de partida", () => {
  for (const plantilla of TEMPLATES) {
    test(`${plantilla.id} se puede cargar y compila`, () => {
      const sesion = sesionCon();
      sesion.aplicar("cargar_plantilla", { plantillaId: plantilla.id });
      assert.equal(sesion.estado.name, plantilla.name);
      const resultado = compileFurniture(sesion.estado.design);
      assert.ok(resultado.parts.length > 0);
      assert.deepEqual(resultado.issues, []);
    });
  }

  test("proyectoDesdePlantilla no comparte referencias con la plantilla", () => {
    const proyecto = proyectoDesdePlantilla(TEMPLATES[0]);
    proyecto.design.columns[0].width = 99;
    assert.notEqual(TEMPLATES[0].columns[0].width, 99);
    assert.notEqual(TEMPLATES[0].columns[0].modules[0].id, proyecto.design.columns[0].modules[0].id);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Errores de comando
 * ──────────────────────────────────────────────────────────────────────── */

describe("errores", () => {
  test("ErrorComando guarda código y sugerencia", () => {
    const error = new ErrorComando("codigo", "mensaje", "sugerencia");
    assert.equal(error.name, "ErrorComando");
    assert.equal(error.codigo, "codigo");
    assert.equal(error.sugerencia, "sugerencia");
    assert.ok(error instanceof Error);
  });

  test("un error inesperado no deja la sesión trabada", () => {
    const sesion = sesionCon({
      servicios: {
        get visor() {
          throw new Error("boom");
        },
      },
    });
    const respuesta = sesion.aplicar("abrir_todo", { abierto: true });
    assert.equal(respuesta.ok, false);
    assert.equal(respuesta.error.codigo, "error_interno");
    // sigue funcionando
    assert.equal(sesion.aplicar("obtener_diseno").ok, true);
  });
});
