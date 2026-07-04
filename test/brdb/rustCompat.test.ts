import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { Brdb, BrzReader, writeBrzLegacy } from '../../src/brdb';
import {
  chunksSave,
  exampleBrickSave,
  featuresSave,
  payloadDump,
} from './fixtures';

// vitest cannot execute the production dynamic-import path; supply the
// engine it already imported statically.
Brdb.engineLoader = async () => Database;

const CRATE = process.env.BRDB_CRATE ?? '../brdb';
const enabled = !!process.env.BRDB_ORACLE;

describe.skipIf(!enabled)('live rust oracle (set BRDB_ORACLE=1)', () => {
  for (const [name, save] of [
    ['brick', exampleBrickSave],
    ['features', featuresSave],
    ['chunks', chunksSave],
  ] as const) {
    test(`rust dump_canonical reads a js-written ${name}.brz and hashes match`, () => {
      const bytes = writeBrzLegacy(save);
      const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
      const path = join(dir, `${name}.brz`);
      writeFileSync(path, bytes);
      const out = execFileSync(
        'cargo',
        [
          'run',
          '-q',
          '--manifest-path',
          `${CRATE}/crates/brdb/Cargo.toml`,
          '--example',
          'dump_canonical',
          '--',
          path,
        ],
        { encoding: 'utf8' }
      );
      const rust: Record<string, { blake3: string; len: number }> =
        JSON.parse(out);
      const reader = BrzReader.from(bytes);
      const js: Record<string, { blake3: string; len: number }> = {};
      for (const p of reader.listPaths()) {
        const content = reader.readFile(p);
        js[p] = { blake3: bytesToHex(blake3(content)), len: content.length };
      }
      expect(Object.keys(js).sort()).toEqual(Object.keys(rust));
      for (const [p, entry] of Object.entries(rust))
        expect(js[p], p).toEqual(entry);
    });
  }

  test(
    'rust dump_canonical reads a js-written features.brdb',
    { timeout: 120000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
      const path = join(dir, 'features.brdb');
      const db = await Brdb.create(path);
      db.save('oracle', featuresSave);
      const expected = payloadDump(db);
      db.close();
      const out = execFileSync(
        'cargo',
        [
          'run',
          '-q',
          '--manifest-path',
          `${CRATE}/crates/brdb/Cargo.toml`,
          '--example',
          'dump_canonical',
          '--',
          path,
        ],
        { encoding: 'utf8' }
      );
      expect(JSON.parse(out)).toEqual(expected);
    }
  );
});
