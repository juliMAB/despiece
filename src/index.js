/**
 * Despiece — diseño de muebles y despiece de piezas.
 * Punto de entrada de la librería.
 *
 * Ejemplo:
 *   import { compileFurniture, buildCutlist, cutlistToCsv } from "./src/index.js";
 *
 *   const resultado = compileFurniture({
 *     columns: [{ width: 0.6, modules: [{ id: "p1", type: "doors", height: 0.8 }] }],
 *   });
 *   const lista = buildCutlist(resultado.parts);
 *   const csv = cutlistToCsv(lista);
 */

export {
  compileFurniture,
  computeCells,
  validateDesign,
  columnHeight,
} from "./engine/compile.js";

export {
  DEFAULT_CONFIG,
  PRECISION,
  MIN_SIZE,
  roundMm,
  clampSize,
  withDefaults,
} from "./engine/config.js";

export {
  buildCutlist,
  cutlistToCsv,
  summarize,
  ROLE_LABELS,
  ROLE_ORDER,
} from "./engine/cutlist.js";

export { TEMPLATES, getTemplate } from "../templates/index.js";
