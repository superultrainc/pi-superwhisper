#!/bin/bash
set -e

PACKAGE="@superwhisper/pi"

if ! command -v pi >/dev/null 2>&1; then
    echo "Error: pi is not installed."
    echo "Install pi first: https://github.com/badlogic/pi-mono"
    exit 1
fi

echo "Installing $PACKAGE via pi..."
pi install "npm:$PACKAGE"

echo "Superwhisper extension installed."
echo "Start a new pi session to activate."

open "superwhisper://agent-installed?agent=pi" 2>/dev/null || true
