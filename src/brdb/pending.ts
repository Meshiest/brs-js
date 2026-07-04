// Pending virtual-filesystem tree: the interchange type between the world
// serializer and the container writers.
// Children are ordered; that order determines archive ids (BFS, Task 4).
export type PendingEntry = [name: string, node: PendingNode];
export type PendingNode =
  | { type: 'folder'; children: PendingEntry[] }
  | { type: 'file'; content: Uint8Array };

export const folder = (children: PendingEntry[]): PendingNode => ({
  type: 'folder',
  children,
});

export const file = (content: Uint8Array): PendingNode => ({
  type: 'file',
  content,
});
