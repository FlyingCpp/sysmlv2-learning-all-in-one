'use strict';

const crypto = require('crypto');
const { createAccountStore } = require('../apps/api/account-store');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUserId = args['user-id'] || args.user || '';
  const targetEmail = args.email || '';
  const apply = Boolean(args.apply);
  const verifyEmail = Boolean(args['verify-email']);
  const confirmUserId = args['confirm-user-id'] || '';
  const confirmEmail = args['confirm-email'] || '';
  if (apply) {
    const userIdConfirmed = targetUserId && confirmUserId && confirmUserId === targetUserId;
    const emailConfirmed = targetEmail && confirmEmail && confirmEmail.toLowerCase() === targetEmail.toLowerCase();
    if (!userIdConfirmed && !emailConfirmed) {
      throw new Error('--apply requires an explicit matching confirmation argument.');
    }
  }
  if (verifyEmail) {
    if (!apply) throw new Error('--verify-email requires --apply.');
    if (!targetEmail) throw new Error('--verify-email requires --email.');
    if (!confirmEmail || confirmEmail.toLowerCase() !== targetEmail.toLowerCase()) {
      throw new Error('--verify-email requires --confirm-email matching --email.');
    }
  }
  const requestId = args['request-id'] || `bootstrap_${crypto.randomUUID()}`;
  const emailVerification = verifyEmail
    ? await markEmailVerified({ targetEmail, actor: args.actor || 'owner-bootstrap', requestId })
    : null;
  const store = createAccountStore();
  const result = await store.bootstrapAdmin({
    targetUserId,
    targetEmail,
    apply,
    actor: args.actor || 'owner-bootstrap',
    requestId
  });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    emailVerification,
    user: result.user,
    missingEntitlements: result.missingEntitlements,
    resultingEntitlementCodes: result.resultingEntitlements.map((item) => item.code)
  }, null, 2));
  if (!apply) console.log('Dry run only. Re-run with --apply and a matching confirmation argument.');
}

async function markEmailVerified({ targetEmail, actor, requestId }) {
  const databaseUrl = process.env.AUTH_DATABASE_URL || process.env.BETTER_AUTH_DATABASE_URL || '';
  if (!databaseUrl) throw new Error('AUTH_DATABASE_URL is required for email verification bootstrap.');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const email = String(targetEmail || '').trim().toLowerCase();
    const userResult = await pool.query(
      `select id, email, name, "emailVerified" as email_verified
         from "user"
        where lower(email) = $1
        limit 2`,
      [email]
    );
    if (userResult.rows.length !== 1) {
      throw new Error(userResult.rows.length ? 'email verification target is ambiguous.' : 'email verification target user not found.');
    }
    const row = userResult.rows[0];
    if (!row.email_verified) {
      await pool.query('update "user" set "emailVerified" = true where id = $1', [row.id]);
      await pool.query(
        `insert into auth_audit_events (user_id, event_type, provider, request_id, metadata_json)
         values ($1, 'auth.email.verified_by_owner', 'owner-bootstrap', $2, $3)`,
        [row.id, requestId, JSON.stringify({ actor, targetEmail: row.email, reason: 'owner confirmed account before admin bootstrap' })]
      );
    }
    return { userId: row.id, email: row.email, changed: !row.email_verified, emailVerified: true };
  } finally {
    await pool.end();
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
