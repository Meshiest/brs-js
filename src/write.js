import { MAGIC, LATEST_VERSION, MAX_INT } from './constants';
import { write, isEqual, concat } from './utils';


// TODO: Validate input saves
function validate(save) {
  if (typeof save !== 'object') {
    throw new Error('Expected save to be an object');
  }

  if (typeof save.bricks !== 'object' && save.bricks.length) {
    throw new Error('Expected save to have bricks field');
  }

  if (!save.bricks.every(b => typeof b.size === 'object' && typeof b.position === 'object'))
    throw new Error('Expected every brick to have size and position arrays')
}

// looks up a value in an object or returns a defualt value
function get(obj, path='', def) {
  // Split the path up by .
  path = path.split('.').filter(p => p.length > 0);

  // Get the child at each part of the path
  while (path.length && typeof obj === 'object') {
    obj = obj[path.splice(0, 1)[0]];
  }

  return typeof obj !== 'undefined' ? obj : def;
}

const EMPTY_ARR = new Uint8Array([]);

export default function writeBrs(save) {
  validate(save);

  if(save.bricks.length > MAX_INT) {
    throw new Error('Brick count out of range');
  }

  const version = save.version === 8 ? 8 : LATEST_VERSION;

  // Convert from BGRA to RGBA
  const rgba = ([r, g, b, a]) => new Uint8Array([b, g, r, a]);

  // stored brick indices from components on the bricks
  const componentBricks = {};

  const buff = concat(
    // Write magic bytes
    MAGIC,
    write.u16(version),

    version >= 8 ? write.i32(save.gameVersion || 0) : EMPTY_ARR,

    // Header 1
    write.compressed(
      write.string(get(save, 'map', 'Unknown')),
      write.string(get(save, 'author.name', 'Unknown')),
      write.string(get(save, 'description', '')),
      write.uuid(get(save, 'author.id', '00000000-0000-0000-0000-000000000000')),
      version >= 8 ? concat(
        write.string(get(save ,'host.name', 'Unknown')),
        write.uuid(get(save, 'host.id', '00000000-0000-0000-0000-000000000000')),
      ) : EMPTY_ARR,
      get(save, 'save_time', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])),
      write.i32(get(save, 'bricks', EMPTY_ARR).length),
    ),


    // Header 2
    write.compressed(
      write.array(get(save, 'mods', EMPTY_ARR), write.string),
      write.array(get(save, 'brick_assets', ['PB_DefaultBrick']), write.string),
      write.array(get(save, 'colors', EMPTY_ARR), rgba),
      write.array(get(save, 'materials', ['BMC_Plastic']), write.string),
      write.array(get(save, 'brick_owners', [{}]), ({ id='00000000-0000-0000-0000-000000000000', name='Unknown', bricks=0 }={}) => concat(
        write.uuid(id),
        write.string(name),
        version >= 8 ? write.i32(bricks) : EMPTY_ARR,
      )),
    ),

    // write the save preview if it exists
    version >= 8
      ? concat(
          new Uint8Array([save.preview ? 1 : 0]),
          save.preview ? write.i32(get(save, 'preview.length', 0)) : EMPTY_ARR, // <- Sorry @Uxie https://i.imgur.com/hSRxdbf.png
          get(save, 'preview', EMPTY_ARR),
        )
      : EMPTY_ARR,

    // Bricks
    write.compressed(write.bits()
      .each(save.bricks, function(brick, i) {
        this.align();
        this.int(get(brick, 'asset_name_index', 0), Math.max(get(save, 'brick_assets', EMPTY_ARR).length, 2));

        const isSingularity = isEqual(brick.size, [0, 0, 0]);
        this.bit(!isSingularity);
        if (!isSingularity) {
          brick.size.map(s => this.uint_packed(s));
        }
        brick.position.map(s => this.int_packed(s));
        const orientation = (get(brick, 'direction', 4) << 2) | get(brick, 'rotation', 0);
        this.int(orientation, 24);
        this.bit(get(brick, 'collision', true));
        this.bit(get(brick, 'visibility', true));
        if (version >= 8) {
          this.int(brick.material_index, Math.max(save.materials.length, 2))
        } else {
          this.bit(brick.material_index !== 1);
          if (brick.material_index !== 1) {
            this.uint_packed(brick.material_index);
          }
        }

        if (typeof brick.color === 'number') {
          this.bit(false);
          this.int(brick.color, Math.max(get(save, 'colors', EMPTY_ARR).length, 2));
        } else {
          this.bit(true);
          this.bytes(rgba(get(brick, 'color', [255, 255, 255, 255])));
        }

        this.uint_packed(get(brick, 'owner_index', 1));

        if (version >= 8) {
          // add all the brick indices to the components list
          for (const key in brick.components) {
            componentBricks[key] = componentBricks[key] || [];
            componentBricks[key].push(i);
          }
        }
      })
      .finish()
    ),

    // write components section
    version >= 8 ? write.compressed(write.array(Object.keys(get(save, 'components', {})), name => concat(
      write.string(name),
      write.bits()
        .self(function() {
          const component = save.components[name];
          const brick_indices = componentBricks[name];
          const properties = Object.entries(component.properties);

          // write version
          this.bytes(write.i32(component.version));

          // write bricks;
          this.array(brick_indices, i => {
            this.int(i, Math.max(save.bricks.length, 2))
          });

          // write properties
          this.array(properties, ([name, type]) => {
            this.string(name);
            this.string(type);
          });

          // read brick indices
          for (const i of brick_indices) {
            for (const [prop, type] of properties) {
              this.unreal(type, get(save, `bricks.${i}.components.${name}.${prop}`));
            }
          };
          this.align();
        })
        .finishSection(),
    ))) : EMPTY_ARR,
  );
  return buff;
}