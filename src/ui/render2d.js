/**
 * Diagrama 2D del mueble (SVG).
 *
 * Dibuja columnas y módulos de frente: puertas partidas, cajones con sus
 * tiradores y estantes abiertos. Las cotas indican ancho de columna y alto
 * total del mueble.
 */

import { svg, metros } from "./dom.js";

const COLORES = {
  modulo: "#f59e0b",
  estante: "#57534e",
  linea: "#1c1917",
  cota: "#78716c",
};

/**
 * @param {{columns: Array}} design
 * @returns {SVGElement|null}
 */
export function renderDiagram(design) {
  const columns = design?.columns ?? [];
  if (columns.length === 0) return null;

  const anchoTotal = columns.reduce((total, column) => total + column.width, 0) || 1;
  const alto = Math.max(
    ...columns.map((column) => column.modules.reduce((total, mod) => total + mod.height, 0)),
    0.1,
  );
  const escala = Math.max(anchoTotal, alto);
  const margen = escala * 0.09;
  const grosor = escala * 0.004;
  const separacion = escala * 0.012;

  const root = svg("svg", {
    viewBox: `${-margen} ${-alto - margen * 1.2} ${anchoTotal + margen * 2} ${alto + margen * 2.6}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `Mueble de ${metros(anchoTotal)} por ${metros(alto)} metros`,
  });

  const rect = (x, y, w, h, fill, opciones = {}) => {
    root.appendChild(
      svg("rect", {
        x, y,
        width: Math.max(0.002, w),
        height: Math.max(0.002, h),
        fill,
        stroke: COLORES.linea,
        "stroke-width": grosor,
        rx: opciones.rx ?? 0,
      }),
    );
  };

  const linea = (x1, y1, x2, y2, width = grosor) => {
    root.appendChild(
      svg("line", {
        x1, y1, x2, y2,
        stroke: COLORES.linea,
        "stroke-width": width,
      }),
    );
  };

  const punto = (cx, cy, r) => {
    root.appendChild(svg("circle", { cx, cy, r, fill: COLORES.linea }));
  };

  const texto = (x, y, contenido, size) => {
    const nodo = svg("text", {
      x, y,
      fill: COLORES.cota,
      "font-size": size,
      "font-family": "ui-sans-serif, system-ui, sans-serif",
      "text-anchor": "middle",
    }, contenido);
    root.appendChild(nodo);
    return nodo;
  };

  let x = 0;
  for (const column of columns) {
    let y = 0;
    for (const mod of column.modules) {
      const altoMod = Number(mod.height) || 0;
      const yTop = -(y + altoMod);
      const esEstante = mod.type === "shelf";
      rect(
        x + separacion,
        yTop + separacion,
        column.width - separacion * 2,
        altoMod - separacion * 2,
        esEstante ? COLORES.estante : COLORES.modulo,
      );

      if (mod.type === "drawer") {
        const cajones = Math.max(1, Math.floor(mod.drawerCount || 1));
        const altoCajon = altoMod / cajones;
        for (let i = 1; i < cajones; i++) {
          linea(x, yTop + altoCajon * i, x + column.width, yTop + altoCajon * i);
        }
        for (let i = 0; i < cajones; i++) {
          const cy = yTop + altoCajon * (i + 0.5);
          punto(x + column.width / 2 - column.width * 0.055, cy, Math.max(0.004, column.width * 0.008));
          punto(x + column.width / 2 + column.width * 0.055, cy, Math.max(0.004, column.width * 0.008));
        }
      } else if (mod.type === "doors") {
        if (column.width > 0.35) linea(x + column.width / 2, yTop, x + column.width / 2, yTop + altoMod);
        punto(x + column.width / 2 - column.width * 0.035, yTop + altoMod / 2, Math.max(0.003, column.width * 0.006));
        punto(x + column.width / 2 + column.width * 0.035, yTop + altoMod / 2, Math.max(0.003, column.width * 0.006));
      } else if (mod.type === "left-door" || mod.type === "right-door") {
        const borde = mod.type === "left-door" ? x + column.width * 0.08 : x + column.width * 0.92;
        punto(borde, yTop + altoMod / 2, Math.max(0.003, column.width * 0.006));
      }

      y += altoMod;
    }

    texto(x + column.width / 2, margen * 0.85, `${metros(column.width)} m`, escala * 0.042);
    x += column.width;
  }

  const cotaAlto = texto(-margen * 0.62, -alto / 2, `${metros(alto)} m`, escala * 0.042);
  cotaAlto.setAttribute("transform", `rotate(-90 ${-margen * 0.62} ${-alto / 2})`);

  return root;
}
