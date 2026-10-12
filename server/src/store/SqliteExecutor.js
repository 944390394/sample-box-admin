/**
 * 一条 SQLite 连接上的执行器。
 * 语句和事务都排进同一条队列：事务占用连接期间，别的请求不能插进来。
 * 回调里只能使用传入的会话，再调用外层 all/run 会等自己手里的锁。
 */
export class SqliteExecutor {
  constructor(database) {
    this.database = database;
    this.dialect = "sqlite";
    this.tail = Promise.resolve();
  }

  exec(sql) {
    return this.#enqueue(() => {
      this.database.exec(sql);
    });
  }

  all(sql, params = []) {
    return this.#enqueue(() => this.database.prepare(sql).all(...params));
  }

  get(sql, params = []) {
    return this.#enqueue(() => this.database.prepare(sql).get(...params));
  }

  run(sql, params = []) {
    return this.#enqueue(() => this.database.prepare(sql).run(...params));
  }

  transaction(fn) {
    return this.#enqueue(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      const session = new SqliteSession(this.database);
      try {
        const value = await fn(session);
        this.database.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // 连接已经不可用时，保留业务错误。
        }
        throw error;
      }
    });
  }

  close() {
    return this.#enqueue(() => {
      this.database.close();
    });
  }

  #enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** 事务内部的执行器。不再排队，避免和正在持有的锁互相等待。 */
class SqliteSession {
  constructor(database) {
    this.database = database;
    this.dialect = "sqlite";
  }

  all(sql, params = []) {
    return this.database.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.database.prepare(sql).get(...params);
  }

  run(sql, params = []) {
    return this.database.prepare(sql).run(...params);
  }
}
