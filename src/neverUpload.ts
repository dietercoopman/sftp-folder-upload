// "Never Upload" / "Allow Upload" in the Explorer, and a badge on every file and folder that is excluded.
//
// The exclusions are the "ignore" lists in sftp.json, so Git SFTP Upload, SFTP Folder Upload and the SFTP
// extension by Natizyskunk all respect them. The setting sftpFolderUpload.alwaysIgnore is not shown here:
// it only applies to this extension, and the badge must not promise more than every tool keeps.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { configPathFor } from './config';
import { addPath, ConfigEntry, entriesFor, IgnoreMatch, matchPath, matchPathAny, parseEntries, removePath } from './ignoreRules';
import { log } from './util';

interface Loaded {
  configPath: string;
  entries: ConfigEntry[];
}

const IGNORED_KEY = 'sftpFolderUpload.neverUploaded';
const HAS_CONFIG_KEY = 'sftpFolderUpload.hasConfig';

async function isDirectory(fsPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(fsPath)).isDirectory();
  } catch {
    return false;
  }
}

export class NeverUpload implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly loaded = new Map<string, Promise<Loaded | undefined>>();
  /**
   * Excluded paths seen by the decorations, published as a context key for the Explorer menu. These are URI paths
   * ("/c:/site/.env" on Windows), because the menu compares them with resourcePath.
   */
  private readonly excluded = new Set<string>();
  private contextTimer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
    const onFile = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && configPathFor(folder) === uri.fsPath) this.refresh();
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sftpFolderUpload')) this.refresh();
      }),
      vscode.window.registerFileDecorationProvider(this)
    );
    void this.updateHasConfig();
  }

  refresh(): void {
    this.loaded.clear();
    this.excluded.clear();
    this.publishExcluded();
    this.emitter.fire(undefined);
    void this.updateHasConfig();
  }

  private async updateHasConfig(): Promise<void> {
    const has = (vscode.workspace.workspaceFolders ?? []).some((f) => {
      const cfg = f.uri.scheme === 'file' ? configPathFor(f) : undefined;
      return !!cfg && fs.existsSync(cfg);
    });
    await vscode.commands.executeCommand('setContext', HAS_CONFIG_KEY, has);
  }

  private load(folder: vscode.WorkspaceFolder): Promise<Loaded | undefined> {
    const key = folder.uri.toString();
    let p = this.loaded.get(key);
    if (!p) {
      p = (async () => {
        const configPath = configPathFor(folder);
        if (!configPath || !fs.existsSync(configPath)) return undefined;
        try {
          return { configPath, entries: parseEntries(await fs.promises.readFile(configPath, 'utf8'), folder.uri.fsPath) };
        } catch {
          return undefined; // invalid JSON; the upload reports it
        }
      })();
      this.loaded.set(key, p);
    }
    return p;
  }

  /** The rule that keeps the path from every server, or with `any`, from at least one server. */
  async match(fsPath: string, isDir: boolean, any = false): Promise<IgnoreMatch | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    const loaded = folder && (await this.load(folder));
    if (!loaded) return undefined;
    return (any ? matchPathAny : matchPath)(loaded.entries, [], fsPath, isDir);
  }

  private publishExcluded(): void {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => {
      void vscode.commands.executeCommand('setContext', IGNORED_KEY, [...this.excluded]);
    }, 50);
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    const m = await this.match(uri.fsPath, await isDirectory(uri.fsPath));
    const had = this.excluded.has(uri.path);
    if (m) this.excluded.add(uri.path);
    else this.excluded.delete(uri.path);
    if (had !== !!m) this.publishExcluded();
    if (!m) return undefined;
    const show = vscode.workspace.getConfiguration('sftpFolderUpload', uri).get<boolean>('showNeverUploadInExplorer', true);
    if (!show) return undefined;
    return new vscode.FileDecoration(
      '⊘',
      `Never uploaded (sftp.json "ignore": ${m.pattern})`,
      new vscode.ThemeColor('gitDecoration.ignoredResourceForeground')
    );
  }

  dispose(): void {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Groups the targets per workspace folder and edits that folder's sftp.json once. */
  private async editConfigs(
    targets: vscode.Uri[],
    edit: (text: string, folder: vscode.WorkspaceFolder, target: vscode.Uri) => Promise<string>
  ): Promise<void> {
    const byFolder = new Map<vscode.WorkspaceFolder, vscode.Uri[]>();
    for (const t of targets) {
      const folder = vscode.workspace.getWorkspaceFolder(t);
      if (!folder) throw new Error(`${t.fsPath} is not inside the open workspace.`);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), t]);
    }
    for (const [folder, uris] of byFolder) {
      const configPath = configPathFor(folder);
      if (!configPath || !fs.existsSync(configPath)) {
        throw new Error(`No ${configPath ? vscode.workspace.asRelativePath(configPath) : 'sftp.json'} in "${folder.name}".`);
      }
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === configPath);
      if (open?.isDirty) throw new Error(`Save ${vscode.workspace.asRelativePath(configPath)} first; it has unsaved changes.`);
      const original = await fs.promises.readFile(configPath, 'utf8');
      let text = original;
      for (const uri of uris) text = await edit(text, folder, uri);
      if (text !== original) await fs.promises.writeFile(configPath, text, 'utf8');
    }
    this.refresh();
  }

  async neverUpload(targets: vscode.Uri[]): Promise<void> {
    const done: string[] = [];
    const notes: string[] = [];
    await this.editConfigs(targets, async (text, folder, uri) => {
      const name = vscode.workspace.asRelativePath(uri);
      const isDir = await isDirectory(uri.fsPath);
      const entries = parseEntries(text, folder.uri.fsPath);
      if (!entriesFor(entries, uri.fsPath).length) {
        notes.push(`${name} is not inside the "context" of a server, or is the context folder itself.`);
        return text;
      }
      const existing = matchPath(entries, [], uri.fsPath, isDir);
      if (existing) {
        notes.push(`${name} is already never uploaded (${existing.pattern}).`);
        return text;
      }
      const result = addPath(text, folder.uri.fsPath, uri.fsPath, isDir);
      if (!result.added.length) return text;
      result.added.forEach((a) => log(`Never upload: ${a}`));
      done.push(path.basename(uri.fsPath) + (isDir ? '/' : ''));
      return result.text;
    });
    if (done.length) {
      vscode.window.showInformationMessage(`${done.join(', ')} will never be uploaded. Added to "ignore" in sftp.json.`);
    }
    if (notes.length) vscode.window.showInformationMessage(notes.join(' '));
  }

  async allowUpload(targets: vscode.Uri[]): Promise<void> {
    const done: string[] = [];
    await this.editConfigs(targets, async (text, folder, uri) => {
      const result = removePath(text, folder.uri.fsPath, uri.fsPath);
      result.removed.forEach((r) => log(`Allow upload: removed ${r}`));
      if (result.removed.length) done.push(path.basename(uri.fsPath));
      return result.text;
    });

    // Still excluded by a wider pattern such as *.log or a parent folder, for any server: say which, and where.
    for (const uri of targets) {
      const m = await this.match(uri.fsPath, await isDirectory(uri.fsPath), true);
      if (!m) continue;
      const folder = vscode.workspace.getWorkspaceFolder(uri)!;
      const where = m.list ? `"${m.list.label}"` : 'sftp.json';
      const OPEN = 'Open sftp.json';
      const choice = await vscode.window.showWarningMessage(
        `${vscode.workspace.asRelativePath(uri)} is still never uploaded: it matches "${m.pattern}" in the ignore list of ${where}. ` +
          `Change that pattern in sftp.json to upload it.`,
        OPEN
      );
      if (choice === OPEN) await vscode.window.showTextDocument(vscode.Uri.file(configPathFor(folder)!));
      return;
    }
    if (done.length) vscode.window.showInformationMessage(`${done.join(', ')} can be uploaded again.`);
  }
}

/** The clicked item, every selected item, or else the file in the active editor. */
export function targetsOf(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  let targets = selected?.length ? selected : clicked ? [clicked] : [];
  if (!targets.length && vscode.window.activeTextEditor) targets = [vscode.window.activeTextEditor.document.uri];
  targets = targets.filter((u) => u.scheme === 'file');
  if (!targets.length) throw new Error('Select a local file or folder in the Explorer first.');
  return targets;
}
