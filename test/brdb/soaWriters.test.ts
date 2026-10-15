// Differential tests for the hand-encoded chunk writers and the plan-cached
// component/entity writers, exercised through the REAL write pipeline.
//
// setFastPaths(false) routes saveToPendingFs back through BrdbSchema's generic
// writer without changing anything else, so writing the same world twice and
// comparing the archives byte for byte compares the fast paths against the
// schema walk they have to reproduce. A silent fallback would make that
// comparison the generic writer against itself, so the shape predicates are
// asserted live first.
import { describe, expect, test } from 'vitest';
import {
  BASIC_BRICK_ASSETS,
  PROCEDURAL_BRICK_ASSETS,
} from '../../src/brdb/catalog';
import {
  COMPONENT_STRUCT_DEFAULTS,
  COMPONENT_TYPE_STRUCTS,
  COMPONENTS,
} from '../../src/brdb/componentDb';
import { setFastPaths } from '../../src/brdb/fastPaths';
import { WorldReader } from '../../src/brdb/reader';
import { BrdbSchema, embeddedSchema } from '../../src/brdb/schema';
import { SchemaSource, SCHEMAS } from '../../src/brdb/schemas';
import {
  brickChunkSchemaIsStandard,
  wireChunkSchemaIsStandard,
} from '../../src/brdb/soaWriters';
import { World, writeBrzLegacy } from '../../src/brdb/world';
import { chunksSave, exampleBrickSave, featuresSave } from './fixtures';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const brickSchema = embeddedSchema('BRSavedBrickChunkSoA');
const wireSchema = embeddedSchema('BRSavedWireChunkSoA');

/** A clone of an embedded schema source with one struct property replaced. */
const mutated = (
  source: SchemaSource,
  struct: string,
  edit: (props: Record<string, unknown>) => Record<string, unknown>
) => {
  const clone = JSON.parse(JSON.stringify(source)) as SchemaSource;
  (clone.structs as Record<string, unknown>)[struct] = edit({
    ...(clone.structs[struct] as Record<string, unknown>),
  });
  return BrdbSchema.fromData(clone);
};

describe('chunk shape predicates', () => {
  test('the embedded schemas are recognized (the fast paths are live)', () => {
    expect(brickChunkSchemaIsStandard(brickSchema)).toBe(true);
    expect(wireChunkSchemaIsStandard(wireSchema)).toBe(true);
  });

  test('an unrelated schema is rejected', () => {
    const owners = embeddedSchema('BRSavedOwnerTableSoA');
    expect(brickChunkSchemaIsStandard(owners)).toBe(false);
    expect(wireChunkSchemaIsStandard(owners)).toBe(false);
    expect(brickChunkSchemaIsStandard(wireSchema)).toBe(false);
    expect(wireChunkSchemaIsStandard(brickSchema)).toBe(false);
  });

  test('a changed field type is rejected', () => {
    const s = mutated(
      SCHEMAS.BRSavedBrickChunkSoA,
      'BRSavedBrickChunkSoA',
      p => ({ ...p, BrickTypeIndices: ['u16'] })
    );
    expect(brickChunkSchemaIsStandard(s)).toBe(false);
  });

  test('a renamed field is rejected', () => {
    const s = mutated(SCHEMAS.BRSavedWireChunkSoA, 'BRSavedWireChunkSoA', p => {
      const { LocalWireSources, ...rest } = p;
      return { ...rest, LocalSources: LocalWireSources };
    });
    expect(wireChunkSchemaIsStandard(s)).toBe(false);
  });

  test('an added field is rejected', () => {
    const s = mutated(
      SCHEMAS.BRSavedBrickChunkSoA,
      'BRSavedBrickChunkSoA',
      p => ({ ...p, NewColumn: 'u32' })
    );
    expect(brickChunkSchemaIsStandard(s)).toBe(false);
  });

  test('a reordered field list is rejected', () => {
    const s = mutated(SCHEMAS.BRSavedWireChunkSoA, 'BRSavedWireChunkSoA', p => {
      const entries = Object.entries(p);
      [entries[0], entries[1]] = [entries[1], entries[0]];
      return Object.fromEntries(entries);
    });
    expect(wireChunkSchemaIsStandard(s)).toBe(false);
  });

  test('a changed nested struct is rejected', () => {
    const s = mutated(SCHEMAS.BRSavedBrickChunkSoA, 'BRSavedBrickColor', p => ({
      ...p,
      A: 'u16',
    }));
    expect(brickChunkSchemaIsStandard(s)).toBe(false);
  });

  test('a flat array turned into a plain array is rejected', () => {
    const s = mutated(SCHEMAS.BRSavedBrickChunkSoA, 'BRSavedBitFlags', () => ({
      Flags: ['u8'],
    }));
    expect(brickChunkSchemaIsStandard(s)).toBe(false);
    expect(
      wireChunkSchemaIsStandard(
        mutated(SCHEMAS.BRSavedWireChunkSoA, 'BRSavedBitFlags', () => ({
          Flags: ['u8'],
        }))
      )
    ).toBe(false);
  });
});

/** Component types whose generated defaults encode cleanly. A few carry an
 * incomplete nested struct default (e.g. BRInventoryEntryWeaponAmmoOverride
 * without Resources) and throw in BOTH writers. */
const usableComponentTypes = (() => {
  const schema = embeddedSchema('BRSavedComponentChunkSoA_max');
  return [...COMPONENT_TYPE_STRUCTS]
    .filter(([, struct]) => {
      if (struct === 'None') return true;
      try {
        schema.encode(
          struct,
          schema.fillStruct(struct, {}, COMPONENT_STRUCT_DEFAULTS.get(struct))
        );
        return true;
      } catch {
        return false;
      }
    })
    .map(([type]) => type);
})();

/** A world touching everything the fast paths encode: several chunks
 * (including negative indices), basic and procedural bricks, every component
 * type in the catalog, interleaved component types that force a regroup,
 * local and remote wires, entities, and a microchip link.
 *
 * Sizes matter as much as shapes here: this format's signed and unsigned
 * msgpack encoders agree for values under 128, so the world deliberately
 * pushes owner, asset, component-type, port and brick indices past that;
 * otherwise swapping mpUint for mpInt on a column would go unnoticed. */
function richWorld(): World {
  const w = new World();
  // >128 owners, so owner columns leave the fixint range.
  const owners = Array.from({ length: 200 }, (_, i) =>
    w.addOwner({ name: `owner${i}`, display_name: `Owner ${i}` })
  );
  const target = COMPONENTS.Target.NAME;
  const { grid } = w.addMicrochip({ position: [0, 0, 2] });
  const input = w.addBrick(
    {
      asset: 'B_1x1_Gate_MicrochipInput',
      position: [0, 0, 2],
      components: [{ type: COMPONENTS.MicrochipInput.NAME, data: {} }],
    },
    grid
  );
  const output = w.addBrick(
    {
      asset: 'B_1x1_Gate_MicrochipOutput',
      position: [20, 0, 2],
      components: [
        { type: COMPONENTS.MicrochipOutput.NAME, data: { PortLabel: 'Out' } },
      ],
    },
    grid
  );
  w.addWire(
    { brick: input, component_type: COMPONENTS.MicrochipInput.NAME, port: 'O' },
    {
      brick: output,
      component_type: COMPONENTS.MicrochipOutput.NAME,
      port: 'I',
    }
  );

  // >128 distinct basic assets ahead of the procedural ones, so brick type
  // indices and ProceduralBrickStartingIndex leave the fixint range too.
  BASIC_BRICK_ASSETS.slice(0, 150).forEach((asset, i) =>
    w.addBrick({
      asset,
      position: [i * 6 - 6000, 0, 2],
      color: [i & 0xff, 0, 0],
      owner_index: owners[i % owners.length],
    })
  );
  // Procedural bricks with sizes past 255, exercising the u16 size column.
  PROCEDURAL_BRICK_ASSETS.slice(0, 6).forEach((asset, i) =>
    w.addBrick({
      asset,
      size: [300 + i, 400 + i, 6],
      position: [-2100, -2100 + i * 20, 6],
      color: [0, i & 0xff, 0],
    })
  );
  // >128 distinct sizes for one procedural asset, inside a single chunk, so
  // that counter's NumSizes leaves the fixint range. (Its AssetIndex cannot:
  // the procedural catalog is far shorter than 128 entries.)
  for (let i = 0; i < 130; i++)
    w.addBrick({
      asset: 'PB_DefaultBrick',
      size: [4 + i, 4, 6],
      position: [4200 + i * 6, 0, 6],
      color: [0, 0, i & 0xff],
    });

  // One brick per component type, all in a single chunk so the last brick
  // indices (and the wires that reference them) run past 128.
  const handles = usableComponentTypes.map((type, i) =>
    w.addBrick({
      asset: i % 3 === 0 ? 'PB_DefaultTile' : 'PB_DefaultBrick',
      size: [5, 5, 6],
      position: [i * 6, 30, 6],
      color: [i & 0xff, (i * 7) & 0xff, (i * 31) & 0xff],
      material: i % 2 ? 'BMC_Metallic' : 'BMC_Plastic',
      material_intensity: i % 11,
      owner_index: owners[i % owners.length],
      direction: i % 6,
      rotation: i % 4,
      visibility: i % 13 !== 0,
      collision: { player: i % 5 !== 0, weapon: i % 3 !== 0 },
      components: [{ type }],
    })
  );

  // >128 sub-grids, so a remote wire crossing from the last one carries a
  // GridPersistentIndex (2 + entity order) past the fixint range.
  let farBrick: ReturnType<World['addBrick']> | null = null;
  for (let i = 0; i < 132; i++) {
    const g = w.addBrickGrid();
    const b = w.addBrick(
      { position: [0, 0, 2], components: i === 131 ? [{ type: target }] : [] },
      g
    );
    if (i === 131) farBrick = b;
  }
  w.addWire(
    { brick: farBrick, component_type: target, port: 'FarOut' },
    {
      brick: input,
      component_type: COMPONENTS.MicrochipInput.NAME,
      port: 'FarIn',
    }
  );

  // A remote source in a NEGATIVE chunk, so the signed chunk-index columns
  // carry values the unsigned encoder could not round-trip.
  const negBrick = w.addBrick({
    position: [-6000, -6000, -6000],
    components: [{ type: target }],
  });
  w.addWire(
    { brick: negBrick, component_type: target, port: 'NegOut' },
    {
      brick: input,
      component_type: COMPONENTS.MicrochipInput.NAME,
      port: 'NegIn',
    }
  );

  // Interleaved types in one chunk: add order is [A, B, A], so the writer has
  // to regroup into one contiguous run per type.
  const light = COMPONENTS.PointLight.NAME;
  w.addBrick({
    position: [0, 200, 6],
    components: [
      { type: light, data: { Brightness: 100 } },
      { type: target, data: {} },
    ],
  });
  w.addBrick({
    position: [20, 200, 6],
    components: [{ type: light, data: { Brightness: 200 } }],
  });
  w.addBrick({
    position: [40, 200, 6],
    components: [{ type: target, data: {} }],
  });

  // Local wires between high-index bricks, with enough distinct port names
  // that port indices also leave the fixint range.
  for (let i = 1; i < 200; i += 2)
    w.addWire(
      {
        brick: handles[i],
        component_type: usableComponentTypes[i],
        port: `OutPort${i}`,
      },
      {
        brick: handles[i - 1],
        component_type: usableComponentTypes[i - 1],
        port: `InPort${i}`,
      }
    );

  // A remote wire: a high-index main-grid source into the chip's inner grid.
  const last = handles.length - 1;
  w.addWire(
    {
      brick: handles[last],
      component_type: usableComponentTypes[last],
      port: 'RemoteOut',
    },
    {
      brick: input,
      component_type: COMPONENTS.MicrochipInput.NAME,
      port: 'RemoteIn',
    }
  );

  w.addEntity({
    location: { X: 1, Y: 2, Z: 3 },
    frozen: true,
    linear_velocity: { X: 0.5, Y: -0.5, Z: 0 },
  });
  return w;
}

/** Write the same input twice, with the fast paths on and off. */
const bothWays = (write: () => Uint8Array) => {
  setFastPaths(true);
  let fast: Uint8Array;
  let generic: Uint8Array;
  try {
    fast = write();
    setFastPaths(false);
    generic = write();
  } finally {
    setFastPaths(true);
  }
  return { fast, generic };
};

describe('fast write paths reproduce the generic writer byte for byte', () => {
  test('the toggle is honoured (otherwise these tests prove nothing)', () => {
    // The predicates gate the brick/wire encoders; the toggle gates all four.
    expect(brickChunkSchemaIsStandard(brickSchema)).toBe(true);
    expect(wireChunkSchemaIsStandard(wireSchema)).toBe(true);
    expect(usableComponentTypes.length).toBeGreaterThan(200);
  });

  for (const [name, save] of [
    ['brick', exampleBrickSave],
    ['features', featuresSave],
    ['chunks', chunksSave],
  ] as const) {
    test(`legacy save: ${name}`, () => {
      const { fast, generic } = bothWays(() => writeBrzLegacy(save));
      expect(hex(fast)).toBe(hex(generic));
    });
  }

  test('rich world: every component type, wires, entities, microchip', () => {
    const { fast, generic } = bothWays(() => richWorld().toBrz());
    expect(hex(fast)).toBe(hex(generic));

    // The world has to actually reach every path for that comparison to mean
    // anything.
    const r = WorldReader.from(fast);
    expect(fast.length).toBeGreaterThan(100_000);
    expect(r.gridIds().length).toBeGreaterThan(128);
    const entities = [...r.entities()];
    expect(entities.length).toBeGreaterThan(128);
    // entity data structs are written (the plan-cached entity path)
    expect(entities.some(e => e.data && Object.keys(e.data).length > 0)).toBe(
      true
    );
    // unset dynamic-grid fields take the game's fresh-grid values, not zero
    const grids = entities.filter(e => e.className === 'BrickGridDynamicActor');
    expect(grids.length).toBeGreaterThan(0);
    for (const e of grids)
      expect(e.data).toMatchObject({
        MassScale: 1,
        bEnableGravity: true,
        bUseNewMassCalculation: true,
        bReceivesDecals: true,
        bVisible: true,
      });
    const { components } = r.componentChunk(1, { x: 0, y: 0, z: 0 });
    expect(components.length).toBeGreaterThan(200);
    const wires = r.wireChunk(2, { x: -1, y: -1, z: -1 });
    expect(wires.remote.length).toBeGreaterThan(0);
    expect(wires.local.length).toBeGreaterThan(0);
  });

  test('prefab world', () => {
    const { fast, generic } = bothWays(() => {
      const w = richWorld();
      w.makePrefab({ isMicrochipPrefab: true });
      return w.toBrz();
    });
    expect(hex(fast)).toBe(hex(generic));
  });

  test('empty world', () => {
    const { fast, generic } = bothWays(() => new World().toBrz());
    expect(hex(fast)).toBe(hex(generic));
  });
});

describe('component regrouping', () => {
  // The regroup runs on both sides of the fast-path toggle, so the byte
  // differentials above cannot catch a counting-sort bug. Check the result
  // against an independent stable sort instead.
  test('counting sort matches a stable sort by type, over many types', () => {
    const types = [
      COMPONENTS.PointLight.NAME,
      COMPONENTS.Target.NAME,
      COMPONENTS.MicrochipInput.NAME,
      COMPONENTS.MicrochipOutput.NAME,
    ];
    // Type order per brick is deliberately irregular so add order interleaves.
    const bricks = Array.from({ length: 40 }, (_, i) => ({
      size: [5, 5, 6] as [number, number, number],
      position: [i * 20, 0, 6] as [number, number, number],
      components: [{ type: types[(i * 3 + (i % 5)) % types.length] }],
    }));
    const r = WorldReader.from(writeBrzLegacy({ bricks }));
    const { soa, components } = r.componentChunk(1, { x: 0, y: 0, z: 0 });

    // First-seen type order is what the registry assigns, and the counters
    // must be one contiguous run per type in ascending TypeIndex order.
    const counters = soa.ComponentTypeCounters as {
      TypeIndex: number;
      NumInstances: number;
    }[];
    expect(counters.map(c => c.TypeIndex)).toEqual(
      [...counters].map((_, i) => i)
    );
    expect(new Set(counters.map(c => c.TypeIndex)).size).toBe(counters.length);

    const registryOrder = [...new Set(bricks.map(b => b.components[0].type))];
    const expected = bricks
      .map((b, brickIndex) => ({ type: b.components[0].type, brickIndex }))
      .map(x => ({ ...x, key: registryOrder.indexOf(x.type) }))
      // stable sort by type index, which must keep ascending brick order
      .sort((a, b) => a.key - b.key)
      .map(x => [x.type, x.brickIndex]);
    expect(components.map(c => [c.typeName, c.brickIndex])).toEqual(expected);
  });
});
