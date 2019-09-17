# brs.js

Read ~~and write~~ Brickadia save files (.brs)

Currently supports save versions <= 4

**Warning:** __Unreal Engine uses numbers potentially larger than Javascript can handle.__

## Install

`npm install brs-js`

## Documentation and Usage

Node:

    const brs = require('brs-js');

ES6:

    import brs from 'brs-js';

### Save Object

The Save Object is the input and output of this program. It represents the decoded/decompressed contents of the save.
Strings can be UCS-2 or UTF-8. UUIDs follow the spec. The `save_time` field is 8 bytes (Little Endian) instead of a long.
Unsigned ints, while unlikely, may overflow.

```javascript
{
  version: short,
  map: string,
  author: {id: uuid, name: string},
  save_time: UTC as 8 bytes,
  brick_count: int,
  mods: string array,
  brick_assets: [string],
  colors: [[byte, byte, byte, byte], ... ],
  materials: [string],
  brick_owners: [{id: uuid, name: string}, ... ],
  bricks: [{
    asset_name_index: int,
    size: [uint, uint, uint],
    position: [int, int, int],
    direction: 0-5,
      // 0: X Positive
      // 1: X Negative
      // 2: Y Positive
      // 3: Y Negative
      // 4: Z Positive
      // 5: Z Negative
    rotation: 0-3,
      // 0: 0 Deg
      // 1: 90 Deg
      // 2: 180 Deg
      // 3: 270 Deg
    collision: bool,
    visibility: bool,
    material_index: uint,
    color: uint or [byte, byte, byte, byte],
    owner_index: uint,
  }, ... ],
}
```

### Function `brs.read(buffer)`

**Returns**: Save Object

In node, the buffer can be obtained from `fs.readFile` without an encoding specified. In web, the buffer can be obtained via `File.arrayBuffer()`. Be sure to resolve promises where necessary.

| parameter   | type                | description              |
|-------------|---------------------|--------------------------|
| `buffer`    | Uint8Array / Buffer | Input bytes to be parsed |

### Function `brs.write(saveObj)`

**Returns**: Byte Array

In node, the buffer can be saved with from `fs.writeFile(fileName, buffer)`. In web, the buffer can be making a `new Blob([buffer])`, and can be downloaded with an `<a download>` with `href` as `URL.createObjectURL(blob)`.

| parameter   | type        | description                            |
|-------------|-------------|----------------------------------------|
| `saveObj`   | Save Object | Save Object to be turned into a buffer |

