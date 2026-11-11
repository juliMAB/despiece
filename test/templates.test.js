/**
 * Tests de las plantillas incluidas.
 *
 * Toda plantilla tiene que abrirse sin avisos y producir un despiece coherente.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { compileFurniture } from "../src/engine/compile.js";
import { buildCutlist } from "../src/engine/cutlist.js";
import { TEMPLATES, getTemplate } from "../templates/index.js";

describe("plantillas", () => {
  test("hay al menos 3 plantillas", () => {
    assert.ok(TEMPLATES.length >= 3);
  });

  for (const template of TEMPLATES) {
    describe(template.name, () => {
      test("tiene id, nombre y descripción", () => {
        assert.match(template.id, /^[a-z0-9-]+$/);
        assert.ok(template.name.length > 0);
        assert.ok(template.description.length > 0);
      });

      test("compila sin avisos", () => {
        const result = compileFurniture(template);
        assert.deepEqual(result.issues, [], `avisos: ${result.issues.map((i) => i.code).join(", ")}`);
      });

      test("produce piezas y un despiece", () => {
        const result = compileFurniture(template);
        assert.ok(result.parts.length > 0);
        assert.ok(result.parts.every((part) => part.size.width > 0 && part.size.height > 0));
        const rows = buildCutlist(result.parts);
        assert.ok(rows.length > 0);
        assert.equal(rows.reduce((total, row) => total + row.quantity, 0), result.parts.length);
      });

      test("las medidas exteriores son positivas", () => {
        const { bounds } = compileFurniture(template);
        assert.ok(bounds.width > 0);
        assert.ok(bounds.height > 0);
        assert.ok(bounds.depth > 0);
      });
    });
  }

  test("getTemplate encuentra por id y devuelve null si no existe", () => {
    assert.equal(getTemplate(TEMPLATES[0].id), TEMPLATES[0]);
    assert.equal(getTemplate("no-existe"), null);
  });

  test("no hay ids repetidos", () => {
    const ids = TEMPLATES.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
