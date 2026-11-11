# Despiece

**Diseñá muebles y obtené la lista exacta de piezas para cortar.** Libre, gratuito y sin cuentas ni backend.

> Estado: **v0.7-F3 — modo agente con HTTP, WebSocket y MCP**.
> Próximo hito: **F4 — modo agente en la UI** (log de comandos, resaltado, desconectar).
> Repositorio **privado por ahora**: la publicación está diferida hasta que el proyecto tenga identidad propia y suficiente diferencia con la app de referencia que inspiró la recuperación.

![Visor 3D de Despiece con la alacena de 2 puertas](docs/img/editor-3d.png)

## Probarlo (local)

La app es estática y no tiene build: alcanza con servir la carpeta.

```bash
git clone https://github.com/juliMAB/despiece.git
cd despiece
npm run serve      # http://127.0.0.1:8080 (app normal)
npm run agent      # http://127.0.0.1:8790 (app + modo agente)
```

Abrís `http://127.0.0.1:8080`, elegís una plantilla y empezás a editar. Todo se calcula en tu navegador y los proyectos se guardan en tu propio equipo.

Con `npm run agent` la app se abre en `8790`, se conecta sola y aparece el badge **Agente conectado**: desde ese momento un agente (o un script) puede editar el mueble en vivo por HTTP, sin recargar la página.

## Qué hace

- **Visor 3D interactivo**: el mueble se ve armado en 3D, con **WebGL 2 y z-buffer real** (las piezas se ocluyen bien desde cualquier ángulo). Arrastrás para rotar, rueda para zoom, doble click para volver a la vista inicial. Cada tipo de pieza tiene su color: laterales azules, estantes verdes, frentes ámbar, fondos grises. Se puede ocultar puertas y frentes, alternar con la vista 2D y verlo **a pantalla completa**.
- **Abrir puertas y cajones**: con una animación, las puertas giran sobre su bisagra y los cajones se deslizan hacia afuera. Hay un botón para abrir todo y **cada puerta o cajón se abre solo con un click**.
- **Medidas sobre el modelo**: cotas de ancho, alto y fondo, y la opción de mostrar las medidas de cada pieza (`al pasar el mouse` / `todas las piezas` / `ocultas`). Al pasar el mouse se resalta la pieza y aparece su medida de corte.
- **Editor visual**: agregá y quitá columnas, cambiá anchos, agregá módulos de puertas (par o simple), cajones o estantes, con su alto y cantidad de cajones.
- **Despiece en vivo**: cada cambio recalcula todas las piezas con sus medidas exactas de corte.
- **Resumen**: medidas exteriores, cantidad de piezas, líneas de corte, mecanizados y superficie de panel.
- **Mecanizados**: perforaciones de tiradores (Ø y posición) y ranuras de fondo, pieza por pieza.
- **Avisos**: si un diseño no cierra (cajones que no entran, puertas demasiado angostas) te lo dice con el motivo.
- **Exportar CSV** del despiece, listo para planilla o para el aserradero.
- **Exportar / importar diseño** en JSON.
- **Guardado local**: proyectos en `localStorage`, sin cuentas ni servidores.
- **5 plantillas** para arrancar (alacena, cómoda, placard, bajo mesada, biblioteca).
- **Modo agente (opcional)**: con `npm run agent`, un agente o script puede editar el mueble en vivo por HTTP/WebSocket, deshacer y pedir capturas del 3D. Con `npm run mcp` el editor se expone como **servidor MCP** (26 herramientas) para Claude Desktop, Cursor, Codex y otros agentes. La app sigue siendo estática y sin backend si no usás este modo.

| Vista 3D rotada | Cómoda de 4 cajones en 3D |
|---|---|
| ![Vista 3D rotada](docs/img/editor-3d-rotado.png) | ![Cómoda en 3D](docs/img/editor-comoda.png) |

| 3D a pantalla completa | Vista 2D con cotas |
|---|---|
| ![3D a pantalla completa](docs/img/editor-3d-pantalla.png) | ![Vista 2D](docs/img/editor-2d.png) |

| Puertas abiertas | Cajones abiertos |
|---|---|
| ![Puertas abiertas](docs/img/editor-3d-abierto.png) | ![Cajones abiertos](docs/img/editor-cajones-abiertos.png) |

| Medidas al pasar el mouse | Medidas de todas las piezas |
|---|---|
| ![Medidas al pasar el mouse](docs/img/editor-3d-medidas.png) | ![Medidas de todas las piezas](docs/img/editor-3d-todas.png) |

![Tabla de mecanizados](docs/img/editor-mecanizados.png)

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

## Como librería

```js
import { compileFurniture, buildCutlist, cutlistToCsv } from "./src/index.js";

const resultado = compileFurniture({
  columns: [{ width: 0.6, modules: [{ id: "puertas", type: "doors", height: 0.8 }] }],
});

resultado.parts.length;      // 7 piezas
resultado.operations.length; // 6 mecanizados
buildCutlist(resultado.parts); // lista agrupada
cutlistToCsv(buildCutlist(resultado.parts));
```

## Estructura

```
index.html          app web (sin build)
styles.css
src/
  engine/           motor de despiece (independiente de la UI)
    config.js       parámetros de fabricación y precisión (1 mm)
    compile.js      diseño → piezas, mecanizados, avisos
    cutlist.js      agrupado, resumen y CSV
  app/              capa de comandos (la puerta de entrada para editar)
    design.js       modelo, normalización y límites del diseño
    commands.js     catálogo de comandos + sesión con historial (undo/redo)
  ui/               editor (sin frameworks)
    app.js          lógica y eventos (dispara comandos)
    agent.js        cliente del modo agente (WebSocket)
    render2d.js     diagrama 2D con cotas
    render3d.js     visor 3D en canvas (rotar, zoom, ocultar frentes)
    geometry3d.js   cámara, proyección, caras y sombreado (puro y testeable)
    storage.js      proyectos en localStorage
    dom.js          helpers
  index.js          API pública
templates/          plantillas propias
test/               tests del motor, despiece, geometría 3D, comandos y servidor de agentes
dev/                herramientas de desarrollo
  server.mjs        servidor estático
  agent-server.mjs  servidor del modo agente (HTTP + WebSocket + token)
  ws-lite.mjs       WebSocket mínimo sin dependencias
  mcp-core.mjs      adaptador MCP (herramientas y recursos)
  mcp-server.mjs    servidor MCP por stdio
  agent-check.mjs   prueba E2E del modo agente y MCP con Chrome
  ui-check.mjs      prueba E2E de la interfaz con Chrome
docs/               documentación técnica
```

El motor y la geometría 3D no dependen del navegador: se usan igual en Node o en la web.

## Tests

```bash
npm test             # 172 tests: motor, despiece, plantillas, geometría 3D, comandos, servidor de agentes y MCP
npm run ui-check     # 37 verificaciones de la interfaz con Chrome (3D, medidas, comandos y undo)
npm run agent-check  # 20 verificaciones del modo agente y MCP con Chrome (HTTP → cambio en vivo, captura, seguridad)
```

El motor fue validado pieza por pieza contra la salida observada de una app de referencia desaparecida (ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)): coincide en cantidad, posición y tamaño de cada pieza y en cada mecanizado.

## Roadmap

| Versión | Contenido | Estado |
|---|---|---|
| v0.1 | Motor de despiece + despiece agrupado + CSV + tests | ✅ |
| v0.2 | Editor visual, plantillas, guardado local, import/export | ✅ |
| v0.3 | Visor 3D interactivo (rotar, zoom, ocultar frentes, 2D/3D) | ✅ |
| v0.3.1 | Visor sobre WebGL 2 con z-buffer real, paleta por tipo de pieza y pantalla completa | ✅ |
| v0.3.2 | Abrir puertas y cajones con animación | ✅ |
| v0.4 | Abrir cada puerta/cajón con un click y medidas sobre el modelo (cotas y hover) | ✅ |
| v0.5-F1 | **Modo agente:** capa de comandos + undo (en la app) | ✅ |
| v0.6-F2 | Servidor local con WebSocket + endpoints HTTP + badge de conexión | ✅ |
| v0.7-F3 | **Adaptador MCP (stdio)**: 26 herramientas y 3 recursos | ✅ |
| v0.7-F4 | Modo agente en la UI (log de comandos, resaltado, desconectar) | 🚧 próximo |
| v0.6 | Materiales y costos por proyecto, PDF de planos y PWA offline | ⏳ |
| v1.0 | Más tipos de mueble, historial de versiones, exportación a CNC | ⏳ |
| — | **Publicación pública** (Pages, dominio, difusión) | ⏸ diferida |

La publicación queda **en pausa a propósito**: primero el proyecto tiene que diferenciarse de la app de referencia que se usó para reconstruir el motor (identidad visual propia, funciones que el original no tenía, documentación y licencia claras), y recién después se abre al público.

> **Descartado por decisión del usuario:** optimización de corte (nesting). El carpintero se encarga de acomodar las piezas en las placas.

## Modo agente (F2+F3 operativo)

Un agente (DSH, Claude Desktop, Cursor, Codex…) puede **editar el mueble en vivo**, sin recargar la página, con comandos semánticos, undo real y capturas para que el agente "vea" lo que hace.

- La página sigue siendo la **fuente de verdad**; el agente manda comandos.
- El servidor es **opcional y local** (sólo `127.0.0.1`, con token): la app sigue siendo estática y gratuita sin él.
- **HTTP/WebSocket** para scripts (y para DSH) y **MCP por stdio** para agentes de escritorio.

```bash
npm run agent                 # app + servidor de agentes en 8790
npm run mcp                   # servidor MCP por stdio (usa el servidor de arriba)
TOKEN=$(cat .despiece-token)  # el token también se imprime al arrancar
```

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/api/comando` | ejecutar un comando (body `{ nombre, argumentos }`) |
| `GET` | `/api/estado` | diseño + resumen actuales |
| `GET` | `/api/despiece` | lista de corte completa |
| `GET` | `/api/captura.png` | PNG del visor 3D |
| `GET` | `/api/salud` | estado del servidor (sin token) |

```bash
curl -s -X POST http://127.0.0.1:8790/api/comando \
  -H "X-Despiece-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"nombre":"agregar_columna","argumentos":{"ancho":0.6}}'
```

### Conectar un cliente MCP

El servidor MCP (`npm run mcp`) expone **26 herramientas** (una por comando, más `despiece_salud`) y **3 recursos** (`despiece://estado`, `despiece://despiece` en CSV y `despiece://captura` en PNG). Configuración típica:

```json
{
  "mcpServers": {
    "despiece": {
      "command": "node",
      "args": ["C:/Repos/Despiece/dev/mcp-server.mjs"],
      "env": { "DESPIECE_URL": "http://127.0.0.1:8790" }
    }
  }
}
```

Si no hay servidor de agentes corriendo, el MCP levanta uno embebido (la app sigue estando en el navegador; el token está en `.despiece-token`). Los errores vuelven como `isError` con una sugerencia concreta (`sin_pagina` → "Iniciá `npm run agent` y abrí la app").

![Modo agente conectado](docs/img/agente-1-conectado.png)

![Una tool MCP cambiando el mueble en vivo](docs/img/agente-3-mcp.png)

📄 Plan completo, catálogo de comandos, protocolos, seguridad y criterios de aceptación: **[docs/PLAN-AGENTES.md](docs/PLAN-AGENTES.md)**.

## Origen

Despiece nace de la recuperación de **madera.app**, una app de diseño de muebles que existió unos meses de 2026 y cuyo servidor desapareció. Se rescataron sus datos y su comportamiento observable, y este proyecto **reimplementa el motor desde cero** con código propio, sin incluir material del autor original. La validación se hizo comparando la salida del motor propio contra la salida observada del original.

## Licencia

[MIT](LICENSE). Usalo, modificalo y compartilo libremente.
