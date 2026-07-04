// Lazy .brz world reader. Schemas are parsed once and cached per archive
// path; chunk payloads are decoded on demand (never all at once); grids and
// entities are enumerated from the archive rather than assumed. Decoding
// always uses the ARCHIVE's own schemas — game-authored files may carry
// field sets that differ from the embedded (current) schemas, and a .brz
// holds exactly one schema per category.
import type { Collision, Owner, Vector } from '../brs/types';
import { bit } from './bits';
import { ByteReader } from './bytes';
import { BrzReader } from './brz';
import type { FoundFile, WorldFs } from './fs';
import { guidToUuid } from './guid';
import { BrdbSchema, BrdbValue } from './schema';
import { BundleJson, CHUNK_HALF, CHUNK_SIZE } from './world';

export type { FoundFile, WorldFs } from './fs';

export const MAIN_GRID = 1;

export interface ChunkCoord {
  x: number;
  y: number;
  z: number;
}

export interface BrickChunkRef {
  index: ChunkCoord;
  offset: ChunkCoord;
  size: number;
  numBricks: number;
  numComponents: number;
  numWires: number;
}

export interface EntityChunkRef {
  index: ChunkCoord;
  numEntities: number;
}

export interface EntityChunkIndex {
  nextPersistentIndex: number;
  chunks: EntityChunkRef[];
}

export interface ComponentInstance {
  typeName: string;
  structName: string | null;
  /** the owning brick's local index within its chunk */
  brickIndex: number;
  data: Record<string, BrdbValue> | null;
}

export interface WireEndpoint {
  /** the endpoint brick's local index within its chunk */
  brickIndex: number;
  componentType: string;
  port: string;
}

export interface RemoteWireEndpoint extends WireEndpoint {
  gridId: number;
  chunk: ChunkCoord;
}

export interface WireChunk {
  /** wires whose source is in the same grid+chunk as the target */
  local: Array<{ source: WireEndpoint; target: WireEndpoint }>;
  /** wires whose source lives in another grid or chunk */
  remote: Array<{ source: RemoteWireEndpoint; target: WireEndpoint }>;
}

export interface EntityRecord {
  typeName: string;
  className: string | null;
  persistentIndex: number;
  ownerIndex: number;
  originalOwnerIndex: number;
  location: { X: number; Y: number; Z: number };
  rotation: { X: number; Y: number; Z: number; W: number };
  frozen: boolean;
  sleeping: boolean;
  linearVelocity: { X: number; Y: number; Z: number };
  angularVelocity: { X: number; Y: number; Z: number };
  colors: Record<string, BrdbValue>;
  remainingLifeSpan: number;
  data: Record<string, BrdbValue> | null;
}

export interface BrzWorldBrick {
  asset_name_index: number;
  size: Vector;
  position: Vector;
  direction: number;
  rotation: number;
  collision: Collision;
  visibility: boolean;
  material_index: number;
  material_intensity: number;
  color: [number, number, number];
  owner_index: number;
}

/** Expand one decoded brick chunk SoA into bricks. Positions are relative to
 * the owning grid's origin (world origin for the main grid). */
function decodeChunkBricks(
  soa: any,
  chunk: ChunkCoord,
  basicCount: number
): BrzWorldBrick[] {
  // Expand the run-length size table: slot s belongs to the counter
  // covering it; BrickSizes[s] is its size.
  const slotAssets: number[] = [];
  for (const counter of soa.BrickSizeCounters)
    for (let s = 0; s < counter.NumSizes; s++)
      slotAssets.push(counter.AssetIndex);
  const start: number = soa.ProceduralBrickStartingIndex;

  const bricks: BrzWorldBrick[] = [];
  for (let i = 0; i < soa.BrickTypeIndices.length; i++) {
    const ty: number = soa.BrickTypeIndices[i];
    let asset_name_index: number;
    let size: Vector;
    if (ty < start) {
      asset_name_index = ty; // basic: same index in the combined list
      size = [0, 0, 0];
    } else {
      const slot = ty - start;
      const sz = soa.BrickSizes[slot];
      if (sz === undefined || slotAssets[slot] === undefined)
        throw new Error(`brdb: invalid procedural size slot ${slot}`);
      asset_name_index = basicCount + slotAssets[slot];
      size = [sz.X, sz.Y, sz.Z];
    }
    const rel = soa.RelativePositions[i];
    const orientation: number = soa.Orientations[i];
    const color = soa.ColorsAndAlphas[i];
    bricks.push({
      asset_name_index,
      size,
      position: [
        chunk.x * CHUNK_SIZE + CHUNK_HALF + rel.X,
        chunk.y * CHUNK_SIZE + CHUNK_HALF + rel.Y,
        chunk.z * CHUNK_SIZE + CHUNK_HALF + rel.Z,
      ],
      direction: (orientation >> 2) & 0x7,
      rotation: orientation & 0x3,
      collision: {
        player: bit(soa.CollisionFlags_Player, i),
        weapon: bit(soa.CollisionFlags_Weapon, i),
        interaction: bit(soa.CollisionFlags_Interaction, i),
        tool: true, // not stored in brdb
        physics: bit(soa.CollisionFlags_Physics, i),
      },
      visibility: bit(soa.VisibilityFlags, i),
      material_index: soa.MaterialIndices[i],
      material_intensity: color.A,
      color: [color.R, color.G, color.B],
      owner_index: soa.OwnerIndices[i],
    });
  }
  return bricks;
}

export class WorldReader {
  private schemas = new Map<string, BrdbSchema>();
  private values = new Map<string, unknown>();

  constructor(readonly fs: WorldFs, readonly worldId: number = 0) {}

  static from(data: Uint8Array): WorldReader {
    return new WorldReader(BrzReader.from(data));
  }

  private path(rel: string): string {
    return `World/${this.worldId}/${rel}`;
  }

  /** Parse a .schema blob once per revision; later calls return the cached
   * schema. The public form resolves the schema file's own (latest)
   * revision. */
  schema(path: string): BrdbSchema {
    const found = this.fs.findFileByPath(path);
    if (!found) throw new Error(`brdb: file not found: ${path}`);
    return this.schemaAt(path, found.createdAt);
  }

  /** Schema as it existed at `revision` (a created_at timestamp). Schemas
   * evolve over a world's history; data files must decode with the schema
   * revision that was live when they were written. */
  private schemaAt(path: string, revision: number): BrdbSchema {
    const key = `${path}@${revision}`;
    let schema = this.schemas.get(key);
    if (!schema) {
      const found = this.fs.findFileByPathAtRevision(path, revision);
      if (!found)
        throw new Error(`brdb: file not found: ${path} at ${revision}`);
      schema = BrdbSchema.fromBinary(this.fs.readBlob(found.contentId));
      this.schemas.set(key, schema);
    }
    return schema;
  }

  private decode(mpsPath: string, schemaPath: string, struct: string): any {
    const found = this.fs.findFileByPath(mpsPath);
    if (!found) throw new Error(`brdb: file not found: ${mpsPath}`);
    return this.schemaAt(schemaPath, found.createdAt).decode(
      this.fs.readBlob(found.contentId),
      struct
    );
  }

  private cached<T>(key: string, load: () => T): T {
    if (!this.values.has(key)) this.values.set(key, load());
    return this.values.get(key) as T;
  }

  bundle(): BundleJson {
    return this.cached('Meta/Bundle.json', () =>
      JSON.parse(new TextDecoder().decode(this.fs.readFile('Meta/Bundle.json')))
    );
  }

  environment(): { environment: string } {
    return this.cached('Meta/World.json', () =>
      JSON.parse(new TextDecoder().decode(this.fs.readFile('Meta/World.json')))
    );
  }

  globalData(): any {
    return this.cached(this.path('GlobalData.mps'), () =>
      this.decode(
        this.path('GlobalData.mps'),
        this.path('GlobalData.schema'),
        'BRSavedGlobalDataSoA'
      )
    );
  }

  owners(): any {
    return this.cached(this.path('Owners.mps'), () =>
      this.decode(
        this.path('Owners.mps'),
        this.path('Owners.schema'),
        'BRSavedOwnerTableSoA'
      )
    );
  }

  /** Basic asset names followed by procedural — decoded brick
   * asset_name_index values point into this combined list. */
  brickAssets(): string[] {
    const globalData = this.globalData();
    return [
      ...globalData.BasicBrickAssetNames,
      ...globalData.ProceduralBrickAssetNames,
    ];
  }

  materials(): string[] {
    return this.globalData().MaterialAssetNames;
  }

  /** Owner rows 1.. (the PUBLIC row 0 is excluded). */
  brickOwners(): Owner[] {
    const owners = this.owners();
    const out: Owner[] = [];
    for (let i = 1; i < owners.UserNames.length; i++) {
      out.push({
        id: guidToUuid(owners.UserIds[i]),
        name: owners.UserNames[i],
        display_name: owners.DisplayNames[i],
        bricks: owners.BrickCounts[i],
      });
    }
    return out;
  }

  /** Grid ids under Bricks/Grids: 1 = the main grid, ≥2 = entity sub-grids. */
  gridIds(): number[] {
    return this.fs
      .childFolders(this.path('Bricks/Grids'))
      .map(Number)
      .sort((a, b) => a - b);
  }

  brickChunkIndex(gridId: number = MAIN_GRID): BrickChunkRef[] {
    const soa = this.decode(
      this.path(`Bricks/Grids/${gridId}/ChunkIndex.mps`),
      this.path('Bricks/ChunkIndexShared.schema'),
      'BRSavedBrickChunkIndexSoA'
    );
    return soa.Chunk3DIndices.map((c: any, i: number) => ({
      index: { x: c.X, y: c.Y, z: c.Z },
      offset: {
        x: soa.ChunkOffsets[i].X,
        y: soa.ChunkOffsets[i].Y,
        z: soa.ChunkOffsets[i].Z,
      },
      size: soa.ChunkSizes[i],
      numBricks: soa.NumBricks[i],
      numComponents: soa.NumComponents[i],
      numWires: soa.NumWires[i],
    }));
  }

  /** Decode one brick chunk's SoA. Not cached: chunk payloads are the bulk
   * of an archive and are meant to be streamed, not retained. */
  brickChunkSoa(gridId: number, chunk: ChunkCoord): any {
    return this.decode(
      this.path(
        `Bricks/Grids/${gridId}/Chunks/${chunk.x}_${chunk.y}_${chunk.z}.mps`
      ),
      this.path('Bricks/ChunksShared.schema'),
      'BRSavedBrickChunkSoA'
    );
  }

  /** Lazily decode a grid's bricks, one chunk at a time. Positions are
   * relative to the grid's origin: world origin for the main grid (1),
   * entity-relative for sub-grids (≥2). */
  *bricks(gridId: number = MAIN_GRID): Generator<BrzWorldBrick, void, void> {
    const basicCount = this.globalData().BasicBrickAssetNames.length;
    for (const ref of this.brickChunkIndex(gridId)) {
      yield* decodeChunkBricks(
        this.brickChunkSoa(gridId, ref.index),
        ref.index,
        basicCount
      );
    }
  }

  /** Entity chunk registry. */
  entityChunkIndex(): EntityChunkIndex {
    const soa = this.decode(
      this.path('Entities/ChunkIndex.mps'),
      this.path('Entities/ChunkIndex.schema'),
      'BRSavedEntityChunkIndexSoA'
    );
    return {
      nextPersistentIndex: soa.NextPersistentIndex,
      chunks: soa.Chunk3DIndices.map((c: any, i: number) => ({
        index: { x: c.X, y: c.Y, z: c.Z },
        numEntities: soa.NumEntities[i],
      })),
    };
  }

  /** Decode a component chunk: the SoA plus each instance's trailing data
   * struct. Instances stream in counter order; a type whose data-struct
   * slot is missing or "None" contributes no trailing bytes. */
  componentChunk(
    gridId: number,
    chunk: ChunkCoord
  ): { soa: any; components: ComponentInstance[] } {
    const mpsPath = this.path(
      `Bricks/Grids/${gridId}/Components/${chunk.x}_${chunk.y}_${chunk.z}.mps`
    );
    const found = this.fs.findFileByPath(mpsPath);
    if (!found) throw new Error(`brdb: file not found: ${mpsPath}`);
    const bytes = this.fs.readBlob(found.contentId);
    const schema = this.schemaAt(
      this.path('Bricks/ComponentsShared.schema'),
      found.createdAt
    );
    const globalData = this.globalData();
    const r = new ByteReader(bytes);
    const soa: any = schema.readValue(r, 'BRSavedComponentChunkSoA');

    const components: ComponentInstance[] = [];
    let stream = 0;
    for (const counter of soa.ComponentTypeCounters) {
      const typeName: string =
        globalData.ComponentTypeNames[counter.TypeIndex] ?? '<invalid>';
      const rawStruct: string | undefined =
        globalData.ComponentDataStructNames[counter.TypeIndex];
      const structName = rawStruct && rawStruct !== 'None' ? rawStruct : null;
      for (let i = 0; i < counter.NumInstances; i++) {
        components.push({
          typeName,
          structName,
          brickIndex: soa.ComponentBrickIndices[stream],
          data: structName
            ? (schema.readValue(r, structName) as Record<string, BrdbValue>)
            : null,
        });
        stream += 1;
      }
    }
    if (r.remaining !== 0)
      throw new Error(
        `brdb: ${r.remaining} trailing bytes after component chunk`
      );
    return { soa, components };
  }

  /** Decode a wire chunk. Wires live in the TARGET's grid+chunk; local
   * rows are same-grid-same-chunk sources, remote rows carry the source
   * grid + chunk. Component/port names resolve through GlobalData. */
  wireChunk(gridId: number, chunk: ChunkCoord): WireChunk {
    const soa: any = this.decode(
      this.path(
        `Bricks/Grids/${gridId}/Wires/${chunk.x}_${chunk.y}_${chunk.z}.mps`
      ),
      this.path('Bricks/WiresShared.schema'),
      'BRSavedWireChunkSoA'
    );
    const globalData = this.globalData();
    const endpoint = (row: any): WireEndpoint => ({
      brickIndex: row.BrickIndexInChunk,
      componentType:
        globalData.ComponentTypeNames[row.ComponentTypeIndex] ?? '<invalid>',
      port: globalData.ComponentWirePortNames[row.PortIndex] ?? '<invalid>',
    });
    return {
      local: soa.LocalWireSources.map((s: any, i: number) => ({
        source: endpoint(s),
        target: endpoint(soa.LocalWireTargets[i]),
      })),
      remote: soa.RemoteWireSources.map((s: any, i: number) => ({
        source: {
          ...endpoint(s),
          gridId: s.GridPersistentIndex,
          chunk: {
            x: s.ChunkIndex.X,
            y: s.ChunkIndex.Y,
            z: s.ChunkIndex.Z,
          },
        },
        target: endpoint(soa.RemoteWireTargets[i]),
      })),
    };
  }

  /** Decode one entity chunk: the SoA plus each entity's trailing data
   * struct (gated on EntityDataClassNames: absent or "None" = no struct). */
  entityChunk(chunk: ChunkCoord): EntityRecord[] {
    const mpsPath = this.path(
      `Entities/Chunks/${chunk.x}_${chunk.y}_${chunk.z}.mps`
    );
    const found = this.fs.findFileByPath(mpsPath);
    if (!found) throw new Error(`brdb: file not found: ${mpsPath}`);
    const bytes = this.fs.readBlob(found.contentId);
    const schema = this.schemaAt(
      this.path('Entities/ChunksShared.schema'),
      found.createdAt
    );
    const globalData = this.globalData();
    const r = new ByteReader(bytes);
    const soa: any = schema.readValue(r, 'BRSavedEntityChunkSoA');

    const entities: EntityRecord[] = [];
    let index = 0;
    for (const counter of soa.TypeCounters) {
      const typeName: string =
        globalData.EntityTypeNames[counter.TypeIndex] ?? '<invalid>';
      const rawClass: string | undefined =
        globalData.EntityDataClassNames[counter.TypeIndex];
      const className = rawClass && rawClass !== 'None' ? rawClass : null;
      for (let i = 0; i < counter.NumEntities; i++) {
        entities.push({
          typeName,
          className,
          persistentIndex: soa.PersistentIndices[index],
          ownerIndex: soa.OwnerIndices[index],
          originalOwnerIndex: soa.OriginalOwnerIndices[index],
          location: soa.Locations[index],
          rotation: soa.Rotations[index],
          frozen: bit(soa.PhysicsLockedFlags, index),
          sleeping: bit(soa.PhysicsSleepingFlags, index),
          linearVelocity: soa.LinearVelocities[index],
          angularVelocity: soa.AngularVelocities[index],
          colors: soa.ColorsAndAlphas[index],
          remainingLifeSpan: soa.RemainingLifeSpans?.[index] ?? 0,
          data: className
            ? (schema.readValue(r, className) as Record<string, BrdbValue>)
            : null,
        });
        index += 1;
      }
    }
    if (r.remaining !== 0)
      throw new Error(`brdb: ${r.remaining} trailing bytes after entity chunk`);
    return entities;
  }

  /** Lazily decode every entity, one chunk at a time. */
  *entities(): Generator<EntityRecord, void, void> {
    for (const ref of this.entityChunkIndex().chunks)
      yield* this.entityChunk(ref.index);
  }
}
