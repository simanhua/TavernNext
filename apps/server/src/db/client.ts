import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle, type SQLJsDatabase } from 'drizzle-orm/sql-js';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js/dist/sql-asm.js';
import * as schema from './schema.js';

type SqlValue = number | string | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

interface PersistenceState {
  raw: SqlJsDatabase;
  rootOrm: SQLJsDatabase<typeof schema>;
  activeOrm: SQLJsDatabase<typeof schema> | undefined;
  transactionDepth: number;
  dirty: boolean;
  lastPersisted: Uint8Array | undefined;
  temporaryFileNumber: number;
}

class SqliteStatement {
  constructor(
    private readonly rawDatabase: () => SqlJsDatabase,
    private readonly sql: string,
    private readonly markDirty: () => void,
  ) {}

  all(...parameters: SqlValue[]): SqlRow[] {
    const statement = this.rawDatabase().prepare(this.sql);
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
    const statement = this.rawDatabase().prepare(this.sql);
    try {
      statement.bind(parameters);
      return statement.step() ? statement.getAsObject() : undefined;
    } finally {
      statement.free();
    }
  }

  run(...parameters: SqlValue[]): { changes: number } {
    const database = this.rawDatabase();
    database.run(this.sql, parameters);
    const changes = database.getRowsModified();
    this.markDirty();
    return { changes };
  }
}

export class SqliteConnection {
  constructor(
    private readonly rawDatabase: () => SqlJsDatabase,
    private readonly markDirty: () => void,
  ) {}

  exec(sql: string): void {
    this.rawDatabase().run(sql);
    this.markDirty();
  }

  pragma(value: string): void {
    this.rawDatabase().run(`PRAGMA ${value}`);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.rawDatabase, sql, this.markDirty);
  }
}

export interface TavernDatabase {
  readonly sqlite: SqliteConnection;
  readonly orm: SQLJsDatabase<typeof schema>;
  persist(): void;
  transaction<T>(work: () => T): T;
  close(): void;
}

const SQL = await initSqlJs();

export function createDatabase(path: string): TavernDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const initialImage = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  const state: PersistenceState = {
    raw: new SQL.Database(initialImage),
    rootOrm: undefined as unknown as SQLJsDatabase<typeof schema>,
    activeOrm: undefined,
    transactionDepth: 0,
    dirty: false,
    lastPersisted: initialImage,
    temporaryFileNumber: 0,
  };

  const configureConnection = () => {
    state.raw.run('PRAGMA foreign_keys = ON');
    state.raw.run('PRAGMA journal_mode = WAL');
    state.raw.run('PRAGMA busy_timeout = 5000');
  };
  const createOrm = () => drizzle(state.raw, { schema });
  const restorePersistedState = () => {
    state.raw.close();
    state.raw = new SQL.Database(state.lastPersisted);
    configureConnection();
    state.rootOrm = createOrm();
    state.activeOrm = undefined;
  };
  const flush = () => {
    const temporaryPath = `${path}.tavernnext-${process.pid}-${state.temporaryFileNumber += 1}.tmp`;
    try {
      const image = state.raw.export();
      writeFileSync(temporaryPath, image);
      renameSync(temporaryPath, path);
      state.lastPersisted = image;
      configureConnection();
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      restorePersistedState();
      throw error;
    }
  };
  const markDirty = () => {
    if (state.transactionDepth > 0) {
      state.dirty = true;
      return;
    }
    flush();
  };

  configureConnection();
  state.rootOrm = createOrm();
  const sqlite = new SqliteConnection(() => state.raw, markDirty);
  const database: TavernDatabase = {
    sqlite,
    get orm() {
      return state.activeOrm ?? state.rootOrm;
    },
    persist: markDirty,
    transaction(work) {
      if (state.transactionDepth > 0) return work();

      try {
        const result = state.rootOrm.transaction((transaction) => {
          state.transactionDepth += 1;
          state.activeOrm = transaction as SQLJsDatabase<typeof schema>;
          try {
            return work();
          } finally {
            state.activeOrm = undefined;
            state.transactionDepth -= 1;
          }
        });
        if (state.dirty) {
          state.dirty = false;
          flush();
        }
        return result;
      } catch (error) {
        state.dirty = false;
        throw error;
      }
    },
    close() {
      if (state.dirty) {
        state.dirty = false;
        flush();
      }
      state.raw.close();
    },
  };
  return database;
}
