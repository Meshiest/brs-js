import { MAGIC, LATEST_VERSION, MAX_INT } from './constants';
import isEqual from 'lodash/isEqual';
import { write } from './utils';

export default function writeBrs(save) {

  if(save.bricks.length > MAX_INT) {
    throw new Error('Brick count out of range');
  }

  const buff = [].concat(
    // Write magic bytes
    MAGIC,
    write.u16(LATEST_VERSION),

    // Header 1
    write.compressed(
      write.string(save.map),
      write.string(save.author.name),
      write.string(save.description),
      write.uuid(save.author.id),
      save.save_time,
      write.i32(save.bricks.length),
    ),

    // Header 2
    write.compressed(
      write.array(save.mods, write.string),
      write.array(save.brick_assets, write.string),
      write.array(save.colors, d => d),
      write.array(save.materials, write.string),
      write.array(save.brick_owners, ({ id, name }) => [].concat(
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