import { loadDotEnv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { openDatabase, runMigrations } from './db.js';

loadDotEnv();
const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH);
const { applied, current } = runMigrations(db);
db.close();
console.warn(
  applied.length > 0
    ? `Applied migrations ${applied.join(', ')}; schema now at version ${current} (${env.DATABASE_PATH})`
    : `Schema already up to date at version ${current} (${env.DATABASE_PATH})`,
);
