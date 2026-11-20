// The "ignore" lists of sftp.json: which local paths are never uploaded, and adding or removing a path.
//
// A path is ignored for a config entry when it matches the given extra patterns or the entry's
// "ignore" list (gitignore syntax, relative to the entry's "context"). A profile with its own "ignore" list
// replaces the entry's list for that profile, the way the settings are merged everywhere else.
// Edits go through jsonc-parser, so comments and formatting in sftp.json are kept.
//
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as path from 'path';
import ignore, { Ignore } from 'ignore';
import { applyEdits, FormattingOptions, JSONPath, modify, parse as parseJsonc, ParseError } from 'jsonc-parser';

export interface IgnoreList {
  /** Location of the list in sftp.json, e.g. [0, "ignore"] or ["profiles", "staging", "ignore"]. */
  jsonPath: JSONPath;
  patterns: string[];
  /** Server name (and profile) the list belongs to, for messages. */
  label: string;
}

export interface ConfigEntry {
  contextPath: string;
  /** The entry's own list first, then the lists of profiles that have their own. */
  lists: IgnoreList[];
}

export interface IgnoreMatch {
  pattern: string;
  /** "setting" for sftpFolderUpload.alwaysIgnore, otherwise the list in sftp.json. */
  source: 'setting' | 'sftp.json';
  list?: IgnoreList;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
}

/** Reads the config entries of an sftp.json text; throws on invalid JSON. */
export function parseEntries(text: string, folderPath: string): ConfigEntry[] {
  const errors: ParseError[] = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('sftp.json contains invalid JSON');
  const isArray = Array.isArray(raw);
  const items: unknown[] = isArray ? raw : [raw];
  const entries: ConfigEntry[] = [];
  items.forEach((item, index) => {
    if (!isObject(item)) return;
    const base: JSONPath = isArray ? [index] : [];
    const name = String(item.name ?? item.host ?? `config ${index + 1}`);
    const lists: IgnoreList[] = [{ jsonPath: [...base, 'ignore'], patterns: stringList(item.ignore), label: name }];
    if (isObject(item.profiles)) {
      for (const [profile, settings] of Object.entries(item.profiles)) {
        if (isObject(settings) && Array.isArray(settings.ignore)) {
          lists.push({
            jsonPath: [...base, 'profiles', profile, 'ignore'],
            patterns: stringList(settings.ignore),
            label: `${name} (${profile})`,
          });
        }
      }
    }
    entries.push({ contextPath: path.resolve(folderPath, typeof item.context === 'string' ? item.context : '.'), lists });
  });
  return entries;
}

/** Path relative to the context with forward slashes, or undefined when outside it (or the context itself). */
export function relativeTo(contextPath: string, fsPath: string): string | undefined {
  const rel = path.relative(contextPath, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

const matchers = new Map<string, Ignore>();

function matcher(patterns: string[]): Ignore {
  const key = JSON.stringify(patterns);
  let m = matchers.get(key);
  if (!m) {
    m = ignore().add(patterns);
    if (matchers.size > 500) matchers.clear();
    matchers.set(key, m);
  }
  return m;
}

function ignores(patterns: string[], rel: string, isDir: boolean): boolean {
  return patterns.length > 0 && matcher(patterns).ignores(isDir ? `${rel}/` : rel);
}

/** The pattern that excludes the path, or undefined when it may be uploaded to at least one server. */
export function matchPath(entries: ConfigEntry[], alwaysIgnore: string[], fsPath: string, isDir: boolean): IgnoreMatch | undefined {
  for (const entry of entries) {
    const rel = relativeTo(entry.contextPath, fsPath);
    if (rel === undefined) continue;
    for (const list of entry.lists) {
      if (!ignores([...alwaysIgnore, ...list.patterns], rel, isDir)) continue;
      // Name the rule: a pattern of this list on its own, else one of the settings.
      const own = list.patterns.find((p) => !p.startsWith('!') && ignores([p], rel, isDir));
      if (own) return { pattern: own, source: 'sftp.json', list };
      const setting = alwaysIgnore.find((p) => !p.startsWith('!') && ignores([p], rel, isDir));
      return { pattern: setting ?? alwaysIgnore.join(', '), source: 'setting' };
    }
  }
  return undefined;
}

/** The entries whose context contains the path. */
export function entriesFor(entries: ConfigEntry[], fsPath: string): ConfigEntry[] {
  return entries.filter((e) => relativeTo(e.contextPath, fsPath) !== undefined);
}

/** Indentation and line endings as used in the file, so an edit blends in. */
export function formattingOf(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 4, eol } : { insertSpaces: true, tabSize: indent.length, eol };
}

/** The anchored pattern for one path: "/.env" for a file, "/wp-content/cache/" for a folder. */
export function patternFor(rel: string, isDir: boolean): string {
  return `/${rel}${isDir ? '/' : ''}`;
}

function setList(text: string, list: IgnoreList, patterns: string[]): string {
  return applyEdits(text, modify(text, list.jsonPath, patterns, { formattingOptions: formattingOf(text) }));
}

/** Adds the path to the "ignore" list of every server whose context contains it. */
export function addPath(text: string, folderPath: string, fsPath: string, isDir: boolean): { text: string; added: string[] } {
  const added: string[] = [];
  for (const entry of entriesFor(parseEntries(text, folderPath), fsPath)) {
    const pattern = patternFor(relativeTo(entry.contextPath, fsPath)!, isDir);
    for (const list of entry.lists) {
      if (list.patterns.includes(pattern)) continue;
      text = setList(text, list, [...list.patterns, pattern]);
      added.push(`${pattern} → ${list.label}`);
    }
  }
  return { text, added };
}

/** Removes the entries for exactly this path (not wider patterns such as *.log) from every "ignore" list. */
export function removePath(text: string, folderPath: string, fsPath: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  for (const entry of entriesFor(parseEntries(text, folderPath), fsPath)) {
    const rel = relativeTo(entry.contextPath, fsPath)!;
    const exact = new Set([`/${rel}`, `/${rel}/`]);
    // A plain name at the top of the context ("wp-config.php") was most likely meant for that file.
    if (!rel.includes('/')) exact.add(rel).add(`${rel}/`);
    for (const list of entry.lists) {
      const keep = list.patterns.filter((p) => !exact.has(p));
      if (keep.length === list.patterns.length) continue;
      list.patterns.filter((p) => exact.has(p)).forEach((p) => removed.push(`${p} → ${list.label}`));
      text = setList(text, list, keep);
    }
  }
  return { text, removed };
}
