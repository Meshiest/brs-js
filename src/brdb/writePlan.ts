// Per-type write plans for the brdb schema writer.
//
// BrdbSchema.writeValue re-resolves, for every field of every instance: the
// field's schema type, its variant member tag, its enum table, and (through
// fillStruct) the value a missing field takes. All of that depends only on the
// struct TYPE, never on the instance. A WritePlanner compiles each type once
// into an ordered list of resolved field operations, caches it, then replays
// the plan per instance.
//
// Anything that cannot be pre-resolved becomes a fallback op that calls the
// generic writer, so its behaviour and error messages are reproduced by
// construction rather than re-implemented. The emitted bytes are identical to
// the unplanned path; test/brdb/writePlan.test.ts asserts that differentially.
import { ByteWriter } from './bytes';
import {
  mpArrayHeader,
  mpBinHeader,
  mpBool,
  mpF32,
  mpF64,
  mpInt,
  mpMapHeader,
  mpStr,
  mpU8,
  mpUint,
} from './msgpack';
import { asInt64, asVariant, BrdbSchema, BrdbValue, PropDesc } from './schema';

// Op kinds. Numeric so the replay switch compiles to a jump table instead of
// the string switch plus three Map probes writeValue does per value.
const OP_BOOL = 0;
const OP_U8 = 1;
const OP_UINT = 2; // u16/u32/u64
const OP_INT = 3; // i8..i64
const OP_F32 = 4;
const OP_F64 = 5;
const OP_STR = 6; // str/bundle_path_ref
const OP_ASSET = 7; // class/object/weak_object as a schema-typed value
const OP_VARIANT_OBJECT = 8; // weak_object as a variant payload (always signed)
const OP_ENUM = 9;
const OP_STRUCT = 10;
const OP_VARIANT = 11;
const OP_DEFERRED = 12; // struct whose plan was still being built
const OP_FALLBACK = 13; // hand back to BrdbSchema.writeValue

// Struct property kinds, resolved from PropDesc.kind once.
const K_TYPE = 0;
const K_ARRAY = 1;
const K_FLAT = 2;
const K_MAP = 3;

// Flat (little-endian, fixed-width) element kinds.
const F_U8 = 0;
const F_I8 = 1;
const F_U16 = 2;
const F_I16 = 3;
const F_U32 = 4;
const F_I32 = 5;
const F_F32 = 6;
const F_F64 = 7;
const F_U64 = 8;
const F_I64 = 9;
const F_STRUCT = 10;
const F_FALLBACK = 11;

/** One resolved write operation. Every instance shares this shape so the
 * replay switch stays monomorphic in V8. */
class PlanOp {
  constructor(
    readonly k: number,
    readonly ty: string,
    /** OP_STRUCT / OP_DEFERRED; DEFERRED fills it in on first write. */
    public struct: StructPlan | null = null,
    /** OP_VARIANT; filled in on first write (a member may name the variant
     * again, so eager planning could recurse forever). */
    public variant: VariantPlan | null = null,
    /** OP_ENUM: the member count, for the ordinal bounds check. */
    readonly enumSize = 0
  ) {}
}

class FlatField {
  constructor(readonly name: string, readonly op: FlatOp) {}
}

class FlatOp {
  constructor(
    readonly k: number,
    readonly ty: string,
    readonly props: FlatField[] | null,
    /** Whether anything in this subtree can put the context path in an error
     * message. When false the per-field path string is never built. */
    readonly usesCtx: boolean
  ) {}
}

class FieldPlan {
  /** Bytes this field emits when it is not set, precomputed by running the
   * real default path once. Null when that precompute threw; the write path
   * then recomputes and rethrows exactly where fillStruct would have. */
  defaultBytes: Uint8Array | null = null;

  constructor(
    readonly name: string,
    /** `${struct}.${field}`, the context the generic writers put in errors. */
    readonly ctx: string,
    readonly kind: number,
    readonly desc: PropDesc,
    /** K_TYPE value op, K_ARRAY element op, or K_MAP key op. */
    readonly op: PlanOp,
    readonly valueOp: PlanOp | null,
    readonly flat: FlatOp | null,
    readonly flatSize: number
  ) {}
}

class StructPlan {
  readonly fields: FieldPlan[] = [];
  readonly names = new Set<string>();
  /** The whole byte stream for an instance with nothing set, emitted with one
   * copy. Null when any field's default was not precomputable. */
  allDefaultBytes: Uint8Array | null = null;
  /** Defaults only matter for a top-level writePartialStruct call, so they are
   * computed on first use rather than for every nested plan. */
  defaultsReady = false;

  constructor(readonly name: string) {}
}

class VariantPlan {
  constructor(
    readonly name: string,
    /** member name -> tag, replacing writeValue's linear indexOf per value. */
    readonly tags: Map<string, number>,
    readonly ops: PlanOp[]
  ) {}
}

/** Plan-cached counterpart of BrdbSchema's write path: identical bytes and
 * errors, but per-type resolution happens once per planner instead of once per
 * instance. One planner is built per schema per write; plan construction is
 * cheap enough that cross-write sharing is unnecessary. */
export class WritePlanner {
  private readonly structPlans = new Map<string, StructPlan | null>();
  private readonly variantPlans = new Map<string, VariantPlan>();
  private readonly ops = new Map<string, PlanOp>();
  private readonly flatOps = new Map<string, FlatOp>();
  private readonly building = new Set<string>();
  // One-entry memo over the top-level type name: data is grouped by type, so
  // consecutive instances usually share one.
  private lastName: string | null = null;
  private lastOp: PlanOp | null = null;

  /** `defaultsFor` supplies the per-struct default table writePartialStruct
   * uses, mirroring fillStruct's `defaults` argument. */
  constructor(
    readonly schema: BrdbSchema,
    private readonly defaultsFor?: (
      structName: string
    ) => Readonly<Record<string, BrdbValue>> | undefined
  ) {}

  /** Plan-cached equivalent of `schema.writeValue(w, ty, value)`. */
  write(w: ByteWriter, ty: string, value: BrdbValue): void {
    if (ty !== this.lastName) {
      this.lastOp = this.resolveOp(ty);
      this.lastName = ty;
    }
    this.writeOp(w, this.lastOp, value);
  }

  /** Plan-cached equivalent of `schema.encode(ty, value)`. */
  encode(ty: string, value: BrdbValue, capacity?: number): Uint8Array {
    const w = new ByteWriter(capacity);
    this.write(w, ty, value);
    return w.toBytes();
  }

  /** Plan-cached equivalent of
   * `writeValue(w, structName, fillStruct(structName, partial, defaults))`,
   * without materializing the filled struct: unset fields emit precomputed
   * default bytes, and a wholly unset instance emits one precomputed run. */
  writePartialStruct(
    w: ByteWriter,
    structName: string,
    partial: Readonly<Record<string, BrdbValue>>
  ): void {
    const plan = this.structPlan(structName);
    if (!plan) throw new Error(`brdb: unknown struct ${structName}`);
    if (!plan.defaultsReady) this.buildDefaults(plan);
    // fillStruct rejects keys the struct does not declare.
    const keys = Object.keys(partial);
    for (let i = 0; i < keys.length; i++)
      if (!plan.names.has(keys[i]))
        throw new Error(`brdb: ${structName} has no field '${keys[i]}'`);
    if (keys.length === 0 && plan.allDefaultBytes) {
      w.bytes(plan.allDefaultBytes);
      return;
    }
    const fields = plan.fields;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const given = partial[f.name];
      if (given !== undefined) this.writeField(w, f, given);
      else if (f.defaultBytes !== null) w.bytes(f.defaultBytes);
      // Not precomputable: recompute the default so it throws where (and only
      // where) fillStruct would have.
      else this.writeField(w, f, this.defaultValue(plan, f));
    }
  }

  // ---- plan construction ----

  /** Resolve a type name to a write op, mirroring writeValue's dispatch order
   * exactly: primitives and special names first, then variant, enum, struct. */
  private resolveOp(ty: string): PlanOp {
    const cached = this.ops.get(ty);
    if (cached) return cached;
    const op = this.buildOp(ty);
    this.ops.set(ty, op);
    return op;
  }

  private buildOp(ty: string): PlanOp {
    switch (ty) {
      case 'bool':
        return new PlanOp(OP_BOOL, ty);
      case 'u8':
        return new PlanOp(OP_U8, ty);
      case 'u16':
      case 'u32':
      case 'u64':
        return new PlanOp(OP_UINT, ty);
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
        return new PlanOp(OP_INT, ty);
      case 'f32':
        return new PlanOp(OP_F32, ty);
      case 'f64':
        return new PlanOp(OP_F64, ty);
      case 'str':
      case 'bundle_path_ref':
        return new PlanOp(OP_STR, ty);
      case 'class':
      case 'object':
      case 'weak_object':
        return new PlanOp(OP_ASSET, ty);
      // The two legacy fixed-tag unions are leaf work, and the generic writer
      // reaches them on its first switch, so planning buys nothing.
      case 'wire_graph_variant':
      case 'wire_graph_prim_math_variant':
        return new PlanOp(OP_FALLBACK, ty);
    }
    if (this.schema.variants.has(ty)) return new PlanOp(OP_VARIANT, ty);
    const enumTy = this.schema.enums.get(ty);
    if (enumTy) return new PlanOp(OP_ENUM, ty, null, null, enumTy.size);
    if (this.schema.structs.has(ty)) {
      if (this.building.has(ty)) return new PlanOp(OP_DEFERRED, ty);
      const plan = this.structPlan(ty);
      return plan
        ? new PlanOp(OP_STRUCT, ty, plan)
        : new PlanOp(OP_FALLBACK, ty);
    }
    return new PlanOp(OP_FALLBACK, ty); // unknown: writeValue throws
  }

  private structPlan(name: string): StructPlan | null {
    const cached = this.structPlans.get(name);
    if (cached !== undefined) return cached;
    const props = this.schema.structs.get(name);
    if (!props) {
      this.structPlans.set(name, null);
      return null;
    }
    if (this.building.has(name)) return null; // in-flight self reference
    this.building.add(name);
    const plan = new StructPlan(name);
    for (const [field, prop] of props) {
      plan.names.add(field);
      plan.fields.push(this.fieldPlan(name, field, prop));
    }
    this.building.delete(name);
    this.structPlans.set(name, plan);
    return plan;
  }

  private fieldPlan(
    structName: string,
    field: string,
    prop: PropDesc
  ): FieldPlan {
    const ctx = `${structName}.${field}`;
    switch (prop.kind) {
      case 'type':
        return new FieldPlan(
          field,
          ctx,
          K_TYPE,
          prop,
          this.resolveOp(prop.type),
          null,
          null,
          0
        );
      case 'array':
        return new FieldPlan(
          field,
          ctx,
          K_ARRAY,
          prop,
          this.resolveOp(prop.type),
          null,
          null,
          0
        );
      case 'flatarray':
        return new FieldPlan(
          field,
          ctx,
          K_FLAT,
          prop,
          this.resolveOp(prop.type),
          null,
          this.resolveFlatOp(prop.type),
          this.schema.flatTypeSize(prop.type)
        );
      case 'map':
        return new FieldPlan(
          field,
          ctx,
          K_MAP,
          prop,
          this.resolveOp(prop.key),
          this.resolveOp(prop.value),
          null,
          0
        );
    }
  }

  private resolveFlatOp(ty: string): FlatOp {
    const cached = this.flatOps.get(ty);
    if (cached) return cached;
    const op = this.buildFlatOp(ty);
    this.flatOps.set(ty, op);
    return op;
  }

  private buildFlatOp(ty: string): FlatOp {
    switch (ty) {
      case 'u8':
        return new FlatOp(F_U8, ty, null, false);
      case 'i8':
        return new FlatOp(F_I8, ty, null, false);
      case 'u16':
        return new FlatOp(F_U16, ty, null, false);
      case 'i16':
        return new FlatOp(F_I16, ty, null, false);
      case 'u32':
        return new FlatOp(F_U32, ty, null, false);
      case 'i32':
        return new FlatOp(F_I32, ty, null, false);
      case 'f32':
        return new FlatOp(F_F32, ty, null, false);
      case 'f64':
        return new FlatOp(F_F64, ty, null, false);
      case 'u64':
        return new FlatOp(F_U64, ty, null, true);
      case 'i64':
        return new FlatOp(F_I64, ty, null, true);
    }
    const struct = this.schema.structs.get(ty);
    // Unknown type, or a struct with a non-flat field: writeFlat errors
    // mid-stream, so hand the whole element back to it.
    if (!struct) return new FlatOp(F_FALLBACK, ty, null, true);
    const props: FlatField[] = [];
    let usesCtx = false;
    for (const [field, prop] of struct) {
      if (prop.kind !== 'type') return new FlatOp(F_FALLBACK, ty, null, true);
      const op = this.resolveFlatOp(prop.type);
      usesCtx = usesCtx || op.usesCtx;
      props.push(new FlatField(field, op));
    }
    return new FlatOp(F_STRUCT, ty, props, usesCtx);
  }

  /** The value fillStruct would put in a field the caller left unset. */
  private defaultValue(plan: StructPlan, f: FieldPlan): BrdbValue {
    const given = this.defaultsFor?.(plan.name)?.[f.name];
    if (given !== undefined) return given;
    return f.kind === K_TYPE
      ? this.schema.zeroValue((f.desc as { type: string }).type)
      : f.kind === K_MAP
      ? ({ $map: [] } as unknown as BrdbValue)
      : [];
  }

  private buildDefaults(plan: StructPlan): void {
    plan.defaultsReady = true;
    let total = 0;
    for (const f of plan.fields) {
      try {
        const w = new ByteWriter(64);
        this.writeField(w, f, this.defaultValue(plan, f));
        f.defaultBytes = w.toBytes();
        total += f.defaultBytes.length;
      } catch {
        f.defaultBytes = null; // recomputed (and rethrown) at write time
        return; // no whole-struct run either
      }
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const f of plan.fields) {
      joined.set(f.defaultBytes, at);
      at += f.defaultBytes.length;
    }
    plan.allDefaultBytes = joined;
  }

  private variantPlan(ty: string): VariantPlan {
    const cached = this.variantPlans.get(ty);
    if (cached) return cached;
    const members = this.schema.variants.get(ty) ?? [];
    const tags = new Map<string, number>();
    const ops: PlanOp[] = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      // indexOf semantics: the FIRST position wins for a duplicated member.
      if (!tags.has(member)) tags.set(member, i);
      // A weak_object variant payload uses the signed encoder for set values
      // too (writeVariantPayload), unlike a schema-typed asset field.
      ops.push(
        member === 'weak_object'
          ? new PlanOp(OP_VARIANT_OBJECT, member)
          : this.resolveOp(member)
      );
    }
    const plan = new VariantPlan(ty, tags, ops);
    this.variantPlans.set(ty, plan);
    return plan;
  }

  // ---- plan replay ----

  private writeOp(w: ByteWriter, op: PlanOp, value: BrdbValue): void {
    switch (op.k) {
      case OP_BOOL:
        return mpBool(w, value as boolean);
      case OP_U8:
        return mpU8(w, value as number);
      case OP_UINT:
        return mpUint(w, asInt64(value, op.ty));
      case OP_INT:
        return mpInt(w, asInt64(value, op.ty));
      case OP_F32:
        return mpF32(w, value as number);
      case OP_F64:
        return mpF64(w, value as number);
      case OP_STR:
        return mpStr(w, value as string);
      case OP_ASSET:
        // asset reference: index into external_asset_references; null = -1
        return value === null ? mpInt(w, -1) : mpUint(w, value as number);
      case OP_VARIANT_OBJECT:
        return mpInt(w, value === null ? -1 : (value as number));
      case OP_ENUM: {
        const ordinal = value as number;
        if (ordinal < 0 || ordinal >= op.enumSize)
          throw new RangeError(
            `brdb: enum ${op.ty} ordinal ${ordinal} out of bounds`
          );
        return mpUint(w, ordinal); // ordinal, NOT the declared value
      }
      case OP_STRUCT:
        return this.writeStruct(w, op.struct, value);
      case OP_DEFERRED: {
        const plan = op.struct ?? (op.struct = this.structPlan(op.ty));
        return plan
          ? this.writeStruct(w, plan, value)
          : this.schema.writeValue(w, op.ty, value);
      }
      case OP_VARIANT: {
        const plan = op.variant ?? (op.variant = this.variantPlan(op.ty));
        const v = asVariant(value, op.ty);
        const tag = plan.tags.get(v.$variant);
        if (tag === undefined)
          throw new Error(
            `brdb: '${v.$variant}' is not a member of variant ${op.ty}`
          );
        mpUint(w, tag);
        return this.writeOp(w, plan.ops[tag], v.value);
      }
      default:
        return this.schema.writeValue(w, op.ty, value);
    }
  }

  private writeStruct(w: ByteWriter, plan: StructPlan, value: BrdbValue): void {
    const obj = value as { [k: string]: BrdbValue };
    const fields = plan.fields;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!(f.name in obj))
        throw new Error(`brdb: missing struct field ${f.ctx}`);
      this.writeField(w, f, obj[f.name]);
    }
  }

  private writeField(w: ByteWriter, f: FieldPlan, value: BrdbValue): void {
    switch (f.kind) {
      case K_TYPE:
        return this.writeOp(w, f.op, value);
      case K_ARRAY: {
        const arr = value as BrdbValue[];
        mpArrayHeader(w, arr.length);
        for (let i = 0; i < arr.length; i++) this.writeOp(w, f.op, arr[i]);
        return;
      }
      case K_FLAT: {
        const arr = value as BrdbValue[];
        const ty = (f.desc as { type: string }).type;
        if (f.flatSize === 0)
          throw new Error(`brdb: invalid flat type ${ty} at ${f.ctx}`);
        mpBinHeader(w, arr.length * f.flatSize);
        for (let i = 0; i < arr.length; i++)
          this.writeFlatOp(w, f.flat, arr[i], f.ctx);
        return;
      }
      case K_MAP: {
        const entries = (value as { $map?: BrdbValue[] })?.$map;
        if (!Array.isArray(entries))
          throw new Error(`brdb: expected a { $map } value at ${f.ctx}`);
        mpMapHeader(w, entries.length);
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] as BrdbValue[];
          this.writeOp(w, f.op, entry[0]);
          this.writeOp(w, f.valueOp, entry[1]);
        }
        return;
      }
    }
  }

  private writeFlatOp(
    w: ByteWriter,
    op: FlatOp,
    value: BrdbValue,
    ctx: string
  ): void {
    switch (op.k) {
      case F_U8:
        return w.u8(value as number);
      case F_I8:
        return w.i8(value as number);
      case F_U16:
        return w.u16le(value as number);
      case F_I16:
        return w.i16le(value as number);
      case F_U32:
        return w.u32le(value as number);
      case F_I32:
        return w.i32le(value as number);
      case F_F32:
        return w.f32le(value as number);
      case F_F64:
        return w.f64le(value as number);
      case F_U64:
        return w.u64le(BigInt(asInt64(value, ctx)));
      case F_I64:
        return w.i64le(BigInt(asInt64(value, ctx)));
      case F_STRUCT: {
        const obj = value as { [k: string]: BrdbValue };
        const props = op.props;
        for (let i = 0; i < props.length; i++) {
          const p = props[i];
          if (!(p.name in obj))
            throw new Error(`brdb: missing struct field ${op.ty}.${p.name}`);
          this.writeFlatOp(
            w,
            p.op,
            obj[p.name],
            p.op.usesCtx ? `${ctx}.${p.name}` : ctx
          );
        }
        return;
      }
      default:
        return this.schema.writeFlat(w, op.ty, value, ctx);
    }
  }
}
