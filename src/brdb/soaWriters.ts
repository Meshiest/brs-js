// Hand-encoded writers for the two large, uniform chunk SoAs (bricks and
// wires), plus the structural checks that guard them.
//
// These bypass the schema walk entirely, so each one is paired with a
// predicate that verifies the LOADED schema still has exactly the shape the
// writer hardcodes: same fields, same order, same types. When a game update
// changes the format the predicate goes false and the caller falls back to the
// generic writer, which reads the shape it was given. Both paths must produce
// identical bytes; test/brdb/soaWriters.test.ts asserts that differentially.
import { ByteWriter } from './bytes';
import { mpArrayHeader, mpBinHeader, mpBool, mpInt, mpUint } from './msgpack';
import { BrdbSchema, PropDesc, structShapeMatches } from './schema';

const ty = (type: string): PropDesc => ({ kind: 'type', type });
const arr = (type: string): PropDesc => ({ kind: 'array', type });
const flat = (type: string): PropDesc => ({ kind: 'flatarray', type });

const BIT_FLAGS: readonly (readonly [string, PropDesc])[] = [
  ['Flags', flat('u8')],
];

/** Whether `schema` still has the brick-chunk shape writeBrickChunk assumes. */
export function brickChunkSchemaIsStandard(schema: BrdbSchema): boolean {
  return (
    structShapeMatches(schema, 'BRSavedBrickChunkSoA', [
      ['ProceduralBrickStartingIndex', ty('u32')],
      ['BrickSizeCounters', arr('BRSavedBrickSizeCounter')],
      ['BrickSizes', arr('BRSavedBrickSize')],
      ['BrickTypeIndices', arr('u32')],
      ['OwnerIndices', arr('u32')],
      ['OriginalOwnerIndices', arr('u32')],
      ['RelativePositions', flat('BRSavedRelativeBrickPosition')],
      ['Orientations', flat('u8')],
      ['CollisionFlags_Player', ty('BRSavedBitFlags')],
      ['CollisionFlags_Player1', ty('BRSavedBitFlags')],
      ['CollisionFlags_Player2', ty('BRSavedBitFlags')],
      ['CollisionFlags_Player3', ty('BRSavedBitFlags')],
      ['CollisionFlags_Weapon', ty('BRSavedBitFlags')],
      ['CollisionFlags_Interaction', ty('BRSavedBitFlags')],
      ['CollisionFlags_Physics', ty('BRSavedBitFlags')],
      ['VisibilityFlags', ty('BRSavedBitFlags')],
      ['MaterialIndices', flat('u8')],
      ['ColorsAndAlphas', flat('BRSavedBrickColor')],
      ['bColorsAreLinear', ty('bool')],
    ]) &&
    structShapeMatches(schema, 'BRSavedBrickSizeCounter', [
      ['AssetIndex', ty('u32')],
      ['NumSizes', ty('u32')],
    ]) &&
    structShapeMatches(schema, 'BRSavedBrickSize', [
      ['X', ty('u16')],
      ['Y', ty('u16')],
      ['Z', ty('u16')],
    ]) &&
    structShapeMatches(schema, 'BRSavedRelativeBrickPosition', [
      ['X', ty('i16')],
      ['Y', ty('i16')],
      ['Z', ty('i16')],
    ]) &&
    structShapeMatches(schema, 'BRSavedBrickColor', [
      ['R', ty('u8')],
      ['G', ty('u8')],
      ['B', ty('u8')],
      ['A', ty('u8')],
    ]) &&
    structShapeMatches(schema, 'BRSavedBitFlags', BIT_FLAGS)
  );
}

/** Whether `schema` still has the wire-chunk shape writeWireChunk assumes. */
export function wireChunkSchemaIsStandard(schema: BrdbSchema): boolean {
  const port: readonly (readonly [string, PropDesc])[] = [
    ['BrickIndexInChunk', ty('u32')],
    ['ComponentTypeIndex', ty('u16')],
    ['PortIndex', ty('u16')],
  ];
  return (
    structShapeMatches(schema, 'BRSavedWireChunkSoA', [
      ['RemoteWireSources', arr('BRSavedRemoteWirePortSource')],
      ['LocalWireSources', arr('BRSavedLocalWirePortSource')],
      ['RemoteWireTargets', arr('BRSavedWirePortTarget')],
      ['LocalWireTargets', arr('BRSavedWirePortTarget')],
      ['PendingPropagationFlags', ty('BRSavedBitFlags')],
    ]) &&
    structShapeMatches(schema, 'BRSavedRemoteWirePortSource', [
      ['GridPersistentIndex', ty('u32')],
      ['ChunkIndex', ty('BRSavedChunk3DIndex')],
      ['BrickIndexInChunk', ty('u32')],
      ['ComponentTypeIndex', ty('u16')],
      ['PortIndex', ty('u16')],
    ]) &&
    structShapeMatches(schema, 'BRSavedLocalWirePortSource', port) &&
    structShapeMatches(schema, 'BRSavedWirePortTarget', port) &&
    structShapeMatches(schema, 'BRSavedChunk3DIndex', [
      ['X', ty('i16')],
      ['Y', ty('i16')],
      ['Z', ty('i16')],
    ]) &&
    structShapeMatches(schema, 'BRSavedBitFlags', BIT_FLAGS)
  );
}

/** The brick SoA columns, in the layout the packer accumulates them. */
export interface BrickChunkColumns {
  sizeCounters: { AssetIndex: number; NumSizes: number }[];
  sizes: { X: number; Y: number; Z: number }[];
  typeIndices: number[];
  ownerIndices: number[];
  originalOwnerIndices: number[];
  relPositions: { X: number; Y: number; Z: number }[];
  orientations: number[];
  /** the eight packed boolean columns, in schema order */
  bitColumns: readonly number[][];
  materialIndices: number[];
  colors: { R: number; G: number; B: number; A: number }[];
}

/** BRSavedBitFlags is a single flat u8 array: a bin header then the raw
 * backing bytes. */
function writeFlagBytes(w: ByteWriter, bytes: number[]): void {
  mpBinHeader(w, bytes.length);
  for (let i = 0; i < bytes.length; i++) w.u8(bytes[i]);
}

export function writeBrickChunk(
  w: ByteWriter,
  cols: BrickChunkColumns,
  proceduralBrickStartingIndex: number
): void {
  mpUint(w, proceduralBrickStartingIndex);
  mpArrayHeader(w, cols.sizeCounters.length);
  for (let i = 0; i < cols.sizeCounters.length; i++) {
    const c = cols.sizeCounters[i];
    mpUint(w, c.AssetIndex);
    mpUint(w, c.NumSizes);
  }
  mpArrayHeader(w, cols.sizes.length);
  for (let i = 0; i < cols.sizes.length; i++) {
    const s = cols.sizes[i];
    mpUint(w, s.X);
    mpUint(w, s.Y);
    mpUint(w, s.Z);
  }
  for (const column of [
    cols.typeIndices,
    cols.ownerIndices,
    cols.originalOwnerIndices,
  ]) {
    mpArrayHeader(w, column.length);
    for (let i = 0; i < column.length; i++) mpUint(w, column[i]);
  }
  // Flat arrays: a bin header then little-endian element bytes.
  mpBinHeader(w, cols.relPositions.length * 6);
  for (let i = 0; i < cols.relPositions.length; i++) {
    const p = cols.relPositions[i];
    w.i16le(p.X);
    w.i16le(p.Y);
    w.i16le(p.Z);
  }
  mpBinHeader(w, cols.orientations.length);
  for (let i = 0; i < cols.orientations.length; i++) w.u8(cols.orientations[i]);
  for (const bytes of cols.bitColumns) writeFlagBytes(w, bytes);
  mpBinHeader(w, cols.materialIndices.length);
  for (let i = 0; i < cols.materialIndices.length; i++)
    w.u8(cols.materialIndices[i]);
  mpBinHeader(w, cols.colors.length * 4);
  for (let i = 0; i < cols.colors.length; i++) {
    const c = cols.colors[i];
    w.u8(c.R);
    w.u8(c.G);
    w.u8(c.B);
    w.u8(c.A);
  }
  mpBool(w, false); // new saves always store sRGB
}

/** One wire endpoint row; remote sources carry the extra grid + chunk. */
export interface WirePortRow {
  GridPersistentIndex?: number;
  ChunkIndex?: { X: number; Y: number; Z: number };
  BrickIndexInChunk: number;
  ComponentTypeIndex: number;
  PortIndex: number;
}

export interface WireChunkRows {
  remoteSources: WirePortRow[];
  localSources: WirePortRow[];
  remoteTargets: WirePortRow[];
  localTargets: WirePortRow[];
}

function writePortRows(w: ByteWriter, rows: WirePortRow[]): void {
  mpArrayHeader(w, rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    mpUint(w, r.BrickIndexInChunk);
    mpUint(w, r.ComponentTypeIndex);
    mpUint(w, r.PortIndex);
  }
}

export function writeWireChunk(w: ByteWriter, rows: WireChunkRows): void {
  mpArrayHeader(w, rows.remoteSources.length);
  for (let i = 0; i < rows.remoteSources.length; i++) {
    const s = rows.remoteSources[i];
    mpUint(w, s.GridPersistentIndex);
    mpInt(w, s.ChunkIndex.X);
    mpInt(w, s.ChunkIndex.Y);
    mpInt(w, s.ChunkIndex.Z);
    mpUint(w, s.BrickIndexInChunk);
    mpUint(w, s.ComponentTypeIndex);
    mpUint(w, s.PortIndex);
  }
  writePortRows(w, rows.localSources);
  writePortRows(w, rows.remoteTargets);
  writePortRows(w, rows.localTargets);
  // PendingPropagationFlags is always empty on a freshly written world.
  writeFlagBytes(w, []);
}
