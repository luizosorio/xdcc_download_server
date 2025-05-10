#!/usr/bin/env node

/**
 * XDCC Download Client
 *
 * A Node.js client for the XDCC Download Server
 */

const net = require('net');
const readline = require('readline');

// Parse command line arguments
const args = process.argv.slice(2);
let host = 'localhost';
let port = 8080;
let botName = '';
let packNumber = '';
let sendProgress = true;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && i+1 < args.length) {
    host = args[i+1];
    i++;
  } else if (args[i] === '--port' && i+1 < args.length) {
    port = parseInt(args[i+1], 10);
    i++;
  } else if (args[i] === '--bot' && i+1 < args.length) {
    botName = args[i+1];
    i++;
  } else if (args[i] === '--pack' && i+1 < args.length) {
    packNumber = args[i+1];
    i++;
  } else if (args[i] === '--no-progress') {
    sendProgress = false;
  } else if (args[i] === '--help') {
    console.log(`
XDCC Download Client

Usage:
  node client.js --host <host> --port <port> --bot <bot_name> --pack <pack_number> [--no-progress]

Options:
  --host <host>       Server hostname (default: localhost)
  --port <port>       Server port (default: 8080)
  --bot <bot_name>    Bot name (required)
  --pack <pack_number> Pack number (required)
  --no-progress       Don't request progress updates
  --help              Show this help message
`);
    process.exit(0);
  }
}

// Validate required arguments
if (!botName || !packNumber) {
  console.error('Error: Bot name and pack number are required');
  console.error('Use --help for usage information');
  process.exit(1);
}

// Format bytes to human-readable size
function formatSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Draw a progress bar
function drawProgressBar(percent, width = 30) {
  const filled = Math.floor(width * percent / 100);
  const bar = '█'.repeat(filled) + '-'.repeat(width - filled);
  return `[${bar}] ${percent}%`;
}

// Create a socket connection
const socket = new net.Socket();
const startTime = Date.now();
let lastProgress = 0;
let buffer = '';

// Connect to the server
console.log(`Connecting to ${host}:${port}...`);
socket.connect(port, host, () => {
  console.log('Connected to XDCC Download Server');

  // Create the request
  const request = {
    bot_name: botName,
    pack_number: packNumber,
    send_progress: sendProgress
  };

  console.log(`Sending request: ${JSON.stringify(request)}`);
  socket.write(JSON.stringify(request));
});

// Handle data received from the server
socket.on('data', (data) => {
  // Add the data to our buffer
  buffer += data.toString();

  // Process complete JSON objects
  let startPos = 0;
  while ((startPos = buffer.indexOf('{', startPos)) !== -1) {
    try {
      // Find a potential JSON object
      let endPos = buffer.indexOf('}', startPos);
      if (endPos === -1) break;

      // Extract and parse the JSON
      const jsonStr = buffer.substring(startPos, endPos + 1);
      const response = JSON.parse(jsonStr);

      // Remove the processed part from the buffer
      buffer = buffer.substring(endPos + 1);
      startPos = 0;

      // Process the response based on its status
      switch (response.status) {
        case 'downloading':
          console.log(`Server accepted request: ${response.message}`);
          break;

        case 'progress':
          const progress = response.progress;
          const received = response.received;
          const total = response.total;

          // Update tracking variables
          lastProgress = progress;

          // Calculate speed
          const elapsed = (Date.now() - startTime) / 1000; // seconds
          const speed = received / elapsed;

          // Print progress bar
          const progressBar = drawProgressBar(progress);
          process.stdout.write(`\r${progressBar} | ${formatSize(received)}/${formatSize(total)} | ${formatSize(speed)}/s`);
          break;

        case 'success':
          console.log(`\nDownload completed successfully!`);
          console.log(`File: ${response.filename}`);
          console.log(`Size: ${formatSize(response.size)}`);
          console.log(`Saved to: ${response.path}`);
          socket.end();
          break;

        case 'error':
          console.log(`\nDownload failed: ${response.message}`);
          socket.end();
          break;

        default:
          console.log(`\nUnknown status: ${response.status}`);
          console.log(response);
      }
    } catch (err) {
      // If we couldn't parse it as JSON, move past this opening brace
      startPos++;
    }
  }
});

// Handle socket closure
socket.on('close', () => {
  if (lastProgress > 0) {
    console.log(`\nServer closed connection after reaching ${lastProgress}% progress.`);
    console.log(`The download is likely continuing on the server.`);
    if (lastProgress > 90) {
      console.log(`Download was at ${lastProgress}%, likely completed successfully!`);
    } else {
      console.log(`Download may still be in progress on the server.`);
    }
  } else {
    console.log('\nConnection closed');
  }
});

// Handle errors
socket.on('error', (err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

// Handle user interruption
process.on('SIGINT', () => {
  console.log('\nOperation cancelled by user');
  socket.end();
  process.exit(0);
});