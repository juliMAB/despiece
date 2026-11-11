/**
 * Plantillas de muebles incluidas en Despiece.
 *
 * Son diseños propios, pensados como punto de partida: se pueden abrir,
 * modificar medidas y guardar. Todas las medidas están en metros.
 */

export const TEMPLATES = [
  {
    id: "alacena-2-puertas",
    name: "Alacena 2 puertas",
    description: "Un cuerpo de 60 cm con un par de puertas. Ideal para empezar.",
    columns: [
      {
        width: 0.6,
        modules: [{ id: "puertas", type: "doors", height: 0.8 }],
      },
    ],
  },
  {
    id: "comoda-4-cajones",
    name: "Cómoda 4 cajones",
    description: "Un cuerpo de 80 cm con cuatro cajones iguales.",
    columns: [
      {
        width: 0.8,
        modules: [{ id: "cajones", type: "drawer", height: 0.8, drawerCount: 4 }],
      },
    ],
  },
  {
    id: "placard-2-cuerpos",
    name: "Placard 2 cuerpos",
    description: "Cajones y puertas a un lado, puerta alta del otro. 1,50 m de ancho.",
    columns: [
      {
        width: 0.6,
        modules: [
          { id: "c1-cajones", type: "drawer", height: 0.6, drawerCount: 2 },
          { id: "c1-puertas", type: "doors", height: 1.4 },
        ],
      },
      {
        width: 0.9,
        modules: [{ id: "c2-puerta", type: "left-door", height: 2 }],
      },
    ],
  },
  {
    id: "bajo-mesada",
    name: "Bajo mesada",
    description: "Mueble bajo de 90 cm con dos puertas, para cocina o lavadero.",
    columns: [
      {
        width: 0.9,
        modules: [{ id: "puertas", type: "doors", height: 0.7 }],
      },
    ],
    config: { depth: 0.55, sidePanelOverhang: 0.01 },
  },
  {
    id: "biblioteca-3-cuerpos",
    name: "Biblioteca 3 cuerpos",
    description: "Tres columnas de estantes abiertos, 1,80 m de ancho.",
    columns: [
      {
        width: 0.6,
        modules: [
          { id: "b1-a", type: "shelf", height: 0.4 },
          { id: "b1-b", type: "shelf", height: 0.4 },
          { id: "b1-c", type: "shelf", height: 0.4 },
          { id: "b1-d", type: "shelf", height: 0.4 },
        ],
      },
      {
        width: 0.6,
        modules: [
          { id: "b2-a", type: "shelf", height: 0.4 },
          { id: "b2-b", type: "shelf", height: 0.4 },
          { id: "b2-c", type: "shelf", height: 0.4 },
          { id: "b2-d", type: "shelf", height: 0.4 },
        ],
      },
      {
        width: 0.6,
        modules: [
          { id: "b3-a", type: "shelf", height: 0.4 },
          { id: "b3-b", type: "shelf", height: 0.4 },
          { id: "b3-c", type: "shelf", height: 0.4 },
          { id: "b3-d", type: "shelf", height: 0.4 },
        ],
      },
    ],
  },
];

/** Busca una plantilla por id. */
export function getTemplate(id) {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}
