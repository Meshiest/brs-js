import { existsSync, readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { BrzReader } from '../../src/brdb/brz';
import { embeddedSchema } from '../../src/brdb/schema';
import {
  CHUNK_SIZE,
  saveToPendingFs,
  toRelative,
  writeBrzLegacy,
} from '../../src/brdb/world';
import { WorldReader } from '../../src/brdb/reader';
import { chunksSave, exampleBrickSave, featuresSave } from './fixtures';

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const HASHES = hasFixtures
  ? JSON.parse(
      readFileSync(
        new URL('../fixtures/brdb/hashes.json', import.meta.url),
        'utf8'
      )
    )
  : {};

test('toRelative: euclidean chunking', () => {
  expect(toRelative([0, 0, 6])).toEqual({
    chunk: [0, 0, 0],
    rel: [-1024, -1024, -1018],
  });
  expect(toRelative([-1, -1, -1])).toEqual({
    chunk: [-1, -1, -1],
    rel: [1023, 1023, 1023],
  });
  expect(toRelative([2048, 0, 0])).toEqual({
    chunk: [1, 0, 0],
    rel: [-1024, -1024, -1024],
  });
  expect(toRelative([-2048, 4096, 10])).toEqual({
    chunk: [-1, 2, 0],
    rel: [-1024, -1024, -1014],
  });
  expect(toRelative([2047, 0, 0]).chunk).toEqual([0, 0, 0]);
  expect(toRelative([2047, 0, 0]).rel[0]).toBe(1023);
});

describe.skipIf(!hasFixtures)(
  'container byte-gates (raw archives, single-chunk fixtures)',
  () => {
    test('brick: writeBrzLegacy(save) === brick_raw.brz byte-for-byte', () => {
      expect(hex(writeBrzLegacy(exampleBrickSave))).toBe(
        hex(fixture('brick_raw.brz'))
      );
    });

    test('features: writeBrzLegacy(save) === features_raw.brz byte-for-byte', () => {
      expect(hex(writeBrzLegacy(featuresSave))).toBe(
        hex(fixture('features_raw.brz'))
      );
    });
  }
);

describe.skipIf(!hasFixtures)(
  'payload hash-gates (all fixtures, per-path, order-independent)',
  () => {
    for (const [name, save] of [
      ['brick', exampleBrickSave],
      ['features', featuresSave],
      ['chunks', chunksSave],
    ] as const) {
      test(name, () => {
        const reader = BrzReader.from(writeBrzLegacy(save));
        const golden = HASHES[name];
        expect(reader.listPaths().slice().sort()).toEqual(Object.keys(golden));
        for (const path of reader.listPaths()) {
          const content = reader.readFile(path);
          expect(bytesToHex(blake3(content)), path).toBe(golden[path].blake3);
          expect(content.length, path).toBe(golden[path].len);
        }
      });
    }
  }
);

describe('basic (non-procedural) asset bricks', () => {
  test('size may be omitted for basic assets', () => {
    const bytes = writeBrzLegacy({
      brick_assets: ['B_1x1_Gate_AND'],
      bricks: [{ position: [0, 0, 2], color: [255, 0, 0] }],
    });
    const r = WorldReader.from(bytes);
    const [b] = [...r.bricks()];
    expect(r.brickAssets()[b.asset_name_index]).toBe('B_1x1_Gate_AND');
    expect(b.position).toEqual([0, 0, 2]);
  });

  test('procedural assets still require a size', () => {
    expect(() =>
      writeBrzLegacy({ bricks: [{ position: [0, 0, 6] }] } as any)
    ).toThrow(/requires a size/);
  });
});

describe('edge cases', () => {
  test('bundle_path_ref fields (PrefabSpawn) round-trip as strings', () => {
    const bytes = writeBrzLegacy({
      bricks: [
        {
          size: [5, 5, 6],
          position: [0, 0, 6],
          components: [
            {
              type: 'BrickComponentType_PrefabSpawn',
              data: { Prefab: 'Prefabs/MyPrefab' },
            },
          ],
        },
      ],
    });
    const r = WorldReader.from(bytes);
    const { components } = r.componentChunk(1, { x: 0, y: 0, z: 0 });
    expect(components[0].data?.Prefab).toBe('Prefabs/MyPrefab');
  });

  test('empty save still produces a full, readable world tree', () => {
    const reader = BrzReader.from(writeBrzLegacy({ bricks: [] }));
    // no bricks -> no Chunks folder, but ChunkIndex.mps and Entities remain
    expect(reader.listPaths()).toEqual([
      'Meta/Bundle.json',
      'Meta/World.json',
      'World/0/GlobalData.schema',
      'World/0/GlobalData.mps',
      'World/0/Owners.schema',
      'World/0/Owners.mps',
      'World/0/Bricks/ChunkIndexShared.schema',
      'World/0/Bricks/ChunksShared.schema',
      'World/0/Bricks/WiresShared.schema',
      'World/0/Bricks/ComponentsShared.schema',
      'World/0/Entities/ChunkIndex.schema',
      'World/0/Entities/ChunkIndex.mps',
      'World/0/Entities/ChunksShared.schema',
      'World/0/Bricks/Grids/1/ChunkIndex.mps',
    ]);
  });

  test('Bundle.json mapping and overrides', () => {
    const reader = BrzReader.from(
      writeBrzLegacy(
        {
          bricks: [],
          description: 'Hello',
          author: { id: '0-0-0-0-0', name: 'cake' },
        },
        { environment: 'Space', bundle: { name: 'My World' } }
      )
    );
    const bundle = JSON.parse(
      new TextDecoder().decode(reader.readFile('Meta/Bundle.json'))
    );
    expect(bundle).toEqual({
      type: 'World',
      iD: '00000000-0000-0000-0000-000000000000',
      name: 'My World',
      version: '',
      tags: [],
      authors: ['cake'],
      createdAt: '0001.01.01-00.00.00',
      updatedAt: '0001.01.01-00.00.00',
      description: 'Hello',
      dependencies: [],
      gameVersion: 'CL0',
    });
    // key order must match serde's declaration order for byte parity
    expect(Object.keys(bundle)).toEqual([
      'type',
      'iD',
      'name',
      'version',
      'tags',
      'authors',
      'createdAt',
      'updatedAt',
      'description',
      'dependencies',
      'gameVersion',
    ]);
    expect(
      JSON.parse(new TextDecoder().decode(reader.readFile('Meta/World.json')))
    ).toEqual({
      environment: 'Space',
    });
  });

  test('validation errors carry the brick index', () => {
    expect(() =>
      writeBrzLegacy({ bricks: [{ size: [1, 1, 1], position: [0.5, 0, 0] }] })
    ).toThrow(/bricks\[0\]/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0], owner_index: 3 }],
      })
    ).toThrow(/bricks\[0\].*owner_index/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ asset_name_index: 5, size: [1, 1, 1], position: [0, 0, 0] }],
      })
    ).toThrow(/bricks\[0\].*asset_name_index/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0], color: 7 }],
      })
    ).toThrow(/bricks\[0\].*palette/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0], color: [256, 0, 0] }],
      })
    ).toThrow(/bricks\[0\].*color component/);
    expect(() =>
      writeBrzLegacy({
        bricks: [
          {
            size: [1, 1, 1],
            position: [0, 0, 0],
            material_intensity: 256,
          },
        ],
      })
    ).toThrow(/bricks\[0\].*material_intensity/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [32768 * CHUNK_SIZE, 0, 0] }],
      })
    ).toThrow(/bricks\[0\].*i16 chunk range/);
  });

  test('additional writer validation guards', () => {
    // material_index out of range (default materials list has 1 entry)
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0], material_index: 5 }],
      })
    ).toThrow(/bricks\[0\].*material_index/);
    // size components must be u16 (non-negative, <= 0xffff)
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [-1, 1, 1], position: [0, 0, 0] }],
      })
    ).toThrow(/bricks\[0\].*u16/);
    // a color array needs at least 3 components (R, G, B)
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0], color: [255] as any }],
      })
    ).toThrow(/bricks\[0\].*at least 3/);
    // an unknown component data field surfaces fillStruct's own guard
    expect(() =>
      writeBrzLegacy({
        bricks: [
          {
            size: [1, 1, 1],
            position: [0, 0, 0],
            components: [
              { type: 'Component_PointLight', data: { NotAField: 1 } },
            ],
          },
        ],
      })
    ).toThrow(/no field 'NotAField'/);
    // more than 256 distinct materials overflows the u8 MaterialIndices column
    expect(() =>
      writeBrzLegacy({
        materials: Array.from({ length: 257 }, (_, i) => `BMC_M${i}`),
        bricks: Array.from({ length: 257 }, (_, i) => ({
          size: [1, 1, 1] as [number, number, number],
          position: [i * 10, 0, 0] as [number, number, number],
          material_index: i,
        })),
      })
    ).toThrow(/too many distinct materials/);
  });

  test('palette-indexed colors resolve through save.colors (RGBA in memory)', () => {
    const bytes = writeBrzLegacy({
      colors: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
      ],
      bricks: [{ size: [5, 5, 6], position: [0, 0, 6], color: 1 }],
    });
    const chunk = BrzReader.from(bytes).readFile(
      'World/0/Bricks/Grids/1/Chunks/0_0_0.mps'
    );
    // ColorsAndAlphas flat bytes are R,G,B,A — find them via the schema
    // decode instead of offsets:
    const soa: any = embeddedSchema('BRSavedBrickChunkSoA').decode(
      chunk,
      'BRSavedBrickChunkSoA'
    );
    expect(soa.ColorsAndAlphas).toEqual([{ R: 40, G: 50, B: 60, A: 5 }]);
  });
});

describe('brdb components and wires (write -> read round-trip)', () => {
  const POINT_LIGHT = 'Component_PointLight';
  const CHIP_IN = 'BrickComponentType_Internal_MicrochipInput';
  const save: Parameters<typeof writeBrzLegacy>[0] = {
    bricks: [
      {
        size: [5, 5, 6],
        position: [0, 0, 6],
        components: [
          { type: POINT_LIGHT, data: { Brightness: 100, bEnabled: true } },
          { type: CHIP_IN, data: { PortLabel: 'In' } },
        ],
      },
      {
        size: [5, 5, 6],
        position: [20, 0, 6],
        components: [{ type: CHIP_IN, data: { PortLabel: 'Other' } }],
      },
      {
        // separate chunk (2,0,0)
        size: [5, 5, 6],
        position: [4096, 0, 6],
        components: [{ type: POINT_LIGHT }],
      },
    ],
    wires: [
      {
        // local: both endpoints in chunk (0,0,0)
        source: { brick_index: 0, component_type: CHIP_IN, port: 'Output' },
        target: { brick_index: 1, component_type: CHIP_IN, port: 'Input' },
      },
      {
        // remote: source chunk (0,0,0), target chunk (2,0,0)
        source: {
          brick_index: 0,
          component_type: POINT_LIGHT,
          port: 'Brightness',
        },
        target: {
          brick_index: 2,
          component_type: POINT_LIGHT,
          port: 'bEnabled',
        },
      },
    ],
  };
  const reader = () => WorldReader.from(writeBrzLegacy(save));

  test('registries, per-chunk counts, and owner component counts', () => {
    const r = reader();
    const globalData = r.globalData();
    expect(globalData.ComponentTypeNames).toEqual([POINT_LIGHT, CHIP_IN]);
    expect(globalData.ComponentDataStructNames).toEqual([
      'BrickComponentData_PointLight',
      'BrickComponentData_Internal_MicrochipInput',
    ]);
    expect(globalData.ComponentWirePortNames).toEqual([
      'Output',
      'Input',
      'Brightness',
      'bEnabled',
    ]);
    const refs = r.brickChunkIndex();
    expect(refs.map(x => [x.numBricks, x.numComponents, x.numWires])).toEqual([
      [2, 3, 1],
      [1, 1, 1],
    ]);
    expect(r.owners().ComponentCounts).toEqual([4]);
  });

  test('component chunks: run-length counters, per-instance data, default-fill', () => {
    const r = reader();
    const { soa, components } = r.componentChunk(1, { x: 0, y: 0, z: 0 });
    expect(soa.ComponentTypeCounters).toEqual([
      { TypeIndex: 0, NumInstances: 1 },
      { TypeIndex: 1, NumInstances: 2 },
    ]);
    expect(components.map(c => [c.typeName, c.brickIndex])).toEqual([
      [POINT_LIGHT, 0],
      [CHIP_IN, 0],
      [CHIP_IN, 1],
    ]);
    // Set fields survive; omitted fields decode as the game's default
    // values (crate STRUCT_DEFAULTS). The expected shape is spelled out
    // literally (not derived via fillStruct, which the production writer
    // also calls) so a regression in fillStruct/defaults can't shift both
    // sides identically and hide.
    const defaultFilledPointLight = {
      bMatchBrickShape: true,
      bEnabled: true,
      Brightness: 20,
      Radius: 150,
      Color: { B: 255, G: 255, R: 255, A: 255 },
      bUseBrickColor: true,
      bCastShadows: false,
    };
    expect(components[0].data).toEqual({
      ...defaultFilledPointLight,
      Brightness: 100,
      bEnabled: true,
    });
    expect(components[1].data).toEqual({ PortLabel: 'In' });
    expect(components[2].data).toEqual({ PortLabel: 'Other' });

    const other = r.componentChunk(1, { x: 2, y: 0, z: 0 });
    expect(other.components).toEqual([
      {
        typeName: POINT_LIGHT,
        structName: 'BrickComponentData_PointLight',
        brickIndex: 0,
        data: defaultFilledPointLight,
      },
    ]);
  });

  test('wire chunks: local vs remote with resolved names', () => {
    const r = reader();
    expect(r.wireChunk(1, { x: 0, y: 0, z: 0 })).toEqual({
      local: [
        {
          source: { brickIndex: 0, componentType: CHIP_IN, port: 'Output' },
          target: { brickIndex: 1, componentType: CHIP_IN, port: 'Input' },
        },
      ],
      remote: [],
    });
    expect(r.wireChunk(1, { x: 2, y: 0, z: 0 })).toEqual({
      local: [],
      remote: [
        {
          source: {
            brickIndex: 0,
            componentType: POINT_LIGHT,
            port: 'Brightness',
            gridId: 1,
            chunk: { x: 0, y: 0, z: 0 },
          },
          target: {
            brickIndex: 0,
            componentType: POINT_LIGHT,
            port: 'bEnabled',
          },
        },
      ],
    });
  });

  test('validation: unknown types and dangling wires throw', () => {
    expect(() =>
      writeBrzLegacy({
        bricks: [
          {
            size: [1, 1, 1],
            position: [0, 0, 0],
            components: [{ type: 'Component_DoesNotExist' }],
          },
        ],
      })
    ).toThrow(/unknown component type/);
    expect(() =>
      writeBrzLegacy({
        bricks: [{ size: [1, 1, 1], position: [0, 0, 0] }],
        wires: [
          {
            source: { brick_index: 0, component_type: POINT_LIGHT, port: 'A' },
            target: { brick_index: 0, component_type: POINT_LIGHT, port: 'A' },
          },
        ],
      })
    ).toThrow(/not used by any brick/);
    expect(() =>
      writeBrzLegacy({
        bricks: [
          {
            size: [1, 1, 1],
            position: [0, 0, 0],
            components: [{ type: POINT_LIGHT }],
          },
        ],
        wires: [
          {
            source: { brick_index: 5, component_type: POINT_LIGHT, port: 'A' },
            target: { brick_index: 0, component_type: POINT_LIGHT, port: 'A' },
          },
        ],
      })
    ).toThrow(/brick_index 5 out of range/);
  });
});
