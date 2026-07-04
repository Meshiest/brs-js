// Write a brick carrying a point light component to example_component.brz,
// then read the component back. Component data fields not listed here are
// zero-filled; unknown field names throw at write time.
// Build the library first: just build
import { existsSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/dist.mjs', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/dist.mjs not found; run `just build` first');
  process.exit(1);
}
const { WorldReader, writeBrzLegacy } = await import(dist.href);

const save = {
  bricks: [
    {
      size: [5, 5, 6],
      position: [0, 0, 6],
      color: [255, 255, 255],
      components: [
        {
          type: 'Component_PointLight',
          data: {
            bEnabled: true,
            Brightness: 500,
            Radius: 800,
            bUseBrickColor: false,
          },
        },
      ],
    },
  ],
};

const bytes = writeBrzLegacy(save, {
  bundle: { description: 'Component example' },
});
writeFileSync('example_component.brz', bytes);
console.log(`example_component.brz written (${bytes.length} bytes)`);

const reader = WorldReader.from(bytes);
for (const ref of reader.brickChunkIndex()) {
  for (const c of reader.componentChunk(1, ref.index).components)
    console.log(`brick ${c.brickIndex} has ${c.typeName}:`, c.data);
}
