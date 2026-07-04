import { existsSync, readFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { BrzReader, writeBrzContainer } from '../../src/brdb/brz';
import { file, folder, PendingEntry } from '../../src/brdb/pending';

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );
const utf8 = (s: string) => new TextEncoder().encode(s);

test('empty archive is exactly 57 bytes with a correct header', () => {
  const out = writeBrzContainer([]);
  expect(out.length).toBe(57); // 3 magic + 42 header + 12-byte empty index
  expect(Array.from(out.subarray(0, 5))).toEqual([0x42, 0x52, 0x5a, 0, 0]); // BRZ, v0, method 0
  const view = new DataView(out.buffer);
  expect(view.getInt32(5, true)).toBe(12); // index_size_uncompressed
  expect(view.getInt32(9, true)).toBe(12); // index_size_compressed mirrors it
  const index = out.subarray(45, 57);
  expect(Array.from(index)).toEqual(new Array(12).fill(0)); // 3 × i32 zero counts
  expect(Array.from(out.subarray(13, 45))).toEqual(Array.from(blake3(index)));
});

const tree: PendingEntry[] = [
  [
    'A',
    folder([
      ['a.txt', file(utf8('alpha'))],
      ['C', folder([['c.txt', file(utf8('gamma'))]])],
    ]),
  ],
  ['b.txt', file(utf8('beta'))],
  ['dupe.txt', file(utf8('alpha'))], // same content as a.txt -> same blob
  ['empty.txt', file(new Uint8Array(0))],
  ['D', folder([])],
];

test('BFS id assignment, dedup, and empty files', () => {
  const reader = BrzReader.from(writeBrzContainer(tree));
  // folders dequeue in BFS order: A, D, then A's child C
  expect(reader.folderNames).toEqual(['A', 'D', 'C']);
  // files in BFS order: root files first, then A's, then C's
  expect(reader.listPaths()).toEqual([
    'b.txt',
    'dupe.txt',
    'empty.txt',
    'A/a.txt',
    'A/C/c.txt',
  ]);
  expect(reader.findFile(0, 'a.txt')!.contentId).toBe(
    reader.findFile(-1, 'dupe.txt')!.contentId
  );
  expect(reader.findFile(-1, 'empty.txt')!.contentId).toBe(-1);
  expect(reader.readFile('empty.txt')).toEqual(new Uint8Array(0));
  expect(new TextDecoder().decode(reader.readFile('A/C/c.txt'))).toBe('gamma');
});

test('compression: strictly-smaller rule, round-trips through fzstd', () => {
  const compressible = utf8('a'.repeat(4096));
  const tiny = utf8('x'); // zstd frame overhead > 1 byte -> stored raw
  const bytes = writeBrzContainer(
    [
      ['big.txt', file(compressible)],
      ['tiny.txt', file(tiny)],
    ],
    { compress: data => zstdCompressSync(data) }
  );
  const reader = BrzReader.from(bytes);
  expect(reader.blobMethod(reader.findFile(-1, 'big.txt')!.contentId)).toBe(1);
  expect(reader.blobMethod(reader.findFile(-1, 'tiny.txt')!.contentId)).toBe(0);
  expect(reader.readFile('big.txt')).toEqual(compressible);
  expect(reader.readFile('tiny.txt')).toEqual(tiny);
});

test('corruption is detected', () => {
  const bytes = writeBrzContainer(tree);
  const corrupted = bytes.slice();
  corrupted[50] ^= 0xff; // inside the index
  expect(() => BrzReader.from(corrupted)).toThrow(/hash/i);
});

test('reads a variant with a zstd-compressed index (method=1)', () => {
  const original = writeBrzContainer(tree);
  const view = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength
  );
  const uncompressedLen = view.getInt32(5, true);
  const indexStart = 45;
  const index = original.subarray(indexStart, indexStart + uncompressedLen);
  const compressedIndex = zstdCompressSync(index);
  const hash = original.subarray(13, 45);
  const restBlobBytes = original.subarray(indexStart + uncompressedLen);

  const out = new Uint8Array(
    indexStart + compressedIndex.length + restBlobBytes.length
  );
  const outView = new DataView(out.buffer);
  out.set(original.subarray(0, 4)); // magic + version, unchanged
  out[4] = 1; // index_method: GenericZstd
  outView.setInt32(5, uncompressedLen, true);
  outView.setInt32(9, compressedIndex.length, true);
  out.set(hash, 13); // hash is of the UNCOMPRESSED index, still valid
  out.set(compressedIndex, indexStart);
  out.set(restBlobBytes, indexStart + compressedIndex.length);

  const originalReader = BrzReader.from(original);
  const compressedReader = BrzReader.from(out);
  expect(compressedReader.listPaths()).toEqual(originalReader.listPaths());
  for (const path of originalReader.listPaths())
    expect(compressedReader.readFile(path), path).toEqual(
      originalReader.readFile(path)
    );
});

describe('BrzReader WorldFs seam', () => {
  const archive = () =>
    BrzReader.from(
      writeBrzContainer([
        [
          'Meta',
          folder([['Bundle.json', file(new TextEncoder().encode('{}'))]]),
        ],
        ['Empty.txt', file(new Uint8Array(0))],
      ])
    );

  test('findFileByPath resolves nested paths with createdAt 0', () => {
    const r = archive();
    const found = r.findFileByPath('Meta/Bundle.json');
    expect(found).not.toBeNull();
    expect(found!.createdAt).toBe(0);
    expect(r.readBlob(found!.contentId)).toEqual(
      new TextEncoder().encode('{}')
    );
  });

  test('findFileByPath misses return null; empty files carry contentId -1', () => {
    const r = archive();
    expect(r.findFileByPath('Meta/Nope.json')).toBeNull();
    expect(r.findFileByPath('No/Such/Path')).toBeNull();
    expect(r.findFileByPath('Empty.txt')).toEqual({
      contentId: -1,
      createdAt: 0,
    });
  });

  test('findFileByPathAtRevision ignores the date', () => {
    const r = archive();
    expect(r.findFileByPathAtRevision('Meta/Bundle.json', 999999)).toEqual(
      r.findFileByPath('Meta/Bundle.json')
    );
  });
});

describe.skipIf(!hasFixtures)('rust fixture archives', () => {
  const expectedBrickPaths = [
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
    'World/0/Bricks/Grids/1/Chunks/0_0_0.mps',
  ];

  test('brick_raw.brz: exact BFS file order and oracle hashes', () => {
    const reader = BrzReader.from(fixture('brick_raw.brz'));
    expect(reader.listPaths()).toEqual(expectedBrickPaths);
    const hashes = JSON.parse(
      readFileSync(
        new URL('../fixtures/brdb/hashes.json', import.meta.url),
        'utf8'
      )
    ).brick;
    for (const path of reader.listPaths()) {
      const content = reader.readFile(path);
      expect(bytesToHex(blake3(content)), path).toBe(hashes[path].blake3);
      expect(content.length, path).toBe(hashes[path].len);
    }
  });

  test('brick.brz (zstd): payloads identical to the raw variant', () => {
    const raw = BrzReader.from(fixture('brick_raw.brz'));
    const zst = BrzReader.from(fixture('brick.brz'));
    expect(zst.listPaths().sort()).toEqual(raw.listPaths().sort());
    for (const path of raw.listPaths())
      expect(zst.readFile(path), path).toEqual(raw.readFile(path));
  });

  test('embedded schema blobs equal the standalone schema fixtures', () => {
    const reader = BrzReader.from(fixture('brick_raw.brz'));
    for (const [path, bin] of [
      ['World/0/GlobalData.schema', 'BRSavedGlobalDataSoA'],
      ['World/0/Owners.schema', 'BRSavedOwnerTableSoA'],
      ['World/0/Bricks/ChunkIndexShared.schema', 'BRSavedBrickChunkIndexSoA'],
      ['World/0/Bricks/ChunksShared.schema', 'BRSavedBrickChunkSoA'],
      ['World/0/Bricks/WiresShared.schema', 'BRSavedWireChunkSoA'],
      ['World/0/Bricks/ComponentsShared.schema', 'BRSavedComponentChunkSoA'],
      ['World/0/Entities/ChunkIndex.schema', 'BRSavedEntityChunkIndexSoA'],
      ['World/0/Entities/ChunksShared.schema', 'BRSavedEntityChunkSoA'],
    ] as const)
      expect(reader.readFile(path), path).toEqual(
        fixture(`schemas/${bin}.bin`)
      );
  });
});
