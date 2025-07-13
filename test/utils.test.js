const {
  utils: { read, write, subarray, chunk },
} = require('..');

describe('buffer read/writing', () => {
  // Generic testing of read and write
  const rwTest =
    fn =>
    (bytes, val, ...args) => {
      expect(read[fn](new Uint8Array(bytes), ...args)).toEqual(val);
      expect(write[fn](val, ...args)).toMatchObject(new Uint8Array(bytes));
    };

  // Testing both endiannesses for read and write
  const endianTest = fn => (bytes, val) => {
    // Little Endian (default)
    rwTest(fn)(bytes, val);

    // Big Endian
    rwTest(fn)(new Uint8Array(bytes).reverse(), val, false);
  };

  describe('byte manipulating util', () => {
    test('subarray', () => {
      const arr = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(subarray(arr, 2)).toMatchObject({ 0: 1, 1: 2 });
      expect(arr.brsOffset).toEqual(2);
      expect(subarray(arr, 4)).toMatchObject({ 0: 3, 1: 4, 2: 5, 3: 6 });
      expect(arr.brsOffset).toEqual(6);
    });

    test('chunk', () => {
      const arr = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      expect(chunk(arr, 4)).toMatchObject([
        { 0: 1, 1: 2, 2: 3, 3: 4 },
        { 0: 5, 1: 6, 2: 7, 3: 8 },
        { 0: 9, 1: 10, 2: 11, 3: 12 },
        { 0: 13, 1: 14, 2: 15, 3: 16 },
      ]);
    });
  });

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
    test('can parse uuid', () => {
      const bytes = [
        205, 107, 157, 27, 45, 75, 253, 187, 141, 171, 93, 155, 237, 75, 189,
        251,
      ];
      const uuid = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

      rwTest('uuid')(bytes, uuid);
    });
  });

  describe('array', () => {
    /*
      const bytes = [0x04, 0x00, 0x00, 0x00, 0x66, 0x6f, 0x6f, 0x00];
      const val = 'foo';
    */
    const read_byte = b => read.bytes(b, 1)[0];

    const arrTest = (bytes, arr, read_fn, write_fn) => {
      expect(read.array(new Uint8Array(bytes), read_fn)).toMatchObject(arr);
      expect(write.array(arr, write_fn)).toMatchObject(new Uint8Array(bytes));
    };

    test('00 00 00 00 -> []', () => {
      const bytes = [0x00, 0x00, 0x00, 0x00];
      const arr = [];

      arrTest(bytes, arr, read_byte, b => [b]);
    });

    test('03 00 00 00 01 02 03 -> [1, 2, 3]', () => {
      const bytes = [0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03];
      const arr = [1, 2, 3];

      arrTest(bytes, arr, read_byte, b => [b]);
    });

    test('string array', () => {
      const str_bytes = [0x04, 0x00, 0x00, 0x00, 0x66, 0x6f, 0x6f, 0x00];
      const str = 'foo';
      const bytes = [
        0x05,
        0,
        0,
        0,
        ...str_bytes,
        ...str_bytes,
        ...str_bytes,
        ...str_bytes,
        ...str_bytes,
      ];
      const arr = [str, str, str, str, str];
      arrTest(bytes, arr, read.string, write.string);
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

    it('reads floats', () => {
      const bits = read.bits([0x42, 0xf6, 0xe6, 0x66].reverse());
      expect(bits.float()).toBeCloseTo(123.45);
    });

    it('doubles', () => {
      const written = write.bits();
      written.double(123.45);
      const bits = read.bits(written.finish());
      expect(bits.double()).toBeCloseTo(123.45);
    });

    it('integer64', () => {
      const written = write.bits();
      written.int64(1234567890);
      const bits = read.bits(written.finish());
      expect(bits.int64()).toBe(1234567890);
    });

    it('writes floats', () => {
      const bits = write.bits();
      bits.float(123.45);
      expect(bits.finish()).toStrictEqual(
        new Uint8Array([0x42, 0xf6, 0xe6, 0x66]).reverse()
      );
    });

    it('reads wire graph types', () => {
      const datas = [
        { bool: false },
        { bool: true },
        { number: 1.23 },
        { number: -1 },
        { number: 0.0 },
        { integer: 123456789 },
        { integer: -123456789 },
        { integer: 0 },
      ];

      for (const data of datas) {
        const written = write.bits();
        written.wireGraphVariant(data);
        const bits = read.bits(written.finish());
        expect(bits.wireGraphVariant()).toMatchObject(data);
      }
    });
    // it('writes wire graph types', () => {});

    // TODO: tests for int_packed, uint_packed, bytes
  });
});
