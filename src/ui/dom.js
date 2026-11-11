/**
 * Helpers mínimos para construir DOM sin framework.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Crea un elemento HTML.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [props] - atributos, clases, eventos (onclick…), text/html
 * @param {Array|string|Node|null} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }

  for (const child of (Array.isArray(children) ? children : [children]).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  return node;
}

/** Crea un elemento SVG. */
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, value);
  }
  for (const child of (Array.isArray(children) ? children : [children]).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Reemplaza el contenido de un nodo. */
export function mount(container, ...children) {
  container.replaceChildren(
    ...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  );
}

/** Formatea metros con coma decimal. */
export function metros(value, decimals = 3) {
  return Number(value).toFixed(decimals).replace(".", ",");
}

/** Formatea milímetros. */
export function milimetros(mm) {
  return Number(mm).toLocaleString("es-AR", { maximumFractionDigits: 1 });
}
