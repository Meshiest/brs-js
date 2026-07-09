// Synthetic-schema and hostile-input regression tests for WorldReader edge
// cases that the real fixtures (all current-format, well-formed) cannot
// reach: legacy archives missing later-added SoA fields, and malicious
// counters that would otherwise drive unbounded allocation. WorldReader
// only needs a WorldFs, so these build a minimal in-memory one directly
// rather than going through Brdb/BrzReader.
import { describe, expect, test } from 'vitest';
import { ByteWriter } from '../../src/brdb/bytes';
import { ENTITY_TYPE_STRUCTS } from '../../src/brdb/componentDb';
import type { FoundFile, WorldFs } from '../../src/brdb/fs';
import { linearToSrgb, WorldReader } from '../../src/brdb/reader';
import { BrdbSchema, BrdbValue, embeddedSchema } from '../../src/brdb/schema';
import { SCHEMAS } from '../../src/brdb/schemas';

class MemFs implements WorldFs {
  private files = new Map<string, FoundFile>();
  private blobs = new Map<number, Uint8Array>();
  private nextId = 1;

  set(path: string, content: Uint8Array): void {
    const contentId = this.nextId++;
    this.blobs.set(contentId, content);
    this.files.set(path, { contentId, createdAt: 0 });
  }
  findFileByPath(path: string): FoundFile | null {
    return this.files.get(path) ?? null;
  }
  findFileByPathAtRevision(path: string): FoundFile | null {
    return this.findFileByPath(path);
  }
  readBlob(contentId: number): Uint8Array {
    const b = this.blobs.get(contentId);
    if (!b) throw new Error('brdb: test fs: blob not found');
    return b;
  }
  readFile(path: string): Uint8Array {
    const found = this.findFileByPath(path);
    if (!found) throw new Error(`brdb: file not found: ${path}`);
    return this.readBlob(found.contentId);
  }
  childFolders(): string[] {
    return [];
  }
}

/** A copy of an embedded schema with the given fields removed from one
 * struct, simulating an archive whose schema predates those fields. */
function schemaWithout(
  source: keyof typeof SCHEMAS,
  struct: string,
  ...fields: string[]
): BrdbSchema {
  const src = SCHEMAS[source];
  const structs: Record<string, any> = { ...src.structs };
  const props: Record<string, any> = { ...(structs[struct] as any) };
  for (const f of fields) delete props[f];
  structs[struct] = props;
  return BrdbSchema.fromData({ ...src, structs } as any);
}

const globalDataSchema = embeddedSchema('BRSavedGlobalDataSoA');

const defaultGlobalData: Record<string, BrdbValue> = {
  EntityTypeNames: [],
  EntityDataClassNames: [],
  BasicBrickAssetNames: ['PB_DefaultBrick'],
  ProceduralBrickAssetNames: [],
  MaterialAssetNames: ['BMC_Plastic'],
  ComponentTypeNames: [],
  ComponentDataStructNames: [],
  ComponentWirePortNames: [],
  ExternalAssetReferences: [],
  GlobalGridEntityTypeIndex: -1,
};

/** A MemFs with GlobalData.mps/.schema pre-populated (the embedded schema,
 * a superset of every archive-schema variant used below). */
function withGlobalData(overrides: Record<string, BrdbValue> = {}): MemFs {
  const fs = new MemFs();
  const data = { ...defaultGlobalData, ...overrides };
  fs.set('World/0/GlobalData.schema', globalDataSchema.toBinary());
  fs.set(
    'World/0/GlobalData.mps',
    globalDataSchema.encode('BRSavedGlobalDataSoA', data)
  );
  return fs;
}

const whiteColor = { R: 255, G: 255, B: 255, A: 255 };
const entityColorsAllWhite: Record<string, BrdbValue> = {
  Color0: whiteColor,
  Color1: whiteColor,
  Color2: whiteColor,
  Color3: whiteColor,
  Color4: whiteColor,
  Color5: whiteColor,
  Color6: whiteColor,
  Color7: whiteColor,
};

const baseBrickChunkValue: Record<string, BrdbValue> = {
  ProceduralBrickStartingIndex: 1,
  BrickSizeCounters: [],
  BrickSizes: [],
  BrickTypeIndices: [0],
  OwnerIndices: [0],
  OriginalOwnerIndices: [0],
  RelativePositions: [{ X: -1024, Y: -1024, Z: -1018 }],
  Orientations: [16], // direction=4 (ZPositive), rotation=0
  CollisionFlags_Player: { Flags: [] },
  CollisionFlags_Player1: { Flags: [] },
  CollisionFlags_Player2: { Flags: [] },
  CollisionFlags_Player3: { Flags: [] },
  CollisionFlags_Weapon: { Flags: [] },
  CollisionFlags_Interaction: { Flags: [] },
  CollisionFlags_Physics: { Flags: [] },
  VisibilityFlags: { Flags: [] },
  MaterialIndices: [0],
  ColorsAndAlphas: [{ R: 200, G: 100, B: 10, A: 5 }],
  bColorsAreLinear: false,
};

function buildBricksFs(opts: {
  chunkIndexSchema?: BrdbSchema;
  chunkIndexValue?: Record<string, BrdbValue>;
  chunkSchema?: BrdbSchema;
  chunkValue: Record<string, BrdbValue>;
  globalData?: Record<string, BrdbValue>;
}): MemFs {
  const fs = withGlobalData(opts.globalData);
  const chunkIndexSchema =
    opts.chunkIndexSchema ?? embeddedSchema('BRSavedBrickChunkIndexSoA');
  const chunkIndexValue = opts.chunkIndexValue ?? {
    Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }],
    ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }],
    ChunkSizes: [2048],
    NumBricks: [1],
    NumComponents: [0],
    NumWires: [0],
  };
  fs.set('World/0/Bricks/ChunkIndexShared.schema', chunkIndexSchema.toBinary());
  fs.set(
    'World/0/Bricks/Grids/1/ChunkIndex.mps',
    chunkIndexSchema.encode('BRSavedBrickChunkIndexSoA', chunkIndexValue)
  );
  const chunkSchema =
    opts.chunkSchema ?? embeddedSchema('BRSavedBrickChunkSoA');
  fs.set('World/0/Bricks/ChunksShared.schema', chunkSchema.toBinary());
  fs.set(
    'World/0/Bricks/Grids/1/Chunks/0_0_0.mps',
    chunkSchema.encode('BRSavedBrickChunkSoA', opts.chunkValue)
  );
  return fs;
}

describe('linear-to-sRGB color conversion', () => {
  test('linearToSrgb matches hand-computed values', () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(15)).toBe(4);
    expect(linearToSrgb(16)).toBe(72);
    expect(linearToSrgb(55)).toBe(126);
    expect(linearToSrgb(100)).toBe(166);
    expect(linearToSrgb(255)).toBe(255);
  });

  test('bricks() converts colors when bColorsAreLinear is absent from the schema', () => {
    const chunkSchema = schemaWithout(
      'BRSavedBrickChunkSoA',
      'BRSavedBrickChunkSoA',
      'bColorsAreLinear'
    );
    const fs = buildBricksFs({ chunkSchema, chunkValue: baseBrickChunkValue });
    const [brick] = [...new WorldReader(fs).bricks(1)];
    expect(brick.color).toEqual([228, 166, 3]);
    expect(brick.material_intensity).toBe(5); // alpha/intensity untouched
  });

  test('bricks() converts colors when bColorsAreLinear is explicitly true', () => {
    const fs = buildBricksFs({
      chunkValue: { ...baseBrickChunkValue, bColorsAreLinear: true },
    });
    const [brick] = [...new WorldReader(fs).bricks(1)];
    expect(brick.color).toEqual([228, 166, 3]);
  });

  test('bricks() passes colors through unchanged when bColorsAreLinear is false', () => {
    const fs = buildBricksFs({ chunkValue: baseBrickChunkValue });
    const [brick] = [...new WorldReader(fs).bricks(1)];
    expect(brick.color).toEqual([200, 100, 10]);
    expect(brick.material_intensity).toBe(5);
  });

  test('entityChunk converts entity colors when bColorsAreLinear is absent from the schema', () => {
    const entitySchema = schemaWithout(
      'BRSavedEntityChunkSoA',
      'BRSavedEntityChunkSoA',
      'bColorsAreLinear'
    );
    const fs = withGlobalData({
      EntityTypeNames: ['Entity_Test'],
      EntityDataClassNames: ['None'],
    });
    fs.set('World/0/Entities/ChunksShared.schema', entitySchema.toBinary());
    const linearColor = { R: 200, G: 100, B: 10, A: 5 };
    const soaValue: Record<string, BrdbValue> = {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }],
      PersistentIndices: [2],
      OwnerIndices: [0],
      OriginalOwnerIndices: [0],
      Locations: [{ X: 0, Y: 0, Z: 0 }],
      Rotations: [{ X: 0, Y: 0, Z: 0, W: 1 }],
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: { Flags: [] },
      PhysicsSleepingFlags: { Flags: [] },
      WeldParentIndices: [],
      LinearVelocities: [{ X: 0, Y: 0, Z: 0 }],
      AngularVelocities: [{ X: 0, Y: 0, Z: 0 }],
      ColorsAndAlphas: [{ ...entityColorsAllWhite, Color0: linearColor }],
      RemainingLifeSpans: [],
    };
    fs.set(
      'World/0/Entities/Chunks/0_0_0.mps',
      entitySchema.encode('BRSavedEntityChunkSoA', soaValue)
    );
    const [entity] = new WorldReader(fs).entityChunk({ x: 0, y: 0, z: 0 });
    expect(entity.colors.Color0).toEqual({ R: 228, G: 166, B: 3, A: 5 });
    // an untouched slot's white stays white after conversion (0 and 255 are
    // both fixed points of the formula)
    expect(entity.colors.Color1).toEqual(whiteColor);
  });
});

describe('brickChunkIndex legacy field fallbacks', () => {
  test('defaults ChunkOffsets/ChunkSizes for a chunk index schema that omits them', () => {
    const chunkIndexSchema = schemaWithout(
      'BRSavedBrickChunkIndexSoA',
      'BRSavedBrickChunkIndexSoA',
      'ChunkOffsets',
      'ChunkSizes'
    );
    const fs = buildBricksFs({
      chunkIndexSchema,
      chunkIndexValue: {
        Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }],
        NumBricks: [1],
        NumComponents: [0],
        NumWires: [0],
      },
      chunkValue: baseBrickChunkValue,
    });
    expect(new WorldReader(fs).brickChunkIndex(1)).toEqual([
      {
        index: { x: 0, y: 0, z: 0 },
        offset: { x: 1024, y: 1024, z: 1024 },
        size: 2048,
        numBricks: 1,
        numComponents: 0,
        numWires: 0,
      },
    ]);
  });
});

describe('unbounded-counter guards on hostile input', () => {
  test('bricks() throws instead of allocating when brick size counters exceed the size table', () => {
    const fs = buildBricksFs({
      chunkValue: {
        ...baseBrickChunkValue,
        BrickSizeCounters: [{ AssetIndex: 0, NumSizes: 5 }],
        BrickSizes: [], // claims 5 slots against an empty table
      },
    });
    expect(() => [...new WorldReader(fs).bricks(1)]).toThrow(
      /brick size counters exceed size table/
    );
  });

  test('componentChunk throws instead of allocating when counters exceed the brick index table', () => {
    const componentSchema = embeddedSchema('BRSavedComponentChunkSoA');
    const fs = withGlobalData();
    fs.set(
      'World/0/Bricks/ComponentsShared.schema',
      componentSchema.toBinary()
    );
    const soaValue: Record<string, BrdbValue> = {
      ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 1_000_000 }],
      ComponentBrickIndices: [], // claims a million instances, zero rows
      JointBrickIndices: [],
      JointEntityReferences: [],
      JointInitialRelativeOffsets: [],
      JointInitialRelativeRotations: [],
      MicrochipBrickIndices: [],
      MicrochipBrickGridReferences: [],
    };
    fs.set(
      'World/0/Bricks/Grids/1/Components/0_0_0.mps',
      componentSchema.encode('BRSavedComponentChunkSoA', soaValue)
    );
    expect(() =>
      new WorldReader(fs).componentChunk(1, { x: 0, y: 0, z: 0 })
    ).toThrow(/component counters do not match brick index count/);
  });

  test('entityChunk throws instead of allocating when counters exceed the persistent index table', () => {
    const entitySchema = embeddedSchema('BRSavedEntityChunkSoA');
    const fs = withGlobalData();
    fs.set('World/0/Entities/ChunksShared.schema', entitySchema.toBinary());
    const soaValue: Record<string, BrdbValue> = {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1_000_000 }],
      PersistentIndices: [], // claims a million entities, zero rows
      OwnerIndices: [],
      OriginalOwnerIndices: [],
      Locations: [],
      Rotations: [],
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: { Flags: [] },
      PhysicsSleepingFlags: { Flags: [] },
      WeldParentIndices: [],
      LinearVelocities: [],
      AngularVelocities: [],
      ColorsAndAlphas: [],
      RemainingLifeSpans: [],
      bColorsAreLinear: false,
    };
    fs.set(
      'World/0/Entities/Chunks/0_0_0.mps',
      entitySchema.encode('BRSavedEntityChunkSoA', soaValue)
    );
    expect(() => new WorldReader(fs).entityChunk({ x: 0, y: 0, z: 0 })).toThrow(
      /entity counters do not match persistent index count/
    );
  });
});

// Some game-produced files (observed in prefab exports with joints) write
// ComponentBrickIndices as k identical copies back-to-back while the
// counters, and the trailing per-instance data, describe a single copy. The
// game itself reads such files fine (it walks the counters and ignores the
// tail), so the reader must tolerate exact self-repetition — but ONLY that;
// any other mismatch is still hostile/corrupt input.
describe('duplicated ComponentBrickIndices tolerance', () => {
  const emptyComponentSoa: Record<string, BrdbValue> = {
    ComponentTypeCounters: [],
    ComponentBrickIndices: [],
    JointBrickIndices: [],
    JointEntityReferences: [],
    JointInitialRelativeOffsets: [],
    JointInitialRelativeRotations: [],
    MicrochipBrickIndices: [],
    MicrochipBrickGridReferences: [],
  };

  function componentFs(opts: {
    soa: Record<string, BrdbValue>;
    globalData?: Record<string, BrdbValue>;
    schema?: BrdbSchema;
    trailing?: (w: ByteWriter, schema: BrdbSchema) => void;
  }): MemFs {
    const schema = opts.schema ?? embeddedSchema('BRSavedComponentChunkSoA');
    const fs = withGlobalData(
      opts.globalData ?? {
        ComponentTypeNames: ['Component_Test'],
        ComponentDataStructNames: ['None'],
      }
    );
    fs.set('World/0/Bricks/ComponentsShared.schema', schema.toBinary());
    const w = new ByteWriter();
    schema.writeValue(w, 'BRSavedComponentChunkSoA', {
      ...emptyComponentSoa,
      ...opts.soa,
    });
    opts.trailing?.(w, schema);
    fs.set('World/0/Bricks/Grids/1/Components/0_0_0.mps', w.toBytes());
    return fs;
  }

  test('accepts an exactly-duplicated index array and uses the first copy', () => {
    const fs = componentFs({
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }],
        ComponentBrickIndices: [5, 9, 5, 9],
      },
    });
    const { components } = new WorldReader(fs).componentChunk(1, {
      x: 0,
      y: 0,
      z: 0,
    });
    expect(components.map(c => c.brickIndex)).toEqual([5, 9]);
    expect(components.map(c => c.typeName)).toEqual([
      'Component_Test',
      'Component_Test',
    ]);
  });

  test('accepts a triplicated index array', () => {
    const fs = componentFs({
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }],
        ComponentBrickIndices: [5, 9, 5, 9, 5, 9],
      },
    });
    const { components } = new WorldReader(fs).componentChunk(1, {
      x: 0,
      y: 0,
      z: 0,
    });
    expect(components.map(c => c.brickIndex)).toEqual([5, 9]);
  });

  test('duplicated indices with single-copy trailing data (zertz.brz shape) decode fully', () => {
    // Mirror of the real failing file: doubled indices, trailing struct data
    // present exactly once, and an i64 constant beyond the safe range.
    const src = SCHEMAS.BRSavedComponentChunkSoA;
    const schema = BrdbSchema.fromData({
      ...src,
      structs: {
        ...src.structs,
        TestComponentData: { Value: 'i64' },
      },
    } as any);
    const big = 33891734021675012n;
    const fs = componentFs({
      schema,
      globalData: {
        ComponentTypeNames: ['Component_Test'],
        ComponentDataStructNames: ['TestComponentData'],
      },
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }],
        ComponentBrickIndices: [5, 9, 5, 9],
      },
      trailing: (w, s) => {
        s.writeValue(w, 'TestComponentData', { Value: 12 });
        s.writeValue(w, 'TestComponentData', { Value: big });
      },
    });
    const { components } = new WorldReader(fs).componentChunk(1, {
      x: 0,
      y: 0,
      z: 0,
    });
    expect(components.map(c => c.brickIndex)).toEqual([5, 9]);
    expect(components[0].data).toEqual({ Value: 12 });
    expect(components[1].data).toEqual({
      Value: { $bigint: big.toString() },
    });
  });

  test('still throws when the repeated segments differ', () => {
    const fs = componentFs({
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }],
        ComponentBrickIndices: [5, 9, 5, 8],
      },
    });
    expect(() =>
      new WorldReader(fs).componentChunk(1, { x: 0, y: 0, z: 0 })
    ).toThrow(/component counters do not match brick index count/);
  });

  test('still throws when the length is not an exact multiple', () => {
    const fs = componentFs({
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }],
        ComponentBrickIndices: [5, 9, 5],
      },
    });
    expect(() =>
      new WorldReader(fs).componentChunk(1, { x: 0, y: 0, z: 0 })
    ).toThrow(/component counters do not match brick index count/);
  });

  test('still throws when counters exceed the index table (vacuous-multiple guard)', () => {
    // 0 % totalInstances === 0 and [].every() is true; the tolerance must
    // not resurrect the unbounded-allocation hole the strict check closes.
    const fs = componentFs({
      soa: {
        ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 1_000_000 }],
        ComponentBrickIndices: [],
      },
    });
    expect(() =>
      new WorldReader(fs).componentChunk(1, { x: 0, y: 0, z: 0 })
    ).toThrow(/component counters do not match brick index count/);
  });
});

describe('entityChunk legacy field fallbacks', () => {
  test('originalOwnerIndex mirrors ownerIndex when OriginalOwnerIndices is absent', () => {
    const entitySchema = schemaWithout(
      'BRSavedEntityChunkSoA',
      'BRSavedEntityChunkSoA',
      'OriginalOwnerIndices'
    );
    const fs = withGlobalData({
      EntityTypeNames: ['Entity_Test'],
      EntityDataClassNames: ['None'],
    });
    fs.set('World/0/Entities/ChunksShared.schema', entitySchema.toBinary());
    const soaValue: Record<string, BrdbValue> = {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }],
      PersistentIndices: [5],
      OwnerIndices: [3],
      Locations: [{ X: 1, Y: 2, Z: 3 }],
      Rotations: [{ X: 0, Y: 0, Z: 0, W: 1 }],
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: { Flags: [] },
      PhysicsSleepingFlags: { Flags: [] },
      WeldParentIndices: [],
      LinearVelocities: [{ X: 0, Y: 0, Z: 0 }],
      AngularVelocities: [{ X: 0, Y: 0, Z: 0 }],
      ColorsAndAlphas: [entityColorsAllWhite],
      RemainingLifeSpans: [],
      bColorsAreLinear: false,
    };
    fs.set(
      'World/0/Entities/Chunks/0_0_0.mps',
      entitySchema.encode('BRSavedEntityChunkSoA', soaValue)
    );
    const [entity] = new WorldReader(fs).entityChunk({ x: 0, y: 0, z: 0 });
    expect(entity.originalOwnerIndex).toBe(3);
    expect(entity.ownerIndex).toBe(3);
  });

  test('falls back to the known entity-type-to-class table when GlobalData lacks EntityDataClassNames', () => {
    expect(ENTITY_TYPE_STRUCTS.get('Entity_DynamicBrickGrid')).toBe(
      'BrickGridDynamicActor'
    );
    const globalDataSchemaNoClassNames = schemaWithout(
      'BRSavedGlobalDataSoA',
      'BRSavedGlobalDataSoA',
      'EntityDataClassNames'
    );
    const fs = new MemFs();
    fs.set(
      'World/0/GlobalData.schema',
      globalDataSchemaNoClassNames.toBinary()
    );
    fs.set(
      'World/0/GlobalData.mps',
      globalDataSchemaNoClassNames.encode('BRSavedGlobalDataSoA', {
        ...defaultGlobalData,
        EntityTypeNames: ['Entity_DynamicBrickGrid'],
      })
    );
    const entitySchema = embeddedSchema('BRSavedEntityChunkSoA');
    fs.set('World/0/Entities/ChunksShared.schema', entitySchema.toBinary());
    const soaValue: Record<string, BrdbValue> = {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }],
      PersistentIndices: [1],
      OwnerIndices: [0],
      OriginalOwnerIndices: [0],
      Locations: [{ X: 0, Y: 0, Z: 0 }],
      Rotations: [{ X: 0, Y: 0, Z: 0, W: 1 }],
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: { Flags: [] },
      PhysicsSleepingFlags: { Flags: [] },
      WeldParentIndices: [],
      LinearVelocities: [{ X: 0, Y: 0, Z: 0 }],
      AngularVelocities: [{ X: 0, Y: 0, Z: 0 }],
      ColorsAndAlphas: [entityColorsAllWhite],
      RemainingLifeSpans: [],
      bColorsAreLinear: false,
    };
    const w = new ByteWriter();
    entitySchema.writeValue(w, 'BRSavedEntityChunkSoA', soaValue);
    // BrickGridDynamicActor is the resolved class's trailing data struct.
    entitySchema.writeValue(w, 'BrickGridDynamicActor', {
      BouyancyScale: 1,
      MassScale: 1,
      bEnableGravity: true,
      bUseNewMassCalculation: false,
      bReceivesDecals: true,
      EntityTag: 'tag',
    });
    fs.set('World/0/Entities/Chunks/0_0_0.mps', w.toBytes());
    const [entity] = new WorldReader(fs).entityChunk({ x: 0, y: 0, z: 0 });
    expect(entity.className).toBe('BrickGridDynamicActor');
    expect(entity.data).toMatchObject({ EntityTag: 'tag' });
  });

  test('an entity type absent from the lookup table falls back to Unknown and throws loudly', () => {
    const globalDataSchemaNoClassNames = schemaWithout(
      'BRSavedGlobalDataSoA',
      'BRSavedGlobalDataSoA',
      'EntityDataClassNames'
    );
    const fs = new MemFs();
    fs.set(
      'World/0/GlobalData.schema',
      globalDataSchemaNoClassNames.toBinary()
    );
    fs.set(
      'World/0/GlobalData.mps',
      globalDataSchemaNoClassNames.encode('BRSavedGlobalDataSoA', {
        ...defaultGlobalData,
        EntityTypeNames: ['Entity_SomethingObscure'],
      })
    );
    const entitySchema = embeddedSchema('BRSavedEntityChunkSoA');
    fs.set('World/0/Entities/ChunksShared.schema', entitySchema.toBinary());
    const soaValue: Record<string, BrdbValue> = {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }],
      PersistentIndices: [1],
      OwnerIndices: [0],
      OriginalOwnerIndices: [0],
      Locations: [{ X: 0, Y: 0, Z: 0 }],
      Rotations: [{ X: 0, Y: 0, Z: 0, W: 1 }],
      WeldParentFlags: { Flags: [] },
      PhysicsLockedFlags: { Flags: [] },
      PhysicsSleepingFlags: { Flags: [] },
      WeldParentIndices: [],
      LinearVelocities: [{ X: 0, Y: 0, Z: 0 }],
      AngularVelocities: [{ X: 0, Y: 0, Z: 0 }],
      ColorsAndAlphas: [entityColorsAllWhite],
      RemainingLifeSpans: [],
      bColorsAreLinear: false,
    };
    fs.set(
      'World/0/Entities/Chunks/0_0_0.mps',
      entitySchema.encode('BRSavedEntityChunkSoA', soaValue)
    );
    expect(() => new WorldReader(fs).entityChunk({ x: 0, y: 0, z: 0 })).toThrow(
      /unknown type Unknown/
    );
  });
});
