// Differential tests for the plan-cached writer (src/brdb/writePlan.ts).
//
// The whole point of the plan cache is that it emits EXACTLY what the generic
// BrdbSchema writer emits, so every test here compares the two byte for byte
// on the same input. BrdbSchema.writeValue / fillStruct are deliberately left
// unoptimized so they stay an independent oracle.
import { describe, expect, test } from 'vitest';
import { ByteWriter } from '../../src/brdb/bytes';
import { COMPONENT_STRUCT_DEFAULTS } from '../../src/brdb/componentDb';
import {
  BrdbSchema,
  BrdbValue,
  embeddedSchema,
  PropDesc,
} from '../../src/brdb/schema';
import { EmbeddedSchemaName, SCHEMAS } from '../../src/brdb/schemas';
import { WritePlanner } from '../../src/brdb/writePlan';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Bytes, or the error message when the writer rejects the value. Both
 * outcomes have to agree between the two paths, and a handful of generated
 * component defaults do legitimately throw in both (an incomplete nested
 * struct default, e.g. BRInventoryEntryWeaponAmmoOverride.Resources). */
const outcome = (run: () => Uint8Array): string => {
  try {
    return hex(run());
  } catch (e) {
    return `throws: ${(e as Error).message}`;
  }
};

/** What the generic path produces for a partially-set struct: materialize the
 * whole value with fillStruct, then walk it with writeValue. */
const genericPartial = (
  schema: BrdbSchema,
  structName: string,
  partial: Record<string, BrdbValue>,
  defaults?: Readonly<Record<string, BrdbValue>>
) =>
  outcome(() => {
    const w = new ByteWriter();
    schema.writeValue(
      w,
      structName,
      schema.fillStruct(structName, partial, defaults)
    );
    return w.toBytes();
  });

const plannedPartial = (
  planner: WritePlanner,
  structName: string,
  partial: Record<string, BrdbValue>
) =>
  outcome(() => {
    const w = new ByteWriter();
    planner.writePartialStruct(w, structName, partial);
    return w.toBytes();
  });

/** A legal value for one struct property, used to exercise the "field is set"
 * side of every field (the value itself is irrelevant; both writers see it). */
const sampleProp = (schema: BrdbSchema, prop: PropDesc): BrdbValue =>
  prop.kind === 'type'
    ? schema.zeroValue(prop.type)
    : prop.kind === 'map'
    ? ({ $map: [] } as unknown as BrdbValue)
    : [];

/** Every struct in a schema, with a zero value that satisfies writeValue. */
const eachStruct = (schema: BrdbSchema) =>
  [...schema.structs.keys()].map(
    name => [name, schema.zeroValue(name)] as const
  );

describe('plan cache matches the generic writer for every embedded schema', () => {
  const all: [string, () => BrdbSchema][] = [
    ...(Object.keys(SCHEMAS) as EmbeddedSchemaName[]).map(
      n => [n, () => embeddedSchema(n)] as [string, () => BrdbSchema]
    ),
  ];
  for (const [name, load] of all) {
    test(name, () => {
      const schema = load();
      const planner = new WritePlanner(schema);
      let compared = 0;
      for (const [ty, zero] of eachStruct(schema)) {
        expect(hex(planner.encode(ty, zero)), ty).toBe(
          hex(schema.encode(ty, zero))
        );
        compared += 1;
      }
      expect(compared).toBeGreaterThan(0);
    });
  }
});

// The component data structs are where the plan cache does the most work:
// whole-struct defaults are precomputed and replayed for a component with
// nothing set, and per-field defaults fill the gaps for a partially set one.
describe.each([
  {
    label: 'current',
    schema: () => embeddedSchema('BRSavedComponentChunkSoA_max'),
    DEFAULTS: COMPONENT_STRUCT_DEFAULTS,
  },
])(
  'plan cache matches fillStruct + writeValue for $label component data',
  ({ schema: load, DEFAULTS: COMPONENT_STRUCT_DEFAULTS }) => {
    const schema = load();
    const planner = new WritePlanner(schema, n =>
      COMPONENT_STRUCT_DEFAULTS.get(n)
    );
    const structNames = [...schema.structs.keys()].filter(
      n =>
        n.startsWith('BrickComponentData_') ||
        n.startsWith('BCSComponentVertex_')
    );

    test('the catalog is actually being swept', () => {
      expect(structNames.length).toBeGreaterThan(200);
    });

    test('nothing set (the all-default fast path)', () => {
      for (const ty of structNames) {
        const defaults = COMPONENT_STRUCT_DEFAULTS.get(ty);
        expect(plannedPartial(planner, ty, {}), ty).toBe(
          genericPartial(schema, ty, {}, defaults)
        );
      }
    });

    test('every field set (no default bytes used)', () => {
      for (const ty of structNames) {
        const defaults = COMPONENT_STRUCT_DEFAULTS.get(ty);
        const partial: Record<string, BrdbValue> = {};
        for (const [field, prop] of schema.structs.get(ty))
          partial[field] = sampleProp(schema, prop);
        expect(plannedPartial(planner, ty, partial), ty).toBe(
          genericPartial(schema, ty, partial, defaults)
        );
      }
    });

    test('every other field set (default bytes interleaved with set fields)', () => {
      for (const ty of structNames) {
        const defaults = COMPONENT_STRUCT_DEFAULTS.get(ty);
        const partial: Record<string, BrdbValue> = {};
        let i = 0;
        for (const [field, prop] of schema.structs.get(ty))
          if (i++ % 2 === 0) partial[field] = sampleProp(schema, prop);
        expect(plannedPartial(planner, ty, partial), ty).toBe(
          genericPartial(schema, ty, partial, defaults)
        );
      }
    });

    test('the defaults table is what makes those bytes non-trivial', () => {
      // If COMPONENT_STRUCT_DEFAULTS were empty, every all-default run would
      // be zeros and the comparisons above would prove far less.
      const withDefaults = structNames.filter(n =>
        COMPONENT_STRUCT_DEFAULTS.has(n)
      );
      expect(withDefaults.length).toBeGreaterThan(100);
      // Many defaults differ from the zero value (so the default bytes matter).
      const differing = withDefaults.filter(
        ty =>
          plannedPartial(planner, ty, {}) !==
          genericPartial(schema, ty, {}, undefined)
      );
      expect(differing.length).toBeGreaterThan(20);
    });
  }
);

describe('plan cache matches the generic writer for exotic shapes', () => {
  // Hand-built schema covering the shapes the embedded ones do not: named
  // variants (including a weak_object member), enums, maps with struct keys,
  // nested and self-referencing structs, and flat arrays of structs.
  const schema = BrdbSchema.fromData({
    enums: { Mode: { Off: 0, On: 1, Auto: 2 } },
    variants: { Choice: ['f64', 'i64', 'bool', 'weak_object', 'str', 'Vec3'] },
    structs: {
      Vec3: { X: 'f32', Y: 'f32', Z: 'f32' },
      Flat3: { X: 'i16', Y: 'i16', Z: 'i16' },
      Node: { Name: 'str', Children: ['Node'] },
      All: {
        Flag: 'bool',
        Byte: 'u8',
        Small: 'u16',
        Big: 'u64',
        Signed: 'i64',
        Single: 'f32',
        Double: 'f64',
        Text: 'str',
        Path: 'bundle_path_ref',
        Asset: 'object',
        Weak: 'weak_object',
        Which: 'Mode',
        Pick: 'Choice',
        Legacy: 'wire_graph_variant',
        LegacyMath: 'wire_graph_prim_math_variant',
        Point: 'Vec3',
        Points: ['Vec3'],
        Packed: ['Flat3', null],
        Bytes: ['u8', null],
        Longs: ['i64', null],
        Lookup: { str: 'Vec3' },
        StructKeys: { Flat3: 'u32' },
        Tree: 'Node',
      },
    },
  });
  const planner = new WritePlanner(schema);

  const value = (over: Record<string, BrdbValue> = {}) => ({
    ...(schema.zeroValue('All') as Record<string, BrdbValue>),
    ...over,
  });

  const same = (v: BrdbValue, label: string) =>
    expect(hex(planner.encode('All', v)), label).toBe(
      hex(schema.encode('All', v))
    );

  test('zero value', () => same(value(), 'zero'));

  test('populated value', () =>
    same(
      value({
        Flag: true,
        Byte: 200,
        Small: 70000,
        Big: { $bigint: '18446744073709551615' },
        Signed: -5,
        Single: 1.5,
        Double: -2.25,
        Text: 'hello',
        Path: 'Bundles/Thing',
        Asset: 3,
        Weak: 4,
        Which: 2,
        Pick: { $variant: 'str', value: 'tagged' },
        Legacy: { $variant: 'bool', value: true },
        LegacyMath: { $variant: 'i64', value: 12 },
        Point: { X: 1, Y: 2, Z: 3 },
        Points: [
          { X: 0.5, Y: 0, Z: 0 },
          { X: 1, Y: 1, Z: 1 },
        ],
        Packed: [
          { X: -1, Y: 2, Z: -3 },
          { X: 4, Y: 5, Z: 6 },
        ],
        Bytes: [1, 2, 3, 254],
        Longs: [1, -2, { $bigint: '9007199254740993' }],
        Lookup: {
          $map: [
            ['a', { X: 1, Y: 0, Z: 0 }],
            ['b', { X: 0, Y: 1, Z: 0 }],
          ],
        } as unknown as BrdbValue,
        StructKeys: {
          $map: [[{ X: 1, Y: 2, Z: 3 }, 7]],
        } as unknown as BrdbValue,
        Tree: {
          Name: 'root',
          Children: [{ Name: 'leaf', Children: [] }],
        },
      }),
      'populated'
    ));

  for (const member of ['f64', 'i64', 'bool', 'weak_object', 'str', 'Vec3'])
    test(`variant member ${member}`, () => {
      // 200 and 70000 are chosen so the signed and unsigned encoders differ:
      // a weak_object payload inside a variant is written SIGNED even when
      // set, unlike a schema-typed asset field. Small values would hide that.
      const payload =
        member === 'weak_object'
          ? [null, 9, 200, 70000]
          : member === 'Vec3'
          ? [{ X: 1, Y: 2, Z: 3 }]
          : member === 'str'
          ? ['x']
          : member === 'bool'
          ? [true, false]
          : [7, 200, 70000];
      for (const v of payload)
        same(
          value({ Pick: { $variant: member, value: v as BrdbValue } }),
          `${member}=${JSON.stringify(v)}`
        );
    });

  test('self-referencing struct nests through the deferred op', () =>
    same(
      value({
        Tree: {
          Name: 'a',
          Children: [
            { Name: 'b', Children: [{ Name: 'c', Children: [] }] },
            { Name: 'd', Children: [] },
          ],
        },
      }),
      'tree'
    ));
});

describe('plan cache reproduces the generic writer errors', () => {
  const schema = BrdbSchema.fromData({
    enums: { Mode: { Off: 0, On: 1 } },
    variants: { Choice: ['f64', 'bool'] },
    structs: {
      Vec3: { X: 'f32', Y: 'f32', Z: 'f32' },
      Bad: { Items: ['Missing', null] },
      Holder: {
        Which: 'Mode',
        Pick: 'Choice',
        Point: 'Vec3',
        Lookup: { str: 'u32' },
      },
    },
  });
  const planner = new WritePlanner(schema);

  const both = (ty: string, v: BrdbValue) => {
    let generic: string | null = null;
    let planned: string | null = null;
    try {
      schema.encode(ty, v);
    } catch (e) {
      generic = (e as Error).message;
    }
    try {
      planner.encode(ty, v);
    } catch (e) {
      planned = (e as Error).message;
    }
    expect(generic).not.toBeNull();
    expect(planned).toBe(generic);
  };

  const base = () => schema.zeroValue('Holder') as Record<string, BrdbValue>;

  test('missing nested struct field', () =>
    both('Holder', { ...base(), Point: { X: 1, Y: 2 } }));
  test('enum ordinal out of bounds', () =>
    both('Holder', { ...base(), Which: 5 }));
  test('unknown variant member', () =>
    both('Holder', {
      ...base(),
      Pick: { $variant: 'nope', value: 1 } as unknown as BrdbValue,
    }));
  test('variant without a wrapper', () =>
    both('Holder', { ...base(), Pick: 1 }));
  test('map without $map', () => both('Holder', { ...base(), Lookup: [] }));
  test('invalid flat type', () => both('Bad', { Items: [] }));
  test('unknown type', () => both('Nope', 0));

  test('writePartialStruct rejects unknown fields like fillStruct', () => {
    const bad = { Nope: 1 } as Record<string, BrdbValue>;
    expect(() => schema.fillStruct('Holder', bad)).toThrow(
      "brdb: Holder has no field 'Nope'"
    );
    expect(() =>
      planner.writePartialStruct(new ByteWriter(), 'Holder', bad)
    ).toThrow("brdb: Holder has no field 'Nope'");
  });

  test('writePartialStruct rejects an unknown struct like fillStruct', () => {
    expect(() => schema.fillStruct('Nope', {})).toThrow(
      'brdb: unknown struct Nope'
    );
    expect(() =>
      planner.writePartialStruct(new ByteWriter(), 'Nope', {})
    ).toThrow('brdb: unknown struct Nope');
  });
});
