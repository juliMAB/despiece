# Changelog

Todas las versiones relevantes de Despiece. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-11-11

**Primera versión estable.** Editor de muebles paramétrico con despiece en vivo y modo agente completo. La app sigue siendo estática, gratuita y sin backend; el modo agente es un extra local opcional.

### Agregado

- **Motor de despiece propio**: diseño → piezas, mecanizados y avisos, con precisión de 1 mm; validado pieza por pieza contra la salida observada de la app de referencia (4 diseños, coincidencia exacta).
- **Editor visual**: columnas, módulos de puertas (par o simple), cajones y estantes; configuración de fabricación (profundidad, espesores, luces, tiradores).
- **Despiece en vivo**: lista de corte agrupada, resumen, mecanizados y exportación CSV.
- **5 plantillas propias**: alacena, cómoda, placard, bajo mesada y biblioteca.
- **Guardado local** en `localStorage`, import/export de diseño en JSON.
- **Visor 3D** con WebGL 2 y z-buffer real (con respaldo Canvas2D): rotar, zoom, ocultar frentes, pantalla completa, paleta por tipo de pieza.
- **Abrir puertas y cajones** con animación: botón para todo y click por pieza.
- **Medidas sobre el modelo**: cotas de ancho/alto/fondo y modos `al pasar el mouse` / `todas las piezas` / `ocultas`.
- **Capa de comandos** (`src/app/commands.js`): 27 comandos con validación estricta, errores accionables y respuesta uniforme con revisión; historial con deshacer/rehacer (Ctrl+Z / Ctrl+Shift+Z).
- **Modo agente**:
  - servidor local opcional (`npm run agent`) con WebSocket y API HTTP, sólo en `127.0.0.1` y con token;
  - **servidor MCP** (`npm run mcp`) con 26 herramientas, 3 recursos (estado, despiece CSV, captura PNG) y transporte stdio;
  - panel en la interfaz con log de comandos, resaltado de las piezas que tocó el agente, aviso de actividad y desconectar/reconectar.

### Seguridad

- El modo agente escucha sólo en localhost, exige token (401 sin token), valida todos los argumentos y limita a una página conectada.
- Sin `npm run agent`, la app no expone ni abre ningún puerto.

### Pruebas

- 179 tests unitarios y de integración (motor, geometría, comandos, servidor de agentes, MCP).
- 37 verificaciones de interfaz con Chrome (visor 3D, medidas, comandos y undo).
- 26 verificaciones end-to-end del modo agente y MCP con Chrome.
- Comparación con el oráculo del motor: 4/4 diseños con coincidencia exacta.

### Notas

- Repositorio **privado** por ahora; la publicación pública queda diferida hasta definir identidad y difusión.
- Licencia MIT. El proyecto reimplementa desde cero el comportamiento observable de una app desaparecida, sin incluir material de su autor.
- Optimización de corte (nesting) **fuera de alcance** por decisión de producto: el carpintero se encarga de acomodar las piezas en las placas.

## [0.8.0] — 2026-11-11

- Modo agente F4: panel con log, resaltado de cambios, aviso de actividad y desconectar/reconectar.

## [0.7.0] — 2026-11-11

- Modo agente F3: adaptador MCP por stdio con 26 herramientas y 3 recursos.

## [0.6.0] — 2026-11-11

- Modo agente F2: servidor local con WebSocket, API HTTP, token y badge de conexión.

## [0.5.0] — 2026-11-11

- Modo agente F1: capa de comandos con historial y undo; la UI pasa a usarla.

## [0.4.0] — 2026-11-11

- Abrir cada puerta/cajón con un click y medidas sobre el modelo (cotas, hover y modo "todas las piezas").

## [0.3.2] — 2026-11-11

- Apertura animada de puertas y cajones.

## [0.3.1] — 2026-11-11

- Visor 3D sobre WebGL 2 con z-buffer real, paleta por tipo de pieza y pantalla completa.

## [0.3.0] — 2026-11-11

- Visor 3D interactivo (rotar, zoom, ocultar frentes, alternar 2D/3D).

## [0.2.0] — 2026-11-11

- Editor visual, plantillas, guardado local e import/export.

## [0.1.0] — 2026-11-11

- Motor de despiece, agrupado, CSV y tests.
