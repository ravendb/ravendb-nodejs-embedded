import type { DatabaseRecord, DocumentConventions } from "ravendb";

export class DatabaseOptions {
    public skipCreatingDatabase = false;
    public conventions?: DocumentConventions;
    public readonly databaseRecord: DatabaseRecord;

    public constructor(database: string | DatabaseRecord) {
        this.databaseRecord = typeof database === "string"
            ? { databaseName: database }
            : database;
    }
}
