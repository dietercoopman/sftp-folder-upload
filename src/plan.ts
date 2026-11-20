// Compares the scanned local files with the server, and runs the upload.
//
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as path from 'path';
import { RemoteEntry, Uploader } from './remote';
import { depth, LocalFile, ScanResult } from './scan';

const posix = path.posix;

/** Remote listing per local folder (relative to the context); undefined when the folder does not exist there. */
export type Listings = Map<string, RemoteEntry[] | undefined>;

export function parentRel(rel: string): string | undefined {
  if (rel === '') return undefined;
  const parent = posix.dirname(rel);
  return parent === '.' ? '' : parent;
}

/** Runs fn over items, at most `size` at a time. Stops at the first error, or when isCancelled returns true. */
export async function runPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
  isCancelled: () => boolean = () => false
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && !isCancelled() && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/** Lists the remote counterpart of every local folder, level by level, skipping folders known to be missing. */
export async function inspectRemote(
  uploader: Uploader,
  dirs: string[],
  remoteOf: (rel: string) => string,
  isCancelled: () => boolean
): Promise<Listings> {
  const listings: Listings = new Map();
  const levels = new Map<number, string[]>();
  for (const d of dirs) {
    const level = depth(d);
    levels.set(level, [...(levels.get(level) ?? []), d]);
  }
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const toList: string[] = [];
    for (const d of levels.get(level)!) {
      const parent = parentRel(d);
      if (parent !== undefined && listings.has(parent)) {
        const parentEntries = listings.get(parent);
        const self = parentEntries?.find((e) => e.name === posix.basename(d));
        if (!self || self.type !== 'dir') {
          listings.set(d, undefined); // the parent is missing, or does not contain this folder
          continue;
        }
      }
      toList.push(d);
    }
    await runPool(
      toList,
      uploader.concurrency * 2,
      async (d) => {
        listings.set(d, await uploader.list(remoteOf(d)));
      },
      isCancelled
    );
    if (isCancelled()) break;
  }
  return listings;
}

/**
 * A file is uploaded when it is missing on the server, differs in size, or is newer than the server's copy.
 * After an upload the server's modification time is set to the local one, so an unchanged file compares equal.
 */
export function needsUpload(file: LocalFile, remote: RemoteEntry | undefined): boolean {
  if (!remote || remote.type !== 'file') return true;
  if (remote.size !== file.size) return true;
  if (!remote.mtime) return true;
  return Math.floor(file.mtimeMs / 1000) > Math.floor(remote.mtime / 1000);
}

export interface Plan {
  /** Files that are new or changed compared to the server. */
  changed: LocalFile[];
  /** Folders (relative to the context) that do not exist on the server yet, shallowest first. */
  missingDirs: string[];
}

export function buildPlan(result: ScanResult, listings: Listings): Plan {
  const changed = result.files.filter((f) => {
    const dir = parentRel(f.rel) ?? '';
    const entry = listings.get(dir)?.find((e) => e.name === posix.basename(f.rel));
    return needsUpload(f, entry);
  });
  const missingDirs = result.dirs.filter((d) => listings.has(d) && listings.get(d) === undefined);
  return { changed, missingDirs };
}

/** Creates the missing folders level by level; a folder whose parent is not part of the upload gets its parents too. */
export async function createDirs(
  uploader: Uploader,
  missingDirs: string[],
  allDirs: Set<string>,
  remoteOf: (rel: string) => string,
  isCancelled: () => boolean,
  onCreated: (rel: string) => void
): Promise<void> {
  const levels = new Map<number, string[]>();
  for (const d of missingDirs) {
    const level = depth(d);
    levels.set(level, [...(levels.get(level) ?? []), d]);
  }
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    await runPool(
      levels.get(level)!,
      uploader.concurrency,
      async (d) => {
        const parent = parentRel(d);
        if (parent !== undefined && allDirs.has(parent)) await uploader.mkdir(remoteOf(d));
        else await uploader.ensureDir(remoteOf(d));
        onCreated(d);
      },
      isCancelled
    );
    if (isCancelled()) return;
  }
}
