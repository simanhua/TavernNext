import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle, type SQLJsDatabase } from 'drizzle-orm/sql-js';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js/dist/sql-asm.js';
import * as schema from './schema.js';

type SqlValue = number | string | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

class SqliteStatement {
  constructor(
    private readonly database: SqlJsDatabase,
    private readonly sql: string,
    private readonly persist: () => void,
  ) {}

  all(...parameters: SqlValue[]): SqlRow[] {
    const statement = this.database.prepare(this.sql);
    try {
      statement.bind(parameters);
      const rows: SqlRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  get(...parameters: SqlValue[]): SqlRow | undefined {
    const statement = this.database.prepare(this.sql);
    try {
      statement.bind(parameters);
      return statement.step() ? statement.getAsObject() : undefined;
    } finally {
      statement.free();
    }
  }

  run(...parameters: SqlValue[]): { changes: number } {
    this.database.run(this.sql, parameters);
    const changes = this.database.getRowsModified();
    this.persist();
    return { changes };
  }
}

export class SqliteConnection {
  constructor(
    private readonly database: SqlJsDatabase,
    private readonly persistDatabase: () => void,
  ) {}

  exec(sql: string): void {
    this.database.run(sql);
    this.persistDatabase();
  }

  pragma(value: string): void {
    this.database.run(`PRAGMA ${value}`);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, this.persistDatabase);
  }
}

export interface TavernDatabase {
  sqlite: SqliteConnection;
  orm: SQLJsDatabase<typeof schema>;
  persist(): void;
}

const SQL = await initSqlJs();

export function createDatabase(path: string): TavernDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const rawDatabase = new SQL.Database(existsSync(path) ? readFileSync(path) : undefined);
  const configureConnection = () => {
    rawDatabase.run('PRAGMA foreign_keys = ON');
    rawDatabase.run('PRAGMA journal_mode = WAL');
    rawDatabase.run('PRAGMA busy_timeout = 5000');
  };
  const persist = () => {
    writeFileSync(path, rawDatabase.export());
    configureConnection();
  };
  const sqlite = new SqliteConnection(rawDatabase, persist);
  configureConnection();
  return { sqlite, orm: drizzle(rawDatabase, { schema }), persist };
}
