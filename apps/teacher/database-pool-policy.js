'use strict';

const DATABASE_POOL_BOOTSTRAP = Object.freeze({
  maxPoolSize: 5,
  connectionTimeoutMs: 5000
});

function createTeacherDatabasePool(options = {}, purpose = 'AI Teacher database') {
  const connectionString = options.connectionString
    || process.env.AI_TEACHER_DB_URL
    || process.env.DATABASE_URL;
  if (!connectionString) throw new Error(`AI_TEACHER_DB_URL or DATABASE_URL is required for ${purpose}`);
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    max: positiveInteger(
      options.maxPoolSize ?? process.env.AI_TEACHER_DB_POOL_MAX,
      DATABASE_POOL_BOOTSTRAP.maxPoolSize,
      'AI_TEACHER_DB_POOL_MAX'
    ),
    connectionTimeoutMillis: positiveInteger(
      options.connectionTimeoutMillis ?? process.env.AI_TEACHER_DB_CONNECT_TIMEOUT_MS,
      DATABASE_POOL_BOOTSTRAP.connectionTimeoutMs,
      'AI_TEACHER_DB_CONNECT_TIMEOUT_MS'
    )
  });
}

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return number;
}

module.exports = {
  DATABASE_POOL_BOOTSTRAP,
  createTeacherDatabasePool
};
