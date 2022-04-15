import { getBrickSize, getScaleAxis } from './helper';
import { Brick, Vector } from './types';

const CHUNK_SIZE = 1024;
const RIGHT = 1;
const BACK = 2;
const BOTTOM = 4;

// a point in space
export class Point {
  x: number;
  y: number;
  z: number;

  static fromVector(vec: Vector) {
    return new Point(...vec);
  }

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static rect(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number
  ): [Point, Point] {
    return [
      new Point(x - w / 2, y - h / 2, z - h / 2),
      new Point(x + w / 2, y + h / 2, z + h / 2),
    ];
  }

  // get a chunk from a point
  getChunk() {
    return new Point(
      Math.floor(this.x / CHUNK_SIZE),
      Math.floor(this.y / CHUNK_SIZE),
      Math.floor(this.z / CHUNK_SIZE)
    );
  }

  // returns true if this point is between the other two
  in(min: Point, max: Point): boolean {
    return (
      min.x <= this.x &&
      this.x <= max.x &&
      min.y <= this.y &&
      this.y <= max.y &&
      min.z <= this.z &&
      this.z <= max.z
    );
  }

  // get the octant the point should be in for a node
  getOctant(point: Point): number {
    return (
      (point.x >= this.x ? RIGHT : 0) |
      (point.y >= this.y ? BACK : 0) |
      (point.z >= this.z ? BOTTOM : 0)
    );
  }

  // get the middle of a chunk
  getChunkMidpoint(): Point {
    return new Point(
      this.x * CHUNK_SIZE + CHUNK_SIZE / 2,
      this.y * CHUNK_SIZE + CHUNK_SIZE / 2,
      this.z * CHUNK_SIZE + CHUNK_SIZE / 2
    );
  }

  // compare points
  eq(point: Point): boolean {
    return this.x == point.x && this.y == point.y && this.z == point.z;
  }

  // return a copy of this point shifted
  shifted(x: number, y: number, z: number): Point {
    return new Point(this.x + x, this.y + y, this.z + z);
  }

  // stringified points are <x, y, z>
  toString(): string {
    return `<${this.x}, ${this.y}, ${this.z}>`;
  }
}

// a node in the tree
export class Node<T> {
  point: Point;
  depth: number;
  value: T;
  nodes: Node<T>[];
  half: number;
  chunk?: Point;

  constructor(point: Point, depth: number, value: T) {
    this.point = point;
    this.depth = depth;
    this.value = value;
    this.nodes = [];
    this.half = Math.pow(2, this.depth - 1);
  }

  // determine if provided bounds perfectly completely cover this node
  wouldFillNode(min: Point, max: Point) {
    const size = 1 << this.depth;
    return (
      max.x - min.x == size && max.y - min.y == size && max.z - min.z == size
    );
  }

  // true if this node is contained by the bounds
  isInside(min: Point, max: Point) {
    // check if this bounds are entirely within
    return (
      this.point.x - this.half >= min.x &&
      this.point.x + this.half <= max.x &&
      this.point.y - this.half >= min.y &&
      this.point.y + this.half <= max.y &&
      this.point.z - this.half >= min.z &&
      this.point.z + this.half <= max.z
    );
  }

  isOutside(min: Point, max: Point) {
    return (
      this.point.x + this.half <= min.x ||
      this.point.x - this.half >= max.x ||
      this.point.y + this.half <= min.y ||
      this.point.y - this.half >= max.y ||
      this.point.z + this.half <= min.z ||
      this.point.z - this.half >= max.z
    );
  }

  // if every child node has the same value, delete them
  reduce() {
    if (this.nodes.length === 0) return;

    let ok = true;

    // reduce all the nodes to values
    // check if the other 7 nodes have the same value as the first one
    for (let i = 0; i < 8; i++) {
      // attempt to reduce this node
      this.nodes[i].reduce();
      if (
        this.nodes[0].value !== this.nodes[i].value ||
        this.nodes[i].nodes.length > 0
      ) {
        ok = false;
      }
    }

    if (ok) {
      // delete the old nodes
      this.value = this.nodes[0].value;
      this.nodes = [];
    }
  }

  // insert an area into the tree
  insert(value: T, minBound: Point, maxBound: Point) {
    if (this.isInside(minBound, maxBound)) {
      this.value = value;
      return;
    }

    if (this.depth === 0) return;

    // populate nodes if it's empty
    if (this.nodes.length === 0) {
      // decrease depth
      const childDepth = this.depth - 1;
      // the shift is half of the child's size
      const childShift = this.half / 2;
      // create new nodes in each 8 child octants of this node
      this.nodes = [
        new Node(
          this.point.shifted(-childShift, -childShift, -childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(childShift, -childShift, -childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(-childShift, childShift, -childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(childShift, childShift, -childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(-childShift, -childShift, childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(childShift, -childShift, childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(-childShift, childShift, childShift),
          childDepth,
          this.value
        ),
        new Node(
          this.point.shifted(childShift, childShift, childShift),
          childDepth,
          this.value
        ),
      ];
    }

    for (const n of this.nodes) {
      if (!n.isOutside(minBound, maxBound)) n.insert(value, minBound, maxBound);
    }
  }

  // search an area
  search(minBound: Point, maxBound: Point, set: Set<T>) {
    if (!set) set = new Set();
    // if there's no nodes...
    if (this.nodes.length === 0) {
      // add this value, this node would only have come up if it was within bounds
      set.add(this.value);
      return;
    }

    // search children
    // // const halfSize = Math.pow(2, this.depth - 2);
    for (const n of this.nodes) {
      // if the bounds are not outside of this node, search
      if (!n.isOutside(minBound, maxBound)) {
        n.search(minBound, maxBound, set);
      }
    }
  }

  // get the value at this point
  get(point: Point): T {
    if (this.nodes.length === 0) return this.value;
    return this.nodes[this.point.getOctant(point)].get(point);
  }
}

export class ChunkTree<T> {
  chunks: Node<T>[];
  fill: T;

  constructor(fill: T = undefined) {
    this.chunks = [];
    // empty nodes have this value
    this.fill = fill;
  }

  // reduce all chunks
  reduce() {
    for (const chunk of this.chunks) {
      chunk.reduce();
    }
  }

  // iterate across chunks with bounds and run the fn with those bounds
  iterChunksFromBounds(
    minBound: Point,
    maxBound: Point,
    fn: (min: Point, max: Point) => void
  ) {
    // if the boundaries are in different chunks, split the area up by chunk
    const minChunk = minBound.getChunk();
    const maxChunk = maxBound.shifted(-1, -1, -1).getChunk();
    if (
      minChunk.x > maxChunk.x ||
      minChunk.y > maxChunk.y ||
      minChunk.z > maxChunk.z
    )
      throw 'max chunk too small';

    if (!minChunk.eq(maxChunk)) {
      /*// insert in all chunks that overlap
      for (let x = minChunk.x; x <= maxChunk.x; ++x) {
        for (let y = minChunk.y; y <= maxChunk.y; ++y) {
          for (let z = minChunk.z; z <= maxChunk.z; ++z) {
            fn(minBound, maxBound);
          }
        }
      }*/
      for (let x = minChunk.x; x <= maxChunk.x; ++x) {
        // determine the min and max bounds for this chunk
        // these should always be within the same chunk
        // and should cap out at the max bound's position
        const minX = x === minChunk.x ? minBound.x : x * CHUNK_SIZE;
        const maxX = Math.min(
          Math.floor(minX / CHUNK_SIZE + 1) * CHUNK_SIZE,
          maxBound.x
        );

        for (let y = minChunk.y; y <= maxChunk.y; ++y) {
          // same thing as above but for y
          const minY = y === minChunk.y ? minBound.y : y * CHUNK_SIZE;
          const maxY = Math.min(
            Math.floor(minY / CHUNK_SIZE + 1) * CHUNK_SIZE,
            maxBound.y
          );

          for (let z = minChunk.z; z <= maxChunk.z; ++z) {
            // same thing as above but for z
            const minZ = z === minChunk.z ? minBound.z : z * CHUNK_SIZE;
            const maxZ = Math.min(
              Math.floor(minZ / CHUNK_SIZE + 1) * CHUNK_SIZE,
              maxBound.z
            );

            // run the fn on the new single-chunk bounds
            fn(new Point(minX, minY, minZ), new Point(maxX, maxY, maxZ));
          }
        }
      }
      return;
    } // otherwise the boundaries are in the same chunk so it's okay to run the function

    fn(minBound, maxBound);
  }

  // get a chunk at a point
  getChunkAt(point: Point, create = false) {
    const chunkPos = point.getChunk();

    // find the the corresponding chunk octtree
    let chunk = this.chunks.find(c => c.chunk.eq(chunkPos));
    if (!chunk && create) {
      // create a new chunk because one does not exist
      chunk = new Node(chunkPos.getChunkMidpoint(), 10, this.fill);
      chunk.chunk = chunkPos;
      this.chunks.push(chunk);
    }

    return chunk;
  }

  // search all values in an area
  search(minBound: Point, maxBound: Point) {
    // the set of all result values
    const results = new Set<T>();

    // run the following code in the chunks covered by these boundaries:
    this.iterChunksFromBounds(minBound, maxBound, (min, max) => {
      const chunk = this.getChunkAt(min);
      if (chunk) {
        // search the chunk if it exists
        chunk.search(min, max, results);
      }
    });

    // remove the empty item1
    results.delete(this.fill);

    return results;
  }

  // get the value at a point
  get(point: Point) {
    const chunk = this.getChunkAt(point);
    if (chunk) {
      // search the chunk if it exists
      return chunk.get(point);
    } else {
      return this.fill;
    }
  }

  // insert an area into chunks
  insert(value: T, minBound: Point, maxBound: Point) {
    // run the following code in the chunks covered by these boundaries:
    this.iterChunksFromBounds(minBound, maxBound, (min, max) => {
      // insert the value into the oct tree
      this.getChunkAt(min, true).insert(value, min, max);
    });
  }
}

export class SaveOctree {
  brick_assets: string[];
  bricks: Brick[];
  tree: ChunkTree<number>;

  constructor(bricks: Brick[], brick_assets: string[]) {
    this.brick_assets = brick_assets;
    this.bricks = bricks;
    this.tree = new ChunkTree(-1);

    for (let i = 0; i < this.bricks.length; i++) {
      const brick = this.bricks[i];
      // get normalized sizes for every brick
      const normal_size = getBrickSize(brick as Brick, this.brick_assets);
      const size = [
        normal_size[getScaleAxis(brick as Brick, 0)],
        normal_size[getScaleAxis(brick as Brick, 1)],
        normal_size[getScaleAxis(brick as Brick, 2)],
      ];

      // build boundaries from the normalized size
      const bounds = {
        min: new Point(
          brick.position[0] - size[0],
          brick.position[1] - size[1],
          brick.position[2] - size[2]
        ),
        max: new Point(
          brick.position[0] + size[0],
          brick.position[1] + size[1],
          brick.position[2] + size[2]
        ),
      };
      // const normal_size = size;

      // add it into the tree
      this.tree.insert(i, bounds.min, bounds.max);
    }

    this.tree.reduce();
  }

  get(vec: Vector): Brick | null {
    return this.bricks[this.tree.get(Point.fromVector(vec))] ?? null;
  }

  search(min: Vector, max: Vector): Brick[] {
    return Array.from(
      this.tree.search(Point.fromVector(min), Point.fromVector(max))
    ).map(i => this.bricks[i]);
  }
}
