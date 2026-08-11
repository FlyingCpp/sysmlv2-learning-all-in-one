'use strict';

const { createPostgresKnowledgeRetriever } = require('./postgres-rag');

function createTeacherRetriever(options = {}) {
  const backend = String(
    options.backend
    || options.mode
    || process.env.AI_TEACHER_RAG_BACKEND
    || 'postgres_pgvector'
  ).trim().toLowerCase();
  if (backend === 'memory') return createMemoryKnowledgeRetriever();
  if (!['postgres', 'postgres_pgvector', 'pgvector'].includes(backend)) {
    throw new Error(`Unsupported AI Teacher retrieval backend: ${backend}`);
  }
  return createPostgresKnowledgeRetriever(options.postgres || options);
}

function createMemoryKnowledgeRetriever() {
  return {
    mode: 'memory',
    cards: [],
    async status() {
      return {
        mode: 'memory',
        enabled: false,
        ready: true,
        cardCount: 0,
        activeBundle: null
      };
    },
    async search() {
      return [];
    },
    async searchAnchors() {
      return {
        anchors: [],
        closure: {
          closureClaimIds: [],
          knowledgeAnswerRequiredClaimIds: [],
          knowledgeSupportingClaimIds: []
        },
        retrieval: { mode: 'memory' }
      };
    },
    async expandClaims() {
      return { claims: [], evidence: [], syntaxMappings: [] };
    },
    async debug(query) {
      return {
        ok: true,
        cardCount: 0,
        query: String(query || ''),
        backend: 'memory',
        hits: []
      };
    },
    async close() {}
  };
}

async function retrieverStatus(retriever) {
  if (typeof retriever.status === 'function') return retriever.status();
  return {
    mode: 'postgres_pgvector',
    enabled: true,
    ready: false,
    cardCount: 0,
    error: 'POSTGRES_PGVECTOR_RETRIEVER_STATUS_REQUIRED'
  };
}

module.exports = {
  createMemoryKnowledgeRetriever,
  createTeacherRetriever,
  retrieverStatus
};
