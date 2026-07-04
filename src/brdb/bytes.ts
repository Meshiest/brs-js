// Growable little/big-endian byte buffer primitives for the brdb codecs.
// msgpack multi-byte values are big-endian; brdb flat arrays are little-endian.

export class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  get length(): number {
    return this.len;
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  i8(v: number) {
    this.ensure(1);
    this.view.setInt8(this.len, v);
    this.len += 1;
  }

  bytes(v: Uint8Array | number[]) {
    const arr = v instanceof Uint8Array ? v : Uint8Array.from(v);
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }

  u16be(v: number) {
    this.ensure(2);
    this.view.setUint16(this.len, v, false);
    this.len += 2;
  }
  u32be(v: number) {
    this.ensure(4);
    this.view.setUint32(this.len, v, false);
    this.len += 4;
  }
  u64be(v: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.len, v, false);
    this.len += 8;
  }
  i16be(v: number) {
    this.ensure(2);
    this.view.setInt16(this.len, v, false);
    this.len += 2;
  }
  i32be(v: number) {
    this.ensure(4);
    this.view.setInt32(this.len, v, false);
    this.len += 4;
  }
  i64be(v: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.len, v, false);
    this.len += 8;
  }
  f32be(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.len, v, false);
    this.len += 4;
  }
  f64be(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.len, v, false);
    this.len += 8;
  }

  u16le(v: number) {
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
  }
  u32le(v: number) {
    this.ensure(4);
    this.view.setUint32(this.len, v, true);
    this.len += 4;
  }
  u64le(v: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.len, v, true);
    this.len += 8;
  }
  i16le(v: number) {
    this.ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
  }
  i32le(v: number) {
    this.ensure(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
  }
  i64le(v: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.len, v, true);
    this.len += 8;
  }
  f32le(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64le(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private view: DataView;
  offset: number;

  constructor(public data: Uint8Array, offset = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  private need(n: number) {
    if (this.offset + n > this.data.length)
      throw new RangeError(
        `brdb: unexpected end of data (need ${n} bytes at offset ${this.offset} of ${this.data.length})`
      );
  }

  peek(): number {
    this.need(1);
    return this.data[this.offset];
  }

  u8(): number {
    this.need(1);
    return this.data[this.offset++];
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.offset++);
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u16be(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }
  u32be(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }
  u64be(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, false);
    this.offset += 8;
    return v;
  }
  i16be(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }
  i32be(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }
  i64be(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }
  f32be(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }
  f64be(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }

  u16le(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32le(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64le(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i16le(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i32le(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  i64le(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  f32le(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64le(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
}
