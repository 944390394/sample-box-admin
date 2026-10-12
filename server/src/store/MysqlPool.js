/**
 * MySQL 连接池。管理接口和设备接入共用，避免整站只有一条连接。
 * 箱号分配必须走 transaction，LAST_INSERT_ID 在池化后会落到别的连接上。
 */
export class MysqlPool {
  constructor(pool) {
    this.pool = pool;
    this.dialect = "mysql";
  }

  static async connect(config) {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({
      host: config.host,
      port: Number(config.port) || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 20,
      timezone: "+08:00",
    });
    return new MysqlPool(pool);
  }

  async all(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  async run(sql, params = []) {
    const [result] = await this.pool.execute(sql, params);
    return result;
  }

  /**
   * 在同一条连接上执行事务。fn 收到的执行器和 all/get/run 用法相同。
   */
  async transaction(fn) {
    const connection = await this.pool.getConnection();
    const tx = {
      dialect: "mysql",
      async all(sql, params = []) {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      async get(sql, params = []) {
        const rows = await this.all(sql, params);
        return rows[0];
      },
      async run(sql, params = []) {
        const [result] = await connection.execute(sql, params);
        return result;
      },
    };
    try {
      await connection.beginTransaction();
      const value = await fn(tx);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
