/**
 * Diseños de prueba propios (no provienen de la app original).
 * Sirven para los tests del motor y como plantillas iniciales.
 *
 * Todas las medidas en metros.
 */

/** Alacena simple: una columna con un par de puertas. */
export const ALACENA = {
  columns: [
    {
      width: 0.6,
      modules: [{ id: "puertas", type: "doors", height: 0.8 }],
    },
  ],
};

/** Cómoda: una columna con una pila de 3 cajones. */
export const COMODA = {
  columns: [
    {
      width: 0.8,
      modules: [{ id: "cajones", type: "drawer", height: 0.75, drawerCount: 3 }],
    },
  ],
};

/** Placard de dos columnas: cajones + puertas abajo, una puerta alta al lado. */
export const PLACARD = {
  columns: [
    {
      width: 0.6,
      modules: [
        { id: "c1-cajones", type: "drawer", height: 0.6, drawerCount: 2 },
        { id: "c1-puertas", type: "doors", height: 1.2 },
      ],
    },
    {
      width: 0.9,
      modules: [{ id: "c2-puerta", type: "left-door", height: 1.8 }],
    },
  ],
};

/** Mueble con distintos espesores de placa (para probar la configuración). */
export const CONFIG_PERSONALIZADA = {
  columns: [
    {
      width: 0.7,
      modules: [{ id: "puertas", type: "doors", height: 0.9 }],
    },
  ],
  config: {
    depth: 0.6,
    panelThickness: 0.025,
    backPanelThickness: 0.006,
    sidePanelOverhang: 0.03,
  },
};

/** Módulo imposible: cajones que no entran en el alto (para probar avisos). */
export const INVALIDO = {
  columns: [
    {
      width: 0.5,
      modules: [{ id: "cajones", type: "drawer", height: 0.1, drawerCount: 6 }],
    },
  ],
};

/** Todos los diseños válidos, con nombre para los snapshots. */
export const DESIGNS = Object.freeze({
  alacena: ALACENA,
  comoda: COMODA,
  placard: PLACARD,
  "config-personalizada": CONFIG_PERSONALIZADA,
});
