import { describe, expect, test } from 'vitest';
import { ByteReader, ByteWriter } from '../../src/brdb/bytes';
import {
  mpArrayHeader,
  mpBinHeader,
  mpBool,
  mpF32,
  mpF64,
  mpInt,
  mpMapHeader,
  mpNil,
  mpStr,
  mpU8,
  mpUint,
  rdArrayLen,
  rdBinLen,
  rdF32,
  rdF64,
  rdInt,
  rdMapLen,
  rdNil,
  rdStr,
  rdUint,
} from '../../src/brdb/msgpack';

const bytesOf = (fn: (w: ByteWriter) => void): number[] => {
  const w = new ByteWriter();
  fn(w);
  return Array.from(w.toBytes());
};

describe('writer deviations', () => {
  test('mpU8 (u8-typed): pfix / i8-marker / negative-fixint bands', () => {
    expect(bytesOf(w => mpU8(w, 0))).toEqual([0x00]);
    expect(bytesOf(w => mpU8(w, 127))).toEqual([0x7f]);
    // 128..=224 use the I8 marker (the game casts u8 through i8 on write;
    // its field SKIPPER rejects the 0xcc uint8 form with mpack_error_type)
    expect(bytesOf(w => mpU8(w, 128))).toEqual([0xd0, 0x80]);
    expect(bytesOf(w => mpU8(w, 224))).toEqual([0xd0, 0xe0]);
    // 225..255 are single negative-fixint bytes
    expect(bytesOf(w => mpU8(w, 225))).toEqual([0xe1]);
    expect(bytesOf(w => mpU8(w, 255))).toEqual([0xff]);
  });

  test('mpUint marker selection', () => {
    expect(bytesOf(w => mpUint(w, 127))).toEqual([0x7f]);
    expect(bytesOf(w => mpUint(w, 128))).toEqual([0xcc, 0x80]);
    expect(bytesOf(w => mpUint(w, 255))).toEqual([0xcc, 0xff]);
    expect(bytesOf(w => mpUint(w, 256))).toEqual([0xcd, 0x01, 0x00]);
    expect(bytesOf(w => mpUint(w, 65535))).toEqual([0xcd, 0xff, 0xff]);
    expect(bytesOf(w => mpUint(w, 65536))).toEqual([
      0xce, 0x00, 0x01, 0x00, 0x00,
    ]);
    expect(bytesOf(w => mpUint(w, 4294967295))).toEqual([
      0xce, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(bytesOf(w => mpUint(w, 4294967296))).toEqual([
      0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  test('mpInt: positive 128..32767 uses i16 (dead-i8-branch quirk)', () => {
    expect(bytesOf(w => mpInt(w, 0))).toEqual([0x00]);
    expect(bytesOf(w => mpInt(w, 127))).toEqual([0x7f]);
    expect(bytesOf(w => mpInt(w, 128))).toEqual([0xd1, 0x00, 0x80]); // NOT 0xd0/0xcc
    expect(bytesOf(w => mpInt(w, 32767))).toEqual([0xd1, 0x7f, 0xff]);
    expect(bytesOf(w => mpInt(w, 32768))).toEqual([
      0xd2, 0x00, 0x00, 0x80, 0x00,
    ]);
    expect(bytesOf(w => mpInt(w, 2147483647))).toEqual([
      0xd2, 0x7f, 0xff, 0xff, 0xff,
    ]);
    expect(bytesOf(w => mpInt(w, 2147483648))).toEqual([
      0xd3, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00,
    ]);
  });

  test('mpInt: negatives', () => {
    expect(bytesOf(w => mpInt(w, -1))).toEqual([0xff]);
    expect(bytesOf(w => mpInt(w, -31))).toEqual([0xe1]);
    // -32 itself takes i8 (the encoder tests value > -32, strictly)
    expect(bytesOf(w => mpInt(w, -32))).toEqual([0xd0, 0xe0]);
    expect(bytesOf(w => mpInt(w, -128))).toEqual([0xd0, 0x80]);
    expect(bytesOf(w => mpInt(w, -129))).toEqual([0xd1, 0xff, 0x7f]);
    expect(bytesOf(w => mpInt(w, -32768))).toEqual([0xd1, 0x80, 0x00]);
    expect(bytesOf(w => mpInt(w, -32769))).toEqual([
      0xd2, 0xff, 0xff, 0x7f, 0xff,
    ]);
    expect(bytesOf(w => mpInt(w, -2147483649))).toEqual([
      0xd3, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff,
    ]);
  });

  test('mpF32 whole-number shrink: v===round(v) && v<65535 && v>-32768', () => {
    expect(bytesOf(w => mpF32(w, 0))).toEqual([0x00]);
    expect(bytesOf(w => mpF32(w, 200))).toEqual([0xd1, 0x00, 0xc8]);
    expect(bytesOf(w => mpF32(w, -5))).toEqual([0xfb]);
    expect(bytesOf(w => mpF32(w, 65534))).toEqual([
      0xd2, 0x00, 0x00, 0xff, 0xfe,
    ]);
    // 65535 fails (v as u16) < u16::MAX -> real f32
    expect(bytesOf(w => mpF32(w, 65535))).toEqual([
      0xca, 0x47, 0x7f, 0xff, 0x00,
    ]);
    // -32768 fails (v as i16) > i16::MIN -> real f32
    expect(bytesOf(w => mpF32(w, -32768))).toEqual([
      0xca, 0xc7, 0x00, 0x00, 0x00,
    ]);
    expect(bytesOf(w => mpF32(w, 0.5))).toEqual([0xca, 0x3f, 0x00, 0x00, 0x00]);
    expect(bytesOf(w => mpF32(w, NaN))).toEqual([0xca, 0x7f, 0xc0, 0x00, 0x00]);
    expect(bytesOf(w => mpF32(w, Infinity))).toEqual([
      0xca, 0x7f, 0x80, 0x00, 0x00,
    ]);
  });

  test('mpF64 whole-number shrink: v<4294967295 && v>-2147483648', () => {
    expect(bytesOf(w => mpF64(w, 3))).toEqual([0x03]);
    expect(bytesOf(w => mpF64(w, 4294967294))).toEqual([
      0xd3, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xfe,
    ]);
    expect(bytesOf(w => mpF64(w, 4294967295))).toEqual([
      0xcb, 0x41, 0xef, 0xff, 0xff, 0xff, 0xe0, 0x00, 0x00,
    ]);
    expect(bytesOf(w => mpF64(w, 0.25))).toEqual([
      0xcb, 0x3f, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  test('str/bin/array/map headers', () => {
    expect(bytesOf(w => mpStr(w, ''))).toEqual([0xa0]);
    expect(bytesOf(w => mpStr(w, 'abc'))).toEqual([0xa3, 0x61, 0x62, 0x63]);
    expect(bytesOf(w => mpStr(w, 'x'.repeat(31)))[0]).toEqual(0xbf);
    expect(bytesOf(w => mpStr(w, 'x'.repeat(32))).slice(0, 2)).toEqual([
      0xd9, 32,
    ]);
    expect(bytesOf(w => mpStr(w, 'x'.repeat(256))).slice(0, 3)).toEqual([
      0xda, 0x01, 0x00,
    ]);
    expect(bytesOf(w => mpBinHeader(w, 0))).toEqual([0xc4, 0x00]);
    expect(bytesOf(w => mpBinHeader(w, 255))).toEqual([0xc4, 0xff]);
    expect(bytesOf(w => mpBinHeader(w, 256))).toEqual([0xc5, 0x01, 0x00]);
    expect(bytesOf(w => mpBinHeader(w, 65536))).toEqual([
      0xc6, 0x00, 0x01, 0x00, 0x00,
    ]);
    expect(bytesOf(w => mpArrayHeader(w, 15))).toEqual([0x9f]);
    expect(bytesOf(w => mpArrayHeader(w, 16))).toEqual([0xdc, 0x00, 0x10]);
    expect(bytesOf(w => mpMapHeader(w, 15))).toEqual([0x8f]);
    expect(bytesOf(w => mpMapHeader(w, 16))).toEqual([0xde, 0x00, 0x10]);
    expect(bytesOf(w => mpBool(w, true))).toEqual([0xc3]);
    expect(bytesOf(w => mpBool(w, false))).toEqual([0xc2]);
    expect(bytesOf(w => mpNil(w))).toEqual([0xc0]);
  });

  test('UTF-8 string length is byte length, not code-unit length', () => {
    // 'é' is 2 UTF-8 bytes
    expect(bytesOf(w => mpStr(w, 'é'))).toEqual([0xa2, 0xc3, 0xa9]);
  });
});

describe('reader', () => {
  test('rdUint reinterprets negative fixint as 256+v', () => {
    expect(rdUint(new ByteReader(new Uint8Array([0xe1])))).toBe(225);
    expect(rdUint(new ByteReader(new Uint8Array([0xff])))).toBe(255);
    expect(rdUint(new ByteReader(new Uint8Array([0xe0])))).toBe(224);
  });

  test('rdUint reinterprets negative I8 marker as 128-255', () => {
    // The game's own encoder casts u8 to i8 before writing, so a u8 field
    // holding 128 arrives as d0 80 (seen in real saves: MaterialAlpha on
    // Component_BrickPropertyChanger).
    expect(rdUint(new ByteReader(new Uint8Array([0xd0, 0x80])))).toBe(128);
    expect(rdUint(new ByteReader(new Uint8Array([0xd0, 0xdf])))).toBe(223);
    expect(rdUint(new ByteReader(new Uint8Array([0xd0, 0x05])))).toBe(5);
  });

  test('rdUint accepts unsigned markers, rejects I16/I32/I64', () => {
    expect(rdUint(new ByteReader(new Uint8Array([0xcc, 0x80])))).toBe(128);
    expect(rdUint(new ByteReader(new Uint8Array([0xcd, 0x01, 0x00])))).toBe(
      256
    );
    expect(() =>
      rdUint(new ByteReader(new Uint8Array([0xd1, 0x00, 0x80])))
    ).toThrow();
  });

  test('rdInt accepts every int marker', () => {
    expect(rdInt(new ByteReader(new Uint8Array([0xd1, 0x00, 0x80])))).toBe(128);
    expect(rdInt(new ByteReader(new Uint8Array([0xd0, 0xe0])))).toBe(-32);
    expect(
      rdInt(new ByteReader(new Uint8Array([0xcf, 0, 0, 0, 1, 0, 0, 0, 0])))
    ).toBe(4294967296);
  });

  test('rdF32/rdF64 accept int markers and coerce', () => {
    expect(rdF32(new ByteReader(new Uint8Array([0xd1, 0x00, 0xc8])))).toBe(200);
    expect(rdF32(new ByteReader(new Uint8Array([0xfb])))).toBe(-5);
    // f32 rejects 32-bit int markers
    expect(() =>
      rdF32(new ByteReader(new Uint8Array([0xd2, 0, 0, 0, 1])))
    ).toThrow();
    expect(rdF64(new ByteReader(new Uint8Array([0xd2, 0, 0, 0, 1])))).toBe(1);
    // f64 accepts an F32 payload
    expect(
      rdF64(new ByteReader(new Uint8Array([0xca, 0x3f, 0x00, 0x00, 0x00])))
    ).toBe(0.5);
  });

  test('round trips', () => {
    for (const v of [
      0,
      1,
      127,
      128,
      255,
      256,
      65535,
      65536,
      2 ** 32 - 1,
      2 ** 32,
    ]) {
      const w = new ByteWriter();
      mpUint(w, v);
      expect(rdUint(new ByteReader(w.toBytes()))).toBe(v);
    }
    for (const v of [
      -1,
      -31,
      -32,
      -128,
      -129,
      -32768,
      -32769,
      -(2 ** 31),
      12345,
    ]) {
      const w = new ByteWriter();
      mpInt(w, v);
      expect(rdInt(new ByteReader(w.toBytes()))).toBe(v);
    }
    for (const s of ['', 'abc', 'é'.repeat(40), 'x'.repeat(300)]) {
      const w = new ByteWriter();
      mpStr(w, s);
      expect(rdStr(new ByteReader(w.toBytes()))).toBe(s);
    }
    for (const v of [0.5, -123.25, 65535, 1e10]) {
      const w = new ByteWriter();
      mpF64(w, v);
      expect(rdF64(new ByteReader(w.toBytes()))).toBe(v);
    }
    const w = new ByteWriter();
    mpArrayHeader(w, 20);
    mpMapHeader(w, 3);
    mpBinHeader(w, 5);
    mpNil(w);
    const r = new ByteReader(w.toBytes());
    expect(rdArrayLen(r)).toBe(20);
    expect(rdMapLen(r)).toBe(3);
    expect(rdBinLen(r)).toBe(5);
    rdNil(r);
    expect(r.remaining).toBe(0);
  });
});
