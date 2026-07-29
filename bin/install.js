#!/usr/bin/env node
"use strict";

// Pre-warms the RavenDB server download cache (for Docker images / CI) and
// clears old versions from it. Thin wrapper over ServerDownloader — all logic
// lives there.
//   pnpm ravendb install              # pinned default version (DEFAULT_SERVER_VERSION)
//   pnpm ravendb install 7.2.5        # specific version (or "latest")
//   pnpm ravendb clear-cache [--keep 7.2.5] [--dir /path/to/cache]

const { ServerDownloader } = require("../dist/ServerDownloader");
const { DEFAULT_SERVER_VERSION } = require("../dist/ServerOptions");

const USAGE =
    "Usage: ravendb install [<version>|latest] [--dir <cache directory>]\n" +
    "       ravendb clear-cache [--keep <x.y.z>]... [--dir <cache directory>] [--yes]\n" +
    `Default version: ${DEFAULT_SERVER_VERSION} (the release this package was tested against).`;

function fail(message) {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(2);
}

function parseFlags(argv, parsed) {
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--dir":
                parsed.dir = argv[++i];
                break;
            case "--keep":
                parsed.keep.push(argv[++i]);
                break;
            case "--yes":
            case "-y":
                parsed.yes = true;
                break;
            case "--help":
            case "-h":
                console.log(USAGE);
                process.exit(0);
                break;
            default:
                fail(`Unknown argument: ${argv[i]}`);
        }
    }
    return parsed;
}

function parseArgs(argv) {
    const parsed = { version: undefined, dir: undefined, clearCache: false, keep: [], yes: false };

    if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(USAGE);
        process.exit(0);
    }

    if (argv[0] === "install") {
        // "install" with no version leaves parsed.version undefined, so
        // downloadServer falls back to the pinned DEFAULT_SERVER_VERSION —
        // same default as the library's auto-download path.
        let rest = argv.slice(1);
        if (rest[0] && !rest[0].startsWith("-")) {
            parsed.version = rest[0];
            rest = rest.slice(1);
        }
        return parseFlags(rest, parsed);
    }

    if (argv[0] === "clear-cache") {
        parsed.clearCache = true;
        return parseFlags(argv.slice(1), parsed);
    }

    fail(argv.length === 0 ? "Missing command." : `Unknown command: ${argv[0]}`);
}

function confirm(question) {
    return new Promise(resolve => {
        const rl = require("node:readline").createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(`${question} (y/n) `, answer => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

async function main() {
    const { version, dir, clearCache, keep, yes } = parseArgs(process.argv.slice(2));

    if (clearCache) {
        if (!yes) {
            const what = keep.length > 0
                ? `all cached RavenDB server instances except ${keep.join(", ")}`
                : "all cached RavenDB server instances";
            const cacheRoot = ServerDownloader.getCacheRoot(dir);
            if (!process.stdin.isTTY) {
                console.error(
                    `Refusing to remove ${what} from ${cacheRoot} without confirmation ` +
                    "in a non-interactive session. Re-run with --yes to skip the prompt.");
                process.exit(2);
            }
            if (!await confirm(`This will remove ${what} from ${cacheRoot}. Are you sure?`)) {
                console.log("Aborted — nothing was removed.");
                return;
            }
        }
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
