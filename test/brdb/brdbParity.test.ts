import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Brdb } from '../../src/brdb/brdb';
import { WorldReader } from '../../src/brdb/reader';
import { dump, featuresSave, payloadDump } from './fixtures';

// vitest cannot execute the production dynamic-import path; supply the
// engine it already imported statically.
Brdb.engineLoader = async () => Database;

const FIXTURES_DIR = new URL('../fixtures/brdb/', import.meta.url);
const hasFixtures = existsSync(FIXTURES_DIR);
const fixturePath = (name: string) =>
  fileURLToPath(new URL(name, FIXTURES_DIR));

const WORLDS = [
  'brick',
  'chunks',
  'components',
  'entities',
  'features',
  'spawner',
  'wires',
];

describe.skipIf(!hasFixtures)('rust parity: .brdb', () => {
  const hashes = () =>
    JSON.parse(
      readFileSync(new URL('hashes.json', FIXTURES_DIR), 'utf8')
    ) as Record<string, Record<string, { blake3: string; len: number }>>;

  for (const name of WORLDS) {
    test(`${name}.brdb payloads match hashes.json`, async () => {
      const db = await Brdb.open(fixturePath(`${name}.brdb`));
      expect(payloadDump(db)).toEqual(hashes()[name]);
      db.close();
    });
  }

  test('features.brdb reads like features_raw.brz through WorldReader', async () => {
    const db = await Brdb.open(fixturePath('features.brdb'));
    const brz = new Uint8Array(
      readFileSync(new URL('features_raw.brz', FIXTURES_DIR))
    );
    expect(dump(db.worldReader())).toEqual(dump(WorldReader.from(brz)));
    db.close();
  });

  test('sqlite schema parity with the crate-created database', async () => {
    const crateDb = await Brdb.open(fixturePath('features.brdb'));
    const jsDb = await Brdb.memory();
    expect(jsDb.sqliteSchema()).toBe(crateDb.sqliteSchema());
    crateDb.close();
  });

  test('write parity: same save, same tree and blob set', async () => {
    const crateDb = await Brdb.open(fixturePath('features.brdb'));
    const jsDb = await Brdb.memory();
    jsDb.save('Fixture', featuresSave);
    // identical visible tree and identical decompressed payloads
    expect(payloadDump(jsDb)).toEqual(payloadDump(crateDb));
    // identical blob identity set and dedup behavior (compressed bytes and
    // timestamps are legitimately different across zstd builds and runs)
    const blobSet = (db: Brdb) =>
      (
        db.db
          .prepare('SELECT hash, size_uncompressed FROM blobs ORDER BY hash')
          .all() as any[]
      ).map(
        r => `${Buffer.from(r.hash).toString('hex')}:${r.size_uncompressed}`
      );
    expect(blobSet(jsDb)).toEqual(blobSet(crateDb));
    const count = (db: Brdb, table: string) =>
      Number(
        (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n
      );
    expect(count(jsDb, 'blobs')).toBe(count(crateDb, 'blobs'));
    expect(count(jsDb, 'revisions')).toBe(count(crateDb, 'revisions'));
    crateDb.close();
  });
});
