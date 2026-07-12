// Write an Array Variable gate preloaded with strings to
// example_arrayvar.brz, then read the component back. Variant-typed fields
// like ArrayVar's Value take a { $variant, value } wrapper naming which
// union member holds the payload (here WireGraphStringArray).
// Build the library first: just build
import { writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const { WorldReader, writeBrzLegacy, brdb } = lib;

// COMPONENTS carries each component's type name (NAME), host brick asset
// (BRICK), and wire port names (PORTS). The ArrayVar component only
// functions on its gate brick, and basic (non-procedural) assets need no
// size.
const ARRAY_VAR = brdb.COMPONENTS.ArrayVar;

const save = {
  brick_assets: [ARRAY_VAR.BRICK],
  bricks: [
    {
      asset_name_index: 0,
      position: [0, 0, 2],
      color: [255, 255, 0],
      components: [
        {
          type: ARRAY_VAR.NAME,
          data: {
            Value: {
              $variant: 'WireGraphStringArray',
              value: { Values: ['hello', 'world', 'from', 'brs-js'] },
            },
          },
        },
      ],
    },
  ],
};

const bytes = writeBrzLegacy(save, {
  bundle: { description: 'String array variable example' },
});
writeFileSync('example_arrayvar.brz', bytes);
console.log(`example_arrayvar.brz written (${bytes.length} bytes)`);

const reader = WorldReader.from(bytes);
for (const ref of reader.brickChunkIndex()) {
  for (const c of reader.componentChunk(1, ref.index).components) {
    const { $variant, value } = c.data.Value;
    console.log(`brick ${c.brickIndex} ${c.typeName} holds ${$variant}:`);
    console.log(' ', value.Values);
  }
}
