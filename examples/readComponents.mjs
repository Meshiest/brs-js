// Print every brick component instance in a world.
// Usage: node examples/readComponents.mjs <world.brz|world.brdb>
import { openWorld } from './openWorld.mjs';

const { reader, db } = await openWorld(
  process.argv[2],
  'node examples/readComponents.mjs <world.brz|world.brdb>'
);

for (const gridId of reader.gridIds()) {
  for (const ref of reader.brickChunkIndex(gridId)) {
    if (ref.numComponents === 0) continue;
    const { index } = ref;
    console.log(`grid ${gridId} chunk ${index.x},${index.y},${index.z}:`);
    for (const c of reader.componentChunk(gridId, index).components) {
      console.log(`  brick ${c.brickIndex}: ${c.typeName}`);
      if (c.data)
        for (const [k, v] of Object.entries(c.data))
          console.log(`    ${k}:`, v);
    }
  }
}
db?.close();
