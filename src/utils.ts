import { deflate, inflate } from 'pako';
import { MAX_INT } from './constants';
import {
  BRSBytes,
  Bytes,
  UnrealColor,
  UnrealFloat,
  UnrealType,
  Uuid,
  WireGraphVariant,
} from './types';
import { uuidParse, uuidStringify } from './uuid';

/*
  Notes:
    - Everything is Little Endian by default because
      UE4 uses it.
    - I'd use Buffer.readUInt16LE if I was making this
      nodejs only. I don't want to require('Buffer/')

 */

// Determine if a string is ascii-only
function isASCII(text: string): boolean {
  return /^[\x00-\x7F]*$/.test(text);
}

// convert BGRA color to RGBA color
export const bgra = ([b, g, r, a]: number[]): [
  number,
  number,
  number,
  number
] => [r, g, b, a];

// Compare equality of byte arrays
export function isEqual<T>(arrA: Array<T>, arrB: Array<T>): boolean {
  return arrA.length === arrB.length && arrA.every((a: T, i) => arrB[i] === a);
}

function isBRSBytes(data: Bytes): data is BRSBytes {
  return (data as BRSBytes).brsOffset !== undefined;
}

// read `len` bytes and return slice while updating offset
export function subarray(data: Bytes, len: number, isCopy = false): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new Error(`Invalid data type in bytes reader (${typeof data})`);
  }

  let bytes: BRSBytes;
  if (!isBRSBytes(data)) {
    bytes = data as BRSBytes;
    bytes.brsOffset = 0;
  } else {
    bytes = data;
  }

  const chunk = bytes[isCopy ? 'slice' : 'subarray'](
    bytes.brsOffset,
    bytes.brsOffset + len
  );
  bytes.brsOffset += len;
  return chunk;
}

// break a byte array into chunks of a specified size
export function chunk(arr: Bytes, size: number): BRSBytes[] {
  // relative length based on the offset of the array's data view
  const length = arr.length - (isBRSBytes(arr) ? arr.brsOffset : 0);

  // out array of chunks pre-allocated
  const out = Array(Math.floor(length / size));

  for (let i = 0; i < length / size; i++) {
    out[i] = subarray(arr, size, true);
  }

  return out;
}

// Read a u16 from a byte array
function read_u16(data: Bytes, littleEndian = true): number {
  const [a, b] = subarray(data, 2);

  return littleEndian ? (b << 8) | a : (a << 8) | b;
}

// Write a u16 into byte array
function write_u16(num: number, littleEndian = true): Uint8Array {
  const data = [num & 255, (num >> 8) & 255];
  return new Uint8Array(!littleEndian ? data.reverse() : data);
}

// Read an i32 from a byte array
function read_i32(data: Bytes, littleEndian = true): number {
  const [a, b, c, d] = subarray(data, 4);
  return littleEndian
    ? (d << 24) | (c << 16) | (b << 8) | a
    : (a << 24) | (b << 16) | (c << 8) | d;
}

// Write an i32 from a byte array
function write_i32(num: number, littleEndian = true): Uint8Array {
  const data = new Uint8Array([
    num & 255,
    (num >> 8) & 255,
    (num >> 16) & 255,
    (num >> 24) & 255,
  ]);

  return !littleEndian ? data.reverse() : data;
}

// Decompress a byte array of compressed data
function read_compressed(data: Bytes): Bytes {
  const uncompressedSize = read_i32(data);
  const compressedSize = read_i32(data);

  // Throw error for weird compression/uncompression sizes
  if (
    compressedSize < 0 ||
    uncompressedSize < 0 ||
    compressedSize >= uncompressedSize
  ) {
    throw new Error(
      `Invalid compressed section size (comp: ${compressedSize}, uncomp: ${uncompressedSize})`
    );
  }

  // No compressed data? Return those bytes
  if (compressedSize === 0) {
    return subarray(data, uncompressedSize);
  } else {
    // Decompress the data otherwise
    const compressed = subarray(data, compressedSize);
    return inflate(compressed);
  }
}

// Compress a byte array into fewer bytes
function write_uncompressed(...args: Uint8Array[]): Uint8Array {
  // Concat the args to one massive array
  const data = concat(...args);

  // Build the output
  return concat(write_i32(data.length), write_i32(0), data);
}

// Compress a byte array into fewer bytes
function write_compressed(...args: Uint8Array[]): Uint8Array {
  // Concat the args to one massive array
  const data = concat(...args);

  // Do the compression
  const compressed = deflate(data);
  const uncompressedSize = data.length;
  const compressedSize = compressed.length;

  if (uncompressedSize > MAX_INT) {
    throw new Error(`uncompressedSize (${uncompressedSize}) out of range`);
  }

  if (compressedSize > MAX_INT) {
    throw new Error(`compressedSize (${compressedSize}) out of range`);
  }

  // Determine if compression increases size
  const badCompress = compressedSize >= uncompressedSize;

  // Build the output
  return concat(
    write_i32(uncompressedSize),
    write_i32(badCompress ? 0 : compressedSize),
    badCompress ? data : compressed
  );
}

// Read a string from a byte array
function read_string(data: Bytes): string {
  const raw_size = read_i32(data);
  const is_ucs2 = raw_size < 0;
  const size = is_ucs2 ? -raw_size * 2 : raw_size;

  // Determine if we are using UCS-2
  if (is_ucs2) {
    if (size % 2 !== 0) {
      throw new Error('Invalid UCS-2 data size');
    }

    // Create ucs2 encoded string
    return String.fromCodePoint(
      // Read the data in 2 byte windows
      ...chunk(subarray(data, size), 2).map(arr => read_u16(arr)) // Convert the two bytes into u16
    );
  } else {
    // Read the data, remove the \u0000 at the end :)
    const strData = subarray(data, size).subarray(0, -1);

    // Convert into ascii
    // console.debug('[debug] strdata', strData);
    return String.fromCharCode.apply(null, strData);
  }
}

// Write a string to bytes
function write_string(str: string): Uint8Array {
  if (isASCII(str)) {
    return concat(
      write_i32(str.length + 1), // Write string length (+ null term)
      new Uint8Array(str.split('').map(s => s.charCodeAt(0))), // Write string as bytes
      new Uint8Array([0]) // Null terminator
    );
  } else {
    // ucs2 strings denoted by negative length
    const len = -str.length;
    return concat(
      write_i32(len), // write length
      // convert string to little endian ucs2
      new Uint8Array(
        str
          .split('')
          .flatMap(s => [s.charCodeAt(0) & 0xff, s.charCodeAt(0) >> 8])
      )
      // new Uint8Array([0]) // Null terminator
    );
  }
}

// Read uuid from 4 LE ints
function read_uuid(data: Bytes): string {
  return uuidStringify(
    // each chunk is LE
    chunk(subarray(data, 16), 4).flatMap(([a, b, c, d]) => [d, c, b, a])
  );
}

// parse a uuid into 4 LE ints
function write_uuid(uuid: Uuid) {
  return concat(
    ...chunk(uuidParse(uuid), 4).map(
      ([a, b, c, d]) => new Uint8Array([d, c, b, a])
    )
  );
}

// Read an array of things given a fn
function read_array<T>(data: Bytes, fn: (_: Bytes) => T): T[] {
  const length = read_i32(data);
  const arr = Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = fn(data);
  }
  return arr;
}

// iterate an array of things given a fn
function read_each(data: Bytes, fn: (_: Bytes) => void) {
  const length = read_i32(data);
  for (let i = 0; i < length; i++) {
    fn(data);
  }
}

// Write an array of things to bytes
function write_array<T>(arr: T[], fn: (_: T) => Uint8Array) {
  return concat(write_i32(arr.length), ...arr.map(o => fn(o)));
}

// Tool for reading byte arrays 1 bit at a time
export class BitReader {
  buffer: Uint8Array;
  pos: number = 0;

  constructor(data: Uint8Array) {
    this.buffer = data;
  }

  empty(): boolean {
    return this.pos >= this.buffer.length * 8;
  }

  // Read one bit as a boolean
  bit(): boolean {
    const bit = (this.buffer[this.pos >> 3] & (1 << (this.pos & 0b111))) !== 0;
    this.pos++;
    return bit;
  }

  // Align the pos to the nearest byte
  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  // read an int up to max
  int(max: number): number {
    let value = 0;
    let mask = 1;

    while (value + mask < max && mask !== 0) {
      if (this.bit()) {
        value |= mask;
      }
      mask <<= 1;
    }

    return value;
  }

  // read a packet in from bits
  uint_packed(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const next = this.bit();

      let part = 0;
      for (let shift = 0; shift < 7; shift++) {
        part |= (this.bit() ? 1 : 0) << shift;
      }
      value |= part << (7 * i);
      if (!next) {
        break;
      }
    }

    return value;
  }

  // an item in a read_positive_int_vector array
  int_packed(): number {
    const value = this.uint_packed();
    return (value >> 1) * ((value & 1) !== 0 ? 1 : -1);
  }

  // read some bits
  bits(num: number): number[] {
    const arr: number[] = [];
    for (let bit = 0; bit < num; bit++) {
      const shift = bit & 7;
      arr[bit >> 3] =
        (arr[bit >> 3] & ~(1 << shift)) | ((this.bit() ? 1 : 0) << shift);
    }
    return arr;
  }

  // Read some bytes
  bytes(num: number): Uint8Array {
    return new Uint8Array(this.bytesArr(num));
  }

  // read some bytes but not as a Uint8Array
  bytesArr(num: number): number[] {
    return this.bits(num * 8);
  }

  // read an array
  array<T>(fn: (_: BitReader) => T): T[] {
    const length = read_i32(this.bytes(4));
    const arr = Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = fn(this);
    }
    return arr;
  }

  // for each
  each(fn: (data: BitReader) => void) {
    const length = read_i32(this.bytes(4));
    for (let i = 0; i < length; i++) {
      fn(this);
    }
  }

  // read a string
  string(): string {
    const lenBytes = this.bytesArr(4);
    let len = read_i32(new Uint8Array(lenBytes));
    if (len < 0) len = -len * 2;
    return read_string(new Uint8Array(lenBytes.concat(this.bytesArr(len))));
  }

  // read a 32-bit float
  float(): number {
    const view = new DataView(new ArrayBuffer(4));

    // Write the ints to it
    view.setUint16(2, read_u16(this.bytes(2)));
    view.setUint16(0, read_u16(this.bytes(2)));

    // Read the bits as a float; note that by doing this, we're implicitly
    // converting it from a 32-bit float into JavaScript's native 64-bit double
    return view.getFloat32(0);
  }

  integer(): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint16(2, read_u16(this.bytes(2)));
    view.setUint16(0, read_u16(this.bytes(2)));

    // Read the bits as a signed 32-bit integer
    return view.getInt32(0);
  }

  int64(): number {
    const view = new DataView(new ArrayBuffer(8));

    // Read it 2 bytes at a time
    view.setUint16(6, read_u16(this.bytes(2)));
    view.setUint16(4, read_u16(this.bytes(2)));
    view.setUint16(2, read_u16(this.bytes(2)));
    view.setUint16(0, read_u16(this.bytes(2)));

    // Read the bits as a signed 64-bit integer
    const num = view.getBigInt64(0);
    if (num <= 1n << 64n) {
      return Number(num);
    }
    throw new Error(
      `Cannot read 64-bit integer ${num} as a JavaScript number...`
    );
  }

  // read a 64-bit double
  double(): number {
    const view = new DataView(new ArrayBuffer(8));

    // Read it 2 bytes at a time
    view.setUint16(6, read_u16(this.bytes(2)));
    view.setUint16(4, read_u16(this.bytes(2)));
    view.setUint16(2, read_u16(this.bytes(2)));
    view.setUint16(0, read_u16(this.bytes(2)));

    // Read the bits as a double
    return view.getFloat64(0);
  }

  wireGraphVariant(): WireGraphVariant {
    const type = this.bytes(1)[0];
    switch (type) {
      case 0: // number
        return { number: this.double() };
      case 1: // integer
        return { integer: this.int64() };
      case 2: // bool
        return { bool: this.bytes(1)[0] !== 0 };
      case 3: // exec
        return { exec: true };
      case 4: // object
        return { object: true };
      default:
        throw new Error(`Unknown wire graph variant type ${type}`);
    }
  }

  // read unreal types
  unreal(type: string): UnrealType {
    switch (type) {
      case 'String':
      case 'Class':
      case 'Object':
        return this.string();
      case 'Boolean':
        return !!read_i32(this.bytes(4));
      case 'Integer':
        return this.integer();
      case 'Integer64':
        return this.int64();
      case 'Float':
        return this.float();
      case 'Double':
        return this.double();
      case 'Color':
        return bgra(this.bytesArr(4)) as UnrealColor;
      case 'Byte':
        return this.bytes(1)[0];
      case 'Rotator':
        return [this.float(), this.float(), this.float()];
      case 'WireGraphVariant':
        return this.wireGraphVariant();
      case 'WireGraphPrimMathVariant':
        return this.wireGraphVariant();
    }
    throw new Error('Unknown unreal type ' + type);
  }
}

export class BitWriter {
  buffer: number[] = [];
  cur: number = 0;
  bitNum: number = 0;

  // Write a boolean as a bit
  bit(val: boolean) {
    this.cur |= (val ? 1 : 0) << this.bitNum;
    this.bitNum++;
    if (this.bitNum >= 8) {
      this.align();
    }
  }

  // Write `len` bits from `src` bytes
  bits(src: number[] | Uint8Array, len: number) {
    for (let bit = 0; bit < len; bit++) {
      this.bit((src[bit >> 3] & (1 << (bit & 7))) !== 0);
    }
  }

  // Write multiple bytes
  bytes(src: number[] | Uint8Array) {
    this.bits(src, 8 * src.length);
  }

  // Push the current bit into the buffer
  align() {
    if (this.bitNum > 0) {
      this.buffer.push(this.cur);
      this.cur = 0;
      this.bitNum = 0;
    }
  }

  // Write an int up to the potential max size
  int(value: number, max: number) {
    if (max < 2) {
      throw new Error(
        `Invalid input (BitWriter) -- max (${max}) must be at least 2`
      );
    }

    if (value >= max) {
      throw new Error(
        `Invalid input (BitWriter) -- value (${value}) is larger than max (${max})`
      );
    }

    let new_val = 0;
    let mask = 1;

    while (new_val + mask < max && mask !== 0) {
      this.bit((value & mask) !== 0);
      if ((value & mask) !== 0) {
        new_val |= mask;
      }

      mask <<= 1;
    }
  }

  // Write a packed unsigned int
  uint_packed(value: number) {
    do {
      const src = value & 0b1111111;
      value >>= 7;
      this.bit(value !== 0);
      this.bits([src], 7);
    } while (value !== 0);
  }

  // Write a packed integer
  int_packed(value: number) {
    this.uint_packed((Math.abs(value) << 1) | (value >= 0 ? 1 : 0));
  }

  // Return built buffer
  finish(): Uint8Array {
    this.align();
    return new Uint8Array(this.buffer);
  }

  // Return built buffer (and include length)
  finishSection() {
    this.align();
    return concat(write_i32(this.buffer.length), new Uint8Array(this.buffer));
  }

  // write a string
  string(str: string) {
    this.bytes(write_string(str));
  }

  float(num: UnrealFloat) {
    // create a float array
    const floatArr = new Float32Array(1);
    // assign the number
    floatArr[0] = num;
    // convert it into a byte array
    const bytes = new Int8Array(floatArr.buffer);
    this.bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
  }

  integer(num: number) {
    // create an int array
    const intArr = new Int32Array(1);
    // assign the number
    intArr[0] = num;
    // convert it into a byte array
    const bytes = new Int8Array(intArr.buffer);
    this.bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
  }

  int64(num: number | bigint | string) {
    // write this as a 64-bit integer using a dataview
    const view = new DataView(new ArrayBuffer(8));
    view.setBigInt64(0, typeof num === 'bigint' ? num : BigInt(num), true);
    this.bytes(new Uint8Array(view.buffer));
  }

  double(num: number) {
    // create a double array
    const doubleArr = new Float64Array(1);
    // assign the number
    doubleArr[0] = num;
    // convert it into a byte array
    const bytes = new Int8Array(doubleArr.buffer);
    this.bytes([
      bytes[0],
      bytes[1],
      bytes[2],
      bytes[3],
      bytes[4],
      bytes[5],
      bytes[6],
      bytes[7],
    ]);
  }

  wireGraphVariant(variant: WireGraphVariant) {
    if ('number' in variant) {
      this.bytes([0]); // type 0
      this.double(variant.number);
    } else if ('integer' in variant) {
      this.bytes([1]); // type 1
      this.int64(variant.integer);
    } else if ('bool' in variant) {
      this.bytes([2, variant.bool ? 1 : 0]); // type 2
    } else if ('exec' in variant) {
      this.bytes([3]); // type 3
      // no data for exec
    } else if ('object' in variant) {
      this.bytes([4]); // type 4
      // no data for object
    } else {
      throw new Error(
        `Unknown wire graph variant type ${JSON.stringify(variant)}`
      );
    }
  }

  // run a function with `this` as a BitReader
  self(fn: (this: BitWriter) => void) {
    fn.bind(this)();
    return this;
  }

  // write an array
  array<T>(arr: T[], fn: (this: BitWriter, item: T, index: number) => void) {
    this.bytes(write_i32(arr.length));
    arr.forEach(fn.bind(this));
    return this;
  }

  // write things from an array
  each<T>(arr: T[], fn: (this: BitWriter, item: T, index: number) => void) {
    arr.forEach(fn.bind(this));
    return this;
  }

  // write unreal types
  unreal(type: string, value: UnrealType) {
    switch (type) {
      case 'Class':
        if (typeof value !== 'string') {
          throw new Error(
            `writing unreal type Class, did not receive string (${value})`
          );
        }
        this.string(value);
        return;
      case 'String':
        if (typeof value !== 'string') {
          throw new Error(
            `writing unreal type String, did not receive string (${value})`
          );
        }
        this.string(value);
        return;
      case 'Object':
        if (typeof value !== 'string') {
          throw new Error(
            `writing unreal type Object, did not receive string (${value})`
          );
        }
        this.string(value);
        return;
      case 'Boolean':
        if (typeof value !== 'boolean') {
          throw new Error(
            `writing unreal type Boolean, did not receive boolean (${value})`
          );
        }
        this.bytes(write_i32(value ? 1 : 0));
        return;
      case 'Float':
        if (typeof value !== 'number') {
          throw new Error(
            `writing unreal type Float, did not receive float (${value})`
          );
        }
        this.float(value);
        return;
      case 'Byte':
        if (typeof value !== 'number') {
          throw new Error(
            `writing unreal type Byte, did not receive Byte (${value})`
          );
        }
        this.bytes([value & 255]);
        return;
      case 'Color':
        if (!Array.isArray(value) || value.length !== 4) {
          throw new Error(
            `writing unreal type Array, did not receive Array (${value})`
          );
        }
        this.bytes(bgra(value));
        return;
      case 'Rotator':
        if (!Array.isArray(value) || value.length !== 3) {
          throw new Error(
            `writing unreal type Array, did not receive Array (${value})`
          );
        }

        this.float(value[0]);
        this.float(value[1]);
        this.float(value[2]);
        return;
      case 'Integer':
        if (typeof value !== 'number') {
          throw new Error(
            `writing unreal type Integer, did not receive integer (${value})`
          );
        }
        this.integer(value);
        return;
      case 'Integer64':
        if (typeof value !== 'number') {
          throw new Error(
            `writing unreal type Integer64, did not receive integer (${value})`
          );
        }
        this.int64(value);
        return;
      case 'Double':
        if (typeof value !== 'number') {
          throw new Error(
            `writing unreal type Double, did not receive double (${value})`
          );
        }
        this.double(value);
        return;
      case 'WireGraphVariant':
        if (typeof value !== 'object') {
          throw new Error(
            `writing unreal type WireGraphVariant, did not receive object (${value})`
          );
        }
        this.wireGraphVariant(value as WireGraphVariant);
        return;
      case 'WireGraphPrimMathVariant':
        if (typeof value !== 'object') {
          throw new Error(
            `writing unreal type WireGraphPrimMathVariant, did not receive object (${value})`
          );
        }
        this.wireGraphVariant(value as WireGraphVariant);
        return;
    }
    throw new Error('Unknown unreal type ' + type);
  }
}

// concat uint8arrays together
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const buffLen = arrays.reduce((sum, value) => sum + value.length, 0);
  const buff = new Uint8Array(buffLen);

  // for each array - copy it over buff
  // next array is copied right after the previous one
  let length = 0;
  for (const array of arrays) {
    buff.set(array, length);
    length += array.length;
  }

  return buff;
}

export const read = {
  bytes: subarray,
  u16: read_u16,
  i32: read_i32,
  compressed: read_compressed,
  string: read_string,
  uuid: read_uuid,
  array: read_array,
  each: read_each,
  bits: (data: Bytes) => new BitReader(data),
};

export const write = {
  u16: write_u16,
  i32: write_i32,
  compressed: write_compressed,
  uncompressed: write_uncompressed,
  string: write_string,
  uuid: write_uuid,
  array: write_array,
  bits: () => new BitWriter(),
};
