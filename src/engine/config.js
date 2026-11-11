/**
 * Configuración de fabricación por defecto.
 *
 * Todas las medidas están en METROS (el motor trabaja en metros y redondea a
 * 1 mm al final). Los valores por defecto son los de una placa de 18 mm con
 * fondo de 4 mm, que es lo más común en melamina.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** Profundidad total del mueble. */
  depth: 0.45,
  /** Espesor de las placas estructurales (laterales, estantes, frentes). */
  panelThickness: 0.018,
  /** Espesor del fondo. */
  backPanelThickness: 0.004,
  /** Luz entre placas que se tocan (para que entren). */
  panelJointClearance: 0.002,
  /** Luz entre el frente (puerta/cajón) y el borde del módulo. */
  frontClearance: 0.002,
  /** Cuánto sobresale el lateral por arriba y por abajo del mueble. */
  sidePanelOverhang: 0.02,
  /** Cuánto se retira el fondo del cajón respecto del borde inferior. */
  drawerBottomInset: 0.02,
  /** Espacio reservado para las correderas del cajón (a cada lado/fondo). */
  drawerSlidesReserve: 0.01,
  /** Cuánto se mete el fondo respecto del borde trasero. */
  backPanelInset: 0.015,
  /** Diámetro de las perforaciones de los tiradores. */
  pullHoleDiameter: 0.025,
  /** Distancia del tirador al borde de la puerta/cajón. */
  pullHoleEdgeInset: 0.04,
  /** Separación entre los dos agujeros del tirador. */
  pullHolePairGap: 0.06,
  /** Ranura del fondo en los laterales (holgura). */
  backPanelGrooveClearance: 0.001,
  /** Límites de diseño. */
  minColumnWidth: 0.12,
  maxColumnWidth: 1.2,
  minModuleHeight: 0.08,
  maxModuleHeight: 2,
  minDrawerHeight: 0.08,
  maxDrawerHeight: 0.5,
});

/** Resolución del motor: 1 mm. */
export const PRECISION = 0.001;
/** Medida mínima que puede tener una pieza (1 mm). */
export const MIN_SIZE = 0.001;

/** Redondea a milímetros (3 decimales en metros). */
export function roundMm(meters) {
  if (!Number.isFinite(meters)) return 0;
  return Math.round(meters * 1000) / 1000;
}

/** Redondea y garantiza la medida mínima. */
export function clampSize(meters) {
  return Math.max(MIN_SIZE, roundMm(meters));
}

/** Devuelve una config completa a partir de una parcial. */
export function withDefaults(config = {}) {
  return { ...DEFAULT_CONFIG, ...config };
}
