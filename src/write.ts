import { DEFAULT_UUID, LATEST_VERSION, MAGIC, MAX_INT } from './constants';
import {
  Brick,
  DefinedComponents,
  KnownComponents,
  Owner,
  WriteOptions,
  WriteSaveObject,
} from './types';
import { concat, isEqual, write } from './utils';

const EMPTY_ARR = new Uint8Array([]);

export const DEFAULT_COMPONENTS: DefinedComponents = {
  BCD_SpotLight: {
    version: 1,
    properties: {
      Rotation: 'Rotator',
      InnerConeAngle: 'Float',
      OuterConeAngle: 'Float',
      Brightness: 'Float',
      Radius: 'Float',
      Color: 'Color',
      bUseBrickColor: 'Boolean',
      bCastShadows: 'Boolean',
    },
  },
  BCD_PointLight: {
    version: 1,
    properties: {
      bMatchBrickShape: 'Boolean',
      Brightness: 'Float',
      Radius: 'Float',
      Color: 'Color',
      bUseBrickColor: 'Boolean',
      bCastShadows: 'Boolean',
    },
  },
  BCD_ItemSpawn: {
    version: 1,
    properties: {
      PickupClass: 'Class',
      bPickupEnabled: 'Boolean',
      bPickupRespawnOnMinigameReset: 'Boolean',
      PickupMinigameResetRespawnDelay: 'Float',
      bPickupAutoDisableOnPickup: 'Boolean',
      PickupRespawnTime: 'Float',
      PickupOffsetDirection: 'Byte',
      PickupOffsetDistance: 'Float',
      PickupRotation: 'Rotator',
      PickupScale: 'Float',
      bPickupAnimationEnabled: 'Boolean',
      PickupAnimationAxis: 'Byte',
      bPickupAnimationAxisLocal: 'Boolean',
      PickupSpinSpeed: 'Float',
      PickupBobSpeed: 'Float',
      PickupBobHeight: 'Float',
      PickupAnimationPhase: 'Float',
    },
  },
  BCD_Interact: {
    version: 1,
    properties: {
      bPlayInteractSound: 'Boolean',
      Message: 'String',
      ConsoleTag: 'String',
    },
  },
  BCD_AudioEmitter: {
    version: 1,
    properties: {
      AudioDescriptor: 'Object',
      VolumeMultiplier: 'Float',
      PitchMultiplier: 'Float',
      InnerRadius: 'Float',
      MaxDistance: 'Float',
      bSpatialization: 'Boolean',
    },
  },
};

export default function writeBrs(
  save: WriteSaveObject,
  options: WriteOptions = {}
) {
  if (typeof save !== 'object') {
    throw new Error('Expected save to be an object');
  }

  if (!Array.isArray(save.bricks) || save.bricks.length === 0) {
    throw new Error('Expected save to have bricks field');
  }

  if (save.bricks.length > MAX_INT) {
    throw new Error('Brick count out of range');
  }

  // compression is disabled by default
  const compress = options.compress ? write.compressed : write.uncompressed;

  // Convert from BGRA to RGBA
  const rgba = ([r, g, b, a]: number[]) => new Uint8Array([b, g, r, a]);

  // stored brick indices from components on the bricks
  const componentBrickOwnership: { [component_name: string]: number[] } = {};

  const numColors = Math.max(save.colors?.length ?? 0, 2);
  const numAssets = Math.max(save.brick_assets?.length ?? 0, 2);
  const numMats = Math.max(save.materials?.length ?? 0, 2);
  const numPhysMats = Math.max(save.physical_materials?.length ?? 0, 2);

  if (save.preview && !Array.isArray(save.preview))
    throw new Error('Expected preview to be an array');

  const buff = concat(
    // Write magic bytes
    MAGIC,
    write.u16(LATEST_VERSION),
    write.i32(save.game_version ?? 0),

    // Header 1
    compress(
      write.string(save.map ?? 'Unknown'),
      write.string(save.author?.name ?? 'Unknown'),
      write.string(save.description ?? ''),
      write.uuid(save.author?.id ?? DEFAULT_UUID),
      concat(
        write.string(save.host?.name ?? 'Unknown'),
        write.uuid(save.host?.id ?? DEFAULT_UUID)
      ),
      new Uint8Array(
        save.save_time &&
        (Array.isArray(save.save_time) ||
          save.save_time instanceof Uint8Array) &&
        save.save_time.length === 8
          ? save.save_time
          : [0, 0, 0, 0, 0, 0, 0, 0]
      ),
      write.i32(save.bricks.length)
    ),

    // Header 2
    compress(
      write.array(save.mods ?? [], write.string),
      write.array(save.brick_assets ?? ['PB_DefaultBrick'], write.string),
      write.array(save.colors ?? [], rgba),
      write.array(save.materials ?? ['BMC_Plastic'], write.string),
      write.array(
        save.brick_owners ?? [],
        ({ id = DEFAULT_UUID, name = 'Unknown', bricks = 0 }: Partial<Owner>) =>
          concat(write.uuid(id), write.string(name), write.i32(bricks))
      ),
      write.array(save.physical_materials ?? ['BPMC_Default'], write.string)
    ),

    // write the save preview if it exists
    concat(
      new Uint8Array([save.preview ? 1 : 0]),
      save.preview ? write.i32(save.preview.length) : EMPTY_ARR, // <- Sorry @Uxie https://i.imgur.com/hSRxdbf.png
      save.preview ?? EMPTY_ARR
    ),

    // Bricks
    compress(
      write
        .bits()
        .each(save.bricks, function (brick: Brick, i) {
          if (typeof brick !== 'object')
            throw new Error(`Expected save.bricks[${i}] to be an object`);

          if (!Array.isArray(brick.size) || brick.size.length !== 3)
            throw new Error(
              `Expected save.bricks[${i}].size to be an array of length 3`
            );

          if (!Array.isArray(brick.position) || brick.position.length !== 3)
            throw new Error(
              `Expected save.bricks[${i}].position to be an array of length 3`
            );

          this.align();
          this.int(brick.asset_name_index ?? 0, numAssets);

          const isNonProcedural = isEqual(brick.size, [0, 0, 0]);
          this.bit(!isNonProcedural);
          if (!isNonProcedural) {
            brick.size.map(s => this.uint_packed(s));
          }
          brick.position.map(s => this.int_packed(s));
          this.int(((brick.direction ?? 4) << 2) | (brick.rotation ?? 0), 24);

          if (typeof brick.collision === 'boolean') {
            this.bit(brick.collision);
            this.bit(brick.collision);
            this.bit(brick.collision);
            this.bit(true);
          } else {
            this.bit(brick.collision?.player ?? true);
            this.bit(brick.collision?.weapon ?? true);
            this.bit(brick.collision?.interaction ?? true);
            this.bit(brick.collision?.tool ?? true);
          }

          this.bit(brick?.visibility ?? true);
          this.int(brick?.material_index ?? 0, numMats);
          this.int(brick.physical_index ?? 0, numPhysMats);
          this.int(brick.material_intensity ?? 5, 11);

          if (typeof brick.color === 'number') {
            this.bit(false);
            this.int(brick.color, numColors);
          } else {
            this.bit(true);
            if (
              brick.color &&
              (!Array.isArray(brick.color) || brick.color.length < 3)
            )
              throw new Error(
                `Expected save.bricks[${i}].color to be an array of at least length 3`
              );
            this.bytes(
              new Uint8Array(brick.color?.slice(0, 3) ?? [255, 255, 255])
            );
          }

          this.uint_packed(brick.owner_index ?? 1);

          // add all the brick indices to the components list
          for (const key in brick.components ?? {}) {
            componentBrickOwnership[key] ??= [];
            componentBrickOwnership[key].push(i);
          }
        })
        .finish()
    ),

    // write components section
    compress(
      write.array(
        Object.keys(save.components ?? DEFAULT_COMPONENTS).filter(
          name => componentBrickOwnership[name]
        ),
        name =>
          concat(
            write.string(name),
            write
              .bits()
              .self(function () {
                const component =
                  save.components?.[name] ?? DEFAULT_COMPONENTS[name];
                const brick_indices = componentBrickOwnership[name];
                const properties = Object.entries(component.properties);

                // write version
                this.bytes(write.i32(component.version));

                // write bricks;
                this.array(brick_indices, i => {
                  this.int(i, Math.max(save.bricks.length, 2));
                });

                // write properties
                this.array(properties, ([name, type]) => {
                  this.string(name);
                  this.string(type);
                });

                // read brick indices
                for (const i of brick_indices) {
                  for (const [prop, type] of properties) {
                    if (!(prop in (save.bricks[i].components?.[name] ?? {}))) {
                      throw new Error(
                        `Expected save.bricks[${i}].components[${name}] to have property '${prop}' of type '${type}'`
                      );
                    }
                    this.unreal(type, save.bricks[i].components[name][prop]);
                  }
                }
                this.align();
              })
              .finishSection()
          )
      )
    )
  );
  return buff;
}
