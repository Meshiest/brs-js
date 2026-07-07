import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Fixtures are generated artifacts and never committed. Run `just fixtures`
// to (re)generate them.
const FIXTURES_DIR = new URL('../fixtures/brdb/', import.meta.url);
export const hasFixtures = existsSync(FIXTURES_DIR);

const fixture = (name: string) => readFileSync(new URL(name, FIXTURES_DIR));

const WORLDS = [
  'brick',
  'chunks',
  'components',
  'entities',
  'features',
  'spawner',
  'wires',
];

describe.skipIf(!hasFixtures)('brdb fixtures (run `just fixtures`)', () => {
  test('generated brdb fixtures look sane', () => {
    for (const name of WORLDS) {
      for (const suffix of ['.brz', '_raw.brz']) {
        const data = fixture(name + suffix);
        // "BRZ" magic + version 0
        expect(Array.from(data.subarray(0, 4))).toEqual([
          0x42, 0x52, 0x5a, 0x00,
        ]);
      }
      // SQLite header magic: "SQLite format 3\0"
      const db = fixture(`${name}.brdb`);
      expect(new TextDecoder().decode(db.subarray(0, 15))).toBe(
        'SQLite format 3'
      );
      expect(db[15]).toBe(0);
    }
    const hashes = JSON.parse(fixture('hashes.json').toString('utf8'));
    expect(Object.keys(hashes).sort()).toEqual(WORLDS);
    expect(Object.keys(hashes.brick)).toHaveLength(15);
    for (const entry of Object.values<any>(hashes.brick)) {
      expect(entry.blake3).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.len).toBeGreaterThanOrEqual(0);
    }
    // the chunks fixture's dedup pair shares a hash
    expect(
      hashes.chunks['World/0/Bricks/Grids/1/Chunks/0_0_0.mps'].blake3
    ).toBe(hashes.chunks['World/0/Bricks/Grids/1/Chunks/1_0_0.mps'].blake3);
    // 9 binary schemas
    const schemaBin = fixture('schemas/BRSavedBrickChunkSoA.bin');
    expect(schemaBin[0]).toBe(0x93); // fixarray(3): [enums, variants, structs]
  });
});
