# Changelog

## 0.1.0

- Upload selected files and folders, or the whole project, to a server from `.vscode/sftp.json` over SFTP or FTPS.
- Follows symbolic links to folders and files; their contents are uploaded at the place of the link.
- Compares with the server first and uploads only new or changed files, or everything on request.
- Respects `ignore` from sftp.json and skips `.git`, `.vscode` and similar folders by default.
