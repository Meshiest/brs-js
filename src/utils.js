import pako from 'pako';
import punycode from 'punycode';
import uuidParse from 'uuid-parse';
import { MAX_INT } from './constants';

/*
  Notes:
    - Everything is Little Endian by default because
      UE4 uses it.
    - I'd use Buffer.readUInt16LE if I was making this
      nodejs only. I don't want to require('Buffer/')

 */

// Determine if a string is ascii-only
function isASCII(str) {
    return /^[\x00-\x7F]*$/.test(str);
}

// Compare equality of byte arrays
export function isEqual(arrA, arrB) {
  return arrA.every((a, i) => arrB[i] === a);
}

function chunk(arr, size) {
  const out = [];
  const clone = Array.from(arr);

  while(clone.length > 0)
    out.push(clone.splice(0, size));

  return out;
}

// Read a u16 from a byte array
function read_u16(data, littleEndian=true) {
  const [a, b] = data.splice(0, 2);

  return littleEndian ? (b << 8 | a) : (a << 8 | b);
}

// Write a u16 into byte array
function write_u16(num, littleEndian=true) {
  const data = [num & 255, (num >> 8) & 255];
  return !littleEndian ? data.reverse() : data;
}

// Read an i32 from a byte array
function read_i32(data, littleEndian=true) {
  const [a, b, c, d] = data.splice(0, 4);
  return littleEndian
    ? (d << 24 | c << 16 | b << 8 | a)
    : (a << 24 | b << 16 | c << 8 | d);
}

// Write an i32 from a byte array
function write_i32(num, littleEndian=true) {
  const data = [
    num & 255,
    (num >> 8) & 255,
    (num >> 16) & 255,
    (num >> 24) & 255,
  ];

  return !littleEndian ? data.reverse() : data;
}

// Decompress a byte array of compressed data
function read_compressed(data) {
  const uncompressedSize = read_i32(data);
  const compressedSize = read_i32(data);

  // Throw error for weird compression/uncompression sizes
  if (compressedSize < 0 || uncompressedSize < 0 || compressedSize >= uncompressedSize) {
    throw new Error('Invalid compressed section size');
  }

  // No compressed data? Return those bytes
  if (compressedSize === 0) {
    return data.splice(0, uncompressedSize);
  } else {
    // Decompress the data otherwise
    const compressed = data.splice(0, compressedSize);
    return Array.from(pako.inflate(compressed));
  }
}

// Compress a byte array into fewer bytes
function write_compressed(...args) {
  // Concat the args to one massive array
  const data = [].concat(...args);

  // Do the compression
  const compressed = Array.from(pako.deflate(data));
  const uncompressed_size = data.length;
  const compressed_size = compressed.length;

  if (uncompressed_size > MAX_INT) {
    throw new Error("uncompressed_size out of range");
  }

  if (compressed_size > MAX_INT) {
    throw new Error("compressed_size out of range");
  }

  // Determine if compression increases size
  const badCompress = compressed_size >= uncompressed_size;

  // Build the output
  return [].concat(
    write_i32(uncompressed_size),
    write_i32(badCompress ? 0 : compressed_size),
    badCompress ? data : compressed,
  );
}

// Read a string from a byte array
function read_string(data) {
  const raw_size = read_i32(data);
  const is_ucs2 = raw_size < 0;
  const size = is_ucs2 ? -raw_size : raw_size;

  // Determine if we are using UCS-2
  if (is_ucs2) {
    if (size % 2 !== 0) {
      throw new Error('Invalid UCS-2 data size');
    }


    // Create ucs2 encoded string
    return punycode.ucs2.encode(
      // Read the data in 2 byte windows
      chunk(data.splice(0, size), 2)
        .map(arr => read_u16(arr)) // Convert the two bytes into u16
    );
  } else {
    // Read the data, remove the \u0000 at the end :)
    const bytes = data.splice(0, size).slice(0, -1);

    // Convert to UTF-8
    return bytes 
      .map(b => String.fromCharCode(b))
      .join('');
  }
}

// Write a string to bytes
function write_string(str) {
  if (isASCII(str)) {
    return [].concat(
      write_i32(str.length + 1), // Write string length (+ null term)
      str.split('').map(s => s.charCodeAt(0)), // Write string as bytes
      [0], // Null terminator
    );
  } else {
    // ucs2 strings denoted by negative length
    const len = -((str.length + 1) * 2);
    return [].concat(
      write_i32(len), // write length
      punycode.ucs2.decode(str), // write decoded string
      [0], // Null terminator
    )
  }
}

// Read uuid from 4 LE ints
function read_uuid(data) {
  return uuidParse.unparse(
    [].concat(...chunk(data.splice(0, 16), 4)
      .map(arr => arr.reverse()) // each int is LE
    )
  );
}

// parse a uuid into 4 LE ints
function write_uuid(uuid) {
  return [].concat(
    ...chunk(Array.from(uuidParse.parse(uuid)), 4)
    .map(arr => arr.reverse()) // convert into 4 LE ints
  );
}

// Read an array of things given a fn
function read_array(data, fn) {
  const length = read_i32(data);
  return Array.from({ length })
    .map(() => fn(data));
}

// Write an array of things to bytes
function write_array(things, fn) {
  return [].concat(
    write_i32(things.length),
    ...things.map(o => fn(o))
  );
}

// Tool for reading byte arrays 1 bit at a time
class BitReader {
  constructor(data) {
    this.buffer = data;
    this.pos = 0;
  }

  empty() {
    return this.pos >= this.buffer.length * 8;
  }

  // Read one bit as a boolean
  bit() {
    const bit = (this.buffer[this.pos >> 3] & (1 << (this.pos & 0b111))) !== 0;
    this.pos++;
    return bit;
  }

  // Align the pos to the nearest byte
  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  // read an int up to max
  int(max) {
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
  uint_packed() {
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
  int_packed() {
    const value = this.uint_packed();
    return (value >> 1) * (value & 1 !== 0 ? 1 : -1);
  }

  // read some bits
  bits(num) {
    const arr = [];
    for (let bit = 0; bit < num; bit++) {
      const shift = bit & 7;
      arr[bit >> 3] = (arr[bit >> 3] & ~(1 << shift)) | ((this.bit() ? 1 : 0) << shift);
    }
    return arr;
  }

  // Read some bytes
  bytes(num) {
    return this.bits(num * 8);
  }
}

class BitWriter {
  constructor() {
    this.buffer = [];
    this.cur = 0;
    this.bitNum = 0;

  }

  // Write a boolean as a bit
  bit(val) {
    this.cur |= (val ? 1 : 0) << this.bitNum;
    this.bitNum++;
    if (this.bitNum >= 8) {
      this.align();
    }
  }

  // Write `len` bits from `src` bytes
  bits(src, len) {
    for (let bit = 0; bit < len; bit++) {
      this.bit((src[bit >> 3] & (1 << (bit & 7))) !== 0);
    }
  }

  // Write multiple bytes
  bytes(src) {
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
  int(value, max) {
    if (max < 2) {
      throw new Error('Invalid input (BitWriter) -- max must be at least 2')
    }

    if (value >= max) {
      throw new Error('Invalid input (BitWriter) -- value is larger than max')
    }

    let new_val = 0;
    let mask = 1;

    while ((new_val + mask) < max && mask !== 0) {
      this.bit((value & mask) !== 0);
      if ((value & mask) !== 0) {
        new_val |= mask;
      }

      mask <<= 1;
    }
  }

  // Write a packed unsigned int
  uint_packed(value) {
    do {
      const src = value & 0b1111111;
      value >>= 7;
      this.bit(value !== 0);
      this.bits([src], 7);
    } while (value !== 0);
  }

  // Write a packed integer 
  int_packed(value) {
    this.uint_packed((Math.abs(value) << 1) | (value >= 0 ? 1 : 0));
  }

  // Return built buffer
  finish() {
    this.align();
    return this.buffer;
  }

  each(arr, fn) {
    arr.forEach(fn.bind(this));
    return this;
  }
}

export const read = {
  u16: read_u16,
  i32: read_i32,
  compressed: read_compressed,
  string: read_string,
  uuid: read_uuid,
  array: read_array,
  bits: data => new BitReader(data),
};

export const write = {
  u16: write_u16,
  i32: write_i32,
  compressed: write_compressed,
  string: write_string,
  uuid: write_uuid,
  array: write_array,
  bits: data => new BitWriter(),
};
