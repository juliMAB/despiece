/**
 * Modelo del diseño: validación, normalización y creación de proyectos.
 *
 * Acá vive lo que es "un diseño válido" para Despiece. Lo usan tanto la UI
 * como la capa de comandos (que en el futuro manejará un agente), así que no
 * puede depender del DOM ni de nada visual.
 */

import { DEFAULT_CONFIG, roundMm } from "../engine/config.js";
import { compileFurniture } from "../engine/compile.js";

/* ── tipos de módulo y límites ───────────────────────────────────────────── */

/** Tipos de módulo válidos y su etiqueta para la UI. */
export const TIPOS_MODULO = Object.freeze([
  ["doors", "Puertas (par)"],
  ["left-door", "Puerta izq."],
  ["right-door", "Puerta der."],
  ["drawer", "Cajones"],
  ["shelf", "Estante"],
]);

export const TIPOS_VALIDOS = new Set(TIPOS_MODULO.map(([tipo]) => tipo));

/** Límites de edición (los mismos que usa la interfaz). */
export const LIMITES = Object.freeze({
  anchoColumna: { min: 0.1, max: 2.5 },
  altoModulo: { min: 0.05, max: 3 },
  cajones: { min: 1, max: 8 },
  config: { min: 0, max: 5 },
});

/** Identificador único para módulos. */
export function idModulo() {
  return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

/** Identificador único para proyectos. */
export function idProyecto() {
  return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

export const limitar = (valor, minimo, maximo) => Math.min(maximo, Math.max(minimo, valor));

/** Convierte un valor en número positivo o devuelve el fallback. */
export function numero(valor, porDefecto = 0) {
  const n = Number.parseFloat(String(valor).replace(",", "."));
  return Number.isFinite(n) ? n : porDefecto;
}

/* ── normalización ───────────────────────────────────────────────────────── */

/** Normaliza un módulo. Lanza si el tipo no es válido. */
export function normalizarModulo(entrada) {
  const tipo = TIPOS_VALIDOS.has(entrada?.type) ? entrada.type : "doors";
  const modulo = {
    id: typeof entrada?.id === "string" && entrada.id ? entrada.id : idModulo(),
    type: tipo,
    height: limitar(numero(entrada?.height, 0.4), LIMITES.altoModulo.min, LIMITES.altoModulo.max),
  };
  if (tipo === "drawer") {
    modulo.drawerCount = limitar(
      Math.round(numero(entrada?.drawerCount, 2)),
      LIMITES.cajones.min,
      LIMITES.cajones.max,
    );
  }
  return modulo;
}

/** Normaliza una columna. */
export function normalizarColumna(entrada) {
  const ancho = limitar(numero(entrada?.width, 0.6), LIMITES.anchoColumna.min, LIMITES.anchoColumna.max);
  const modulos = Array.isArray(entrada?.modules) ? entrada.modules.map(normalizarModulo) : [];
  return { width: ancho, modules: modulos };
}

/**
 * Valida y normaliza un diseño completo.
 * Acepta tanto `{columns, config}` como un objeto proyecto `{design: {...}}`.
 * Lanza un error legible si la forma es inválida.
 */
export function normalizarDiseno(entrada) {
  const base = entrada?.design ?? entrada;
  if (!base || !Array.isArray(base.columns)) {
    throw new Error("El diseño no tiene columnas (falta `columns`).");
  }

  const columns = base.columns.map(normalizarColumna);

  const config = {};
  if (base.config && typeof base.config === "object") {
    for (const clave of Object.keys(DEFAULT_CONFIG)) {
      const valor = numero(base.config[clave], Number.NaN);
      if (Number.isFinite(valor)) {
        config[clave] = limitar(valor, LIMITES.config.min, LIMITES.config.max);
      }
    }
  }

  return Object.keys(config).length > 0 ? { columns, config } : { columns };
}

/** Proyecto en blanco: un cuerpo con un par de puertas. */
export function proyectoEnBlanco() {
  return {
    id: idProyecto(),
    name: "Mueble nuevo",
    design: {
      columns: [{ width: 0.6, modules: [{ id: idModulo(), type: "doors", height: 0.8 }] }],
    },
  };
}

/** Proyecto a partir de una plantilla (del catálogo de `templates/`). */
export function proyectoDesdePlantilla(template) {
  return {
    id: idProyecto(),
    name: template.name,
    design: {
      columns: template.columns.map((columna) => ({
        width: columna.width,
        modules: columna.modules.map((modulo) => ({ ...modulo, id: idModulo() })),
      })),
      ...(template.config ? { config: { ...template.config } } : {}),
    },
  };
}

/** Alto total de una columna. */
export function altoColumna(columna) {
  return columna.modules.reduce((total, modulo) => total + modulo.height, 0);
}

/** Compila un diseño y devuelve el resultado del motor. */
export function compilar(design) {
  return compileFurniture(design);
}

/** Redondeo a mm (reexportado para comodidad). */
export { roundMm };
