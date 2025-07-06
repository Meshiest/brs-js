import {
  AppliedComponent,
  BrickV8,
  BRSBytes,
  BrsV8,
  ReadOptions,
  UnrealColor,
  User,
  Vector,
} from './types';
import { bgra, read } from './utils';

// Reads in a byte array to build a brs object
export default function readBrsV8(
  brsData: BRSBytes,
  options: ReadOptions = {}
): BrsV8 {
  // game version is included in saves >= v8
  const game_version = read.i32(brsData);

  // Read in Headers
  const header1Data = read.compressed(brsData);
  const header2Data = read.compressed(brsData);

  const map = read.string(header1Data);
  const author_name = read.string(header1Data);
  const description = read.string(header1Data);
  const author_id = read.uuid(header1Data);

  const host: User = {
    name: read.string(header1Data),
    id: read.uuid(header1Data),
  };
  const save_time = read.bytes(header1Data, 8);

  const brick_count = read.i32(header1Data);

  const mods = read.array(header2Data, read.string);
  const brick_assets = read.array(header2Data, read.string);
  const colors = read.array(
    header2Data,
    data => bgra(Array.from(read.bytes(data, 4))) as UnrealColor
  );
  const materials = read.array(header2Data, read.string);
  const brick_owners = read.array(header2Data, data => ({
    id: read.uuid(data),
    name: read.string(data),
    bricks: read.i32(data),
  }));

  // check for preview byte
  let preview = null;
  if (read.bytes(brsData, 1)[0]) {
    const len = read.i32(brsData);
    if (options.preview) {
      preview = read.bytes(brsData, len);
    } else {
      brsData.brsOffset += len;
    }
  }

  // Read in bricks
  let bricks: BrickV8[] = [];
  const components: BrsV8['components'] = {};

  const numMats = Math.max(materials.length, 2);
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
      const material_index = brickBits.int(numMats);

      const color = brickBits.bit()
        ? bgra(brickBits.bytesArr(4) as [number, number, number, number])
        : brickBits.int(colors.length);

      const owner_index = brickBits.uint_packed();

      bricks[i] = {
        asset_name_index,
        size,
        position,
        direction,
        rotation,
        collision,
        visibility,
        material_index,
        color,
        owner_index,
        components: {},
      };
    }

    const componentData = read.compressed(brsData);
    const numBricks = Math.max(bricks.length, 2);

    read.each(componentData, data => {
      // read component name
      const name = read.string(data);

      // read component body
      const bits = read.bits(read.bytes(data, read.i32(data)));

      const version = read.i32(bits.bytes(4));
      // list of bricks
      const brick_indices = bits.array(() => bits.int(numBricks));

      // list of name, type properties
      const properties = bits.array(() => [bits.string(), bits.string()]);

      // read components for each brick
      for (const i of brick_indices) {
        const props: AppliedComponent = {};
        for (const [name, type] of properties) props[name] = bits.unreal(type);
        bricks[i].components[name] = props;
      }

      components[name] = {
        version,
        brick_indices,
        properties: Object.fromEntries(properties),
      };
    });
  }

  return {
    version: 8,
    game_version,
    map,
    description,
    author: {
      id: author_id,
      name: author_name,
    },
    host,
    mods,
    brick_assets,
    colors,
    materials,
    brick_owners,
    preview,
    bricks,
    brick_count,
    save_time,
    components,
  };
}
