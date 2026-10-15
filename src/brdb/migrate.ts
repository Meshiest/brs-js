// Migration of worlds from older save formats to the current one.
//
// Brickadia's breaking updates rename component types, data structs, fields
// and gate bricks, and change how some values are stored. Each update is a
// MigrationStep in the brdb crate's migrations.json (synced into
// migrations.ts), oldest first. toLatest() runs every step a world needs, the
// same way the game upgrades an old world when it loads it, so the rest of
// brs-js only has to understand the current vocabulary. Mirrors the crate's
// `migrate` module.
//
// A world runs the first step that recognises it and every step after it.
// The steps rename names and reshape values; the result is then encoded once,
// file by file. Files whose meaning did not change keep their original
// encoding (every game build reads the older formats):
// - GlobalData.mps: component type, data struct and brick asset names are
//   renamed; gates that became procedural bricks add their PB_Gate_* asset.
// - ComponentsShared.schema and the component chunks: data is re-encoded
//   into the current structs.
// - brick chunks: only those holding a brick whose asset changed index.
import { writeBrzContainer } from './brz';
import { ByteWriter } from './bytes';
import {
  COMPONENT_STRUCT_DEFAULTS,
  COMPONENT_TYPE_STRUCTS,
} from './componentDb';
import { PROCEDURAL_GATES } from './gateVariants';
import { MIGRATION_STEPS } from './migrations';
import { file, folder, PendingEntry, PendingNode } from './pending';
import { WorldReader } from './reader';
import { BrdbSchema, BrdbValue, embeddedSchema } from './schema';

/** One breaking game update: how to recognise a save written before it, and
 * what to rename and reshape to bring the save past it. */
export interface MigrationStep {
  /** Short identifier, e.g. "ea3". */
  readonly name: string;
  readonly description: string;
  /** Every condition given must hold for the save's ComponentsShared.schema. */
  readonly detect: {
    readonly componentSchemaFormat?: 'EA3' | 'Latest';
    readonly componentSchemaHasStruct?: string;
  };
  readonly componentTypes?: {
    /** [from, to] prefix replacements, tried in order after `renames`. */
    readonly prefixes?: readonly (readonly [string, string])[];
    readonly renames?: Readonly<Record<string, string>>;
  };
  readonly bricks?: {
    /** Renamed brick assets (basic or procedural). */
    readonly renames?: Readonly<Record<string, string>>;
    /** Basic gate bricks replaced by a procedural gate brick. */
    readonly toGate?: Readonly<Record<string, string>>;
  };
  /** Renamed data fields; `component` is the type's name after the step. */
  readonly fields?: readonly {
    readonly component: string;
    readonly from: string;
    readonly to: string;
  }[];
  /** Named value conversions (see VALUE_RULES). */
  readonly values?: readonly string[];
}

/** What an older brick asset becomes. */
export type BrickMigration =
  | { kind: 'basic'; asset: string }
  | {
      kind: 'procedural';
      asset: string;
      /** The gate's largest size, which exposes every port. */
      size: { x: number; y: number; z: number };
    };

/** Whether a save whose component schema is `components` was written before
 * `step`. */
export function stepDetects(
  step: MigrationStep,
  components: BrdbSchema
): boolean {
  const { componentSchemaFormat, componentSchemaHasStruct } = step.detect;
  if (
    componentSchemaFormat !== undefined &&
    components.sourceFormat !== componentSchemaFormat
  )
    return false;
  if (
    componentSchemaHasStruct !== undefined &&
    !components.structs.has(componentSchemaHasStruct)
  )
    return false;
  return true;
}

/** The steps a world needs: the first step that recognises it and every
 * step after it. Empty for a world in the current format. */
export function pendingSteps(
  reader: WorldReader,
  steps: readonly MigrationStep[] = MIGRATION_STEPS
): readonly MigrationStep[] {
  const components = reader.schema(
    `World/${reader.worldId}/Bricks/ComponentsShared.schema`
  );
  const i = steps.findIndex(s => stepDetects(s, components));
  return i === -1 ? [] : steps.slice(i);
}

/** Whether a world is in an older save format. */
export function needsMigration(reader: WorldReader): boolean {
  return pendingSteps(reader).length > 0;
}

/** The current name of a component type from any older format. Names that
 * did not change are returned as they are. */
export function migrateComponentType(
  name: string,
  steps: readonly MigrationStep[] = MIGRATION_STEPS
): string {
  for (const step of steps) {
    const renamed = step.componentTypes?.renames?.[name];
    if (renamed !== undefined) {
      name = renamed;
      continue;
    }
    for (const [from, to] of step.componentTypes?.prefixes ?? [])
      if (name.startsWith(from)) {
        name = to + name.slice(from.length);
        break;
      }
  }
  return name;
}

/** What a brick asset from any older format becomes, or undefined when it
 * is unchanged. */
export function migrateBrickAsset(
  name: string,
  steps: readonly MigrationStep[] = MIGRATION_STEPS
): BrickMigration | undefined {
  let current = name;
  let changed = false;
  let gate = false;
  for (const step of steps) {
    const toGate = step.bricks?.toGate?.[current];
    const renamed = step.bricks?.renames?.[current];
    if (toGate !== undefined) {
      current = toGate;
      gate = true;
    } else if (renamed !== undefined) current = renamed;
    else continue;
    changed = true;
  }
  if (!changed) return undefined;
  if (!gate) return { kind: 'basic', asset: current };
  const variants = PROCEDURAL_GATES.get(current)?.variants;
  const [x, y, z] = variants?.[variants.length - 1]?.halfSize ?? [10, 5, 2];
  return { kind: 'procedural', asset: current, size: { x, y, z } };
}

/** The fields of a component's data renamed by `steps`, as current field
 * name -> field name in the stored data. `type` is the stored type name. */
export function fieldAliases(
  type: string,
  steps: readonly MigrationStep[] = MIGRATION_STEPS
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [i, step] of steps.entries()) {
    type = migrateComponentType(type, steps.slice(i, i + 1));
    for (const f of step.fields ?? []) {
      if (f.component !== type) continue;
      const stored = aliases.get(f.from) ?? f.from;
      aliases.delete(f.from);
      aliases.set(f.to, stored);
    }
  }
  return aliases;
}

/** The current types entry for an EA3 wire graph element type name (from a
 * `WireGraph<T>Array` or `WireGraphMap_<K>_<V>` struct name). */
function elementType(ea3: string): string {
  switch (ea3) {
    case 'Double':
    case 'double':
      return 'f64';
    case 'Int64':
    case 'int64':
      return 'i64';
    case 'Bool':
    case 'bool':
      return 'Bool';
    case 'Object':
    case 'FWeakObjectPtr':
      return 'weak_object';
    case 'Vector':
    case 'FVector':
      return 'Vector';
    case 'Rotator':
    case 'FRotator':
      return 'Rotator';
    case 'Quat':
    case 'FQuat':
      return 'Quat';
    case 'String':
    case 'FWireGraphString':
      return 'str';
    case 'LinearColor':
    case 'FLinearColor':
      return 'LinearColor';
    default:
      return ea3; // an enum name
  }
}

const isObject = (v: BrdbValue): v is { [k: string]: BrdbValue } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** `ea3WireGraph`: wire graph arrays become dynamic arrays, wire graph maps
 * become dynamic maps and wrapped enums become dynamic enums. Everything
 * else is kept. */
function ea3WireGraph(value: BrdbValue): BrdbValue {
  if (Array.isArray(value)) return value.map(ea3WireGraph);
  if (!isObject(value) || '$bigint' in value) return value;
  if (typeof value.$variant === 'string') {
    const member = value.$variant;
    const inner = value.value as BrdbValue;
    const array =
      /^WireGraphEnumArray_(.+)$/.exec(member) ??
      /^WireGraph(.+)Array$/.exec(member);
    if (array && isObject(inner)) {
      return {
        $elementType: elementType(array[1]),
        $array: (inner.Values as BrdbValue[]).map(ea3WireGraph),
      } as unknown as BrdbValue;
    }
    if (member.startsWith('WireGraphMapKeyWrapper_') && isObject(inner)) {
      const map = inner.Map as { $variant: string; value: BrdbValue };
      const kv =
        /^WireGraphMap_(int64|FWireGraphString|FWeakObjectPtr)_(.+)$/.exec(
          map.$variant
        );
      if (!kv) throw new Error(`brdb: unknown wire graph map ${map.$variant}`);
      const entries = ((
        map.value as { Values: { $map: [BrdbValue, BrdbValue][] } }
      ).Values.$map ?? []) as [BrdbValue, BrdbValue][];
      return {
        $keyType: elementType(kv[1]),
        $valueType: elementType(kv[2]),
        $map: entries.map(([k, v]) => [ea3WireGraph(k), ea3WireGraph(v)]),
      } as unknown as BrdbValue;
    }
    if (member === 'WireGraphEnumWrapper' && isObject(inner)) {
      // The enum value itself, written as a dynamic_enum.
      const e = inner.Enum as { $variant: string; value: BrdbValue };
      return {
        $variant: 'dynamic_enum',
        value: { $enum: e.$variant, value: e.value } as unknown as BrdbValue,
      } as unknown as BrdbValue;
    }
    return { $variant: member, value: ea3WireGraph(inner) } as BrdbValue;
  }
  const out: { [k: string]: BrdbValue } = {};
  for (const [k, v] of Object.entries(value)) out[k] = ea3WireGraph(v);
  return out;
}

/** The value conversions a step can name in its `values` list. */
const VALUE_RULES: Readonly<Record<string, (value: BrdbValue) => BrdbValue>> = {
  ea3WireGraph,
};

/** Reshape a value decoded with an older schema into the form the current
 * schema encodes, applying every step's value conversions. Values that did
 * not change shape are returned as they are. */
export function migrateValue(
  value: BrdbValue,
  steps: readonly MigrationStep[] = MIGRATION_STEPS
): BrdbValue {
  for (const step of steps)
    for (const rule of step.values ?? []) {
      const apply = VALUE_RULES[rule];
      if (!apply) throw new Error(`brdb: unknown value rule ${rule}`);
      value = apply(value);
    }
  return value;
}

/** Every file of the world (its latest revision) as a pending tree. */
function pendingTree(reader: WorldReader, path = ''): PendingEntry[] {
  const fs = reader.fs;
  const at = (name: string) => (path ? `${path}/${name}` : name);
  return [
    ...fs
      .childFolders(path)
      .map(
        (name): PendingEntry => [name, folder(pendingTree(reader, at(name)))]
      ),
    ...fs
      .childFiles(path)
      .map((name): PendingEntry => [name, file(fs.readFile(at(name)))]),
  ];
}

/** Replace the file at `path` in a pending tree. */
function setFile(tree: PendingEntry[], path: string, content: Uint8Array) {
  const parts = path.split('/');
  let children = tree;
  for (const part of parts.slice(0, -1)) {
    const next = children.find(([n]) => n === part)?.[1];
    if (!next || next.type !== 'folder')
      throw new Error(`brdb: no folder ${part} in ${path}`);
    children = next.children;
  }
  const name = parts[parts.length - 1];
  const entry = children.find(([n]) => n === name);
  const node: PendingNode = file(content);
  if (entry) entry[1] = node;
  else children.push([name, node]);
}

/** Rename the entries of a name table, keeping every index. When a new name
 * is already taken (by an unrenamed entry, or by an earlier entry renamed to
 * the same name), the entry keeps its old name and `remap` sends its index
 * to the entry holding the new name. */
export function renameTable(
  table: readonly string[],
  rename: (name: string) => string | undefined
): { names: string[]; remap: Map<number, number> } {
  const names = [...table];
  const remap = new Map<number, number>();
  // Entries that keep their name own it.
  const owner = new Map<string, number>();
  table.forEach((name, i) => {
    if (rename(name) === undefined) owner.set(name, i);
  });
  table.forEach((name, i) => {
    const to = rename(name);
    if (to === undefined) return;
    const at = owner.get(to);
    if (at !== undefined) {
      remap.set(i, at);
      return;
    }
    owner.set(to, i);
    names[i] = to;
  });
  // A remapped entry's old name can collide with another entry's new name.
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name))
      throw new Error(`brdb: migration renames two table entries to ${name}`);
    seen.add(name);
  }
  return { names, remap };
}

type BrickSizeValue = { X: number; Y: number; Z: number };

/** Rewrite a brick chunk's columns for renamed and procedural assets:
 * procedural counters follow `proceduralRemap`, basic bricks follow
 * `basicRemap`, and basic bricks in `toProcedural` become procedural bricks.
 * Returns whether anything changed. Mutates `types`, `counters` and
 * `sizes`. */
export function migrateBrickColumns(
  start: number,
  types: number[],
  counters: { AssetIndex: number; NumSizes: number }[],
  sizes: BrickSizeValue[],
  basicRemap: ReadonlyMap<number, number>,
  proceduralRemap: ReadonlyMap<number, number>,
  toProcedural: ReadonlyMap<number, { asset: number; size: BrickSizeValue }>
): boolean {
  const counted = counters.reduce((n, c) => n + c.NumSizes, 0);
  if (counted > sizes.length)
    throw new Error(
      `brdb: brick size counters cover ${counted} slots but the chunk has ${sizes.length} sizes`
    );
  let changed = false;
  for (const c of counters) {
    const target = proceduralRemap.get(c.AssetIndex);
    if (target === undefined) continue;
    c.AssetIndex = target;
    changed = true;
  }
  // The slot holding (asset, size): an existing one, else a new slot at the
  // end of the asset's run (or a new run). Slots map one to one onto
  // BrickSizes; sizes past the counted slots are unreferenced and stay so.
  const slotOf = (asset: number, size: BrickSizeValue): number => {
    let end = 0;
    for (const c of counters) {
      const begin = end;
      end += c.NumSizes;
      if (c.AssetIndex !== asset) continue;
      for (let s = begin; s < end; s++) {
        const have = sizes[s];
        if (have.X === size.X && have.Y === size.Y && have.Z === size.Z)
          return s;
      }
      c.NumSizes += 1;
      sizes.splice(end, 0, size);
      for (let i = 0; i < types.length; i++)
        if (types[i] >= start + end) types[i] += 1;
      return end;
    }
    counters.push({ AssetIndex: asset, NumSizes: 1 });
    sizes.splice(end, 0, size);
    return end;
  };
  for (let i = 0; i < types.length; i++) {
    const ty = types[i];
    if (ty >= start) continue;
    const proc = toProcedural.get(ty);
    if (proc) {
      types[i] = start + slotOf(proc.asset, proc.size);
      changed = true;
    } else if (basicRemap.has(ty)) {
      types[i] = basicRemap.get(ty)!;
      changed = true;
    }
  }
  return changed;
}

/** Component data in the shape the current `struct` encodes. Fields the
 * struct no longer has are dropped (the game drops them on load too),
 * missing fields take `defaults` or their zero value, and older enum values
 * whose field became a dynamic_enum are tagged with their enum type, at any
 * depth. `oldStruct` is the struct the data was stored as, in `oldSchema`. */
export function conformStruct(
  schema: BrdbSchema,
  oldSchema: BrdbSchema,
  oldStruct: string | null,
  struct: string,
  data: Readonly<Record<string, BrdbValue>>,
  defaults?: Readonly<Record<string, BrdbValue>>
): Record<string, BrdbValue> {
  const oldProps = oldStruct ? oldSchema.structs.get(oldStruct) : undefined;
  const kept: Record<string, BrdbValue> = {};
  for (const [field, prop] of schema.structs.get(struct) ?? []) {
    const value = data[field];
    if (value === undefined) continue;
    if (prop.kind === 'map') {
      kept[field] = value;
      continue;
    }
    const oldProp = oldProps?.get(field);
    const oldType = oldProp && oldProp.kind !== 'map' ? oldProp.type : null;
    const one = (v: BrdbValue) =>
      conformValue(schema, oldSchema, prop.type, oldType, v);
    kept[field] =
      prop.kind === 'type'
        ? one(value)
        : Array.isArray(value)
        ? value.map(one)
        : value;
  }
  return schema.fillStruct(struct, kept, defaults);
}

function conformValue(
  schema: BrdbSchema,
  oldSchema: BrdbSchema,
  ty: string,
  oldTy: string | null,
  value: BrdbValue
): BrdbValue {
  if (ty === 'dynamic_enum') {
    // A variant over enum types (`{ $variant: EnumName, value }`), or a
    // plain enum (decoded to its ordinal, so tagged with the stored type).
    if (isObject(value) && typeof value.$variant === 'string')
      return oldSchema.enums.has(value.$variant)
        ? ({ $enum: value.$variant, value: value.value } as BrdbValue)
        : value;
    if (
      typeof value === 'number' &&
      oldTy !== null &&
      oldSchema.enums.has(oldTy)
    )
      return { $enum: oldTy, value } as unknown as BrdbValue;
    return value;
  }
  if (schema.structs.has(ty) && isObject(value) && !('$variant' in value))
    return conformStruct(
      schema,
      oldSchema,
      oldTy !== null && oldSchema.structs.has(oldTy) ? oldTy : null,
      ty,
      value
    );
  return value;
}

/** Upgrade a world to the current save format, returning its latest
 * revision as a pending tree. A world already in the current format is
 * returned unchanged. */
export function toLatest(
  reader: WorldReader,
  steps: readonly MigrationStep[] = pendingSteps(reader)
): PendingEntry[] {
  const tree = pendingTree(reader);
  if (steps.length === 0) return tree;
  const world = `World/${reader.worldId}`;
  const renamedBrick = (name: string) => {
    const to = migrateBrickAsset(name, steps);
    return to?.kind === 'basic' ? to.asset : undefined;
  };

  // The current component schema every component chunk is re-encoded with.
  const schema = embeddedSchema('BRSavedComponentChunkSoA_max');

  // --- GlobalData: rename names, keeping indices.
  const old = reader.globalData();
  const gd = { ...old };
  const oldTypes: string[] = old.ComponentTypeNames;
  const oldStructs: string[] = old.ComponentDataStructNames;
  const types = renameTable(oldTypes, n => {
    const to = migrateComponentType(n, steps);
    return to !== n ? to : undefined;
  });
  // Merging two component types would mean rewriting every reference to a
  // type index (component and wire chunks, component refs in data); no step
  // does that.
  for (const [from, to] of types.remap)
    throw new Error(
      `brdb: migration renames component type ${oldTypes[from]} to ${oldTypes[to]}, which the world already has`
    );
  gd.ComponentTypeNames = types.names;
  // A type with no current data struct (removed from the game) keeps its
  // instances without data, as there is no current struct to encode it in.
  gd.ComponentDataStructNames = gd.ComponentTypeNames.map(
    (ty: string, i: number) => {
      const struct = COMPONENT_TYPE_STRUCTS.get(ty) ?? oldStructs[i];
      return struct === 'None' || schema.structs.has(struct) ? struct : 'None';
    }
  );
  const basic = renameTable(old.BasicBrickAssetNames, renamedBrick);
  gd.BasicBrickAssetNames = basic.names;
  const procedural = renameTable(old.ProceduralBrickAssetNames, renamedBrick);
  gd.ProceduralBrickAssetNames = procedural.names;
  // Basic bricks that become procedural: old basic index -> asset + size.
  const toProcedural = new Map<
    number,
    { asset: number; size: BrickSizeValue }
  >();
  gd.BasicBrickAssetNames.forEach((name: string, i: number) => {
    const to = migrateBrickAsset(name, steps);
    if (to?.kind !== 'procedural') return;
    let asset = gd.ProceduralBrickAssetNames.indexOf(to.asset);
    if (asset === -1) asset = gd.ProceduralBrickAssetNames.push(to.asset) - 1;
    toProcedural.set(i, {
      asset,
      size: { X: to.size.x, Y: to.size.y, Z: to.size.z },
    });
  });

  // --- Brick chunks whose asset indices changed.
  const grids = reader
    .gridIds()
    .map(gid => [gid, reader.brickChunkIndex(gid)] as const);
  if (
    basic.remap.size > 0 ||
    procedural.remap.size > 0 ||
    toProcedural.size > 0
  ) {
    const bricksSchema = reader.schema(`${world}/Bricks/ChunksShared.schema`);
    for (const [gid, chunks] of grids) {
      for (const chunk of chunks) {
        const soa = reader.brickChunkSoa(gid, chunk.index);
        const types: number[] = [...soa.BrickTypeIndices];
        const counters = soa.BrickSizeCounters.map((c: any) => ({ ...c }));
        const sizes: BrickSizeValue[] = [...soa.BrickSizes];
        if (
          migrateBrickColumns(
            soa.ProceduralBrickStartingIndex,
            types,
            counters,
            sizes,
            basic.remap,
            procedural.remap,
            toProcedural
          )
        )
          setFile(
            tree,
            `${world}/Bricks/Grids/${gid}/Chunks/${chunk.index.x}_${chunk.index.y}_${chunk.index.z}.mps`,
            bricksSchema.encode('BRSavedBrickChunkSoA', {
              ...soa,
              BrickTypeIndices: types,
              BrickSizeCounters: counters,
              BrickSizes: sizes,
            })
          );
      }
    }
  }

  // --- Components: re-encode every chunk with the current schema.
  const oldSchema = reader.schema(`${world}/Bricks/ComponentsShared.schema`);
  const aliases = oldTypes.map(ty => fieldAliases(ty, steps));
  for (const [gid, chunks] of grids) {
    for (const chunk of chunks) {
      if (chunk.numComponents === 0) continue;
      const { soa, components } = reader.componentChunk(gid, chunk.index);
      const w = new ByteWriter();
      schema.writeValue(
        w,
        'BRSavedComponentChunkSoA',
        schema.fillStruct('BRSavedComponentChunkSoA', soa)
      );
      let i = 0;
      for (const counter of soa.ComponentTypeCounters) {
        const struct: string | undefined =
          gd.ComponentDataStructNames[counter.TypeIndex];
        for (let n = 0; n < counter.NumInstances; n++) {
          const c = components[i++];
          if (!struct || struct === 'None') continue;
          const data = (c.data ? migrateValue(c.data, steps) : {}) as Record<
            string,
            BrdbValue
          >;
          for (const [to, from] of aliases[counter.TypeIndex] ?? []) {
            if (!(from in data)) continue;
            data[to] = data[from];
            delete data[from];
          }
          try {
            schema.writeValue(
              w,
              struct,
              conformStruct(
                schema,
                oldSchema,
                c.structName,
                struct,
                data,
                COMPONENT_STRUCT_DEFAULTS.get(struct)
              )
            );
          } catch (err) {
            throw new Error(
              `brdb: migrate ${c.typeName} (${struct}) in grid ${gid}: ${
                (err as Error).message
              }`
            );
          }
        }
      }
      setFile(
        tree,
        `${world}/Bricks/Grids/${gid}/Components/${chunk.index.x}_${chunk.index.y}_${chunk.index.z}.mps`,
        w.toBytes()
      );
    }
  }
  setFile(tree, `${world}/Bricks/ComponentsShared.schema`, schema.toBinary());

  // --- GlobalData, written with the world's own GlobalData schema.
  setFile(
    tree,
    `${world}/GlobalData.mps`,
    reader
      .schema(`${world}/GlobalData.schema`)
      .encode('BRSavedGlobalDataSoA', gd)
  );
  return tree;
}

/** Open a world in the current save format: an older world is upgraded with
 * toLatest() into an in-memory .brz that the returned reader reads. A world
 * already in the current format is copied as is. */
export function openLatest(reader: WorldReader): WorldReader {
  return WorldReader.from(writeBrzContainer(toLatest(reader)));
}
