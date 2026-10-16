// Synthetic tests for the EA3 and Latest schema/value formats (mirrors the
// crate's schema::format_tests).
import { describe, expect, test } from 'vitest';
import { ByteReader, ByteWriter } from '../../src/brdb/bytes';
import {
  mpArrayHeader,
  mpMapHeader,
  mpStr,
  mpF64,
} from '../../src/brdb/msgpack';
import { BrdbSchema, BrdbValue, SchemaFormat } from '../../src/brdb/schema';
import { WritePlanner } from '../../src/brdb/writePlan';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (...b: number[]) => new Uint8Array(b);

const withFormat = (text: string, format: SchemaFormat) => {
  const schema = BrdbSchema.fromText(text);
  schema.setFormat(format);
  return schema;
};

/** Encode through both the generic writer and the plan cache; they agree. */
const encode = (schema: BrdbSchema, ty: string, value: BrdbValue) => {
  const generic = schema.encode(ty, value);
  expect(hex(new WritePlanner(schema).encode(ty, value)), ty).toBe(
    hex(generic)
  );
  return generic;
};

const structSection = (w: ByteWriter) => {
  mpMapHeader(w, 1);
  mpStr(w, 'S');
  mpMapHeader(w, 1);
  mpStr(w, 'A');
  mpStr(w, 'i64');
};
const enumSection = (w: ByteWriter) => {
  mpMapHeader(w, 1);
  mpStr(w, 'E');
  mpMapHeader(w, 2);
  mpStr(w, 'E::A');
  w.u8(0);
  mpStr(w, 'E::B');
  w.u8(1);
};

describe('schema containers', () => {
  test('reads the EA3 array containers', () => {
    const two = new ByteWriter();
    mpArrayHeader(two, 2);
    enumSection(two);
    structSection(two);
    const a = BrdbSchema.fromBinary(two.toBytes());
    expect(a.sourceFormat).toBe('EA3');
    expect(a.enums.has('E') && a.structs.has('S')).toBe(true);

    const three = new ByteWriter();
    mpArrayHeader(three, 3);
    enumSection(three);
    mpMapHeader(three, 1);
    mpStr(three, 'V');
    mpArrayHeader(three, 2);
    mpStr(three, 'f64');
    mpStr(three, 'S');
    structSection(three);
    const b = BrdbSchema.fromBinary(three.toBytes());
    expect(b.format()).toBe('EA3');
    expect(hex(b.toBinary())).toBe(hex(three.toBytes()));
  });

  test('reads the Latest map in any section order, and {}', () => {
    const w = new ByteWriter();
    mpMapHeader(w, 3);
    mpStr(w, 'types');
    mpArrayHeader(w, 2);
    mpStr(w, 'E');
    mpStr(w, 'i64');
    mpStr(w, 'structs');
    structSection(w);
    mpStr(w, 'enums');
    enumSection(w);
    const schema = BrdbSchema.fromBinary(w.toBytes());
    expect(schema.sourceFormat).toBe('Latest');
    expect(schema.types).toEqual(['E', 'i64']);
    expect(schema.typeIndex('i64')).toBe(1);

    const empty = BrdbSchema.fromBinary(bytes(0x80));
    expect(empty.structs.size).toBe(0);
    expect(empty.sourceFormat).toBe('Latest');
    expect(hex(empty.toBinary())).toBe('80');
  });

  test('rejects duplicate, unknown and invalid sections', () => {
    const dup = new ByteWriter();
    mpMapHeader(dup, 2);
    mpStr(dup, 'structs');
    structSection(dup);
    mpStr(dup, 'structs');
    structSection(dup);
    expect(() => BrdbSchema.fromBinary(dup.toBytes())).toThrow(/duplicate/);

    const unknown = new ByteWriter();
    mpMapHeader(unknown, 1);
    mpStr(unknown, 'aliases');
    mpMapHeader(unknown, 0);
    expect(() => BrdbSchema.fromBinary(unknown.toBytes())).toThrow(/unknown/);

    const dynamicType = new ByteWriter();
    mpMapHeader(dynamicType, 1);
    mpStr(dynamicType, 'types');
    mpArrayHeader(dynamicType, 1);
    mpStr(dynamicType, 'dynamic_array');
    expect(() => BrdbSchema.fromBinary(dynamicType.toBytes())).toThrow();

    expect(() => BrdbSchema.fromBinary(bytes(0x94))).toThrow(/header length 4/);
  });
});

const DYNAMIC_SCHEMA = `
enum EColor {
    EColor::Red = 0,
    EColor::Green = 1,
}
variant WireValue {
    Bool,
    i64,
    f64,
    Str,
    dynamic_enum,
    weak_object,
    BRSavedComponentRef,
    WireGraphExec,
}
struct BRSavedChunk3DIndex {
    X: i16,
    Y: i16,
    Z: i16,
}
struct BRSavedBrickRef {
    GridPersistentIndex: u32,
    ChunkIndex: BRSavedChunk3DIndex,
    BrickIndexInChunk: u32,
}
struct BRSavedComponentRef {
    Brick: BRSavedBrickRef,
    ComponentTypeIndex: u16,
}
struct WireGraphExec {
}
struct Holder {
    Values: dynamic_array,
    Lookup: dynamic_map,
    Value: WireValue,
    Tail: u8,
}
types {
    EColor,
    i64,
    Str,
    f64,
    Bool,
    brick_handle,
    component_handle,
}
`;

describe('Latest schemas and values', () => {
  const schema = () => BrdbSchema.fromText(DYNAMIC_SCHEMA);

  test('a types table selects the Latest container; EA3 cannot express it', () => {
    const s = schema();
    expect(s.needsLatestForm()).toBe(true);
    expect(s.format()).toBe('Latest');
    const bin = s.toBinary();
    expect(bin[0] & 0xf0).toBe(0x80);
    expect(() => s.toBinary('EA3')).toThrow(/EA3 format cannot express/);
    const back = BrdbSchema.fromBinary(bin);
    expect(back.types).toEqual(s.types);
    expect(hex(back.toBinary())).toBe(hex(bin));

    // Without types: the EA3 array under Auto; Latest omits empty sections.
    const plain = BrdbSchema.fromText('struct S { A: i64 }');
    expect(plain.format()).toBe('EA3');
    expect(plain.toBinary()[0]).toBe(0x93);
    const expected = new ByteWriter();
    mpMapHeader(expected, 1);
    mpStr(expected, 'structs');
    structSection(expected);
    expect(hex(plain.toBinary('Latest'))).toBe(hex(expected.toBytes()));
    // a schema read in the map form keeps it under Auto
    const reread = BrdbSchema.fromBinary(plain.toBinary('Latest'));
    expect(hex(reread.toBinary())).toBe(hex(expected.toBytes()));
  });

  test('dynamic containers round-trip, including empty ones', () => {
    const s = schema();
    const value: BrdbValue = {
      Values: { $elementType: 'i64', $array: [10, 20] },
      Lookup: { $keyType: 'i64', $valueType: 'f64', $map: [[12, 3.5]] },
      Value: { $variant: 'Str', value: 'hi' },
      Tail: 7,
    } as unknown as BrdbValue;
    const bin = encode(s, 'Holder', value);
    expect(Array.from(bin.slice(0, 7))).toEqual([1, 0x92, 10, 20, 1, 3, 0x81]);
    expect(s.decode(bin, 'Holder')).toEqual(value);

    const empty = {
      Values: { $elementType: 'Str', $array: [] },
      Lookup: { $keyType: 'EColor', $valueType: 'Bool', $map: [] },
      Value: { $variant: 'Str', value: 'hi' },
      Tail: 7,
    } as unknown as BrdbValue;
    const emptyBin = encode(s, 'Holder', empty);
    expect(Array.from(emptyBin.slice(0, 5))).toEqual([2, 0x90, 0, 4, 0x80]);
    expect(s.decode(emptyBin, 'Holder')).toEqual(empty);

    // unset: empty containers of f64 elements and i64 -> f64 pairs
    const zero = s.zeroValue('Holder') as Record<string, BrdbValue>;
    const w = new ByteWriter();
    s.writeValue(w, 'dynamic_array', zero.Values);
    s.writeValue(w, 'dynamic_map', zero.Lookup);
    expect(Array.from(w.toBytes())).toEqual([3, 0x90, 1, 3, 0x80]);
  });

  test('type references are validated', () => {
    const s = schema();
    expect(() =>
      s.readValue(new ByteReader(bytes(9, 0x90)), 'dynamic_array')
    ).toThrow(/type index 9 is outside the types table \(length 7\)/);
    expect(() =>
      s.encode('dynamic_array', {
        $elementType: 'Vector',
        $array: [],
      } as unknown as BrdbValue)
    ).toThrow(/not in the types table/);
  });

  test('handle arrays hold inline refs', () => {
    const s = schema();
    const empty = s.readValue(new ByteReader(bytes(5, 0x90)), 'dynamic_array');
    expect(empty).toEqual({ $elementType: 'brick_handle', $array: [] });
    expect(Array.from(s.encode('dynamic_array', empty))).toEqual([5, 0x90]);

    // Two elements of a game-saved array of arrays: each is a bare
    // BRSavedComponentRef (grid 0, chunk 0,0,0, brick 297/298, type 15).
    const brickRef = (index: number) => ({
      GridPersistentIndex: 0,
      ChunkIndex: { X: 0, Y: 0, Z: 0 },
      BrickIndexInChunk: index,
    });
    const saved = [
      0x06, 0x92, 0, 0, 0, 0, 0xcd, 0x01, 0x29, 0x0f, 0, 0, 0, 0, 0xcd, 0x01,
      0x2a, 0x0f,
    ];
    const components = {
      $elementType: 'component_handle',
      $array: [297, 298].map(i => ({
        Brick: brickRef(i),
        ComponentTypeIndex: 15,
      })),
    } as unknown as BrdbValue;
    expect(
      s.readValue(new ByteReader(Uint8Array.from(saved)), 'dynamic_array')
    ).toEqual(components);
    expect(Array.from(s.encode('dynamic_array', components))).toEqual(saved);

    // A brick handle is the BRSavedBrickRef part of the same layout.
    const bricks = {
      $elementType: 'brick_handle',
      $array: [brickRef(297), brickRef(298)],
    } as unknown as BrdbValue;
    const brickBytes = [
      0x05, 0x92, 0, 0, 0, 0, 0xcd, 0x01, 0x29, 0, 0, 0, 0, 0xcd, 0x01, 0x2a,
    ];
    expect(Array.from(s.encode('dynamic_array', bricks))).toEqual(brickBytes);
    expect(
      s.readValue(new ByteReader(Uint8Array.from(brickBytes)), 'dynamic_array')
    ).toEqual(bricks);
  });

  test('WireValue alternatives and the extra type strings', () => {
    const s = schema();
    const f64 = new ByteWriter();
    f64.u8(2);
    mpF64(f64, 2.5);
    const cases: [BrdbValue, number[]][] = [
      [{ $variant: 'Bool', value: true }, [0, 0xc3]],
      [{ $variant: 'i64', value: -5 }, [1, 0xfb]],
      [{ $variant: 'f64', value: 2.5 }, Array.from(f64.toBytes())],
      [{ $variant: 'Str', value: 'ok' }, [3, 0xa2, 0x6f, 0x6b]],
      // dynamic_enum: the enum's types index (0 = EColor), then the value
      [
        { $variant: 'dynamic_enum', value: { $enum: 'EColor', value: 1 } },
        [4, 0, 1],
      ],
      [{ $variant: 'weak_object', value: null }, [5, 0xff]],
      [
        {
          $variant: 'BRSavedComponentRef',
          value: {
            Brick: {
              GridPersistentIndex: 1,
              ChunkIndex: { X: -1, Y: 0, Z: 2 },
              BrickIndexInChunk: 42,
            },
            ComponentTypeIndex: 3,
          },
        },
        [6, 1, 0xff, 0, 2, 42, 3],
      ],
      [{ $variant: 'WireGraphExec', value: {} }, [7]],
    ];
    for (const [value, expected] of cases) {
      const bin = encode(s, 'WireValue', value as BrdbValue);
      expect(Array.from(bin), JSON.stringify(value)).toEqual(expected);
      expect(s.decode(bin, 'WireValue')).toEqual(value);
    }
  });

  test('variant alternatives are matched by type, not position', () => {
    const saved = withFormat(
      'variant V { f64, i64, bool } struct S { Value: V, Tail: u8 }',
      'EA3'
    );
    const current = withFormat(
      'variant V { Str, Bool, i64, f64 } struct S { Value: V, Tail: u8 }',
      'Latest'
    );
    // saved selector 2 (bool), then Tail
    const value = saved.decode(bytes(2, 0xc3, 9), 'S');
    expect(Array.from(encode(current, 'S', value))).toEqual([1, 0xc3, 9]);
  });

  test('a removed alternative is consumed with its saved type', () => {
    const saved = withFormat(
      'variant V { f64, Old } struct Old { A: i64, B: str } struct S { Value: V, Tail: u8 }',
      'EA3'
    );
    const current = withFormat(
      'variant V { f64 } struct S { Value: V, Tail: u8 }',
      'Latest'
    );
    // selector 1 (Old {A: 300, B: "x"}) then Tail = 5
    const value = saved.decode(
      bytes(1, 0xd1, 0x01, 0x2c, 0xa1, 0x78, 5),
      'S'
    ) as Record<string, BrdbValue>;
    expect(value.Tail).toBe(5);
    expect(() => current.encode('S', value)).toThrow(/not a member/);
  });

  test('nil fields consume no bytes', () => {
    const s = BrdbSchema.fromText('struct S { A: nil, B: u8 }');
    expect(s.decode(bytes(7), 'S')).toEqual({ A: null, B: 7 });
    expect(Array.from(encode(s, 'S', { A: null, B: 7 }))).toEqual([7]);
  });

  test('flat arrays: C layout in Latest, packed in EA3', () => {
    const text = 'struct P { A: u8, B: u32 } struct S { Items: P[flat] }';
    const ea3 = withFormat(text, 'EA3');
    const latest = withFormat(text, 'Latest');
    expect(ea3.flatTypeSize('P')).toBe(5);
    expect(latest.flatTypeSize('P')).toBe(8);
    const value = { Items: [{ A: 1, B: 2 }] };
    expect(Array.from(encode(latest, 'S', value))).toEqual([
      0xc4, 8, 1, 0, 0, 0, 2, 0, 0, 0,
    ]);
    expect(latest.decode(encode(latest, 'S', value), 'S')).toEqual(value);
    expect(Array.from(encode(ea3, 'S', value))).toEqual([
      0xc4, 5, 1, 2, 0, 0, 0,
    ]);
    expect(ea3.decode(encode(ea3, 'S', value), 'S')).toEqual(value);
  });

  test('u8: legacy negatives read as 128..255; written per format', () => {
    for (const format of ['EA3', 'Latest'] as const) {
      const s = withFormat('struct S { A: u8 }', format);
      expect(s.decode(bytes(0xd0, 0x80), 'u8')).toBe(128);
      expect(s.decode(bytes(0xff), 'u8')).toBe(255);
      expect(s.decode(bytes(0xcc, 200), 'u8')).toBe(200);
    }
    expect(
      Array.from(
        encode(withFormat('struct S { A: u8 }', 'EA3'), 'S', { A: 200 })
      )
    ).toEqual([0xd0, 200]);
    expect(
      Array.from(
        encode(withFormat('struct S { A: u8 }', 'Latest'), 'S', { A: 200 })
      )
    ).toEqual([0xcc, 200]);
  });

  test('extracted structs carry the types table', () => {
    const s = schema();
    const { enums, structs, types } = s.extractStructsTransitive(['Holder']);
    expect(types).toEqual(s.types);
    expect(enums.has('EColor')).toBe(true);
    expect(structs.has('BRSavedComponentRef')).toBe(true);
    const small = BrdbSchema.fromText('struct Base { }');
    small.merge(s.extractStructsTransitive(['Holder']));
    expect(small.format()).toBe('Latest');
    const plain = BrdbSchema.fromText('struct A { X: i64 } types { i64 }');
    expect(plain.extractStructsTransitive(['A']).types).toEqual([]);
  });
});

describe('EA3 regressions', () => {
  const text = 'struct S { W: wire_graph_variant, O: weak_object, Tail: u8 }';

  test('wire_graph_variant selector 3 keeps its i64 index; weak_object keeps its index', () => {
    const s = withFormat(text, 'EA3');
    // W = selector 3 + index 2, O = index 3, Tail = 9
    const value = s.decode(bytes(3, 2, 3, 9), 'S');
    expect(value).toEqual({
      W: { $variant: 'weak_object', value: 2 },
      O: 3,
      Tail: 9,
    });
    expect(Array.from(encode(s, 'S', value))).toEqual([3, 2, 3, 9]);
  });

  test('Latest follows the spec: no selector-3 payload, weak_object is null / -1', () => {
    const s = withFormat(text, 'Latest');
    const value = s.decode(bytes(3, 3, 9), 'S');
    expect(value).toEqual({
      W: { $variant: 'weak_object', value: null },
      O: null,
      Tail: 9,
    });
    expect(Array.from(encode(s, 'S', value))).toEqual([3, 0xff, 9]);
  });
});
