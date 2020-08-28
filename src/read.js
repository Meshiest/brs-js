import { MAGIC, MAX_VERSION } from './constants';
import { read, isEqual } from './utils';

// Reads in a byte array to build a brs object
export default function readBrs(brsData, options={}) {
  if (typeof options !== 'object')
    throw new Error('Invalid options');

  brsData = new Uint8Array(brsData);
  brsData.brsOffset = 3;

  // Determine if the first 3 bytes are equal to the Brickadia save magic bytes
  if (!isEqual(brsData.slice(0, 3), MAGIC)) {
    throw new Error('Invalid starting bytes');
  }

  // Determine if the file version supported
  const version = read.u16(brsData);
  if (version > MAX_VERSION) {
    throw new Error('Unsupported version ' + version);
  }

  // game version is included in saves >= v8
  let gameVersion = 0;
  if (version >= 8) {
    gameVersion = read.i32(brsData);
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
    ...(version >= 8 ? {host: {
      name: read.string(header1Data),
      id: read.uuid(header1Data),
    }} : {}),
    save_time: version >= 4 ? read.bytes(header1Data, 8) : null,
    brick_count: read.i32(header1Data),
  };

  const header2 = {
    mods: read.array(header2Data, read.string),
    brick_assets: read.array(header2Data, read.string),
    colors: read.array(header2Data, data => bgra(read.bytes(data, 4))),
    materials: version >= 2
      ? read.array(header2Data, read.string)
      : ['BMC_Hologram', 'BMC_Plastic', 'BMC_Glow', 'BMC_Metallic'],
    brick_owners: version >= 3
      ? read.array(header2Data, data => ({
        id: read.uuid(data),
        name: read.string(data),
        ...(version >= 8 ? {bricks: read.i32(data)} : {}),
      }))
      : [{id: header1.author_id, name: header1.author_name}],
  };

  // check for preview byte
  let preview;
  if (version >= 8) {
    if(read.bytes(brsData, 1)[0]) {
      const len = read.i32(brsData);
      preview = read.bytes(brsData, len);
    }
  }

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
      material_index: version >= 8
        ? brickBits.int(Math.max(header2.materials.length, 2))
        : brickBits.bit() ? brickBits.uint_packed() : 1,
      color: brickBits.bit() ? bgra(brickBits.bytes(4)) : brickBits.int(header2.colors.length),
      owner_index: version >= 3 ? brickBits.uint_packed(true) : 0,
      ...(version >= 8 ? { components: {} } : {}),
    });
  }

  // components reader
  const components = {};
  if (version >= 8) {
    const componentData = read.compressed(brsData);
    read.array(componentData, data => {
      // read component name
      const name = read.string(data);

      // read component body
      const bits = read.bits(read.bytes(data, read.i32(data)));

      const version = read.i32(bits.bytes(4));
      // list of bricks
      const brick_indices = bits.array(() => bits.int(Math.max(bricks.length, 2)));

      // list of name, type properties
      const properties = bits.array(() => [bits.string(), bits.string()]);

      // read components for each brick
      for (const i of brick_indices) {
        const props = Object.fromEntries(properties.map(([name, type]) =>  [name, bits.unreal(type)]));
        bricks[i].components[name] = props;
      };

      return components[name] = {
        version,
        brick_indices,
        properties: Object.fromEntries(properties),
      }
    });
  }

  return {
    version,
    ...header1,
    ...header2,
    ...(version >= 8 ? {
      gameVersion,
      preview,
      components,
    } : {}),
    bricks,
  }
};
