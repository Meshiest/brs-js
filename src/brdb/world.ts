// WriteSaveObject -> brdb world tree -> .brz. Bricks, brdb-native
// components, and wires; entities are a later phase.
import { DEFAULT_UUID } from '../brs/constants';
import type { WriteSaveObject } from '../brs/types';
import { BitFlags } from './bits';
import { BrzContainerOptions, Compressor, writeBrzContainer } from './brz';
import { ByteWriter } from './bytes';
import { isProceduralAsset } from './catalog';
import { COMPONENT_TYPE_STRUCTS } from './componentDb';
import { BrGuid, PUBLIC_GUID, uuidToGuid } from './guid';
import { file, folder, PendingEntry } from './pending';
import { BrdbSchema, BrdbValue, embeddedSchema } from './schema';
import { SCHEMAS } from './schemas';

export const CHUNK_SIZE = 2048;
export const CHUNK_HALF = 1024;

export interface BundleJson {
  type: string;
  iD: string;
  name: string;
  version: string;
  tags: string[];
  authors: string[];
  createdAt: string;
  updatedAt: string;
  description: string;
  dependencies: unknown[];
  gameVersion: string;
}

export interface WriteBrzOptions {
  /** zstd compressor for blobs; omitted -> all blobs stored raw (valid, and
   * what the byte-parity gates compare against). */
  compress?: Compressor;
  /** Meta/World.json environment. save.map is NOT used. Default "Plate". */
  environment?: string;
  /** Meta/Bundle.json field overrides. */
  bundle?: Partial<BundleJson>;
}

/** A brdb-native component on a brick. Legacy brs components
 * (save.components / brick.components) are NOT converted. */
export interface BrdbComponentInput {
  /** brdb component type name, e.g. 'Component_Internal_Seat' */
  type: string;
  /** fields of the component's data struct; omitted fields zero-fill */
  data?: Record<string, BrdbValue>;
}

export interface BrdbWireEndpointInput {
  /** index into save.bricks */
  brick_index: number;
  /** brdb component type name (must be used by a brick in this save) */
  component_type: string;
  /** wire port name, e.g. 'Output' */
  port: string;
}

/** A wire between two component ports, using brdb-native names. Legacy
 * save.wires (brs component names) are NOT converted. */
export interface BrdbWireInput {
  source: BrdbWireEndpointInput;
  target: BrdbWireEndpointInput;
}

/** brdb-native extras alongside the legacy save shape: bricks carry a
 * modern `components` ARRAY of typed inputs (replacing the legacy .brs
 * component map on that field, which is not converted) and the save
 * carries `wires`. */
export interface BrdbBrickExtras {
  components?: BrdbComponentInput[];
}

export interface BrdbSaveExtras {
  wires?: BrdbWireInput[];
}

/** The legacy save shape plus the brdb-native extras. The brick-level
 * legacy `components` map and the save-level legacy `wires` list are
 * replaced by the modern forms. */
export type WriteBrzSave = Omit<WriteSaveObject, 'bricks' | 'wires'> & {
  bricks: (Omit<WriteSaveObject['bricks'][number], 'components'> &
    BrdbBrickExtras)[];
} & BrdbSaveExtras;

/** What the world writers accept: the modern shape, or an unmodified
 * legacy save (whose map-shaped `components` and legacy-named `wires`
 * are ignored rather than converted). */
export type WriteBrzInput = WriteBrzSave | WriteSaveObject;

const floorDiv = (a: number, n: number) => Math.floor(a / n);
const euclidMod = (a: number, n: number) => ((a % n) + n) % n;

export function toRelative(position: readonly number[]): {
  chunk: [number, number, number];
  rel: [number, number, number];
} {
  const chunk = position.map(v => floorDiv(v, CHUNK_SIZE)) as [
    number,
    number,
    number
  ];
  const rel = position.map(v => euclidMod(v, CHUNK_SIZE) - CHUNK_HALF) as [
    number,
    number,
    number
  ];
  return { chunk, rel };
}

interface Brick {
  assetName: string;
  procedural: boolean;
  size: [number, number, number];
  position: [number, number, number];
  direction: number;
  rotation: number;
  collision: {
    player: boolean;
    weapon: boolean;
    interaction: boolean;
    physics: boolean;
  };
  visible: boolean;
  materialName: string;
  intensity: number;
  color: [number, number, number];
  ownerIndex: number;
  components: BrdbComponentInput[];
}

function normalizeBricks(save: WriteBrzInput): Brick[] {
  const assets = save.brick_assets ?? ['PB_DefaultBrick'];
  const materials = save.materials ?? ['BMC_Plastic'];
  const numOwners = save.brick_owners?.length ?? 0;
  return save.bricks.map((brick, i) => {
    const at = `bricks[${i}]`;
    // Only the modern array form is written; a legacy map-shaped .brs
    // `components` object on a brick is ignored (not converted).
    const componentInputs = Array.isArray(brick.components)
      ? brick.components
      : [];
    const components = componentInputs.map((c, ci) => {
      if (!COMPONENT_TYPE_STRUCTS.has(c.type))
        throw new Error(
          `brdb: ${at}.components[${ci}]: unknown component type '${c.type}'`
        );
      return c;
    });
    const assetName = assets[brick.asset_name_index ?? 0];
    if (assetName === undefined)
      throw new Error(
        `brdb: ${at}: asset_name_index ${brick.asset_name_index} out of range`
      );
    const materialName = materials[brick.material_index ?? 0];
    if (materialName === undefined)
      throw new Error(
        `brdb: ${at}: material_index ${brick.material_index} out of range`
      );
    const position = brick.position.map(v => {
      if (!Number.isSafeInteger(v))
        throw new Error(
          `brdb: ${at}: position must be integers, got ${brick.position}`
        );
      if (!(v >= -32768 * CHUNK_SIZE && v <= 32768 * CHUNK_SIZE - 1))
        throw new Error(
          `brdb: ${at}: position ${v} outside the i16 chunk range`
        );
      return v;
    }) as [number, number, number];
    const size = brick.size.map(v => {
      if (!Number.isInteger(v) || v < 0 || v > 0xffff)
        throw new Error(
          `brdb: ${at}: size components must be u16, got ${brick.size}`
        );
      return v;
    }) as [number, number, number];
    let collision: Brick['collision'];
    if (typeof brick.collision === 'boolean') {
      const b = brick.collision;
      collision = { player: b, weapon: b, interaction: b, physics: b };
    } else {
      collision = {
        player: brick.collision?.player ?? true,
        weapon: brick.collision?.weapon ?? true,
        interaction: brick.collision?.interaction ?? true,
        physics: brick.collision?.physics ?? true,
        // Collision.tool is not serialized in brdb (the column was removed)
      };
    }
    let color: [number, number, number];
    const c = brick.color;
    if (typeof c === 'number') {
      const entry = save.colors?.[c];
      if (!entry)
        throw new Error(`brdb: ${at}: color palette index ${c} out of range`);
      color = [entry[0], entry[1], entry[2]]; // in-memory palette is RGBA
    } else if (Array.isArray(c)) {
      if (c.length < 3)
        throw new Error(
          `brdb: ${at}: color array must have at least 3 components`
        );
      color = [c[0], c[1], c[2]];
    } else {
      color = [255, 255, 255];
    }
    color = color.map((v, ci) => {
      if (!Number.isInteger(v) || v < 0 || v > 255)
        throw new Error(
          `brdb: ${at}: resolved color component ${ci} must be u8, got ${v}`
        );
      return v;
    }) as [number, number, number];
    const intensity = brick.material_intensity ?? 5;
    if (!Number.isInteger(intensity) || intensity < 0 || intensity > 255)
      throw new Error(
        `brdb: ${at}: material_intensity must be u8, got ${intensity}`
      );
    const ownerIndex = brick.owner_index ?? 0;
    if (
      !Number.isInteger(ownerIndex) ||
      ownerIndex < 0 ||
      ownerIndex > numOwners
    )
      throw new Error(
        `brdb: ${at}: owner_index ${ownerIndex} out of range (0..${numOwners})`
      );
    return {
      assetName,
      procedural: isProceduralAsset(assetName),
      size,
      position,
      direction: brick.direction ?? 4, // ZPositive
      rotation: brick.rotation ?? 0, // Deg0
      collision,
      visible: brick.visibility ?? true,
      materialName,
      intensity,
      color,
      ownerIndex,
      components,
    };
  });
}

class Registry {
  private map = new Map<string, number>();
  add(name: string): number {
    let i = this.map.get(name);
    if (i === undefined) {
      i = this.map.size;
      this.map.set(name, i);
    }
    return i;
  }
  indexOf(name: string): number {
    const i = this.map.get(name);
    if (i === undefined) throw new Error(`brdb: registry miss for ${name}`);
    return i;
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
  get names(): string[] {
    return [...this.map.keys()];
  }
  get size(): number {
    return this.map.size;
  }
}

// Column packer for one chunk of the brick SoA.
class ChunkBuilder {
  private sizeCounters: { AssetIndex: number; NumSizes: number }[] = [];
  private sizes: { X: number; Y: number; Z: number }[] = [];
  private typeIndices: number[] = [];
  private ownerIndices: number[] = [];
  private originalOwnerIndices: number[] = [];
  private relPositions: { X: number; Y: number; Z: number }[] = [];
  private orientations: number[] = [];
  private colPlayer = new BitFlags();
  private colPlayer1 = new BitFlags();
  private colPlayer2 = new BitFlags();
  private colPlayer3 = new BitFlags();
  private colWeapon = new BitFlags();
  private colInteraction = new BitFlags();
  private colPhysics = new BitFlags();
  private visibility = new BitFlags();
  private materialIndices: number[] = [];
  private colors: { R: number; G: number; B: number; A: number }[] = [];
  private sizeIndexMap = new Map<string, number>();
  private numBrickSizes = 0;
  numBricks = 0;

  addBrick(
    b: Brick,
    rel: [number, number, number],
    reg: { materials: Registry; basic: Registry; procedural: Registry },
    basicCount: number
  ) {
    let typeIndex: number;
    if (!b.procedural) {
      typeIndex = reg.basic.indexOf(b.assetName);
    } else {
      const tyIndex = reg.procedural.indexOf(b.assetName);
      const key = `${tyIndex}:${b.size[0]},${b.size[1]},${b.size[2]}`;
      let sizeIndex = this.sizeIndexMap.get(key);
      if (sizeIndex === undefined) {
        // slot = per-chunk running size count, offset past the basic assets
        sizeIndex = this.numBrickSizes + basicCount;
        const last = this.sizeCounters[this.sizeCounters.length - 1];
        if (last && last.AssetIndex === tyIndex) {
          // extend the tail run; the equal-size case is unreachable because
          // a repeated (asset,size) pair hits sizeIndexMap above
          last.NumSizes += 1;
        } else {
          this.sizeCounters.push({ AssetIndex: tyIndex, NumSizes: 1 });
        }
        this.sizes.push({ X: b.size[0], Y: b.size[1], Z: b.size[2] });
        this.sizeIndexMap.set(key, sizeIndex);
        this.numBrickSizes += 1;
      }
      typeIndex = sizeIndex;
    }
    this.typeIndices.push(typeIndex);
    this.ownerIndices.push(b.ownerIndex);
    this.originalOwnerIndices.push(b.ownerIndex); // mirrors owner (legacy rule)
    this.relPositions.push({ X: rel[0], Y: rel[1], Z: rel[2] });
    this.orientations.push(((b.direction & 0x7) << 2) | (b.rotation & 0x3));
    this.colPlayer.push(b.collision.player);
    this.colPlayer1.push(b.collision.player); // Player1..3 mirror player
    this.colPlayer2.push(b.collision.player);
    this.colPlayer3.push(b.collision.player);
    this.colWeapon.push(b.collision.weapon);
    this.colInteraction.push(b.collision.interaction);
    this.colPhysics.push(b.collision.physics);
    this.visibility.push(b.visible);
    this.materialIndices.push(reg.materials.indexOf(b.materialName));
    this.colors.push({
      R: b.color[0],
      G: b.color[1],
      B: b.color[2],
      A: b.intensity,
    });
    this.numBricks += 1;
  }

  toValue(proceduralBrickStartingIndex: number): BrdbValue {
    return {
      ProceduralBrickStartingIndex: proceduralBrickStartingIndex,
      BrickSizeCounters: this.sizeCounters,
      BrickSizes: this.sizes,
      BrickTypeIndices: this.typeIndices,
      OwnerIndices: this.ownerIndices,
      OriginalOwnerIndices: this.originalOwnerIndices,
      RelativePositions: this.relPositions,
      Orientations: this.orientations,
      CollisionFlags_Player: this.colPlayer.toValue(),
      CollisionFlags_Player1: this.colPlayer1.toValue(),
      CollisionFlags_Player2: this.colPlayer2.toValue(),
      CollisionFlags_Player3: this.colPlayer3.toValue(),
      CollisionFlags_Weapon: this.colWeapon.toValue(),
      CollisionFlags_Interaction: this.colInteraction.toValue(),
      CollisionFlags_Physics: this.colPhysics.toValue(),
      VisibilityFlags: this.visibility.toValue(),
      MaterialIndices: this.materialIndices,
      ColorsAndAlphas: this.colors,
      bColorsAreLinear: false, // new saves always store sRGB
    };
  }
}

// Column packer for one chunk's component SoA plus the trailing
// per-instance data structs (appended back-to-back after the SoA; a type
// whose data-struct slot is "None" contributes no trailing bytes).
class ComponentChunkBuilder {
  private counters: { TypeIndex: number; NumInstances: number }[] = [];
  private brickIndices: number[] = [];
  private trailing: { structName: string; data: Record<string, BrdbValue> }[] =
    [];
  numComponents = 0;

  add(
    typeIndex: number,
    brickIndex: number,
    structName: string,
    data: Record<string, BrdbValue>
  ) {
    // run-length counters merge only consecutive same-type instances
    const last = this.counters[this.counters.length - 1];
    if (last && last.TypeIndex === typeIndex) last.NumInstances += 1;
    else this.counters.push({ TypeIndex: typeIndex, NumInstances: 1 });
    this.brickIndices.push(brickIndex);
    if (structName !== 'None') this.trailing.push({ structName, data });
    this.numComponents += 1;
  }

  toBytes(schema: BrdbSchema): Uint8Array {
    const w = new ByteWriter();
    schema.writeValue(w, 'BRSavedComponentChunkSoA', {
      ComponentTypeCounters: this.counters,
      ComponentBrickIndices: this.brickIndices,
      JointBrickIndices: [],
      JointEntityReferences: [],
      JointInitialRelativeOffsets: [],
      JointInitialRelativeRotations: [],
      MicrochipBrickIndices: [],
      MicrochipBrickGridReferences: [],
    });
    for (const t of this.trailing)
      schema.writeValue(
        w,
        t.structName,
        schema.fillStruct(t.structName, t.data)
      );
    return w.toBytes();
  }
}

export function saveToPendingFs(
  save: WriteBrzInput,
  options: WriteBrzOptions = {}
): PendingEntry[] {
  const bricks = normalizeBricks(save);

  // Registry pre-pass: material THEN asset, per brick, in brick order.
  // Registration must complete before any chunk packs — procedural type
  // indices embed the final basic-asset count.
  const materials = new Registry();
  const basic = new Registry();
  const procedural = new Registry();
  for (const b of bricks) {
    materials.add(b.materialName);
    (b.procedural ? procedural : basic).add(b.assetName);
  }
  if (materials.size > 256)
    throw new Error(
      `brdb: too many distinct materials (${materials.size}); MaterialIndices is u8 (max 256)`
    );
  const reg = { materials, basic, procedural };
  const basicCount = basic.size;

  // Component registries: type names first-seen across bricks, with the
  // parallel data-struct column; port names come from the wires that use
  // them (matching the reference writer's used-only registration).
  const componentTypes = new Registry();
  const componentStructNames: string[] = [];
  for (const b of bricks)
    for (const c of b.components) {
      const before = componentTypes.size;
      if (componentTypes.add(c.type) === before)
        componentStructNames.push(COMPONENT_TYPE_STRUCTS.get(c.type)!);
    }

  // Legacy .brs wires name endpoints by brs component; only modern-shaped
  // wires (component_type) are written, matching the components handling.
  const wires = (save.wires ?? []).filter(
    (w): w is BrdbWireInput => 'component_type' in w.source
  );
  const ports = new Registry();
  wires.forEach((wire, wi) => {
    for (const [role, end] of [
      ['source', wire.source],
      ['target', wire.target],
    ] as const) {
      if (
        !Number.isInteger(end.brick_index) ||
        end.brick_index < 0 ||
        end.brick_index >= bricks.length
      )
        throw new Error(
          `brdb: wires[${wi}].${role}: brick_index ${end.brick_index} out of range`
        );
      if (!componentTypes.has(end.component_type))
        throw new Error(
          `brdb: wires[${wi}].${role}: component type '${end.component_type}' is not used by any brick`
        );
      ports.add(end.port);
    }
  });

  // ComponentsShared.schema: the minimal SoA scaffolding, plus (when
  // components are used) the data structs actually referenced and their
  // transitive dependencies pulled from the max catalog schema.
  const componentsSchema = BrdbSchema.fromData(
    SCHEMAS.BRSavedComponentChunkSoA
  );
  if (componentTypes.size > 0) {
    const seeds: string[] = [];
    for (const structName of componentStructNames)
      if (structName !== 'None' && !seeds.includes(structName))
        seeds.push(structName);
    componentsSchema.merge(
      embeddedSchema('BRSavedComponentChunkSoA_max').extractStructsTransitive(
        seeds
      )
    );
  }

  // Owner table: row 0 = PUBLIC, then brick_owners
  const ownerRows: { guid: BrGuid; name: string; display: string }[] = [
    { guid: PUBLIC_GUID, name: 'PUBLIC', display: 'PUBLIC' },
  ];
  for (const o of save.brick_owners ?? []) {
    ownerRows.push({
      guid: uuidToGuid(o.id ?? DEFAULT_UUID),
      name: o.name ?? 'Unknown',
      display: o.display_name ?? o.name ?? 'Unknown',
    });
  }
  const brickCounts = ownerRows.map(() => 0);
  const componentCounts = ownerRows.map(() => 0);

  // Chunking: first-seen chunk order (deterministic; the ChunkIndex SoA
  // rows use the same order)
  const chunkOrder: string[] = [];
  const chunks = new Map<
    string,
    { index: [number, number, number]; builder: ChunkBuilder }
  >();
  const componentChunks = new Map<string, ComponentChunkBuilder>();
  const brickLocations: {
    key: string;
    chunk: [number, number, number];
    localIndex: number;
  }[] = [];
  for (const b of bricks) {
    const { chunk, rel } = toRelative(b.position);
    const key = chunk.join('_');
    let entry = chunks.get(key);
    if (!entry) {
      entry = { index: chunk, builder: new ChunkBuilder() };
      chunks.set(key, entry);
      chunkOrder.push(key);
    }
    const localIndex = entry.builder.numBricks;
    entry.builder.addBrick(b, rel, reg, basicCount);
    brickLocations.push({ key, chunk, localIndex });
    brickCounts[b.ownerIndex] += 1;
    if (b.components.length > 0) {
      componentCounts[b.ownerIndex] += b.components.length;
      let componentBuilder = componentChunks.get(key);
      if (!componentBuilder)
        componentChunks.set(
          key,
          (componentBuilder = new ComponentChunkBuilder())
        );
      for (const c of b.components) {
        const typeIndex = componentTypes.indexOf(c.type);
        componentBuilder.add(
          typeIndex,
          localIndex,
          componentStructNames[typeIndex],
          c.data ?? {}
        );
      }
    }
  }

  // Wires live in the TARGET's chunk. Local rows are same-chunk sources
  // (the legacy writer is single-grid); anything else is a remote source
  // carrying the source grid + chunk.
  interface WireRows {
    remoteSources: Record<string, BrdbValue>[];
    localSources: Record<string, BrdbValue>[];
    remoteTargets: Record<string, BrdbValue>[];
    localTargets: Record<string, BrdbValue>[];
  }
  const wireChunks = new Map<string, WireRows>();
  const chunkWireCounts = new Map<string, number>();
  for (const wire of wires) {
    const source = brickLocations[wire.source.brick_index];
    const targetLoc = brickLocations[wire.target.brick_index];
    const target = {
      BrickIndexInChunk: targetLoc.localIndex,
      ComponentTypeIndex: componentTypes.indexOf(wire.target.component_type),
      PortIndex: ports.indexOf(wire.target.port),
    };
    let rows = wireChunks.get(targetLoc.key);
    if (!rows)
      wireChunks.set(
        targetLoc.key,
        (rows = {
          remoteSources: [],
          localSources: [],
          remoteTargets: [],
          localTargets: [],
        })
      );
    chunkWireCounts.set(
      targetLoc.key,
      (chunkWireCounts.get(targetLoc.key) ?? 0) + 1
    );
    if (source.key === targetLoc.key) {
      rows.localSources.push({
        BrickIndexInChunk: source.localIndex,
        ComponentTypeIndex: componentTypes.indexOf(wire.source.component_type),
        PortIndex: ports.indexOf(wire.source.port),
      });
      rows.localTargets.push(target);
    } else {
      rows.remoteSources.push({
        GridPersistentIndex: 1, // single (main) grid in the legacy writer
        ChunkIndex: {
          X: source.chunk[0],
          Y: source.chunk[1],
          Z: source.chunk[2],
        },
        BrickIndexInChunk: source.localIndex,
        ComponentTypeIndex: componentTypes.indexOf(wire.source.component_type),
        PortIndex: ports.indexOf(wire.source.port),
      });
      rows.remoteTargets.push(target);
    }
  }

  const globalDataSchema = embeddedSchema('BRSavedGlobalDataSoA');
  const ownersSchema = embeddedSchema('BRSavedOwnerTableSoA');
  const chunkIndexSchema = embeddedSchema('BRSavedBrickChunkIndexSoA');
  const chunkSchema = embeddedSchema('BRSavedBrickChunkSoA');
  const wiresSchema = embeddedSchema('BRSavedWireChunkSoA');
  const entityChunkIndexSchema = embeddedSchema('BRSavedEntityChunkIndexSoA');
  const entitySchema = embeddedSchema('BRSavedEntityChunkSoA');

  const globalDataMps = globalDataSchema.encode('BRSavedGlobalDataSoA', {
    EntityTypeNames: [],
    EntityDataClassNames: [],
    BasicBrickAssetNames: basic.names,
    ProceduralBrickAssetNames: procedural.names,
    MaterialAssetNames: materials.names,
    ComponentTypeNames: componentTypes.names,
    ComponentDataStructNames: componentStructNames,
    ComponentWirePortNames: ports.names,
    ExternalAssetReferences: [],
    GlobalGridEntityTypeIndex: -1,
  });

  const ownersMps = ownersSchema.encode('BRSavedOwnerTableSoA', {
    UserIds: ownerRows.map(r => ({
      A: r.guid.A,
      B: r.guid.B,
      C: r.guid.C,
      D: r.guid.D,
    })),
    UserNames: ownerRows.map(r => r.name),
    DisplayNames: ownerRows.map(r => r.display),
    EntityCounts: ownerRows.map(() => 0),
    BrickCounts: brickCounts,
    ComponentCounts: componentCounts,
    WireCounts: ownerRows.map(() => 0),
  });

  const chunkIndexMps = chunkIndexSchema.encode('BRSavedBrickChunkIndexSoA', {
    Chunk3DIndices: chunkOrder.map(k => {
      const [X, Y, Z] = chunks.get(k)!.index;
      return { X, Y, Z };
    }),
    // origin chunk gets zero offsets; every other chunk (CHUNK_HALF)³
    ChunkOffsets: chunkOrder.map(k => {
      const zero = chunks.get(k)!.index.every(v => v === 0);
      const off = zero ? 0 : CHUNK_HALF;
      return { X: off, Y: off, Z: off };
    }),
    ChunkSizes: chunkOrder.map(() => CHUNK_SIZE),
    NumBricks: chunkOrder.map(k => chunks.get(k)!.builder.numBricks),
    NumComponents: chunkOrder.map(
      k => componentChunks.get(k)?.numComponents ?? 0
    ),
    NumWires: chunkOrder.map(k => chunkWireCounts.get(k) ?? 0),
  });

  const entityChunkIndexMps = entityChunkIndexSchema.encode(
    'BRSavedEntityChunkIndexSoA',
    {
      NextPersistentIndex: 2, // sub-grids/entities start at 2; none in phase 1
      Chunk3DIndices: [],
      NumEntities: [],
    }
  );

  const utf8 = new TextEncoder();
  const bundle: BundleJson = {
    type: 'World',
    iD: '00000000-0000-0000-0000-000000000000',
    name: '',
    version: '',
    tags: [],
    authors: save.author?.name ? [save.author.name] : [],
    createdAt: '0001.01.01-00.00.00',
    updatedAt: '0001.01.01-00.00.00',
    description: save.description ?? 'A Generated World',
    dependencies: [],
    gameVersion: 'CL0',
    ...options.bundle,
  };

  // Tree creation order below defines archive ids — it is part of the
  // byte format; do not reorder.
  const gridDir: PendingEntry[] = [['ChunkIndex.mps', file(chunkIndexMps)]];
  if (chunkOrder.length > 0) {
    gridDir.push([
      'Chunks',
      folder(
        chunkOrder.map(k => [
          `${k}.mps`,
          file(
            chunkSchema.encode(
              'BRSavedBrickChunkSoA',
              chunks.get(k)!.builder.toValue(basicCount)
            )
          ),
        ])
      ),
    ]);
  }
  if (componentChunks.size > 0) {
    gridDir.push([
      'Components',
      folder(
        chunkOrder
          .filter(k => componentChunks.has(k))
          .map(k => [
            `${k}.mps`,
            file(componentChunks.get(k)!.toBytes(componentsSchema)),
          ])
      ),
    ]);
  }
  if (wireChunks.size > 0) {
    gridDir.push([
      'Wires',
      folder(
        chunkOrder
          .filter(k => wireChunks.has(k))
          .map(k => {
            const rows = wireChunks.get(k)!;
            return [
              `${k}.mps`,
              file(
                wiresSchema.encode('BRSavedWireChunkSoA', {
                  RemoteWireSources: rows.remoteSources,
                  LocalWireSources: rows.localSources,
                  RemoteWireTargets: rows.remoteTargets,
                  LocalWireTargets: rows.localTargets,
                  PendingPropagationFlags: { Flags: [] },
                })
              ),
            ];
          })
      ),
    ]);
  }
  return [
    [
      'Meta',
      folder([
        ['Bundle.json', file(utf8.encode(JSON.stringify(bundle)))],
        // Screenshot.jpg / Thumbnail.png: no content -> omitted entirely
        [
          'World.json',
          file(
            utf8.encode(
              JSON.stringify({ environment: options.environment ?? 'Plate' })
            )
          ),
        ],
      ]),
    ],
    [
      'World',
      folder([
        [
          '0',
          folder([
            ['GlobalData.schema', file(globalDataSchema.toBinary())],
            ['GlobalData.mps', file(globalDataMps)],
            ['Owners.schema', file(ownersSchema.toBinary())],
            ['Owners.mps', file(ownersMps)],
            [
              'Bricks',
              folder([
                ['ChunkIndexShared.schema', file(chunkIndexSchema.toBinary())],
                ['ChunksShared.schema', file(chunkSchema.toBinary())],
                ['WiresShared.schema', file(wiresSchema.toBinary())],
                ['ComponentsShared.schema', file(componentsSchema.toBinary())],
                ['Grids', folder([['1', folder(gridDir)]])],
              ]),
            ],
            [
              'Entities',
              folder([
                ['ChunkIndex.schema', file(entityChunkIndexSchema.toBinary())],
                ['ChunkIndex.mps', file(entityChunkIndexMps)],
                ['ChunksShared.schema', file(entitySchema.toBinary())],
              ]),
            ],
          ]),
        ],
      ]),
    ],
  ];
}

/** Write a .brz world from a legacy .brs-shaped WriteSaveObject. A
 * builder-style world API for authoring saves from scratch is planned;
 * this entry point exists for converting existing saves. */
export function writeBrzLegacy(
  save: WriteBrzInput,
  options: WriteBrzOptions = {}
): Uint8Array {
  const containerOptions: BrzContainerOptions = { compress: options.compress };
  return writeBrzContainer(saveToPendingFs(save, options), containerOptions);
}
