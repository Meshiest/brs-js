import { MAGIC, MAX_VERSION } from './constants';
import { read, isEqual } from './utils';

// Reads in a byte array to build a brs object
export default function readBrs(brsData, options={}) {
  if (typeof options !== 'object')
    throw new Error('Invalid options');

  // default enable brick reading
  if (typeof options.bricks !== 'boolean') options.bricks = true;

  // default disable preview (a5 only)
  if (typeof options.preview !== 'boolean') options.preview = false;

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
    author: {name: read.string(header1Data)},
    description: read.string(header1Data),
    save_time: null,
  };
  header1.author.id = read.uuid(header1Data);

  if(version >= 8) {
    header1.host = {
      name: read.string(header1Data),
      id: read.uuid(header1Data),
    };
  }
  if (version >= 4)
    header1.save_time = read.bytes(header1Data, 8);

  header1.brick_count = read.i32(header1Data);

  const header2 = {
    mods: read.array(header2Data, read.string),
    brick_assets: read.array(header2Data, read.string),
    colors: read.array(header2Data, data => bgra(read.bytes(data, 4))),
    materials: version >= 2
      ? read.array(header2Data, read.string)
      : ['BMC_Hologram', 'BMC_Plastic', 'BMC_Glow', 'BMC_Metallic', 'BMC_Glass'],
    brick_owners: version >= 3
      ? read.array(header2Data, data => {
        const owner = {
          id: read.uuid(data),
          name: read.string(data),
        };

        if (version >= 8) owner.bricks = read.i32(data);

        return owner;
      })
      : [{id: header1.author_id, name: header1.author_name}],
  };

  if (version >= 9)
    header2.physical_materials = read.array(header2Data, read.string);


  // check for preview byte
  let preview;
  if (version >= 8) {
    if(read.bytes(brsData, 1)[0]) {
      const len = read.i32(brsData);
      if (options.preview) {
        preview = read.bytes(brsData, len);
      } else {
        brsData.brsOffset += len;
      }
    }
  }

  // Read in bricks
  let bricks = [];
  const components = {};

  const numPhysMats = version >= 9 ? Math.max(header2.physical_materials.length, 2) : 0;
  const numMats = Math.max(header2.materials.length, 2);
  const numAssets = Math.max(header2.brick_assets.length, 2);

  if (options.bricks) {
    bricks = Array(header1.brick_count)
    const brickData = read.compressed(brsData);
    const brickBits = read.bits(brickData);

    // Brick reader
    for(let i = 0; !brickBits.empty() && i < header1.brick_count; i++) {
      brickBits.align();
      const brick = bricks[i] = {};
      brick.asset_name_index = brickBits.int(numAssets);
      brick.size = brickBits.bit()
          ? [brickBits.uint_packed(), brickBits.uint_packed(), brickBits.uint_packed()]
          : [0, 0, 0];
      brick.position = [brickBits.int_packed(), brickBits.int_packed(), brickBits.int_packed()];

      const orientation = brickBits.int(24);
      brick.direction = (orientation >> 2) % 6;
      brick.rotation = orientation & 3;

      if (version >= 10) {
        brick.collision = {
          player: brickBits.bit(),
          weapon: brickBits.bit(),
          interaction: brickBits.bit(),
          tool: brickBits.bit(),
        };
      } else {
        brick.collision = brickBits.bit();
      }
      brick.visibility = brickBits.bit();
      brick.material_index = version >= 8
        ? brickBits.int(numMats)
        : brickBits.bit() ? brickBits.uint_packed() : 1;

      if (version >= 9) {
        brick.physical_index = brickBits.int(numPhysMats);
        brick.material_intensity = brickBits.int(11);
      }
      brick.color = brickBits.bit()
        ? version >= 9 ? Array.from(brickBits.bytes(3)) : bgra(brickBits.bytes(4))
        : brickBits.int(header2.colors.length);

      brick.owner_index = version >= 3 ? brickBits.uint_packed(true) : 0;

      if (version >= 8) {
        brick.components = {};
      }
    }

    if (version >= 8) {
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
          const props = {};
          for (const [name, type] of properties)
            props[name] = bits.unreal(type);
          bricks[i].components[name] = props;
        };

        components[name] = {
          version,
          brick_indices,
          properties: Object.fromEntries(properties),
        };
      });
    }
  }

  const saveData = {
    version,
    bricks,
  };

  Object.assign(saveData, header1);
  Object.assign(saveData, header2);

  if (version >= 8) {
    saveData.gameVersion = gameVersion;
    saveData.preview = preview;
    saveData.components = components;
  }

  return saveData;
};
