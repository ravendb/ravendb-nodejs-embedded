#!/usr/bin/env node
"use strict";

// Pre-warms the RavenDB server download cache (for Docker images / CI).
// Thin wrapper over ServerDownloader — all logic lives there.
//   npx ravendb-embedded-install [--version 7.2.5] [--dir /path/to/cache]

const { ServerDownloader } = require("../dist/ServerDownloader");

function parseArgs(argv) {
    const parsed = { version: undefined, dir: undefined };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--version":
                parsed.version = argv[++i];
                break;
            case "--dir":
                parsed.dir = argv[++i];
                break;
            case "--help":
            case "-h":
                console.log("Usage: ravendb-embedded-install [--version <x.y.z>|latest] [--dir <cache directory>]");
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
    const { version, dir } = parseArgs(process.argv.slice(2));
    const logger = {
        debug: message => console.log(message),
        info: message => console.log(message),
        warn: (message, error) => console.warn(message, error ?? "")
    };

    const installDir = await ServerDownloader.downloadServer({
        version,
        cacheDirectory: dir,
        logger
    });
    console.log(`RavenDB server is ready in: ${installDir}`);
}

main().catch(error => {
    console.error(error.message ?? error);
    process.exit(1);
});
