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

Check the runtime [prerequisites](https://ravendb.net/docs/article-page/server/embedded#prerequisite) in our docs. In short:

- RavenDB server binaries extracted into `./RavenDBServer` (or any directory
  passed via `serverOptions.serverDirectory`). Download from
  https://ravendb.net/download — the distribution zip can be extracted as-is,
  its nested `Server/` subdirectory is detected automatically.
  This package does not download the server.
- When only `Raven.Server.dll` is present (no native executable), a .NET
  runtime matching `serverOptions.frameworkVersion` must be installed.

## Learning resources
- **Embedded Server Guide** - https://ravendb.net/articles/building-a-beer-vending-machine-program-with-ravendb-embedded-server 🛣️
- **Documentation** - https://ravendb.net/docs/article-page/server/embedded 🎒
- Code Samples - https://demo.ravendb.net/ 🧑‍💻

## Community
- **RavenDB's Discord** - https://discord.gg/ravendb 🍻
- Articles & guides - https://ravendb.net/articles 📰
- YouTube - https://www.youtube.com/@ravendb_net 🍿
- Blog - https://ayende.com/blog/ 🧑‍💻


## Getting started

### Initialize
```ts
import { embeddedServer, ServerOptions } from "ravendb-embedded";

const options = new ServerOptions();
options.licensing.eulaAccepted = true;

await embeddedServer.startServer(options);

const store = await embeddedServer.getDocumentStore("Embedded");
const session = store.openSession();
// Your code here

await embeddedServer.dispose();
```

`embeddedServer` is a shared singleton (like `EmbeddedServer.Instance` in C#).
Instantiate `new EmbeddedServer()` for isolated servers (e.g. tests).

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

const session = store.openSession();               // Open a session for a default 'Database'

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
const session = store.openSession();               // Open a session for a default 'Database'

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

### Logging
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
- `npm run test:unit` — no server needed
- `npm run test:integration` — requires binaries in `./RavenDBServer`;
  the secured scenario additionally requires `openssl` on PATH (skipped otherwise)

## Contributing
- Submit an issue - https://github.com/ravendb/ravendb/issues
- GitHub Discussions - https://github.com/ravendb/ravendb/discussions
- Contributing rules - https://github.com/ravendb/ravendb/blob/v7.2/CONTRIBUTING.md
