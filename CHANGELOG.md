# Changelog

## 0.2.1

- A file excluded for only some servers (for example only in the `ignore` list of one profile) is no longer shown as never uploaded, and **Never Upload** now adds it to the other lists instead of saying it is already excluded.
- **Never Upload** on a path with `[`, `]` or `*` in its name (such as `app/[slug]/page.tsx`) now writes an escaped pattern, so that exact path is excluded.
- **Allow Upload** is offered in the Explorer for excluded items on Windows too.
- README: the SFTP extension by Natizyskunk does not check the `ignore` list for its Upload File and Force Upload commands.
- Marketplace listing: README with a rating badge, a "Get started in 30 seconds" section, a comparison with uploading by hand, more FAQ, links to Git SFTP Upload and SFTP Remote Editor, and links to rate the extension. More search keywords.

## 0.2.0

- **Never Upload**, like *Exclude path* in PhpStorm: right-click a file or folder in the Explorer to add it to the `ignore` list of sftp.json, for every server whose context contains it. **Allow Upload** removes it again. Comments and formatting in sftp.json are kept.
- Files and folders in the `ignore` list are marked with ⊘ in the Explorer (setting `sftpFolderUpload.showNeverUploadInExplorer`).
- A file in the `ignore` list is no longer uploaded when it is selected on its own.

## 0.1.0

- Upload selected files and folders, or the whole project, to a server from `.vscode/sftp.json` over SFTP or FTPS.
- Follows symbolic links to folders and files; their contents are uploaded at the place of the link.
- Compares with the server first and uploads only new or changed files, or everything on request.
- Respects `ignore` from sftp.json and skips `.git`, `.vscode` and similar folders by default.
