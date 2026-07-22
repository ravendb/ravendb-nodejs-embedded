# RavenDB Node.js Embedded Server
You're looking at RavenDB Node.js Embedded Server release.
It lets you to spin-up RavenDB server locally in no-time using friendly API.

RavenDB is a NoSQL database that fuses extreme performance with ease-of-use, offering above the roof developer experience.
Learn more at https://ravendb.net or visit our [GitHub repository](https://github.com/ravendb/ravendb).


## Installation
Install the package together with the [`ravendb`](https://www.npmjs.com/package/ravendb) client:

```bash
npm install ravendb-embedded ravendb
```

No further setup is required: on the first `startServer()` call the package
downloads the RavenDB server binaries for your platform automatically
(Puppeteer-style) and caches them per version, as long as
`licensing.eulaAccepted = true` is set. Download progress is printed to stderr
so the first run never looks like a hang — inject a `logger` to redirect or
silence it. Subsequent starts reuse the cache and make no network calls.
See [Server download details](#server-download-details) for cache location,
version pinning, opt-out and manual installation.

Check the runtime [prerequisites](https://ravendb.net/docs/article-page/server/embedded#prerequisite) in our docs. In short:

- When only `Raven.Server.dll` is present (no native executable), a .NET
  runtime matching `serverOptions.frameworkVersion` must be installed.
- Extraction uses the system `tar` (ships with Windows 10+, Linux and macOS);
  without it, install the server manually (see below).

## Getting started

### Initialize
```ts
import { embeddedServer, ServerOptions } from "ravendb-embedded";

const options = new ServerOptions({
    licensing: { eulaAccepted: true }
});

await embeddedServer.startServer(options);

const store = await embeddedServer.getDocumentStore("Embedded");
const session = store.openSession();
// Your code here

await embeddedServer.dispose();
```

`embeddedServer` is a shared singleton (like `EmbeddedServer.Instance` in C#).
Instantiate `new EmbeddedServer()` for isolated servers (e.g. tests).

Runnable samples live in [`examples/`](examples).

> **EULA semantics:** `licensing.eulaAccepted` gates the automatic binaries
> download and is forwarded to the server as `--License.Eula.Accepted` (same
> as C#) — enforcement of the flag itself is up to the server. A manual
> install in `serverDirectory` is run as-is.

> **Options are snapshotted:** `startServer()` takes a copy of the
> `ServerOptions` object. The caller's object is never mutated (the resolved
> download directory and server URL stay internal — use `getServerUri()`), and
> editing it after the call has no effect on the running server.

> **Start semantics vs C#:** `startServer()` awaits the full server startup, so
> configuration errors surface immediately at the call site. The C#
> `StartServer()` is fire-and-forget — the server boots in the background and
> the first `GetDocumentStore()` call does the waiting. Code ported 1:1 from C#
> will therefore see slightly different timing (errors earlier, first store
> faster), never different results.

`startServer()` also accepts an `AbortSignal` to cancel a startup in flight —
the spawned process is torn down immediately:

```ts
await embeddedServer.startServer(options, AbortSignal.timeout(30_000));
```

### Graceful shutdown on process exit

The server watches its parent process (`--Embedded.ParentProcessId`) and exits
when it dies — that safety net is always on. For a *graceful* shutdown when the
host receives `SIGINT`/`SIGTERM` (Ctrl-C, `kill`, container stop), opt in:

```ts
options.installSignalHandlers = true;
```

On a signal the server is disposed first; the signal is then re-raised only
when your app has no handler of its own, so the process still exits with the
conventional exit code — apps with their own handlers keep full control.
`beforeExit` also disposes the server. This is opt-in (unlike the JVM shutdown
hook and Python `atexit` equivalents, which auto-register) because it changes
process-global signal behavior.

### Store documents
```ts
class Category {
    public id?: string;
    public name?: string;
}

class Product {
    public id?: string;
    public name?: string;
    public category?: string;
    public unitsInStock?: number;
}

const session = store.openSession();               // Open a session on the 'Embedded' database

const category = new Category();
category.name = "Database Category";

await session.store(category);                     // Assign an 'Id' and collection (Categories)
                                                   // and start tracking an entity

const product = new Product();
product.name = "RavenDB Database";
product.category = category.id;
product.unitsInStock = 10;

await session.store(product);                      // Assign an 'Id' and collection (Products)
                                                   // and start tracking an entity

await session.saveChanges();                       // Send to the Server
                                                   // one request processed in one transaction
```

### Query
```ts
const session = store.openSession();               // Open a session on the 'Embedded' database

const productNames = await session
    .query<Product>({ collection: "Products" })    // Query for Products
    .whereGreaterThan("unitsInStock", 5)           // Filter
    .skip(0).take(10)                              // Page
    .selectFields<string>("name")                  // Project
    .all();                                        // Materialize query
```

### Secured server
```ts
options.secured("/path/to/cert.pem");
// PFX: Node cannot parse PKCS#12, pass the thumbprint explicitly:
options.secured("/path/to/cert.pfx", "password", "<server cert thumbprint>");
// Self-signed certificate: pass its PEM as the CA bundle so the client trusts it
// (the counterpart of C#'s RemoteCertificateValidationCallback):
options.secured("/path/to/cert.pfx", "password", "<thumbprint>", "/path/to/cert.pem");
```

The certificate must carry `keyUsage=digitalSignature` and
`extendedKeyUsage=serverAuth` (RavenDB validates both); add `clientAuth` when
the same certificate is used as the client certificate.

#### Certificate from a vault/HSM (external program)

When the server certificate lives in a vault or HSM instead of a file, let the
server obtain it by running an external program
(`--Security.Certificate.Load.Exec`, mirrors the C#
`Secured(certLoadExec, ...)` overload):

```ts
options.securedWithExec(
    "vault-cli",                       // program the server runs
    "get --cert ravendb-server",       // its arguments (raw string)
    "<server cert thumbprint>",        // required — the cert is loaded by the server
    "/path/to/client-cert.pem",        // client certificate for document stores
    undefined,                         // client certificate password, if any
    "/path/to/ca.pem"                  // CA bundle the client should trust
);
```

The client certificate's thumbprint is registered as the server admin
certificate. For a PEM client certificate it is computed automatically; for
PFX the `serverCertThumbprint` value is used as a fallback (correct when the
same certificate secures the server and authenticates the client).

#### Server certificate trust (no thumbprint pinning)

The C# package pins the server certificate by thumbprint via a global
`RemoteCertificateValidationCallback`. The `ravendb` Node client exposes no
certificate-validation hook (its auth options are only
`type`/`certificate`/`password`/`ca`), so thumbprint pinning is **not
available** in this package. Trust the server through the `ca` option instead:
for a self-signed server certificate, its own PEM *is* the CA — pass it as
`caCertificatePath` (shown above). The `serverCertThumbprint` parameters exist
for C# API parity and the PFX fallback described above.

### Logging
Silent by default, with one exception: automatic server download progress goes
to stderr, so a ~350 MB first-run download never looks like a hang. Inject any
logger implementing `debug`/`info`/`warn` to redirect everything — or
`noopLogger` for full silence:

```ts
import type { Logger } from "ravendb-embedded";

options.logger = {
    debug: message => console.debug(message),
    info: message => console.info(message),
    warn: (message, error) => console.warn(message, error)
};
```

Log points mirror the C# package: server start (PID), graceful shutdown,
kill fallback, document store creation, database-already-exists — plus
download progress.

## Server download details

- **Cache location:** `%LOCALAPPDATA%\ravendb-embedded\{version}-{platform}` on
  Windows, `$XDG_CACHE_HOME/ravendb-embedded/{version}-{platform}` (default
  `~/.cache/ravendb-embedded/...`) elsewhere. Override with
  `serverOptions.downloadCacheDirectory` or `RAVENDB_EMBEDDED_CACHE_DIR`.
- **Version:** `serverOptions.serverVersion` or
  `RAVENDB_EMBEDDED_SERVER_VERSION`. The default is pinned to the server
  release this package version was built and tested against (exported as
  `DEFAULT_SERVER_VERSION`; the package version tracks it, same as the
  Python and Java embedded packages), so builds are deterministic. Set
  `"latest"` to opt into the current stable release instead — it resolves
  once and then stays pinned in the cache (`latest-*.version` marker), so
  later runs are offline and deterministic; delete the marker to move.
- **Opt out:** set `serverOptions.downloadServer = false` or
  `RAVENDB_EMBEDDED_SKIP_DOWNLOAD=1`.
- **Manual installation always wins:** extract the distribution from
  https://ravendb.net/download into `./RavenDBServer` (or any directory passed
  via `serverOptions.serverDirectory`) — the zip can be extracted as-is, its
  nested `Server/` subdirectory is detected automatically. When binaries are
  present, the network is never touched. A custom `serverDirectory` is treated
  as user-managed and is never downloaded into.
- **Pre-warm the cache** (Docker images, CI):

  ```bash
  npx ravendb-embedded-install [--version 7.2.4] [--dir /path/to/cache]
  ```

- **Integrity:** downloads run over HTTPS and are verified against the
  response `Content-Length` (truncated downloads are rejected). RavenDB does
  not publish a checksum manifest for its distributions yet, so a stronger
  check is not possible.
- **Clear the cache** (old versions accumulate, one distribution per
  version+platform):

  ```bash
  npx ravendb-embedded-install --clear-cache [--keep 7.2.5] [--dir /path/to/cache]
  ```

  or from code: `ServerDownloader.clearCache({ keepVersions: ["7.2.5"] })`.

## Learning resources
- **Embedded Server Guide** - https://ravendb.net/articles/building-a-beer-vending-machine-program-with-ravendb-embedded-server 🛣️
- **Documentation** - https://ravendb.net/docs/article-page/server/embedded 🎒
- Code Samples - https://demo.ravendb.net/ 🧑‍💻

## Community
- **RavenDB's Discord** - https://discord.gg/ravendb 🍻
- Articles & guides - https://ravendb.net/articles 📰
- YouTube - https://www.youtube.com/@ravendb_net 🍿
- Blog - https://ayende.com/blog/ 🧑‍💻

## Tests
- `npm run test:unit` — no server needed
- `npm run test:integration` — requires binaries in `./RavenDBServer`;
  the secured scenario additionally requires `openssl` on PATH (skipped otherwise);
  the download scenario is opt-in via `RAVENDB_EMBEDDED_TEST_DOWNLOAD=1`
  (fetches a full ~350 MB distribution)

## Contributing
- Submit an issue - https://github.com/ravendb/ravendb/issues
- GitHub Discussions - https://github.com/ravendb/ravendb/discussions
- Contributing rules - https://github.com/ravendb/ravendb/blob/v7.2/CONTRIBUTING.md
