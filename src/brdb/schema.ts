// BrdbSchema: the msgpack-schema model plus its binary (de)serialization.
//
// Two save formats exist (see SchemaFormat). EA3 schemas are the
// [enums, variants, structs] array; Latest schemas are the spec map
// {enums, variants, structs, types} with empty sections omitted. Structs are
// always written in topological dependency-first order.
import { ByteReader, ByteWriter } from './bytes';
import {
  mpArrayHeader,
  mpBinHeader,
  mpBool,
  mpF32,
  mpF64,
  mpInt,
  mpMapHeader,
  mpNil,
  mpStr,
  mpU8,
  mpUint,
  rdArrayLen,
  rdBinLen,
  rdBool,
  rdF32,
  rdF64,
  rdInt,
  rdMapLen,
  rdNil,
  rdStr,
  rdUint,
} from './msgpack';
import { parseSchemaText, SchemaData } from './schemaText';
import { EmbeddedSchemaName, SCHEMAS } from './schemas';

/** The save format a schema belongs to.
 *
 * - `EA3`: retail EA3 builds (and every save before the map container).
 *   Array container, no `types` table; `weak_object` keeps its asset index;
 *   `wire_graph_variant` selector 3 carries an i64 index; `u8` 128..=255 is
 *   written as -128..=-1; flat struct fields are packed back to back.
 * - `Latest`: the spec map container with a `types` table and dynamic
 *   containers; `weak_object` is written as -1 and read as null;
 *   `wire_graph_variant` selector 3 has no payload; `u8` is written
 *   unsigned; flat structs use C layout.
 * - `Auto`: each schema's own format: the one it was read in, otherwise
 *   Latest when it has a `types` table, otherwise EA3. Writing a schema that
 *   needs the Latest container always uses it.
 *
 * Both formats decode integers leniently and accept any integer or float
 * tag for f32/f64. */
export type SchemaFormat = 'Auto' | 'EA3' | 'Latest';
export const SchemaFormat = {
  Auto: 'Auto',
  EA3: 'EA3',
  Latest: 'Latest',
} as const;

/** A concrete format (never `Auto`). */
export type ConcreteSchemaFormat = 'EA3' | 'Latest';

export type PropDesc =
  | { kind: 'type' | 'array' | 'flatarray'; type: string }
  | { kind: 'map'; key: string; value: string };

/** Compact data form emitted by scripts/syncBrdbData.mjs:
 * 'T' = plain type, ['T'] = array, ['T', null] = flat array,
 * { K: 'V' } = map (single entry). */
export type SchemaSourceProp =
  | string
  | readonly [string]
  | readonly [string, null]
  | Readonly<Record<string, string>>;

export interface SchemaSource {
  enums: Readonly<Record<string, Readonly<Record<string, number>>>>;
  variants: Readonly<Record<string, readonly string[]>>;
  structs: Readonly<Record<string, Readonly<Record<string, SchemaSourceProp>>>>;
  /** The ordered types table (absent when empty). */
  types?: readonly string[];
}

/** Field type whose element type is chosen per instance from `types`. */
export const DYNAMIC_ARRAY = 'dynamic_array';
/** Field type whose key and value types are chosen per instance. */
export const DYNAMIC_MAP = 'dynamic_map';
/** An enum value tagged with its enum type: a `types` index, then the
 * value. Written by the game but not in the draft spec. */
export const DYNAMIC_ENUM = 'dynamic_enum';
/** Undeclared type names the game writes whose payload encoding is not
 * known: reading or writing a value is an error; empty containers of them
 * still round-trip. */
export const BRICK_HANDLE = 'brick_handle';
export const COMPONENT_HANDLE = 'component_handle';
/** EA3 wire graph unions used directly as field types. */
export const EA3_WIRE_GRAPH_VARIANT = 'wire_graph_variant';
export const EA3_WIRE_GRAPH_PRIM_MATH_VARIANT = 'wire_graph_prim_math_variant';

/** `Bool` and `Str` are undeclared names the game writes for `bool` and
 * `str` (assumed: no saved instance has been observed). Only used when the
 * schema does not define the name itself. */
const BUILTIN_ALIASES: Record<string, string> = { Bool: 'bool', Str: 'str' };
const canonical = (ty: string) => BUILTIN_ALIASES[ty] ?? ty;
/** Whether two type names describe the same payload type (for matching
 * variant alternatives and `types` entries by type). */
export const sameType = (a: string, b: string) =>
  a === b || canonical(a) === canonical(b);

/** Index of an alternative matched by type: exact name first, then an
 * equivalent built-in alias. -1 when absent. */
export function alternativeIndex(members: readonly string[], name: string) {
  const exact = members.indexOf(name);
  return exact !== -1 ? exact : members.findIndex(m => sameType(m, name));
}

function propFromSource(source: SchemaSourceProp, ctx: string): PropDesc {
  if (typeof source === 'string') return { kind: 'type', type: source };
  if (Array.isArray(source)) {
    if (source.length === 1) return { kind: 'array', type: source[0] };
    if (source.length === 2 && source[1] === null)
      return { kind: 'flatarray', type: source[0] };
    throw new Error(`brdb: invalid schema prop source at ${ctx}`);
  }
  const entries = Object.entries(source);
  if (entries.length === 1)
    return { kind: 'map', key: entries[0][0], value: entries[0][1] as string };
  throw new Error(`brdb: invalid schema prop source at ${ctx}`);
}

export type BrdbValue =
  | number
  | bigint // accepted on encode; decode always produces { $bigint } wrappers
  | boolean
  | string
  | null
  | BrdbValue[]
  | { [field: string]: BrdbValue };

/** A 64-bit integer outside the JS safe-integer range, decoded as a
 * JSON-safe wrapper (decimal string payload) so values survive
 * JSON.stringify/parse. In-range values stay plain numbers; encode accepts
 * the wrapper, a raw bigint, or a number interchangeably. */
export type BrdbBigint = { $bigint: string };

/** A `dynamic_array` value: the element type (a `types` entry) is written
 * even when the array is empty. */
export interface BrdbDynamicArray {
  $elementType: string;
  $array: BrdbValue[];
}

/** A `dynamic_map` value: ordered [key, value] entries. */
export interface BrdbDynamicMap {
  $keyType: string;
  $valueType: string;
  $map: [BrdbValue, BrdbValue][];
}

/** A `dynamic_enum` value: an enum value tagged with its enum type. */
export interface BrdbDynamicEnum {
  $enum: string;
  value: number;
}

const asBigintWrapper = (value: BrdbValue): BrdbBigint | null =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as { $bigint?: unknown }).$bigint === 'string'
    ? (value as unknown as BrdbBigint)
    : null;

/** Wrap an out-of-safe-range 64-bit read; in-range values pass through. */
const wrapBig = (v: number | bigint): number | BrdbBigint =>
  typeof v === 'bigint' ? { $bigint: v.toString() } : v;

/** Narrow a caller-supplied integer value (number, bigint, or { $bigint }
 * wrapper) to what the msgpack integer encoders take.
 * @internal shared with the plan-cached writer in writePlan.ts */
export function asInt64(value: BrdbValue, ctx: string): number | bigint {
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  const wrapped = asBigintWrapper(value);
  if (wrapped) {
    try {
      return BigInt(wrapped.$bigint);
    } catch {
      throw new RangeError(
        `brdb: invalid $bigint payload '${wrapped.$bigint}' for ${ctx}`
      );
    }
  }
  throw new Error(`brdb: expected an integer value for ${ctx}`);
}

/** A decoded variant value: which member the selector chose, plus its
 * payload. Kept tagged so that decode -> encode round-trips byte-identically.
 * Writing matches `$variant` to the target schema's alternatives by type. */
export interface BrdbVariant {
  $variant: string;
  value: BrdbValue;
}

// The EA3 fixed-selector unions; the member names match the named-variant
// vocabulary so both share one representation.
const EA3_WIRE_GRAPH_VARIANT_MEMBERS = [
  'f64',
  'i64',
  'bool',
  'weak_object',
  'WireGraphExec',
];
const EA3_WIRE_GRAPH_PRIM_MATH_VARIANT_MEMBERS = ['f64', 'i64'];

/** @internal shared with the plan-cached writer in writePlan.ts */
export function asVariant(value: BrdbValue, ty: string): BrdbVariant {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { $variant?: unknown }).$variant === 'string'
  )
    return value as unknown as BrdbVariant;
  throw new Error(`brdb: variant ${ty} requires a { $variant, value } wrapper`);
}

function asObject<T>(value: BrdbValue, key: string, ty: string): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    key in value
  )
    return value as unknown as T;
  throw new Error(`brdb: ${ty} requires a { ${key}, ... } value`);
}

const FLAT_SIZES: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  u64: 8,
  i64: 8,
  f64: 8,
};

/** The layout of a flat (memory dump) type: EA3 packs struct fields back to
 * back, Latest uses C layout (fields aligned, size padded). The two agree
 * for every naturally aligned struct. */
export interface FlatLayout {
  type: string;
  size: number;
  align: number;
  /** struct fields; absent for scalars */
  fields?: { name: string; offset: number; layout: FlatLayout }[];
}

const alignUp = (offset: number, align: number) =>
  Math.ceil(offset / align) * align;

function readPropDesc(r: ByteReader): PropDesc {
  const m = r.peek();
  // Type: FixStr/Str8/Str16 only (Str32 descriptors are invalid in this format)
  if ((m & 0xe0) === 0xa0 || m === 0xd9 || m === 0xda)
    return { kind: 'type', type: rdStr(r) };
  if ((m & 0xf0) === 0x90) {
    const len = rdArrayLen(r);
    if (len === 1) return { kind: 'array', type: rdStr(r) };
    if (len === 2) {
      const type = rdStr(r);
      rdNil(r); // FlatArray is exactly [type, nil]
      return { kind: 'flatarray', type };
    }
    throw new Error(`brdb: unsupported property array length ${len}`);
  }
  if ((m & 0xf0) === 0x80) {
    const len = rdMapLen(r);
    if (len !== 1)
      throw new Error(`brdb: unsupported property map length ${len}`);
    return { kind: 'map', key: rdStr(r), value: rdStr(r) };
  }
  throw new Error(`brdb: unsupported property marker 0x${m.toString(16)}`);
}

function readEnumSection(r: ByteReader) {
  const enums = new Map<string, Map<string, number>>();
  for (let i = 0, n = rdMapLen(r); i < n; i++) {
    const name = rdStr(r);
    const values = new Map<string, number>();
    for (let j = 0, m = rdMapLen(r); j < m; j++) values.set(rdStr(r), rdInt(r));
    enums.set(name, values);
  }
  return enums;
}

function readVariantSection(r: ByteReader) {
  const variants = new Map<string, string[]>();
  for (let i = 0, n = rdMapLen(r); i < n; i++) {
    const name = rdStr(r);
    const members: string[] = [];
    for (let j = 0, m = rdArrayLen(r); j < m; j++) members.push(rdStr(r));
    variants.set(name, members);
  }
  return variants;
}

function readStructSection(r: ByteReader) {
  const structs = new Map<string, Map<string, PropDesc>>();
  for (let i = 0, n = rdMapLen(r); i < n; i++) {
    const name = rdStr(r);
    const props = new Map<string, PropDesc>();
    for (let j = 0, m = rdMapLen(r); j < m; j++)
      props.set(rdStr(r), readPropDesc(r));
    structs.set(name, props);
  }
  return structs;
}

function readTypesSection(r: ByteReader) {
  const types: string[] = [];
  for (let i = 0, n = rdArrayLen(r); i < n; i++) {
    const ty = rdStr(r);
    if (ty === DYNAMIC_ARRAY || ty === DYNAMIC_MAP)
      throw new Error(`brdb: '${ty}' cannot appear in the types table`);
    types.push(ty);
  }
  return types;
}

export class BrdbSchema {
  /** The format this schema was read in, when it came from binary. */
  sourceFormat: ConcreteSchemaFormat | null = null;
  private formatOverride: ConcreteSchemaFormat | null = null;
  private flatLayouts = new Map<string, FlatLayout | null>();

  constructor(
    readonly enums: Map<string, Map<string, number>>,
    readonly variants: Map<string, string[]>,
    readonly structs: Map<string, Map<string, PropDesc>>,
    /** The ordered types table dynamic containers index into (append-only). */
    readonly types: string[] = []
  ) {}

  static fromText(text: string): BrdbSchema {
    const { enums, variants, structs, types } = parseSchemaText(text);
    return new BrdbSchema(enums, variants, structs, types ?? []);
  }

  /** Hydrate a schema from the generated data form (see SchemaSource). */
  static fromData(data: SchemaSource): BrdbSchema {
    const enums = new Map(
      Object.entries(data.enums).map(([name, values]) => [
        name,
        new Map(Object.entries(values)),
      ])
    );
    const variants = new Map(
      Object.entries(data.variants).map(([name, members]) => [
        name,
        [...members],
      ])
    );
    const structs = new Map(
      Object.entries(data.structs).map(([name, props]) => [
        name,
        new Map(
          Object.entries(props).map(([field, source]) => [
            field,
            propFromSource(source, `${name}.${field}`),
          ])
        ),
      ])
    );
    return new BrdbSchema(enums, variants, structs, [...(data.types ?? [])]);
  }

  /** Parse a binary schema: the spec map (any subset of sections, any
   * order; duplicate or unknown sections rejected) or an EA3 array
   * (`[enums, structs]` or `[enums, variants, structs]`). */
  static fromBinary(bytes: Uint8Array): BrdbSchema {
    const r = new ByteReader(bytes);
    const m = r.peek();
    let schema: BrdbSchema;
    if ((m & 0xf0) === 0x90 || m === 0xdc || m === 0xdd) {
      const header = rdArrayLen(r);
      if (header !== 2 && header !== 3)
        throw new Error(`brdb: invalid schema header length ${header}`);
      const enums = readEnumSection(r);
      const variants =
        header === 3 ? readVariantSection(r) : new Map<string, string[]>();
      const structs = readStructSection(r);
      schema = new BrdbSchema(enums, variants, structs);
      schema.sourceFormat = 'EA3';
    } else if ((m & 0xf0) === 0x80 || m === 0xde || m === 0xdf) {
      let enums = new Map<string, Map<string, number>>();
      let variants = new Map<string, string[]>();
      let structs = new Map<string, Map<string, PropDesc>>();
      let types: string[] = [];
      const seen = new Set<string>();
      for (let i = 0, n = rdMapLen(r); i < n; i++) {
        const section = rdStr(r);
        if (seen.has(section))
          throw new Error(`brdb: duplicate schema section '${section}'`);
        seen.add(section);
        if (section === 'enums') enums = readEnumSection(r);
        else if (section === 'variants') variants = readVariantSection(r);
        else if (section === 'structs') structs = readStructSection(r);
        else if (section === 'types') types = readTypesSection(r);
        else throw new Error(`brdb: unknown schema section '${section}'`);
      }
      schema = new BrdbSchema(enums, variants, structs, types);
      schema.sourceFormat = 'Latest';
    } else {
      throw new Error(
        `brdb: schema must be a map or an array, found marker 0x${m.toString(
          16
        )}`
      );
    }
    if (r.remaining !== 0)
      throw new Error(`brdb: ${r.remaining} trailing bytes after schema`);
    return schema;
  }

  /** The format (never Auto) whose value encodings this schema uses: an
   * explicit setFormat, else the format it was read in, else Latest when it
   * has a types table, else EA3. */
  format(): ConcreteSchemaFormat {
    return (
      this.formatOverride ??
      this.sourceFormat ??
      (this.types.length > 0 ? 'Latest' : 'EA3')
    );
  }

  isLatest(): boolean {
    return this.format() === 'Latest';
  }

  /** Choose the format for this schema's value encodings; Auto restores the
   * inferred one. */
  setFormat(format: SchemaFormat): void {
    this.formatOverride = format === 'Auto' ? null : format;
    this.flatLayouts.clear();
  }

  /** This schema pinned to `format` (a view sharing its definitions); the
   * schema itself for Auto. */
  withFormat(format: SchemaFormat): BrdbSchema {
    if (format === 'Auto' || format === this.format()) return this;
    const view = new BrdbSchema(
      this.enums,
      this.variants,
      this.structs,
      this.types
    );
    view.sourceFormat = this.sourceFormat;
    view.setFormat(format);
    return view;
  }

  /** Whether this schema can only be written in the Latest container: it
   * has a types table, or something references a dynamic type. */
  needsLatestForm(): boolean {
    if (this.types.length > 0) return true;
    const dynamic = (t: string) =>
      t === DYNAMIC_ARRAY || t === DYNAMIC_MAP || t === DYNAMIC_ENUM;
    for (const props of this.structs.values())
      for (const prop of props.values())
        if (
          prop.kind === 'map'
            ? dynamic(prop.key) || dynamic(prop.value)
            : dynamic(prop.type)
        )
          return true;
    for (const members of this.variants.values())
      if (members.some(dynamic)) return true;
    return false;
  }

  /** The concrete format a write with `format` uses for this schema. */
  resolveFormat(format: SchemaFormat = 'Auto'): ConcreteSchemaFormat {
    if (format !== 'Auto') return format;
    return this.needsLatestForm() ? 'Latest' : this.format();
  }

  /** Index of a type in the types table, by name, falling back to an
   * equivalent built-in alias; -1 when absent. */
  typeIndex(name: string): number {
    return alternativeIndex(this.types, name);
  }

  /** Extract the named structs plus every type they transitively reference
   * (sub-structs, enums, variants, and variant member types) into a
   * self-contained subset. Primitive/unknown names are skipped. When
   * anything extracted uses a dynamic type, the whole types table (and every
   * type it names) comes along. Uses a LIFO worklist; the result ORDER
   * matches the reference implementation, and that order determines the
   * serialized schema's bytes. */
  extractStructsTransitive(seeds: Iterable<string>): SchemaData {
    const enums = new Map<string, Map<string, number>>();
    const variants = new Map<string, string[]>();
    const structs = new Map<string, Map<string, PropDesc>>();
    let types: string[] = [];
    const seen = new Set<string>();
    const work = [...seeds];
    for (let name = work.pop(); name !== undefined; name = work.pop()) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (
        (name === DYNAMIC_ARRAY ||
          name === DYNAMIC_MAP ||
          name === DYNAMIC_ENUM) &&
        types.length === 0 &&
        this.types.length > 0
      ) {
        types = [...this.types];
        // LIFO worklist: push in reverse so the table is visited in order.
        work.push(...[...types].reverse());
        continue;
      }
      const variantMembers = this.variants.get(name);
      if (variantMembers) {
        work.push(...variantMembers);
        variants.set(name, [...variantMembers]);
        continue;
      }
      const enumValues = this.enums.get(name);
      if (enumValues) {
        enums.set(name, new Map(enumValues));
        continue;
      }
      const props = this.structs.get(name);
      if (props) {
        const copy = new Map<string, PropDesc>();
        for (const [field, prop] of props) {
          if (prop.kind === 'map') work.push(prop.key, prop.value);
          else work.push(prop.type);
          copy.set(field, { ...prop });
        }
        structs.set(name, copy);
      }
      // else: primitive/unknown type, nothing to extract
    }
    return { enums, variants, structs, types };
  }

  /** Merge definitions into this schema. Existing names keep their position
   * (and are replaced); new names append, matching the reference merge. The
   * types table is append-only. */
  merge(data: SchemaData): void {
    for (const [name, values] of data.enums) this.enums.set(name, values);
    for (const [name, members] of data.variants)
      this.variants.set(name, members);
    for (const [name, props] of data.structs) this.structs.set(name, props);
    for (const ty of data.types ?? [])
      if (!this.types.includes(ty)) this.types.push(ty);
    this.flatLayouts.clear();
  }

  /** The types table entry an unset dynamic container selects: the first of
   * `preferred` present (the game's defaults for new variables), else the
   * first entry. */
  private defaultTypeName(preferred: string): string {
    if (this.types.length === 0)
      throw new Error('brdb: dynamic container without a types table');
    const i = this.typeIndex(preferred);
    return this.types[i === -1 ? 0 : i];
  }

  /** The zero value of a type: numbers 0, bool false, str '', asset refs
   * null, arrays empty, structs recursive, enums ordinal 0, variants tag 0
   * with the first member's zero value, dynamic containers empty. */
  zeroValue(ty: string): BrdbValue {
    switch (ty) {
      case 'nil':
        return null;
      case 'u8':
      case 'u16':
      case 'u32':
      case 'u64':
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
      case 'f32':
      case 'f64':
        return 0;
      case 'bool':
        return false;
      case 'str':
      case 'bundle_path_ref':
        return '';
      case 'class':
      case 'object':
      case 'weak_object':
        return null;
      case EA3_WIRE_GRAPH_VARIANT:
      case EA3_WIRE_GRAPH_PRIM_MATH_VARIANT:
        return { $variant: 'f64', value: 0 };
      case DYNAMIC_ARRAY:
        return {
          $elementType: this.defaultTypeName('f64'),
          $array: [],
        } as unknown as BrdbValue;
      case DYNAMIC_MAP:
        return {
          $keyType: this.defaultTypeName('i64'),
          $valueType: this.defaultTypeName('f64'),
          $map: [],
        } as unknown as BrdbValue;
    }
    const variant = this.variants.get(ty);
    if (variant) {
      const first = variant[0];
      if (first === undefined) throw new Error(`brdb: empty variant ${ty}`);
      return { $variant: first, value: this.zeroValue(first) };
    }
    if (this.enums.has(ty)) return 0;
    const struct = this.structs.get(ty);
    if (struct) {
      const obj: { [k: string]: BrdbValue } = {};
      for (const [field, prop] of struct)
        obj[field] =
          prop.kind === 'type'
            ? this.zeroValue(prop.type)
            : prop.kind === 'map'
            ? { $map: [] }
            : [];
      return obj;
    }
    if (BUILTIN_ALIASES[ty]) return this.zeroValue(BUILTIN_ALIASES[ty]);
    if (ty === DYNAMIC_ENUM) {
      const name = this.types.find(t => this.enums.has(t));
      if (name === undefined)
        throw new Error(
          'brdb: dynamic_enum without an enum in the types table'
        );
      return { $enum: name, value: 0 };
    }
    if (ty === BRICK_HANDLE || ty === COMPONENT_HANDLE)
      throw new Error(
        `brdb: the payload encoding of ${ty} values is not known`
      );
    throw new Error(`brdb: unknown type ${ty}`);
  }

  /** Complete a partial struct value: present fields pass through, missing
   * fields fall back to `defaults`, then to their zero value. Unknown keys
   * in `partial` are an error; unknown keys in `defaults` are ignored (the
   * defaults table may carry fields a given schema revision lacks). */
  fillStruct(
    structName: string,
    partial: Readonly<Record<string, BrdbValue>>,
    defaults?: Readonly<Record<string, BrdbValue>>
  ): Record<string, BrdbValue> {
    const struct = this.structs.get(structName);
    if (!struct) throw new Error(`brdb: unknown struct ${structName}`);
    for (const key of Object.keys(partial))
      if (!struct.has(key))
        throw new Error(`brdb: ${structName} has no field '${key}'`);
    const out: Record<string, BrdbValue> = {};
    for (const [field, prop] of struct) {
      const given =
        partial[field] !== undefined ? partial[field] : defaults?.[field];
      out[field] =
        given !== undefined
          ? given
          : prop.kind === 'type'
          ? this.zeroValue(prop.type)
          : prop.kind === 'map'
          ? { $map: [] }
          : [];
    }
    return out;
  }

  // DFS post-order: a struct is emitted after every struct it references.
  // Roots iterate in insertion order; deps in property declaration order
  // (map: key then value).
  topoStructOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const props = this.structs.get(name);
      if (props)
        for (const prop of props.values()) {
          const deps =
            prop.kind === 'map' ? [prop.key, prop.value] : [prop.type];
          for (const dep of deps) if (this.structs.has(dep)) visit(dep);
        }
      order.push(name);
    };
    for (const name of this.structs.keys()) visit(name);
    return order;
  }

  /** Serialize in the given format (default Auto: the schema's own format,
   * or Latest when it needs that container). EA3 is the 3-element
   * [enums, variants, structs] array and cannot express a types table;
   * Latest is the spec map, omitting empty sections and writing the legacy
   * `bundle_path_ref` alias as `str`. */
  toBinary(format: SchemaFormat = 'Auto'): Uint8Array {
    const resolved = this.resolveFormat(format);
    const latest = resolved === 'Latest';
    if (!latest && this.needsLatestForm())
      throw new Error(
        'brdb: the EA3 format cannot express a types table or dynamic containers'
      );
    const name = (ty: string) =>
      latest && ty === 'bundle_path_ref' ? 'str' : ty;
    const w = new ByteWriter();
    const sections = [
      this.enums.size > 0,
      this.variants.size > 0,
      this.structs.size > 0,
      this.types.length > 0,
    ];
    if (latest) mpMapHeader(w, sections.filter(Boolean).length);
    else mpArrayHeader(w, 3);

    if (!latest || sections[0]) {
      if (latest) mpStr(w, 'enums');
      mpMapHeader(w, this.enums.size);
      for (const [enumName, values] of this.enums) {
        mpStr(w, enumName);
        mpMapHeader(w, values.size);
        for (const [key, value] of values) {
          mpStr(w, key);
          mpInt(w, value);
        }
      }
    }
    if (!latest || sections[1]) {
      if (latest) mpStr(w, 'variants');
      mpMapHeader(w, this.variants.size);
      for (const [variantName, members] of this.variants) {
        mpStr(w, variantName);
        mpArrayHeader(w, members.length);
        for (const member of members) mpStr(w, name(member));
      }
    }
    if (!latest || sections[2]) {
      if (latest) mpStr(w, 'structs');
      const order = this.topoStructOrder();
      mpMapHeader(w, order.length);
      for (const structName of order) {
        const props = this.structs.get(structName)!;
        mpStr(w, structName);
        mpMapHeader(w, props.size);
        for (const [propName, prop] of props) {
          mpStr(w, propName);
          switch (prop.kind) {
            case 'type':
              mpStr(w, name(prop.type));
              break;
            case 'array':
              mpArrayHeader(w, 1);
              mpStr(w, name(prop.type));
              break;
            case 'flatarray':
              mpArrayHeader(w, 2);
              mpStr(w, name(prop.type));
              mpNil(w);
              break;
            case 'map':
              mpMapHeader(w, 1);
              mpStr(w, name(prop.key));
              mpStr(w, name(prop.value));
              break;
          }
        }
      }
    }
    if (latest && sections[3]) {
      mpStr(w, 'types');
      mpArrayHeader(w, this.types.length);
      for (const ty of this.types) mpStr(w, name(ty));
    }
    return w.toBytes();
  }

  /** The flat layout of `ty` under this schema's format, or null when it
   * cannot be flat. */
  flatLayout(ty: string): FlatLayout | null {
    const cached = this.flatLayouts.get(ty);
    if (cached !== undefined) return cached;
    let layout: FlatLayout | null = null;
    const prim = FLAT_SIZES[ty];
    if (prim) layout = { type: ty, size: prim, align: prim };
    else {
      const struct = this.structs.get(ty);
      if (struct) {
        const cLayout = this.isLatest();
        const fields: NonNullable<FlatLayout['fields']> = [];
        let offset = 0;
        let align = 1;
        let ok = true;
        for (const [name, prop] of struct) {
          const field =
            prop.kind === 'type' ? this.flatLayout(prop.type) : null;
          if (!field) {
            ok = false;
            break;
          }
          if (cLayout) {
            offset = alignUp(offset, field.align);
            align = Math.max(align, field.align);
          }
          fields.push({ name, offset, layout: field });
          offset += field.size;
        }
        if (ok)
          layout = { type: ty, size: alignUp(offset, align), align, fields };
      }
    }
    this.flatLayouts.set(ty, layout);
    return layout;
  }

  flatTypeSize(ty: string): number {
    return this.flatLayout(ty)?.size ?? 0;
  }

  writeValue(w: ByteWriter, ty: string, value: BrdbValue): void {
    switch (ty) {
      case 'nil':
        return; // no payload
      case 'u8':
        // EA3 builds only read the signed form; Latest writes unsigned.
        return this.isLatest()
          ? mpUint(w, value as number)
          : mpU8(w, value as number);
      case 'u16':
      case 'u32':
      case 'u64':
        return mpUint(w, asInt64(value, ty));
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
        return mpInt(w, asInt64(value, ty));
      case 'f32':
        return mpF32(w, value as number);
      case 'f64':
        return mpF64(w, value as number);
      case 'str':
      case 'bundle_path_ref': // a string path on the wire
        return mpStr(w, value as string);
      case 'bool':
        return mpBool(w, value as boolean);
      case 'weak_object':
        // Latest: non-persistent, always -1.
        if (this.isLatest()) return mpInt(w, -1);
      // falls through: EA3 keeps the asset index
      case 'class':
      case 'object':
        // asset reference: index into external_asset_references; null = -1
        if (value === null) return mpInt(w, -1);
        return mpUint(w, value as number);
      case EA3_WIRE_GRAPH_VARIANT:
      case EA3_WIRE_GRAPH_PRIM_MATH_VARIANT:
        return this.writeEA3WireVariant(w, ty, value);
      case DYNAMIC_ARRAY: {
        const v = asObject<BrdbDynamicArray>(value, '$elementType', ty);
        const element = this.dynamicType(v.$elementType);
        mpUint(w, this.types.indexOf(element));
        mpArrayHeader(w, v.$array.length);
        for (const item of v.$array) this.writeValue(w, element, item);
        return;
      }
      case DYNAMIC_MAP: {
        const v = asObject<BrdbDynamicMap>(value, '$keyType', ty);
        const key = this.dynamicType(v.$keyType);
        const val = this.dynamicType(v.$valueType);
        mpUint(w, this.types.indexOf(key));
        mpUint(w, this.types.indexOf(val));
        mpMapHeader(w, v.$map.length);
        for (const [k, x] of v.$map) {
          this.writeValue(w, key, k);
          this.writeValue(w, val, x);
        }
        return;
      }
    }
    // Named variants: the selector is the index of the alternative matching
    // the value's member by type (resolved per schema, never hardcoded),
    // followed by the member value.
    const variantTy = this.variants.get(ty);
    if (variantTy) {
      const v = asVariant(value, ty);
      const tag = alternativeIndex(variantTy, v.$variant);
      if (tag === -1)
        throw new Error(
          `brdb: '${v.$variant}' is not a member of variant ${ty}`
        );
      mpUint(w, tag);
      return this.writeVariantPayload(w, variantTy[tag], v.value);
    }
    const enumTy = this.enums.get(ty);
    if (enumTy) {
      const ordinal = value as number;
      if (ordinal < 0 || ordinal >= enumTy.size)
        throw new RangeError(
          `brdb: enum ${ty} ordinal ${ordinal} out of bounds`
        );
      return mpUint(w, ordinal); // ordinal, NOT the declared value
    }
    const struct = this.structs.get(ty);
    if (struct) {
      const obj = value as { [k: string]: BrdbValue };
      for (const [field, prop] of struct) {
        if (!(field in obj))
          throw new Error(`brdb: missing struct field ${ty}.${field}`);
        this.writeProperty(w, prop, obj[field], `${ty}.${field}`);
      }
      return;
    }
    if (BUILTIN_ALIASES[ty])
      return this.writeValue(w, BUILTIN_ALIASES[ty], value);
    if (ty === DYNAMIC_ENUM) {
      const v = asObject<BrdbDynamicEnum>(value, '$enum', ty);
      if (!this.enums.has(v.$enum))
        throw new Error(`brdb: dynamic_enum type ${v.$enum} is not an enum`);
      mpUint(w, this.types.indexOf(this.dynamicType(v.$enum)));
      return mpInt(w, v.value);
    }
    if (ty === BRICK_HANDLE || ty === COMPONENT_HANDLE)
      throw new Error(
        `brdb: the payload encoding of ${ty} values is not known`
      );
    throw new Error(`brdb: unknown type ${ty}`);
  }

  /** The types table entry for a dynamic container's selected type. */
  private dynamicType(name: string): string {
    if (name === DYNAMIC_ARRAY || name === DYNAMIC_MAP)
      throw new Error(`brdb: dynamic containers cannot contain '${name}'`);
    const i = this.typeIndex(name);
    if (i === -1) throw new Error(`brdb: '${name}' is not in the types table`);
    return this.types[i];
  }

  private writeVariantPayload(
    w: ByteWriter,
    member: string,
    value: BrdbValue
  ): void {
    // weak_object payloads inside variants use the signed-int encoder for
    // both null and non-null (matching the component write path); plain
    // schema-typed asset refs use the uint encoder when set. Latest always
    // writes -1.
    if (member === 'weak_object')
      return mpInt(
        w,
        value === null || this.isLatest() ? -1 : (value as number)
      );
    this.writeValue(w, member, value);
  }

  private writeEA3WireVariant(
    w: ByteWriter,
    ty: string,
    value: BrdbValue
  ): void {
    const members =
      ty === EA3_WIRE_GRAPH_VARIANT
        ? EA3_WIRE_GRAPH_VARIANT_MEMBERS
        : EA3_WIRE_GRAPH_PRIM_MATH_VARIANT_MEMBERS;
    const v = asVariant(value, ty);
    const tag = alternativeIndex(members, v.$variant);
    if (tag === -1)
      throw new Error(`brdb: '${v.$variant}' is not a member of ${ty}`);
    mpUint(w, tag);
    switch (members[tag]) {
      case 'f64':
        return mpF64(w, v.value as number);
      case 'i64':
        return mpInt(w, asInt64(v.value, ty));
      case 'bool':
        return mpBool(w, v.value as boolean);
      case 'weak_object':
        // EA3 stores the asset index; the spec's Latest layout has no
        // payload for selector 3.
        if (this.isLatest()) return;
        return mpInt(w, v.value === null ? -1 : (v.value as number));
      case 'WireGraphExec':
        return; // no payload
    }
  }

  private writeProperty(
    w: ByteWriter,
    prop: PropDesc,
    value: BrdbValue,
    ctx: string
  ): void {
    switch (prop.kind) {
      case 'type':
        return this.writeValue(w, prop.type, value);
      case 'array': {
        const arr = value as BrdbValue[];
        mpArrayHeader(w, arr.length);
        for (const item of arr) this.writeValue(w, prop.type, item);
        return;
      }
      case 'flatarray': {
        const arr = value as BrdbValue[];
        const size = this.flatTypeSize(prop.type);
        if (size === 0)
          throw new Error(`brdb: invalid flat type ${prop.type} at ${ctx}`);
        mpBinHeader(w, arr.length * size);
        for (const item of arr) this.writeFlat(w, prop.type, item, ctx);
        return;
      }
      case 'map': {
        // Inverse of readProperty's map case: a msgpack map header (the count)
        // then schema-typed key/value pairs, in stored order.
        const entries = (value as { $map?: BrdbValue[] })?.$map;
        if (!Array.isArray(entries))
          throw new Error(`brdb: expected a { $map } value at ${ctx}`);
        mpMapHeader(w, entries.length);
        for (const entry of entries) {
          const [key, val] = entry as BrdbValue[];
          this.writeValue(w, prop.key, key);
          this.writeValue(w, prop.value, val);
        }
        return;
      }
    }
  }

  /** @internal the flat-array element writer; writePlan.ts falls back to it
   * for element shapes it cannot plan, so mid-stream error behavior matches. */
  writeFlat(w: ByteWriter, ty: string, value: BrdbValue, ctx: string): void {
    const layout = this.flatLayout(ty);
    if (!layout) throw new Error(`brdb: invalid flat type ${ty} at ${ctx}`);
    this.writeFlatLayout(w, layout, value, ctx);
  }

  private writeFlatLayout(
    w: ByteWriter,
    layout: FlatLayout,
    value: BrdbValue,
    ctx: string
  ): void {
    switch (layout.type) {
      case 'u8':
        return w.u8(value as number);
      case 'i8':
        return w.i8(value as number);
      case 'u16':
        return w.u16le(value as number);
      case 'i16':
        return w.i16le(value as number);
      case 'u32':
        return w.u32le(value as number);
      case 'i32':
        return w.i32le(value as number);
      case 'f32':
        return w.f32le(value as number);
      case 'f64':
        return w.f64le(value as number);
      case 'u64':
        return w.u64le(BigInt(asInt64(value, ctx)));
      case 'i64':
        return w.i64le(BigInt(asInt64(value, ctx)));
    }
    const obj = value as { [k: string]: BrdbValue };
    let pos = 0;
    for (const field of layout.fields!) {
      for (; pos < field.offset; pos++) w.u8(0);
      if (!(field.name in obj))
        throw new Error(
          `brdb: missing struct field ${layout.type}.${field.name}`
        );
      this.writeFlatLayout(
        w,
        field.layout,
        obj[field.name],
        `${ctx}.${field.name}`
      );
      pos = field.offset + field.layout.size;
    }
    for (; pos < layout.size; pos++) w.u8(0);
  }

  // A hostile .schema blob can declare a struct that references itself
  // (directly or transitively) as a plain field, which would otherwise
  // recurse forever consuming zero input bytes. depth is threaded through
  // the decode-side walk only (readValue/readProperty); encode is
  // unaffected since it always terminates against caller-supplied values.
  private static readonly MAX_DECODE_DEPTH = 64;

  /** Read a types table reference. */
  private readTypeRef(r: ByteReader): string {
    const index = rdUint(r);
    const ty = this.types[index];
    if (ty === undefined)
      throw new Error(
        `brdb: type index ${index} is outside the types table (length ${this.types.length})`
      );
    if (ty === DYNAMIC_ARRAY || ty === DYNAMIC_MAP)
      throw new Error(`brdb: dynamic containers cannot contain '${ty}'`);
    return ty;
  }

  readValue(r: ByteReader, ty: string, depth = 0): BrdbValue {
    if (depth > BrdbSchema.MAX_DECODE_DEPTH)
      throw new Error('brdb: schema recursion too deep');
    switch (ty) {
      case 'nil':
        return null; // no payload
      case 'u8':
      case 'u16':
      case 'u32':
        return rdUint(r);
      case 'u64':
        return wrapBig(rdUint(r, true));
      case 'i8':
      case 'i16':
      case 'i32':
        return rdInt(r);
      case 'i64':
        return wrapBig(rdInt(r, true));
      case 'f32':
        return rdF32(r);
      case 'f64':
        return rdF64(r);
      case 'str':
      case 'bundle_path_ref':
        return rdStr(r);
      case 'bool':
        return rdBool(r);
      case 'weak_object':
        // Latest: the index is discarded and the reference loads as null.
        if (this.isLatest()) {
          rdInt(r);
          return null;
        }
      // falls through: EA3 keeps the asset index
      case 'class':
      case 'object': {
        const id = rdInt(r);
        return id < 0 ? null : id;
      }
      case EA3_WIRE_GRAPH_VARIANT:
      case EA3_WIRE_GRAPH_PRIM_MATH_VARIANT:
        return this.readEA3WireVariant(r, ty);
      case DYNAMIC_ARRAY: {
        const element = this.readTypeRef(r);
        const $array: BrdbValue[] = [];
        for (let i = 0, n = rdArrayLen(r); i < n; i++)
          $array.push(this.readValue(r, element, depth + 1));
        return { $elementType: element, $array } as unknown as BrdbValue;
      }
      case DYNAMIC_MAP: {
        const key = this.readTypeRef(r);
        const val = this.readTypeRef(r);
        const $map: BrdbValue[] = [];
        for (let i = 0, n = rdMapLen(r); i < n; i++) {
          const k = this.readValue(r, key, depth + 1);
          $map.push([k, this.readValue(r, val, depth + 1)]);
        }
        return {
          $keyType: key,
          $valueType: val,
          $map,
        } as unknown as BrdbValue;
      }
    }
    // Named variant: the selector indexes the SAVED alternative list and the
    // payload decodes with that alternative's saved type.
    const variantTy = this.variants.get(ty);
    if (variantTy) {
      const tag = rdUint(r);
      const member = variantTy[tag];
      if (member === undefined)
        throw new Error(`brdb: unknown tag ${tag} for variant ${ty}`);
      return { $variant: member, value: this.readValue(r, member, depth + 1) };
    }
    const enumTy = this.enums.get(ty);
    if (enumTy) {
      const ordinal = rdUint(r);
      if (ordinal >= enumTy.size)
        throw new RangeError(
          `brdb: enum ${ty} ordinal ${ordinal} out of bounds`
        );
      return ordinal;
    }
    const struct = this.structs.get(ty);
    if (struct) {
      const obj: { [k: string]: BrdbValue } = {};
      for (const [field, prop] of struct)
        obj[field] = this.readProperty(r, prop, `${ty}.${field}`, depth + 1);
      return obj;
    }
    if (BUILTIN_ALIASES[ty])
      return this.readValue(r, BUILTIN_ALIASES[ty], depth + 1);
    if (ty === DYNAMIC_ENUM) {
      const name = this.readTypeRef(r);
      if (!this.enums.has(name))
        throw new Error(`brdb: dynamic_enum type ${name} is not an enum`);
      return { $enum: name, value: rdInt(r) };
    }
    if (ty === BRICK_HANDLE || ty === COMPONENT_HANDLE)
      throw new Error(
        `brdb: the payload encoding of ${ty} values is not known; only empty containers of it are supported`
      );
    throw new Error(`brdb: unknown type ${ty}`);
  }

  private readEA3WireVariant(r: ByteReader, ty: string): BrdbValue {
    const members =
      ty === EA3_WIRE_GRAPH_VARIANT
        ? EA3_WIRE_GRAPH_VARIANT_MEMBERS
        : EA3_WIRE_GRAPH_PRIM_MATH_VARIANT_MEMBERS;
    const tag = rdUint(r);
    const member = members[tag];
    switch (member) {
      case 'f64':
        return { $variant: member, value: rdF64(r) };
      case 'i64':
        return { $variant: member, value: wrapBig(rdInt(r, true)) };
      case 'bool':
        return { $variant: member, value: rdBool(r) };
      case 'weak_object': {
        // EA3 data stores an i64 asset index after selector 3; it must be
        // consumed or the rest of the struct misaligns. Latest follows the
        // spec's frozen layout (no payload).
        if (this.isLatest()) return { $variant: member, value: null };
        const id = rdInt(r);
        return { $variant: member, value: id < 0 ? null : id };
      }
      case 'WireGraphExec':
        return { $variant: member, value: null }; // no payload
      default:
        throw new Error(`brdb: unknown tag ${tag} for ${ty}`);
    }
  }

  private readProperty(
    r: ByteReader,
    prop: PropDesc,
    ctx: string,
    depth = 0
  ): BrdbValue {
    switch (prop.kind) {
      case 'type':
        return this.readValue(r, prop.type, depth);
      case 'array': {
        const len = rdArrayLen(r);
        const out: BrdbValue[] = [];
        for (let i = 0; i < len; i++)
          out.push(this.readValue(r, prop.type, depth));
        return out;
      }
      case 'flatarray': {
        const byteLen = rdBinLen(r);
        const layout = this.flatLayout(prop.type);
        if (!layout || layout.size === 0)
          throw new Error(`brdb: invalid flat type ${prop.type} at ${ctx}`);
        if (byteLen % layout.size !== 0)
          throw new Error(
            `brdb: flat data length ${byteLen} not divisible by ${layout.size} (${ctx})`
          );
        const bin = r.bytes(byteLen);
        const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
        const out: BrdbValue[] = [];
        for (let at = 0; at < byteLen; at += layout.size)
          out.push(this.decodeFlat(view, at, layout));
        return out;
      }
      case 'map': {
        // Wire form: a msgpack map header (the count) followed by that many
        // schema-typed key/value pairs. Kept as an ordered [key, value] entry
        // list under { $map } so complex (struct/enum) keys and insertion
        // order survive decode -> encode.
        const len = rdMapLen(r);
        const entries: BrdbValue[] = [];
        for (let i = 0; i < len; i++) {
          const key = this.readValue(r, prop.key, depth + 1);
          const val = this.readValue(r, prop.value, depth + 1);
          entries.push([key, val]);
        }
        return { $map: entries };
      }
    }
  }

  /** Decode one flat element whose bytes start at `offset`. */
  private decodeFlat(
    view: DataView,
    offset: number,
    layout: FlatLayout
  ): BrdbValue {
    switch (layout.type) {
      case 'u8':
        return view.getUint8(offset);
      case 'i8':
        return view.getInt8(offset);
      case 'u16':
        return view.getUint16(offset, true);
      case 'i16':
        return view.getInt16(offset, true);
      case 'u32':
        return view.getUint32(offset, true);
      case 'i32':
        return view.getInt32(offset, true);
      case 'f32':
        return view.getFloat32(offset, true);
      case 'f64':
        return view.getFloat64(offset, true);
      case 'u64':
      case 'i64': {
        const v =
          layout.type === 'u64'
            ? view.getBigUint64(offset, true)
            : view.getBigInt64(offset, true);
        return v > BigInt(Number.MAX_SAFE_INTEGER) ||
          v < BigInt(Number.MIN_SAFE_INTEGER)
          ? { $bigint: v.toString() }
          : Number(v);
      }
    }
    const obj: { [k: string]: BrdbValue } = {};
    for (const field of layout.fields!)
      obj[field.name] = this.decodeFlat(
        view,
        offset + field.offset,
        field.layout
      );
    return obj;
  }

  encode(ty: string, value: BrdbValue): Uint8Array {
    const w = new ByteWriter();
    this.writeValue(w, ty, value);
    return w.toBytes();
  }

  decode(bytes: Uint8Array, ty: string): BrdbValue {
    const r = new ByteReader(bytes);
    const value = this.readValue(r, ty);
    if (r.remaining !== 0)
      throw new Error(`brdb: ${r.remaining} trailing bytes after ${ty}`);
    return value;
  }
}

/** Whether `name` resolves to a struct whose properties match `expect`
 * exactly, in order, by name and shape. Specialized (hand-encoded) writers
 * call this to verify the loaded schema still has the shape they hardcode,
 * and fall back to the generic writer when it does not. That check is what
 * keeps them safe across a game update that changes the format. */
export function structShapeMatches(
  schema: BrdbSchema,
  name: string,
  expect: readonly (readonly [string, PropDesc])[]
): boolean {
  const props = schema.structs.get(name);
  if (!props || props.size !== expect.length) return false;
  let i = 0;
  for (const [field, prop] of props) {
    const [expectField, expectProp] = expect[i++];
    if (field !== expectField || prop.kind !== expectProp.kind) return false;
    if (prop.kind === 'map') {
      if (expectProp.kind !== 'map') return false;
      if (prop.key !== expectProp.key || prop.value !== expectProp.value)
        return false;
    } else if (expectProp.kind === 'map' || prop.type !== expectProp.type) {
      return false;
    }
  }
  return true;
}

const embeddedCache = new Map<string, BrdbSchema>();

/** A built-in schema of the current game build. */
export function embeddedSchema(name: EmbeddedSchemaName): BrdbSchema {
  let schema = embeddedCache.get(name);
  if (!schema) {
    schema = BrdbSchema.fromData(SCHEMAS[name]);
    embeddedCache.set(name, schema);
  }
  return schema;
}
