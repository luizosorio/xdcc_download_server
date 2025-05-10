# XDCC Download Server

A Node.js server that connects to IRC channels and handles XDCC file download requests. The server accepts requests via a TCP socket API and downloads files from XDCC bots to a specified destination.

This project extends and improves upon [node-xdcc](https://github.com/Indysama/node-xdcc) by Indysama, with significant enhancements to core functionality, logging, API interface, and Docker compatibility.

## Features

- Connect to IRC servers and channels automatically
- Download files from XDCC bots
- Resume interrupted downloads
- Real-time download progress tracking
- Docker-compatible logging
- Robust socket handling
- JSON-based API for requests
- Continue downloads even if client disconnects
- Easy configuration via environment variables

## Installation

### Prerequisites

- Node.js 12.x or higher
- npm or yarn

### Install Dependencies

```bash
npm install
```

### Environment Variables

Create a `.env` file in the project root with the following configuration:

```env
PORT=8080
HOST=0.0.0.0
FILE_DESTINATION=/data
IRC_SERVER=irc.rizon.net
IRC_NICK=your_irc_nick
IRC_CHANNEL=#your_channel
PROGRESS_INTERVAL=1
LOG_FILE=/var/log/xdcc-download.log
DEBUG=false
DISABLE_PROGRESS_ANSI=true
PROGRESS_UPDATE_PERCENT=5
```

## Running the Server

### Standard Mode

```bash
node server.js
```

### Docker

Build the Docker image:

```bash
docker build -t xdcc-download-server .
```

Run the container:

```bash
docker run -d \
  --name xdcc-downloader \
  -p 8080:8080 \
  -v /path/to/downloads:/data \
  -v /path/to/logs:/var/log \
  -e IRC_SERVER=irc.rizon.net \
  -e IRC_NICK=your_irc_nick \
  -e IRC_CHANNEL=#your_channel \
  xdcc-download-server
```

## API Usage

The server accepts download requests via a TCP socket API.

### API Request Format

Send a JSON object to the server with the following format:

```json
{
  "bot_name": "BotName|FileInfo",
  "pack_number": "123",
  "send_progress": true
}
```

Parameters:
- `bot_name`: The IRC nickname of the XDCC bot, often includes file information after a pipe character
- `pack_number`: The pack number to download
- `send_progress` (optional): Whether to receive progress updates (default: false)

### API Response Format

The server responds with JSON objects for different stages of the download:

#### Initial Response

```json
{
  "status": "downloading",
  "message": "Started download request for pack #123 from BotName|FileInfo",
  "pack_number": "123"
}
```

#### Progress Updates (if requested)

```json
{
  "status": "progress",
  "filename": "example.mkv",
  "progress": 45,
  "received": 471859200,
  "total": 1048576000
}
```

#### Success Response

```json
{
  "status": "success",
  "filename": "example.mkv",
  "path": "/data/example.mkv",
  "size": 1048576000,
  "pack_number": "123"
}
```

#### Error Response

```json
{
  "status": "error",
  "message": "Error message describing what went wrong",
  "pack_number": "123"
}
```

## Configuration Options

### Server Options

| Environment Variable | Description | Default |
|---------------------|-------------|--------|
| PORT | Port for the TCP server | 8080 |
| HOST | Host to bind the server to | 0.0.0.0 |
| FILE_DESTINATION | Where to save downloaded files | /data |
| IRC_SERVER | IRC server address | irc.rizon.net |
| IRC_NICK | Nickname to use on IRC | ghost_rider |
| IRC_CHANNEL | IRC channel to join | #AnimeNSK |
| PROGRESS_INTERVAL | How often to check download progress (seconds) | 1 |
| LOG_FILE | Where to save log files | /var/log/xdcc-download.log |
| DEBUG | Enable debug logging | false |
| DISABLE_PROGRESS_ANSI | Use Docker-compatible progress logging | true |
| PROGRESS_UPDATE_PERCENT | Send progress updates to client at this percentage interval | 5 |

## Architecture

The server consists of two main components:

1. **IRC Client**: Connects to the IRC server and channel, and communicates with XDCC bots
2. **TCP Server**: Accepts download requests from clients and tracks download progress

The core XDCC download functionality is provided by the `axdcc.js` module, which is based on [node-xdcc](https://github.com/Indysama/node-xdcc) with significant improvements for robustness, error handling, and progress reporting.

## Advanced Features

### Automatic Download Resumption

If a download is interrupted, the server will automatically attempt to resume it when the same file is requested again.

### Background Downloads

Even if a client disconnects during a download, the server will continue downloading the file in the background. The file will be available in the specified download directory once complete.

### Progress Tracking

The server provides real-time progress tracking via both:
- Server logs (visible in Docker logs)
- Client progress updates (when requested)

### Socket Management

The server implements robust socket management to handle:
- Client disconnections
- Network errors
- Timeouts
- Incomplete JSON requests

## Credits

- Original XDCC download module by [Indysama](https://github.com/Indysama/node-xdcc)
- Enhanced and extended with modern JavaScript features and Docker compatibility
