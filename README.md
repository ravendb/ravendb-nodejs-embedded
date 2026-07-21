# ravendb-embedded (Node.js)

Runs a local RavenDB server as a child process and hands out `DocumentStore`
instances from the [`ravendb`](https://www.npmjs.com/package/ravendb) client.
Node.js port of the C# `RavenDB.Embedded` package.

## Prerequisites

- RavenDB server binaries extracted into `./RavenDBServer` (or any directory
  passed via `serverOptions.serverDirectory`). Download from
  https://ravendb.net/download. This package does not download the server.
  The distribution zip can be extracted as-is — its nested `Server/`
  subdirectory is detected automatically.
- When only `Raven.Server.dll` is present (no native executable), a .NET
  runtime matching `serverOptions.frameworkVersion` must be installed.

## Usage

```ts
import { embeddedServer, ServerOptions } from "ravendb-embedded";

const options = new ServerOptions();
options.licensing.eulaAccepted = true;

await embeddedServer.startServer(options);

const store = await embeddedServer.getDocumentStore("mydb");
const session = store.openSession();
// ... regular ravendb client usage

await embeddedServer.dispose();
```

`embeddedServer` is a shared singleton (like `EmbeddedServer.Instance` in C#).
Instantiate `new EmbeddedServer()` for isolated servers (e.g. tests).

## Secured servers

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

## Logging

Silent by default. Inject any logger implementing `debug`/`info`/`warn`:

```ts
import type { Logger } from "ravendb-embedded";

options.logger = {
    debug: message => console.debug(message),
    info: message => console.info(message),
    warn: (message, error) => console.warn(message, error)
};
```

Log points mirror the C# package: server start (PID), graceful shutdown,
kill fallback, document store creation, database-already-exists.

## Tests

- `pnpm test:unit` — no server needed
- `pnpm test:integration` — requires binaries in `./RavenDBServer`;
  the secured scenario additionally requires `openssl` on PATH (skipped otherwise)
