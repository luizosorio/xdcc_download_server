/**
 * IRC XDCC Download Server
 *
 * This server connects to an IRC channel and handles XDCC download requests
 * received via a TCP socket. Files are downloaded to a specified destination.
 *
 * To run: npm install
 */

'use strict';

// Load dependencies
const irc = require('irc');
const axdcc = require('./lib/axdcc');
const net = require('net');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { createWriteStream } = require('fs');
const { format } = require('util');

// Load environment variables
dotenv.config();

// Configuration variables with defaults
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const FILE_DESTINATION = process.env.FILE_DESTINATION || '/data';
const IRC_SERVER = process.env.IRC_SERVER || 'irc.rizon.net';
const IRC_NICK = process.env.IRC_NICK || 'ghost_rider';
const IRC_CHANNEL = process.env.IRC_CHANNEL || '#AnimeNSK';
const PROGRESS_INTERVAL = process.env.PROGRESS_INTERVAL || 1; // Seconds
const LOG_FILE = process.env.LOG_FILE || '/var/log/xdcc-download.log';
const PROGRESS_UPDATE_PERCENT = process.env.PROGRESS_UPDATE_PERCENT || 5; // Send updates every 5% by default
const DISABLE_PROGRESS_ANSI = process.env.DISABLE_PROGRESS_ANSI === 'true' || true; // Disable ANSI codes in Docker

// Create destination directory if it doesn't exist
if (!fs.existsSync(FILE_DESTINATION)) {
    fs.mkdirSync(FILE_DESTINATION, { recursive: true });
}

// Create logs directory if it doesn't exist
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (err) {
        console.error(`Failed to create log directory: ${err.message}`);
        // Continue without logging to file if directory creation fails
    }
}

// Set up a log file stream
let logStream;
try {
    logStream = createWriteStream(LOG_FILE, { flags: 'a' });
} catch (err) {
    console.error(`Failed to create log file: ${err.message}`);
    // Create a dummy stream that does nothing if we can't write to the log file
    logStream = {
        write: () => {},
        end: (cb) => { if (cb) cb(); }
    };
}

// Set up logging system
const logger = {
    _writeToLog: (level, message) => {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level}] ${message}\n`;

        try {
            logStream.write(formattedMessage);
        } catch (err) {
            console.error(`Failed to write to log file: ${err.message}`);
        }

        return `[${level}] ${message}`;
    },

    info: (message) => {
        const logMessage = logger._writeToLog('INFO', message);
        console.log(logMessage);
    },

    error: (message) => {
        const logMessage = logger._writeToLog('ERROR', message);
        console.error(logMessage);
    },

    warn: (message) => {
        const logMessage = logger._writeToLog('WARN', message);
        console.warn(logMessage);
    },

    debug: (message) => {
        if (process.env.DEBUG === 'true') {
            const logMessage = logger._writeToLog('DEBUG', message);
            console.debug(logMessage);
        }
    },

    progress: (message) => {
        const match = message.match(/^(\d+)%/);
        if (match) {
            const percent = parseInt(match[1], 10);
            if (percent % 10 === 0 || percent === 100) {
                logger._writeToLog('PROGRESS', message);
            }
        }

        // For Docker compatibility, use new lines instead of carriage returns
        if (DISABLE_PROGRESS_ANSI) {
            // Print progress on a new line each time for Docker logs
            console.log(`[PROGRESS] ${message}`);
        } else {
            // Clear line and update in console (for interactive terminals)
            process.stdout.write("\r\x1b[K"); // Clear line
            process.stdout.write(`[PROGRESS] ${message}`);
        }
    }
};

// Function to safely send a response to the client
function safeSocketWrite(socket, data, callback) {
    if (socket && !socket.destroyed && socket.writable) {
        try {
            const responseStr = typeof data === 'object' ? JSON.stringify(data) : data.toString();
            return socket.write(responseStr, (err) => {
                if (err) {
                    logger.error(`Error writing to socket: ${err.message}`);
                    if (callback) callback(err);
                    return false;
                }
                if (callback) callback(null);
                return true;
            });
        } catch (err) {
            logger.error(`Exception writing to socket: ${err.message}`);
            if (callback) callback(err);
            return false;
        }
    } else {
        logger.warn('Attempted to write to an invalid socket');
        if (callback) callback(new Error('Invalid socket'));
        return false;
    }
}

// Function to safely end a socket
function safeSocketEnd(socket) {
    if (socket && !socket.destroyed) {
        try {
            socket.end();
        } catch (err) {
            logger.error(`Error ending socket: ${err.message}`);
            try {
                socket.destroy();
            } catch (err2) {
                logger.error(`Also failed to destroy socket: ${err2.message}`);
            }
        }
    }
}

// Log server startup with version info
logger.info(`Starting XDCC Download Server`);
logger.info(`Node.js version: ${process.version}`);
logger.info(`Log file: ${LOG_FILE}`);
logger.info(`Download directory: ${FILE_DESTINATION}`);
logger.info(`Progress format: ${DISABLE_PROGRESS_ANSI ? 'Docker-compatible (line by line)' : 'Interactive (ANSI)'}`);

// Set IRC configuration
const ircConfig = {
    server: IRC_SERVER,
    nick: IRC_NICK,
    options: {
        channels: [IRC_CHANNEL],
        userName: IRC_NICK,
        realName: IRC_NICK,
        debug: false,
        stripColors: true,
        retryCount: 3,
        retryDelay: 2000
    }
};

// Connect to the IRC server
const client = new irc.Client(ircConfig.server, ircConfig.nick, ircConfig.options);
logger.info(`Connecting to ${ircConfig.server} as ${ircConfig.nick}`);

// Handle IRC events
client.on('registered', (message) => {
    logger.info(`Connected to IRC server successfully`);
});

client.on('join', (channel, nick, message) => {
    if (nick === ircConfig.nick && channel === ircConfig.options.channels[0]) {
        logger.info(`Joined channel ${channel}`);
    }
});

client.on('error', (error) => {
    logger.error(`IRC error: ${JSON.stringify(error)}`);

    // Attempt to reconnect if disconnected
    if (error.command === 'ECONNRESET' || error.command === 'ETIMEDOUT') {
        logger.info('Attempting to reconnect to IRC server...');
    }
});

client.on('netError', (error) => {
    logger.error(`IRC network error: ${error.message}`);
});

client.on('notice', (nick, to, text) => {
    if (nick === 'NickServ' || nick === 'ChanServ') {
        logger.debug(`${nick}: ${text}`);
    }
});

// Active downloads tracking
const activeDownloads = new Map();

// XDCC transfer handlers
const xdccHandlers = {
    connect: (pack) => {
        logger.info(`Starting download of ${pack.filename} (${formatSize(pack.filesize)})`);
    },

    progress: (pack, received) => {
        const progressPercent = Math.floor((received / pack.filesize) * 100);
        logger.progress(`${progressPercent}% of ${pack.filename} (${formatSize(received)}/${formatSize(pack.filesize)})`);

        const downloadId = pack.filename + '|' + pack.port;
        const downloadTracker = activeDownloads.get(downloadId);

        if (downloadTracker && downloadTracker.socket) {
            const progressUpdate = {
                status: 'progress',
                filename: pack.filename,
                progress: progressPercent,
                received: received,
                total: pack.filesize
            };
            safeSocketWrite(downloadTracker.socket, progressUpdate);
            logger.debug(`Sent progress update to client: ${progressPercent}%`);
        }
    },

    complete: (pack) => {
        logger.info(`Completed download of ${pack.filename} to ${pack.location}`);

        const downloadId = pack.filename + '|' + pack.port;
        const downloadTracker = activeDownloads.get(downloadId);

        if (downloadTracker && downloadTracker.socket) {
            const response = {
                status: 'success',
                filename: pack.filename,
                path: pack.location,
                size: pack.filesize,
                pack_number: downloadTracker.packNumber
            };

            logger.debug(`Sending success response: ${JSON.stringify(response)}`);

            // Send response and wait for it to be written before closing
            safeSocketWrite(downloadTracker.socket, response, (err) => {
                if (err) {
                    logger.error(`Failed to send success response: ${err.message}`);
                } else {
                    logger.debug(`Success response sent to client`);
                }

                // Wait a moment to ensure the data is sent before closing
                setTimeout(() => {
                    safeSocketEnd(downloadTracker.socket);
                    logger.debug(`Socket closed after success response`);

                    // Remove from active downloads
                    activeDownloads.delete(downloadId);
                }, 200);
            });
        } else {
            logger.info(`No active socket for completed download ${pack.filename}`);
            // Clean up anyway
            activeDownloads.delete(downloadId);
        }
    },

    error: (pack, error) => {
        // For Docker compatibility
        const filename = pack && pack.filename ? pack.filename : 'unknown file';
        logger.error(`Download error with ${filename}: ${JSON.stringify(error)}`);

        // Get the download tracker
        const downloadId = pack && pack.filename && pack.port ?
            pack.filename + '|' + pack.port : 'unknown';
        const downloadTracker = activeDownloads.get(downloadId);

        if (downloadTracker && downloadTracker.socket) {
            const errorResponse = {
                status: 'error',
                message: `Download failed: ${JSON.stringify(error)}`,
                pack_number: downloadTracker.packNumber
            };

            logger.error(`Sending error response: ${JSON.stringify(errorResponse)}`);

            // Send error and wait for it to be written before closing
            safeSocketWrite(downloadTracker.socket, errorResponse, (err) => {
                if (err) {
                    logger.error(`Failed to send error response: ${err.message}`);
                } else {
                    logger.debug(`Error response sent to client`);
                }

                // Wait a moment to ensure the data is sent before closing
                setTimeout(() => {
                    safeSocketEnd(downloadTracker.socket);
                    logger.debug(`Socket closed after error response`);

                    // Remove from active downloads
                    activeDownloads.delete(downloadId);
                }, 200);
            });
        } else {
            logger.info(`No active socket for failed download ${filename}`);
            // Clean up anyway
            if (downloadId !== 'unknown') {
                activeDownloads.delete(downloadId);
            }
        }
    }
};

// Create TCP server for receiving download requests
const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info(`New connection from ${clientId}`);

    socket.setEncoding('utf8');

    // Set timeout to prevent zombie connections
    socket.setTimeout(60000, () => {
        logger.info(`Connection from ${clientId} timed out`);
        safeSocketEnd(socket);
    });

    let requestData = '';
    socket.on('data', (data) => {
        requestData += data.toString();

        // Simple guard against very large requests
        if (requestData.length > 10000) {
            logger.warn(`Received oversized request from ${clientId}, closing connection`);
            safeSocketWrite(socket, {
                status: 'error',
                message: 'Request too large'
            });
            safeSocketEnd(socket);
            return;
        }

        try {
            // Attempt to parse JSON - if it fails, wait for more data
            const request = JSON.parse(requestData);
            requestData = ''; // Reset for potential future requests

            // Check required parameters
            const { bot_name, pack_number, send_progress } = request;

            if (!bot_name || !pack_number) {
                throw new Error('Invalid request format. Required fields: bot_name, pack_number');
            }

            logger.info(`Received request for bot ${bot_name}, pack #${pack_number}`);

            // Send initial response
            safeSocketWrite(socket, {
                status: 'downloading',
                message: `Started download request for pack #${pack_number} from ${bot_name}`,
                pack_number: pack_number
            });

            // Create download request
            const xdccRequest = new axdcc.Request(client, {
                pack: '#' + pack_number,
                nick: bot_name,
                path: FILE_DESTINATION,
                resume: true, // Enable resume to handle interrupted downloads
                progressInterval: PROGRESS_INTERVAL,
                verbose: true // Enable detailed progress logging
            });

            xdccRequest.once("connect", function(pack) {
                const downloadId = pack.filename + '|' + pack.port;

                activeDownloads.set(downloadId, {
                    socket: socket,
                    packNumber: pack_number,
                    sendProgress: send_progress === true,
                    startTime: Date.now(),
                    request: xdccRequest
                });

                xdccHandlers.connect(pack);
            });

            // Attach event handlers
            xdccRequest
                .on("progress", xdccHandlers.progress)
                .on("complete", xdccHandlers.complete)
                .on("dlerror", xdccHandlers.error);

            // Start the download
            xdccRequest.emit("start");

            // Handle socket close/error during download
            socket.on('close', (hadError) => {
                logger.info(`Connection from ${clientId} closed${hadError ? ' with error' : ''}`);

                for (const [downloadId, tracker] of activeDownloads.entries()) {
                    if (tracker.socket === socket) {
                        logger.debug(`Marking socket as closed for download ${downloadId}`);
                        tracker.socket = null;
                    }
                }
            });

        } catch (err) {
            // If it's a JSON parsing error and we don't have complete data, wait for more
            if (err instanceof SyntaxError && !requestData.endsWith('}')) {
                return;
            }

            logger.error(`Error processing request from ${clientId}: ${err.message}`);
            safeSocketWrite(socket, {
                status: 'error',
                message: `Invalid request: ${err.message}`
            });
            safeSocketEnd(socket);
        }
    });

    socket.on('error', (err) => {
        logger.error(`Socket error from ${clientId}: ${err.message}`);
        try {
            socket.destroy();
        } catch (err2) {
            logger.error(`Failed to destroy socket: ${err2.message}`);
        }
    });

    socket.on('end', () => {
        logger.info(`Connection from ${clientId} closed by client`);
    });
});

// Set reasonable limit on listeners
server.setMaxListeners(20);

// Handle server errors
server.on('error', (err) => {
    logger.error(`Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use. Please choose another port.`);
        process.exit(1);
    }
});

// Start the server
server.listen(PORT, HOST, () => {
    logger.info(`IRC-XDCC Download server running on ${HOST}:${PORT}`);
});

// Periodically clean up stale download trackers
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [downloadId, tracker] of activeDownloads.entries()) {
        // If socket is closed and download is more than 1 hour old
        if (!tracker.socket && tracker.startTime && (now - tracker.startTime > 60 * 60 * 1000)) {
            activeDownloads.delete(downloadId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger.debug(`Cleaned up ${cleaned} stale download trackers`);
    }
}, 30 * 60 * 1000); // Run every 30 minutes

// Handle process termination
process.on('SIGINT', () => {
    logger.info('Shutting down server...');
    server.close(() => {
        logger.info('Server stopped');
        client.disconnect('Shutting down', () => {
            logger.info('Disconnected from IRC');
            // Close log stream
            logStream.end(() => {
                process.exit(0);
            });
        });
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack);
    // Close log stream
    logStream.end(() => {
        process.exit(1);
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
    // No need to exit here
});

// Utility function to format file sizes
function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}