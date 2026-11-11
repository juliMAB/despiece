/**
 * Comparación de piezas entre dos compilaciones del motor.
 *
 * Sirve para que la interfaz resalte qué tocó el agente: compara la firma
 * geométrica de cada pieza (rol, posición y tamaño) y devuelve las claves que
 * aparecieron, desaparecieron o cambiaron.
 */

/** Firma estable de una pieza: si cambia, la pieza cambió. */
function firma(parte) {
  const { x, y, z } = parte.position;
  const { width, height, thickness } = parte.size;
  return `${parte.role}|${x}|${y}|${z}|${width}|${height}|${thickness}`;
}

/**
 * Devuelve las claves de las piezas que cambiaron entre dos listas.
 *
 * @param {Array<object>} antes
 * @param {Array<object>} despues
 * @returns {string[]} claves de piezas nuevas, movidas, redimensionadas o quitadas
 */
export function clavesCambiadas(antes = [], despues = []) {
  const anteriores = new Map(antes.map((parte) => [parte.key, firma(parte)]));
  const cambiadas = new Set();

  for (const parte of despues) {
    const anterior = anteriores.get(parte.key);
    if (anterior === undefined || anterior !== firma(parte)) cambiadas.add(parte.key);
    anteriores.delete(parte.key);
  }

  // las que sobraron en el mapa son piezas que ya no existen
  for (const clave of anteriores.keys()) cambiadas.add(clave);

  return [...cambiadas];
}

/** ¿Cambió más de la mitad de las piezas? (para no resaltar todo el mueble) */
export function cambioMasivo(claves, totalDespues) {
  if (!Array.isArray(claves) || !Number.isFinite(totalDespues) || totalDespues <= 0) return false;
  return claves.length / totalDespues > 0.6;
}
