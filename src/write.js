import { MAGIC, LATEST_VERSION, MAX_INT } from './constants';
import { write, isEqual } from './utils';

// TODO: Validate input saves
function validate(save) {
  if (typeof save !== 'object')
    throw new Error('Expected save to be an object');
}

// looks up a value in an object or returns a defualt value
function get(obj, path='', def) {
  // Split the path up by .
  path = path.split('.').filter(p => p);

  // Get the child at each part of the path
  while (path.length && typeof obj === 'object') {
    obj = obj[path.splice(0, 1)[0]];
  }

  return obj || def;
}

export default function writeBrs(save) {
  validate(save);

  if(save.bricks.length > MAX_INT) {
    throw new Error('Brick count out of range');
  }

  const buff = [].concat(
    // Write magic bytes
    MAGIC,
    write.u16(LATEST_VERSION),

    // Header 1
    write.compressed(
      write.string(get(save, 'map', 'Unknown')),
      write.string(get(save, 'author.name', 'Unknown')),
      write.string(get(save, 'description', '')),
      write.uuid(get(save, 'author.id', '00000000-0000-0000-0000-000000000000')),
      get(save, 'save_time', [0, 0, 0, 0, 0, 0, 0, 0]),
      write.i32(get(save, 'bricks', []).length),
    ),


    // Header 2
    write.compressed(
      write.array(get(save, 'mods', []), write.string),
      write.array(get(save, 'brick_assets', []), write.string),
      write.array(get(save, 'colors', []), d => d),
      write.array(get(save, 'materials', ['BMC_Plastic']), write.string),
      write.array(get(save, 'brick_owners', []), ({ id='00000000-0000-0000-0000-000000000000', name='Unknown' }={}) => [].concat(
        write.uuid(id),
        write.string(name),
      )),
    ),

    // Bricks
    write.compressed(write.bits()
      .each(save.bricks, function(brick) {
        this.align();
        this.int(brick.asset_name_index, Math.max(save.brick_assets.length, 2));

        const isSingularity = isEqual(brick.size, [0, 0, 0])
        this.bit(!isSingularity);
        if (!isSingularity) {
          brick.size.map(s => this.uint_packed(s));
        }
        brick.position.map(s => this.int_packed(s));
        const orientation = (brick.direction << 2) | brick.rotation;
        this.int(orientation, 24);
        this.bit(brick.collision);
        this.bit(brick.visibility);
        this.bit(brick.material_index != 1);
        if (brick.material_index != 1) {
          this.int_packed(brick.material_index);
        }

        if (typeof brick.color === 'number') {
          this.bit(false);
          this.int(brick.color, save.colors.length);
        } else {
          this.bit(true);
          this.bytes(brick.color);
        }
        this.int_packed(brick.owner_index);
      })
      .finish()
    ),
  );

  return buff;
}