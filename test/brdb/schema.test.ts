import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BrdbSchema, embeddedSchema } from '../../src/brdb/schema';
import { EmbeddedSchemaName, SCHEMAS } from '../../src/brdb/schemas';

// Fixtures are generated artifacts and never committed (same policy as the
// oracle). Run `just fixtures` to (re)generate them.
const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe.skipIf(!hasFixtures)(
  'embedded schema data -> binary matches the reference serializer byte-for-byte',
  () => {
    for (const name of Object.keys(SCHEMAS) as EmbeddedSchemaName[]) {
      test(name, () => {
        expect(hex(embeddedSchema(name).toBinary())).toBe(
          hex(fixture(`schemas/${name}.bin`))
        );
      });
    }
  }
);

describe.skipIf(!hasFixtures)(
  'binary round-trip (schema_roundtrip mirror)',
  () => {
    // SCHEMAS includes the max component schema: exercises enums,
    // variants, and the topological sort at scale
    const names = Object.keys(SCHEMAS);
    for (const name of names) {
      test(name, () => {
        const original = fixture(`schemas/${name}.bin`);
        expect(hex(BrdbSchema.fromBinary(original).toBinary())).toBe(
          hex(original)
        );
      });
    }
  }
);

test('parsed model shape: BRSavedBrickChunkSoA', () => {
  const schema = embeddedSchema('BRSavedBrickChunkSoA');
  const soa = schema.structs.get('BRSavedBrickChunkSoA')!;
  expect([...soa.keys()]).toEqual([
    'ProceduralBrickStartingIndex',
    'BrickSizeCounters',
    'BrickSizes',
    'BrickTypeIndices',
    'OwnerIndices',
    'OriginalOwnerIndices',
    'RelativePositions',
    'Orientations',
    'CollisionFlags_Player',
    'CollisionFlags_Player1',
    'CollisionFlags_Player2',
    'CollisionFlags_Player3',
    'CollisionFlags_Weapon',
    'CollisionFlags_Interaction',
    'CollisionFlags_Physics',
    'VisibilityFlags',
    'MaterialIndices',
    'ColorsAndAlphas',
    'bColorsAreLinear',
  ]);
  expect(soa.get('RelativePositions')).toEqual({
    kind: 'flatarray',
    type: 'BRSavedRelativeBrickPosition',
  });
  expect(soa.get('BrickSizes')).toEqual({
    kind: 'array',
    type: 'BRSavedBrickSize',
  });
  expect(soa.get('bColorsAreLinear')).toEqual({ kind: 'type', type: 'bool' });
});

test('topo order puts dependencies before their users', () => {
  const order = embeddedSchema('BRSavedBrickChunkSoA').topoStructOrder();
  const soaAt = order.indexOf('BRSavedBrickChunkSoA');
  for (const dep of [
    'BRSavedBitFlags',
    'BRSavedBrickColor',
    'BRSavedBrickSize',
    'BRSavedBrickSizeCounter',
    'BRSavedRelativeBrickPosition',
  ]) {
    expect(order.indexOf(dep)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(dep)).toBeLessThan(soaAt);
  }
});

test('plaintext parser handles enum and variant declarations', () => {
  const schema = BrdbSchema.fromText(`
    enum EFoo {
      EFoo::A = 0,
      EFoo::B = 0x10,
      EFoo::C = 0b1_01,
      EFoo::D = -2,
    }
    variant MyVariant {
      f64,
      i64,
      SomeStruct,
    }
    struct SomeStruct {
      Value: EFoo,
      Var: MyVariant,
    }
  `);
  expect([...schema.enums.get('EFoo')!.entries()]).toEqual([
    ['EFoo::A', 0],
    ['EFoo::B', 16],
    ['EFoo::C', 5],
    ['EFoo::D', -2],
  ]);
  expect(schema.variants.get('MyVariant')).toEqual([
    'f64',
    'i64',
    'SomeStruct',
  ]);
  expect(schema.structs.get('SomeStruct')!.get('Var')).toEqual({
    kind: 'type',
    type: 'MyVariant',
  });
});

test('variant values round-trip with tag preserved', () => {
  const schema = BrdbSchema.fromText(`
    variant MyVariant {
      f64,
      i64,
      bool,
      weak_object,
      WireGraphExec,
      Vec3,
      str,
    }
    struct WireGraphExec {
    }
    struct Vec3 {
      X: f64,
      Y: f64,
      Z: f64,
    }
    struct Holder {
      Value: MyVariant,
    }
  `);
  const cases = [
    { $variant: 'f64', value: 1.5 },
    { $variant: 'i64', value: -7 },
    { $variant: 'bool', value: true },
    { $variant: 'weak_object', value: null },
    { $variant: 'weak_object', value: 3 },
    { $variant: 'WireGraphExec', value: {} },
    { $variant: 'Vec3', value: { X: 1, Y: 2.5, Z: -3 } },
    { $variant: 'str', value: 'hello' },
  ];
  for (const value of cases) {
    const bytes = schema.encode('Holder', { Value: value });
    expect(schema.decode(bytes, 'Holder'), value.$variant).toEqual({
      Value: value,
    });
  }
  // tags are member-list positions: str is member 6
  const bytes = schema.encode('Holder', {
    Value: { $variant: 'str', value: 'x' },
  });
  expect(Array.from(bytes)).toEqual([6, 0xa1, 0x78]);
});

test('decode guards against a self-referential struct cycle', () => {
  const schema = BrdbSchema.fromData({
    enums: {},
    variants: {},
    structs: {
      Cyclic: { Next: 'Cyclic' },
    },
  });
  expect(() => schema.decode(new Uint8Array(0), 'Cyclic')).toThrow(
    /schema recursion too deep/
  );
});

test('legacy wire_graph_variant uses fixed tags', () => {
  const schema = BrdbSchema.fromText(`
    struct Holder {
      Value: wire_graph_variant,
      Math: wire_graph_prim_math_variant,
    }
  `);
  const bytes = schema.encode('Holder', {
    Value: { $variant: 'weak_object', value: null },
    Math: { $variant: 'i64', value: 2 },
  });
  // weak_object = tag 3, payload -1 (nfix 0xff); i64 = tag 1, payload 2
  expect(Array.from(bytes)).toEqual([3, 0xff, 1, 2]);
  expect(schema.decode(bytes, 'Holder')).toEqual({
    Value: { $variant: 'weak_object', value: null },
    Math: { $variant: 'i64', value: 2 },
  });
  const exec = schema.encode('Holder', {
    Value: { $variant: 'WireGraphExec', value: null },
    Math: { $variant: 'f64', value: 0.5 },
  });
  expect(Array.from(exec)).toEqual([4, 0, 0xcb, 0x3f, 0xe0, 0, 0, 0, 0, 0, 0]);
});

describe('64-bit fields outside the JS safe-integer range', () => {
  // observed in a real game save: a bitwise logic gate's i64 input constant
  const BIG = 33891734021675012n;
  const schema = BrdbSchema.fromText(`
    struct BigHolder {
      Signed: i64,
      Unsigned: u64,
      SignedFlat: i64[flat],
      UnsignedArr: u64[],
      Wire: wire_graph_variant,
    }
  `);

  test('decode surfaces oversized values as JSON-safe { $bigint } wrappers', () => {
    const bytes = schema.encode('BigHolder', {
      Signed: -BIG,
      Unsigned: 2n ** 64n - 1n,
      SignedFlat: [BIG, 7],
      UnsignedArr: [2n ** 60n, 3],
      Wire: { $variant: 'i64', value: BIG },
    });
    expect(schema.decode(bytes, 'BigHolder')).toEqual({
      Signed: { $bigint: '-33891734021675012' },
      Unsigned: { $bigint: '18446744073709551615' },
      // in-range values stay plain numbers
      SignedFlat: [{ $bigint: '33891734021675012' }, 7],
      UnsignedArr: [{ $bigint: '1152921504606846976' }, 3],
      Wire: { $variant: 'i64', value: { $bigint: '33891734021675012' } },
    });
  });

  test('encode accepts raw bigint and { $bigint } wrappers identically', () => {
    const fromBigints = schema.encode('BigHolder', {
      Signed: BIG,
      Unsigned: BIG,
      SignedFlat: [-BIG],
      UnsignedArr: [BIG],
      Wire: { $variant: 'i64', value: -BIG },
    });
    const fromWrappers = schema.encode('BigHolder', {
      Signed: { $bigint: BIG.toString() },
      Unsigned: { $bigint: BIG.toString() },
      SignedFlat: [{ $bigint: (-BIG).toString() }],
      UnsignedArr: [{ $bigint: BIG.toString() }],
      Wire: { $variant: 'i64', value: { $bigint: (-BIG).toString() } },
    });
    expect(Array.from(fromWrappers)).toEqual(Array.from(fromBigints));
  });

  test('decode -> JSON round-trip -> encode is byte-identical', () => {
    const bytes = schema.encode('BigHolder', {
      Signed: BIG,
      Unsigned: BIG,
      SignedFlat: [-BIG],
      UnsignedArr: [BIG],
      Wire: { $variant: 'i64', value: -BIG },
    });
    // the wrapper's whole point: decoded values survive JSON serialization
    const jsonned = JSON.parse(
      JSON.stringify(schema.decode(bytes, 'BigHolder'))
    );
    expect(Array.from(schema.encode('BigHolder', jsonned))).toEqual(
      Array.from(bytes)
    );
  });

  test('in-range values decode as plain numbers everywhere', () => {
    const bytes = schema.encode('BigHolder', {
      Signed: -12,
      Unsigned: 4294967296,
      SignedFlat: [1, -2],
      UnsignedArr: [3],
      Wire: { $variant: 'i64', value: 42 },
    });
    expect(schema.decode(bytes, 'BigHolder')).toEqual({
      Signed: -12,
      Unsigned: 4294967296,
      SignedFlat: [1, -2],
      UnsignedArr: [3],
      Wire: { $variant: 'i64', value: 42 },
    });
  });
});
