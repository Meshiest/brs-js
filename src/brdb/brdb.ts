// .brdb container: the same virtual filesystem as .brz, stored in SQLite
// with content-addressed blobs and soft-delete revision history. This module
// is engine-free: it speaks to any handle satisfying BrdbSqlite (better-
// sqlite3 does structurally). The static openers below lazily load
// better-sqlite3 so the web bundle never needs it.
import { blake3 } from '@noble/hashes/blake3.js';
import { decompress as zstdDecompress } from 'fzstd';
import type { Compressor } from './brz';
import type { FoundFile, WorldFs } from './fs';
import type { PendingEntry, PendingNode } from './pending';
import { WorldReader } from './reader';
import { saveToPendingFs, WriteBrzInput, WriteBrzOptions } from './world';

export interface BrdbStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface BrdbSqlite {
  exec(sql: string): unknown;
  prepare(sql: string): BrdbStatement;
  close(): void;
}

export interface BrdbBlob {
  blobId: number;
  compression: number;
  sizeUncompressed: number;
  sizeCompressed: number;
  deltaBaseId: number | null;
  hash: Uint8Array;
  content: Uint8Array;
}

export interface BrdbRevision {
  revisionId: number;
  description: string;
  createdAt: number;
}

export interface WritePendingOptions {
  /** Revision timestamp in unix seconds. Defaults to the wall clock. */
  createdAt?: number;
  /** Blob compressor. undefined uses the instance default (zstd level 14
   * when opened through the lazy openers); null stores raw. */
  compress?: Compressor | null;
}

// The exact statement text matters: SQLite stores CREATE statements verbatim
// in sqlite_schema, and the parity suite compares this against databases
// created by the reference implementation (whose DDL indents columns with
// four tabs and closing parens with three).
const C = '\n\t\t\t\t';
const E = '\n\t\t\t';
export const BRDB_SQLITE_SCHEMA =
  `CREATE TABLE blobs (${C}blob_id INTEGER PRIMARY KEY,${C}compression INTEGER,` +
  `${C}size_uncompressed INTEGER,${C}size_compressed INTEGER,` +
  `${C}delta_base_id INTEGER REFERENCES blobs(blob_id),${C}hash BLOB,` +
  `${C}content BLOB${E});\n` +
  `CREATE TABLE revisions (${C}revision_id INTEGER PRIMARY KEY,` +
  `${C}description TEXT,${C}created_at INTEGER${E});\n` +
  `CREATE TABLE folders (${C}folder_id INTEGER PRIMARY KEY,` +
  `${C}parent_id INTEGER REFERENCES folders(folder_id),${C}name TEXT,` +
  `${C}created_at INTEGER,${C}deleted_at INTEGER${E});\n` +
  `CREATE TABLE files (${C}file_id INTEGER PRIMARY KEY,` +
  `${C}parent_id INTEGER REFERENCES folders(folder_id),${C}name TEXT,` +
  `${C}content_id INTEGER REFERENCES blobs(blob_id),${C}created_at INTEGER,` +
  `${C}deleted_at INTEGER${E});\n` +
  'CREATE INDEX blobs_size_hash ON blobs(size_uncompressed, hash);\n' +
  'CREATE INDEX folders_parent_name_deleted ON folders(parent_id, name, deleted_at);\n' +
  'CREATE INDEX files_parent_name_deleted ON files(parent_id, name, deleted_at);';

const REQUIRED_TABLES = ['blobs', 'revisions', 'folders', 'files'] as const;

const now = () => Math.floor(Date.now() / 1000);

// src/ stays isomorphic (no @types/node), so Buffer has no ambient type here.
// This module-local declaration describes just enough of the real Node global
// to type the guarded access below; it shadows (does not conflict with) the
// full Node typing that test/tsconfig.json brings in for the test suite.
declare const Buffer:
  | {
      from(
        data: ArrayBufferLike | Uint8Array,
        byteOffset?: number,
        length?: number
      ): Uint8Array;
    }
  | undefined;

/** Bind bytes as a BLOB parameter. better-sqlite3 requires Buffer; when
 * unavailable (browser engines), pass the Uint8Array through. */
const asBlob = (bytes: Uint8Array): Uint8Array =>
  typeof Buffer === 'undefined'
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

declare const process: { getBuiltinModule?(name: string): any } | undefined;

/** A node builtin without any import machinery (bundler inert and safe
 * under test runners that cannot compile dynamic import at runtime).
 * Null outside node or below Node 22.3. */
const builtin = (name: string): any => {
  try {
    return typeof process !== 'undefined'
      ? process?.getBuiltinModule?.(name) ?? null
      : null;
  } catch {
    return null;
  }
};

/** Dynamic import kept opaque so bundlers never try to resolve engine or
 * node-builtin specifiers; the web bundle stays SQLite-free. Constructed
 * lazily so merely loading the library never evaluates code under a CSP
 * that bans eval. */
let dynamicImport: ((specifier: string) => Promise<any>) | null = null;
const loadModule = (specifier: string): Promise<any> => {
  dynamicImport ??= new Function(
    'specifier',
    'return import(specifier)'
  ) as any;
  return dynamicImport!(specifier);
};

interface SerializableSqlite extends BrdbSqlite {
  serialize(): Uint8Array;
}

async function engine(): Promise<
  new (
    source: string | Uint8Array,
    options?: { readonly?: boolean; fileMustExist?: boolean }
  ) => SerializableSqlite
> {
  try {
    const mod: any = await (
      Brdb.engineLoader ?? (() => loadModule('better-sqlite3'))
    )();
    return mod.default ?? mod;
  } catch {
    throw new Error(
      'brdb: the Brdb openers require better-sqlite3 (npm install better-sqlite3), or wrap your own handle with new Brdb(db)'
    );
  }
}

function nodeZstd(): Compressor | null {
  const zlib = builtin('node:zlib');
  if (typeof zlib?.zstdCompressSync !== 'function') return null;
  const level = zlib.constants.ZSTD_c_compressionLevel;
  return data =>
    new Uint8Array(zlib.zstdCompressSync(data, { params: { [level]: 14 } }));
}

export class Brdb implements WorldFs {
  /** Override how the better-sqlite3 module is resolved. Useful when a
   * bundler or test runner cannot execute a native dynamic import. */
  static engineLoader: (() => Promise<unknown>) | null = null;

  /** zstd compressor applied to new blobs when no per-write compressor is
   * given. The lazy openers set this; a directly-wrapped handle has none. */
  defaultCompress: Compressor | null = null;

  constructor(readonly db: BrdbSqlite) {
    for (const t of REQUIRED_TABLES) {
      const row = this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?"
        )
        .get(t);
      if (!row) throw new Error(`brdb: missing required table '${t}'`);
    }
  }

  /** Create-container semantics on any handle: run the DDL and stamp the
   * initial revision. */
  static init(db: BrdbSqlite, createdAt: number = now()): Brdb {
    db.exec(BRDB_SQLITE_SCHEMA);
    const brdb = new Brdb(db);
    brdb.createRevision('Initial Revision', createdAt);
    return brdb;
  }

  /** Construct create/open semantics on a handle, closing it if construction
   * (the DDL or the required-table guard) throws so a failed opener never
   * leaks the underlying handle (and, on Windows, never leaves it locked). */
  private static async wrap(db: BrdbSqlite, init: boolean): Promise<Brdb> {
    try {
      const brdb = init ? Brdb.init(db) : new Brdb(db);
      brdb.defaultCompress = nodeZstd();
      return brdb;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Open an existing database file. Rejects (without creating a file) when
   * the path does not already exist. */
  static async open(path: string): Promise<Brdb> {
    return Brdb.wrap(
      new (await engine())(path, { fileMustExist: true }),
      false
    );
  }

  /** Open an existing database file read-only. Rejects (without creating a
   * file) when the path does not already exist. */
  static async openReadonly(path: string): Promise<Brdb> {
    return Brdb.wrap(
      new (await engine())(path, { readonly: true, fileMustExist: true }),
      false
    );
  }

  /** Create a new database file (container schema + initial revision). */
  static async create(path: string): Promise<Brdb> {
    return Brdb.wrap(new (await engine())(path), true);
  }

  /** Open the file if it exists, otherwise create it. */
  static async openOrCreate(path: string): Promise<Brdb> {
    const fs = builtin('node:fs');
    if (!fs)
      throw new Error(
        'brdb: openOrCreate requires node 22.3 or newer; call open or create explicitly'
      );
    return fs.existsSync(path) ? Brdb.open(path) : Brdb.create(path);
  }

  /** New in-memory database. */
  static async memory(): Promise<Brdb> {
    return Brdb.wrap(new (await engine())(':memory:'), true);
  }

  /** Open a database from serialized bytes. */
  static async fromBytes(bytes: Uint8Array): Promise<Brdb> {
    return Brdb.wrap(new (await engine())(Buffer.from(bytes)), false);
  }

  /** Serialize the database to bytes (requires a better-sqlite3 handle). */
  toBytes(): Uint8Array {
    const serialize = (this.db as Partial<SerializableSqlite>).serialize;
    if (typeof serialize !== 'function')
      throw new Error(
        'brdb: toBytes requires a better-sqlite3 database handle'
      );
    return new Uint8Array(serialize.call(this.db));
  }

  /** Write a world save as one revision. */
  save(
    description: string,
    save: WriteBrzInput,
    options: Omit<WriteBrzOptions, 'compress'> & WritePendingOptions = {}
  ): void {
    this.writePending(description, saveToPendingFs(save, options), options);
  }

  /** Lazy world reader over this database (same surface as .brz reading).
   * The reader caches decoded metadata (GlobalData, Owners, Bundle/World
   * JSON) for its lifetime; if this Brdb is written to (save/writePending)
   * after the reader is created, construct a fresh worldReader() rather
   * than reusing the old one, or later reads may mix stale cached metadata
   * with newly written chunk data. */
  worldReader(): WorldReader {
    return new WorldReader(this);
  }

  sqliteSchema(): string {
    return (this.db.prepare('SELECT sql FROM sqlite_schema').all() as any[])
      .map(r => r.sql)
      .join('\n');
  }

  createRevision(description: string, createdAt: number = now()): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO revisions (description, created_at) VALUES (?, ?);'
        )
        .run(description, createdAt).lastInsertRowid
    );
  }

  revisions(): BrdbRevision[] {
    return (
      this.db
        .prepare(
          'SELECT revision_id, description, created_at FROM revisions ORDER BY revision_id;'
        )
        .all() as any[]
    ).map(r => ({
      revisionId: Number(r.revision_id),
      description: String(r.description),
      createdAt: Number(r.created_at),
    }));
  }

  insertFolder(
    name: string,
    parentId: number | null,
    createdAt: number
  ): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO folders (name, parent_id, created_at) VALUES (?, ?, ?);'
        )
        .run(name, parentId, createdAt).lastInsertRowid
    );
  }

  insertFile(
    name: string,
    parentId: number | null,
    contentId: number,
    createdAt: number
  ): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO files (name, parent_id, content_id, created_at) VALUES (?, ?, ?, ?);'
        )
        .run(name, parentId, contentId, createdAt).lastInsertRowid
    );
  }

  /** Insert a blob (dedup by hash + uncompressed size), compressing when the
   * compressor yields something strictly smaller. */
  insertBlob(
    content: Uint8Array,
    hash: Uint8Array,
    compress: Compressor | null
  ): number {
    const existing = this.findBlobByHash(content.length, hash);
    if (existing) return existing.blobId;
    const sizeUncompressed = content.length;
    let sizeCompressed = sizeUncompressed;
    let compression = 0;
    let stored = content;
    const compressed = compress ? compress(content) : null;
    if (compressed && compressed.length < sizeUncompressed) {
      sizeCompressed = compressed.length;
      compression = 1;
      stored = compressed;
    }
    return Number(
      this.db
        .prepare(
          'INSERT INTO blobs (compression, size_uncompressed, size_compressed, delta_base_id, hash, content) VALUES (?, ?, ?, ?, ?, ?);'
        )
        .run(
          compression,
          sizeUncompressed,
          sizeCompressed,
          null,
          asBlob(hash),
          asBlob(stored)
        ).lastInsertRowid
    );
  }

  findBlobByHash(size: number, hash: Uint8Array): BrdbBlob | null {
    const row = this.db
      .prepare(
        'SELECT blob_id, compression, size_uncompressed, size_compressed, delta_base_id, hash, content FROM blobs WHERE hash = ? AND size_uncompressed = ? LIMIT 1;'
      )
      .get(asBlob(hash), size);
    return row ? rowToBlob(row) : null;
  }

  findBlob(contentId: number): BrdbBlob {
    const row = this.db
      .prepare(
        'SELECT blob_id, compression, size_uncompressed, size_compressed, delta_base_id, hash, content FROM blobs WHERE blob_id = ?;'
      )
      .get(contentId);
    if (!row) throw new Error(`brdb: blob ${contentId} not found`);
    return rowToBlob(row);
  }

  deleteFile(fileId: number, deletedAt: number): void {
    this.db
      .prepare('UPDATE files SET deleted_at = ? WHERE file_id = ?;')
      .run(deletedAt, fileId);
  }

  deleteFolder(folderId: number, deletedAt: number): void {
    this.db
      .prepare('UPDATE folders SET deleted_at = ? WHERE folder_id = ?;')
      .run(deletedAt, folderId);
  }

  findFolder(parentId: number | null, name: string): number | null {
    const row = this.db
      .prepare(
        `SELECT folder_id FROM folders WHERE parent_id ${
          parentId === null ? 'IS NULL' : '= ?'
        } AND name = ? AND deleted_at IS NULL;`
      )
      .get(...(parentId === null ? [name] : [parentId, name]));
    return row ? Number((row as any).folder_id) : null;
  }

  /** Like findFolder, but resolves against the tree as of a revision date
   * instead of the current tree. Used by findFileByPathAtRevision so an
   * ancestor folder that was soft-deleted after `date` does not hide a file
   * that was still live at `date`. */
  findFolderAtRevision(
    parentId: number | null,
    name: string,
    date: number
  ): number | null {
    const row = this.db
      .prepare(
        `SELECT folder_id FROM folders WHERE parent_id ${
          parentId === null ? 'IS NULL' : '= ?'
        } AND name = ? AND created_at <= ? AND (deleted_at IS NULL OR deleted_at > ?) ORDER BY created_at ASC LIMIT 1;`
      )
      .get(
        ...(parentId === null
          ? [name, date, date]
          : [parentId, name, date, date])
      );
    return row ? Number((row as any).folder_id) : null;
  }

  findFile(parentId: number | null, name: string): FoundFile | null {
    const row = this.db
      .prepare(
        `SELECT content_id, created_at FROM files WHERE parent_id ${
          parentId === null ? 'IS NULL' : '= ?'
        } AND name = ? AND deleted_at IS NULL;`
      )
      .get(...(parentId === null ? [name] : [parentId, name]));
    return row ? rowToFound(row) : null;
  }

  findFileAtRevision(
    parentId: number | null,
    name: string,
    date: number
  ): FoundFile | null {
    const row = this.db
      .prepare(
        `SELECT content_id, created_at FROM files WHERE parent_id ${
          parentId === null ? 'IS NULL' : '= ?'
        } AND name = ? AND created_at <= ? AND (deleted_at IS NULL OR deleted_at > ?) ORDER BY created_at ASC LIMIT 1;`
      )
      .get(
        ...(parentId === null
          ? [name, date, date]
          : [parentId, name, date, date])
      );
    return row ? rowToFound(row) : null;
  }

  close(): void {
    this.db.close();
  }

  /** Merge a COMPLETE pending tree against the current tree in one
   * transaction: identical files are noops, changed files are soft-deleted
   * and reinserted, and existing entries absent from the pending tree are
   * soft-deleted recursively. */
  writePending(
    description: string,
    pending: PendingEntry[],
    options: WritePendingOptions = {}
  ): void {
    const createdAt = options.createdAt ?? now();
    const compress =
      options.compress === undefined ? this.defaultCompress : options.compress;
    this.db.exec('BEGIN');
    try {
      this.createRevision(description, createdAt);
      this.mergeFolder(null, pending, createdAt, compress);
      this.db.exec('COMMIT');
    } catch (err) {
      // Some SQLite error classes (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM)
      // auto-rollback the transaction before the throw reaches here; an
      // explicit ROLLBACK would then fail with its own unrelated error and
      // mask the original one. Swallow that failure so `err` always wins.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // transaction already rolled back by SQLite
      }
      throw err;
    }
  }

  private currentFolders(
    parentId: number | null
  ): { folderId: number; name: string }[] {
    const stmt = this.db.prepare(
      `SELECT folder_id, name FROM folders WHERE parent_id ${
        parentId === null ? 'IS NULL' : '= ?'
      } AND deleted_at IS NULL ORDER BY name;`
    );
    const rows = (parentId === null ? stmt.all() : stmt.all(parentId)) as any[];
    return rows.map(r => ({
      folderId: Number(r.folder_id),
      name: String(r.name),
    }));
  }

  private currentFiles(
    parentId: number | null
  ): { fileId: number; name: string; contentId: number | null }[] {
    const stmt = this.db.prepare(
      `SELECT file_id, name, content_id FROM files WHERE parent_id ${
        parentId === null ? 'IS NULL' : '= ?'
      } AND deleted_at IS NULL ORDER BY name;`
    );
    const rows = (parentId === null ? stmt.all() : stmt.all(parentId)) as any[];
    return rows.map(r => ({
      fileId: Number(r.file_id),
      name: String(r.name),
      contentId: r.content_id === null ? null : Number(r.content_id),
    }));
  }

  private mergeFolder(
    parentId: number | null,
    changes: PendingEntry[],
    createdAt: number,
    compress: Compressor | null
  ): void {
    const folders = new Map(
      this.currentFolders(parentId).map(f => [f.name, f.folderId])
    );
    const files = new Map(this.currentFiles(parentId).map(f => [f.name, f]));
    const seen = new Set<string>();
    for (const [name, node] of changes) {
      if (seen.has(name))
        throw new Error(`brdb: duplicate name '${name}' in pending tree`);
      seen.add(name);
      if (node.type === 'folder') {
        if (files.has(name))
          throw new Error(
            `brdb: pending folder '${name}' collides with an existing file`
          );
        const existing = folders.get(name);
        if (existing !== undefined)
          this.mergeFolder(existing, node.children, createdAt, compress);
        else this.insertPending(name, parentId, node, createdAt, compress);
      } else {
        if (folders.has(name))
          throw new Error(
            `brdb: pending file '${name}' collides with an existing folder`
          );
        const existing = files.get(name);
        if (existing === undefined) {
          this.insertPending(name, parentId, node, createdAt, compress);
          continue;
        }
        const hash = blake3(node.content);
        const blob = this.findBlobByHash(node.content.length, hash);
        if (blob && existing.contentId === blob.blobId) continue;
        this.deleteFile(existing.fileId, createdAt);
        const contentId = this.insertBlob(node.content, hash, compress);
        this.insertFile(name, parentId, contentId, createdAt);
      }
    }
    for (const [name, folderId] of folders)
      if (!seen.has(name)) this.deleteFolderRecursive(folderId, createdAt);
    for (const [name, f] of files)
      if (!seen.has(name)) this.deleteFile(f.fileId, createdAt);
  }

  private insertPending(
    name: string,
    parentId: number | null,
    node: PendingNode,
    createdAt: number,
    compress: Compressor | null
  ): void {
    if (node.type === 'folder') {
      // The reference writer stamps freshly-inserted folders with the wall
      // clock rather than the revision timestamp; we use the revision
      // timestamp for both (content-equivalent, deterministic under an
      // injected createdAt).
      const folderId = this.insertFolder(name, parentId, createdAt);
      const seen = new Set<string>();
      for (const [childName, child] of node.children) {
        if (seen.has(childName))
          throw new Error(
            `brdb: duplicate name '${childName}' in pending tree`
          );
        seen.add(childName);
        this.insertPending(childName, folderId, child, createdAt, compress);
      }
    } else {
      const contentId = this.insertBlob(
        node.content,
        blake3(node.content),
        compress
      );
      this.insertFile(name, parentId, contentId, createdAt);
    }
  }

  private deleteFolderRecursive(folderId: number, deletedAt: number): void {
    this.deleteFolder(folderId, deletedAt);
    for (const child of this.currentFolders(folderId))
      this.deleteFolderRecursive(child.folderId, deletedAt);
    for (const f of this.currentFiles(folderId))
      this.deleteFile(f.fileId, deletedAt);
  }

  /** Resolve a folder path. '' is the root. With no date, resolves against
   * the current tree; with a date, resolves each segment against the tree
   * as of that revision (see findFolderAtRevision). */
  private folderIdOf(path: string, date?: number): number | null {
    if (path === '') return null;
    let id: number | null = null;
    for (const part of path.split('/')) {
      // Real crate-written databases stamp a freshly inserted folder with
      // the wall clock mid-transaction, so a folder's created_at can be
      // LATER than the files it contains (the revision/file timestamps are
      // captured once at transaction start). When the at-revision lookup
      // misses for that reason, fall back to the current tree so such an
      // ancestor still resolves; a folder deleted after `date` is still
      // caught by the at-revision branch first.
      const next =
        date === undefined
          ? this.findFolder(id, part)
          : this.findFolderAtRevision(id, part, date) ??
            this.findFolder(id, part);
      if (next === null) return null;
      id = next;
    }
    return id;
  }

  findFileByPath(path: string): FoundFile | null {
    if (path.startsWith('/'))
      throw new Error('brdb: absolute paths not allowed');
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const parentId = this.folderIdOf(parent);
    if (parent !== '' && parentId === null) return null;
    return this.findFile(parentId, path.slice(slash + 1));
  }

  /** Both folders and the leaf file resolve against the tree as of `date`,
   * so a file is still reachable at a date before an ancestor folder was
   * later soft-deleted. */
  findFileByPathAtRevision(path: string, date: number): FoundFile | null {
    if (path.startsWith('/'))
      throw new Error('brdb: absolute paths not allowed');
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const parentId = this.folderIdOf(parent, date);
    if (parent !== '' && parentId === null) return null;
    return this.findFileAtRevision(parentId, path.slice(slash + 1), date);
  }

  childFolders(path: string): string[] {
    const parentId = this.folderIdOf(path);
    if (path !== '' && parentId === null) return [];
    return this.currentFolders(parentId).map(f => f.name);
  }

  childFiles(path: string): string[] {
    const parentId = this.folderIdOf(path);
    if (path !== '' && parentId === null) return [];
    return this.currentFiles(parentId).map(f => f.name);
  }

  /** Decompressed blob content. Empty files (contentId -1) yield empty
   * bytes, matching the .brz reader's documented deviation. */
  readBlob(contentId: number): Uint8Array {
    if (contentId === -1) return new Uint8Array(0);
    const blob = this.findBlob(contentId);
    if (blob.deltaBaseId !== null)
      throw new Error('brdb: delta blobs are not supported');
    let content = blob.content;
    if (blob.compression === 1)
      content = zstdDecompress(content, new Uint8Array(blob.sizeUncompressed));
    else if (blob.compression !== 0)
      throw new Error(`brdb: unknown blob compression ${blob.compression}`);
    if (content.length !== blob.sizeUncompressed)
      throw new Error('brdb: blob uncompressed size mismatch');
    return content;
  }

  readFile(path: string): Uint8Array {
    const found = this.findFileByPath(path);
    if (!found) throw new Error(`brdb: file not found: ${path}`);
    return this.readBlob(found.contentId);
  }

  /** The full current tree as a pending tree (folders first, then files,
   * each in name order). */
  toPending(): PendingEntry[] {
    const walk = (parentId: number | null): PendingEntry[] => {
      const out: PendingEntry[] = [];
      for (const f of this.currentFolders(parentId))
        out.push([f.name, { type: 'folder', children: walk(f.folderId) }]);
      for (const f of this.currentFiles(parentId))
        out.push([
          f.name,
          { type: 'file', content: this.readBlob(f.contentId ?? -1) },
        ]);
      return out;
    };
    return walk(null);
  }
}

const rowToBlob = (row: any): BrdbBlob => ({
  blobId: Number(row.blob_id),
  compression: Number(row.compression),
  sizeUncompressed: Number(row.size_uncompressed),
  sizeCompressed: Number(row.size_compressed),
  deltaBaseId: row.delta_base_id === null ? null : Number(row.delta_base_id),
  hash: new Uint8Array(row.hash),
  content: new Uint8Array(row.content),
});

const rowToFound = (row: any): FoundFile => ({
  contentId: row.content_id === null ? -1 : Number(row.content_id),
  createdAt: Number(row.created_at),
});
