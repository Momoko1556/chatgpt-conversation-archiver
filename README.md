# ChatGPT Conversation Archiver

A local Chrome/Edge extension for exporting complete ChatGPT conversations as JSON, Markdown, TXT, and image archives with automatic pagination and validation.

一个在本地运行的 Chrome / Edge 扩展，用于完整归档 ChatGPT 长对话。

## Features

- Automatically follows ChatGPT's conversation pagination until the oldest page is reached.
- Validates conversation IDs, page structure, cursor uniqueness, and archive completeness.
- Deduplicates raw messages by `message.id`.
- Exports the selected format independently:
  - Complete merged JSON
  - Readable Markdown
  - Plain-text TXT
  - Original image files in a separate ZIP archive
- Filters hidden system, tool, reasoning, and internal messages from readable exports.
- Converts message times to `Asia/Shanghai`.
- Shows live page and image progress.
- Keeps session credentials in memory only; no cookies or access tokens are written to disk or extension storage.

## Installation

### Microsoft Edge

1. Download or clone this repository.
2. Open `edge://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository directory containing `manifest.json`.

### Google Chrome

Follow the same steps at `chrome://extensions/`.

## Usage

1. Sign in to [ChatGPT](https://chatgpt.com/).
2. Open the conversation you want to archive. Its URL must contain `/c/<conversation_id>`.
3. Open the extension and choose one action:
   - **导出 JSON** → `<title>_完整合并.json`
   - **导出 Markdown** → `<title>_完整对话.md`
   - **导出 TXT** → `<title>_完整对话.txt`
   - **导出图片** → `<title>_图片.zip`
4. Keep the extension popup open until the task finishes.

Every action reads the full pagination chain first so older messages and images are not missed.

## Archive validation

The extension refuses to label an archive complete unless it reaches a page where:

```text
page_info.has_previous_page = false
```

It also stops on:

- A mismatched `conversation_id`
- A response missing `messages` or `page_info`
- Repeated cursor boundaries
- Missing pagination cursors
- Network or authentication failures

The merged JSON includes an `_archive` section containing the pagination ledger and message statistics.

## Image archives

Images are kept separate from text exports. The ZIP uses lossless Store mode and includes:

```text
images/
  image_001_<file_id>.png
  image_002_<file_id>.webp
  ...
manifest.json
```

`manifest.json` records the originating message ID, role, timestamp, asset pointer, dimensions, MIME type, downloaded size, and any failed downloads.

## Privacy and security

- The extension runs locally in the browser.
- It requests access only to `https://chatgpt.com/*`.
- It obtains a temporary ChatGPT access token from the current signed-in session for read-only archive requests.
- The token is held in memory for the current operation only.
- Cookies, authorization headers, and session tokens are never included in exported files or logs.
- Tokens are never sent to non-ChatGPT download origins.

## Limitations

- This project uses ChatGPT's private web endpoints, which may change without notice.
- It is not affiliated with or endorsed by OpenAI.
- Deleted, expired, or inaccessible image assets cannot be recovered.
- Very large image archives may require substantial browser memory while the ZIP is assembled.
- Reload the extension and refresh the ChatGPT tab after updating the source files.

## Development

There is no build step and no third-party runtime dependency. Edit the source files, reload the unpacked extension, and refresh the ChatGPT tab.

Basic syntax checks:

```powershell
node --check background.js
node --check popup.js
```

## License

[MIT](LICENSE)

