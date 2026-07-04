import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BrzWorldBrick, WorldReader } from '../../src/brdb/reader';
import { writeBrzLegacy } from '../../src/brdb/world';
import { chunksSave, dump, exampleBrickSave, featuresSave } from './fixtures';

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );

const allTrueCollision = {
  player: true,
  weapon: true,
  interaction: true,
  tool: true,
  physics: true,
};

describe.skipIf(!hasFixtures)('WorldReader(brick_raw.brz)', () => {
  test('reads the complete expected world', () => {
    const reader = WorldReader.from(fixture('brick_raw.brz'));
    expect(reader.bundle()).toEqual({
      type: 'World',
      iD: '00000000-0000-0000-0000-000000000000',
      name: '',
      version: '',
      tags: [],
      authors: [],
      createdAt: '0001.01.01-00.00.00',
      updatedAt: '0001.01.01-00.00.00',
      description: 'Example World',
      dependencies: [],
      gameVersion: 'CL0',
    });
    expect(reader.environment()).toEqual({ environment: 'Plate' });
    expect(reader.brickAssets()).toEqual(['PB_DefaultBrick']);
    expect(reader.materials()).toEqual(['BMC_Plastic']);
    expect(reader.brickOwners()).toEqual([]);
    expect([...reader.bricks()]).toEqual([
      {
        asset_name_index: 0,
        size: [5, 5, 6],
        position: [0, 0, 6],
        direction: 4,
        rotation: 0,
        collision: allTrueCollision,
        visibility: true,
        material_index: 0,
        material_intensity: 5,
        color: [255, 0, 0],
        owner_index: 0,
      },
    ]);
  });

  test('enumerates grids and tracks entities', () => {
    const reader = WorldReader.from(fixture('brick_raw.brz'));
    expect(reader.gridIds()).toEqual([1]);
    expect(reader.entityChunkIndex()).toEqual({
      nextPersistentIndex: 2,
      chunks: [],
    });
    expect(reader.brickChunkIndex(1)).toEqual([
      {
        index: { x: 0, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
        size: 2048,
        numBricks: 1,
        numComponents: 0,
        numWires: 0,
      },
    ]);
  });
});

describe.skipIf(!hasFixtures)('WorldReader (lazy)', () => {
  test('caches schemas; decodes chunks on demand through a generator', () => {
    const reader = WorldReader.from(fixture('features_raw.brz'));
    const schema = reader.schema('World/0/Bricks/ChunksShared.schema');
    expect(reader.schema('World/0/Bricks/ChunksShared.schema')).toBe(schema);

    const bricks = reader.bricks();
    const first = bricks.next().value as BrzWorldBrick;
    expect(first.position).toEqual([0, 0, 6]);
    expect([...reader.bricks(1)]).toHaveLength(7);
  });

  test('multi-chunk fixture: chunk refs match the chunk index', () => {
    const reader = WorldReader.from(fixture('chunks_raw.brz'));
    const refs = reader.brickChunkIndex();
    expect(refs.map(r => [r.index.x, r.index.y, r.index.z])).toEqual([
      [0, 0, 0],
      [-1, -1, -1],
      [1, 0, 0],
      [-1, 2, 0],
    ]);
    // non-origin chunks carry the half-size offset
    expect(refs[0].offset).toEqual({ x: 0, y: 0, z: 0 });
    expect(refs[1].offset).toEqual({ x: 1024, y: 1024, z: 1024 });
    // per-chunk lazy decode agrees with the ref counts
    for (const ref of refs)
      expect(reader.brickChunkSoa(1, ref.index).BrickTypeIndices).toHaveLength(
        ref.numBricks
      );
  });
});

describe.skipIf(!hasFixtures)(
  'compressed and raw variants read identically (fzstd path)',
  () => {
    for (const name of ['brick', 'features', 'chunks']) {
      test(`${name}.brz === ${name}_raw.brz`, () => {
        expect(dump(WorldReader.from(fixture(`${name}.brz`)))).toEqual(
          dump(WorldReader.from(fixture(`${name}_raw.brz`)))
        );
      });
    }
  }
);

describe.skipIf(!hasFixtures)('WorldReader(features_raw.brz)', () => {
  const reader = () => WorldReader.from(fixture('features_raw.brz'));

  test('registries and owners', () => {
    // combined list = basic ++ procedural, registry (first-use) order
    expect(reader().brickAssets()).toEqual([
      'B_2x2_Overhang',
      'PB_DefaultBrick',
      'PB_DefaultTile',
    ]);
    expect(reader().materials()).toEqual([
      'BMC_Plastic',
      'BMC_Metallic',
      'BMC_Glow',
    ]);
    expect(reader().brickOwners()).toEqual([
      {
        id: 'a1b2c3d4-e5f6-4789-8abc-def012345678',
        name: 'cake',
        display_name: 'Cake',
        bricks: 4,
      },
      {
        id: '00112233-4455-6677-8899-aabbccddeeff',
        name: 'bob',
        display_name: 'Bob',
        bricks: 2,
      },
    ]);
  });

  test('bricks (single chunk, original order preserved)', () => {
    expect([...reader().bricks()]).toEqual([
      {
        asset_name_index: 1,
        size: [5, 5, 6],
        position: [0, 0, 6],
        direction: 4,
        rotation: 0,
        collision: allTrueCollision,
        visibility: true,
        material_index: 0,
        material_intensity: 5,
        color: [255, 0, 0],
        owner_index: 1,
      },
      {
        asset_name_index: 2,
        size: [10, 10, 2],
        position: [20, 0, 2],
        direction: 0,
        rotation: 1,
        collision: allTrueCollision,
        visibility: true,
        material_index: 1,
        material_intensity: 7,
        color: [0, 255, 0],
        owner_index: 1,
      },
      {
        asset_name_index: 2,
        size: [10, 10, 2],
        position: [40, 0, 2],
        direction: 4,
        rotation: 0,
        collision: allTrueCollision,
        visibility: true,
        material_index: 0,
        material_intensity: 5,
        color: [0, 0, 255],
        owner_index: 2,
      },
      {
        asset_name_index: 2,
        size: [20, 20, 2],
        position: [80, 0, 2],
        direction: 4,
        rotation: 0,
        collision: allTrueCollision,
        visibility: true,
        material_index: 0,
        material_intensity: 5,
        color: [255, 255, 0],
        owner_index: 2,
      },
      {
        asset_name_index: 1,
        size: [5, 5, 6],
        position: [100, 0, 6],
        direction: 4,
        rotation: 0,
        collision: allTrueCollision,
        visibility: true,
        material_index: 0,
        material_intensity: 5,
        color: [255, 255, 255],
        owner_index: 1,
      },
      {
        asset_name_index: 0,
        size: [0, 0, 0],
        position: [200, 0, 10],
        direction: 3,
        rotation: 2,
        collision: { ...allTrueCollision, player: false },
        visibility: true,
        material_index: 2,
        material_intensity: 3,
        color: [128, 64, 32],
        owner_index: 0,
      },
      {
        asset_name_index: 1,
        size: [2, 2, 2],
        position: [300, 0, 2],
        direction: 4,
        rotation: 0,
        collision: {
          player: false,
          weapon: false,
          interaction: false,
          tool: true,
          physics: false,
        },
        visibility: false,
        material_index: 0,
        material_intensity: 5,
        color: [10, 20, 30],
        owner_index: 1,
      },
    ]);
  });
});

describe('write -> read round-trips', () => {
  describe.skipIf(!hasFixtures)(
    'features: full fidelity (single chunk)',
    () => {
      test('matches the features_raw.brz fixture', () => {
        expect(dump(WorldReader.from(writeBrzLegacy(featuresSave)))).toEqual(
          dump(WorldReader.from(fixture('features_raw.brz')))
        );
      });
    }
  );

  test('chunks: positions survive euclidean chunking; order is per-chunk', () => {
    const bricks = [...WorldReader.from(writeBrzLegacy(chunksSave)).bricks()];
    // chunk-index order: 0_0_0, -1_-1_-1, 1_0_0, -1_2_0 (first-seen);
    // bricks come back grouped by chunk
    expect(bricks.map(b => b.position)).toEqual([
      [0, 0, 0],
      [500, 500, 500], // chunk 0,0,0
      [-1, -1, -1], // chunk -1,-1,-1
      [2048, 0, 0],
      [2548, 500, 500], // chunk 1,0,0
      [-2048, 4096, 10], // chunk -1,2,0
    ]);
    expect(bricks.map(b => b.color)).toEqual([
      [1, 2, 3],
      [42, 42, 42],
      [4, 5, 6],
      [1, 2, 3],
      [42, 42, 42],
      [10, 11, 12],
    ]);
  });

  test('example brick save round-trips through write', () => {
    const bricks = [
      ...WorldReader.from(writeBrzLegacy(exampleBrickSave)).bricks(),
    ];
    expect(bricks).toHaveLength(1);
    expect(bricks[0].position).toEqual([0, 0, 6]);
    expect(bricks[0].size).toEqual([5, 5, 6]);
  });
});
