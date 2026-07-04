// TS mirrors of the oracle fixture worlds (regenerate with `just fixtures`).
// These MUST stay in lockstep with the generator — the worldWrite tests
// assert that writeBrzLegacy(save) reproduces the oracle archives byte-for-byte.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { WriteSaveObject } from '../../src';
import type { WorldReader } from '../../src/brdb/reader';

/** Drain every reader surface for whole-archive comparisons. */
export const dump = (reader: WorldReader) => ({
  bundle: reader.bundle(),
  environment: reader.environment(),
  brickAssets: reader.brickAssets(),
  materials: reader.materials(),
  brickOwners: reader.brickOwners(),
  entityChunkIndex: reader.entityChunkIndex(),
  grids: Object.fromEntries(
    reader.gridIds().map(id => [id, [...reader.bricks(id)]])
  ),
});

/** Per-path BLAKE3 + length of every decompressed payload, keyed by path.
 * Matches the shape of hashes.json and the oracle's dump_canonical output. */
export const payloadDump = (fs: {
  childFolders(p: string): string[];
  childFiles(p: string): string[];
  readFile(p: string): Uint8Array;
}): Record<string, { blake3: string; len: number }> => {
  const out: Record<string, { blake3: string; len: number }> = {};
  const walk = (path: string) => {
    for (const name of fs.childFiles(path)) {
      const p = path === '' ? name : `${path}/${name}`;
      const content = fs.readFile(p);
      out[p] = { blake3: bytesToHex(blake3(content)), len: content.length };
    }
    for (const name of fs.childFolders(path))
      walk(path === '' ? name : `${path}/${name}`);
  };
  walk('');
  return out;
};

export const CAKE_UUID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
export const BOB_UUID = '00112233-4455-6677-8899-aabbccddeeff';

export const exampleBrickSave: WriteSaveObject = {
  description: 'Example World',
  bricks: [
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [0, 0, 6],
      color: [255, 0, 0],
    },
  ],
};

export const featuresSave: WriteSaveObject = {
  description: 'Feature fixture',
  brick_assets: ['PB_DefaultBrick', 'PB_DefaultTile', 'B_2x2_Overhang'],
  materials: ['BMC_Plastic', 'BMC_Metallic', 'BMC_Glow'],
  brick_owners: [
    { id: CAKE_UUID, name: 'cake', display_name: 'Cake' },
    { id: BOB_UUID, name: 'bob', display_name: 'Bob' },
  ],
  bricks: [
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [0, 0, 6],
      color: [255, 0, 0],
      owner_index: 1,
    },
    {
      asset_name_index: 1,
      size: [10, 10, 2],
      position: [20, 0, 2],
      color: [0, 255, 0],
      owner_index: 1,
      material_index: 1,
      material_intensity: 7,
      direction: 0,
      rotation: 1,
    },
    {
      asset_name_index: 1,
      size: [10, 10, 2],
      position: [40, 0, 2],
      color: [0, 0, 255],
      owner_index: 2,
    },
    {
      asset_name_index: 1,
      size: [20, 20, 2],
      position: [80, 0, 2],
      color: [255, 255, 0],
      owner_index: 2,
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [100, 0, 6],
      color: [255, 255, 255],
      owner_index: 1,
    },
    {
      asset_name_index: 2,
      size: [0, 0, 0],
      position: [200, 0, 10],
      color: [128, 64, 32],
      material_index: 2,
      material_intensity: 3,
      direction: 3,
      rotation: 2,
      collision: { player: false },
    },
    {
      asset_name_index: 0,
      size: [2, 2, 2],
      position: [300, 0, 2],
      color: [10, 20, 30],
      owner_index: 1,
      visibility: false,
      collision: {
        player: false,
        weapon: false,
        interaction: false,
        physics: false,
      },
    },
  ],
};

export const chunksSave: WriteSaveObject = {
  description: 'Chunk fixture',
  bricks: [
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [0, 0, 0],
      color: [1, 2, 3],
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [-1, -1, -1],
      color: [4, 5, 6],
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [2048, 0, 0],
      color: [1, 2, 3],
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [-2048, 4096, 10],
      color: [10, 11, 12],
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [500, 500, 500],
      color: [42, 42, 42],
    },
    {
      asset_name_index: 0,
      size: [5, 5, 6],
      position: [2548, 500, 500],
      color: [42, 42, 42],
    },
  ],
};
