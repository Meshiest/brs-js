// Write two microchip-port bricks connected by a wire to example_wire.brz,
// then read the wire back.
// Build the library first: just build
import { writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const { WorldReader, writeBrzLegacy } = lib;

const CHIP_IN = 'BrickComponentType_Internal_MicrochipInput';

const save = {
  bricks: [
    {
      size: [5, 5, 6],
      position: [0, 0, 6],
      color: [255, 0, 0],
      components: [{ type: CHIP_IN, data: { PortLabel: 'Out' } }],
    },
    {
      size: [5, 5, 6],
      position: [20, 0, 6],
      color: [0, 255, 0],
      components: [{ type: CHIP_IN, data: { PortLabel: 'In' } }],
    },
  ],
  wires: [
    {
      source: { brick_index: 0, component_type: CHIP_IN, port: 'Output' },
      target: { brick_index: 1, component_type: CHIP_IN, port: 'Input' },
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
