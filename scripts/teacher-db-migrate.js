'use strict';

const { migratePostgresKnowledgeStore } = require('../apps/teacher/postgres-rag');
const { migrateTeacherConversationStore } = require('../apps/teacher/conversation-store');

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await migratePostgresKnowledgeStore();
  await migrateTeacherConversationStore();
  console.log('teacher database migration completed');
}
