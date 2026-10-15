import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { COMPONENT_TYPE_STRUCTS } from '../../src/brdb/componentDb';
import { PROCEDURAL_GATES } from '../../src/brdb/gateVariants';
import {
  conformStruct,
  fieldAliases,
  migrateBrickAsset,
  migrateBrickColumns,
  migrateComponentType,
  migrateValue,
  MigrationStep,
  needsMigration,
  openLatest,
  renameTable,
  stepDetects,
} from '../../src/brdb/migrate';
import { MIGRATION_STEPS } from '../../src/brdb/migrations';
import { WorldReader } from '../../src/brdb/reader';
import { BrdbSchema, BrdbValue, embeddedSchema } from '../../src/brdb/schema';
import { writeBrzLegacy } from '../../src/brdb/world';

/** Two synthetic steps: `old` renames types by prefix and bricks, `new`
 * renames one of the results again and renames a field of its data. */
const CHAINED_STEPS: MigrationStep[] = [
  {
    name: 'old',
    description: '',
    detect: { componentSchemaFormat: 'EA3' },
    componentTypes: { prefixes: [['Old_', 'Mid_']] },
    bricks: {
      renames: { B_A: 'B_B' },
      toGate: { B_Gate: 'PB_Gate_QueueTicks' },
    },
  },
  {
    name: 'new',
    description: '',
    detect: { componentSchemaHasStruct: 'OnlyBeforeNew' },
    componentTypes: { renames: { Mid_Thing: 'New_Thing' } },
    bricks: { renames: { B_B: 'B_C' } },
    fields: [
      { component: 'New_Thing', from: 'Value', to: 'Amount' },
      { component: 'New_Thing', from: 'Amount', to: 'Total' },
    ],
  },
];

describe('migration steps', () => {
  test('the shared steps start with ea3 and name real targets', () => {
    expect(MIGRATION_STEPS[0].name).toBe('ea3');
    for (const step of MIGRATION_STEPS) {
      for (const to of Object.values(step.componentTypes?.renames ?? {}))
        expect(COMPONENT_TYPE_STRUCTS.has(to), to).toBe(true);
      for (const to of Object.values(step.bricks?.toGate ?? {}))
        expect(PROCEDURAL_GATES.has(to), to).toBe(true);
    }
  });

  test('steps chain renames', () => {
    expect(migrateComponentType('Old_Thing', CHAINED_STEPS)).toBe('New_Thing');
    expect(migrateComponentType('Old_Other', CHAINED_STEPS)).toBe('Mid_Other');
    // A save from between the steps only runs the second one.
    expect(migrateComponentType('Mid_Thing', CHAINED_STEPS.slice(1))).toBe(
      'New_Thing'
    );
    expect(migrateBrickAsset('B_A', CHAINED_STEPS)).toEqual({
      kind: 'basic',
      asset: 'B_C',
    });
    expect(migrateBrickAsset('B_Gate', CHAINED_STEPS)?.asset).toBe(
      'PB_Gate_QueueTicks'
    );
    expect(migrateBrickAsset('B_Other', CHAINED_STEPS)).toBeUndefined();
    // Field renames compose: Total <- Amount <- Value.
    expect(fieldAliases('Old_Thing', CHAINED_STEPS)).toEqual(
      new Map([['Total', 'Value']])
    );
    expect(fieldAliases('Old_Other', CHAINED_STEPS).size).toBe(0);
  });

  test('steps detect saves by container and struct', () => {
    const readBack = (text: string, format: 'EA3' | 'Latest') =>
      BrdbSchema.fromBinary(BrdbSchema.fromText(text).toBinary(format));
    const ea3 = readBack('struct S { A: i64 }', 'EA3');
    expect(stepDetects(CHAINED_STEPS[0], ea3)).toBe(true);
    expect(stepDetects(CHAINED_STEPS[1], ea3)).toBe(false);
    const between = readBack('struct OnlyBeforeNew { A: i64 }', 'Latest');
    expect(stepDetects(CHAINED_STEPS[0], between)).toBe(false);
    expect(stepDetects(CHAINED_STEPS[1], between)).toBe(true);
  });
});

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );

/** A small EA3 component schema with every reshaped wire graph form. */
const EA3_SCHEMA = `
  enum EBrickAxis { EBrickAxis::X = 0, EBrickAxis::Y = 1, EBrickAxis::Z = 2 }
  variant WireGraphEnumVariant { EBrickAxis }
  struct WireGraphEnumWrapper { Enum: WireGraphEnumVariant }
  variant WireGraphVariant { f64, i64, bool, WireGraphEnumWrapper }
  struct WireGraphDoubleArray { Values: f64[] }
  struct WireGraphStringArray { Values: str[] }
  variant WireGraphArrayVariant { WireGraphDoubleArray, WireGraphStringArray }
  struct WireGraphMap_int64_double { Values: {i64: f64} }
  variant WireGraphMapVariant_int64 { WireGraphMap_int64_double }
  struct WireGraphMapKeyWrapper_int64 { Map: WireGraphMapVariant_int64 }
  variant WireGraphMapVariant { WireGraphMapKeyWrapper_int64 }
  struct BrickComponentData_WireGraphPseudo_Var { Value: WireGraphVariant }
  struct BrickComponentData_WireGraphPseudo_ArrayVar { Value: WireGraphArrayVariant }
  struct BrickComponentData_WireGraphPseudo_MapVar { Value: WireGraphMapVariant }
`;

/** Encode `value` as EA3 `ea3Ty`, decode it, migrate it, encode it as Latest
 * `latestTy` and decode the result. */
function migrateThrough(ea3Ty: string, value: BrdbValue, latestTy: string) {
  const ea3 = BrdbSchema.fromText(EA3_SCHEMA);
  ea3.setFormat('EA3');
  const decoded = ea3.decode(ea3.encode(ea3Ty, value), ea3Ty);
  const latest = embeddedSchema('BRSavedComponentChunkSoA_max');
  return latest.decode(
    latest.encode(latestTy, migrateValue(decoded)),
    latestTy
  ) as Record<string, BrdbValue>;
}

describe('migration names', () => {
  test('component types follow the prefix rule and exceptions', () => {
    expect(
      migrateComponentType('BrickComponentType_WireGraph_Expr_LogicalAND')
    ).toBe('BrickComponentType_Expr_LogicalAND');
    expect(
      migrateComponentType('BrickComponentType_WireGraphPseudo_BufferTicks')
    ).toBe('BrickComponentType_BufferTicks');
    expect(
      migrateComponentType('BrickComponentType_WireGraphPseudo_Timer')
    ).toBe('BrickComponentType_Stopwatch');
    expect(
      migrateComponentType(
        'BrickComponentType_WireGraph_Fake_Gamemode_RoundEndEvent'
      )
    ).toBe('BrickComponentType_Event_Gamemode_RoundEnd');
    expect(migrateComponentType('Component_Internal_Seat')).toBe(
      'Component_Internal_Seat'
    );
  });

  test('every renamed component type is a current component type', () => {
    for (const name of [
      'BrickComponentType_Internal_AerodynamicSurface',
      'BrickComponentType_WireGraphPseudo_CustomEvent_Global',
      'BrickComponentType_WireGraph_Exec_WholeGridTargeted',
      'BrickComponentType_WireGraph_ServerUptime',
    ])
      expect(COMPONENT_TYPE_STRUCTS.has(migrateComponentType(name))).toBe(true);
  });

  test('removed gate bricks become their largest procedural gate', () => {
    expect(migrateBrickAsset('B_1x1_Gate_Pseudo_QueueTicks')).toEqual({
      kind: 'procedural',
      asset: 'PB_Gate_QueueTicks',
      size: { x: 10, y: 5, z: 2 },
    });
    expect(migrateBrickAsset('B_1x1_Gate_Pseudo_Timer')).toEqual({
      kind: 'basic',
      asset: 'B_1x1_Gate_Stopwatch',
    });
    expect(migrateBrickAsset('PB_DefaultBrick')).toBeUndefined();
    for (const name of [
      'B_1x1_Gate_FunctionCall',
      'B_1x1_Gate_Pseudo_SendCustomEvent_Global',
      'B_1x1_Gate_Exec_ArrayVar_SortMultiple',
    ]) {
      const to = migrateBrickAsset(name);
      expect(to?.kind).toBe('procedural');
      expect(PROCEDURAL_GATES.has(to!.asset)).toBe(true);
    }
  });
});

describe('migrateValue', () => {
  test('wire graph arrays become dynamic arrays', () => {
    const out = migrateThrough(
      'BrickComponentData_WireGraphPseudo_ArrayVar',
      {
        Value: {
          $variant: 'WireGraphDoubleArray',
          value: { Values: [1.5, -2] },
        },
      },
      'BrickComponentData_ArrayVar'
    );
    expect(out.Value).toEqual({ $elementType: 'f64', $array: [1.5, -2] });
  });

  test('empty string arrays keep their element type', () => {
    const out = migrateThrough(
      'BrickComponentData_WireGraphPseudo_ArrayVar',
      { Value: { $variant: 'WireGraphStringArray', value: { Values: [] } } },
      'BrickComponentData_ArrayVar'
    );
    expect(out.Value).toEqual({ $elementType: 'str', $array: [] });
  });

  test('wire graph maps become dynamic maps', () => {
    const out = migrateThrough(
      'BrickComponentData_WireGraphPseudo_MapVar',
      {
        Value: {
          $variant: 'WireGraphMapKeyWrapper_int64',
          value: {
            Map: {
              $variant: 'WireGraphMap_int64_double',
              value: { Values: { $map: [[7, 0.25]] } },
            },
          },
        },
      } as unknown as BrdbValue,
      'BrickComponentData_MapVar'
    );
    expect(out.Value).toEqual({
      $keyType: 'i64',
      $valueType: 'f64',
      $map: [[7, 0.25]],
    });
  });

  test('wrapped enums become dynamic enums', () => {
    const out = migrateThrough(
      'BrickComponentData_WireGraphPseudo_Var',
      {
        Value: {
          $variant: 'WireGraphEnumWrapper',
          value: { Enum: { $variant: 'EBrickAxis', value: 2 } },
        },
      },
      'BrickComponentData_Var'
    );
    expect(out.Value).toEqual({
      $variant: 'dynamic_enum',
      value: { $enum: 'EBrickAxis', value: 2 },
    });
  });

  test('plain wire values pass through', () => {
    const out = migrateThrough(
      'BrickComponentData_WireGraphPseudo_Var',
      { Value: { $variant: 'i64', value: -9 } },
      'BrickComponentData_Var'
    );
    expect(out.Value).toEqual({ $variant: 'i64', value: -9 });
  });
});

describe.skipIf(!hasFixtures)('openLatest', () => {
  test('a world already in the current format reads the same', () => {
    const original = WorldReader.from(fixture('components_latest_raw.brz'));
    const latest = openLatest(original);
    expect(latest.globalData()).toEqual(original.globalData());
    for (const gid of original.gridIds())
      for (const ref of original.brickChunkIndex(gid))
        if (ref.numComponents > 0)
          expect(latest.componentChunk(gid, ref.index)).toEqual(
            original.componentChunk(gid, ref.index)
          );
  });
});

describe('needsMigration', () => {
  const save = {
    bricks: [{ size: [5, 5, 6], position: [0, 0, 6], color: [255, 0, 0] }],
  } as const;

  test('a world brs-js writes without components is current', () => {
    const reader = WorldReader.from(writeBrzLegacy(save as any));
    expect(needsMigration(reader)).toBe(false);
  });

  test("'Auto' keeps the EA3 container, which reads as EA3", () => {
    const reader = WorldReader.from(
      writeBrzLegacy(save as any, { schemaFormat: 'Auto' })
    );
    expect(needsMigration(reader)).toBe(true);
  });
});

describe('renameTable', () => {
  const rename = (map: Record<string, string>) => (n: string) => map[n];

  test('renames in place, keeping indices', () => {
    expect(renameTable(['A', 'B', 'C'], rename({ B: 'X' }))).toEqual({
      names: ['A', 'X', 'C'],
      remap: new Map(),
    });
  });

  test('a new name the table already has remaps to its entry', () => {
    const { names, remap } = renameTable(['P', 'U'], rename({ P: 'U' }));
    expect(names).toEqual(['P', 'U']);
    expect(remap).toEqual(new Map([[0, 1]]));
  });

  test('two entries renamed to one new name share the first', () => {
    const { names, remap } = renameTable(
      ['A', 'B', 'C'],
      rename({ A: 'X', C: 'X' })
    );
    expect(names).toEqual(['X', 'B', 'C']);
    expect(remap).toEqual(new Map([[2, 0]]));
  });

  test('chained renames keep every name unique', () => {
    expect(renameTable(['A', 'B'], rename({ A: 'B', B: 'C' })).names).toEqual([
      'B',
      'C',
    ]);
  });

  test('a duplicate name throws', () => {
    // C stays (remapped onto X's entry) while D is renamed to C.
    expect(() =>
      renameTable(['A', 'C', 'D'], rename({ A: 'X', C: 'X', D: 'C' }))
    ).toThrow(/two table entries to C/);
  });
});

describe('migrateBrickColumns', () => {
  const size = (X: number, Y: number, Z: number) => ({ X, Y, Z });
  const gate = { asset: 7, size: size(10, 5, 2) };

  test('a new procedural asset starts a run after the counted slots', () => {
    // Two basic assets (start 2); one procedural slot, plus an unreferenced
    // trailing size.
    const types = [0, 2, 1];
    const counters = [{ AssetIndex: 3, NumSizes: 1 }];
    const sizes = [size(1, 1, 1), size(9, 9, 9)];
    const changed = migrateBrickColumns(
      2,
      types,
      counters,
      sizes,
      new Map(),
      new Map(),
      new Map([[0, gate]])
    );
    expect(changed).toBe(true);
    expect(types).toEqual([3, 2, 1]);
    expect(counters).toEqual([
      { AssetIndex: 3, NumSizes: 1 },
      { AssetIndex: 7, NumSizes: 1 },
    ]);
    expect(sizes).toEqual([size(1, 1, 1), gate.size, size(9, 9, 9)]);
  });

  test('an asset the chunk has extends its run and shifts later slots', () => {
    const types = [0, 2, 3];
    const counters = [
      { AssetIndex: 7, NumSizes: 1 },
      { AssetIndex: 3, NumSizes: 1 },
    ];
    const sizes = [size(4, 4, 4), size(1, 1, 1)];
    migrateBrickColumns(
      2,
      types,
      counters,
      sizes,
      new Map(),
      new Map(),
      new Map([[0, gate]])
    );
    expect(counters).toEqual([
      { AssetIndex: 7, NumSizes: 2 },
      { AssetIndex: 3, NumSizes: 1 },
    ]);
    expect(sizes).toEqual([size(4, 4, 4), gate.size, size(1, 1, 1)]);
    // the new brick at slot 1; the old slot 1 (asset 3) moved to slot 2
    expect(types).toEqual([3, 2, 4]);
  });

  test('an existing (asset, size) slot is reused', () => {
    const types = [0, 0, 2];
    const counters = [{ AssetIndex: 7, NumSizes: 1 }];
    const sizes = [gate.size];
    migrateBrickColumns(
      2,
      types,
      counters,
      sizes,
      new Map(),
      new Map(),
      new Map([[0, gate]])
    );
    expect(types).toEqual([2, 2, 2]);
    expect(counters).toEqual([{ AssetIndex: 7, NumSizes: 1 }]);
    expect(sizes).toEqual([gate.size]);
  });

  test('counters past the size table throw', () => {
    expect(() =>
      migrateBrickColumns(
        0,
        [],
        [{ AssetIndex: 0, NumSizes: 2 }],
        [size(1, 1, 1)],
        new Map(),
        new Map(),
        new Map()
      )
    ).toThrow(/cover 2 slots/);
  });
});

describe('conformStruct', () => {
  const oldSchema = BrdbSchema.fromText(`
enum EColor {
    EColor::Red = 0,
    EColor::Blue = 1,
}
struct InnerOld {
    Mode: EColor,
    Gone: bool,
}
struct DataOld {
    Inner: InnerOld,
    Items: InnerOld[],
    Kept: f64,
    Removed: str,
}
`);
  const schema = BrdbSchema.fromText(`
enum EColor {
    EColor::Red = 0,
    EColor::Blue = 1,
}
struct Inner {
    Mode: dynamic_enum,
    Added: i32,
}
struct Data {
    Inner: Inner,
    Items: Inner[],
    Kept: f64,
}
types {
    EColor,
}
`);

  test('drops removed fields, fills new ones and tags nested enums', () => {
    const data = conformStruct(schema, oldSchema, 'DataOld', 'Data', {
      Inner: { Mode: 1, Gone: true },
      Items: [{ Mode: 0, Gone: false }],
      Kept: 2.5,
      Removed: 'x',
    });
    expect(data).toEqual({
      Inner: { Mode: { $enum: 'EColor', value: 1 }, Added: 0 },
      Items: [{ Mode: { $enum: 'EColor', value: 0 }, Added: 0 }],
      Kept: 2.5,
    });
    expect(() => schema.encode('Data', data)).not.toThrow();
  });
});
