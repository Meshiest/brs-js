// Container-agnostic filesystem seam consumed by WorldReader. Mirrors the
// reference reader trait: path lookups return the file's content id plus the
// created_at timestamp of the revision that wrote it (always 0 for .brz,
// which holds exactly one revision).
export interface FoundFile {
  contentId: number;
  createdAt: number;
}

export interface WorldFs {
  findFileByPath(path: string): FoundFile | null;
  /** The file revision whose [created_at, deleted_at) interval contains
   * date. For single-revision containers this is findFileByPath. */
  findFileByPathAtRevision(path: string, date: number): FoundFile | null;
  /** Decompressed blob content. */
  readBlob(contentId: number): Uint8Array;
  readFile(path: string): Uint8Array;
  /** Names of the subfolders of a folder path ('' = root). */
  childFolders(path: string): string[];
}
