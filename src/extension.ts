import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isInside, loadServers, ServerConfig } from './config';
import { connect } from './connect';
import { forgetTrustedHostKeys, initHostKeys } from './hostKeys';
import { NeverUpload, targetsOf } from './neverUpload';
import { buildPlan, createDirs, inspectRemote, runPool } from './plan';
import { CancelledScan, LocalFile, scan } from './scan';
import { CancelledError, errorMessage, log, output } from './util';

export function activate(context: vscode.ExtensionContext) {
  initHostKeys(context.globalState);
  const neverUpload = new NeverUpload();

  const command = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof CancelledError || e instanceof CancelledScan) return;
        log(`ERROR: ${errorMessage(e)}`);
        const choice = await vscode.window.showErrorMessage(errorMessage(e), 'Show log');
        if (choice) output.show();
      }
    });

  context.subscriptions.push(
    output,
    neverUpload,
    command('sftpFolderUpload.upload', uploadSelection),
    command('sftpFolderUpload.neverUpload', (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
      neverUpload.neverUpload(targetsOf(clicked, selected))
    ),
    command('sftpFolderUpload.allowUpload', (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
      neverUpload.allowUpload(targetsOf(clicked, selected))
    ),
    command('sftpFolderUpload.uploadProject', uploadProject),
    command('sftpFolderUpload.showLog', async () => output.show()),
    vscode.commands.registerCommand('sftpFolderUpload.forgetTrustedHostKeys', forgetTrustedHostKeys)
  );
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Explorer / editor context menu: the clicked item, or every selected item. From the palette: the active file. */
async function uploadSelection(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const targets = targetsOf(clicked, selected);

  const folders = new Set(targets.map((t) => vscode.workspace.getWorkspaceFolder(t)));
  if (folders.has(undefined)) throw new Error('Only files and folders inside the open workspace can be uploaded.');
  if (folders.size > 1) throw new Error('The selection spans several workspace folders; upload them one folder at a time.');
  const folder = [...folders][0]!;

  const servers = await loadServers(folder);
  const candidates = servers.filter((s) => targets.every((t) => isInside(s.contextPath, t.fsPath)));
  if (!candidates.length) {
    throw new Error(`The selection is outside the "context" of every server in ${vscode.workspace.asRelativePath(servers[0].configPath)}.`);
  }
  const server = await pickServer(candidates);
  await runUpload(server, targets.map((t) => t.fsPath));
}

/** Uploads the whole context of a server. */
async function uploadProject(): Promise<void> {
  const servers: ServerConfig[] = [];
  let firstError: unknown;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      servers.push(...(await loadServers(folder)));
    } catch (e) {
      firstError ??= e;
    }
  }
  if (!servers.length) throw firstError ?? new Error('Open a folder with a .vscode/sftp.json first.');
  const server = await pickServer(servers);
  await runUpload(server, [server.contextPath]);
}

async function pickServer(servers: ServerConfig[]): Promise<ServerConfig> {
  if (servers.length === 1) return servers[0];
  const sorted = [...servers].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const picked = await vscode.window.showQuickPick(
    sorted.map((s) => ({
      label: s.label,
      description: s.detail,
      detail: `${s.remotePath}${s.isDefault ? '  ·  default profile' : ''}${multiRoot ? `  ·  ${s.folder.name}` : ''}`,
      server: s,
    })),
    { placeHolder: 'Upload to which server?', ignoreFocusOut: true }
  );
  if (!picked) throw new CancelledError();
  return picked.server;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

async function runUpload(server: ServerConfig, roots: string[]): Promise<void> {
  const settings = vscode.workspace.getConfiguration('sftpFolderUpload', server.folder.uri);
  const followSymlinks = settings.get<boolean>('followSymlinks', true);
  const alwaysIgnore = settings.get<string[]>('alwaysIgnore', []);
  const confirm = settings.get<boolean>('confirm', true);
  const parallel = Math.max(1, Math.min(16, Math.floor(settings.get<number>('parallelUploads', 4))));

  if (!fs.existsSync(server.contextPath)) throw new Error(`The context folder ${server.contextPath} does not exist.`);
  const remoteOf = (rel: string) => (rel ? path.posix.join(server.remotePath, rel) : server.remotePath);
  const relOf = (p: string) => path.relative(server.contextPath, p).split(path.sep).join('/');
  const what = roots.length === 1 ? relOf(roots[0]) || path.basename(server.contextPath) : plural(roots.length, 'item');

  output.appendLine('');
  log(`Upload of ${what} to ${server.label} (${server.detail}:${server.remotePath})`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Upload to ${server.label}`, cancellable: true },
    async (progress, token) => {
      const cancelled = () => token.isCancellationRequested;

      progress.report({ message: 'scanning local files…' });
      const result = await scan(roots, {
        contextPath: server.contextPath,
        ignore: [...alwaysIgnore, ...server.ignore],
        followSymlinks,
        isCancelled: cancelled,
      });
      for (const link of result.links) log(`  follows link  ${link.rel} → ${tilde(link.target)}`);
      for (const s of result.skipped) log(`  skipped       ${s}`);
      log(
        `Found ${plural(result.files.length, 'file')} in ${plural(result.dirs.length, 'folder')}` +
          (result.ignored ? `, ${result.ignored.toLocaleString()} ignored` : '') +
          (result.links.length ? `, through ${plural(result.links.length, 'symbolic link')}` : '')
      );
      if (!result.files.length && !result.dirs.length) {
        vscode.window.showInformationMessage('Nothing to upload: the selection is set to never upload, ignored or skipped (see the log).');
        return;
      }

      progress.report({ message: 'connecting…' });
      const uploader = await connect(server, parallel);
      try {
        progress.report({ message: 'comparing with the server…' });
        const listings = await inspectRemote(uploader, result.dirs, remoteOf, cancelled);
        if (cancelled()) return;
        const plan = buildPlan(result, listings);
        log(
          `${plural(plan.changed.length, 'file')} new or changed on the server` +
            (plan.missingDirs.length ? `, ${plural(plan.missingDirs.length, 'new folder')}` : '')
        );
        for (const f of plan.changed) log(`  changed       ${f.rel}`);

        let files: LocalFile[] = plan.changed;
        if (confirm) {
          const choice = await askConfirmation(server, roots.length === 1 ? remoteOf(relOf(roots[0])) : server.remotePath, result, plan);
          if (choice === undefined) {
            log('Cancelled');
            return;
          }
          if (choice === 'all') files = result.files;
        } else if (!plan.changed.length && !plan.missingDirs.length) {
          vscode.window.showInformationMessage(`Everything is up to date on ${server.label}.`);
          return;
        }

        // Folders first, then the files, several at a time over SFTP.
        const started = Date.now();
        let createdDirs = 0;
        progress.report({ message: plan.missingDirs.length ? 'creating folders…' : undefined });
        await createDirs(uploader, plan.missingDirs, new Set(result.dirs), remoteOf, cancelled, (rel) => {
          createdDirs++;
          log(`  folder        ${remoteOf(rel)}`);
        });

        const failed: string[] = [];
        let done = 0;
        await runPool(
          files,
          uploader.concurrency,
          async (f) => {
            try {
              await uploader.upload(f.local, remoteOf(f.rel), f.mtimeMs);
              log(`  uploaded      ${f.rel}`);
            } catch (e) {
              // A lost connection stops the whole upload; any other error only skips this file.
              if (uploader.closed) throw e;
              failed.push(f.rel);
              log(`  FAILED        ${f.rel}: ${errorMessage(e)}`);
            }
            done++;
            progress.report({ increment: 100 / files.length, message: `${done.toLocaleString()} / ${files.length.toLocaleString()}  ${f.rel}` });
          },
          cancelled
        );

        if (uploader.timeWarning) log(`NOTE: ${uploader.timeWarning}`);
        const uploaded = done - failed.length;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const summary =
          `${cancelled() ? 'Cancelled after uploading' : 'Uploaded'} ${plural(uploaded, 'file')}` +
          (createdDirs ? ` and created ${plural(createdDirs, 'folder')}` : '') +
          ` to ${server.label}`;
        log(`${summary} in ${seconds}s` + (failed.length ? `, ${failed.length} failed` : ''));
        if (failed.length) {
          const choice = await vscode.window.showErrorMessage(`${summary}. ${plural(failed.length, 'file')} failed.`, 'Show log');
          if (choice) output.show();
        } else {
          vscode.window.showInformationMessage(`${summary}.`);
        }
      } finally {
        await uploader.end();
      }
    }
  );
}

async function askConfirmation(
  server: ServerConfig,
  target: string,
  result: Awaited<ReturnType<typeof scan>>,
  plan: ReturnType<typeof buildPlan>
): Promise<'changed' | 'all' | undefined> {
  const total = result.files.length;
  const upToDate = !plan.changed.length && !plan.missingDirs.length;
  const lines: string[] = [`${server.detail}:${target}`, ''];
  lines.push(
    upToDate
      ? `All ${plural(total, 'file')} are up to date on the server.`
      : `${plan.changed.length.toLocaleString()} of ${plural(total, 'file')} are new or changed on the server` +
          (plan.missingDirs.length ? `, ${plural(plan.missingDirs.length, 'folder')} to create.` : '.')
  );
  if (result.ignored) lines.push(`${plural(result.ignored, 'item')} ignored (sftp.json "ignore" and settings).`);
  if (result.skipped.length) lines.push(`${plural(result.skipped.length, 'item')} skipped (see the log).`);
  if (result.links.length) {
    lines.push('', 'Follows symbolic links:');
    for (const link of result.links.slice(0, 8)) lines.push(`  ${link.rel} → ${tilde(link.target)}`);
    if (result.links.length > 8) lines.push(`  …and ${result.links.length - 8} more`);
  }
  lines.push('', 'The full list of files is in the log (Output › SFTP Folder Upload).');

  const changedLabel = plan.changed.length
    ? `Upload ${plural(plan.changed.length, 'changed file')}`
    : `Create ${plural(plan.missingDirs.length, 'folder')}`;
  const allLabel = `Upload all ${plural(total, 'file')}`;
  const buttons = upToDate ? [allLabel] : plan.changed.length === total ? [changedLabel] : [changedLabel, allLabel];

  const choice = await vscode.window.showWarningMessage(
    upToDate ? `Nothing changed. Upload anyway to ${server.label}?` : `Upload to ${server.label}?`,
    { modal: true, detail: lines.join('\n') },
    ...buttons
  );
  if (choice === changedLabel) return 'changed';
  if (choice === allLabel) return 'all';
  return undefined;
}
