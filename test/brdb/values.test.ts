import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BrzReader } from '../../src/brdb/brz';
import { embeddedSchema } from '../../src/brdb/schema';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));

test('flatTypeSize', () => {
  const schema = embeddedSchema('BRSavedBrickChunkSoA');
  expect(schema.flatTypeSize('u8')).toBe(1);
  expect(schema.flatTypeSize('f64')).toBe(8);
  expect(schema.flatTypeSize('BRSavedRelativeBrickPosition')).toBe(6); // 3 × i16
  expect(schema.flatTypeSize('BRSavedBrickColor')).toBe(4); // 4 × u8
  // non-Type props contribute 0 -> a BitFlags flat array is invalid flat data
  expect(schema.flatTypeSize('BRSavedBitFlags')).toBe(0);
  expect(embeddedSchema('BRSavedOwnerTableSoA').flatTypeSize('BRGuid')).toBe(
    16
  );
});

describe.skipIf(!hasFixtures)(
  'fixture .mps payloads decode and re-encode byte-identically',
  () => {
    const cases: [
      fixture: string,
      path: string,
      schema: any,
      struct: string
    ][] = [];
    for (const fx of ['brick_raw', 'features_raw', 'chunks_raw']) {
      cases.push(
        [
          fx,
          'World/0/GlobalData.mps',
          'BRSavedGlobalDataSoA',
          'BRSavedGlobalDataSoA',
        ],
        [
          fx,
          'World/0/Owners.mps',
          'BRSavedOwnerTableSoA',
          'BRSavedOwnerTableSoA',
        ],
        [
          fx,
          'World/0/Bricks/Grids/1/ChunkIndex.mps',
          'BRSavedBrickChunkIndexSoA',
          'BRSavedBrickChunkIndexSoA',
        ],
        [
          fx,
          'World/0/Entities/ChunkIndex.mps',
          'BRSavedEntityChunkIndexSoA',
          'BRSavedEntityChunkIndexSoA',
        ]
      );
    }
    for (const [fx, path, schemaName, structName] of cases) {
      test(`${fx}: ${path}`, () => {
        const payload = BrzReader.from(fixture(`${fx}.brz`)).readFile(path);
        const schema = embeddedSchema(schemaName);
        expect(
          hex(schema.encode(structName, schema.decode(payload, structName)))
        ).toBe(hex(payload));
      });
    }

    test('every chunk .mps in every fixture round-trips', () => {
      const schema = embeddedSchema('BRSavedBrickChunkSoA');
      for (const fx of ['brick_raw', 'features_raw', 'chunks_raw']) {
        const reader = BrzReader.from(fixture(`${fx}.brz`));
        const chunkPaths = reader
          .listPaths()
          .filter(p => /\/Chunks\/[^/]+\.mps$/.test(p));
        expect(chunkPaths.length).toBeGreaterThan(0);
        for (const path of chunkPaths) {
          const payload = reader.readFile(path);
          const value = schema.decode(payload, 'BRSavedBrickChunkSoA');
          expect(
            hex(schema.encode('BRSavedBrickChunkSoA', value)),
            `${fx}:${path}`
          ).toBe(hex(payload));
        }
      }
    });
  }
);

describe.skipIf(!hasFixtures)(
  'decoded values match the known brick fixture',
  () => {
    const reader = () => BrzReader.from(fixture('brick_raw.brz'));

    test('GlobalData', () => {
      const value = embeddedSchema('BRSavedGlobalDataSoA').decode(
        reader().readFile('World/0/GlobalData.mps'),
        'BRSavedGlobalDataSoA'
      );
      expect(value).toEqual({
        EntityTypeNames: [],
        EntityDataClassNames: [],
        BasicBrickAssetNames: [],
        ProceduralBrickAssetNames: ['PB_DefaultBrick'],
        MaterialAssetNames: ['BMC_Plastic'],
        ComponentTypeNames: [],
        ComponentDataStructNames: [],
        ComponentWirePortNames: [],
        ExternalAssetReferences: [],
        GlobalGridEntityTypeIndex: -1,
      });
    });

    test('Owners: PUBLIC row 0 with one brick', () => {
      const value = embeddedSchema('BRSavedOwnerTableSoA').decode(
        reader().readFile('World/0/Owners.mps'),
        'BRSavedOwnerTableSoA'
      );
      expect(value).toEqual({
        UserIds: [
          { A: 4294967295, B: 4294967295, C: 4294967295, D: 4294967295 },
        ],
        UserNames: ['PUBLIC'],
        DisplayNames: ['PUBLIC'],
        EntityCounts: [0],
        BrickCounts: [1],
        ComponentCounts: [0],
        WireCounts: [0],
      });
    });

    test('ChunkIndex: origin chunk gets zero offsets', () => {
      const value = embeddedSchema('BRSavedBrickChunkIndexSoA').decode(
        reader().readFile('World/0/Bricks/Grids/1/ChunkIndex.mps'),
        'BRSavedBrickChunkIndexSoA'
      );
      expect(value).toEqual({
        Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }],
        ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }],
        ChunkSizes: [2048],
        NumBricks: [1],
        NumComponents: [0],
        NumWires: [0],
      });
    });

    test('Chunk SoA: the single default brick', () => {
      const value = embeddedSchema('BRSavedBrickChunkSoA').decode(
        reader().readFile('World/0/Bricks/Grids/1/Chunks/0_0_0.mps'),
        'BRSavedBrickChunkSoA'
      );
      const bit1 = { Flags: [1] };
      expect(value).toEqual({
        ProceduralBrickStartingIndex: 0,
        BrickSizeCounters: [{ AssetIndex: 0, NumSizes: 1 }],
        BrickSizes: [{ X: 5, Y: 5, Z: 6 }],
        BrickTypeIndices: [0],
        OwnerIndices: [0],
        OriginalOwnerIndices: [0],
        RelativePositions: [{ X: -1024, Y: -1024, Z: -1018 }], // (0,0,6) − 1024
        Orientations: [16], // ZPositive<<2 | Deg0
        CollisionFlags_Player: bit1,
        CollisionFlags_Player1: bit1,
        CollisionFlags_Player2: bit1,
        CollisionFlags_Player3: bit1,
        CollisionFlags_Weapon: bit1,
        CollisionFlags_Interaction: bit1,
        CollisionFlags_Physics: bit1,
        VisibilityFlags: bit1,
        MaterialIndices: [0],
        ColorsAndAlphas: [{ R: 255, G: 0, B: 0, A: 5 }], // A = material_intensity
        bColorsAreLinear: false,
      });
    });

    test('Entities ChunkIndex: empty grid, next persistent index 2', () => {
      const value = embeddedSchema('BRSavedEntityChunkIndexSoA').decode(
        reader().readFile('World/0/Entities/ChunkIndex.mps'),
        'BRSavedEntityChunkIndexSoA'
      );
      expect(value).toEqual({
        NextPersistentIndex: 2,
        Chunk3DIndices: [],
        NumEntities: [],
      });
    });
  }
);
