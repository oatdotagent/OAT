import { loadDotEnv } from './config/dotenv.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { serve } from './serve.js';

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
  await serve(env);
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
