import {
  BrickV1,
  BRSBytes,
  BrsV1,
  ReadOptions,
  UnrealColor,
  Vector,
} from './types';
import { bgra, read } from './utils';

// Reads in a byte array to build a brs object
export default function readBrsV1(
  brsData: BRSBytes,
  options: ReadOptions = {}
): BrsV1 {
  // Read in Headers
  const header1Data = read.compressed(brsData);
  const header2Data = read.compressed(brsData);

  const map = read.string(header1Data);
  const author_name = read.string(header1Data);
  const description = read.string(header1Data);

  const author_id = read.uuid(header1Data);

  const brick_count = read.i32(header1Data);

  const mods = read.array(header2Data, read.string);
  const brick_assets = read.array(header2Data, read.string);
  const colors = read.array(
    header2Data,
    data => bgra(Array.from(read.bytes(data, 4))) as UnrealColor
  );

  // Read in bricks
  let bricks: BrickV1[] = [];

  const numAssets = Math.max(brick_assets.length, 2);

  if (options.bricks) {
    bricks = Array(brick_count);
    const brickData = read.compressed(brsData);
    const brickBits = read.bits(brickData);

    // Brick reader
    for (let i = 0; !brickBits.empty() && i < brick_count; i++) {
      brickBits.align();
      const asset_name_index = brickBits.int(numAssets);
      const size: Vector = brickBits.bit()
        ? [
            brickBits.uint_packed(),
            brickBits.uint_packed(),
            brickBits.uint_packed(),
          ]
        : [0, 0, 0];
      const position: Vector = [
        brickBits.int_packed(),
        brickBits.int_packed(),
        brickBits.int_packed(),
      ];

      const orientation = brickBits.int(24);
      const direction = (orientation >> 2) % 6;
      const rotation = orientation & 3;
      const collision = brickBits.bit();
      const visibility = brickBits.bit();

      const color = brickBits.bit()
        ? bgra(brickBits.bytesArr(4) as [number, number, number, number])
        : brickBits.int(colors.length);

      bricks[i] = {
        asset_name_index,
        size,
        collision,
        position,
        direction,
        rotation,
        visibility,
        color,
      };
    }
  }

  return {
    version: 1,
    map,
    description,
    author: {
      id: author_id,
      name: author_name,
    },
    mods,
    brick_assets,
    colors,
    bricks,
    brick_count,
  };
}
