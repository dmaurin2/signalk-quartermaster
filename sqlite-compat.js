'use strict';
// Small callback adapter for Quartermaster's existing database calls.
// Uses Node 24's built-in SQLite so App Store installs need no native build scripts.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const OPEN_READONLY = 1, OPEN_READWRITE = 2;
class Database {
  constructor(filename, mode, callback) {
    if (typeof mode === 'function') { callback = mode; mode = undefined; }
    setImmediate(() => {
      let error = null;
      try {
        if (mode === OPEN_READWRITE && !fs.existsSync(filename)) throw new Error('Database does not exist');
        this.connection = new DatabaseSync(filename, { readOnly: mode === OPEN_READONLY });
        this.connection.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      } catch (caught) { error = caught; this.openError = caught; }
      if (callback) callback(error);
    });
  }
  serialize(callback) { callback(); return this; }
  operation(kind, sql, args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    const parameters = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    setImmediate(() => {
      let error = null, value, context = this;
      try {
        if (!this.connection) throw this.openError || new Error('Database closed');
        if (kind === 'exec') this.connection.exec(sql);
        else {
          const statement = this.connection.prepare(sql);
          if (kind === 'run') {
            const result = statement.run(...parameters);
            context = { changes: Number(result.changes), lastID: Number(result.lastInsertRowid) };
          } else value = statement[kind](...parameters);
        }
      } catch (caught) { error = caught; }
      if (callback) callback.call(context, error, value);
    });
    return this;
  }
  run(sql, ...args) { return this.operation('run', sql, args); }
  get(sql, ...args) { return this.operation('get', sql, args); }
  all(sql, ...args) { return this.operation('all', sql, args); }
  exec(sql, ...args) { return this.operation('exec', sql, args); }
  close(callback) {
    setImmediate(() => {
      let error = null;
      try { if (this.connection) { this.connection.close(); this.connection = null; } }
      catch (caught) { error = caught; }
      if (callback) callback(error);
    });
  }
}
module.exports = { Database, OPEN_READONLY, OPEN_READWRITE, verbose() { return this; } };
