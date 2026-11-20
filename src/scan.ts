// Walks the selected local files and folders and lists what to upload. Symbolic links to files and folders
// are followed (like PhpStorm's deployment), and their contents are uploaded at the place of the link in the
// project, not at the place of the link target. A link that points back into one of its own parent folders
// is skipped instead of looping forever.
//
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';

export interface LocalFile {
  /** Path relative to the context, with forward slashes. */
  rel: string;
  /** Absolute local path (through the link, so reading it follows the link). */
  local: string;
  size: number;
  mtimeMs: number;
}

export interface FollowedLink {
  rel: string;
  /** Resolved absolute target. */
  target: string;
  isDir: boolean;
}

export interface ScanResult {
  files: LocalFile[];
  /** Folders to exist on the server, relative to the context ("" is the context itself). */
  dirs: string[];
  links: FollowedLink[];
  ignored: number;
  /** Human readable reasons for entries that were left out (broken links, loops, special files). */
  skipped: string[];
}

export interface ScanOptions {
  contextPath: string;
  /** Patterns in gitignore syntax, relative to the context. */
  ignore: string[];
  followSymlinks: boolean;
  /** Checked between entries; when it returns true the scan stops with a CancelledScan error. */
  isCancelled?: () => boolean;
}

export class CancelledScan extends Error {
  constructor() {
    super('Cancelled');
  }
}

function toRel(contextPath: string, absolute: string): string {
  return path.relative(contextPath, absolute).split(path.sep).join('/');
}

export async function scan(roots: string[], opts: ScanOptions): Promise<ScanResult> {
  const ig = ignore().add(opts.ignore);
  const files = new Map<string, LocalFile>();
  const dirs = new Set<string>();
  const links = new Map<string, FollowedLink>();
  const skipped: string[] = [];
  let ignored = 0;
  /** Real paths of the folders on the current walk path, to detect link loops. */
  const ancestors = new Set<string>();

  const isIgnored = (rel: string, isDir: boolean) => rel !== '' && ig.ignores(isDir ? `${rel}/` : rel);

  const addFile = (rel: string, local: string, st: fs.Stats) => {
    files.set(rel, { rel, local, size: st.size, mtimeMs: st.mtimeMs });
  };

  async function walk(absolute: string, rel: string): Promise<void> {
    if (opts.isCancelled?.()) throw new CancelledScan();
    const real = await fs.promises.realpath(absolute);
    if (ancestors.has(real)) {
      skipped.push(`${rel || '.'}: link loop (points back to one of its parent folders)`);
      return;
    }
    ancestors.add(real);
    try {
      dirs.add(rel);
      const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const childAbs = path.join(absolute, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        await visit(childAbs, childRel, entry.isSymbolicLink(), false);
      }
    } finally {
      ancestors.delete(real);
    }
  }

  /** explicit: selected by the user, so the ignore list does not apply to it. */
  async function visit(absolute: string, rel: string, isLink: boolean, explicit: boolean): Promise<void> {
    if (isLink && !opts.followSymlinks) {
      skipped.push(`${rel}: symbolic link (following links is turned off)`);
      return;
    }
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(absolute);
    } catch {
      skipped.push(`${rel}: ${isLink ? 'broken symbolic link' : 'cannot be read'}`);
      return;
    }
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) {
      skipped.push(`${rel}: not a regular file`);
      return;
    }
    if (!explicit && isIgnored(rel, isDir)) {
      ignored++;
      return;
    }
    if (isLink) {
      const target = await fs.promises.realpath(absolute);
      if (isDir && ancestors.has(target)) {
        skipped.push(`${rel}: link loop (points back to one of its parent folders)`);
        return;
      }
      links.set(rel, { rel, target, isDir });
    }
    if (isDir) await walk(absolute, rel);
    else addFile(rel, absolute, st);
  }

  for (const root of roots) {
    const rel = toRel(opts.contextPath, root);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${root} is outside the sftp.json context`);
    const lst = await fs.promises.lstat(root);
    await visit(root, rel, lst.isSymbolicLink(), true);
  }

  // Make sure the folder of every file is known, also for files selected on their own.
  for (const f of files.values()) {
    const dir = path.posix.dirname(f.rel);
    dirs.add(dir === '.' ? '' : dir);
  }

  return {
    files: [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)),
    dirs: [...dirs].sort(byDepth),
    links: [...links.values()],
    ignored,
    skipped,
  };
}

export function depth(rel: string): number {
  return rel === '' ? 0 : rel.split('/').length;
}

export function byDepth(a: string, b: string): number {
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
}
