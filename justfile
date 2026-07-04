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

BRDB_CRATE := env_var_or_default("BRDB_CRATE", "../brdb")

# Regenerate cross-language fixtures from the Rust oracle crate and copy them in
[windows]
fixtures:
    cargo run -q --manifest-path {{BRDB_CRATE}}/crates/brdb/Cargo.toml --example write_fixtures
    if (Test-Path test/fixtures/brdb) { Remove-Item -Recurse -Force test/fixtures/brdb }
    New-Item -ItemType Directory -Force test/fixtures/brdb | Out-Null
    Copy-Item -Recurse -Force {{BRDB_CRATE}}/crates/brdb/fixtures/* test/fixtures/brdb/

# Regenerate cross-language fixtures from the Rust oracle crate and copy them in
[unix]
fixtures:
    cargo run -q --manifest-path {{BRDB_CRATE}}/crates/brdb/Cargo.toml --example write_fixtures
    rm -rf test/fixtures/brdb
    mkdir -p test/fixtures/brdb
    cp -r {{BRDB_CRATE}}/crates/brdb/fixtures/* test/fixtures/brdb/

# Regenerate src/brdb/schemas.ts and src/brdb/catalog.ts from the Rust crate
sync-brdb-data:
    node scripts/syncBrdbData.mjs {{BRDB_CRATE}}

# Run the full test suite including the live Rust oracle (needs cargo)
[windows]
test-oracle:
    $env:BRDB_ORACLE = "1"; $env:BRDB_CRATE = "{{BRDB_CRATE}}"; npm test

# Run the full test suite including the live Rust oracle (needs cargo)
[unix]
test-oracle:
    BRDB_ORACLE=1 BRDB_CRATE={{BRDB_CRATE}} npm test

# Run any example by name, e.g. `just example countWires world.brdb`
example NAME *ARGS:
    node examples/{{NAME}}.mjs {{ARGS}}

# Read a .brz or .brdb world and print a summary
example-read FILE:
    node examples/readWorld.mjs "{{FILE}}"

# Write a one-brick world to example_brick.brz and example_brick.brdb
example-write-brick:
    node examples/writeBrick.mjs

# Write a brick carrying a point light component to example_component.brz
example-write-component:
    node examples/writeComponent.mjs
