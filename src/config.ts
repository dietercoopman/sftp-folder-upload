// Reads the servers from .vscode/sftp.json (the format of Git SFTP Upload, SFTP Remote Editor and the SFTP
// extension by Natizyskunk / liximomo). Every config entry, and every profile of an entry, becomes one server.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as tls from 'tls';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { log } from './util';

export interface SftpConfig {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string | boolean;
  privateKeyPath?: string;
  passphrase?: string | boolean;
  agent?: string;
  remotePath?: string;
  context?: string;
  connectTimeout?: number;
  /** Patterns in gitignore syntax, relative to the context, that are never uploaded. */
  ignore?: string[];
  /** FTP only: true = explicit FTPS (default), "implicit" = implicit FTPS, false = unencrypted FTP. */
  secure?: boolean | 'implicit' | 'control';
  /** FTP only: TLS options such as rejectUnauthorized, passed to Node's tls.connect. */
  secureOptions?: tls.ConnectionOptions;
  profiles?: Record<string, Partial<SftpConfig>>;
  defaultProfile?: string;
}

export interface ServerConfig {
  label: string;
  /** user@host plus protocol, shown next to the label. */
  detail: string;
  /** The profile this server comes from, if any. */
  profile?: string;
  /** True for the entry's "defaultProfile", which is offered first. */
  isDefault: boolean;
  folder: vscode.WorkspaceFolder;
  configPath: string;
  /** Local directory that corresponds to remotePath (the entry's "context"). */
  contextPath: string;
  remotePath: string;
  protocol: 'sftp' | 'ftp';
  ignore: string[];
  settings: SftpConfig;
  /** Serialized connection settings, used as the key for passwords typed in this session. */
  fingerprint: string;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function configPathFor(folder: vscode.WorkspaceFolder): string | undefined {
  const rel = vscode.workspace
    .getConfiguration('sftpFolderUpload', folder.uri)
    .get<string>('configFile', '.vscode/sftp.json');
  const cfgPath = path.resolve(folder.uri.fsPath, rel);
  // The config file must live inside the workspace folder; never read arbitrary files on disk.
  return isInside(folder.uri.fsPath, cfgPath) ? cfgPath : undefined;
}

/** Warnings are written once per config file per session, not on every upload. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(`WARNING: ${message}`);
}

/** All servers of one workspace folder. Throws when its sftp.json is missing or invalid. */
export async function loadServers(folder: vscode.WorkspaceFolder): Promise<ServerConfig[]> {
  const cfgPath = configPathFor(folder);
  if (!cfgPath) throw new Error(`sftpFolderUpload.configFile must point inside the workspace folder "${folder.name}"`);
  const display = vscode.workspace.asRelativePath(cfgPath);
  if (!fs.existsSync(cfgPath)) throw new Error(`No ${display} found in "${folder.name}"`);

  const errors: ParseError[] = [];
  const raw = parseJsonc(await fs.promises.readFile(cfgPath, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`${display}: invalid JSON: ${printParseErrorCode(errors[0].error)} (position ${errors[0].offset})`);
  }

  const servers: ServerConfig[] = [];
  const entries = (Array.isArray(raw) ? raw : [raw]) as SftpConfig[];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const profiles = entry.profiles ?? {};
    const variants: { profile?: string; settings: SftpConfig }[] = Object.keys(profiles).map((p) => ({
      profile: p,
      settings: { ...entry, ...profiles[p] },
    }));
    if (!variants.length || entry.host) variants.unshift({ settings: { ...entry } });

    for (const { profile, settings } of variants) {
      const name = (settings.name ?? settings.host ?? `config ${index + 1}`) + (profile ? ` (${profile})` : '');
      const protocol = settings.protocol ?? 'sftp';
      let problem: string | undefined;
      if (protocol !== 'sftp' && protocol !== 'ftp') problem = `protocol "${protocol}" is not supported, only sftp and ftp`;
      else if (!settings.host) problem = 'no "host" set';
      else if (!settings.remotePath) problem = 'no "remotePath" set';
      if (problem) {
        warnOnce(`${cfgPath}#${index}#${profile}#problem`, `${display} (${name}): ${problem}`);
        continue;
      }

      if (protocol === 'ftp' && settings.secure === false) {
        warnOnce(
          `${cfgPath}#${index}#plain`,
          `${display} (${name}) uses unencrypted FTP ("secure": false). The password and all file contents are sent in plaintext.`
        );
      } else if (protocol === 'ftp' && settings.secureOptions?.rejectUnauthorized === false) {
        warnOnce(`${cfgPath}#${index}#tls`, `${display} (${name}) disables TLS certificate verification ("rejectUnauthorized": false).`);
      }
      if (typeof settings.password === 'string' || typeof settings.passphrase === 'string') {
        warnOnce(
          `${cfgPath}#${index}#pw`,
          `${display} contains a plaintext password or passphrase. Use "password": true to be prompted instead, and keep this file out of version control.`
        );
      }

      const detail =
        `${settings.username ? settings.username + '@' : ''}${settings.host}` +
        (protocol === 'ftp' ? (settings.secure === false ? ' · ftp' : ' · ftps') : ' · sftp');
      const { profiles: _p, defaultProfile: _d, ignore: _i, ...connection } = settings;
      servers.push({
        label: name,
        detail,
        profile,
        isDefault: !!profile && profile === entry.defaultProfile,
        folder,
        configPath: cfgPath,
        contextPath: path.resolve(folder.uri.fsPath, entry.context ?? '.'),
        remotePath: path.posix.normalize(settings.remotePath!),
        protocol: protocol as 'sftp' | 'ftp',
        ignore: Array.isArray(settings.ignore) ? settings.ignore.filter((p) => typeof p === 'string') : [],
        settings,
        fingerprint: JSON.stringify(connection),
      });
    }
  });
  if (!servers.length) throw new Error(`${display} contains no usable server (see the log)`);
  return servers;
}
