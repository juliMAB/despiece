/**
 * Tests del WebSocket mínimo (frames, fragmentación y cierre).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { construirFrameTexto, construirFrameCierre, DecodificadorFrames } from "../dev/ws-lite.mjs";

const MASCARA = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

/** Arma un frame como lo manda un navegador: enmascarado. */
function frameDeCliente(texto, { fin = true, opcode = 0x1 } = {}) {
  const payload = Buffer.from(texto, "utf8");
  const largo = payload.length;

  let encabezado;
  if (largo < 126) {
    encabezado = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | largo]);
  } else if (largo < 65536) {
    encabezado = Buffer.alloc(4);
    encabezado[0] = (fin ? 0x80 : 0) | opcode;
    encabezado[1] = 0x80 | 126;
    encabezado.writeUInt16BE(largo, 2);
  } else {
    encabezado = Buffer.alloc(10);
    encabezado[0] = (fin ? 0x80 : 0) | opcode;
    encabezado[1] = 0x80 | 127;
    encabezado.writeBigUInt64BE(BigInt(largo), 2);
  }

  const enmascarado = Buffer.from(payload);
  for (let i = 0; i < enmascarado.length; i++) enmascarado[i] ^= MASCARA[i % 4];

  return Buffer.concat([encabezado, MASCARA, enmascarado]);
}

test("construirFrameTexto usa 7 bits para mensajes cortos", () => {
  const frame = construirFrameTexto("hola");
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 4);
  assert.equal(frame.subarray(2).toString("utf8"), "hola");
});

test("construirFrameTexto usa 16 bits para mensajes medianos", () => {
  const texto = "x".repeat(200);
  const frame = construirFrameTexto(texto);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 126);
  assert.equal(frame.readUInt16BE(2), 200);
  assert.equal(frame.subarray(4).toString("utf8"), texto);
});

test("construirFrameTexto usa 64 bits para mensajes largos", () => {
  const texto = "y".repeat(70000);
  const frame = construirFrameTexto(texto);
  assert.equal(frame[1], 127);
  assert.equal(Number(frame.readBigUInt64BE(2)), 70000);
  assert.equal(frame.length, 10 + 70000);
});

test("construirFrameCierre arma el código", () => {
  const frame = construirFrameCierre(1000);
  assert.equal(frame[0], 0x88);
  assert.equal(frame.readUInt16BE(2), 1000);
});

test("decodifica un mensaje enmascarado", () => {
  const decodificador = new DecodificadorFrames();
  const eventos = decodificador.agregar(frameDeCliente('{"type":"hola"}'));
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, "texto");
  assert.deepEqual(JSON.parse(eventos[0].texto), { type: "hola" });
});

test("decodifica mensajes partidos byte por byte", () => {
  const decodificador = new DecodificadorFrames();
  const frame = frameDeCliente("mensaje partido");
  const eventos = [];
  for (const byte of frame) eventos.push(...decodificador.agregar(Buffer.from([byte])));
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].texto, "mensaje partido");
});

test("arma un mensaje fragmentado en varios frames", () => {
  const decodificador = new DecodificadorFrames();
  const primero = decodificador.agregar(frameDeCliente("hola ", { fin: false, opcode: 0x1 }));
  assert.equal(primero.length, 0, "el primer fragmento no cierra el mensaje");
  const segundo = decodificador.agregar(frameDeCliente("mundo", { fin: true, opcode: 0x0 }));
  assert.equal(segundo.length, 1);
  assert.equal(segundo[0].texto, "hola mundo");
});

test("detecta ping y cierre", () => {
  const decodificador = new DecodificadorFrames();
  const ping = decodificador.agregar(frameDeCliente("", { opcode: 0x9 }));
  assert.equal(ping[0].tipo, "ping");
  const cierre = decodificador.agregar(frameDeCliente("", { opcode: 0x8 }));
  assert.equal(cierre[0].tipo, "close");
});

test("dos mensajes seguidos en un mismo chunk", () => {
  const decodificador = new DecodificadorFrames();
  const datos = Buffer.concat([frameDeCliente("uno"), frameDeCliente("dos")]);
  const eventos = decodificador.agregar(datos);
  assert.deepEqual(eventos.map((evento) => evento.texto), ["uno", "dos"]);
});
