// BrdbSchema: the msgpack-schema model plus its binary (de)serialization.
// Wire form: always the 3-element [enums, variants, structs] msgpack array,
// structs in topological dependency-first order.
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
  | boolean
  | string
  | null
  | BrdbValue[]
  | { [field: string]: BrdbValue };

/** A decoded variant value: which member the tag selected, plus its payload.
 * Kept tagged (rather than flattened like the reference reader) so that
 * decode -> encode round-trips byte-identically. */
export interface BrdbVariant {
  $variant: string;
  value: BrdbValue;
}

// The legacy (pre-variant-table) unions use fixed tags; the member names
// match the named-variant vocabulary so both share one representation.
const LEGACY_WIRE_MEMBERS = [
  'f64',
  'i64',
  'bool',
  'weak_object',
  'WireGraphExec',
];
const LEGACY_PRIM_MATH_MEMBERS = ['f64', 'i64'];

function asVariant(value: BrdbValue, ty: string): BrdbVariant {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { $variant?: unknown }).$variant === 'string'
  )
    return value as unknown as BrdbVariant;
  throw new Error(`brdb: variant ${ty} requires a { $variant, value } wrapper`);
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

export class BrdbSchema {
  constructor(
    readonly enums: Map<string, Map<string, number>>,
    readonly variants: Map<string, string[]>,
    readonly structs: Map<string, Map<string, PropDesc>>
  ) {}

  static fromText(text: string): BrdbSchema {
    const { enums, variants, structs } = parseSchemaText(text);
    return new BrdbSchema(enums, variants, structs);
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
    return new BrdbSchema(enums, variants, structs);
  }

  static fromBinary(bytes: Uint8Array): BrdbSchema {
    const r = new ByteReader(bytes);
    const header = rdArrayLen(r);
    if (header !== 2 && header !== 3)
      throw new Error(`brdb: invalid schema header length ${header}`);
    const enums = new Map<string, Map<string, number>>();
    for (let i = 0, n = rdMapLen(r); i < n; i++) {
      const name = rdStr(r);
      const values = new Map<string, number>();
      for (let j = 0, m = rdMapLen(r); j < m; j++)
        values.set(rdStr(r), rdInt(r));
      enums.set(name, values);
    }
    const variants = new Map<string, string[]>();
    if (header === 3) {
      for (let i = 0, n = rdMapLen(r); i < n; i++) {
        const name = rdStr(r);
        const members: string[] = [];
        for (let j = 0, m = rdArrayLen(r); j < m; j++) members.push(rdStr(r));
        variants.set(name, members);
      }
    }
    const structs = new Map<string, Map<string, PropDesc>>();
    for (let i = 0, n = rdMapLen(r); i < n; i++) {
      const name = rdStr(r);
      const props = new Map<string, PropDesc>();
      for (let j = 0, m = rdMapLen(r); j < m; j++)
        props.set(rdStr(r), readPropDesc(r));
      structs.set(name, props);
    }
    if (r.remaining !== 0)
      throw new Error(`brdb: ${r.remaining} trailing bytes after schema`);
    return new BrdbSchema(enums, variants, structs);
  }

  /** Extract the named structs plus every type they transitively reference
   * (sub-structs, enums, variants, and variant member types) into a
   * self-contained subset. Primitive/unknown names are skipped. Uses a LIFO
   * worklist; the result ORDER matches the reference implementation, and
   * that order determines the serialized schema's bytes. */
  extractStructsTransitive(seeds: Iterable<string>): SchemaData {
    const enums = new Map<string, Map<string, number>>();
    const variants = new Map<string, string[]>();
    const structs = new Map<string, Map<string, PropDesc>>();
    const seen = new Set<string>();
    const work = [...seeds];
    for (let name = work.pop(); name !== undefined; name = work.pop()) {
      if (seen.has(name)) continue;
      seen.add(name);
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
    return { enums, variants, structs };
  }

  /** Merge definitions into this schema. Existing names keep their position
   * (and are replaced); new names append, matching the reference merge. */
  merge(data: SchemaData): void {
    for (const [name, values] of data.enums) this.enums.set(name, values);
    for (const [name, members] of data.variants)
      this.variants.set(name, members);
    for (const [name, props] of data.structs) this.structs.set(name, props);
  }

  /** The zero value of a type: numbers 0, bool false, str '', asset refs
   * null, arrays empty, structs recursive, enums ordinal 0, variants tag 0
   * with the first member's zero value. */
  zeroValue(ty: string): BrdbValue {
    switch (ty) {
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
        return '';
      case 'class':
      case 'object':
      case 'weak_object':
        return null;
      case 'wire_graph_variant':
      case 'wire_graph_prim_math_variant':
        return { $variant: 'f64', value: 0 };
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
        obj[field] = prop.kind === 'type' ? this.zeroValue(prop.type) : [];
      return obj;
    }
    throw new Error(`brdb: unknown type ${ty}`);
  }

  /** Complete a partial struct value: present fields pass through, missing
   * fields get their zero value. Unknown keys are an error. */
  fillStruct(
    structName: string,
    partial: Readonly<Record<string, BrdbValue>>
  ): Record<string, BrdbValue> {
    const struct = this.structs.get(structName);
    if (!struct) throw new Error(`brdb: unknown struct ${structName}`);
    for (const key of Object.keys(partial))
      if (!struct.has(key))
        throw new Error(`brdb: ${structName} has no field '${key}'`);
    const out: Record<string, BrdbValue> = {};
    for (const [field, prop] of struct) {
      const given = partial[field];
      out[field] =
        given !== undefined
          ? given
          : prop.kind === 'type'
          ? this.zeroValue(prop.type)
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

  toBinary(): Uint8Array {
    const w = new ByteWriter();
    // Always the 3-element form; an empty variants map is valid.
    mpArrayHeader(w, 3);
    mpMapHeader(w, this.enums.size);
    for (const [name, values] of this.enums) {
      mpStr(w, name);
      mpMapHeader(w, values.size);
      for (const [key, value] of values) {
        mpStr(w, key);
        mpInt(w, value);
      }
    }
    mpMapHeader(w, this.variants.size);
    for (const [name, members] of this.variants) {
      mpStr(w, name);
      mpArrayHeader(w, members.length);
      for (const member of members) mpStr(w, member);
    }
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
            mpStr(w, prop.type);
            break;
          case 'array':
            mpArrayHeader(w, 1);
            mpStr(w, prop.type);
            break;
          case 'flatarray':
            mpArrayHeader(w, 2);
            mpStr(w, prop.type);
            mpNil(w);
            break;
          case 'map':
            mpMapHeader(w, 1);
            mpStr(w, prop.key);
            mpStr(w, prop.value);
            break;
        }
      }
    }
    return w.toBytes();
  }

  flatTypeSize(ty: string): number {
    const prim = FLAT_SIZES[ty];
    if (prim) return prim;
    const struct = this.structs.get(ty);
    if (!struct) return 0;
    let sum = 0;
    for (const prop of struct.values())
      sum += prop.kind === 'type' ? this.flatTypeSize(prop.type) : 0;
    return sum;
  }

  writeValue(w: ByteWriter, ty: string, value: BrdbValue): void {
    switch (ty) {
      case 'u8':
        return mpU8(w, value as number);
      case 'u16':
      case 'u32':
      case 'u64':
        return mpUint(w, value as number);
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
        return mpInt(w, value as number);
      case 'f32':
        return mpF32(w, value as number);
      case 'f64':
        return mpF64(w, value as number);
      case 'str':
        return mpStr(w, value as string);
      case 'bool':
        return mpBool(w, value as boolean);
      case 'class':
      case 'object':
      case 'weak_object':
        // asset reference: index into external_asset_references; null = -1
        if (value === null) return mpInt(w, -1);
        return mpUint(w, value as number);
      case 'wire_graph_variant':
      case 'wire_graph_prim_math_variant':
        return this.writeLegacyWireVariant(w, ty, value);
    }
    // Named variants (e.g. WireGraphVariant): uint tag (the member's index
    // in the schema's ordered member list — resolved per schema, never
    // hardcoded) followed by the member value.
    const variantTy = this.variants.get(ty);
    if (variantTy) {
      const v = asVariant(value, ty);
      const tag = variantTy.indexOf(v.$variant);
      if (tag === -1)
        throw new Error(
          `brdb: '${v.$variant}' is not a member of variant ${ty}`
        );
      mpUint(w, tag);
      return this.writeVariantPayload(w, v.$variant, v.value);
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
    throw new Error(`brdb: unknown type ${ty}`);
  }

  private writeVariantPayload(
    w: ByteWriter,
    member: string,
    value: BrdbValue
  ): void {
    // weak_object payloads inside variants use the signed-int encoder for
    // both null and non-null (matching the component write path); plain
    // schema-typed asset refs use the uint encoder when set.
    if (member === 'weak_object')
      return mpInt(w, value === null ? -1 : (value as number));
    this.writeValue(w, member, value);
  }

  private writeLegacyWireVariant(
    w: ByteWriter,
    ty: string,
    value: BrdbValue
  ): void {
    const members =
      ty === 'wire_graph_variant'
        ? LEGACY_WIRE_MEMBERS
        : LEGACY_PRIM_MATH_MEMBERS;
    const v = asVariant(value, ty);
    const tag = members.indexOf(v.$variant);
    if (tag === -1)
      throw new Error(`brdb: '${v.$variant}' is not a member of ${ty}`);
    mpUint(w, tag);
    switch (v.$variant) {
      case 'f64':
        return mpF64(w, v.value as number);
      case 'i64':
        return mpInt(w, v.value as number);
      case 'bool':
        return mpBool(w, v.value as boolean);
      case 'weak_object':
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
      case 'map':
        // No shipped schema uses Map properties, and the format's reference
        // reader/writer disagree on the wire form (BRDB.md §4.4 item 10).
        throw new Error(`brdb: Map properties are unsupported (${ctx})`);
    }
  }

  private writeFlat(
    w: ByteWriter,
    ty: string,
    value: BrdbValue,
    ctx: string
  ): void {
    switch (ty) {
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
        return w.u64le(BigInt(value as number));
      case 'i64':
        return w.i64le(BigInt(value as number));
    }
    const struct = this.structs.get(ty);
    if (!struct) throw new Error(`brdb: invalid flat type ${ty} at ${ctx}`);
    const obj = value as { [k: string]: BrdbValue };
    for (const [field, prop] of struct) {
      if (prop.kind !== 'type')
        throw new Error(`brdb: flat struct ${ty} has non-flat field ${field}`);
      if (!(field in obj))
        throw new Error(`brdb: missing struct field ${ty}.${field}`);
      this.writeFlat(w, prop.type, obj[field], `${ctx}.${field}`);
    }
  }

  readValue(r: ByteReader, ty: string): BrdbValue {
    switch (ty) {
      case 'u8':
      case 'u16':
      case 'u32':
      case 'u64':
        return rdUint(r);
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
        return rdInt(r);
      case 'f32':
        return rdF32(r);
      case 'f64':
        return rdF64(r);
      case 'str':
        return rdStr(r);
      case 'bool':
        return rdBool(r);
      case 'class':
      case 'object':
      case 'weak_object': {
        const id = rdInt(r);
        return id < 0 ? null : id;
      }
      case 'wire_graph_variant':
      case 'wire_graph_prim_math_variant':
        return this.readLegacyWireVariant(r, ty);
    }
    // Named variant: uint tag indexes the schema's ordered member list.
    const variantTy = this.variants.get(ty);
    if (variantTy) {
      const tag = rdUint(r);
      const member = variantTy[tag];
      if (member === undefined)
        throw new Error(`brdb: unknown tag ${tag} for variant ${ty}`);
      return { $variant: member, value: this.readValue(r, member) };
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
        obj[field] = this.readProperty(r, prop, `${ty}.${field}`);
      return obj;
    }
    throw new Error(`brdb: unknown type ${ty}`);
  }

  private readLegacyWireVariant(r: ByteReader, ty: string): BrdbValue {
    const members =
      ty === 'wire_graph_variant'
        ? LEGACY_WIRE_MEMBERS
        : LEGACY_PRIM_MATH_MEMBERS;
    const tag = rdUint(r);
    const member = members[tag];
    switch (member) {
      case 'f64':
        return { $variant: member, value: rdF64(r) };
      case 'i64':
        return { $variant: member, value: rdInt(r) };
      case 'bool':
        return { $variant: member, value: rdBool(r) };
      case 'weak_object': {
        const id = rdInt(r);
        return { $variant: member, value: id < 0 ? null : id };
      }
      case 'WireGraphExec':
        return { $variant: member, value: null }; // no payload
      default:
        throw new Error(`brdb: unknown tag ${tag} for ${ty}`);
    }
  }

  private readProperty(r: ByteReader, prop: PropDesc, ctx: string): BrdbValue {
    switch (prop.kind) {
      case 'type':
        return this.readValue(r, prop.type);
      case 'array': {
        const len = rdArrayLen(r);
        const out: BrdbValue[] = [];
        for (let i = 0; i < len; i++) out.push(this.readValue(r, prop.type));
        return out;
      }
      case 'flatarray': {
        const byteLen = rdBinLen(r);
        const size = this.flatTypeSize(prop.type);
        if (size === 0)
          throw new Error(`brdb: invalid flat type ${prop.type} at ${ctx}`);
        if (byteLen % size !== 0)
          throw new Error(
            `brdb: flat data length ${byteLen} not divisible by ${size} (${ctx})`
          );
        const out: BrdbValue[] = [];
        for (let i = 0; i < byteLen / size; i++)
          out.push(this.readFlat(r, prop.type, ctx));
        return out;
      }
      case 'map':
        throw new Error(`brdb: Map properties are unsupported (${ctx})`);
    }
  }

  private readFlat(r: ByteReader, ty: string, ctx: string): BrdbValue {
    switch (ty) {
      case 'u8':
        return r.u8();
      case 'i8':
        return r.i8();
      case 'u16':
        return r.u16le();
      case 'i16':
        return r.i16le();
      case 'u32':
        return r.u32le();
      case 'i32':
        return r.i32le();
      case 'f32':
        return r.f32le();
      case 'f64':
        return r.f64le();
      case 'u64':
      case 'i64': {
        const v = ty === 'u64' ? r.u64le() : r.i64le();
        if (
          v > BigInt(Number.MAX_SAFE_INTEGER) ||
          v < BigInt(Number.MIN_SAFE_INTEGER)
        )
          throw new RangeError(
            `brdb: flat 64-bit value ${v} exceeds JS safe range`
          );
        return Number(v);
      }
    }
    const struct = this.structs.get(ty);
    if (!struct) throw new Error(`brdb: invalid flat type ${ty} at ${ctx}`);
    const obj: { [k: string]: BrdbValue } = {};
    for (const [field, prop] of struct) {
      if (prop.kind !== 'type')
        throw new Error(`brdb: flat struct ${ty} has non-flat field ${field}`);
      obj[field] = this.readFlat(r, prop.type, `${ctx}.${field}`);
    }
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

const embeddedCache = new Map<string, BrdbSchema>();

export function embeddedSchema(name: EmbeddedSchemaName): BrdbSchema {
  let schema = embeddedCache.get(name);
  if (!schema) {
    schema = BrdbSchema.fromData(SCHEMAS[name]);
    embeddedCache.set(name, schema);
  }
  return schema;
}
