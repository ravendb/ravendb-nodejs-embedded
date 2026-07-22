// Minimal end-to-end example: start the server, store a document, query it back.
//
// Run from a project that has both packages installed:
//   npm install ravendb-embedded ravendb
//   node quickstart.mjs
//
// The first run downloads the RavenDB server binaries (~350 MB, progress on
// stderr) and caches them per version — later runs start offline in seconds.
import { embeddedServer, ServerOptions } from "ravendb-embedded";

class Product {
    constructor(name, unitsInStock) {
        this.name = name;
        this.unitsInStock = unitsInStock;
    }
}

const options = new ServerOptions({
    licensing: { eulaAccepted: true }, // review https://ravendb.net/legal first
    installSignalHandlers: true        // graceful shutdown on Ctrl-C / SIGTERM
});

await embeddedServer.startServer(options);
console.log("Server is up at", await embeddedServer.getServerUri());

const store = await embeddedServer.getDocumentStore("Quickstart");

{
    const session = store.openSession();
    await session.store(new Product("RavenDB Database", 10)); // collection: Products
    await session.saveChanges();
}

{
    const session = store.openSession();
    const inStock = await session
        .query({ collection: "Products" })
        .whereGreaterThan("unitsInStock", 5)
        .all();
    console.log("In stock:", inStock);
}

// Uncomment to inspect the database in RavenDB Studio:
// await embeddedServer.openStudioInBrowser();

await embeddedServer.dispose();
