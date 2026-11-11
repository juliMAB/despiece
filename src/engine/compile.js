/**
 * Motor de despiece de Despiece.
 * ==============================
 *
 * Entrada: un diseño paramétrico
 *   { columns: [{ width, modules: [{ id, type, height, drawerCount? }] }], config? }
 *
 * Salida:
 *   { parts, operations, bounds, issues }
 *
 * - `parts`       son los paneles a cortar: posición, tamaño y orientación.
 * - `operations`  son los mecanizados: perforaciones de tiradores y ranuras
 *                 para el fondo (en laterales, estantes y cajas de cajón).
 * - `bounds`      es el volumen exterior del mueble.
 * - `issues`      son avisos de diseño (medidas imposibles, piezas sin espacio).
 *
 * Convenciones:
 * - Todo en METROS. El resultado final se redondea a 1 mm.
 * - Eje X: a lo ancho (centrado en 0).
 * - Eje Y: a lo alto (0 = piso del mueble, crece hacia arriba).
 * - Eje Z: hacia el fondo (negativo = atrás, positivo = frente).
 *
 * Los tipos de módulo son:
 *   "doors"      → un par de puertas con tirador
 *   "left-door"  → una puerta con bisagra a la izquierda
 *   "right-door" → una puerta con bisagra a la derecha
 *   "drawer"     → una pila de cajones
 *   "shelf"      → estante (sin frente)
 */

import {
  DEFAULT_CONFIG,
  MIN_SIZE,
  roundMm,
  clampSize,
  withDefaults,
} from "./config.js";

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Celdas interiores
 * ────────────────────────────────────────────────────────────────────────── */

/** Alto total de una columna (suma de sus módulos). */
export function columnHeight(column) {
  return column.modules.reduce((total, mod) => total + mod.height, 0);
}

/**
 * Calcula la caja interior libre de cada módulo, descontando los laterales y
 * las luces de armado. Es la base de todo lo que viene después.
 */
export function computeCells(columns, rawConfig) {
  const config = withDefaults(rawConfig);
  const {
    panelThickness, panelJointClearance, depth,
    backPanelInset, backPanelThickness, frontClearance,
  } = config;

  const totalWidth = columns.reduce((total, col) => total + col.width, 0);
  const halfWidth = totalWidth / 2;
  let cursorX = 0;

  return columns.map((column, columnIndex) => {
    const centerX = cursorX + column.width / 2 - halfWidth;
    cursorX += column.width;

    let y = 0;
    return column.modules.map((mod, moduleIndex) => {
      const baseYMin = y;
      const baseYMax = baseYMin + mod.height;
      y = baseYMax;

      const xMin = centerX - column.width / 2 + panelThickness / 2 + panelJointClearance;
      const xMax = centerX + column.width / 2 - panelThickness / 2 - panelJointClearance;
      const yMin = baseYMin + panelThickness / 2 + panelJointClearance;
      const yMax = baseYMax - panelThickness / 2 - panelJointClearance;
      const zMin = -depth / 2 + backPanelInset + backPanelThickness + panelJointClearance;
      const zMax = depth / 2 - panelJointClearance;

      return {
        moduleId: mod.id,
        columnIndex,
        moduleIndex,
        xMin, xMax, yMin, yMax, zMin, zMax,
        width: xMax - xMin,
        height: yMax - yMin,
        depth: zMax - zMin,
        /** Z del plano donde apoyan puertas y frentes de cajón. */
        frontZ: depth / 2 - panelThickness / 2,
        frontWidth: xMax - xMin - 2 * frontClearance,
        frontHeight: yMax - yMin - 2 * frontClearance,
      };
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Validaciones
 * ────────────────────────────────────────────────────────────────────────── */

function issue(severity, code, message, cell) {
  return {
    severity,
    code,
    message,
    moduleId: cell?.moduleId,
    columnIndex: cell?.columnIndex,
    moduleIndex: cell?.moduleIndex,
  };
}

/** Revisa que el diseño sea construible. No bloquea el cálculo. */
export function validateDesign(columns, cells, rawConfig) {
  const config = withDefaults(rawConfig);
  const issues = [];

  if (
    config.backPanelInset + config.backPanelThickness + config.panelJointClearance >=
    config.depth
  ) {
    issues.push(
      issue("error", "back-reserve-overflows-depth",
        "El fondo, su retiro y la luz de armado no entran en la profundidad del mueble."),
    );
  }

  columns.forEach((column, columnIndex) => {
    column.modules.forEach((mod, moduleIndex) => {
      const cell = cells[columnIndex]?.[moduleIndex];
      if (!cell) return;

      if (cell.width < MIN_SIZE) issues.push(issue("error", "cell-too-narrow", "El módulo es demasiado angosto.", cell));
      if (cell.height < MIN_SIZE) issues.push(issue("error", "cell-too-short", "El módulo es demasiado bajo.", cell));
      if (cell.depth < MIN_SIZE) issues.push(issue("error", "cell-too-shallow", "El módulo es demasiado poco profundo.", cell));
      if (cell.frontWidth < MIN_SIZE || cell.frontHeight < MIN_SIZE) {
        issues.push(issue("error", "front-degenerate", "El frente del módulo no tiene tamaño.", cell));
      }

      if (mod.type === "doors" && (cell.frontWidth - 2 * config.frontClearance) / 2 < MIN_SIZE) {
        issues.push(issue("error", "paired-door-too-narrow", "Las hojas de puerta quedan demasiado angostas.", cell));
      }

      if (mod.type === "drawer") {
        if (config.drawerSlidesReserve >= cell.depth) {
          issues.push(issue("error", "slides-reserve-overflows-cell", "La reserva de corredera no entra en el módulo.", cell));
        }
        const count = Math.max(1, Math.floor(mod.drawerCount || 1));
        const frontBand = (cell.height - config.frontClearance * (count + 1)) / count;
        const bottomBand =
          (cell.height - 2 * config.panelJointClearance * Math.max(0, count - 1)) / count -
          2 * config.drawerBottomInset -
          2 * config.panelJointClearance;
        const sideHeight = bottomBand - config.backPanelInset - config.backPanelThickness;

        if (frontBand < MIN_SIZE || bottomBand < MIN_SIZE || sideHeight < MIN_SIZE) {
          issues.push(issue("error", "drawer-band-too-short",
            "No entra la banda del cajón (frente, fondo, laterales y luces).", cell));
        }
        if (cell.depth - config.drawerSlidesReserve < MIN_SIZE) {
          issues.push(issue("error", "drawer-depth-too-shallow",
            "La caja del cajón queda demasiado profunda para el módulo.", cell));
        }
      }
    });
  });

  return issues;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Piezas
 * ────────────────────────────────────────────────────────────────────────── */

/** Lateral vertical. `x` es el borde; `height` el alto de la columna más alta. */
function verticalSide(boundaryIndex, x, height, moduleIds, config) {
  const overhang = config.sidePanelOverhang;
  return {
    kind: "panel",
    key: `vertical:${boundaryIndex}`,
    role: "vertical-side",
    position: { x, y: height / 2, z: 0 },
    size: { width: config.depth, height: height + 2 * overhang, thickness: config.panelThickness },
    orientation: "vertical-yz",
    touchedModuleIds: moduleIds,
  };
}

/** Estante o tapa horizontal. `y` es la altura del borde inferior. */
function horizontalDeck(columnIndex, boundaryIndex, x, y, columnWidth, moduleIds, config) {
  const width = Math.max(MIN_SIZE, columnWidth - config.panelThickness - 2 * config.panelJointClearance);
  return {
    kind: "panel",
    key: `horizontal:${columnIndex}:${boundaryIndex}`,
    role: "horizontal-deck",
    position: { x, y, z: config.sidePanelOverhang / 4 },
    size: { width, height: config.depth + config.sidePanelOverhang / 2, thickness: config.panelThickness },
    orientation: "horizontal-xz",
    touchedModuleIds: moduleIds,
  };
}

/** Fondo del módulo, metido en la ranura contra los laterales. */
function backPanel(mod, cell, config) {
  const groove = config.panelThickness * 0.25;
  return {
    kind: "panel",
    key: `back:${cell.columnIndex}:${cell.moduleIndex}`,
    role: "back-panel",
    sourceModuleId: mod.id,
    position: {
      x: (cell.xMin + cell.xMax) / 2,
      y: (cell.yMin + cell.yMax) / 2,
      z: -config.depth / 2 + config.backPanelInset + config.backPanelThickness / 2,
    },
    size: {
      width: Math.max(MIN_SIZE, cell.width + 2 * groove),
      height: Math.max(MIN_SIZE, cell.height + 2 * groove),
      thickness: config.backPanelThickness,
    },
    orientation: "vertical-xy",
    touchedModuleIds: [mod.id],
  };
}

/** Perforación pasante para el tirador, con el centro siempre dentro del panel. */
function pullHole(panel, center, diameter, suffix) {
  const margin = Math.max(0, diameter / 2);
  const halfW = panel.size.width / 2;
  const halfH = panel.size.height / 2;
  const xMin = -halfW + margin;
  const xMax = halfW - margin;
  const yMin = -halfH + margin;
  const yMax = halfH - margin;

  return {
    kind: "operation",
    key: `hole:${panel.key}:${suffix}`,
    operationType: "through-hole",
    targetPanelKey: panel.key,
    face: "front",
    center: {
      x: xMin > xMax ? 0 : Math.min(xMax, Math.max(xMin, center.x)),
      y: yMin > yMax ? 0 : Math.min(yMax, Math.max(yMin, center.y)),
    },
    diameter,
    depth: panel.size.thickness,
    through: true,
    sourceModuleId: panel.sourceModuleId,
  };
}

/** Ranura del fondo en un lateral o estante (mecanizado de caja). */
function backRailCut(back, target, targetKind, config) {
  const grooveDepth = config.panelThickness * 0.25;
  const grooveWidth = config.backPanelThickness + config.backPanelGrooveClearance;
  const isSide = targetKind === "left-side" || targetKind === "right-side";
  let length, rotation, centerX, centerY;

  if (isSide) {
    const thickness = target.size.thickness;
    const height = target.size.height;
    const overhang = config.sidePanelOverhang;
    length = Math.max(MIN_SIZE, height - thickness + grooveDepth - overhang);
    rotation = Math.PI / 2;
    centerX = -(back.position.z - target.position.z);
    centerY = (grooveDepth - thickness - overhang) / 2;
  } else {
    length = Math.max(MIN_SIZE, target.size.width);
    rotation = 0;
    centerX = 0;
    centerY = -(back.position.z - target.position.z);
  }

  return {
    kind: "operation",
    key: `rail:back:${back.key}:${targetKind}`,
    operationType: "rail-cut",
    targetPanelKey: target.key,
    face: targetKind === "left-side" || targetKind === "bottom-deck" ? "front" : "back",
    center: { x: centerX, y: centerY },
    width: grooveWidth,
    length,
    depth: grooveDepth,
    rotation,
    sourceModuleId: back.sourceModuleId,
  };
}

/** Ranura del fondo en la caja del cajón. */
function drawerRailCut(bottom, target, targetKind, cell, config) {
  const grooveDepth = config.panelThickness * 0.25;
  const grooveWidth = config.backPanelThickness + config.backPanelGrooveClearance;
  const thickness = config.panelThickness;

  let face, length;
  if (targetKind === "left-side" || targetKind === "right-side") {
    face = targetKind === "left-side" ? "front" : "back";
    length = Math.max(MIN_SIZE, target.size.width);
  } else if (targetKind === "back") {
    face = "front";
    length = Math.max(MIN_SIZE, target.size.width);
  } else {
    face = "back";
    length = Math.max(MIN_SIZE, cell.width - 2 * thickness + 2 * grooveDepth);
  }

  const dx = bottom.position.x - target.position.x;
  const dy = bottom.position.y - target.position.y;

  return {
    kind: "operation",
    key: `rail:drawer:${bottom.key}:${targetKind}`,
    operationType: "rail-cut",
    targetPanelKey: target.key,
    face,
    center: targetKind === "left-side" || targetKind === "right-side"
      ? { x: -(bottom.position.z - target.position.z), y: dy }
      : { x: dx, y: dy },
    width: grooveWidth,
    length,
    depth: grooveDepth,
    rotation: 0,
    sourceModuleId: bottom.sourceModuleId,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Módulos con frente
 * ────────────────────────────────────────────────────────────────────────── */

/** Puertas (simples o en par) + sus tiradores. */
function buildDoorModule(mod, cell, config) {
  const clearance = config.frontClearance;
  const centerX = (cell.xMin + cell.xMax) / 2;
  const centerY = (cell.yMin + cell.yMax) / 2;
  const leafHeight = Math.max(MIN_SIZE, cell.frontHeight);
  const diameter = config.pullHoleDiameter;
  const edgeInset = config.pullHoleEdgeInset;

  /** Agujero de una puerta simple. */
  const singleHole = (panel, hinge) => {
    const halfW = panel.size.width / 2;
    const halfH = panel.size.height / 2;
    return { x: hinge === "left" ? halfW - edgeInset : -halfW + edgeInset, y: halfH - edgeInset };
  };

  /** Agujero de una hoja de puerta en par. */
  const pairedHole = (panel, side) => {
    const halfW = panel.size.width / 2;
    const halfH = panel.size.height / 2;
    const offset = halfW + clearance - config.pullHolePairGap / 2;
    return { x: side === "left" ? offset : -offset, y: halfH - edgeInset };
  };

  if (mod.type === "left-door" || mod.type === "right-door") {
    const hinge = mod.type === "left-door" ? "left" : "right";
    const panel = {
      kind: "panel",
      key: `door:${mod.id}`,
      role: "door-front",
      sourceModuleId: mod.id,
      doorHinge: hinge,
      position: { x: centerX, y: centerY, z: cell.frontZ },
      size: { width: Math.max(MIN_SIZE, cell.frontWidth), height: leafHeight, thickness: config.panelThickness },
      orientation: "vertical-xy",
    };
    return { panels: [panel], operations: [pullHole(panel, singleHole(panel, hinge), diameter, "a")] };
  }

  if (mod.type === "doors") {
    const leafWidth = Math.max(MIN_SIZE, (cell.frontWidth - 2 * clearance) / 2);
    const left = {
      kind: "panel",
      key: `door:${mod.id}:left`,
      role: "door-front",
      sourceModuleId: mod.id,
      doorHinge: "left",
      position: { x: centerX - leafWidth / 2 - clearance, y: centerY, z: cell.frontZ },
      size: { width: leafWidth, height: leafHeight, thickness: config.panelThickness },
      orientation: "vertical-xy",
    };
    const right = {
      kind: "panel",
      key: `door:${mod.id}:right`,
      role: "door-front",
      sourceModuleId: mod.id,
      doorHinge: "right",
      position: { x: centerX + leafWidth / 2 + clearance, y: centerY, z: cell.frontZ },
      size: { width: leafWidth, height: leafHeight, thickness: config.panelThickness },
      orientation: "vertical-xy",
    };
    return {
      panels: [left, right],
      operations: [
        pullHole(left, pairedHole(left, "left"), diameter, "a"),
        pullHole(right, pairedHole(right, "right"), diameter, "a"),
      ],
    };
  }

  return { panels: [], operations: [] };
}

/** Pila de cajones: frente, laterales, trasera, fondo + tiradores y ranuras. */
function buildDrawerModule(mod, cell, config) {
  const panels = [];
  const operations = [];

  const count = Math.max(1, Math.floor(mod.drawerCount || 1));
  const panelT = config.panelThickness;
  const backT = config.backPanelThickness;
  const jointClearance = config.panelJointClearance;
  const bottomInset = config.drawerBottomInset;
  const backInset = config.backPanelInset;
  const frontClearance = config.frontClearance;

  const centerX = (cell.xMin + cell.xMax) / 2;

  // Alto del frente de cada cajón.
  const frontBandRaw = (cell.height - frontClearance * (count + 1)) / count;
  const frontBand = Math.max(MIN_SIZE, frontBandRaw);

  // Reparto vertical de las cajas (sin las luces de los frentes).
  const bandGap = 2 * jointClearance;
  const boxBand = (cell.height - bandGap * Math.max(0, count - 1)) / count;

  // Caja del cajón.
  const boxDepth = Math.max(MIN_SIZE, cell.depth - config.drawerSlidesReserve);
  const sideDepth = Math.max(MIN_SIZE, boxDepth - 2 * panelT - 2 * jointClearance);
  const boxBackZ = cell.zMax - boxDepth;
  const boxCenterZ = boxBackZ + boxDepth / 2 + jointClearance;
  const groove = panelT * 0.25;
  const bottomWidth = Math.max(MIN_SIZE, cell.width - 2 * jointClearance - 2 * panelT + 2 * groove);
  const leftX = cell.xMin + panelT / 2 + jointClearance;
  const rightX = cell.xMax - panelT / 2 - jointClearance;
  const backPanelZ = boxBackZ + panelT / 2 + jointClearance;

  for (let index = 0; index < count; index++) {
    // Centro del frente: reparte el alto del módulo entre frentes y luces.
    const frontCenterY = cell.yMin + frontClearance + index * (frontBand + frontClearance) + frontBand / 2;

    // Banda de la caja (sin luces de frente).
    const boxBottom = cell.yMin + index * (boxBand + bandGap);
    const boxTop = boxBottom + boxBand;
    const sideBottom = boxBottom + bottomInset + jointClearance;
    const sideTop = boxTop - bottomInset - jointClearance;
    const sideHeight = Math.max(MIN_SIZE, sideTop - sideBottom);
    const sideCenterY = (sideBottom + sideTop) / 2;
    const bottomCenterY = sideBottom + backInset + backT / 2;

    const front = {
      kind: "panel",
      key: `drawer:${mod.id}:${index}:front`,
      role: "drawer-front",
      sourceModuleId: mod.id,
      position: { x: centerX, y: frontCenterY, z: cell.frontZ },
      size: { width: cell.frontWidth, height: frontBand, thickness: panelT },
      orientation: "vertical-xy",
    };
    panels.push(front);

    const holeY = frontBand / 2 - config.pullHoleEdgeInset;
    const holeX = config.pullHolePairGap / 2;
    operations.push(
      pullHole(front, { x: -holeX, y: holeY }, config.pullHoleDiameter, "left"),
      pullHole(front, { x: holeX, y: holeY }, config.pullHoleDiameter, "right"),
    );

    const leftSide = {
      kind: "panel",
      key: `drawer:${mod.id}:${index}:left`,
      role: "drawer-side",
      sourceModuleId: mod.id,
      position: { x: leftX, y: sideCenterY, z: boxCenterZ },
      size: { width: sideDepth, height: sideHeight, thickness: panelT },
      orientation: "vertical-yz",
    };
    const rightSide = {
      kind: "panel",
      key: `drawer:${mod.id}:${index}:right`,
      role: "drawer-side",
      sourceModuleId: mod.id,
      position: { x: rightX, y: sideCenterY, z: boxCenterZ },
      size: { width: sideDepth, height: sideHeight, thickness: panelT },
      orientation: "vertical-yz",
    };
    const back = {
      kind: "panel",
      key: `drawer:${mod.id}:${index}:back`,
      role: "drawer-back",
      sourceModuleId: mod.id,
      position: { x: centerX, y: sideCenterY, z: backPanelZ },
      size: { width: front.size.width, height: sideHeight, thickness: panelT },
      orientation: "vertical-xy",
    };
    const bottom = {
      kind: "panel",
      key: `drawer:${mod.id}:${index}:bottom`,
      role: "drawer-bottom",
      sourceModuleId: mod.id,
      position: { x: centerX, y: bottomCenterY, z: boxCenterZ },
      size: { width: bottomWidth, height: sideDepth, thickness: backT },
      orientation: "horizontal-xz",
    };
    panels.push(leftSide, rightSide, back, bottom);

    for (const [target, kind] of [
      [leftSide, "left-side"],
      [rightSide, "right-side"],
      [back, "back"],
      [front, "front"],
    ]) {
      operations.push(drawerRailCut(bottom, target, kind, cell, config));
    }
  }

  return { panels, operations };
}

/** Despacha según el tipo de módulo. */
function buildModule(mod, cell, config) {
  switch (mod.type) {
    case "shelf":
      return { panels: [], operations: [] };
    case "left-door":
    case "right-door":
    case "doors":
      return buildDoorModule(mod, cell, config);
    case "drawer":
      return buildDrawerModule(mod, cell, config);
    default:
      return { panels: [], operations: [] };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Compilación completa
 * ────────────────────────────────────────────────────────────────────────── */

function emptyResult(config) {
  return {
    parts: [],
    operations: [],
    bounds: { width: 0, height: 0, depth: roundMm(config.depth) },
    issues: [],
  };
}

/**
 * Compila un diseño en piezas, mecanizados y avisos.
 *
 * @param {{ columns?: Array, config?: object }} design
 * @returns {{ parts: Array, operations: Array, bounds: object, issues: Array }}
 */
export function compileFurniture(design = {}) {
  const config = withDefaults(design.config);
  const columns = design.columns ?? [];

  if (columns.length === 0) return emptyResult(config);

  const totalWidth = columns.reduce((total, col) => total + col.width, 0);
  if (!(totalWidth > 0)) return emptyResult(config);

  const cells = computeCells(columns, config);
  const issues = validateDesign(columns, cells, config);

  const parts = [];
  const operations = [];
  const partByKey = new Map();

  // Posiciones acumuladas de los bordes de columna, centradas en 0.
  const columnHeights = columns.map(columnHeight);
  const boundaries = [0];
  for (const column of columns) boundaries.push(boundaries[boundaries.length - 1] + column.width);

  const columnCenters = columns.map((_, index) =>
    (boundaries[index] + boundaries[index + 1]) / 2 - totalWidth / 2,
  );

  // ── Laterales ──────────────────────────────────────────────────────────
  for (let b = 0; b < boundaries.length; b++) {
    const x = boundaries[b] - totalWidth / 2;
    const height = Math.max(
      b > 0 ? columnHeights[b - 1] : 0,
      b < columns.length ? columnHeights[b] : 0,
    );
    const ids = [
      ...(b > 0 ? columns[b - 1].modules.map((m) => m.id) : []),
      ...(b < columns.length ? columns[b].modules.map((m) => m.id) : []),
    ];
    const side = verticalSide(b, x, height, ids, config);
    parts.push(side);
    partByKey.set(side.key, side);
  }

  // ── Estantes, fondos y módulos ─────────────────────────────────────────
  columns.forEach((column, columnIndex) => {
    if (column.modules.length === 0) return;

    const heights = [0];
    let accumulated = 0;
    for (const mod of column.modules) {
      accumulated += mod.height;
      heights.push(accumulated);
    }

    for (let boundary = 0; boundary < heights.length; boundary++) {
      const touched = boundary === 0
        ? [column.modules[0].id]
        : boundary === column.modules.length
          ? [column.modules[column.modules.length - 1].id]
          : [column.modules[boundary - 1].id, column.modules[boundary].id];

      const deck = horizontalDeck(
        columnIndex, boundary, columnCenters[columnIndex], heights[boundary],
        column.width, touched, config,
      );
      parts.push(deck);
      partByKey.set(deck.key, deck);
    }

    column.modules.forEach((mod, moduleIndex) => {
      const cell = cells[columnIndex]?.[moduleIndex];
      if (!cell) return;

      const back = backPanel(mod, cell, config);
      parts.push(back);
      partByKey.set(back.key, back);

      const built = buildModule(mod, cell, config);
      for (const panel of built.panels) {
        parts.push(panel);
        partByKey.set(panel.key, panel);
      }
      operations.push(...built.operations);
    });
  });

  // ── Ranuras del fondo en laterales y estantes ──────────────────────────
  columns.forEach((column, columnIndex) => {
    column.modules.forEach((mod, moduleIndex) => {
      const cell = cells[columnIndex]?.[moduleIndex];
      if (!cell) return;
      const back = partByKey.get(`back:${columnIndex}:${moduleIndex}`);
      if (!back) return;

      const targets = [
        [`vertical:${columnIndex}`, "left-side"],
        [`vertical:${columnIndex + 1}`, "right-side"],
        [`horizontal:${columnIndex}:${moduleIndex}`, "bottom-deck"],
        [`horizontal:${columnIndex}:${moduleIndex + 1}`, "top-deck"],
      ];
      for (const [key, kind] of targets) {
        const target = partByKey.get(key);
        if (target) operations.push(backRailCut(back, target, kind, config));
      }
    });
  });

  // ── Normalización final ────────────────────────────────────────────────
  // `-0` no aporta nada y hace ruido al comparar/serializar: se normaliza a 0.
  const zero = (value) => (Object.is(value, -0) ? 0 : value);

  const overhang = config.sidePanelOverhang;
  const finalParts = parts.map((part) => ({
    ...part,
    position: {
      x: zero(part.position.x),
      y: roundMm(part.position.y + overhang),
      z: zero(part.position.z),
    },
    size: {
      width: clampSize(part.size.width),
      height: clampSize(part.size.height),
      thickness: clampSize(part.size.thickness),
    },
  }));

  const finalOperations = operations.map((op) => {
    const out = { ...op };
    out.center = { x: zero(op.center?.x ?? 0), y: zero(op.center?.y ?? 0) };
    if (op.diameter != null) out.diameter = roundMm(op.diameter);
    if (op.depth != null) out.depth = roundMm(op.depth);
    if (op.width != null) out.width = roundMm(op.width);
    if (op.length != null) out.length = roundMm(op.length);
    return out;
  });

  const sides = finalParts.filter((p) => p.role === "vertical-side");
  const height = sides.length ? Math.max(0, ...sides.map((p) => p.size.height)) : 0;

  return {
    parts: finalParts,
    operations: finalOperations,
    bounds: { width: roundMm(totalWidth), height, depth: roundMm(config.depth) },
    issues,
  };
}

export { DEFAULT_CONFIG };
