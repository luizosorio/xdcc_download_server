#!/usr/bin/env python3
"""
XDCC Download Client

A simple client to request files from the XDCC Download Server.
"""

import socket
import json
import argparse
import time
import sys


def format_size(bytes_size):
    """Format file size to human-readable format"""
    if bytes_size < 1024:
        return f"{bytes_size} B"
    elif bytes_size < 1024 * 1024:
        return f"{bytes_size / 1024:.2f} KB"
    elif bytes_size < 1024 * 1024 * 1024:
        return f"{bytes_size / (1024 * 1024):.2f} MB"
    else:
        return f"{bytes_size / (1024 * 1024 * 1024):.2f} GB"


def draw_progress_bar(percent, width=30):
    """Draw a text-based progress bar"""
    filled = int(width * percent / 100)
    bar = '█' * filled + '-' * (width - filled)
    return f"[{bar}] {percent}%"


def main():
    """Main function to run the client"""
    parser = argparse.ArgumentParser(description="XDCC Download Client")
    parser.add_argument("--host", default="localhost", help="XDCC server host")
    parser.add_argument("--port", type=int, default=8080, help="XDCC server port")
    parser.add_argument("--bot", required=True, help="Bot name (e.g., 'BotName')")
    parser.add_argument("--pack", required=True, help="Pack number")
    parser.add_argument("--no-progress", action="store_true", help="Don't request progress updates")

    args = parser.parse_args()

    # Create socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    try:
        # Connect to server
        print(f"Connecting to {args.host}:{args.port}...")
        sock.connect((args.host, args.port))
        print(f"Connected to XDCC Download Server")

        # Create and send request
        request = {
            "bot_name": args.bot,
            "pack_number": args.pack,
            "send_progress": not args.no_progress
        }

        print(f"Sending request: {json.dumps(request)}")
        sock.sendall(json.dumps(request).encode('utf-8'))

        # Set timeout for receiving data
        sock.settimeout(60)  # 60 seconds

        # Buffer for incomplete data
        buffer = b""

        # Start time for progress calculation
        start_time = time.time()

        print("\nWaiting for server response...")

        # Variables to track download
        last_progress = 0

        # Main receiving loop
        while True:
            try:
                # Try to receive data
                chunk = sock.recv(4096)

                if not chunk:
                    if last_progress > 0:
                        print(f"\nServer closed connection after reaching {last_progress}% progress.")
                        print(f"The download is likely continuing on the server.")
                        if last_progress > 90:
                            print(f"Download was at {last_progress}%, likely completed successfully!")
                        else:
                            print(f"Download may still be in progress on the server.")
                        return 0
                    else:
                        print("\nServer closed connection without any progress updates.")
                        return 1

                # Add to our buffer
                buffer += chunk

                # Try to process one or more JSON objects from buffer
                while True:
                    # Find the start of a JSON object
                    start = buffer.find(b'{')
                    if start == -1:
                        break

                    # Find the end of the JSON object
                    end = buffer.find(b'}', start)
                    if end == -1:
                        break

                    # Extract potential JSON data
                    json_data = buffer[start:end + 1]

                    try:
                        # Try to parse it as JSON
                        response = json.loads(json_data)

                        # If successful, remove from buffer
                        buffer = buffer[end + 1:]

                        # Process the response
                        status = response.get("status", "unknown")

                        if status == "downloading":
                            print(f"Server accepted request: {response.get('message', '')}")

                        elif status == "progress":
                            # Update progress information
                            progress = response.get("progress", 0)
                            filename = response.get("filename", "unknown")
                            received = response.get("received", 0)
                            total = response.get("total", 0)

                            # Update tracking variables
                            last_progress = progress

                            # Calculate speed
                            elapsed = time.time() - start_time
                            speed = received / elapsed if elapsed > 0 else 0

                            # Print progress bar
                            progress_bar = draw_progress_bar(progress)
                            progress_msg = (f"\r{progress_bar} | "
                                            f"{format_size(received)}/{format_size(total)} | "
                                            f"{format_size(speed)}/s")
                            sys.stdout.write(progress_msg)
                            sys.stdout.flush()

                        elif status == "success":
                            print(f"\nDownload completed successfully!")
                            print(f"File: {response.get('filename', 'unknown')}")
                            print(f"Size: {format_size(response.get('size', 0))}")
                            print(f"Saved to: {response.get('path', 'unknown')}")
                            return 0

                        elif status == "error":
                            print(f"\nDownload failed: {response.get('message', 'Unknown error')}")
                            return 1

                    except json.JSONDecodeError:
                        # Not valid JSON - might be incomplete or not JSON at all
                        # Just move past the opening brace and try again
                        buffer = buffer[start + 1:]

            except socket.timeout:
                print("\nTimeout waiting for server response")
                if last_progress > 0:
                    print(f"Download reached {last_progress}% and may be continuing on the server")
                return 1

            except KeyboardInterrupt:
                print("\nOperation cancelled by user")
                return 1

            except Exception as e:
                print(f"\nUnexpected error: {str(e)}")
                return 1

    finally:
        print("\nClosing connection...")
        try:
            sock.close()
        except:
            pass


if __name__ == "__main__":
    sys.exit(main())