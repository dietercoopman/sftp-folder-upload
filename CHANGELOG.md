# Changelog

## 0.2.0

- **Never Upload**, like *Exclude path* in PhpStorm: right-click a file or folder in the Explorer to add it to the `ignore` list of sftp.json, for every server whose context contains it. **Allow Upload** removes it again. Comments and formatting in sftp.json are kept.
- Files and folders in the `ignore` list are marked with ⊘ in the Explorer (setting `sftpFolderUpload.showNeverUploadInExplorer`).
- A file in the `ignore` list is no longer uploaded when it is selected on its own.

## 0.1.0

- Upload selected files and folders, or the whole project, to a server from `.vscode/sftp.json` over SFTP or FTPS.
- Follows symbolic links to folders and files; their contents are uploaded at the place of the link.
- Compares with the server first and uploads only new or changed files, or everything on request.
- Respects `ignore` from sftp.json and skips `.git`, `.vscode` and similar folders by default.
