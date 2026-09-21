import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

/** Transaction handle type, extracted so services accept Db or tx. */
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DbOrTx = Db | DbTransaction;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string): DbHandle {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return {
    db,
    close: () => client.end(),
  };
}
