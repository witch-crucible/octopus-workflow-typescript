import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { persistenceSchema } from "./db/schema.js"
import {
  createPersistenceStoreFromDatabase,
  type PersistenceDatabase,
  type PersistenceStore,
} from "./persistence.js"

export interface TestPersistence {
  client: PGlite
  store: PersistenceStore
}

/** 在内存 PGlite 中执行生产 migration，并创建同一 repository。 */
export async function createTestPersistenceStore(storeDir = ".octo_test"): Promise<TestPersistence> {
  const client = new PGlite()
  const migrationPath = fileURLToPath(
    new URL("../../../drizzle/0000_reflective_mesmero.sql", import.meta.url),
  )
  await client.exec(await readFile(migrationPath, "utf8"))
  const database = drizzle(client, { schema: persistenceSchema }) as unknown as PersistenceDatabase
  const store = await createPersistenceStoreFromDatabase(database, {
    storeDir,
    close: async () => client.close(),
  })
  return { client, store }
}
