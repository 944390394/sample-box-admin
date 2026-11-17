import { ensureSchema } from "../src/store/schema.js";

/** 操作日志表，以及旧库上缺的列和索引。已经记下的版本之后，启动仍会再补一次。 */
export async function up(db) {
  await ensureSchema(db);
}
