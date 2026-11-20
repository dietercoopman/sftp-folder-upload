// The remote operations the uploader needs, over SFTP or FTP(S).
//
// SFTP goes through ssh2's raw SFTP channel, which handles many requests at once, so several files can be
// uploaded in parallel over one connection. Files are written without chmod (ssh2-sftp-client's put() would
// make every file 0666), and afterwards their modification time is set to the local one, so the next upload
// can tell which files really changed.
//
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import SftpClient from 'ssh2-sftp-client';
import { Client as FtpClient, FileInfo, FileType, FTPError } from 'basic-ftp';

const posix = path.posix;

export type EntryType = 'file' | 'dir' | 'other';

export interface RemoteEntry {
  name: string;
  /** For a link, the type of its target. */
  type: EntryType;
  size: number;
  /** Modification time in milliseconds since the epoch; 0 when unknown. */
  mtime: number;
}

export interface Uploader {
  readonly protocol: 'sftp' | 'ftp';
  /** Number of operations that may run at the same time. */
  readonly concurrency: number;
  /** True once the connection has been closed, by us or by the server. */
  readonly closed: boolean;
  /** Set once when the server refuses to set modification times; uploads still work. */
  readonly timeWarning: string | undefined;
  /** Entries of a directory, or undefined when it does not exist. */
  list(dir: string): Promise<RemoteEntry[] | undefined>;
  /** Creates a directory whose parent exists; an existing directory is fine. */
  mkdir(dir: string): Promise<void>;
  /** Creates a directory and any missing parents. */
  ensureDir(dir: string): Promise<void>;
  /** Uploads a local file, keeping the permissions of an existing remote file, and sets its modification time. */
  upload(localPath: string, remotePath: string, mtimeMs: number): Promise<void>;
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

interface SftpAttrs {
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

type Cb<T = void> = (err: (Error & { code?: unknown }) | undefined | null, result: T) => void;

/** The part of ssh2's SFTP channel used here. */
interface RawSftp {
  readdir(location: string, cb: Cb<{ filename: string; attrs: SftpAttrs }[]>): void;
  stat(location: string, cb: Cb<SftpAttrs>): void;
  mkdir(location: string, cb: Cb): void;
  utimes(location: string, atime: number, mtime: number, cb: Cb): void;
  open(location: string, flags: string, attrs: object, cb: Cb<Buffer>): void;
  write(handle: Buffer, data: Buffer, offset: number, length: number, position: number, cb: Cb): void;
  close(handle: Buffer, cb: Cb): void;
}

/** SFTP status code for "no such file" (draft-ietf-secsh-filexfer). */
const SFTP_NO_SUCH_FILE = 2;

function call<T>(fn: (cb: Cb<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))));
}

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === SFTP_NO_SUCH_FILE || code === 'ENOENT' || /no such file/i.test(String((e as Error)?.message));
}

function sftpType(a: SftpAttrs): EntryType {
  return a.isDirectory() ? 'dir' : a.isFile() ? 'file' : 'other';
}

const CHUNK = 32 * 1024;
/** Write requests in flight per file, so large files are not slowed down by one round trip per chunk. */
const PARALLEL_CHUNKS = 8;

async function putWithoutChmod(sftp: RawSftp, localPath: string, remotePath: string): Promise<void> {
  const file = await fs.promises.open(localPath, 'r');
  try {
    // Opening without attributes truncates an existing file and keeps its owner and mode, and gives a
    // new file the server's default permissions (umask).
    const handle = await call<Buffer>((cb) => sftp.open(remotePath, 'w', {}, cb));
    try {
      const inFlight = new Set<Promise<void>>();
      let position = 0;
      for (;;) {
        const buffer = Buffer.alloc(CHUNK);
        const { bytesRead } = await file.read(buffer, 0, CHUNK, position);
        if (bytesRead === 0) break;
        const offset = position;
        position += bytesRead;
        const request = call<void>((cb) => sftp.write(handle, buffer, 0, bytesRead, offset, cb));
        request.catch(() => undefined); // handled through race/all below
        inFlight.add(request);
        void request.finally(() => inFlight.delete(request)).catch(() => undefined);
        if (inFlight.size >= PARALLEL_CHUNKS) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
    } finally {
      await call<void>((cb) => sftp.close(handle, cb));
    }
  } finally {
    await file.close();
  }
}

export class SftpUploader implements Uploader {
  readonly protocol = 'sftp';
  timeWarning: string | undefined;
  private isClosed = false;

  constructor(private readonly client: SftpClient, readonly concurrency: number) {
    const markClosed = () => {
      this.isClosed = true;
    };
    client.on('close', markClosed);
    client.on('end', markClosed);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private get sftp(): RawSftp {
    const sftp = (this.client as unknown as { sftp?: RawSftp }).sftp;
    if (!sftp || this.isClosed) throw new Error('The SFTP connection was closed');
    return sftp;
  }

  async list(dir: string): Promise<RemoteEntry[] | undefined> {
    let items: { filename: string; attrs: SftpAttrs }[];
    try {
      items = await call((cb) => this.sftp.readdir(dir, cb));
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
    const entries: RemoteEntry[] = [];
    for (const { filename, attrs } of items) {
      if (filename === '.' || filename === '..') continue;
      let a = attrs;
      if (attrs.isSymbolicLink()) {
        try {
          a = await call((cb) => this.sftp.stat(posix.join(dir, filename), cb));
        } catch {
          entries.push({ name: filename, type: 'other', size: 0, mtime: 0 }); // broken link
          continue;
        }
      }
      entries.push({ name: filename, type: sftpType(a), size: a.size, mtime: a.mtime * 1000 });
    }
    return entries;
  }

  async mkdir(dir: string): Promise<void> {
    try {
      await call<void>((cb) => this.sftp.mkdir(dir, cb));
    } catch (e) {
      // Created in the meantime, or it existed already.
      const st = await call<SftpAttrs>((cb) => this.sftp.stat(dir, cb)).catch(() => undefined);
      if (!st?.isDirectory()) throw e;
    }
  }

  async ensureDir(dir: string): Promise<void> {
    const parts = posix.normalize(dir).split('/').filter(Boolean);
    let current = dir.startsWith('/') ? '/' : '.';
    for (const part of parts) {
      current = posix.join(current, part);
      const st = await call<SftpAttrs>((cb) => this.sftp.stat(current, cb)).catch((e) => {
        if (isNotFound(e)) return undefined;
        throw e;
      });
      if (!st) await this.mkdir(current);
      else if (!st.isDirectory()) throw new Error(`${current} exists on the server but is not a folder`);
    }
  }

  async upload(localPath: string, remotePath: string, mtimeMs: number): Promise<void> {
    await putWithoutChmod(this.sftp, localPath, remotePath);
    const seconds = Math.floor(mtimeMs / 1000);
    try {
      await call<void>((cb) => this.sftp.utimes(remotePath, seconds, seconds, cb));
    } catch (e) {
      this.timeWarning ??=
        `The server did not allow setting the modification time (${(e as Error).message}). ` +
        `Changed files are then detected by size and by being newer than the copy on the server.`;
    }
  }

  async end(): Promise<void> {
    this.isClosed = true;
    await this.client.end().catch(() => undefined);
  }
}

/** Connects with the given options (which carry the host key verifier). */
export async function connectSftp(options: SftpClient.ConnectOptions, concurrency: number): Promise<SftpUploader> {
  const client = new SftpClient();
  try {
    await client.connect(options);
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
  return new SftpUploader(client, concurrency);
}

// ---------------------------------------------------------------------------
// FTP / FTPS
// ---------------------------------------------------------------------------

/** "YYYYMMDDHHMMSS" in UTC, as used by the MFMT command. */
function ftpTimestamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export class FtpUploader implements Uploader {
  readonly protocol = 'ftp';
  /** FTP runs one command at a time on a connection. */
  readonly concurrency = 1;
  timeWarning: string | undefined;
  private isEnded = false;
  private canSetTime = true;

  constructor(private readonly client: FtpClient) {}

  get closed(): boolean {
    return this.isEnded || this.client.closed;
  }

  private async isDir(dir: string): Promise<boolean> {
    try {
      await this.client.cd(dir);
      return true;
    } catch (e) {
      if (e instanceof FTPError) return false;
      throw e;
    }
  }

  private async toEntry(dir: string, info: FileInfo): Promise<RemoteEntry> {
    const mtime = info.modifiedAt?.getTime() ?? 0;
    if (info.type === FileType.SymbolicLink) {
      // FTP cannot stat a link target; a link that can be entered is a folder.
      const isDir = await this.isDir(posix.join(dir, info.name));
      return { name: info.name, type: isDir ? 'dir' : 'file', size: info.size, mtime };
    }
    const type: EntryType = info.type === FileType.Directory ? 'dir' : info.type === FileType.File ? 'file' : 'other';
    return { name: info.name, type, size: info.size, mtime };
  }

  async list(dir: string): Promise<RemoteEntry[] | undefined> {
    let infos: FileInfo[];
    try {
      infos = await this.client.list(dir);
    } catch (e) {
      if (e instanceof FTPError && (e.code === 550 || e.code === 450)) return undefined;
      throw e;
    }
    // Some servers answer an empty listing for a folder that does not exist.
    if (!infos.length && !(await this.isDir(dir))) return undefined;
    const entries: RemoteEntry[] = [];
    for (const info of infos) {
      if (info.name === '.' || info.name === '..') continue;
      entries.push(await this.toEntry(dir, info));
    }
    return entries;
  }

  async mkdir(dir: string): Promise<void> {
    await this.ensureDir(dir);
  }

  async ensureDir(dir: string): Promise<void> {
    await this.client.ensureDir(dir);
  }

  async upload(localPath: string, remotePath: string, mtimeMs: number): Promise<void> {
    // Absolute remote paths, so the working directory ensureDir leaves behind does not matter.
    await this.client.uploadFrom(localPath, remotePath);
    if (!this.canSetTime) return;
    try {
      await this.client.send(`MFMT ${ftpTimestamp(mtimeMs)} ${remotePath}`);
    } catch (e) {
      if (!(e instanceof FTPError)) throw e;
      this.canSetTime = false;
      this.timeWarning =
        `The FTP server does not support setting the modification time (MFMT: ${e.message.trim()}). ` +
        `Changed files are then detected by size and by being newer than the copy on the server.`;
    }
  }

  async end(): Promise<void> {
    this.isEnded = true;
    this.client.close();
  }
}

export interface FtpConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean | 'implicit';
  secureOptions?: tls.ConnectionOptions;
  timeout: number;
}

export async function connectFtp(o: FtpConnectOptions): Promise<FtpUploader> {
  const client = new FtpClient(o.timeout);
  try {
    await client.access({
      host: o.host,
      port: o.port,
      user: o.user,
      password: o.password,
      secure: o.secure,
      secureOptions: o.secureOptions,
    });
  } catch (e) {
    client.close();
    throw e;
  }
  return new FtpUploader(client);
}
