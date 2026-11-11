/**
 * Capa de comandos de Despiece.
 *
 * Todo cambio del diseño pasa por acá: la interfaz, los scripts y (en la
 * próxima fase) el servidor de agentes usan la misma puerta. Los comandos son
 * funciones con validación estricta, errores pensados para que los lea un LLM
 * y una respuesta uniforme con número de revisión.
 *
 * La sesión mantiene el estado y el historial para deshacer/rehacer.
 */

import { DEFAULT_CONFIG } from "../engine/config.js";
import { buildCutlist, summarize, ROLE_LABELS } from "../engine/cutlist.js";
import { compileFurniture } from "../engine/compile.js";
import { TEMPLATES } from "../../templates/index.js";
import {
  LIMITES,
  TIPOS_VALIDOS,
  TIPOS_MODULO,
  idModulo,
  idProyecto,
  limitar,
  normalizarDiseno,
  normalizarModulo,
  numero,
  proyectoDesdePlantilla,
  proyectoEnBlanco,
} from "./design.js";

const LIMITE_HISTORIAL = 100;
const LARGO_MAXIMO_NOMBRE = 80;

/** Error de comando con código y sugerencia para el agente. */
export class ErrorComando extends Error {
  constructor(codigo, mensaje, sugerencia) {
    super(mensaje);
    this.name = "ErrorComando";
    this.codigo = codigo;
    this.sugerencia = sugerencia;
  }
}

const fallar = (codigo, mensaje, sugerencia) => {
  throw new ErrorComando(codigo, mensaje, sugerencia);
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

const clonar = (valor) => structuredClone(valor);
const redondearMilimetro = (metros) => Math.round(metros * 1000) / 1000;
const redondearConfig = (valor) => Math.round(valor * 10000) / 10000;

function validarIndice(indice, largo, tipo, permitirFinal = false) {
  const maximo = permitirFinal ? largo : largo - 1;
  if (!Number.isInteger(indice) || indice < 0 || indice > maximo) {
    fallar(
      "indice_fuera_de_rango",
      `No existe ${tipo} ${indice} (hay ${largo}).`,
      `Usá un índice entre 0 y ${Math.max(0, maximo)}.`,
    );
  }
}

function validarNombre(nombre) {
  if (typeof nombre !== "string" || nombre.trim().length === 0) {
    fallar("nombre_invalido", "El nombre no puede estar vacío.", "Pasá un texto, por ejemplo { nombre: \"Placard\" }.");
  }
  return nombre.trim().slice(0, LARGO_MAXIMO_NOMBRE);
}

function validarNumero(valor, campo, limites) {
  const n = numero(valor, Number.NaN);
  if (!Number.isFinite(n)) {
    fallar("valor_invalido", `"${campo}" tiene que ser un número.`, `Por ejemplo { ${campo}: 0.6 }.`);
  }
  return limitar(n, limites.min, limites.max);
}

/** Módulo a partir de argumentos con nombres amigables (tipo/alto/cajones). */
function moduloDesdeArgs(args = {}) {
  const tipo = args.tipo ?? args.type ?? "doors";
  if (!TIPOS_VALIDOS.has(tipo)) {
    fallar(
      "tipo_invalido",
      `No existe el tipo de módulo "${tipo}".`,
      `Tipos válidos: ${[...TIPOS_VALIDOS].join(", ")}.`,
    );
  }
  return normalizarModulo({
    type: tipo,
    height: args.alto ?? args.height ?? 0.4,
    drawerCount: args.cajones ?? args.drawerCount ?? 2,
  });
}

function conDiseno(estado, design, resultado) {
  return { estado: { ...estado, design }, resultado };
}

function obtenerResultado(estado) {
  return compileFurniture(estado.design);
}

function requiereVisor(servicios) {
  if (!servicios.visor) {
    fallar(
      "sin_visor",
      "El visor 3D todavía no está disponible.",
      "Esperá a que cargue la app y volvé a intentar.",
    );
  }
  return servicios.visor;
}

/* ── catálogo ────────────────────────────────────────────────────────────── */

/**
 * Catálogo de comandos.
 * Cada entrada: { descripcion, argumentos, aplicar(estado, args, servicios) }.
 * `aplicar` devuelve { estado, resultado } cuando cambia el diseño, o solo
 * { resultado } cuando es una consulta o una acción de vista.
 */
export const COMANDOS = {
  /* ── proyecto ───────────────────────────────────────────────────────── */

  crear_proyecto: {
    descripcion: "Crea un proyecto nuevo (vacío o a partir de una plantilla).",
    argumentos: "{ nombre?, plantillaId? }",
    aplicar(estado, args) {
      const proyecto = args.plantillaId
        ? proyectoDesdePlantilla(buscarPlantilla(args.plantillaId))
        : proyectoEnBlanco();
      const nombre = typeof args.nombre === "string" && args.nombre.trim()
        ? args.nombre.trim().slice(0, LARGO_MAXIMO_NOMBRE)
        : proyecto.name;
      return {
        estado: { ...proyecto, name: nombre },
        resultado: { id: proyecto.id, nombre },
      };
    },
  },

  cargar_plantilla: {
    descripcion: "Reemplaza el proyecto por uno nuevo basado en una plantilla.",
    argumentos: "{ plantillaId, nombre? }",
    aplicar(estado, args) {
      if (!args.plantillaId) {
        fallar("falta_plantilla", "Tenés que indicar plantillaId.", listaPlantillasSugerencia());
      }
      const proyecto = proyectoDesdePlantilla(buscarPlantilla(args.plantillaId));
      return {
        estado: { ...proyecto, name: typeof args.nombre === "string" && args.nombre.trim() ? args.nombre.trim().slice(0, LARGO_MAXIMO_NOMBRE) : proyecto.name },
        resultado: { id: proyecto.id },
      };
    },
  },

  cargar_diseno: {
    descripcion: "Reemplaza el diseño actual por uno dado (se valida y normaliza).",
    argumentos: "{ design, nombre? }",
    aplicar(estado, args) {
      let design;
      try {
        design = normalizarDiseno(args.design);
      } catch (error) {
        fallar("diseno_invalido", "El diseño no es válido: " + error.message, "Pasá { design: { columns: [...] } }.");
      }
      if (design.columns.length === 0) {
        fallar("diseno_vacio", "El diseño no tiene columnas.", "Agregá al menos una columna con módulos.");
      }
      return {
        estado: {
          ...estado,
          name: typeof args.nombre === "string" && args.nombre.trim() ? args.nombre.trim().slice(0, LARGO_MAXIMO_NOMBRE) : estado.name,
          design,
        },
        resultado: { columnas: design.columns.length },
      };
    },
  },

  renombrar_proyecto: {
    descripcion: "Cambia el nombre del proyecto.",
    argumentos: "{ nombre }",
    aplicar(estado, args) {
      const nombre = validarNombre(args.nombre);
      return { estado: { ...estado, name: nombre }, resultado: { nombre } };
    },
  },

  /* ── estructura ─────────────────────────────────────────────────────── */

  agregar_columna: {
    descripcion: "Agrega una columna al mueble, opcionalmente con un módulo.",
    argumentos: "{ ancho?, indice?, modulo? }",
    aplicar(estado, args) {
      const columnas = clonar(estado.design.columns);
      const indice = args.indice === undefined ? columnas.length : args.indice;
      validarIndice(indice, columnas.length, "la posición", true);

      const ancho = redondearMilimetro(
        args.ancho === undefined
          ? 0.6
          : validarNumero(args.ancho, "ancho", LIMITES.anchoColumna),
      );
      const columna = { width: ancho, modules: [] };
      if (args.modulo) columna.modules.push(moduloDesdeArgs(args.modulo));

      columnas.splice(indice, 0, columna);
      return conDiseno(estado, { ...estado.design, columns: columnas }, { indice, columnas: columnas.length });
    },
  },

  quitar_columna: {
    descripcion: "Quita una columna completa.",
    argumentos: "{ indice }",
    aplicar(estado, args) {
      const columnas = clonar(estado.design.columns);
      if (columnas.length <= 1) {
        fallar("ultima_columna", "No podés quitar la única columna del mueble.", "Agregá otra columna antes, o cambiá el ancho de esta.");
      }
      validarIndice(args.indice, columnas.length, "la columna");
      columnas.splice(args.indice, 1);
      return conDiseno(estado, { ...estado.design, columns: columnas }, { columnas: columnas.length });
    },
  },

  fijar_ancho_columna: {
    descripcion: "Cambia el ancho de una columna (en metros).",
    argumentos: "{ indice, ancho }",
    aplicar(estado, args) {
      const columnas = clonar(estado.design.columns);
      validarIndice(args.indice, columnas.length, "la columna");
      const ancho = redondearMilimetro(validarNumero(args.ancho, "ancho", LIMITES.anchoColumna));
      columnas[args.indice].width = ancho;
      return conDiseno(estado, { ...estado.design, columns: columnas }, { ancho });
    },
  },

  agregar_modulo: {
    descripcion: "Agrega un módulo (puertas, cajones o estante) a una columna.",
    argumentos: "{ columna, tipo, alto, cajones?, indice? }",
    aplicar(estado, args) {
      const columnas = clonar(estado.design.columns);
      validarIndice(args.columna, columnas.length, "la columna");
      const column = columnas[args.columna];

      const modulo = moduloDesdeArgs(args);
      const indice = args.indice === undefined ? column.modules.length : args.indice;
      validarIndice(indice, column.modules.length, "la posición del módulo", true);
      column.modules.splice(indice, 0, modulo);

      return conDiseno(estado, { ...estado.design, columns: columnas }, { indice, modulo: modulo.id });
    },
  },

  editar_modulo: {
    descripcion: "Cambia el tipo, el alto o la cantidad de cajones de un módulo.",
    argumentos: "{ columna, modulo, tipo?, alto?, cajones? }",
    aplicar(estado, args) {
      if (args.tipo === undefined && args.alto === undefined && args.cajones === undefined) {
        fallar("sin_cambios", "No indicaste qué cambiar del módulo.", "Pasá al menos tipo, alto o cajones.");
      }
      const columnas = clonar(estado.design.columns);
      validarIndice(args.columna, columnas.length, "la columna");
      const column = columnas[args.columna];
      validarIndice(args.modulo, column.modules.length, "el módulo");

      const modulo = column.modules[args.modulo];
      if (args.tipo !== undefined) {
        if (!TIPOS_VALIDOS.has(args.tipo)) {
          fallar("tipo_invalido", `No existe el tipo de módulo "${args.tipo}".`, `Tipos válidos: ${[...TIPOS_VALIDOS].join(", ")}.`);
        }
        modulo.type = args.tipo;
      }
      if (args.alto !== undefined) {
        modulo.height = redondearMilimetro(validarNumero(args.alto, "alto", LIMITES.altoModulo));
      }
      if (modulo.type === "drawer") {
        const cajones = args.cajones !== undefined
          ? Math.round(validarNumero(args.cajones, "cajones", LIMITES.cajones))
          : modulo.drawerCount ?? 2;
        modulo.drawerCount = limitar(cajones, LIMITES.cajones.min, LIMITES.cajones.max);
      } else {
        delete modulo.drawerCount;
      }

      return conDiseno(estado, { ...estado.design, columns: columnas }, { modulo: modulo.id });
    },
  },

  quitar_modulo: {
    descripcion: "Quita un módulo de una columna.",
    argumentos: "{ columna, modulo }",
    aplicar(estado, args) {
      const columnas = clonar(estado.design.columns);
      validarIndice(args.columna, columnas.length, "la columna");
      const column = columnas[args.columna];
      validarIndice(args.modulo, column.modules.length, "el módulo");
      column.modules.splice(args.modulo, 1);
      return conDiseno(estado, { ...estado.design, columns: columnas }, { modulos: column.modules.length });
    },
  },

  fijar_config: {
    descripcion: "Cambia parámetros de fabricación (profundidad, espesores, luces).",
    argumentos: "{ valores: { clave: número } }",
    aplicar(estado, args) {
      const valores = args.valores;
      if (!valores || typeof valores !== "object" || Object.keys(valores).length === 0) {
        fallar("sin_valores", "No indicaste qué configuración cambiar.", `Claves válidas: ${Object.keys(DEFAULT_CONFIG).join(", ")}.`);
      }

      const config = { ...(estado.design.config ?? {}) };
      for (const [clave, valor] of Object.entries(valores)) {
        if (!(clave in DEFAULT_CONFIG)) {
          fallar("clave_desconocida", `No existe la configuración "${clave}".`, `Claves válidas: ${Object.keys(DEFAULT_CONFIG).join(", ")}.`);
        }
        const n = numero(valor, Number.NaN);
        if (!Number.isFinite(n)) {
          fallar("valor_invalido", `"${clave}" tiene que ser un número.`, `Por ejemplo { valores: { ${clave}: 0.018 } }.`);
        }
        config[clave] = redondearConfig(limitar(n, LIMITES.config.min, LIMITES.config.max));
      }

      return conDiseno(estado, { ...estado.design, config }, { claves: Object.keys(valores) });
    },
  },

  /* ── vista (no cambia el diseño) ────────────────────────────────────── */

  abrir_todo: {
    descripcion: "Abre o cierra todas las puertas y cajones del 3D.",
    argumentos: "{ abierto }",
    aplicar(estado, args, servicios) {
      const visor = requiereVisor(servicios);
      const abierto = args.abierto === undefined ? true : Boolean(args.abierto);
      visor.setApertura(abierto ? 1 : 0);
      return { resultado: { abierto } };
    },
  },

  alternar_apertura: {
    descripcion: "Abre o cierra las puertas o cajones de un módulo puntual.",
    argumentos: "{ columna, modulo, cajon?, hoja? }",
    aplicar(estado, args, servicios) {
      const visor = requiereVisor(servicios);
      const columnas = estado.design.columns;
      validarIndice(args.columna, columnas.length, "la columna");
      const column = columnas[args.columna];
      validarIndice(args.modulo, column.modules.length, "el módulo");
      const modulo = column.modules[args.modulo];

      const resultado = obtenerResultado(estado);
      const partesDelModulo = resultado.parts.filter((parte) => parte.sourceModuleId === modulo.id);
      const ROLES_CAJON = new Set(["drawer-front", "drawer-side", "drawer-back", "drawer-bottom"]);
      const frentes = partesDelModulo.filter(
        (parte) => parte.role === "door-front" || ROLES_CAJON.has(parte.role),
      );
      if (frentes.length === 0) {
        fallar("modulo_sin_frentes", "Ese módulo no tiene puertas ni cajones que abrir.", "Los estantes no se abren.");
      }

      if (modulo.type === "drawer") {
        const cajon = args.cajon === undefined ? 0 : args.cajon;
        const grupos = [...new Set(
          frentes
            .filter((parte) => parte.drawerIndex !== undefined)
            .map((parte) => `drawer:${modulo.id}:${parte.drawerIndex}`),
        )];
        validarIndice(cajon, grupos.length, "el cajón");
        const grupo = grupos[cajon];
        const abierto = visor.getAperturaGrupo(grupo) > 0.5;
        visor.setAperturaGrupo(grupo, abierto ? 0 : 1);
        return { resultado: { grupo, abierto: !abierto } };
      }

      // Puertas: puede haber una hoja o un par
      const hojas = frentes.filter((parte) => parte.role === "door-front");
      const grupos = hojas.map((parte) => `door:${parte.key}`);
      const abierto = grupos.some((grupo) => visor.getAperturaGrupo(grupo) > 0.5);
      for (const grupo of grupos) visor.setAperturaGrupo(grupo, abierto ? 0 : 1);
      return { resultado: { grupos, abierto: !abierto } };
    },
  },

  mover_camara: {
    descripcion: "Mueve la cámara del visor 3D (rotación y zoom).",
    argumentos: "{ yaw?, pitch?, zoom? }",
    aplicar(estado, args, servicios) {
      const visor = requiereVisor(servicios);
      if (args.yaw === undefined && args.pitch === undefined && args.zoom === undefined) {
        fallar("sin_cambios", "No indicaste qué mover.", "Pasá yaw, pitch o zoom.");
      }
      visor.setCamara({
        yaw: args.yaw === undefined ? visor.estado.yaw : Number(args.yaw),
        pitch: args.pitch === undefined ? visor.estado.pitch : Number(args.pitch),
        zoom: args.zoom === undefined ? visor.estado.zoom : Number(args.zoom),
      });
      return { resultado: { yaw: visor.estado.yaw, pitch: visor.estado.pitch, zoom: visor.estado.zoom } };
    },
  },

  reiniciar_camara: {
    descripcion: "Vuelve la cámara a la vista inicial.",
    argumentos: "{}",
    aplicar(estado, args, servicios) {
      requiereVisor(servicios).reiniciarCamara();
      return { resultado: { camara: "inicial" } };
    },
  },

  fijar_vista: {
    descripcion: "Cambia el modo de vista: 2D/3D, medidas y frentes.",
    argumentos: "{ modo?, medidas?, frentes? }",
    aplicar(estado, args, servicios) {
      const pedido = {};
      if (args.modo !== undefined) {
        if (!["2d", "3d"].includes(args.modo)) {
          fallar("modo_invalido", `Modo "${args.modo}" inválido.`, 'Usá "3d" o "2d".');
        }
        pedido.modo = args.modo;
      }
      if (args.medidas !== undefined) {
        if (!["hover", "todas", "sin"].includes(args.medidas)) {
          fallar("medidas_invalidas", `Medidas "${args.medidas}" inválidas.`, 'Usá "hover", "todas" o "sin".');
        }
        pedido.medidas = args.medidas;
      }
      if (args.frentes !== undefined) pedido.frentes = Boolean(args.frentes);
      if (Object.keys(pedido).length === 0) {
        fallar("sin_cambios", "No indicaste qué cambiar de la vista.", "Pasá modo, medidas o frentes.");
      }
      if (!servicios.fijarVista) {
        fallar("sin_visor", "La vista todavía no está disponible.", "Esperá a que cargue la app.");
      }
      servicios.fijarVista(pedido);
      return { resultado: pedido };
    },
  },

  /* ── consultas (no cambian nada) ────────────────────────────────────── */

  obtener_estado: {
    descripcion: "Devuelve el diseño completo con un resumen del despiece.",
    argumentos: "{}",
    aplicar(estado) {
      const resultado = obtenerResultado(estado);
      return {
        resultado: {
          id: estado.id,
          nombre: estado.name,
          design: estado.design,
          resumen: summarize(resultado),
          avisos: resultado.issues.length,
        },
      };
    },
  },

  obtener_diseno: {
    descripcion: "Devuelve solo el diseño (columnas y configuración).",
    argumentos: "{}",
    aplicar(estado) {
      return { resultado: { nombre: estado.name, design: estado.design } };
    },
  },

  obtener_despiece: {
    descripcion: "Devuelve la lista de corte agrupada y el resumen.",
    argumentos: "{}",
    aplicar(estado) {
      const resultado = obtenerResultado(estado);
      return {
        resultado: {
          lineas: buildCutlist(resultado.parts),
          resumen: summarize(resultado),
          roles: ROLE_LABELS,
        },
      };
    },
  },

  obtener_mecanizados: {
    descripcion: "Devuelve los mecanizados (perforaciones y ranuras).",
    argumentos: "{}",
    aplicar(estado) {
      const resultado = obtenerResultado(estado);
      return { resultado: { operaciones: resultado.operations, total: resultado.operations.length } };
    },
  },

  obtener_avisos: {
    descripcion: "Devuelve los avisos de validación del diseño.",
    argumentos: "{}",
    aplicar(estado) {
      const resultado = obtenerResultado(estado);
      return {
        resultado: { avisos: resultado.issues, valido: resultado.issues.length === 0 },
      };
    },
  },

  obtener_comandos: {
    descripcion: "Lista los comandos disponibles con su descripción y argumentos.",
    argumentos: "{}",
    aplicar() {
      return {
        resultado: Object.entries(COMANDOS).map(([nombre, comando]) => ({
          nombre,
          descripcion: comando.descripcion,
          argumentos: comando.argumentos,
          esquema: ESQUEMAS[nombre],
        })),
      };
    },
  },

  deshacer: {
    descripcion: "Deshace el último cambio del proyecto (historial de la sesión).",
    argumentos: "{}",
    // Lo maneja `crearSesion` antes de buscar en el catálogo; existe acá para
    // que la API y MCP lo descubran y lo puedan llamar por nombre.
  },

  rehacer: {
    descripcion: "Rehace el último cambio deshecho (historial de la sesión).",
    argumentos: "{}",
  },

  capturar_vista: {
    descripcion: "Devuelve una captura PNG del visor (data URL).",
    argumentos: "{ ancho?, alto? }",
    aplicar(estado, args, servicios) {
      if (!servicios.capturarVista) {
        fallar("sin_visor", "El visor 3D todavía no está disponible.", "Esperá a que cargue la app.");
      }
      const png = servicios.capturarVista({ ancho: args.ancho, alto: args.alto });
      if (!png) fallar("sin_captura", "No se pudo capturar la vista.", "Probá de nuevo con la vista 3D activa.");
      return { resultado: { png } };
    },
  },
};

/* ── historial y sesión ──────────────────────────────────────────────────── */

function buscarPlantilla(id) {
  const plantilla = TEMPLATES.find((item) => item.id === id);
  if (!plantilla) {
    fallar("plantilla_desconocida", `No existe la plantilla "${id}".`, listaPlantillasSugerencia());
  }
  return plantilla;
}

function listaPlantillasSugerencia() {
  return `Plantillas disponibles: ${TEMPLATES.map((item) => item.id).join(", ")}.`;
}

function normalizarEstadoInicial(entrada = {}) {
  const design = normalizarDiseno(entrada.design ?? entrada);
  return {
    id: entrada.id ?? idProyecto(),
    name: String(entrada.name ?? entrada.nombre ?? "Proyecto").slice(0, LARGO_MAXIMO_NOMBRE),
    design,
  };
}

/**
 * Crea una sesión de edición: estado + historial + comandos.
 *
 * @param {{ estadoInicial?: object, servicios?: object }} opciones
 *   servicios: { visor?, fijarVista?, capturarVista?, alCambiar?(estado, info) }
 */
export function crearSesion({ estadoInicial = {}, servicios = {} } = {}) {
  let estado = normalizarEstadoInicial(estadoInicial);
  let revision = 0;
  const pasados = [];
  const futuros = [];

  const respuestaOk = (resultado) => ({ ok: true, revision, resultado: resultado ?? null });
  const respuestaError = (codigo, mensaje, sugerencia) => ({
    ok: false,
    revision,
    error: { codigo, mensaje, sugerencia },
  });

  function notificar(comando) {
    try {
      servicios.alCambiar?.(clonar(estado), { comando });
    } catch {
      /* la UI no debe romper la sesión */
    }
  }

  function aplicar(nombre, argumentos = {}) {
    if (nombre === "deshacer" || nombre === "rehacer") return moverHistorial(nombre);

    const comando = COMANDOS[nombre];
    if (!comando) {
      return respuestaError(
        "comando_desconocido",
        `No existe el comando "${nombre}".`,
        "Usá obtener_comandos para ver la lista.",
      );
    }

    try {
      const salida = comando.aplicar(estado, argumentos ?? {}, servicios) ?? {};
      if (salida.estado) {
        pasados.push(clonar(estado));
        if (pasados.length > LIMITE_HISTORIAL) pasados.shift();
        futuros.length = 0;
        estado = salida.estado;
        revision += 1;
        notificar(nombre);
      }
      return respuestaOk(salida.resultado);
    } catch (error) {
      if (error instanceof ErrorComando) {
        return respuestaError(error.codigo, error.message, error.sugerencia);
      }
      return respuestaError("error_interno", error.message ?? "Error inesperado.");
    }
  }

  function moverHistorial(nombre) {
    const origen = nombre === "deshacer" ? pasados : futuros;
    const destino = nombre === "deshacer" ? futuros : pasados;
    if (origen.length === 0) {
      return respuestaError(
        nombre === "deshacer" ? "sin_cambios_para_deshacer" : "sin_cambios_para_rehacer",
        nombre === "deshacer" ? "No hay cambios para deshacer." : "No hay cambios para rehacer.",
        "Seguí editando el mueble.",
      );
    }
    destino.push(clonar(estado));
    estado = origen.pop();
    revision += 1;
    notificar(nombre);
    return respuestaOk({ nombre: estado.name });
  }

  return {
    aplicar,
    reiniciar(nuevoEstado) {
      estado = normalizarEstadoInicial(nuevoEstado);
      revision += 1;
      pasados.length = 0;
      futuros.length = 0;
      notificar("reiniciar");
    },
    get estado() {
      return clonar(estado);
    },
    get revision() {
      return revision;
    },
    get puedeDeshacer() {
      return pasados.length > 0;
    },
    get puedeRehacer() {
      return futuros.length > 0;
    },
  };
}

export { normalizarDiseno };

/* ── esquemas de entrada (JSON Schema) ───────────────────────────────────── */

/**
 * Esquema de entrada de cada comando.
 *
 * Es la fuente de verdad para validar pedidos externos (API/MCP) y para que un
 * agente sepa qué mandar. Los comandos solo usan nombres y descripciones.
 */
export const ESQUEMAS = {
  crear_proyecto: {
    type: "object",
    properties: {
      nombre: { type: "string", maxLength: 80 },
      plantillaId: { type: "string", enum: TEMPLATES.map((plantilla) => plantilla.id) },
    },
    additionalProperties: false,
  },
  cargar_plantilla: {
    type: "object",
    properties: {
      plantillaId: { type: "string", enum: TEMPLATES.map((plantilla) => plantilla.id) },
      nombre: { type: "string", maxLength: 80 },
    },
    required: ["plantillaId"],
    additionalProperties: false,
  },
  cargar_diseno: {
    type: "object",
    properties: {
      design: { type: "object", description: "Diseño completo: { columns: [...], config?: {...} }." },
      nombre: { type: "string", maxLength: 80 },
    },
    required: ["design"],
    additionalProperties: false,
  },
  renombrar_proyecto: {
    type: "object",
    properties: { nombre: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["nombre"],
    additionalProperties: false,
  },
  agregar_columna: {
    type: "object",
    properties: {
      ancho: { type: "number", minimum: 0.1, maximum: 2.5, description: "Ancho en metros." },
      indice: { type: "integer", minimum: 0, description: "Posición donde insertar (0..columnas)." },
      modulo: {
        type: "object",
        properties: {
          tipo: { type: "string", enum: [...TIPOS_VALIDOS] },
          alto: { type: "number", minimum: 0.05, maximum: 3 },
          cajones: { type: "integer", minimum: 1, maximum: 8 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  quitar_columna: {
    type: "object",
    properties: { indice: { type: "integer", minimum: 0 } },
    required: ["indice"],
    additionalProperties: false,
  },
  fijar_ancho_columna: {
    type: "object",
    properties: {
      indice: { type: "integer", minimum: 0 },
      ancho: { type: "number", minimum: 0.1, maximum: 2.5 },
    },
    required: ["indice", "ancho"],
    additionalProperties: false,
  },
  agregar_modulo: {
    type: "object",
    properties: {
      columna: { type: "integer", minimum: 0 },
      tipo: { type: "string", enum: [...TIPOS_VALIDOS] },
      alto: { type: "number", minimum: 0.05, maximum: 3 },
      cajones: { type: "integer", minimum: 1, maximum: 8 },
      indice: { type: "integer", minimum: 0 },
    },
    required: ["columna", "tipo"],
    additionalProperties: false,
  },
  editar_modulo: {
    type: "object",
    properties: {
      columna: { type: "integer", minimum: 0 },
      modulo: { type: "integer", minimum: 0 },
      tipo: { type: "string", enum: [...TIPOS_VALIDOS] },
      alto: { type: "number", minimum: 0.05, maximum: 3 },
      cajones: { type: "integer", minimum: 1, maximum: 8 },
    },
    required: ["columna", "modulo"],
    additionalProperties: false,
  },
  quitar_modulo: {
    type: "object",
    properties: {
      columna: { type: "integer", minimum: 0 },
      modulo: { type: "integer", minimum: 0 },
    },
    required: ["columna", "modulo"],
    additionalProperties: false,
  },
  fijar_config: {
    type: "object",
    properties: {
      valores: {
        type: "object",
        description: `Claves válidas: ${Object.keys(DEFAULT_CONFIG).join(", ")}.`,
        additionalProperties: { type: "number", minimum: 0, maximum: 5 },
      },
    },
    required: ["valores"],
    additionalProperties: false,
  },
  abrir_todo: {
    type: "object",
    properties: { abierto: { type: "boolean", description: "true abre, false cierra." } },
    additionalProperties: false,
  },
  alternar_apertura: {
    type: "object",
    properties: {
      columna: { type: "integer", minimum: 0 },
      modulo: { type: "integer", minimum: 0 },
      cajon: { type: "integer", minimum: 0, description: "Índice del cajón (0-based)." },
      hoja: { type: "string", enum: ["left", "right"], description: "Hoja de puerta a abrir." },
    },
    required: ["columna", "modulo"],
    additionalProperties: false,
  },
  mover_camara: {
    type: "object",
    properties: {
      yaw: { type: "number" },
      pitch: { type: "number", minimum: -1.45, maximum: 1.45 },
      zoom: { type: "number", minimum: 0.35, maximum: 4 },
    },
    additionalProperties: false,
  },
  reiniciar_camara: { type: "object", properties: {}, additionalProperties: false },
  fijar_vista: {
    type: "object",
    properties: {
      modo: { type: "string", enum: ["3d", "2d"] },
      medidas: { type: "string", enum: ["hover", "todas", "sin"] },
      frentes: { type: "boolean" },
    },
    additionalProperties: false,
  },
  obtener_estado: { type: "object", properties: {}, additionalProperties: false },
  obtener_diseno: { type: "object", properties: {}, additionalProperties: false },
  obtener_despiece: { type: "object", properties: {}, additionalProperties: false },
  obtener_mecanizados: { type: "object", properties: {}, additionalProperties: false },
  obtener_avisos: { type: "object", properties: {}, additionalProperties: false },
  obtener_comandos: { type: "object", properties: {}, additionalProperties: false },
  deshacer: { type: "object", properties: {}, additionalProperties: false },
  rehacer: { type: "object", properties: {}, additionalProperties: false },
  capturar_vista: {
    type: "object",
    properties: {
      ancho: { type: "integer", minimum: 1 },
      alto: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
};
