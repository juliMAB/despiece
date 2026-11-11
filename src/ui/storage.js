/**
 * Persistencia en el navegador (localStorage).
 *
 * Dos cosas se guardan:
 *  - el proyecto actual, para retomar donde quedaste;
 *  - la lista de proyectos guardados a mano.
 *
 * Si localStorage no está disponible (modo privado, por ejemplo), se usa un
 * almacén en memoria para que la app siga funcionando.
 */

const CLAVE_ACTUAL = "despiece:actual:v1";
const CLAVE_PROYECTOS = "despiece:proyectos:v1";
const CLAVE_VISTA_3D = "despiece:vista3d:v1";

const memoria = new Map();

function almacen() {
  try {
    const prueba = "__despiece_test__";
    window.localStorage.setItem(prueba, "1");
    window.localStorage.removeItem(prueba);
    return window.localStorage;
  } catch {
    return null;
  }
}

const store = almacen();

function leer(clave) {
  if (!store) return memoria.get(clave) ?? null;
  try {
    const raw = store.getItem(clave);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function escribir(clave, valor) {
  if (!store) {
    memoria.set(clave, valor);
    return true;
  }
  try {
    store.setItem(clave, JSON.stringify(valor));
    return true;
  } catch {
    // cuota llena u otra restricción: guardamos en memoria para no perder datos
    memoria.set(clave, valor);
    return false;
  }
}

/** Identificador único de proyecto. */
export function nuevoId() {
  return (
    "p-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 7)
  );
}

/** Fecha legible corta. */
export function fechaCorta(iso) {
  if (!iso) return "";
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "";
  return fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
}

/** Proyecto con el que se abre la app. */
export function leerActual() {
  const valor = leer(CLAVE_ACTUAL);
  if (!valor || typeof valor !== "object") return null;
  if (!valor.design || !Array.isArray(valor.design.columns)) return null;
  return valor;
}

/** Guarda el proyecto en curso (autoguardado). */
export function guardarActual(project) {
  return escribir(CLAVE_ACTUAL, {
    id: project.id,
    name: project.name,
    design: project.design,
    savedAt: new Date().toISOString(),
  });
}

/** Lista de proyectos guardados, más recientes primero. */
export function listarProyectos() {
  const valor = leer(CLAVE_PROYECTOS);
  if (!Array.isArray(valor)) return [];
  return valor
    .filter((item) => item && item.id && item.design)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Crea o actualiza un proyecto. */
export function guardarProyecto(project) {
  const proyectos = listarProyectos();
  const guardado = {
    id: project.id,
    name: project.name,
    design: project.design,
    updatedAt: new Date().toISOString(),
  };
  const indice = proyectos.findIndex((item) => item.id === project.id);
  if (indice >= 0) proyectos[indice] = guardado;
  else proyectos.unshift(guardado);
  escribir(CLAVE_PROYECTOS, proyectos.slice(0, 40));
  guardarActual(project);
  return guardado;
}

/** Borra un proyecto guardado. */
export function borrarProyecto(id) {
  const proyectos = listarProyectos().filter((item) => item.id !== id);
  escribir(CLAVE_PROYECTOS, proyectos);
  const actual = leer(CLAVE_ACTUAL);
  if (actual?.id === id) escribir(CLAVE_ACTUAL, null);
}

/** Indica si el almacenamiento persistente está disponible. */
export function hayAlmacenamiento() {
  return Boolean(store);
}

/** Preferencia de vista: true = 3D, false = 2D (por defecto 3D). */
export function leerVista3d() {
  const valor = leer(CLAVE_VISTA_3D);
  return valor === null || valor === undefined ? true : Boolean(valor);
}

/** Guarda la preferencia de vista. */
export function guardarVista3d(valor) {
  escribir(CLAVE_VISTA_3D, Boolean(valor));
}
