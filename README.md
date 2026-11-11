# Despiece

**Diseñá muebles y obtené la lista exacta de piezas para cortar.** Libre, gratuito y sin cuentas ni backend.

> Estado: **v0.1 — motor terminado y validado**. El editor visual y el visor 3D están en desarrollo.

## Qué hace

A partir de un diseño paramétrico (columnas con módulos de puertas, cajones o estantes) el motor calcula:

- **Todas las piezas** con sus medidas exactas de corte, posición y orientación.
- **Los mecanizados**: perforaciones de tiradores (Ø, posición) y ranuras para el fondo en laterales, estantes y cajas de cajón.
- **El despiece agrupado**: "18 placas de 550 × 1726", listo para el aserradero.
- **Avisos de diseño** cuando algo no cierra (cajones que no entran, puertas demasiado angostas, etc.).
- **Exportación CSV** para planilla.

## Por qué

La mayoría de las apps de muebles son de escritorio, caras o cerradas. Despiece apunta a lo mínimo que necesita un carpintero o un hobbista:

- corre en el navegador, sin instalar nada;
- no necesita servidor ni registro (los proyectos quedan en tu máquina);
- es código abierto, sin funciones pagas;
- los cálculos son transparentes y auditables.

## Uso rápido

Requiere Node.js 20 o superior.

```bash
git clone https://github.com/juliMAB/despiece.git
cd despiece
npm test
```

Como librería:

```js
import { compileFurniture, buildCutlist, cutlistToCsv } from "./src/index.js";

const resultado = compileFurniture({
  columns: [
    {
      width: 0.6,
      modules: [{ id: "puertas", type: "doors", height: 0.8 }],
    },
  ],
});

console.log(resultado.parts.length);      // 7 piezas
console.log(resultado.operations.length); // 6 mecanizados
console.log(buildCutlist(resultado.parts)); // lista agrupada
console.log(cutlistToCsv(buildCutlist(resultado.parts)));
```

## Modelo de diseño

Medidas en **metros**. Un diseño es:

```js
{
  columns: [
    {
      width: 0.6,                 // ancho de la columna
      modules: [                  // apilados de abajo hacia arriba
        { id: "a", type: "doors",  height: 0.8 },
        { id: "b", type: "drawer", height: 0.5, drawerCount: 2 },
        { id: "c", type: "shelf",  height: 0.3 },
      ],
    },
  ],
  config: {                       // opcional: sobrescribe los valores por defecto
    depth: 0.45,
    panelThickness: 0.018,
    // …ver src/engine/config.js
  },
}
```

Tipos de módulo: `doors` (par de puertas), `left-door` / `right-door` (una hoja con bisagra), `drawer` (pila de cajones), `shelf` (estante abierto).

## Estructura

```
src/
  engine/
    config.js     configuración de fabricación y precisión (1 mm)
    compile.js    motor: diseño → piezas, mecanizados, avisos
    cutlist.js    agrupado de piezas, resumen y CSV
  index.js        API pública
templates/        plantillas de muebles propias
test/             tests del motor y del despiece (+ snapshots)
dev/              herramientas de desarrollo (comparación, snapshots)
docs/             documentación técnica
```

## Tests

```bash
npm test
```

34 tests que cubren medidas calculadas a mano, snapshots de la salida, validaciones y exportación. El motor además fue validado pieza por pieza contra la salida observada de una app de referencia desaparecida (ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)): coincide en cantidad, posición y tamaño de cada pieza y en cada mecanizado.

## Roadmap

| Versión | Contenido | Estado |
|---|---|---|
| v0.1 | Motor de despiece + despiece agrupado + CSV + tests | ✅ |
| v0.2 | Editor visual (2D) con plantillas, guardado local e import/export | 🚧 |
| v0.3 | Visor 3D interactivo | ⏳ |
| v0.4 | Publicación en GitHub Pages + PWA offline | ⏳ |
| v1.0 | Materiales y espesores por proyecto, PDF de planos, optimización de corte | ⏳ |

## Origen

Despiece nace de la recuperación de **madera.app**, una app de diseño de muebles que existió unos meses de 2026 y cuyo servidor desapareció. Se rescataron sus datos y su comportamiento observable, y este proyecto **reimplementa el motor desde cero** con código propio, sin incluir material del autor original. La validación se hizo comparando la salida del motor propio contra la salida observada del original.

## Licencia

[MIT](LICENSE). Usalo, modificalo y compartilo libremente.
