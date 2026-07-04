import { MAGIC } from './constants';
import readBrsV1 from './read.v1';
import readBrsV10 from './read.v10';
import readBrsV14 from './read.v14';
import readBrsV2 from './read.v2';
import readBrsV3 from './read.v3';
import readBrsV4 from './read.v4';
import readBrsV8 from './read.v8';
import readBrsV9 from './read.v9';
import { BRSBytes, ReadOptions, ReadSaveObject } from './types';
import { read } from './utils';

// Reads in a byte array to build a brs object
export default function readBrs(
  rawBytes: Uint8Array,
  options: ReadOptions = {}
): ReadSaveObject {
  if (typeof options !== 'object') throw new Error('Invalid options');

  // default enable brick reading
  if (typeof options.bricks !== 'boolean') options.bricks = true;

  // default disable preview (a5 only)
  if (typeof options.preview !== 'boolean') options.preview = false;

  // Determine if the first 3 bytes are equal to the Brickadia save magic bytes
  if (
    rawBytes[0] !== MAGIC[0] ||
    rawBytes[1] !== MAGIC[1] ||
    rawBytes[2] !== MAGIC[2]
  ) {
    throw new Error('Invalid starting bytes');
  }

  const brsData = rawBytes as BRSBytes;
  brsData.brsOffset = 3;

  // Determine if the file version supported
  const version = read.u16(brsData);
  switch (version) {
    case 1:
      return readBrsV1(brsData, options);
    case 2:
      return readBrsV2(brsData, options);
    case 3:
      return readBrsV3(brsData, options);
    case 4:
      return readBrsV4(brsData, options);
    case 8:
      return readBrsV8(brsData, options);
    case 9:
      return readBrsV9(brsData, options);
    case 10:
      return readBrsV10(brsData, options);
    case 14:
      return readBrsV14(brsData, options);
    default:
      throw new Error('Unsupported version ' + version);
  }
}
