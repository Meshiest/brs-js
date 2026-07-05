// Write two microchip-port bricks connected by a wire to example_wire.brz,
// then read the wire back.
// Build the library first: just build
import { writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const { WorldReader, writeBrzLegacy, brdb } = lib;

// COMPONENTS carries each component's type name (NAME), host brick asset
// (BRICK), and wire port names (PORTS). Port components only function on
// their matching gate brick assets, and basic (non-procedural) assets need
// no size.
const CHIP_IN = brdb.COMPONENTS.MicrochipInput;
const CHIP_OUT = brdb.COMPONENTS.MicrochipOutput;

const save = {
  brick_assets: [CHIP_IN.BRICK, CHIP_OUT.BRICK],
  bricks: [
    {
      asset_name_index: 0,
      position: [0, 0, 2],
      color: [255, 0, 0],
      components: [{ type: CHIP_IN.NAME, data: { PortLabel: 'In' } }],
    },
    {
      asset_name_index: 1,
      position: [20, 0, 2],
      color: [0, 255, 0],
      components: [{ type: CHIP_OUT.NAME, data: { PortLabel: 'Out' } }],
    },
  ],
  wires: [
    {
      source: {
        brick_index: 0,
        component_type: CHIP_IN.NAME,
        port: CHIP_IN.PORTS.RER_Output,
      },
      target: {
        brick_index: 1,
        component_type: CHIP_OUT.NAME,
        port: CHIP_OUT.PORTS.RER_Input,
      },
    },
  ],
};

const bytes = writeBrzLegacy(save, { bundle: { description: 'Wire example' } });
writeFileSync('example_wire.brz', bytes);
console.log(`example_wire.brz written (${bytes.length} bytes)`);

const reader = WorldReader.from(bytes);
for (const ref of reader.brickChunkIndex()) {
  if (ref.numWires === 0) continue;
  const wires = reader.wireChunk(1, ref.index);
  for (const w of wires.local)
    console.log(
      `wire: brick ${w.source.brickIndex} ${w.source.componentType}.${w.source.port}`,
      `feeds brick ${w.target.brickIndex} ${w.target.componentType}.${w.target.port}`
    );
}
