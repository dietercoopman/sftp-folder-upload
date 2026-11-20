// Opens a connection to a server from sftp.json: SFTP with host key verification, or FTPS / FTP.
// Same behaviour as SFTP Remote Editor and Git SFTP Upload.
import * as os from 'os';
import * as fs from 'fs';
import SftpClient from 'ssh2-sftp-client';
import { FTPError } from 'basic-ftp';
import { ServerConfig, SftpConfig } from './config';
import { checkHostKey, confirmNewHostKey, HostCheckState } from './hostKeys';
import { connectFtp, connectSftp, Uploader } from './remote';
import { askSecret, CancelledError, errorMessage, log } from './util';

/** FTP reply codes a server gives when it does not understand or refuses "AUTH TLS". */
const TLS_REFUSED_CODES = new Set([500, 502, 504, 534]);

/** Passwords and passphrases typed in this session, so the next upload does not ask again. Never stored on disk. */
const typedSecrets = new Map<string, string>();

async function secret(key: string, prompt: string): Promise<string> {
  const known = typedSecrets.get(key);
  if (known !== undefined) return known;
  const value = await askSecret(prompt);
  typedSecrets.set(key, value);
  return value;
}

function forgetSecrets(server: ServerConfig): void {
  for (const key of [...typedSecrets.keys()]) {
    if (key.startsWith(`${server.fingerprint}#`)) typedSecrets.delete(key);
  }
}

async function sftpOptions(server: ServerConfig): Promise<SftpClient.ConnectOptions> {
  const c: SftpConfig = server.settings;
  const key = (what: string) => `${server.fingerprint}#${what}`;
  const opts: SftpClient.ConnectOptions = {
    host: c.host,
    port: c.port ?? 22,
    username: c.username,
    readyTimeout: c.connectTimeout ?? 20000,
    keepaliveInterval: 30000,
    // No automatic retries: a rejected host key or wrong password must fail immediately.
    retries: 0,
  };

  if (c.privateKeyPath) {
    const keyPath = c.privateKeyPath.replace(/^~(?=$|[\/\\])/, os.homedir());
    opts.privateKey = await fs.promises.readFile(keyPath);
    if (c.passphrase === true) opts.passphrase = await secret(key('passphrase'), `Passphrase for ${keyPath}`);
    else if (typeof c.passphrase === 'string') opts.passphrase = c.passphrase;
  }

  if (c.password === true) opts.password = await secret(key('password'), `Password for ${c.username}@${c.host}`);
  else if (typeof c.password === 'string') opts.password = c.password;

  const agent = c.agent ?? process.env.SSH_AUTH_SOCK;
  if (agent && !opts.privateKey && !opts.password) opts.agent = agent;

  if (!opts.privateKey && !opts.password && !opts.agent) {
    opts.password = await secret(key('password'), `Password for ${c.username}@${c.host}`);
  }
  return opts;
}

/** Connects with host key verification; on an unknown host asks the user once and retries. */
async function openSftp(server: ServerConfig, concurrency: number): Promise<Uploader> {
  const opts = await sftpOptions(server);
  const host = server.settings.host!;
  const port = opts.port ?? 22;
  for (let attempt = 0; ; attempt++) {
    const check: HostCheckState = {};
    opts.hostVerifier = (key: Buffer) => checkHostKey(host, port, key, check);
    try {
      return await connectSftp(opts, concurrency);
    } catch (e) {
      if (check.mismatch) throw new Error(check.mismatch);
      if (check.unknown && attempt === 0) {
        await confirmNewHostKey(check.unknown.pattern, check.unknown.id);
        continue;
      }
      throw e;
    }
  }
}

async function openFtp(server: ServerConfig): Promise<Uploader> {
  const c = server.settings;
  const secure: boolean | 'implicit' = c.secure === false ? false : c.secure === 'implicit' ? 'implicit' : true;
  const user = c.username ?? 'anonymous';
  const password =
    typeof c.password === 'string' ? c.password : await secret(`${server.fingerprint}#password`, `Password for ${user}@${c.host}`);
  try {
    return await connectFtp({
      host: c.host!,
      port: c.port ?? (secure === 'implicit' ? 990 : 21),
      user,
      password,
      secure,
      secureOptions: c.secureOptions,
      timeout: c.connectTimeout ?? 20000,
    });
  } catch (e) {
    if (c.secure === undefined && e instanceof FTPError && TLS_REFUSED_CODES.has(e.code)) {
      throw new Error(
        `${e.message.trim()} — the server does not accept FTPS (explicit TLS). ` +
          `Set "secure": "implicit" for implicit FTPS, or "secure": false to allow unencrypted FTP.`
      );
    }
    throw e;
  }
}

export async function connect(server: ServerConfig, concurrency: number): Promise<Uploader> {
  log(`Connecting to ${server.label} (${server.detail})`);
  try {
    const uploader = server.protocol === 'ftp' ? await openFtp(server) : await openSftp(server, concurrency);
    log(`Connected to ${server.label}`);
    return uploader;
  } catch (e) {
    if (!(e instanceof CancelledError)) {
      log(`Connection to ${server.label} failed: ${errorMessage(e)}`);
      // A wrong password must be asked again next time instead of being reused.
      const authFailed =
        (e instanceof FTPError && e.code === 530) || /authentication|passphrase|decrypt/i.test(errorMessage(e));
      if (authFailed) forgetSecrets(server);
    }
    throw e;
  }
}
