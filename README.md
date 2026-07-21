# ravendb-embedded (Node.js)

Runs a local RavenDB server as a child process and hands out `DocumentStore`
instances from the [`ravendb`](https://www.npmjs.com/package/ravendb) client.
Node.js port of the C# `RavenDB.Embedded` package.

## Prerequisites

- RavenDB server binaries extracted into `./RavenDBServer` (or any directory
  passed via `serverOptions.serverDirectory`). Download from
  https://ravendb.net/download. This package does not download the server.
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
```

## Tests

- `pnpm test:unit` — no server needed
- `pnpm test:integration` — requires binaries in `./RavenDBServer`
