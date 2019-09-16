import pako from 'pako';
import punycode from 'punycode';
import chunk from 'lodash/chunk';
import uuidParse from 'uuid-parse';

/*
  Notes:
    - Everything is Little Endian by default because
      UE4 uses it.
    - I'd use Buffer.readUInt16LE if I was making this
      nodejs only. I don't want to require('Buffer/')

 */

// Read a u16 from a byte array
function read_u16(data, littleEndian=true) {
  const [a, b] = data.splice(0, 2);

  return littleEndian ? (b << 8 | a) : (a << 8 | b);
}

// Read an i32 from a byte array
function read_i32(data, littleEndian=true) {
  const [a, b, c, d] = data.splice(0, 4);
  return littleEndian
    ? (d << 24 | c << 16 | b << 8 | a)
    : (a << 24 | b << 16 | c << 8 | d);
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

// Read uuid from bytes
function read_uuid(data) {
  return uuidParse.unparse(data.splice(0, 16));
}

// Read an array of things in
function read_array(data, fn) {
  const length = read_i32(data);
  return Array.from({ length })
    .map(() => fn(data));
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
    this.pos = this.pos + 7 & ~7;
  }

  // read an int up to max
  int(max) {
    let value = 0;
    let mask = 1;

    while (value + mask < max && mask != 0) {
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
    return (value >> 1) * (value & 1 != 0 ? 1 : -1);
  }

  // read some bits
  bits(num) {
    const arr = [];
    for (let bit = 0; bit < num; bit++) {
      const shift = bit & 7;
      arr[bit >> 3] = (arr[bit >> 3] & !(1 << shift)) | ((this.bit() ? 1 : 0) << shift);
    }
    this.pos += num;
    return arr;
  }

  // Read some bytes
  bytes(num) {
    return this.bits(num * 8);
  }
}

const read = {
  u16: read_u16,
  i32: read_i32,
  compressed: read_compressed,
  string: read_string,
  uuid: read_uuid,
  array: read_array,
  bits: data => new BitReader(data),
};

export {
  read,
};