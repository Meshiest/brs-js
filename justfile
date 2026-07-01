set windows-shell := ["powershell", "-NoProfile", "-Command"]

# List available recipes
default:
    @just --list

# Install dependencies
install:
    npm install

# Build all targets (web + node) and type declarations
build:
    npm run build

# Rebuild on change
watch:
    npm run watch

# Production build
dist:
    npm run dist

# Run the test suite
test:
    npm test
