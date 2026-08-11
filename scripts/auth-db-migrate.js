'use strict';

const { createBetterAuthAdapter } = require('../apps/api/better-auth-adapter');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const adapter = createBetterAuthAdapter();
  const result = await adapter.migrateSchema({ dryRun });
  if (dryRun) {
    console.log(result.sql || '-- Better Auth schema is already up to date.');
    return;
  }
  console.log('auth db migration completed');
  if (result.toBeCreated.length) console.log(`created tables: ${result.toBeCreated.join(', ')}`);
  if (result.toBeAdded.length) console.log(`updated tables: ${result.toBeAdded.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
