import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Brdb } from '../../src/brdb/brdb';
import { BrzReader } from '../../src/brdb/brz';
import { file, folder, PendingEntry } from '../../src/brdb/pending';
import { MAIN_GRID, WorldReader } from '../../src/brdb/reader';
import { writeBrzLegacy } from '../../src/brdb/world';
import { dump, featuresSave } from './fixtures';

// vitest cannot execute the production dynamic-import path; supply the
// engine it already imported statically.
Brdb.engineLoader = async () => Database;

const mem = (createdAt = 1000) =>
  Brdb.init(new Database(':memory:'), createdAt);

describe('Brdb container core', () => {
  test('init creates the schema and the initial revision', () => {
    const db = mem(42);
    expect(db.revisions()).toEqual([
      { revisionId: 1, description: 'Initial Revision', createdAt: 42 },
    ]);
    expect(db.sqliteSchema()).toContain('CREATE TABLE blobs');
    expect(db.sqliteSchema()).toContain(
      'CREATE INDEX files_parent_name_deleted'
    );
  });

  test('required-table guard names the missing table', () => {
    expect(() => new Brdb(new Database(':memory:'))).toThrow(
      "missing required table 'blobs'"
    );
  });

  test('insertBlob dedups by hash and size', () => {
    const db = mem();
    const content = new TextEncoder().encode('hello brdb');
    const hash = new Uint8Array(32).fill(7); // caller-supplied hash is trusted
    const a = db.insertBlob(content, hash, null);
    const b = db.insertBlob(content, hash, null);
    expect(b).toBe(a);
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({
      n: 1,
    });
    const blob = db.findBlob(a);
    expect(blob.compression).toBe(0);
    expect(blob.sizeCompressed).toBe(blob.sizeUncompressed);
    expect(new Uint8Array(blob.content)).toEqual(content);
  });

  test('insertBlob keeps compressed content only when strictly smaller', () => {
    const db = mem();
    const content = new Uint8Array(100).fill(1);
    const smaller = db.insertBlob(
      content,
      new Uint8Array(32).fill(1),
      () => new Uint8Array(10)
    );
    expect(db.findBlob(smaller).compression).toBe(1);
    expect(db.findBlob(smaller).sizeCompressed).toBe(10);
    const equal = db.insertBlob(
      new Uint8Array(100).fill(2),
      new Uint8Array(32).fill(2),
      d => new Uint8Array(d.length)
    );
    expect(db.findBlob(equal).compression).toBe(0);
    const refused = db.insertBlob(
      new Uint8Array(100).fill(3),
      new Uint8Array(32).fill(3),
      () => null
    );
    expect(db.findBlob(refused).compression).toBe(0);
  });

  test('find/insert/delete file and folder rows', () => {
    const db = mem();
    const f = db.insertFolder('World', null, 100);
    expect(db.findFolder(null, 'World')).toBe(f);
    expect(db.findFolder(null, 'Nope')).toBeNull();
    const blobId = db.insertBlob(new Uint8Array([1]), new Uint8Array(32), null);
    db.insertFile('a.bin', f, blobId, 100);
    expect(db.findFile(f, 'a.bin')).toEqual({
      contentId: blobId,
      createdAt: 100,
    });
    const found = db.findFile(f, 'a.bin')!;
    db.deleteFile(
      Number(
        (db.db.prepare('SELECT file_id AS id FROM files').get() as any).id
      ),
      200
    );
    expect(db.findFile(f, 'a.bin')).toBeNull();
    expect(db.findFileAtRevision(f, 'a.bin', 150)).toEqual(found);
    expect(db.findFileAtRevision(f, 'a.bin', 250)).toBeNull();
    expect(db.findFileAtRevision(f, 'a.bin', 50)).toBeNull();
  });

  test('findFileByPathAtRevision tolerates a folder stamped after its files', () => {
    // Real crate-written worlds stamp a freshly inserted folder with the
    // wall clock mid-transaction, so a folder's created_at can be LATER
    // than the files it contains (whose created_at is the revision
    // timestamp captured once at transaction start). Reproduce that skew
    // directly: the file's created_at (1100) predates its parent folder's
    // (1101).
    const db = mem(1000);
    const root = db.insertFolder('World', null, 1000);
    const entities = db.insertFolder('Entities', root, 1101);
    const blobId = db.insertBlob(new Uint8Array([1]), new Uint8Array(32), null);
    db.insertFile('ChunkIndex.schema', entities, blobId, 1100);
    expect(
      db.findFileByPathAtRevision('World/Entities/ChunkIndex.schema', 1100)
    ).toEqual({ contentId: blobId, createdAt: 1100 });
  });

  test('findFileByPathAtRevision keeps the soft-delete improvement', () => {
    // A normal (unskewed) ancestor folder that is soft-deleted AFTER `date`
    // must still resolve a file that was live at `date`.
    const db = mem(1000);
    const root = db.insertFolder('World', null, 1000);
    const entities = db.insertFolder('Entities', root, 1000);
    const blobId = db.insertBlob(new Uint8Array([1]), new Uint8Array(32), null);
    db.insertFile('ChunkIndex.schema', entities, blobId, 1100);
    db.deleteFolder(entities, 1200);
    expect(
      db.findFileByPathAtRevision('World/Entities/ChunkIndex.schema', 1100)
    ).toEqual({ contentId: blobId, createdAt: 1100 });
    expect(
      db.findFileByPathAtRevision('World/Entities/ChunkIndex.schema', 1250)
    ).toBeNull();
  });
});

const enc = (s: string) => new TextEncoder().encode(s);

const tree = (dataContent = 'v1'): PendingEntry[] => [
  ['Meta', folder([['Bundle.json', file(enc('{"a":1}'))]])],
  ['World', folder([['0', folder([['data.bin', file(enc(dataContent))]])]])],
];

const count = (db: Brdb, table: string) =>
  Number((db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);

describe('Brdb.writePending', () => {
  test('first write inserts the tree under one revision', () => {
    const db = mem(1000);
    db.writePending('first', tree(), { createdAt: 1100 });
    expect(count(db, 'folders')).toBe(3); // Meta, World, 0
    expect(count(db, 'files')).toBe(2);
    expect(count(db, 'blobs')).toBe(2);
    expect(db.revisions().map(r => r.description)).toEqual([
      'Initial Revision',
      'first',
    ]);
    expect(db.childFolders('')).toEqual(['Meta', 'World']);
    expect(db.childFolders('World')).toEqual(['0']);
    expect(db.childFiles('World/0')).toEqual(['data.bin']);
  });

  test('rewriting identical content is a noop (no new rows)', () => {
    const db = mem(1000);
    db.writePending('first', tree(), { createdAt: 1100 });
    db.writePending('second', tree(), { createdAt: 1200 });
    expect(count(db, 'files')).toBe(2);
    expect(count(db, 'blobs')).toBe(2);
    expect(count(db, 'revisions')).toBe(3);
  });

  test('a changed file is soft-deleted and reinserted', () => {
    const db = mem(1000);
    db.writePending('first', tree('v1'), { createdAt: 1100 });
    db.writePending('second', tree('v2'), { createdAt: 1200 });
    expect(count(db, 'files')).toBe(3); // old data.bin row + new one
    expect(count(db, 'blobs')).toBe(3);
    const old = db.findFileByPathAtRevision('World/0/data.bin', 1150)!;
    const cur = db.findFileByPath('World/0/data.bin')!;
    expect(old.contentId).not.toBe(cur.contentId);
    expect(old.createdAt).toBe(1100);
    expect(cur.createdAt).toBe(1200);
  });

  test('entries absent from pending are soft-deleted recursively', () => {
    const db = mem(1000);
    db.writePending('first', tree(), { createdAt: 1100 });
    db.writePending('second', [tree()[0]], { createdAt: 1200 }); // Meta only
    expect(db.childFolders('')).toEqual(['Meta']);
    expect(db.findFileByPath('World/0/data.bin')).toBeNull();
    // still visible at its live interval
    expect(
      db.findFileByPathAtRevision('World/0/data.bin', 1150)
    ).not.toBeNull();
    expect(db.findFileByPathAtRevision('World/0/data.bin', 1250)).toBeNull();
  });

  test('duplicate names and structure mismatches throw', () => {
    const db = mem(1000);
    expect(() =>
      db.writePending('dup', [
        ['x', file(enc('1'))],
        ['x', file(enc('2'))],
      ])
    ).toThrow(/duplicate name 'x'/);
    const db2 = mem(1000);
    db2.writePending('first', [['x', file(enc('1'))]], { createdAt: 1100 });
    expect(() =>
      db2.writePending('clash', [['x', folder([])]], { createdAt: 1200 })
    ).toThrow(/'x'/);
  });

  test('the original error propagates even when ROLLBACK itself fails', () => {
    // Simulate SQLite auto-rolling back the transaction before the catch
    // block runs its own explicit ROLLBACK (e.g. SQLITE_FULL/IOERR): the
    // explicit ROLLBACK then fails with an unrelated error, which must not
    // mask the original one.
    const db = mem(1000);
    let rollbackCalls = 0;
    const originalExec = db.db.exec.bind(db.db);
    (db.db as any).exec = (sql: string) => {
      if (sql === 'ROLLBACK') {
        rollbackCalls++;
        throw new Error('cannot rollback - no transaction is active');
      }
      return originalExec(sql);
    };
    expect(() =>
      db.writePending('dup', [
        ['x', file(enc('1'))],
        ['x', file(enc('2'))],
      ])
    ).toThrow(/duplicate name 'x'/);
    expect(rollbackCalls).toBe(1);
  });

  test('toPending round-trips the current tree', () => {
    const db = mem(1000);
    db.writePending('first', tree(), { createdAt: 1100 });
    const db2 = mem(2000);
    db2.writePending('import', db.toPending(), { createdAt: 2100 });
    expect(db2.childFiles('Meta')).toEqual(['Bundle.json']);
    expect(new TextDecoder().decode(db2.readFile('World/0/data.bin'))).toBe(
      'v1'
    );
  });
});

describe('Brdb world API', () => {
  test('save + worldReader equals the .brz path', async () => {
    const db = await Brdb.memory();
    db.save('test', featuresSave);
    expect(dump(db.worldReader())).toEqual(
      dump(WorldReader.from(writeBrzLegacy(featuresSave)))
    );
  });

  test('brz to brdb conversion preserves every payload', async () => {
    const bytes = writeBrzLegacy(featuresSave);
    const brz = BrzReader.from(bytes);
    const pendingFrom = (
      fs: {
        childFolders(p: string): string[];
        childFiles(p: string): string[];
        readFile(p: string): Uint8Array;
      },
      path = ''
    ): PendingEntry[] => [
      ...fs.childFolders(path).map(
        (name): PendingEntry => [
          name,
          {
            type: 'folder',
            children: pendingFrom(fs, path === '' ? name : `${path}/${name}`),
          },
        ]
      ),
      ...fs.childFiles(path).map(
        (name): PendingEntry => [
          name,
          {
            type: 'file',
            content: fs.readFile(path === '' ? name : `${path}/${name}`),
          },
        ]
      ),
    ];
    const db = await Brdb.memory();
    db.writePending('import', pendingFrom(brz));
    expect(dump(db.worldReader())).toEqual(dump(WorldReader.from(bytes)));
  });

  test('toBytes + fromBytes round-trips', async () => {
    const db = await Brdb.memory();
    db.save('test', featuresSave);
    const db2 = await Brdb.fromBytes(db.toBytes());
    expect(dump(db2.worldReader())).toEqual(dump(db.worldReader()));
  });

  test('openers apply zstd level 14 by default; compress null stores raw', async () => {
    const db = await Brdb.memory();
    db.save('test', featuresSave);
    const rows = db.db
      .prepare(
        'SELECT compression, size_compressed, size_uncompressed FROM blobs'
      )
      .all() as any[];
    expect(rows.some(r => r.compression === 1)).toBe(true);
    for (const r of rows.filter(r => r.compression === 1))
      expect(r.size_compressed).toBeLessThan(r.size_uncompressed);
    // and the compressed payloads decode fine
    expect(dump(db.worldReader()).grids['1']).toHaveLength(7);

    const raw = await Brdb.memory();
    raw.save('test', featuresSave, { compress: null });
    const rawRows = raw.db
      .prepare('SELECT compression FROM blobs')
      .all() as any[];
    expect(rawRows.every(r => r.compression === 0)).toBe(true);
  });

  test('open/create/openOrCreate against real files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
    const path = join(dir, 'world.brdb');
    const created = await Brdb.openOrCreate(path);
    created.save('test', featuresSave);
    created.close();
    const reopened = await Brdb.openOrCreate(path);
    expect(reopened.revisions()).toHaveLength(2);
    const readonly = await Brdb.openReadonly(path);
    expect(dump(readonly.worldReader()).brickAssets).toEqual(
      dump(WorldReader.from(writeBrzLegacy(featuresSave))).brickAssets
    );
    expect(() => readonly.save('nope', featuresSave)).toThrow();
  });

  test('open() on a nonexistent path rejects and leaves no file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
    const missing = join(dir, 'missing.brdb');
    await expect(Brdb.open(missing)).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    // openOrCreate must still take the create branch afterward (no stray
    // empty file left behind to poison it)
    const fresh = await Brdb.openOrCreate(missing);
    expect(fresh.revisions()).toHaveLength(1);
    fresh.close();
  });

  test('openReadonly() on a nonexistent path rejects and leaves no file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
    const missing = join(dir, 'missing-ro.brdb');
    await expect(Brdb.openReadonly(missing)).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  test('a failed construction closes the underlying handle', async () => {
    // A path whose file exists but is not a valid brdb container: the
    // required-table guard throws inside the Brdb constructor. The handle
    // must still be closed (not leaked), otherwise the file stays locked
    // (on Windows, an open handle blocks deletion of its own file).
    const dir = mkdtempSync(join(tmpdir(), 'brs-js-brdb-'));
    const path = join(dir, 'not-a-container.brdb');
    new Database(path).close(); // an empty, valid-but-schema-less sqlite file
    await expect(Brdb.open(path)).rejects.toThrow(/missing required table/);
    expect(() => rmSync(path)).not.toThrow();
  });

  test('fromBytes on garbage bytes rejects', async () => {
    await expect(
      Brdb.fromBytes(new Uint8Array([1, 2, 3, 4]))
    ).rejects.toThrow();
  });
});

describe('revision-aware schema pairing (P4)', () => {
  const POINT_LIGHT = 'Component_PointLight';
  const INTERACT = 'Component_Interact';
  const brick = (x: number, components: any[]) => ({
    size: [5, 5, 6] as [number, number, number],
    position: [x, 0, 6] as [number, number, number],
    components: components,
  });

  test('unchanged chunks decode with their original schema revision', async () => {
    const db = await Brdb.memory();
    // Revision A: PointLight in chunk (0,0,0) and in far chunk (2,0,0).
    db.save(
      'A',
      {
        bricks: [
          brick(0, [{ type: POINT_LIGHT, data: { Brightness: 100 } }]),
          brick(4096, [{ type: POINT_LIGHT, data: { Brightness: 200 } }]),
        ],
      },
      { createdAt: 100 }
    );
    // Revision B: chunk (0,0,0) byte-identical (noop, keeps createdAt 100);
    // the far brick gains an Interact component, which changes GlobalData,
    // the far chunk, and ComponentsShared.schema (a new extracted struct).
    db.save(
      'B',
      {
        bricks: [
          brick(0, [{ type: POINT_LIGHT, data: { Brightness: 100 } }]),
          brick(4096, [
            { type: POINT_LIGHT, data: { Brightness: 250 } },
            { type: INTERACT, data: { Message: 'hi' } },
          ]),
        ],
      },
      { createdAt: 200 }
    );

    const schemaPath = 'World/0/Bricks/ComponentsShared.schema';
    // the unchanged component chunk still carries revision A's timestamp...
    expect(
      db.findFileByPath('World/0/Bricks/Grids/1/Components/0_0_0.mps')!
        .createdAt
    ).toBe(100);
    // ...and two schema revisions exist for the shared components schema
    expect(db.findFileByPathAtRevision(schemaPath, 100)!.contentId).not.toBe(
      db.findFileByPathAtRevision(schemaPath, 200)!.contentId
    );

    const reader = db.worldReader();
    const chunkA = reader.componentChunk(MAIN_GRID, { x: 0, y: 0, z: 0 });
    expect(chunkA.components).toHaveLength(1);
    expect((chunkA.components[0].data as any).Brightness).toBe(100);
    const chunkB = reader.componentChunk(MAIN_GRID, { x: 2, y: 0, z: 0 });
    expect(chunkB.components.map(c => c.typeName)).toEqual([
      POINT_LIGHT,
      INTERACT,
    ]);
    // the reader cached one schema object per revision
    const keys = [...(reader as any).schemas.keys()].filter((k: string) =>
      k.startsWith(`${schemaPath}@`)
    );
    expect(keys.sort()).toEqual([`${schemaPath}@100`, `${schemaPath}@200`]);
  });
});
