import { buildApp } from './api/app.js';
import { loadDotEnv } from './config/dotenv.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { registerSecrets } from './lib/redact.js';
import { openDatabase, runMigrations } from './storage/db.js';
import { Repositories } from './storage/repositories.js';

async function main() {
  loadDotEnv();
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  registerSecrets([env.ANTHROPIC_API_KEY, env.GEMINI_API_KEY, env.JINA_API_KEY, env.TAVILY_API_KEY, env.EXA_API_KEY, env.GITHUB_TOKEN]);

  const db = openDatabase(env.DATABASE_PATH);
  runMigrations(db);
  const interrupted = new Repositories(db).markOrphanedExecutionsInterrupted();

  const app = await buildApp({ env, db });
  if (interrupted > 0) app.log.warn({ interrupted }, 'marked executions from a previous run as interrupted');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close(); // aborts running executions via the coordinator
    } finally {
      new Repositories(db).markOrphanedExecutionsInterrupted();
      db.close();
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
