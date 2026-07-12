// Brick/entity/wire state -> brdb world tree -> .brz. Two entry points:
// writeBrzLegacy converts a legacy .brs-shaped save (single grid), and the
// World builder authors multi-grid worlds with entities, microchips, and
// prefab metadata, mirroring the reference crate's wrapper::World.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_UUID } from '../brs/constants';
import type { WriteSaveObject } from '../brs/types';
import { BitFlags } from './bits';
import { BrzContainerOptions, Compressor, writeBrzContainer } from './brz';
import { ByteWriter } from './bytes';
import { isProceduralAsset } from './catalog';
import {
  COMPONENT_STRUCT_DEFAULTS,
  COMPONENT_TYPE_STRUCTS,
  ENTITY_TYPE_STRUCTS,
} from './componentDb';
import type { ComponentTypeDataMap } from './componentTypes';
import { BrGuid, PUBLIC_GUID, uuidToGuid } from './guid';
import { file, folder, PendingEntry } from './pending';
import { BrdbSchema, BrdbValue, embeddedSchema } from './schema';
import { SCHEMAS } from './schemas';

export const CHUNK_SIZE = 2048;
export const CHUNK_HALF = 1024;

/** One entry of Bundle.json's `authors` array as the game writes it. */
export interface BundleAuthor {
  iD: string;
  name: string;
}

/** Bundle.json `color` (RGBA, 0..=1 floats; the game writes whole numbers
 * for white). */
export interface BundleColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BundleJson {
  type: string;
  iD: string;
  name: string;
  version: string;
  tags: string[];
  authors: BundleAuthor[];
  createdAt: string;
  updatedAt: string;
  description: string;
  /** Absent in older generated bundles; the game always writes it. */
  color?: BundleColor;
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
  /** Meta/Thumbnail.png content; omitted -> file not written. */
  thumbnail?: Uint8Array;
  /** Meta/Screenshot.jpg content; omitted -> file not written. The game
   * reads it for world previews, and for prefab previews when present. */
  screenshot?: Uint8Array;
}

/** A brdb-native component on a brick. Legacy brs components
 * (save.components / brick.components) are NOT converted. */
/** Typed component input: known component types complete their `data`
 * fields in the editor; unknown type strings stay accepted (they throw at
 * write time unless the component db knows them). Omitted data fields take
 * the game's default values (zero values where no default is known). */
export type BrdbComponentInput =
  | {
      [T in keyof ComponentTypeDataMap]: {
        /** brdb component type name, e.g. 'Component_Internal_Seat' */
        type: T;
        /** fields of the component's data struct */
        data?: Partial<ComponentTypeDataMap[T]>;
      };
    }[keyof ComponentTypeDataMap]
  | {
      type: string & {};
      data?: Record<string, BrdbValue>;
    };

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
  /** Required for procedural assets; optional for basic (non-procedural)
   * assets, whose size is fixed by the asset and never stored. */
  size?: WriteSaveObject['bricks'][number]['size'];
}

export interface BrdbSaveExtras {
  wires?: BrdbWireInput[];
}

/** The legacy save shape plus the brdb-native extras. The brick-level
 * legacy `components` map and the save-level legacy `wires` list are
 * replaced by the modern forms. */
export type WriteBrzSave = Omit<WriteSaveObject, 'bricks' | 'wires'> & {
  bricks: (Omit<WriteSaveObject['bricks'][number], 'components' | 'size'> &
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
    const procedural = isProceduralAsset(assetName);
    if (brick.size === undefined && procedural)
      throw new Error(
        `brdb: ${at}: procedural asset ${assetName} requires a size`
      );
    // Basic assets have a fixed size that is never stored; default it.
    const size = (brick.size ?? [0, 0, 0]).map(v => {
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
      procedural,
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
  // per-instance records in add (brick) order; the SoA columns are derived
  // at toBytes time so instances can be regrouped by type first
  private instances: {
    typeIndex: number;
    brickIndex: number;
    structName: string;
    data: Record<string, BrdbValue>;
  }[] = [];
  // outer-microchip-brick <-> inner-grid-entity pairings on this chunk
  private microchipBrickIndices: number[] = [];
  private microchipGridReferences: number[] = [];

  get numComponents(): number {
    return this.instances.length;
  }

  add(
    typeIndex: number,
    brickIndex: number,
    structName: string,
    data: Record<string, BrdbValue>
  ) {
    this.instances.push({ typeIndex, brickIndex, structName, data });
  }

  addMicrochipLink(brickIndex: number, gridReference: number) {
    this.microchipBrickIndices.push(brickIndex);
    this.microchipGridReferences.push(gridReference);
  }

  toBytes(schema: BrdbSchema): Uint8Array {
    // Run-length counters merge consecutive same-type instances. The game
    // reads each counter run's trailing data as a single type, so a type
    // split across multiple runs (a brick carrying several component
    // types, or adjacent bricks differing in type) would desync its data
    // stream. When that happens, regroup so each type forms one contiguous
    // run — stable sort keeps ascending brick order within a type, and the
    // per-instance records keep brick indices and data paired.
    const runsOf = (list: typeof this.instances) => {
      const runs: { TypeIndex: number; NumInstances: number }[] = [];
      for (const inst of list) {
        const last = runs[runs.length - 1];
        if (last && last.TypeIndex === inst.typeIndex) last.NumInstances += 1;
        else runs.push({ TypeIndex: inst.typeIndex, NumInstances: 1 });
      }
      return runs;
    };
    let instances = this.instances;
    let counters = runsOf(instances);
    if (new Set(counters.map(c => c.TypeIndex)).size < counters.length) {
      instances = [...instances].sort((a, b) => a.typeIndex - b.typeIndex);
      counters = runsOf(instances);
    }

    const w = new ByteWriter();
    schema.writeValue(w, 'BRSavedComponentChunkSoA', {
      ComponentTypeCounters: counters,
      ComponentBrickIndices: instances.map(i => i.brickIndex),
      JointBrickIndices: [],
      JointEntityReferences: [],
      JointInitialRelativeOffsets: [],
      JointInitialRelativeRotations: [],
      MicrochipBrickIndices: this.microchipBrickIndices,
      MicrochipBrickGridReferences: this.microchipGridReferences,
    });
    for (const t of instances)
      if (t.structName !== 'None')
        schema.writeValue(
          w,
          t.structName,
          schema.fillStruct(
            t.structName,
            t.data,
            COMPONENT_STRUCT_DEFAULTS.get(t.structName)
          )
        );
    return w.toBytes();
  }
}

// ---- internal write model (shared by the legacy converter and World) ----

interface ModelWireEnd {
  gridSlot: number; // index into model.grids
  brickIndex: number; // index into that grid's brick list
  componentType: string;
  port: string;
}

interface NormEntity {
  type: string;
  className: string;
  location: { X: number; Y: number; Z: number };
  rotation: { X: number; Y: number; Z: number; W: number };
  ownerIndex: number;
  frozen: boolean;
  sleeping: boolean;
  velocity: { X: number; Y: number; Z: number };
  angularVelocity: { X: number; Y: number; Z: number };
  colors: { R: number; G: number; B: number; A: number }[]; // exactly 8
  data: Record<string, BrdbValue>;
}

interface WorldModel {
  description?: string;
  author?: { id?: string; name: string };
  /** owner table rows; row 0 is the built-in PUBLIC owner */
  ownerRows: { guid: BrGuid; name: string; display: string }[];
  /** normalized bricks per grid; slot 0 is the main grid (grid id 1) */
  grids: Brick[][];
  /** on-disk grid id per slot: 1 for slot 0, then each sub-grid entity's
   * persistent index */
  gridIds: number[];
  /** entities in insertion order; persistent index = 2 + position */
  entities: NormEntity[];
  wires: { source: ModelWireEnd; target: ModelWireEnd }[];
  /** outer-microchip-brick -> inner-grid pairings; gridReference is the
   * inner grid entity's persistent index */
  microchipLinks: {
    gridSlot: number;
    brickIndex: number;
    gridReference: number;
  }[];
  /** Meta/Prefab.json content; non-null switches the bundle to a prefab
   * (Bundle.json type "Prefab" + Prefab.json, no World.json) */
  prefab: Record<string, unknown> | null;
  /** Prefabs/ — embedded prefab archives: [root-relative path, raw .brz
   * bytes], insertion-ordered (order defines archive ids). */
  prefabs: [string, Uint8Array][];
}

function ownerRowsFrom(
  owners: WriteSaveObject['brick_owners']
): WorldModel['ownerRows'] {
  const rows = [{ guid: PUBLIC_GUID, name: 'PUBLIC', display: 'PUBLIC' }];
  for (const o of owners ?? [])
    rows.push({
      guid: uuidToGuid(o.id ?? DEFAULT_UUID),
      name: o.name ?? 'Unknown',
      display: o.display_name ?? o.name ?? 'Unknown',
    });
  return rows;
}

export function saveToPendingFs(
  save: WriteBrzInput,
  options: WriteBrzOptions = {}
): PendingEntry[] {
  const bricks = normalizeBricks(save);
  // Legacy .brs wires name endpoints by brs component; only modern-shaped
  // wires (component_type) are written, matching the components handling.
  const wires = (save.wires ?? []).filter(
    (w): w is BrdbWireInput => 'component_type' in w.source
  );
  return modelToPendingFs(
    {
      description: save.description,
      author: save.author?.name
        ? { id: save.author.id, name: save.author.name }
        : undefined,
      prefabs: [],
      ownerRows: ownerRowsFrom(save.brick_owners),
      grids: [bricks],
      gridIds: [1],
      entities: [],
      wires: wires.map(w => ({
        source: {
          gridSlot: 0,
          brickIndex: w.source.brick_index,
          componentType: w.source.component_type,
          port: w.source.port,
        },
        target: {
          gridSlot: 0,
          brickIndex: w.target.brick_index,
          componentType: w.target.component_type,
          port: w.target.port,
        },
      })),
      microchipLinks: [],
      prefab: null,
    },
    options
  );
}

function modelToPendingFs(
  model: WorldModel,
  options: WriteBrzOptions = {}
): PendingEntry[] {
  // Registration order: grids in slot order (main grid first), matching
  // the reference writer's meta pre-pass over bricks then sub-grids.
  const allBricks = model.grids.flat();

  // Registry pre-pass: material THEN asset, per brick, in brick order.
  // Registration must complete before any chunk packs — procedural type
  // indices embed the final basic-asset count.
  const materials = new Registry();
  const basic = new Registry();
  const procedural = new Registry();
  for (const b of allBricks) {
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
  for (const b of allBricks)
    for (const c of b.components) {
      const before = componentTypes.size;
      if (componentTypes.add(c.type) === before)
        componentStructNames.push(COMPONENT_TYPE_STRUCTS.get(c.type)!);
    }

  const ports = new Registry();
  model.wires.forEach((wire, wi) => {
    for (const [role, end] of [
      ['source', wire.source],
      ['target', wire.target],
    ] as const) {
      const gridLen = model.grids[end.gridSlot]?.length ?? 0;
      if (
        !Number.isInteger(end.brickIndex) ||
        end.brickIndex < 0 ||
        end.brickIndex >= gridLen
      )
        throw new Error(
          `brdb: wires[${wi}].${role}: brick_index ${end.brickIndex} out of range`
        );
      if (!componentTypes.has(end.componentType))
        throw new Error(
          `brdb: wires[${wi}].${role}: component type '${end.componentType}' is not used by any brick`
        );
      ports.add(end.port);
    }
  });

  // Entity type registry: first-seen, with the parallel class-name column.
  const entityTypes = new Registry();
  const entityClassNames: string[] = [];
  for (const e of model.entities) {
    const before = entityTypes.size;
    if (entityTypes.add(e.type) === before) entityClassNames.push(e.className);
  }

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

  // Owner table: row 0 = PUBLIC, then the save's owners.
  const ownerRows = model.ownerRows;
  const brickCounts = ownerRows.map(() => 0);
  const componentCounts = ownerRows.map(() => 0);
  const entityCounts = ownerRows.map(() => 0);
  for (const e of model.entities) entityCounts[e.ownerIndex] += 1;

  // Chunking, per grid: first-seen chunk order (deterministic; each grid's
  // ChunkIndex SoA rows use the same order).
  interface WireRows {
    remoteSources: Record<string, BrdbValue>[];
    localSources: Record<string, BrdbValue>[];
    remoteTargets: Record<string, BrdbValue>[];
    localTargets: Record<string, BrdbValue>[];
  }
  interface GridPack {
    chunkOrder: string[];
    chunks: Map<
      string,
      { index: [number, number, number]; builder: ChunkBuilder }
    >;
    componentChunks: Map<string, ComponentChunkBuilder>;
    brickLocations: {
      key: string;
      chunk: [number, number, number];
      localIndex: number;
    }[];
    wireChunks: Map<string, WireRows>;
    chunkWireCounts: Map<string, number>;
  }
  const packs: GridPack[] = model.grids.map(gridBricks => {
    const pack: GridPack = {
      chunkOrder: [],
      chunks: new Map(),
      componentChunks: new Map(),
      brickLocations: [],
      wireChunks: new Map(),
      chunkWireCounts: new Map(),
    };
    for (const b of gridBricks) {
      const { chunk, rel } = toRelative(b.position);
      const key = chunk.join('_');
      let entry = pack.chunks.get(key);
      if (!entry) {
        entry = { index: chunk, builder: new ChunkBuilder() };
        pack.chunks.set(key, entry);
        pack.chunkOrder.push(key);
      }
      const localIndex = entry.builder.numBricks;
      entry.builder.addBrick(b, rel, reg, basicCount);
      pack.brickLocations.push({ key, chunk, localIndex });
      brickCounts[b.ownerIndex] += 1;
      if (b.components.length > 0) {
        componentCounts[b.ownerIndex] += b.components.length;
        let componentBuilder = pack.componentChunks.get(key);
        if (!componentBuilder)
          pack.componentChunks.set(
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
    return pack;
  });

  // Microchip links land on the chunk holding the outer shell brick.
  for (const link of model.microchipLinks) {
    const pack = packs[link.gridSlot];
    const loc = pack?.brickLocations[link.brickIndex];
    if (!loc)
      throw new Error(
        `brdb: microchip link brick index ${link.brickIndex} out of range`
      );
    let cb = pack.componentChunks.get(loc.key);
    if (!cb)
      pack.componentChunks.set(loc.key, (cb = new ComponentChunkBuilder()));
    cb.addMicrochipLink(loc.localIndex, link.gridReference);
  }

  // Wires live in the TARGET's grid + chunk. Local rows are
  // same-grid-same-chunk sources; anything else is a remote source
  // carrying the source grid + chunk.
  for (const wire of model.wires) {
    const source =
      packs[wire.source.gridSlot].brickLocations[wire.source.brickIndex];
    const targetPack = packs[wire.target.gridSlot];
    const targetLoc = targetPack.brickLocations[wire.target.brickIndex];
    const target = {
      BrickIndexInChunk: targetLoc.localIndex,
      ComponentTypeIndex: componentTypes.indexOf(wire.target.componentType),
      PortIndex: ports.indexOf(wire.target.port),
    };
    let rows = targetPack.wireChunks.get(targetLoc.key);
    if (!rows)
      targetPack.wireChunks.set(
        targetLoc.key,
        (rows = {
          remoteSources: [],
          localSources: [],
          remoteTargets: [],
          localTargets: [],
        })
      );
    targetPack.chunkWireCounts.set(
      targetLoc.key,
      (targetPack.chunkWireCounts.get(targetLoc.key) ?? 0) + 1
    );
    if (
      wire.source.gridSlot === wire.target.gridSlot &&
      source.key === targetLoc.key
    ) {
      rows.localSources.push({
        BrickIndexInChunk: source.localIndex,
        ComponentTypeIndex: componentTypes.indexOf(wire.source.componentType),
        PortIndex: ports.indexOf(wire.source.port),
      });
      rows.localTargets.push(target);
    } else {
      rows.remoteSources.push({
        GridPersistentIndex: model.gridIds[wire.source.gridSlot],
        ChunkIndex: {
          X: source.chunk[0],
          Y: source.chunk[1],
          Z: source.chunk[2],
        },
        BrickIndexInChunk: source.localIndex,
        ComponentTypeIndex: componentTypes.indexOf(wire.source.componentType),
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
    EntityTypeNames: entityTypes.names,
    EntityDataClassNames: entityClassNames,
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
    EntityCounts: entityCounts,
    BrickCounts: brickCounts,
    ComponentCounts: componentCounts,
    WireCounts: ownerRows.map(() => 0),
  });

  // Entities: one chunk at (0,0,0) holding every entity, persistent
  // indices 2..; empty tables when there are none.
  const totalEntities = model.entities.length;
  const entityChunkIndexMps = entityChunkIndexSchema.encode(
    'BRSavedEntityChunkIndexSoA',
    {
      NextPersistentIndex: 2 + totalEntities,
      Chunk3DIndices: totalEntities ? [{ X: 0, Y: 0, Z: 0 }] : [],
      NumEntities: totalEntities ? [totalEntities] : [],
    }
  );
  let entityChunkMps: Uint8Array | null = null;
  if (totalEntities > 0) {
    const counters: { TypeIndex: number; NumEntities: number }[] = [];
    const locked = new BitFlags();
    const sleepingFlags = new BitFlags();
    for (const e of model.entities) {
      const typeIndex = entityTypes.indexOf(e.type);
      const last = counters[counters.length - 1];
      if (last && last.TypeIndex === typeIndex) last.NumEntities += 1;
      else counters.push({ TypeIndex: typeIndex, NumEntities: 1 });
      locked.push(e.frozen);
      sleepingFlags.push(e.sleeping);
    }
    const w = new ByteWriter();
    entitySchema.writeValue(w, 'BRSavedEntityChunkSoA', {
      TypeCounters: counters,
      PersistentIndices: model.entities.map((_, i) => 2 + i),
      OwnerIndices: model.entities.map(e => e.ownerIndex),
      OriginalOwnerIndices: model.entities.map(e => e.ownerIndex),
      Locations: model.entities.map(e => e.location),
      Rotations: model.entities.map(e => e.rotation),
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: locked.toValue(),
      PhysicsSleepingFlags: sleepingFlags.toValue(),
      WeldParentIndices: [],
      LinearVelocities: model.entities.map(e => e.velocity),
      AngularVelocities: model.entities.map(e => e.angularVelocity),
      ColorsAndAlphas: model.entities.map(e =>
        Object.fromEntries(e.colors.map((c, ci) => [`Color${ci}`, c]))
      ),
      RemainingLifeSpans: model.entities.map(() => 0),
      bColorsAreLinear: false, // new saves always store sRGB
    });
    // Trailing per-entity data structs, in SoA order.
    model.entities.forEach((e, i) => {
      if (e.className === 'None') return;
      try {
        entitySchema.writeValue(
          w,
          e.className,
          entitySchema.fillStruct(e.className, e.data)
        );
      } catch (err) {
        throw new Error(
          `brdb: entities[${i}] (${e.type}) data: ${(err as Error).message}`
        );
      }
    });
    entityChunkMps = w.toBytes();
  }

  const utf8 = new TextEncoder();
  const bundle: BundleJson = {
    type: model.prefab ? 'Prefab' : 'World',
    iD: DEFAULT_UUID,
    name: '',
    version: '',
    tags: [],
    // The game writes authors as { iD, name } objects.
    authors: model.author
      ? [{ iD: model.author.id ?? DEFAULT_UUID, name: model.author.name }]
      : [],
    createdAt: '0001.01.01-00.00.00',
    updatedAt: '0001.01.01-00.00.00',
    description: model.description ?? 'A Generated World',
    dependencies: [],
    gameVersion: 'CL0',
    ...options.bundle,
  };

  // Tree creation order below defines archive ids — it is part of the
  // byte format; do not reorder.
  const makeGridDir = (pack: GridPack, isMainGrid: boolean): PendingEntry[] => {
    // The game writes ChunkOffsets (0,0,0) for every main-grid chunk and
    // (CHUNK_HALF)^3 for every sub-grid chunk, regardless of coordinate
    // (surveyed across game-authored worlds). Anything else displaces
    // bricks across chunk borders in-game.
    const off = isMainGrid ? 0 : CHUNK_HALF;
    const chunkIndexMps = chunkIndexSchema.encode('BRSavedBrickChunkIndexSoA', {
      Chunk3DIndices: pack.chunkOrder.map(k => {
        const [X, Y, Z] = pack.chunks.get(k)!.index;
        return { X, Y, Z };
      }),
      ChunkOffsets: pack.chunkOrder.map(() => ({ X: off, Y: off, Z: off })),
      ChunkSizes: pack.chunkOrder.map(() => CHUNK_SIZE),
      NumBricks: pack.chunkOrder.map(
        k => pack.chunks.get(k)!.builder.numBricks
      ),
      NumComponents: pack.chunkOrder.map(
        k => pack.componentChunks.get(k)?.numComponents ?? 0
      ),
      NumWires: pack.chunkOrder.map(k => pack.chunkWireCounts.get(k) ?? 0),
    });
    const gridDir: PendingEntry[] = [['ChunkIndex.mps', file(chunkIndexMps)]];
    if (pack.chunkOrder.length > 0) {
      gridDir.push([
        'Chunks',
        folder(
          pack.chunkOrder.map(k => [
            `${k}.mps`,
            file(
              chunkSchema.encode(
                'BRSavedBrickChunkSoA',
                pack.chunks.get(k)!.builder.toValue(basicCount)
              )
            ),
          ])
        ),
      ]);
    }
    if (pack.componentChunks.size > 0) {
      gridDir.push([
        'Components',
        folder(
          pack.chunkOrder
            .filter(k => pack.componentChunks.has(k))
            .map(k => [
              `${k}.mps`,
              file(pack.componentChunks.get(k)!.toBytes(componentsSchema)),
            ])
        ),
      ]);
    }
    if (pack.wireChunks.size > 0) {
      gridDir.push([
        'Wires',
        folder(
          pack.chunkOrder
            .filter(k => pack.wireChunks.has(k))
            .map(k => {
              const rows = pack.wireChunks.get(k)!;
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
    return gridDir;
  };

  const metaDir: PendingEntry[] = [
    ['Bundle.json', file(utf8.encode(JSON.stringify(bundle)))],
  ];
  if (model.prefab) {
    // Prefabs write Prefab.json (+ the optional Screenshot/Thumbnail) and
    // omit World.json.
    metaDir.push([
      'Prefab.json',
      file(utf8.encode(serializePrefabJson(model.prefab))),
    ]);
  }
  if (options.screenshot)
    metaDir.push(['Screenshot.jpg', file(options.screenshot)]);
  if (options.thumbnail)
    metaDir.push(['Thumbnail.png', file(options.thumbnail)]);
  if (!model.prefab)
    metaDir.push([
      'World.json',
      file(
        utf8.encode(
          JSON.stringify({ environment: options.environment ?? 'Plate' })
        )
      ),
    ]);

  const entitiesDir: PendingEntry[] = [
    ['ChunkIndex.schema', file(entityChunkIndexSchema.toBinary())],
    ['ChunkIndex.mps', file(entityChunkIndexMps)],
    ['ChunksShared.schema', file(entitySchema.toBinary())],
  ];
  if (entityChunkMps)
    entitiesDir.push(['Chunks', folder([['0_0_0.mps', file(entityChunkMps)]])]);

  const root: PendingEntry[] = [
    ['Meta', folder(metaDir)],
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
                [
                  'Grids',
                  folder(
                    packs.map((pack, slot) => [
                      String(model.gridIds[slot]),
                      folder(makeGridDir(pack, model.gridIds[slot] === 1)),
                    ])
                  ),
                ],
              ]),
            ],
            ['Entities', folder(entitiesDir)],
          ]),
        ],
      ]),
    ],
  ];
  // Embedded prefabs (root Prefabs/ folder), only when present — bundles
  // with no prefab references have no Prefabs folder at all. Paths nest
  // generically so future subpaths beyond Uploads/ survive.
  if (model.prefabs.length > 0) {
    for (const [path, bytes] of model.prefabs) {
      const segments = path.split('/');
      let children = root;
      for (let i = 0; i < segments.length - 1; i++) {
        let entry = children.find(
          ([n, node]) => n === segments[i] && node.type === 'folder'
        );
        if (!entry) {
          entry = [segments[i], folder([])];
          children.push(entry);
        }
        children = (entry[1] as { type: 'folder'; children: PendingEntry[] })
          .children;
      }
      children.push([segments[segments.length - 1], file(bytes)]);
    }
  }
  return root;
}

// ---- World builder (mirrors the reference crate's wrapper::World) ----

/** An entity to place in the world. Grid entities (dynamic/microchip brick
 * grids) come from `World.addBrickGrid`/`World.addMicrochip`. */
export interface BrdbEntityInput {
  /** entity type name; default 'Entity_DynamicBrickGrid' */
  type?: string;
  location?: { X: number; Y: number; Z: number };
  rotation?: { X: number; Y: number; Z: number; W: number };
  owner_index?: number;
  frozen?: boolean;
  sleeping?: boolean;
  linear_velocity?: { X: number; Y: number; Z: number };
  angular_velocity?: { X: number; Y: number; Z: number };
  /** up to 8 entity palette colors; missing slots default to white */
  colors?: { R: number; G: number; B: number; A: number }[];
  /** fields of the entity's data class struct; omitted fields zero-fill */
  data?: Record<string, BrdbValue>;
}

/** A brick for the World builder: the legacy brick shape with the asset
 * and material referenced by NAME instead of by table index. */
export type WorldBrickInput = Omit<
  WriteBrzSave['bricks'][number],
  'asset_name_index' | 'material_index' | 'color' | 'owner_index'
> & {
  /** brick asset name; default 'PB_DefaultBrick' */
  asset?: string;
  /** material asset name; default 'BMC_Plastic' */
  material?: string;
  color?: [number, number, number];
  /** index returned by `World.addOwner` (0 = the built-in PUBLIC) */
  owner_index?: number;
};

export interface WorldBrickHandle {
  /** grid slot (0 = main grid) */
  readonly grid: number;
  /** index within that grid's brick list */
  readonly index: number;
}
export interface WorldGridHandle {
  readonly grid: number;
  readonly entityOrder: number;
}
export interface WorldEntityHandle {
  readonly entityOrder: number;
}
export interface WorldWireEndpoint {
  brick: WorldBrickHandle;
  component_type: string;
  port: string;
}

export interface WorldPrefabOptions {
  isMicrochipPrefab?: boolean;
  isPhysicsGrid?: boolean;
  freezePhysicsGrid?: boolean;
  freezeGlobalGrid?: boolean;
  addedGlobalGridOffset?: { x: number; y: number; z: number };
}

export interface WorldMicrochipOptions {
  /** world position of the outer microchip shell brick */
  position: [number, number, number];
  color?: [number, number, number];
  owner_index?: number;
  /** inner grid entity location; default {X:0, Y:0, Z:40} */
  entityLocation?: { X: number; Y: number; Z: number };
  /** inner grid plane half-extent in grid units; default {X:14, Y:14, Z:2}
   * (matches in-game placement) */
  planeExtent?: { X: number; Y: number; Z: number };
  /** whether the chip starts collapsed; default true */
  collapsed?: boolean;
}

function normalizeEntity(
  e: BrdbEntityInput,
  i: number,
  numOwners: number
): NormEntity {
  const type = e.type ?? 'Entity_DynamicBrickGrid';
  const className = ENTITY_TYPE_STRUCTS.get(type);
  if (className === undefined)
    throw new Error(`brdb: entities[${i}]: unknown entity type '${type}'`);
  const ownerIndex = e.owner_index ?? 0;
  if (!Number.isInteger(ownerIndex) || ownerIndex < 0 || ownerIndex > numOwners)
    throw new Error(
      `brdb: entities[${i}]: owner_index ${ownerIndex} out of range (0..${numOwners})`
    );
  const colors = [...(e.colors ?? [])];
  if (colors.length > 8)
    throw new Error(
      `brdb: entities[${i}]: at most 8 colors, got ${colors.length}`
    );
  while (colors.length < 8) colors.push({ R: 255, G: 255, B: 255, A: 255 });
  return {
    type,
    className,
    location: e.location ?? { X: 0, Y: 0, Z: 0 },
    rotation: e.rotation ?? { X: 0, Y: 0, Z: 0, W: 1 },
    ownerIndex,
    frozen: e.frozen ?? false,
    sleeping: e.sleeping ?? false,
    velocity: e.linear_velocity ?? { X: 0, Y: 0, Z: 0 },
    angularVelocity: e.angular_velocity ?? { X: 0, Y: 0, Z: 0 },
    colors,
    data: e.data ?? {},
  };
}

// serde_json prints whole f64 values with a trailing ".0" (5 -> "5.0") where
// JSON.stringify prints "5". JSON numbers can't carry the ".0", so pivot
// vectors (the only f64 fields in Prefab.json) are wrapped in F64: it tags the
// value with a sentinel during stringify, which serializePrefabJson rewrites
// to serde's format. This keeps the JSON SHAPE driven entirely by
// computePrefabJson — only float formatting is special-cased.
const F64_SENTINEL = '@@f64:';

class F64 {
  constructor(readonly value: number) {}
  toJSON(): string {
    return `${F64_SENTINEL}${this.value}`;
  }
}

const f64vec = (x: number, y: number, z: number) => ({
  x: new F64(x),
  y: new F64(y),
  z: new F64(z),
});

/** Serialize a Prefab.json object to bytes matching the reference crate:
 * field order comes from object insertion order (see computePrefabJson) and
 * f64-tagged values (F64) get serde's trailing-".0" whole-number formatting.
 * Non-integral values (2.5) print identically in both writers. */
function serializePrefabJson(prefab: Record<string, unknown>): string {
  return JSON.stringify(prefab).replace(
    new RegExp(`"${F64_SENTINEL}(-?[\\d.eE+-]+)"`, 'g'),
    (_, n) => (Number.isInteger(Number(n)) ? `${n}.0` : n)
  );
}

/** Meta/Prefab.json from the main-grid brick bounding box: all four pivots
 * are the bounds box (in brick units), like the reference crate's
 * PrefabJson::from_bounds. Sub-grids are excluded — their bricks live
 * inside an entity. */
function computePrefabJson(
  mainBricks: Brick[],
  opts: WorldPrefabOptions
): Record<string, unknown> {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  mainBricks.forEach((b, i) => {
    // A brick's local bounds: procedural size, the 1x1 plate footprint for
    // the collapsed microchip shell, or a 1x1 brick footprint fallback.
    const half = b.procedural
      ? b.size
      : b.assetName === 'B_1x1_Microchip'
      ? [5, 5, 2]
      : [5, 5, 6];
    for (let ax = 0; ax < 3; ax++) {
      const lo = b.position[ax] - half[ax];
      const hi = b.position[ax] + half[ax];
      if (i === 0 || lo < min[ax]) min[ax] = lo;
      if (i === 0 || hi > max[ax]) max[ax] = hi;
    }
  });
  // f64 pivot components (serde formatting handled by serializePrefabJson).
  const pivot = {
    center: f64vec(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ),
    halfExtent: f64vec(
      (max[0] - min[0]) / 2,
      (max[1] - min[1]) / 2,
      (max[2] - min[2]) / 2
    ),
  };
  return {
    pivots: {
      bottomStudsPivot: pivot,
      studsExpandedPivot: pivot,
      topStudsPivot: pivot,
      boundsPivot: pivot,
      bottomStudsDirection: 'Z_Negative',
      topStudsDirection: 'Z_Positive',
      bBottomStudsValid: true,
      bTopStudsValid: true,
    },
    addedGlobalGridOffset: opts.addedGlobalGridOffset ?? { x: 0, y: 0, z: 0 },
    bIsPhysicsGrid: opts.isPhysicsGrid ?? false,
    bFreezePhysicsGrid: opts.freezePhysicsGrid ?? false,
    bFreezeGlobalGrid: opts.freezeGlobalGrid ?? false,
    bIsMicrochipPrefab: opts.isMicrochipPrefab ?? false,
  };
}

/** Builder for multi-grid worlds: bricks, components, wires (including
 * cross-grid), entities, microchips with linked inner grids, and prefab
 * metadata. Write with `toBrz` / `toPendingFs`.
 *
 * ```js
 * const w = new World();
 * const { grid } = w.addMicrochip({ position: [0, 0, 2] });
 * const gate = w.addBrick({ asset: ..., components: [...] }, grid);
 * w.addWire({ brick: gate, component_type, port }, ...);
 * w.makePrefab({ isMicrochipPrefab: true });
 * writeFileSync('chip.brz', w.toBrz());
 * ```
 */
export class World {
  private gridBrickInputs: WorldBrickInput[][] = [[]];
  /** per sub-grid slot (1..): the grid entity's insertion order */
  private gridEntityOrders: number[] = [];
  private entityInputs: BrdbEntityInput[] = [];
  private wireList: { source: WorldWireEndpoint; target: WorldWireEndpoint }[] =
    [];
  private chipLinks: { brick: WorldBrickHandle; grid: WorldGridHandle }[] = [];
  private ownerList: NonNullable<WriteSaveObject['brick_owners']> = [];
  private prefabOptions: WorldPrefabOptions | null = null;
  private prefabList: [string, Uint8Array][] = [];

  /** Register an owner; returns its owner_index (0 is the built-in PUBLIC
   * owner, so the first added owner is index 1). */
  addOwner(owner: {
    id?: string;
    name?: string;
    display_name?: string;
  }): number {
    this.ownerList.push(owner);
    return this.ownerList.length;
  }

  /** Add a brick to the main grid, or to a sub-grid via its handle. */
  addBrick(brick: WorldBrickInput, grid?: WorldGridHandle): WorldBrickHandle {
    const slot = grid?.grid ?? 0;
    const list = this.gridBrickInputs[slot];
    if (!list) throw new Error(`brdb: unknown grid handle (slot ${slot})`);
    list.push(brick);
    return { grid: slot, index: list.length - 1 };
  }

  addBricks(
    bricks: Iterable<WorldBrickInput>,
    grid?: WorldGridHandle
  ): WorldBrickHandle[] {
    return [...bricks].map(b => this.addBrick(b, grid));
  }

  /** Add a standalone (non-grid) entity. */
  addEntity(entity: BrdbEntityInput = {}): WorldEntityHandle {
    this.entityInputs.push(entity);
    return { entityOrder: this.entityInputs.length - 1 };
  }

  /** Create a sub-grid backed by a grid entity (a dynamic brick grid by
   * default). Brick positions in sub-grids are grid-local; the writer
   * shifts them by -CHUNK_HALF per axis to the chunk-center convention,
   * matching the reference writer. */
  addBrickGrid(entity: BrdbEntityInput = {}): WorldGridHandle {
    const handle = this.addEntity({
      type: 'Entity_DynamicBrickGrid',
      ...entity,
    });
    this.gridBrickInputs.push([]);
    this.gridEntityOrders.push(handle.entityOrder);
    return {
      grid: this.gridBrickInputs.length - 1,
      entityOrder: handle.entityOrder,
    };
  }

  /** Wire two component ports together; endpoints may be in different
   * grids (the writer emits remote wire rows for cross-grid sources). */
  addWire(source: WorldWireEndpoint, target: WorldWireEndpoint): void {
    this.wireList.push({ source, target });
  }

  /** Pair an outer microchip shell brick with its inner grid. Most callers
   * get this for free via `addMicrochip`. */
  registerMicrochipLink(brick: WorldBrickHandle, grid: WorldGridHandle): void {
    this.chipLinks.push({ brick, grid });
  }

  /** Build a microchip: places the outer B_1x1_Microchip shell brick on
   * the main grid (with its Component_Internal_Microchip), creates the
   * linked inner grid entity, and returns both handles. Add the chip's
   * contents with `addBrick(..., grid)`. */
  addMicrochip(opts: WorldMicrochipOptions): {
    brick: WorldBrickHandle;
    grid: WorldGridHandle;
  } {
    const brick = this.addBrick({
      asset: 'B_1x1_Microchip',
      position: opts.position,
      color: opts.color,
      owner_index: opts.owner_index,
      components: [{ type: 'Component_Internal_Microchip' }],
    });
    const grid = this.addBrickGrid({
      type: 'Entity_MicrochipDynamicBrickGrid',
      location: opts.entityLocation ?? { X: 0, Y: 0, Z: 40 },
      data: {
        bCollapsed: opts.collapsed ?? true,
        PlaneCenter: { X: 0, Y: 0, Z: 0 },
        PlaneExtent: opts.planeExtent ?? { X: 14, Y: 14, Z: 2 },
      },
    });
    this.registerMicrochipLink(brick, grid);
    return { brick, grid };
  }

  /** Mark this world as a prefab bundle: Bundle.json type "Prefab" plus
   * Meta/Prefab.json with pivots/bounds computed from the main-grid brick
   * bounding box (World.json is omitted). */
  makePrefab(options: WorldPrefabOptions = {}): void {
    this.prefabOptions = options;
  }

  /** Embed a prefab archive, content-addressed the way the game does:
   * `Prefabs/Uploads/<BLAKE3-uppercase-hex>.brz`. Returns that path — the
   * exact string a `Prefab` component property (`bundle_path_ref`) should
   * carry, e.g. on BrickComponentType_WireGraph_Exec_PrefabSpawner or
   * BrickComponentType_PrefabSpawn. Identical bytes dedupe to one entry. */
  addPrefab(bytes: Uint8Array): string {
    const hash = bytesToHex(blake3(bytes)).toUpperCase();
    const path = `Prefabs/Uploads/${hash}.brz`;
    if (!this.prefabList.some(([p]) => p === path))
      this.prefabList.push([path, bytes]);
    return path;
  }

  toPendingFs(options: WriteBrzOptions = {}): PendingEntry[] {
    // Shared name tables across grids.
    const assetNames = new Registry();
    const materialNames = new Registry();
    for (const list of this.gridBrickInputs)
      for (const b of list) {
        assetNames.add(b.asset ?? 'PB_DefaultBrick');
        materialNames.add(b.material ?? 'BMC_Plastic');
      }
    const grids = this.gridBrickInputs.map((list, slot) =>
      normalizeBricks({
        brick_assets: assetNames.names,
        materials: materialNames.names,
        brick_owners: this.ownerList,
        bricks: list.map(b => ({
          ...b,
          asset_name_index: assetNames.indexOf(b.asset ?? 'PB_DefaultBrick'),
          material_index: materialNames.indexOf(b.material ?? 'BMC_Plastic'),
          // the default (asset omitted) brick is a 1x1: PB_DefaultBrick 5,5,6
          size: b.size ?? (b.asset === undefined ? [5, 5, 6] : undefined),
          // sub-grid bricks are chunk-centered on disk
          position:
            slot === 0
              ? b.position
              : (b.position.map(v => v - CHUNK_HALF) as [
                  number,
                  number,
                  number
                ]),
          color: b.color ?? [255, 255, 255],
        })),
      } as WriteBrzInput)
    );
    const entities = this.entityInputs.map((e, i) =>
      normalizeEntity(e, i, this.ownerList.length)
    );
    const gridIds = [1, ...this.gridEntityOrders.map(o => 2 + o)];
    return modelToPendingFs(
      {
        ownerRows: ownerRowsFrom(this.ownerList),
        grids,
        gridIds,
        entities,
        wires: this.wireList.map(w => ({
          source: {
            gridSlot: w.source.brick.grid,
            brickIndex: w.source.brick.index,
            componentType: w.source.component_type,
            port: w.source.port,
          },
          target: {
            gridSlot: w.target.brick.grid,
            brickIndex: w.target.brick.index,
            componentType: w.target.component_type,
            port: w.target.port,
          },
        })),
        microchipLinks: this.chipLinks.map(l => ({
          gridSlot: l.brick.grid,
          brickIndex: l.brick.index,
          gridReference: 2 + l.grid.entityOrder,
        })),
        prefab: this.prefabOptions
          ? computePrefabJson(grids[0], this.prefabOptions)
          : null,
        prefabs: this.prefabList,
      },
      options
    );
  }

  /** Serialize to an in-memory .brz archive. */
  toBrz(options: WriteBrzOptions = {}): Uint8Array {
    return writeBrzContainer(this.toPendingFs(options), {
      compress: options.compress,
    });
  }
}

/** Write a .brz world from a legacy .brs-shaped WriteSaveObject; for
 * authoring multi-grid worlds from scratch use the World builder. */
export function writeBrzLegacy(
  save: WriteBrzInput,
  options: WriteBrzOptions = {}
): Uint8Array {
  const containerOptions: BrzContainerOptions = { compress: options.compress };
  return writeBrzContainer(saveToPendingFs(save, options), containerOptions);
}
