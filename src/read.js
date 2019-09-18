import { MAGIC, MAX_VERSION } from './constants';
import { read, isEqual } from './utils';

// Reads in a byte array to build a brs object
export default function readBrs(brsData) {
  brsData = Array.from(new Uint8Array(brsData));

  // Determine if the first 3 bytes are equal to the Brickadia save magic bytes
  if (!isEqual(brsData.splice(0, 3), MAGIC)) {
    throw new Error('Invalid starting bytes');
  }

  // Determine if the file version supported
  const version = read.u16(brsData);
  if (version > MAX_VERSION) {
    throw new Error('Unsupported version');
  }

  // Convert from BGRA to RGBA
  const bgra = ([b, g, r, a]) => [r, g, b, a];

  // Read in Headers
  const header1Data = read.compressed(brsData);
  const header2Data = read.compressed(brsData);

  const header1 = {
    map: read.string(header1Data),
    ...((name, description, id) => ({
      author: {
        id, name,
      },
      description,
    }))(
      read.string(header1Data), // read author name
      read.string(header1Data), // read description
      read.uuid(header1Data), // read author id
    ),
    save_time: version >= 4 ? header1Data.splice(0, 8) : null,
    brick_count: read.i32(header1Data),
  };

  const header2 = {
    mods: read.array(header2Data, read.string),
    brick_assets: read.array(header2Data, read.string),
    colors: read.array(header2Data, data => bgra(data.splice(0, 4))),
    materials: version >= 2
      ? read.array(header2Data, read.string)
      : ['BMC_Hologram', 'BMC_Plastic', 'BMC_Glow', 'BMC_Metallic'],
    brick_owners: version >= 3
      ? read.array(header2Data, data => ({
        id: read.uuid(data),
        name: read.string(data),
      }))
      : [{id: header1.author_id, name: header1.author_name}],
  };

  // Read in bricks
  const brickData = read.compressed(brsData);
  const brickBits = read.bits(brickData);
  const bricks = [];

  // Brick reader
  while(!brickBits.empty() && bricks.length < header1.brick_count) {  
    brickBits.align();
    bricks.push({
      asset_name_index: brickBits.int(Math.max(header2.brick_assets.length, 2)),
      size: brickBits.bit() ? [brickBits.uint_packed(), brickBits.uint_packed(), brickBits.uint_packed()] : [0, 0, 0],
      position: [brickBits.int_packed(), brickBits.int_packed(), brickBits.int_packed()],
      ...(orientation => ({
        direction: (orientation >> 2) % 6,
        rotation: orientation & 3,
      }))(brickBits.int(24)),
      collision: brickBits.bit(),
      visibility: brickBits.bit(),
      material_index: brickBits.bit() ? brickBits.uint_packed() : 1,
      color: brickBits.bit() ? bgra(brickBits.bytes(4)) : brickBits.int(header2.colors.length),
      owner_index: version >= 3 ? brickBits.uint_packed() : 0,
    });
  }

  return {
    version,
    ...header1,
    ...header2,
    bricks,
  }
};
