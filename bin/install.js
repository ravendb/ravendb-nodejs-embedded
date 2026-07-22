#!/usr/bin/env node
"use strict";

// Pre-warms the RavenDB server download cache (for Docker images / CI) and
// clears old versions from it. Thin wrapper over ServerDownloader — all logic
// lives there.
//   npx ravendb-embedded-install [--version 7.2.5] [--dir /path/to/cache]
//   npx ravendb-embedded-install --clear-cache [--keep 7.2.5] [--dir /path/to/cache]

const { ServerDownloader } = require("../dist/ServerDownloader");
const { DEFAULT_SERVER_VERSION } = require("../dist/ServerOptions");

const USAGE =
    "Usage: ravendb-embedded-install [--version <x.y.z>|latest] [--dir <cache directory>]\n" +
    "       ravendb-embedded-install --clear-cache [--keep <x.y.z>]... [--dir <cache directory>]\n" +
    `Default version: ${DEFAULT_SERVER_VERSION} (the release this package was tested against)`;

function parseArgs(argv) {
    const parsed = { version: undefined, dir: undefined, clearCache: false, keep: [] };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--version":
                parsed.version = argv[++i];
                break;
            case "--dir":
                parsed.dir = argv[++i];
                break;
            case "--clear-cache":
                parsed.clearCache = true;
                break;
            case "--keep":
                parsed.keep.push(argv[++i]);
                break;
            case "--help":
            case "-h":
                console.log(USAGE);
                process.exit(0);
                break;
            default:
                console.error(`Unknown argument: ${argv[i]}`);
                process.exit(2);
        }
    }
    return parsed;
}

async function main() {
    const { version, dir, clearCache, keep } = parseArgs(process.argv.slice(2));

    if (clearCache) {
        const removed = ServerDownloader.clearCache({ cacheDirectory: dir, keepVersions: keep });
        if (removed.length === 0) {
            console.log("Cache is already empty — nothing to remove.");
        } else {
            for (const entry of removed) {
                console.log(`Removed: ${entry}`);
            }
        }
        return;
    }

    // No logger override: the default stderr logger draws an in-place progress
    // bar on a TTY, same as the auto-download path in EmbeddedServer.start().
    const installDir = await ServerDownloader.downloadServer({
        version,
        cacheDirectory: dir
    });
    console.log(`RavenDB server is ready in: ${installDir}`);
}

main().catch(error => {
    console.error(error.message ?? error);
    process.exit(1);
});
