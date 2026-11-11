# Arquitectura y criterios de cálculo

Documento técnico del motor de despiece. Explica qué hay adentro de una pieza, de dónde sale cada medida y por qué los tests son la garantía de que un cambio no rompe nada.

## 1. Sistema de coordenadas

Todo en **metros**, redondeado a **1 mm** al final (`roundMm`).

| Eje | Dirección |
|---|---|
| X | a lo ancho, centrado en 0 (el mueble va de `-ancho/2` a `+ancho/2`) |
| Y | a lo alto, con 0 en el piso del mueble |
| Z | hacia el fondo: negativo atrás, positivo adelante |

La profundidad se centra en 0: el mueble ocupa de `-profundidad/2` a `+profundidad/2`.

## 2. De columnas a celdas

Un diseño es una lista de columnas; cada columna es una pila de módulos. Para cada módulo el motor calcula su **celda interior** descontando:

```
xMin = centroColumna − anchoColumna/2 + espesorPlaca/2 + luzArmado
xMax = centroColumna + anchoColumna/2 − espesorPlaca/2 − luzArmado
yMin = baseModulo   + espesorPlaca/2 + luzArmado
yMax = techoModulo  − espesorPlaca/2 − luzArmado
zMin = −profundidad/2 + retiroFondo + espesorFondo + luzArmado
zMax = +profundidad/2 − luzArmado
```

Del alto y ancho de la celda salen los **frentes**:

```
frenteAncho = (xMax − xMin) − 2 × luzFrente
frenteAlto  = (yMax − yMin) − 2 × luzFrente
```

## 3. Piezas

| Rol | Se calcula así |
|---|---|
| `vertical-side` | Ancho = profundidad; alto = alto de la columna más alta + 2 × voladizo; espesor = placa |
| `horizontal-deck` | Ancho = ancho de columna − placa − 2 × luz; alto (dimensión Z) = profundidad + voladizo/2 |
| `back-panel` | Ancho/alto = celda + 2 × (placa × 0,25) para entrar en la ranura; espesor = espesor del fondo |
| `door-front` | Alto = frenteAlto; ancho = frenteAncho (hoja simple) o `(frenteAncho − 2 × luzFrente)/2` (par) |
| `drawer-front` | Ancho = frenteAncho; alto = `(altoCelda − luzFrente × (n+1)) / n` |
| `drawer-side` | Profundidad = profundidadCelda − reservaCorredera − 2 × placa − 2 × luz |
| `drawer-back` | Ancho = ancho del frente; alto = alto del lateral |
| `drawer-bottom` | Ancho = anchoCelda − 2 × luz − 2 × placa + 2 × (placa × 0,25) |

Todas las medidas se limitan a un mínimo de 1 mm (`clampSize`), para que un diseño raro no genere piezas de 0 mm.

## 4. Mecanizados

- **Tiradores** (`through-hole`): perforación pasante sobre el frente, Ø configurable (25 mm por defecto). El centro se **recorta** siempre dentro del panel (deja medio diámetro de margen al borde), así nunca sale del material.
- **Ranuras de fondo** (`rail-cut`): una por cada panel que toca el fondo (2 laterales + el estante de abajo y el de arriba de cada módulo; y en los cajones, laterales, trasera y frente de la caja). Profundidad de ranura = placa × 0,25; ancho = espesor del fondo + holgura.

## 5. Avisos de validación

El motor **no bloquea** diseños: los calcula y devuelve avisos. Códigos actuales:

| Código | Significado |
|---|---|
| `back-reserve-overflows-depth` | El fondo y su retiro no entran en la profundidad |
| `cell-too-narrow` / `cell-too-short` / `cell-too-shallow` | La celda interior no tiene tamaño |
| `front-degenerate` | El frente no tiene tamaño |
| `paired-door-too-narrow` | Las hojas del par de puertas quedan muy angostas |
| `slides-reserve-overflows-cell` | La reserva de corredera no entra en el módulo |
| `drawer-band-too-short` | No entra la banda del cajón con sus luces |
| `drawer-depth-too-shallow` | La caja del cajón queda muy poco profunda |

## 6. Despiece agrupado

`buildCutlist` agrupa las piezas por `rol + ancho + alto + espesor` (redondeado a 0,1 mm) y suma cantidades y superficie. El orden es estructural primero (laterales → estantes → fondos → frentes → piezas de cajón). `cutlistToCsv` exporta con separador `;` y coma decimal por defecto, pensado para planilla en español.

## 7. Validación contra una referencia

El motor fue reescrito a partir del comportamiento observable de una app de referencia (desaparecida) y se validó con una herramienta de desarrollo (`dev/compare-oracle.mjs`) que:

1. corre la implementación de referencia y la nuestra sobre los mismos diseños;
2. normaliza ambas salidas (rol, posición, tamaño, orientación, mecanizados, avisos);
3. compara conjunto por conjunto.

Resultado: 4 diseños de referencia, **coincidencia exacta** en piezas (39, 45, 59 y 14), en mecanizados (44, 52, 68 y 16) y en medidas exteriores.

Ese oráculo **no forma parte del proyecto** ni se publica: el repo de Despiece no contiene código de terceros. Los tests del repo usan snapshots de diseños propios.

## 8. Estructura del resultado

```js
{
  parts: [
    { kind: "panel", key, role, position: {x,y,z}, size: {width,height,thickness}, orientation, sourceModuleId? }
  ],
  operations: [
    { kind: "operation", key, operationType, targetPanelKey, face, center: {x,y}, ... }
  ],
  bounds: { width, height, depth },
  issues: [ { severity, code, message, moduleId?, columnIndex?, moduleIndex? } ],
}
```

`orientation` indica qué medida del panel va en qué eje:

- `vertical-yz`: `width` → Z (profundidad), `height` → Y
- `vertical-xy`: `width` → X, `height` → Y
- `horizontal-xz`: `width` → X, `height` → Z
