// Count the wires in a world, per chunk and in total.
// Usage: node examples/countWires.mjs <world.brz|world.brdb>
import { openWorld } from './openWorld.mjs';

const { reader, db } = await openWorld(
  process.argv[2],
  'node examples/countWires.mjs <world.brz|world.brdb>'
);

let total = 0;
for (const gridId of reader.gridIds()) {
  for (const ref of reader.brickChunkIndex(gridId)) {
    if (ref.numWires === 0) continue;
    const { index } = ref;
    console.log(
      `grid ${gridId} chunk ${index.x},${index.y},${index.z}: ${ref.numWires} wires`
    );
    total += ref.numWires;
  }
}
console.log(`total wires: ${total}`);
db?.close();
