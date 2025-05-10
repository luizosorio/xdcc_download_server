/**
 * XDCC Download Request Module
 *
 * This module handles XDCC download requests for IRC clients,
 * supporting resume functionality and progress tracking.
 */

'use strict';

// Get dependencies
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Request class for handling XDCC downloads
 * @class Request
 * @extends EventEmitter
 */
class Request extends EventEmitter {
  /**
   * Create a new XDCC download request
   * @param {Object} client - IRC client instance
   * @param {Object} args - Configuration options
   * @param {string} args.nick - Bot nickname
   * @param {string} args.pack - Pack number/id
   * @param {string} args.path - Download destination directory
   * @param {boolean} [args.resume=true] - Whether to resume interrupted downloads
   * @param {number} [args.progressInterval=1] - Progress update interval in seconds
   * @param {boolean} [args.verbose=false] - Whether to log detailed progress information
   */
  constructor(client, args) {
    super();

    this.finished = false;
    this.client = client;
    this.args = Object.assign({
      progressInterval: 1,
      resume: true,
      verbose: false
    }, args);

    this.pack_info = {};
    this.intervalId = null;
    this.startTime = null;
    this.lastReceivedBytes = 0;
    this.handlerBound = false;

    // Start handler
    this.once('start', this._handleStart.bind(this));

    // Set up cleanup handlers
    this.once('cancel', this._handleCancel.bind(this));
    this.on('kill', this._killRequest.bind(this));
  }

  /**
   * Handles the start event for the download
   * @private
   */
  _handleStart() {
    if (this.args.verbose) {
      console.log(`[XDCC] Requesting pack ${this.args.pack} from ${this.args.nick}`);
    }

    // Request the file from the XDCC bot
    this.client.say(this.args.nick, `XDCC SEND ${this.args.pack}`);

    // Listen for data from the XDCC bot
    if (!this.handlerBound) {
      this.client.on('ctcp-privmsg', this._dccDownloadHandler.bind(this));
      this.handlerBound = true;
    }
  }

  /**
   * Handles the cancel event
   * @private
   */
  _handleCancel() {
    if (this.finished) {
      return;
    }

    if (this.args.verbose) {
      console.log(`[XDCC] Canceling download from ${this.args.nick}`);
    }

    // Cancel the pack
    this.client.say(this.args.nick, 'XDCC CANCEL');
    this._killRequest();
  }

  /**
   * Handles DCC messages from the bot
   * @param {string} sender - Message sender
   * @param {string} target - Message target
   * @param {string} message - CTCP message
   * @private
   */
  _dccDownloadHandler(sender, target, message) {
    if (this.finished) {
      return;
    }

    // Only process messages from the bot to our client
    if (sender !== this.args.nick || target !== this.client.nick || !message.startsWith('DCC ')) {
      return;
    }

    if (this.args.verbose) {
      console.log(`[XDCC] Received DCC message: ${message}`);
    }

    // Parse the DCC message
    // Format: DCC {command} ("|'){filename}("|') {ip} {port}( {filesize})
    const parser = /DCC (\w+) "?'?(.+?)'?"? (\d+) (\d+)(?: (\d+))?/;
    const params = message.match(parser);

    if (!params) {
      this.emit('dlerror', null, `Invalid DCC message format: ${message}`);
      return;
    }

    const command = params[1];
    const filename = params[2];
    const ip = this._intToIP(parseInt(params[3], 10));
    const port = parseInt(params[4], 10);
    const filesize = params[5] ? parseInt(params[5], 10) : 0;

    switch (command) {
      case 'SEND':
        this._handleDccSend(filename, ip, port, filesize);
        break;

      case 'ACCEPT':
        this._handleDccAccept(filename, port, parseInt(params[5], 10));
        break;

      default:
        this.emit('dlerror', this.pack_info, `Unknown DCC command: ${command}`);
    }
  }

  /**
   * Handles DCC SEND message
   * @param {string} filename - File name
   * @param {string} ip - Server IP address
   * @param {number} port - Server port
   * @param {number} filesize - Size of the file
   * @private
   */
  _handleDccSend(filename, ip, port, filesize) {
    this.pack_info = {
      command: 'SEND',
      filename,
      ip,
      port,
      filesize,
      resumepos: 0
    };

    if (this.args.verbose) {
      console.log(`[XDCC] Preparing to download: ${filename} (${this._formatSize(filesize)})`);
    }

    // Ensure the download directory exists
    let downloadDir = this.args.path;
    // Remove trailing slashes for consistency
    downloadDir = downloadDir.replace(/[\/\\]$/, '');

    const createDirectory = () => {
      if (!fs.existsSync(downloadDir)) {
        try {
          fs.mkdirSync(downloadDir, { recursive: true });
          if (this.args.verbose) {
            console.log(`[XDCC] Created directory: ${downloadDir}`);
          }
          checkForPartialFile();
        } catch (err) {
          this.emit('dlerror', this.pack_info, `Failed to create directory: ${err.message}`);
        }
      } else {
        checkForPartialFile();
      }
    };

    // Preserve the original filename and save it to the specified directory
    const filePath = path.join(downloadDir, filename);
    this.pack_info.location = filePath;

    if (this.args.verbose) {
      console.log(`[XDCC] Will save to: ${filePath}`);
    }

    const checkForPartialFile = () => {
      // Check if partial file exists for potential resume
      fs.stat(`${filePath}.part`, (err, stats) => {
        if (!err && stats.isFile()) {
          if (this.args.resume) {
            // Resume download
            if (this.args.verbose) {
              console.log(`[XDCC] Resuming download from ${this._formatSize(stats.size)} (${Math.round((stats.size / filesize) * 100)}%)`);
            }

            this.client.ctcp(
              this.args.nick,
              'privmsg',
              `DCC RESUME ${this.pack_info.filename} ${this.pack_info.port} ${stats.size}`
            );
            this.pack_info.resumepos = stats.size;
          } else {
            // Don't resume, delete partial file and start fresh
            fs.unlink(`${filePath}.part`, (err) => {
              if (err) {
                this.emit('dlerror', this.pack_info, `Failed to delete partial file: ${err.message}`);
                return;
              }
              if (this.args.verbose) {
                console.log(`[XDCC] Deleted partial file, starting fresh download`);
              }
              this._download(this.pack_info);
            });
          }
        } else {
          // No partial file exists, start download
          if (this.args.verbose) {
            console.log(`[XDCC] Starting new download`);
          }
          this._download(this.pack_info);
        }
      });
    };

    // Start the process by creating directory if needed
    createDirectory();
  }

  /**
   * Handles DCC ACCEPT message (bot accepts resume)
   * @param {string} filename - File name
   * @param {number} port - Server port
   * @param {number} resumepos - Resume position
   * @private
   */
  _handleDccAccept(filename, port, resumepos) {
    // Verify the accept message matches our request
    if (
      this.pack_info.filename === filename &&
      this.pack_info.port === port &&
      this.pack_info.resumepos === resumepos
    ) {
      if (this.args.verbose) {
        console.log(`[XDCC] Resume accepted, continuing download from ${this._formatSize(resumepos)}`);
      }

      this.pack_info.command = 'ACCEPT';
      this._download(this.pack_info);
    } else {
      this.emit('dlerror', this.pack_info, 'DCC ACCEPT parameters mismatch');
    }
  }

  /**
   * Starts the download process
   * @param {Object} pack - Pack information
   * @private
   */
  _download(pack) {
    if (this.finished) return;

    // Create write stream to store data
    const stream = fs.createWriteStream(`${pack.location}.part`, { flags: 'a' });

    stream.on('open', () => {
      const sendBuffer = Buffer.alloc(4);
      let received = pack.resumepos;
      let ack = pack.resumepos;

      this.startTime = Date.now();
      this.lastReceivedBytes = received;

      // Connect to the bot
      const conn = net.connect({ port: pack.port, host: pack.ip }, () => {
        this.emit('connect', pack);

        if (this.args.verbose) {
          console.log(`[XDCC] Connected to ${pack.ip}:${pack.port}`);
        }

        // Set up progress reporting
        this.intervalId = setInterval(() => {
          if (!this.finished) {
            this._logProgress(pack, received);
            this.emit('progress', pack, received);
          }
        }, this.args.progressInterval * 1000);
      });

      // Handle incoming data
      conn.on('data', (data) => {
        if (this.finished) return;

        received += data.length;

        // Support for large files (>4GB)
        ack += data.length;
        while (ack > 0xFFFFFFFF) {
          ack -= 0xFFFFFFFF + 1;
        }

        sendBuffer.writeUInt32BE(ack, 0);
        conn.write(sendBuffer);

        stream.write(data);
      });

      // Handle connection end
      conn.on('end', () => {
        // Close the write stream
        const closeStream = () => {
          stream.end(() => {
            if (this.args.verbose) {
              console.log(`[XDCC] Stream closed`);
            }
          });
        };

        closeStream();

        // Connection closed
        if (received === pack.filesize) {
          // Download complete, rename from .part to final name
          fs.rename(`${pack.location}.part`, pack.location, (err) => {
            if (err) {
              this.emit('dlerror', pack, `Failed to rename file: ${err.message}`);
              conn.destroy();
              this._killRequest();
            } else {
              if (this.args.verbose) {
                // Log final stats
                const elapsedTime = (Date.now() - this.startTime) / 1000;
                const averageSpeed = (received / elapsedTime);
                console.log(`\n[XDCC] Download complete: ${pack.filename}`);
                console.log(`[XDCC] Size: ${this._formatSize(received)}`);
                console.log(`[XDCC] Time: ${this._formatTime(elapsedTime)}`);
                console.log(`[XDCC] Average Speed: ${this._formatSpeed(averageSpeed)}`);
                console.log(`[XDCC] Saved to: ${pack.location}`);
              }

              // Emit completion event before cleanup
              this.emit('complete', pack);
              conn.destroy();
              this._killRequest();
            }
          });
        } else if (received !== pack.filesize && !this.finished) {
          // Download incomplete
          if (this.args.verbose) {
            console.log(`\n[XDCC] Download incomplete: ${this._formatSize(received)}/${this._formatSize(pack.filesize)}`);
          }
          this.emit('dlerror', pack, 'Server unexpectedly closed connection');
          conn.destroy();
          this._killRequest();
        } else if (received !== pack.filesize && this.finished) {
          // Download aborted
          if (this.args.verbose) {
            console.log(`\n[XDCC] Download canceled: ${this._formatSize(received)}/${this._formatSize(pack.filesize)}`);
          }
          this.emit('dlerror', pack, 'Server closed connection, download canceled');
          conn.destroy();
          this._killRequest();
        }
      });

      // Handle connection errors
      conn.on('error', (error) => {
        if (this.finished) return;

        stream.end();
        if (this.args.verbose) {
          console.log(`\n[XDCC] Connection error: ${error.message}`);
        }
        this.emit('dlerror', pack, error);
        conn.destroy();
        this._killRequest();
      });

      // Set connection timeout
      conn.setTimeout(60000, () => {
        if (this.finished) return;

        stream.end();
        if (this.args.verbose) {
          console.log(`\n[XDCC] Connection timed out`);
        }
        this.emit('dlerror', pack, 'Connection timed out');
        conn.destroy();
        this._killRequest();
      });
    });

    // Handle file stream errors
    stream.on('error', (error) => {
      if (this.finished) return;

      stream.end();
      if (this.args.verbose) {
        console.log(`\n[XDCC] File error: ${error.message}`);
      }
      this.emit('dlerror', pack, error);
      this._killRequest();
    });
  }

  /**
   * Log the download progress with advanced statistics
   * @param {Object} pack - Pack information
   * @param {number} received - Bytes received
   * @private
   */
  _logProgress(pack, received) {
    if (!this.args.verbose) return;

    const currentTime = Date.now();
    const elapsedSeconds = (currentTime - this.startTime) / 1000;
    const percent = Math.min(100, Math.floor((received / pack.filesize) * 100));

    // Calculate speed
    const bytesDownloadedSinceLastUpdate = received - this.lastReceivedBytes;
    const timeSinceLastUpdate = this.args.progressInterval;
    const currentSpeed = bytesDownloadedSinceLastUpdate / timeSinceLastUpdate;
    const averageSpeed = received / elapsedSeconds;

    // Calculate ETA
    const remainingBytes = pack.filesize - received;
    const etaSeconds = remainingBytes / (currentSpeed > 0 ? currentSpeed : averageSpeed);

    // Create progress bar
    const width = 30;
    const completed = Math.round(width * percent / 100);
    const remaining = width - completed;
    const progressBar = '[' + '='.repeat(completed) + ' '.repeat(remaining) + ']';

    // Update last received bytes for next speed calculation
    this.lastReceivedBytes = received;

    // Clear line and update progress
    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `[XDCC] ${progressBar} ${percent}% | ` +
      `${this._formatSize(received)}/${this._formatSize(pack.filesize)} | ` +
      `${this._formatSpeed(currentSpeed)} | ` +
      `ETA: ${this._formatTime(etaSeconds)} | ` +
      `Elapsed: ${this._formatTime(elapsedSeconds)}`
    );
  }

  /**
   * Clean up resources and end request
   * @private
   */
  _killRequest() {
    if (this.finished) return;

    this.finished = true;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.handlerBound) {
      this.client.removeListener('ctcp-privmsg', this._dccDownloadHandler);
      this.handlerBound = false;
    }

    // Set a short delay before removing listeners to ensure any pending events are processed
    setTimeout(() => {
      this.removeAllListeners();
      this.pack_info = {};
    }, 100);
  }

  /**
   * Converts integer to IP address
   * @param {number} n - Integer representation of IP
   * @returns {string} Dotted decimal IP address
   * @private
   */
  _intToIP(n) {
    const octets = [];

    octets.unshift(n & 255);
    octets.unshift((n >> 8) & 255);
    octets.unshift((n >> 16) & 255);
    octets.unshift((n >> 24) & 255);

    return octets.join('.');
  }

  /**
   * Format file size into human-readable string
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size
   * @private
   */
  _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  /**
   * Format time in seconds to human-readable string
   * @param {number} seconds - Time in seconds
   * @returns {string} Formatted time
   * @private
   */
  _formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '∞';
    if (seconds < 60) return `${Math.floor(seconds)}s`;

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return hours > 0
      ? `${hours}h ${minutes}m ${secs}s`
      : `${minutes}m ${secs}s`;
  }

  /**
   * Format speed in bytes/second to human-readable string
   * @param {number} bytesPerSecond - Speed in bytes per second
   * @returns {string} Formatted speed
   * @private
   */
  _formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(1024));
    return `${(bytesPerSecond / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }
}

module.exports = { Request };