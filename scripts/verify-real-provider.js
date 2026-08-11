'use strict';

const baseUrl = String(process.env.AI_TEACHER_BASE_URL || 'http://litellm:4000/v1').replace(/\/+$/u, '');
const apiKey = String(process.env.AI_TEACHER_API_KEY || process.env.LITELLM_MASTER_KEY || '');
const model = String(process.env.AI_TEACHER_MODEL || 'ai-teacher-fast');

main().catch((error) => {
  console.error(JSON.stringify({ status: 'BLOCK', error: error.message }, null, 2));
  process.exit(1);
});

async function main() {
  if (!apiKey) throw new Error('AI_TEACHER_API_KEY or LITELLM_MASTER_KEY is required');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
      temperature: 0,
      max_tokens: 16
    }),
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('LiteLLM returned invalid JSON'); }
  if (!response.ok) throw new Error(`LiteLLM completion returned HTTP ${response.status}`);
  if (!String(payload?.choices?.[0]?.message?.content || '').trim()) throw new Error('provider completion returned empty content');
  console.log(JSON.stringify({
    status: 'PASS',
    gateway: 'litellm',
    businessModelAlias: model,
    providerModel: String(payload.model || ''),
    contentPresent: true,
    usageReported: Boolean(payload.usage)
  }, null, 2));
}
