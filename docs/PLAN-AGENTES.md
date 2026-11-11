# Plan: modo agente (API local + MCP)

> **Estado:** **F3 implementado** (2026-11-11). F4 (modo agente en la UI) es el próximo paso.
> **Decisión del usuario:** sí al modo agente; **no** a la optimización de corte (el carpintero se encarga del nesting).

Este documento es el contrato de trabajo del "modo agente" de Despiece. Define qué se construye, qué no, cómo se comunican las partes y cuándo se considera terminado cada paso. Si algo no está acá, no está en el alcance hasta que se actualice este archivo.

---

## 1. Decisiones cerradas

| # | Decisión | Detalle |
|---|---|---|
| 1 | **La página es la fuente de verdad** | El agente no guarda el diseño: manda comandos y la página aplica, valida y devuelve el nuevo estado. El servidor no mantiene una copia paralela. |
| 2 | **Comandos, no estado crudo** | Nada de `setState({...})`. Herramientas chicas y semánticas (`agregar_modulo`, `fijar_ancho_columna`, …). |
| 3 | **Undo real** | Todo cambio de agente se puede deshacer por el humano. La base es una capa de comandos con historial. |
| 4 | **Capturas** | El agente puede pedir un PNG del canvas para "ver" el resultado y autocorregirse. |
| 5 | **Seguridad desde el día uno** | Solo `127.0.0.1`, token de sesión, validación estricta, indicador visible de agente conectado. |
| 6 | **Agentes locales primero** | Transporte MCP por `stdio`, pensado para agentes de escritorio (Claude Desktop, Cursor, Codex, **DSH**). HTTP remoto queda para más adelante. |
| 7 | **No-opcional para el usuario final** | Sin modo agente, la app sigue siendo 100 % estática, gratis y sin backend. El servidor es un accesorio que se levanta aparte. |
| 8 | **Fuera de alcance: optimización de corte** | Descartado por decisión del usuario. |

---

## 2. Objetivo

Permitir que un agente edite el mueble **en vivo**, sin recargar la página, y que el humano vea el cambio al instante, pueda deshacerlo y pueda pedirle al agente que "mire" el resultado.

### Casos de uso que definen el éxito

1. **Diseño conversacional:** "hacéme un placard de 1,80 con dos cajones y puertas" → el mueble aparece armado en pantalla.
2. **Iteración visual:** el agente pide una captura, nota que las puertas quedaron angostas, corrige.
3. **Auto-validación:** el agente consulta los avisos del motor y arregla lo que no cierra.
4. **Despiece asistido:** el agente obtiene el despiece y arma un resumen o un CSV.

### No objetivos (por ahora)

- Backend central, cuentas, multiusuario remoto.
- Varios agentes editando a la vez (v1 = un agente).
- Persistencia del lado del servidor (se mantiene `localStorage` + export/import).
- Control de la app *sin* una página abierta.

---

## 3. Arquitectura

```
┌───────────────┐   MCP (stdio)    ┌────────────────────┐   WebSocket   ┌──────────────────┐
│ Agente        │ ◄──────────────► │ Servidor Despiece  │ ◄───────────► │ Página Despiece  │
│ (DSH, Claude, │  tools/resources │ (proceso local)    │  comandos /   │ (fuente de       │
│  Cursor…)     │                  │                    │  estado /     │  verdad, 3D vivo)│
└───────────────┘                  │  · adaptador MCP   │  capturas     └──────────────────┘
                                   │  · HTTP (scripts)  │
                                   │  · WS broadcast    │
                                   └────────┬───────────┘
                                            │ importa
                                            ▼
                                   ┌────────────────────┐
                                   │ Motor Despiece     │
                                   │ (JS puro, Node/web)│
                                   └────────────────────┘
```

### Responsabilidades

| Pieza | Hace | No hace |
|---|---|---|
| **Página** | Guarda el diseño, aplica comandos, valida, dibuja, persiste en `localStorage`, responde capturas | No acepta estado arbitrario ni comandos sin validar |
| **Servidor local** | Expone MCP y HTTP, mantiene la conexión WS, hace de puente, aplica token y rate limit | No guarda el diseño ni decide nada del mueble |
| **Motor** | Cálculos (piezas, mecanizados, avisos) | No conoce transporte ni UI |
| **Capa de comandos** | Una función por comando, con validación y resultado uniforme | No toca el DOM |

---

## 4. Capa de comandos (base de todo)

Un comando es una función pura de `(estado, argumentos) → { estado, resultado, deshacer }` (o `error`). La UI, el servidor HTTP y el MCP usan la misma capa.

### 4.1 Contrato

```js
// src/app/commands.js
export const COMANDOS = {
  agregar_columna: {
    descripcion: "Agrega una columna al mueble.",
    esquema: { ancho: "number?", indice: "number?" },
    aplicar(estado, args) { … return { estado, resultado, deshacer } },
  },
  …
};

export function aplicarComando(estado, nombre, argumentos) {
  // valida esquema, ejecuta, devuelve
  // { ok, revision, resultado?, error? }
}
```

**Respuesta uniforme:**

```json
{ "ok": true, "revision": 12, "resultado": { "columnas": 2 } }
```

```json
{ "ok": false, "revision": 12,
  "error": { "codigo": "indice_fuera_de_rango",
             "mensaje": "No existe la columna 5 (hay 2).",
             "sugerencia": "Usá indice 0 o 1." } }
```

Los `mensaje` y `sugerencia` están escritos **para que los lea un LLM**: cortos, con la acción concreta para corregir.

### 4.2 Catálogo de comandos

**Proyecto**

| Comando | Argumentos | Resultado |
|---|---|---|
| `crear_proyecto` | `{nombre?, plantillaId?}` | proyecto vacío o desde plantilla |
| `cargar_plantilla` | `{plantillaId}` | proyecto nuevo con esa plantilla |
| `cargar_diseno` | `{design, nombre?}` | reemplaza el diseño (valida esquema) |
| `renombrar_proyecto` | `{nombre}` | nombre actualizado |

**Estructura**

| Comando | Argumentos | Resultado |
|---|---|---|
| `agregar_columna` | `{ancho?, indice?}` | índice de la columna nueva |
| `quitar_columna` | `{indice}` | columnas restantes |
| `fijar_ancho_columna` | `{indice, ancho}` | ancho efectivo (con límites del motor) |
| `agregar_modulo` | `{columna, tipo, alto, cajones?, indice?}` | índice del módulo nuevo |
| `editar_modulo` | `{columna, modulo, tipo?, alto?, cajones?}` | módulo actualizado |
| `quitar_modulo` | `{columna, modulo}` | módulos restantes |
| `fijar_config` | `{valores: {clave: número}}` | configuración efectiva |

**Vista (no cambia el diseño, sí lo que se ve)**

| Comando | Argumentos |
|---|---|
| `abrir_todo` | `{abierto: boolean}` |
| `alternar_apertura` | `{columna, modulo, cajonIndice?}` (puerta o cajón puntual) |
| `mover_camara` | `{yaw?, pitch?, zoom?}` |
| `fijar_vista` | `{modo?: "3d"\|"2d", medidas?: "hover"\|"todas"\|"sin", frentes?: boolean}` |
| `reiniciar_camara` | `{}` |

**Consultas (sin efectos)**

| Comando | Devuelve |
|---|---|
| `obtener_estado` | diseño + resumen + revisión + si hay avisos |
| `obtener_diseno` | solo `{columns, config}` |
| `obtener_despiece` | `{lineas: [...], resumen}` (agrupado) |
| `obtener_mecanizados` | lista de operaciones |
| `obtener_avisos` | errores/warnings del motor |
| `capturar_vista` | PNG en base64 (data URL) |

**Historial**

| Comando | Argumentos |
|---|---|
| `deshacer` | `{}` |
| `rehacer` | `{}` |

### 4.3 Reglas

- Todo comando devuelve `revision`. La revisión sube de a 1 por cambio de diseño (las consultas no la cambian).
- Los comandos de vista **no** entran al historial de undo.
- `_deshacer` restaura el estado anterior exacto (snapshot del diseño, no re-ejecución).
- Límite de historial: 100 pasos.
- Idempotencia: aplicar dos veces el mismo `agregar_columna` con el mismo `indice` **no** es idempotente (agrega dos veces); el agente debe leer el estado o usar `obtener_*` antes. Es preferible eso a comandos mágicos.

---

## 5. Transportes

### 5.1 WebSocket (página ↔ servidor)

La página se conecta a `ws://127.0.0.1:8790/ws?token=…` cuando el modo agente está activo. Mensajes JSON con `type`.

| Dirección | Mensaje | Payload |
|---|---|---|
| servidor → página | `comando` | `{id, nombre, argumentos}` |
| página → servidor | `resultado` | `{id, ok, revision, resultado?/error?}` |
| página → servidor | `estado` | `{revision, design, resumen, avisos}` (broadcast al cambiar) |
| página → servidor | `presencia` | `{pagina: true, agente: false}` |
| servidor → página | `captura_solicitud` | `{id, ancho?, alto?}` |
| página → servidor | `captura` | `{id, png}` |

Reglas:
- Si **no hay página conectada**, el servidor responde `error.codigo = "sin_pagina"` con el mensaje: *"Abrí la app en el navegador: npm run serve"*.
- El servidor **no encola** comandos: si no hay página, falla rápido.
- Si se cae la conexión, la página reintenta cada 3 s (máx. 5 intentos) y muestra el estado en la UI.

### 5.2 HTTP (para scripts y para DSH)

Pensado para que cualquier proceso (incluido el agente de DSH, que tiene shell) maneje la app sin hablar MCP.

| Método | Ruta | Body/params | Devuelve |
|---|---|---|---|
| `GET` | `/api/estado` | — | estado completo |
| `GET` | `/api/despiece` | — | despiece agrupado |
| `POST` | `/api/comando` | `{nombre, argumentos}` | resultado uniforme |
| `GET` | `/api/captura.png` | `?ancho&alto` | PNG |
| `GET` | `/api/salud` | — | `{ok, paginaConectada, revision, motor}` |

Autenticación: header `X-Despiece-Token`. El token se genera al arrancar el servidor, se imprime en consola y se guarda en `.despiece-token` (ignorado por git).

**Ejemplo (PowerShell):**

```powershell
$token = Get-Content .despiece-token
$body = @{ nombre = "agregar_columna"; argumentos = @{ ancho = 0.6 } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8790/api/comando `
  -Headers @{ "X-Despiece-Token" = $token } -ContentType "application/json" -Body $body
```

### 5.3 MCP (agentes de escritorio)

- Transporte: **stdio** (`npm run mcp` lanza el servidor MCP, que a su vez se conecta por WS a la página; o `despiece mcp` en el paquete futuro).
- Nombres de tools con prefijo `despiece_` para evitar colisiones.
- Cada tool = un comando de la capa de comandos (salvo consultas, que van como tools de lectura).
- `tools/list` con descripciones en español/inglés cortas + `inputSchema` JSON Schema.
- Errores como `isError: true` con texto accionable.
- **Resources** (lectura):
  - `despiece://estado` — JSON del diseño actual.
  - `despiece://despiece` — CSV de la lista de corte.
  - `despiece://captura` — PNG (blob).
- El MCP server debe funcionar aunque no haya página: responde error `sin_pagina` claro.
- Futuro: transporte HTTP para agentes remotos (queda fuera de esta fase).

**Cómo lo usa DSH:** no hace falta MCP. El agente de DSH (esta sesión) maneja el proyecto con `node`/`Invoke-RestMethod` contra los endpoints HTTP: `POST /api/comando` para editar, `GET /api/captura.png` para "ver", `GET /api/despiece` para validar. MCP queda para clientes que solo hablan MCP.

---

## 6. Undo y seguridad

### 6.1 Undo
- Historial de snapshots del diseño (no de la vista).
- `deshacer`/`rehacer` disponibles por comando y en la UI (Ctrl+Z / Ctrl+Shift+Z).
- El servidor no maneja el historial: lo hace la página (fuente de verdad).
- Antes de conectar un agente, la página guarda un **backup automático** del proyecto actual (`localStorage`, clave `despiece:backup-preagente`).

### 6.2 Seguridad
- Bind exclusivo a `127.0.0.1` (nunca `0.0.0.0` por defecto).
- Token obligatorio en HTTP y WS; se regenera en cada arranque.
- Validación de argumentos contra esquema + límites del motor (nada de valores arbitrarios).
- Rate limit: 20 comandos/segundo por conexión; 1 agente a la vez (v1).
- Sin ejecución de código: los comandos son funciones del paquete, no strings evaluadas.
- La UI muestra **"Agente conectado"** y un log de los últimos comandos, con botón de desconectar.
- Si el agente se desconecta, la página sigue funcionando normal.

---

## 7. Fases y criterios de aceptación

### F1 — Capa de comandos + undo (en la app) ✅
**Entrega:** `src/app/design.js` (modelo y normalización), `src/app/commands.js` (catálogo + `crearSesion`), UI usando la capa, Ctrl+Z/Ctrl+Shift+Z y menú Deshacer/Rehacer.
**Aceptación:**
- ✅ Todos los comandos del catálogo §4.2 implementados y testeados en Node (`test/commands.test.js`).
- ✅ La UI no muta el diseño directamente: todos los cambios pasan por `aplicarComando`/`crearSesion`.
- ✅ Ctrl+Z / Ctrl+Shift+Z funcionan y están testeados (unitarios + UI automatizada).
- ✅ Tests: 50 nuevos (135 en total).

**Notas de implementación:**
- `crearSesion({ estadoInicial, servicios })` devuelve `{ aplicar(nombre, args), estado, revision, reiniciar, puedeDeshacer, puedeRehacer }`.
- Los servicios que recibe son `{ visor?, fijarVista?, capturarVista? }`; sin ellos los comandos de vista/captura devuelven `sin_visor` con sugerencia accionable.
- Se agregó `agregar_columna({ modulo? })` para que la UI pueda crear la columna con un módulo en un solo paso.
- Se agregó `obtener_comandos` para que un agente descubra el catálogo.
- `deshacer`/`rehacer` son operaciones de la sesión (también aceptadas por nombre en `aplicar`) y no están en el catálogo público de diseño.
- El nombre del proyecto se confirma con `change` (blur/Enter), no en cada tecla, para no llenar el historial de mini-pasos.
- La vista (2D/3D, medidas, frentes, apertura, cámara) va por `fijar_vista` / `abrir_todo` / `alternar_apertura` / `mover_camara` / `reiniciar_camara` pero **no** entra al historial.

### F2 — Servidor local + WebSocket ✅
**Entrega:** `dev/agent-server.mjs` (`npm run agent`), `dev/ws-lite.mjs` (WebSocket sin dependencias), cliente en `src/ui/agent.js`, modo agente en la página, endpoints HTTP y script `npm run agent-check` (E2E con Chrome).
**Aceptación:**
- ✅ Con la página abierta, `POST /api/comando` cambia el 3D **sin recargar** (verificado con Chrome automatizado).
- ✅ Sin página abierta devuelve `sin_pagina` (HTTP 409 en `/api/estado` y `/api/captura.png`; `ok:false` en `/api/comando`).
- ✅ Token obligatorio: 401 sin token o con token incorrecto (verificado).
- ✅ `/api/captura.png` devuelve un PNG válido con el mueble.
- ✅ El servidor se cierra limpio y no deja procesos.

**Notas de implementación:**
- WebSocket propio (`dev/ws-lite.mjs`): handshake, frames de texto, ping/pong, cierre y fragmentación; sin dependencias.
- El servidor inyecta `window.__DESPIECE_AGENTE__ = { token, entrada: "/ws", version }` en el HTML que sirve. Si la página se sirve con `npm run serve` (sin agente), no se inyecta nada y la app queda igual que siempre.
- Protocolo real: el servidor manda `{ type: "hola", version, revision }` al conectar y `{ type: "error", codigo: "reemplazada" }` si otra pestaña toma el control (v1: una sola página).
- La captura viaja como data URL en el mensaje `captura`; el servidor la convierte a PNG. El cliente fuerza la vista 3D antes de capturar (dos `requestAnimationFrame` para que el canvas esté dibujado).
- La página avisa el estado después de cada cambio (propio o del agente): `{ type: "estado", revision, design, resumen, avisos }`.
- El servidor guarda el último estado y la última captura; `/api/despiece` compila del lado del servidor con el mismo motor.
- Timeout de 8 s por comando/captura, con error `tiempo_agotado`.
- El badge del encabezado muestra el estado de la conexión (`Agente conectado`, `Reconectando…`, etc.).
- El script `dev/agent-check.mjs` (14 verificaciones) cubre el flujo completo con Chrome: comando HTTP → cambio en el DOM, sin recarga, captura, undo y seguridad.

### F3 — Adaptador MCP (stdio) ✅
**Entrega:** `dev/mcp-core.mjs` (protocolo, herramientas y recursos), `dev/mcp-server.mjs` (stdio + cliente HTTP + servidor embebido opcional), `ESQUEMAS` de entrada en `src/app/commands.js`, script `npm run mcp` y tests.
**Aceptación:**
- ✅ Un cliente MCP de prueba lista las tools y ejecuta `despiece_agregar_columna` → el 3D cambia (verificado en el E2E de Chrome).
- ✅ Errores accionables cuando no hay página (`sin_pagina` → "Iniciá `npm run agent`…").
- ✅ Documentado cómo conectarlo desde un cliente MCP estándar.

**Notas de implementación:**
- Protocolo: JSON-RPC 2.0 por stdio, línea por mensaje. Versiones soportadas: `2025-06-18`, `2025-03-26`, `2024-11-05` (negocia con la del cliente).
- `initialize` devuelve `capabilities.tools` y `capabilities.resources`, más `instructions` para orientar al agente.
- Herramientas: **26** = 25 comandos del catálogo (`despiece_<comando>`, incluidos `deshacer` y `rehacer`) + `despiece_salud`. Cada una con `inputSchema` tomado de `ESQUEMAS` (no se duplica la definición).
- Recursos: `despiece://estado` (JSON), `despiece://despiece` (CSV generado con `cutlistToCsv`), `despiece://captura` (PNG como blob).
- `despiece_capturar_vista` devuelve **texto + imagen** (content array), así un agente multimodal "ve" el mueble.
- Errores de comando → `isError: true` con el JSON del error y la sugerencia; fallo de conexión → mensaje con los pasos para arrancar el servidor.
- Si no hay servidor de agentes corriendo, el MCP levanta uno **embebido** (misma app + WebSocket) salvo `DESPIECE_AUTOSTART=0`. El token se lee de `.despiece-token` o `DESPIECE_TOKEN`.
- `stdout` es solo protocolo; los logs van a `stderr`.
- Tests: 14 del núcleo (initialize, tools, recursos, errores, imágenes, notificaciones) + 5 por stdio real (spawn del proceso + página simulada).
- E2E con Chrome extendido a 20 verificaciones: entre ellas una tool MCP editando el mueble en vivo, captura por MCP y `deshacer` por MCP.

**Config para un cliente MCP (Claude Desktop / Cursor):**

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

### F4 — Modo agente en la UI
**Entrega:** indicador, log de comandos, resaltado de piezas tocadas, botón desconectar.
**Aceptación:**
- El humano ve qué hizo el agente y puede deshacer cada paso.
- Sin modo agente, la app no muestra nada nuevo y sigue siendo estática.

### F5 — (opcional, futuro)
Transporte HTTP para agentes remotos, demo conversacional, grabación de sesión.

---

## 8. Pruebas

| Tipo | Qué |
|---|---|
| **Unitarias** | Cada comando: efecto, validación, errores, undo/redo. |
| **Integración** | Cliente WS en Node: comando → estado del DOM por CDP → verificación. |
| **E2E agente** | Script que crea un placard en ≤8 comandos, pide captura y valida el despiece. |
| **Seguridad** | Sin token → 401; bind local; argumentos inválidos → error sin romper. |
| **UI** | `ui-check` sigue pasando 30/30 sin modo agente (no romper la app base). |

---

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Dos fuentes de verdad | La página manda; el servidor no guarda diseño. |
| El agente rompe un diseño lindo | Undo + backup pre-agente + export automático opcional. |
| Complejidad en una app "estática gratis" | Servidor en carpeta aparte; el build de Pages no lo incluye. |
| Superficie de ataque local | Localhost + token + validación + rate limit + un solo cliente. |
| MCP cambia de versión | La capa de comandos es propia; el MCP es un adaptador fino. |
| Latencia/orden | `revision` monotónica y respuesta por `id`; sin en cola. |

---

## 10. Preguntas abiertas

1. ¿El servidor debe poder iniciar la app solo (abrir el navegador)? Propuesta: sí, opción `--abrir`.
2. ¿Más de un agente en v2? No por ahora.
3. ¿El agente puede crear/cargar proyectos sin que el humano confirme? Propuesta: sí, con undo y log visible.

---

## 11. Anexo: ejemplo de sesión (objetivo de F2)

```
agente → POST /api/comando {"nombre":"crear_proyecto","argumentos":{"plantillaId":"alacena-2-puertas"}}
página → {ok:true, revision:1}
agente → POST /api/comando {"nombre":"fijar_ancho_columna","argumentos":{"indice":0,"ancho":0.9}}
página → {ok:true, revision:2}
agente → POST /api/comando {"nombre":"agregar_modulo","argumentos":{"columna":0,"tipo":"drawer","alto":0.5,"cajones":2}}
página → {ok:true, revision:3, resultado:{modulos:2}}
agente → GET /api/despiece
servidor → {lineas:[…], resumen:{piezas:…, lineas:…}}
agente → GET /api/captura.png
servidor → PNG con el mueble actualizado (sin recargar la página)
```
