/**
 * Despiece de un mueble: agrupa las piezas para cortar y las exporta.
 *
 * El motor devuelve todas las piezas individuales (una puerta izquierda, un
 * lateral, etc). Para el taller lo útil es la lista agrupada: "18 placas de
 * 550 × 1726", etc.
 */

/** Orden y nombre legible de cada tipo de pieza. */
export const ROLE_LABELS = Object.freeze({
  "vertical-side": "Lateral",
  "horizontal-deck": "Estante / tapa",
  "back-panel": "Fondo",
  "door-front": "Frente de puerta",
  "drawer-front": "Frente de cajón",
  "drawer-side": "Lateral de cajón",
  "drawer-back": "Trasera de cajón",
  "drawer-bottom": "Fondo de cajón",
});

export const ROLE_ORDER = Object.freeze([
  "vertical-side",
  "horizontal-deck",
  "back-panel",
  "door-front",
  "drawer-front",
  "drawer-side",
  "drawer-back",
  "drawer-bottom",
]);

/** Redondeo a décimas de milímetro, para agrupar piezas iguales. */
const tenth = (meters) => Math.round(meters * 10000) / 10;

/**
 * Agrupa las piezas del motor en líneas de corte.
 *
 * @param {Array} parts - piezas devueltas por compileFurniture
 * @returns {Array<{role, label, widthMm, heightMm, thicknessMm, quantity, areaM2}>}
 */
export function buildCutlist(parts = []) {
  const groups = new Map();

  for (const part of parts) {
    if (!part.size) continue;
    const widthMm = tenth(part.size.width);
    const heightMm = tenth(part.size.height);
    const thicknessMm = tenth(part.size.thickness);
    const key = `${part.role}|${widthMm}|${heightMm}|${thicknessMm}`;

    const existing = groups.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      groups.set(key, {
        role: part.role,
        label: ROLE_LABELS[part.role] ?? part.role,
        widthMm,
        heightMm,
        thicknessMm,
        quantity: 1,
        areaM2: 0,
      });
    }
  }

  const rows = [...groups.values()];
  for (const row of rows) {
    row.areaM2 = (row.widthMm / 1000) * (row.heightMm / 1000) * row.quantity;
  }

  rows.sort((a, b) => {
    const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    if (byRole !== 0) return byRole;
    if (b.heightMm !== a.heightMm) return b.heightMm - a.heightMm;
    return b.widthMm - a.widthMm;
  });

  return rows;
}

/** Resumen numérico del mueble. */
export function summarize(result = {}) {
  const parts = result.parts ?? [];
  const rows = buildCutlist(parts);
  const area = parts.reduce(
    (total, part) => total + (part.size ? part.size.width * part.size.height : 0),
    0,
  );
  return {
    width: result.bounds?.width ?? 0,
    height: result.bounds?.height ?? 0,
    depth: result.bounds?.depth ?? 0,
    parts: parts.length,
    cutRows: rows.length,
    operations: (result.operations ?? []).length,
    areaM2: area,
    modules: (result.parts ?? []).filter((p) => p.role === "back-panel").length,
    issues: (result.issues ?? []).length,
  };
}

/**
 * Exporta la lista de corte a CSV (formato planilla, separador configurable).
 *
 * @param {Array} rows - salida de buildCutlist
 * @param {{separator?: string, decimal?: string}} options
 */
export function cutlistToCsv(rows, options = {}) {
  const separator = options.separator ?? ";";
  const decimal = options.decimal ?? ",";
  const format = (value) => String(value).replace(".", decimal);

  const lines = [
    ["Pieza", "Cantidad", "Ancho (mm)", "Alto (mm)", "Espesor (mm)", "Superficie (m2)"].join(separator),
  ];

  for (const row of rows) {
    lines.push([
      row.label,
      row.quantity,
      format(row.widthMm),
      format(row.heightMm),
      format(row.thicknessMm),
      format(row.areaM2.toFixed(3)),
    ].join(separator));
  }

  return lines.join("\r\n");
}
