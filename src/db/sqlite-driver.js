/**
 * src/db/sqlite-driver.js
 * ───────────────────────────────────────────────────────────────────────
 * SQLite-এর জন্য একটি সরু (thin) driver wrapper।
 *
 * দুইটি ইঞ্জিন সাপোর্ট করা হয়েছে:
 *   ১) better-sqlite3  — native module, সবচেয়ে দ্রুত (থাকলে এটিই ব্যবহৃত হয়)
 *   ২) node:sqlite     — Node.js 22.5+ এর বিল্ট-ইন SQLite (native build
 *                        ব্যর্থ হলে fallback; কোনো compile দরকার নেই)
 *
 * দুই ইঞ্জিনের API প্রায় একই (prepare/run/get/all), তাই এখানে একটি common
 * interface দেওয়া হলো — উপরের repository লেয়ার জানে না কোনটি চলছে।
 *
 * নিরাপত্তা: এখানে কখনো string concatenation দিয়ে SQL বানানো হয় না,
 * সব query prepared statement + parameter binding ব্যবহার করে (SQL injection
 * প্রতিরোধ)।
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * প্যারামিটার নরমালাইজেশন — node:sqlite boolean/undefined বাইন্ড করতে পারে না,
 * তাই সব boolean → 0/1 এবং undefined → null করা হয়।
 */
function normalizeParams(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

/** null-prototype row কে সাধারণ object-এ রূপান্তর (JSON serialize-এর জন্য) */
const plain = (row) => (row ? Object.assign({}, row) : row);

function openDatabase(file) {
  // ডাটাবেস ফাইলের ডিরেক্টরি না থাকলে তৈরি করা হয় (data/.gitkeep)
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let raw;
  let impl;

  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const Database = require('better-sqlite3');
    raw = new Database(file);
    impl = 'better-sqlite3';
  } catch (err) {
    const { DatabaseSync } = require('node:sqlite');
    raw = new DatabaseSync(file);
    impl = 'node:sqlite';
  }

  logger.info(`[db] SQLite ইঞ্জিন: ${impl} → ${file}`);

  // WAL mode: একই সময়ে read ও write — real-time chat-এ concurrency ভালো হয়
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  // prepared statement cache — একই SQL বারবার prepare করার খরচ বাঁচায়
  const cache = new Map();
  const prepare = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  let depth = 0; // nested transaction গণনা

  return {
    impl,
    file,

    /** স্কিমা/একাধিক statement চালানোর জন্য */
    exec(sql) {
      raw.exec(sql);
    },

    /** INSERT/UPDATE/DELETE → { changes, lastInsertRowid } */
    run(sql, params = []) {
      return prepare(sql).run(...normalizeParams(params));
    },

    /** একটি row */
    get(sql, params = []) {
      return plain(prepare(sql).get(...normalizeParams(params)));
    },

    /** সব row */
    all(sql, params = []) {
      return prepare(sql).all(...normalizeParams(params)).map(plain);
    },

    /**
     * সিঙ্ক্রোনাস transaction. better-sqlite3 ও node:sqlite দুটোতেই কাজ করে
     * এমনভাবে ম্যানুয়াল BEGIN/COMMIT ব্যবহার করা হয়েছে। nested call হলে
     * ভিতরের গুলো শুধু callback চালায় (savepoint প্রয়োজন নেই এই অ্যাপে)।
     */
    transaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch (rollbackErr) {
          logger.error('[db] ROLLBACK ব্যর্থ', rollbackErr.message);
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },

    close() {
      cache.clear();
      raw.close();
    }
  };
}

module.exports = { openDatabase };
