// .brz container serializer/deserializer, byte-compatible with the game's
// archive format.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decompress as zstdDecompress } from 'fzstd';
import { ByteReader, ByteWriter } from './bytes';
import type { FoundFile, WorldFs } from './fs';
import { PendingEntry, PendingNode } from './pending';

export type Compressor = (data: Uint8Array) => Uint8Array | null;

export interface BrzContainerOptions {
  /** zstd compressor (e.g. node:zlib zstdCompressSync); return null to skip.
   * Omitted -> every blob stored raw (still a valid archive, and what the
   * byte-parity gates compare against). */
  compress?: Compressor;
}

export function writeBrzContainer(
  root: PendingEntry[],
  options: BrzContainerOptions = {}
): Uint8Array {
  interface QueueItem {
    parentId: number;
    name: string;
    node: PendingNode;
  }
  // BFS; ids are assigned when an entry is dequeued
  const queue: QueueItem[] = root.map(([name, node]) => ({
    parentId: -1,
    name,
    node,
  }));

  const folderParentIds: number[] = [];
  const folderNames: string[] = [];
  const fileParentIds: number[] = [];
  const fileContentIds: number[] = [];
  const fileNames: string[] = [];
  const methods: number[] = [];
  const sizesUncompressed: number[] = [];
  const sizesCompressed: number[] = [];
  const blobHashes: Uint8Array[] = [];
  const blobChunks: Uint8Array[] = [];
  const hashToBlobId = new Map<string, number>();

  for (let head = 0; head < queue.length; head++) {
    const { parentId, name, node } = queue[head];
    if (node.type === 'folder') {
      const folderId = folderParentIds.length;
      folderParentIds.push(parentId);
      folderNames.push(name);
      for (const [childName, child] of node.children)
        queue.push({ parentId: folderId, name: childName, node: child });
    } else {
      fileParentIds.push(parentId);
      fileNames.push(name);
      const content = node.content;
      let contentId: number;
      if (content.length === 0) {
        contentId = -1; // empty file: no blob
      } else {
        const hash = blake3(content);
        const hex = bytesToHex(hash);
        const existing = hashToBlobId.get(hex);
        if (existing !== undefined) {
          contentId = existing; // dedup by hash of uncompressed content
        } else {
          contentId = blobHashes.length;
          hashToBlobId.set(hex, contentId);
          blobHashes.push(hash);
          sizesUncompressed.push(content.length);
          const compressed = options.compress
            ? options.compress(content)
            : null;
          if (compressed && compressed.length < content.length) {
            methods.push(1); // GenericZstd, only when strictly smaller
            sizesCompressed.push(compressed.length);
            blobChunks.push(compressed);
          } else {
            methods.push(0);
            sizesCompressed.push(content.length);
            blobChunks.push(content);
          }
        }
      }
      fileContentIds.push(contentId);
    }
  }

  const utf8 = new TextEncoder();
  const iw = new ByteWriter();
  iw.i32le(folderNames.length);
  iw.i32le(fileNames.length);
  iw.i32le(blobHashes.length);
  for (const id of folderParentIds) iw.i32le(id);
  const folderNameBytes = folderNames.map(n => utf8.encode(n));
  for (const n of folderNameBytes) iw.u16le(n.length);
  for (const n of folderNameBytes) iw.bytes(n);
  for (const id of fileParentIds) iw.i32le(id);
  for (const id of fileContentIds) iw.i32le(id);
  const fileNameBytes = fileNames.map(n => utf8.encode(n));
  for (const n of fileNameBytes) iw.u16le(n.length);
  for (const n of fileNameBytes) iw.bytes(n);
  for (const m of methods) iw.u8(m);
  for (const s of sizesUncompressed) iw.i32le(s);
  for (const s of sizesCompressed) iw.i32le(s);
  for (const h of blobHashes) iw.bytes(h);
  const index = iw.toBytes();

  const out = new ByteWriter();
  out.bytes([0x42, 0x52, 0x5a]); // "BRZ"
  out.u8(0); // version: Initial
  // The index is always stored uncompressed — the format's reference writer
  // never compresses it, and byte parity requires matching that. Readers
  // still accept a compressed index.
  out.u8(0); // index_method: None
  out.i32le(index.length);
  out.i32le(index.length); // compressed size mirrors uncompressed when raw
  out.bytes(blake3(index)); // BLAKE3 of the uncompressed index
  out.bytes(index);
  for (const chunk of blobChunks) out.bytes(chunk);
  return out.toBytes();
}

interface BlobInfo {
  method: number;
  sizeUncompressed: number;
  sizeCompressed: number;
  hash: Uint8Array;
  start: number;
  end: number;
}

export class BrzReader implements WorldFs {
  private folderLut = new Map<string, number>();
  private fileLut = new Map<string, number>();
  private pathCache: string[] | null = null;

  private constructor(
    readonly folderParentIds: number[],
    readonly folderNames: string[],
    readonly fileParentIds: number[],
    readonly fileContentIds: number[],
    readonly fileNames: string[],
    private blobs: BlobInfo[],
    private blobData: Uint8Array
  ) {
    for (let i = 0; i < folderNames.length; i++)
      this.folderLut.set(`${folderParentIds[i]} ${folderNames[i]}`, i);
    for (let i = 0; i < fileNames.length; i++)
      this.fileLut.set(`${fileParentIds[i]} ${fileNames[i]}`, i);
  }

  static from(data: Uint8Array): BrzReader {
    const r = new ByteReader(data);
    const magic = r.bytes(3);
    if (magic[0] !== 0x42 || magic[1] !== 0x52 || magic[2] !== 0x5a)
      throw new Error('brdb: invalid .brz magic');
    const version = r.u8();
    if (version !== 0)
      throw new Error(`brdb: unsupported .brz version ${version}`);
    const method = r.u8();
    if (method !== 0 && method !== 1)
      throw new Error(`brdb: invalid index compression method ${method}`);
    const sizeUncompressed = r.i32le();
    const sizeCompressed = r.i32le();
    if (sizeUncompressed < 0 || sizeCompressed < 0)
      throw new Error('brdb: negative index size');
    const headerHash = r.bytes(32);
    let index: Uint8Array;
    if (method === 0) {
      index = r.bytes(sizeUncompressed);
    } else {
      index = zstdDecompress(
        r.bytes(sizeCompressed),
        new Uint8Array(sizeUncompressed)
      );
      if (index.length !== sizeUncompressed)
        throw new Error('brdb: index decompressed to the wrong size');
    }
    if (bytesToHex(blake3(index)) !== bytesToHex(headerHash))
      throw new Error('brdb: index hash mismatch');
    const blobData = r.bytes(r.remaining);

    const ir = new ByteReader(index);
    const numFolders = ir.i32le();
    const numFiles = ir.i32le();
    const numBlobs = ir.i32le();
    if (numFolders < 0 || numFiles < 0 || numBlobs < 0)
      throw new Error('brdb: negative index count');
    const readArray = <T>(n: number, fn: () => T): T[] =>
      Array.from({ length: n }, fn);
    const folderParentIds = readArray(numFolders, () => ir.i32le());
    const folderNameLens = readArray(numFolders, () => ir.u16le());
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const folderNames = folderNameLens.map(len => utf8.decode(ir.bytes(len)));
    const fileParentIds = readArray(numFiles, () => ir.i32le());
    const fileContentIds = readArray(numFiles, () => ir.i32le());
    const fileNameLens = readArray(numFiles, () => ir.u16le());
    const fileNames = fileNameLens.map(len => utf8.decode(ir.bytes(len)));
    const methods = readArray(numBlobs, () => ir.u8());
    const sizesUncompressed = readArray(numBlobs, () => ir.i32le());
    const sizesCompressed = readArray(numBlobs, () => ir.i32le());
    const hashes = readArray(numBlobs, () => ir.bytes(32).slice());
    if (ir.remaining !== 0) throw new Error('brdb: trailing bytes in index');

    // blob byte ranges are not stored: reconstruct by accumulating on-disk sizes
    const blobs: BlobInfo[] = [];
    let offset = 0;
    for (let i = 0; i < numBlobs; i++) {
      if (sizesUncompressed[i] < 0 || sizesCompressed[i] < 0)
        throw new Error('brdb: negative blob size');
      const length =
        methods[i] === 0 ? sizesUncompressed[i] : sizesCompressed[i];
      blobs.push({
        method: methods[i],
        sizeUncompressed: sizesUncompressed[i],
        sizeCompressed: sizesCompressed[i],
        hash: hashes[i],
        start: offset,
        end: offset + length,
      });
      offset += length;
    }
    return new BrzReader(
      folderParentIds,
      folderNames,
      fileParentIds,
      fileContentIds,
      fileNames,
      blobs,
      blobData
    );
  }

  /** parentId -1 = root */
  findFolder(parentId: number, name: string): number | null {
    return this.folderLut.get(`${parentId} ${name}`) ?? null;
  }

  findFile(parentId: number, name: string): { contentId: number } | null {
    const i = this.fileLut.get(`${parentId} ${name}`);
    return i === undefined ? null : { contentId: this.fileContentIds[i] };
  }

  private folderIdOf(path: string): number | null {
    if (path === '') return -1;
    let id = -1;
    for (const part of path.split('/')) {
      const next = this.findFolder(id, part);
      if (next === null) return null;
      id = next;
    }
    return id;
  }

  /** Names of the subfolders of a folder path ('' = root), in id order.
   * A missing path yields []. */
  childFolders(path: string): string[] {
    const parent = this.folderIdOf(path);
    if (parent === null) return [];
    const out: string[] = [];
    for (let i = 0; i < this.folderNames.length; i++)
      if (this.folderParentIds[i] === parent) out.push(this.folderNames[i]);
    return out;
  }

  /** Names of the files directly inside a folder path ('' = root), in id
   * order. A missing path yields []. */
  childFiles(path: string): string[] {
    const parent = this.folderIdOf(path);
    if (parent === null) return [];
    const out: string[] = [];
    for (let i = 0; i < this.fileNames.length; i++)
      if (this.fileParentIds[i] === parent) out.push(this.fileNames[i]);
    return out;
  }

  blobMethod(contentId: number): number {
    return this.blob(contentId).method;
  }

  private blob(contentId: number): BlobInfo {
    if (contentId < 0 || contentId >= this.blobs.length)
      throw new Error(`brdb: blob ${contentId} not found`);
    return this.blobs[contentId];
  }

  /** Decompress (if needed) and verify size + BLAKE3. */
  readBlob(contentId: number): Uint8Array {
    const blob = this.blob(contentId);
    const raw = this.blobData.subarray(blob.start, blob.end);
    let content: Uint8Array;
    if (blob.method === 0) {
      content = raw;
    } else {
      if (raw.length !== blob.sizeCompressed)
        throw new Error('brdb: blob compressed size mismatch');
      content = zstdDecompress(raw, new Uint8Array(blob.sizeUncompressed));
    }
    if (content.length !== blob.sizeUncompressed)
      throw new Error('brdb: blob uncompressed size mismatch');
    if (bytesToHex(blake3(content)) !== bytesToHex(blob.hash))
      throw new Error('brdb: blob hash mismatch');
    return content;
  }

  /** '/'-separated path from the root. An empty file (contentId -1) returns
   * an empty buffer (the reference reader treats empty files as unfindable
   * — deliberate, documented deviation for usability). */
  readFile(path: string): Uint8Array {
    if (path.startsWith('/'))
      throw new Error('brdb: absolute paths not allowed');
    const parts = path.split('/');
    let parentId = -1;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = this.findFolder(parentId, parts[i]);
      if (next === null)
        throw new Error(`brdb: folder not found: ${parts[i]} in ${path}`);
      parentId = next;
    }
    const found = this.findFile(parentId, parts[parts.length - 1]);
    if (!found) throw new Error(`brdb: file not found: ${path}`);
    return found.contentId === -1
      ? new Uint8Array(0)
      : this.readBlob(found.contentId);
  }

  /** Path lookup returning the WorldFs FoundFile shape. createdAt is always
   * 0: a .brz archive holds exactly one revision. */
  findFileByPath(path: string): FoundFile | null {
    if (path.startsWith('/'))
      throw new Error('brdb: absolute paths not allowed');
    const slash = path.lastIndexOf('/');
    const parentId = this.folderIdOf(slash === -1 ? '' : path.slice(0, slash));
    if (parentId === null) return null;
    const found = this.findFile(parentId, path.slice(slash + 1));
    return found === null ? null : { contentId: found.contentId, createdAt: 0 };
  }

  findFileByPathAtRevision(path: string, _date: number): FoundFile | null {
    return this.findFileByPath(path);
  }

  /** All file paths in file-id (BFS) order. */
  listPaths(): string[] {
    if (this.pathCache) return this.pathCache;
    const folderPaths: string[] = [];
    for (let i = 0; i < this.folderNames.length; i++) {
      const parent = this.folderParentIds[i];
      // parents always precede children in BFS id order
      folderPaths.push(
        parent === -1
          ? this.folderNames[i]
          : `${folderPaths[parent]}/${this.folderNames[i]}`
      );
    }
    this.pathCache = this.fileNames.map((name, i) => {
      const parent = this.fileParentIds[i];
      return parent === -1 ? name : `${folderPaths[parent]}/${name}`;
    });
    return this.pathCache;
  }
}
