// Build a microchip PREFAB with the World builder: an outer chip shell
// brick linked to an inner grid holding two wired ports, with
// Meta/Prefab.json bounds so it pastes like a native copied selection.
// Build the library first: just build
import { writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const { World, WorldReader, brdb } = lib;

const CHIP_IN = brdb.COMPONENTS.MicrochipInput;
const CHIP_OUT = brdb.COMPONENTS.MicrochipOutput;

const w = new World();

// Outer shell on the main grid + the linked inner grid entity.
const { grid } = w.addMicrochip({ position: [0, 0, 2] });

// Chip contents live in the inner grid (positions are grid-local).
const input = w.addBrick(
  {
    asset: CHIP_IN.BRICK,
    position: [0, 0, 2],
    color: [255, 0, 0],
    components: [{ type: CHIP_IN.NAME, data: { PortLabel: 'In' } }],
  },
  grid
);
const output = w.addBrick(
  {
    asset: CHIP_OUT.BRICK,
    position: [20, 0, 2],
    color: [0, 255, 0],
    components: [{ type: CHIP_OUT.NAME, data: { PortLabel: 'Out' } }],
  },
  grid
);

// Pass the chip's input port straight through to its output port.
w.addWire(
  { brick: input, component_type: CHIP_IN.NAME, port: CHIP_IN.PORTS.RER_Output },
  { brick: output, component_type: CHIP_OUT.NAME, port: CHIP_OUT.PORTS.RER_Input }
);

// Prefab metadata: pivots/bounds from the main-grid bricks (the shell).
w.makePrefab({ isMicrochipPrefab: true });

const bytes = w.toBrz({ bundle: { description: 'Microchip example' } });
writeFileSync('example_microchip.brz', bytes);
console.log(`example_microchip.brz written (${bytes.length} bytes)`);

// Read it back.
const reader = WorldReader.from(bytes);
console.log('grids:', reader.gridIds());
for (const e of reader.entities())
  console.log(
    `entity ${e.typeName} (persistent ${e.persistentIndex})`,
    e.data ?? ''
  );
const { soa } = reader.componentChunk(1, { x: 0, y: 0, z: 0 });
console.log(
  'shell brick',
  soa.MicrochipBrickIndices[0],
  'links to grid',
  soa.MicrochipBrickGridReferences[0]
);
for (const gridId of reader.gridIds())
  for (const ref of reader.brickChunkIndex(gridId)) {
    if (ref.numWires === 0) continue;
    for (const wire of reader.wireChunk(gridId, ref.index).local)
      console.log(
        `grid ${gridId} wire: ${wire.source.componentType}.${wire.source.port}`,
        `feeds ${wire.target.componentType}.${wire.target.port}`
      );
  }
