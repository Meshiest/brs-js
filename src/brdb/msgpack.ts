// msgpack primitives for the brdb msgpack-schema encoding. This is NOT standard
// msgpack: see the u8 negative-fixint band and the float shrink predicates.
import { ByteReader, ByteWriter } from './bytes';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const checkSafe = (v: number, what: string) => {
  if (!Number.isSafeInteger(v))
    throw new RangeError(`brdb: ${what} ${v} is not a safe integer`);
};

export const mpNil = (w: ByteWriter) => w.u8(0xc0);
export const mpBool = (w: ByteWriter, v: boolean) => w.u8(v ? 0xc3 : 0xc2);

// The 'u8' schema type only. 0..=127 pfix; 225..=255 negative fixint
// (0xe1..0xff); 128..=224 u8 marker.
export function mpU8(w: ByteWriter, v: number) {
  if (v < 0 || v > 255 || !Number.isInteger(v))
    throw new RangeError(`brdb: u8 value out of range: ${v}`);
  if (v <= 127) w.u8(v);
  // reinterpreted as negative fixint on the wire
  else if (v > 224) w.u8(v);
  else {
    w.u8(0xcc);
    w.u8(v);
  }
}

// u16/u32/u64 schema types.
export function mpUint(w: ByteWriter, v: number) {
  checkSafe(v, 'uint');
  if (v < 0) throw new RangeError(`brdb: uint value negative: ${v}`);
  if (v <= 127) w.u8(v);
  else if (v <= 0xff) {
    w.u8(0xcc);
    w.u8(v);
  } else if (v <= 0xffff) {
    w.u8(0xcd);
    w.u16be(v);
  } else if (v <= 0xffffffff) {
    w.u8(0xce);
    w.u32be(v);
  } else {
    w.u8(0xcf);
    w.u64be(BigInt(v));
  }
}

// i8..i64 schema types. Positive values use SIGNED markers (never 0xcc+),
// and positives 128..=32767 skip i8 and go straight to i16.
export function mpInt(w: ByteWriter, v: number) {
  checkSafe(v, 'int');
  if (v >= 0) {
    if (v < 128) w.u8(v);
    else if (v <= 32767) {
      w.u8(0xd1);
      w.i16be(v);
    } else if (v <= 2147483647) {
      w.u8(0xd2);
      w.i32be(v);
    } else {
      w.u8(0xd3);
      w.i64be(BigInt(v));
    }
  } else {
    // negative fixint 0xe1..0xff
    if (v > -32) w.u8(0x100 + v);
    else if (v >= -128) {
      w.u8(0xd0);
      w.i8(v);
    } else if (v >= -32768) {
      w.u8(0xd1);
      w.i16be(v);
    } else if (v >= -2147483648) {
      w.u8(0xd2);
      w.i32be(v);
    } else {
      w.u8(0xd3);
      w.i64be(BigInt(v));
    }
  }
}

// Whole f32 shrinks to int when (v as u16) < 65535 && (v as i16) > -32768.
// With saturating casts this reduces to v < 65535 && v > -32768.
export function mpF32(w: ByteWriter, v: number) {
  if (v === Math.round(v) && v < 65535 && v > -32768) mpInt(w, v === 0 ? 0 : v);
  else {
    w.u8(0xca);
    w.f32be(v);
  }
}

// Whole f64 shrinks when (v as u32) < 4294967295 && (v as i32) > -2147483648.
export function mpF64(w: ByteWriter, v: number) {
  if (v === Math.round(v) && v < 4294967295 && v > -2147483648)
    mpInt(w, v === 0 ? 0 : v);
  else {
    w.u8(0xcb);
    w.f64be(v);
  }
}

export function mpStr(w: ByteWriter, s: string) {
  const bytes = utf8Encoder.encode(s);
  const len = bytes.length;
  if (len < 32) w.u8(0xa0 | len);
  else if (len < 256) {
    w.u8(0xd9);
    w.u8(len);
  } else if (len <= 0xffff) {
    w.u8(0xda);
    w.u16be(len);
  } else {
    w.u8(0xdb);
    w.u32be(len);
  }
  w.bytes(bytes);
}

export function mpBinHeader(w: ByteWriter, len: number) {
  if (len < 256) {
    w.u8(0xc4);
    w.u8(len);
  } else if (len <= 0xffff) {
    w.u8(0xc5);
    w.u16be(len);
  } else {
    w.u8(0xc6);
    w.u32be(len);
  }
}

export function mpArrayHeader(w: ByteWriter, len: number) {
  if (len < 16) w.u8(0x90 | len);
  else if (len <= 0xffff) {
    w.u8(0xdc);
    w.u16be(len);
  } else {
    w.u8(0xdd);
    w.u32be(len);
  }
}

export function mpMapHeader(w: ByteWriter, len: number) {
  if (len < 16) w.u8(0x80 | len);
  else if (len <= 0xffff) {
    w.u8(0xde);
    w.u16be(len);
  } else {
    w.u8(0xdf);
    w.u32be(len);
  }
}

// ---- readers ----

const fromBigint = (v: bigint): number => {
  if (
    v > BigInt(Number.MAX_SAFE_INTEGER) ||
    v < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError(
      `brdb: 64-bit value ${v} exceeds JS safe integer range`
    );
  return Number(v);
};

const badMarker = (marker: number, expected: string): never => {
  throw new TypeError(
    `brdb: unexpected marker 0x${marker.toString(16)} for ${expected}`
  );
};

const isFixPos = (m: number) => (m & 0x80) === 0;
const isFixNeg = (m: number) => (m & 0xe0) === 0xe0;

// Accepts every int marker, signed and unsigned.
export function rdInt(r: ByteReader): number {
  const m = r.u8();
  if (isFixPos(m)) return m;
  if (isFixNeg(m)) return m - 256;
  switch (m) {
    case 0xcc:
      return r.u8();
    case 0xcd:
      return r.u16be();
    case 0xce:
      return r.u32be();
    case 0xcf:
      return fromBigint(r.u64be());
    case 0xd0:
      return r.i8();
    case 0xd1:
      return r.i16be();
    case 0xd2:
      return r.i32be();
    case 0xd3:
      return fromBigint(r.i64be());
    default:
      return badMarker(m, 'integer');
  }
}

// Negative fixint bytes are unsigned 224..255 in this format (256+v), and
// an explicit I8 marker's payload is likewise reinterpreted as 0..255: the
// game's encoder casts u8 to i8 before writing, so u8 values 128..=224
// arrive as d0 XX in real saves (e.g. MaterialAlpha=128 is d0 80). The
// reference decoder sign-extends the i8 to u64 and its u8 field cast
// truncates back to the same byte.
export function rdUint(r: ByteReader): number {
  const m = r.u8();
  if (isFixPos(m)) return m;
  if (isFixNeg(m)) return m; // 0xe0..0xff read back as 224..255
  switch (m) {
    case 0xcc:
    case 0xd0:
      return r.u8();
    case 0xcd:
      return r.u16be();
    case 0xce:
      return r.u32be();
    case 0xcf:
      return fromBigint(r.u64be());
    default:
      return badMarker(m, 'uint');
  }
}

// f32 accepts FixPos/FixNeg/I8/I16/U8/U16/F32 only.
export function rdF32(r: ByteReader): number {
  const m = r.u8();
  if (isFixPos(m)) return m;
  if (isFixNeg(m)) return m - 256;
  switch (m) {
    case 0xcc:
      return r.u8();
    case 0xcd:
      return r.u16be();
    case 0xd0:
      return r.i8();
    case 0xd1:
      return r.i16be();
    case 0xca:
      return r.f32be();
    default:
      return badMarker(m, 'float32');
  }
}

// f64 additionally accepts I32/U32/F32/F64.
export function rdF64(r: ByteReader): number {
  const m = r.u8();
  if (isFixPos(m)) return m;
  if (isFixNeg(m)) return m - 256;
  switch (m) {
    case 0xcc:
      return r.u8();
    case 0xcd:
      return r.u16be();
    case 0xce:
      return r.u32be();
    case 0xd0:
      return r.i8();
    case 0xd1:
      return r.i16be();
    case 0xd2:
      return r.i32be();
    case 0xca:
      return r.f32be();
    case 0xcb:
      return r.f64be();
    default:
      return badMarker(m, 'float64');
  }
}

export function rdBool(r: ByteReader): boolean {
  const m = r.u8();
  if (m === 0xc3) return true;
  if (m === 0xc2) return false;
  return badMarker(m, 'bool');
}

export function rdStr(r: ByteReader): string {
  const m = r.u8();
  let len: number;
  if ((m & 0xe0) === 0xa0) len = m & 0x1f;
  else if (m === 0xd9) len = r.u8();
  else if (m === 0xda) len = r.u16be();
  else if (m === 0xdb) len = r.u32be();
  else return badMarker(m, 'str');
  return utf8Decoder.decode(r.bytes(len));
}

export function rdBinLen(r: ByteReader): number {
  const m = r.u8();
  if (m === 0xc4) return r.u8();
  if (m === 0xc5) return r.u16be();
  if (m === 0xc6) return r.u32be();
  return badMarker(m, 'bin');
}

export function rdArrayLen(r: ByteReader): number {
  const m = r.u8();
  if ((m & 0xf0) === 0x90) return m & 0x0f;
  if (m === 0xdc) return r.u16be();
  if (m === 0xdd) return r.u32be();
  return badMarker(m, 'array');
}

export function rdMapLen(r: ByteReader): number {
  const m = r.u8();
  if ((m & 0xf0) === 0x80) return m & 0x0f;
  if (m === 0xde) return r.u16be();
  if (m === 0xdf) return r.u32be();
  return badMarker(m, 'map');
}

export function rdNil(r: ByteReader): void {
  const m = r.u8();
  if (m !== 0xc0) badMarker(m, 'nil');
}
