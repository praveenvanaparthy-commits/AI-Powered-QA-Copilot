#!/bin/bash
set -e

echo "Installing dependencies from backend directory..."
cd backend
npm install
echo "Build complete!"
