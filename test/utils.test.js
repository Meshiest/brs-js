const { utils: { read, write } } = require('../dist/dist.node.js');
const clone = require('lodash/clone');

describe('buffer read/writing', () => {
  // Generic testing of read and write
  const rwTest = fn => (bytes, val, ...args) => {
    expect(read[fn](clone(bytes), ...args)).toEqual(val);
    expect(write[fn](val, ...args)).toEqual(bytes);
  };

  // Testing both endiannesses for read and write
  const endianTest = fn => (bytes, val) => {
    // Little Endian (default)
    rwTest(fn)(bytes, val);

    // Big Endian
    rwTest(fn)(clone(bytes).reverse(), val, false);
  };

  describe('unsigned short', () => {
    const shortTest = endianTest('u16');

    test('00 00 -> 0', () => {
      const bytes = [0x00, 0x00];
      const val = 0;

      shortTest(bytes, val);
    });

    test('ff ff -> 65535', () => {
      const bytes = [0xff, 0xff];
      const val = 0xffff;

      shortTest(bytes, val);
    });

    test('01 20 -> 8193', () => {
      const bytes = [0x01, 0x20];
      const val = 0x2001;

      shortTest(bytes, val);
    });
  });

  describe('signed int', () => {
    const intTest = endianTest('i32');

    test('00 00 00 00 -> 0', () => {
      const bytes = [0x00, 0x00, 0x00, 0x00];
      const val = 0;

      intTest(bytes, val);
    });

    test('ff ff ff ff -> -1', () => {
      const bytes = [0xff, 0xff, 0xff, 0xff];
      const val = -1;

      intTest(bytes, val);
    });

    test('13 37 69 69 -> 322398569', () => {
      const bytes = [0x69, 0x69, 0x37, 0x13];
      const val = 322398569;

      intTest(bytes, val);
    });
  });

  describe('string', () => {
    test('04 00 00 00 66 6f 6f 00 -> "foo"', () => {
      const bytes = [0x04, 0x00, 0x00, 0x00, 0x66, 0x6f, 0x6f, 0x00];
      const val = 'foo';

      rwTest('string')(bytes, val);
    });
  });

  describe('uuid', () => {
    test('01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 -> "01020304-0506-0708-090a-0b0c0d0e0f10"', () => {
      const bytes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10];
      const uuid = '01020304-0506-0708-090a-0b0c0d0e0f10';

      rwTest('uuid')(bytes, uuid);
    });
  });

  describe('array', () => {
    const arrTest = (bytes, arr) => {
      expect(read.array(clone(bytes), b => b.splice(0, 1)[0])).toEqual(arr);
      expect(write.array(arr, b => b)).toEqual(bytes);
    };

    test('00 00 00 00 -> []', () => {
      const bytes = [0x00, 0x00, 0x00, 0x00];
      const arr = [];

      arrTest(bytes, arr);
    });

    test('03 00 00 00 01 02 03 -> [1, 2, 3]', () => {
      const bytes = [0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03];
      const arr = [1, 2, 3];
      
      arrTest(bytes, arr);
    });
  });

  describe('bit reader', () => {
    it('reads bits', () => {
      const bits = read.bits([0b10101111]);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(false);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(false);
      expect(bits.bit()).toBe(true);
    });

    it('reads aligned bits', () => {
      const bits = read.bits([0b00000001, 0b10101111]);
      expect(bits.bit()).toBe(true);
      bits.align();
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(false);
      expect(bits.bit()).toBe(true);
      expect(bits.bit()).toBe(false);
      expect(bits.bit()).toBe(true);
    });

    it('reads ints', () => {
      const bits = read.bits([0b11001111]);
      expect(bits.int(16)).toBe(15);
      expect(bits.int(16)).toBe(12);
    });

    // TODO: tests for int_packed, uint_packed, bits, bytes
  });
});