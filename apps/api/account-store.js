'use strict';

const crypto = require('crypto');
const {
  DEFAULT_LITELLM_CONFIG_VERSION_ID,
  defaultLiteLlmConfig,
  normalizeLiteLlmConfig,
  renderLiteLlmConfigYaml,
  validateLiteLlmConfig,
  publicLiteLlmConfigVersion,
  checksumText
} = require('./litellm-config');
const {
  SCHEMA_VERSION: AGENT_RESOURCE_POLICY_SCHEMA_VERSION,
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  validatePolicyValues: validateAgentResourcePolicyValues,
  checksumPolicyValues: checksumAgentResourcePolicyValues,
  createPolicySnapshot: createAgentResourcePolicySnapshot,
  diffPolicyValues: diffAgentResourcePolicyValues,
  migratePolicyValues: migrateAgentResourcePolicyValues
} = require('../../packages/agent-resource-policy');
const {
  SYSON_TOOL_ID,
  defaultExternalModelingToolSettings,
  normalizeExternalModelingToolSettings
} = require('./external-modeling-tools');

const DEFAULT_ENTITLEMENTS = {
  guest: ['course.read', 'draft.write'],
  free: ['course.read', 'draft.write', 'progress.write', 'syson.model.write'],
  plus: ['course.read', 'draft.write', 'progress.write', 'syson.model.write', 'ai.teacher.use']
};

const AI_TEACHER_TIER_POLICY_SEED = 'system-seed-free-limited-v1';

const ADMIN_ENTITLEMENTS = [
  'admin.console.access',
  'course.pack.manage',
  'course.pack.create',
  'course.pack.update',
  'course.pack.publish',
  'course.pack.read.unpublished',
  'course.content.validate',
  'syson.model.write',
  'syson.proxy.write'
];

const ADMIN_USER_SORT_COLUMNS = Object.freeze({
  user: 'lower(coalesce(p.display_name, u.name, u.email, p.user_id))',
  createdAt: 'p.created_at',
  lastLoginAt: 'p.last_login_at',
  activeDurationSeconds: 'p.active_seconds',
  tier: 'p.default_tier',
  status: 'p.status'
});

const ENTITLEMENT_DESCRIPTIONS = {
  'course.read': '读取课程内容',
  'draft.write': '保存个人草稿',
  'progress.write': '保存个人学习进度',
  'syson.model.write': '生成或修改 SysON 模型',
  'syson.proxy.write': '使用 SysON 管理写代理',
  'ai.teacher.use': '使用 AI 教师',
  'admin.console.access': '访问管理后台',
  'course.pack.manage': '管理课程包',
  'course.pack.create': '创建课程包',
  'course.pack.update': '更新课程包',
  'course.pack.publish': '发布课程包',
  'course.pack.read.unpublished': '读取未发布课程包',
  'course.content.validate': '校验课程内容'
};

function createAccountStore(options = {}) {
  const databaseUrl = options.authDatabaseUrl || process.env.AUTH_DATABASE_URL || process.env.BETTER_AUTH_DATABASE_URL || '';
  const plusEmails = new Set(String(process.env.AUTH_PLUS_EMAILS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  const defaultAiTeacherTierPolicies = buildAiTeacherTierPolicies(options.aiTeacherTierPolicies || options.aiTeacherQuotaPolicies);
  const profiles = new Map();
  const memoryAiUsage = new Map();
  const memoryAiUsageLedger = [];
  const memoryAiThreads = new Map();
  const memoryAiMessages = [];
  const memoryAiQuotaEvents = [];
  const memoryAiQuotaResets = new Map();
  const memoryAiBudgetReservations = new Map();
  const memoryAiBudgetLocks = new Map();
  const aiTeacherBudgetReservationTtlMs = normalizeBudgetReservationTtlMs(
    options.aiTeacherBudgetReservationTtlMs ?? process.env.AI_TEACHER_BUDGET_RESERVATION_TTL_MS
  );
  let memoryAiTeacherTierPolicies = cloneAiTeacherTierPolicies(defaultAiTeacherTierPolicies);
  const memoryLiteLlmConfigVersions = [seedLiteLlmConfigVersionRow()];
  const memoryLiteLlmCapabilityProbeRuns = [];
  const memoryAgentResourcePolicyVersions = migrateMemoryAgentResourcePolicyVersions(
    Array.isArray(options.agentResourcePolicyVersions) ? options.agentResourcePolicyVersions : []
  );
  const memoryUserEntitlements = new Map();
  const memoryAdminAuditEvents = [];
  let memoryAuthSettings = defaultAuthSettings();
  let memoryExternalModelingToolSettings = defaultExternalModelingToolSettings();
  let pool = options.authPool || null;
  let schemaReady = false;

  async function ensurePool() {
    if (!databaseUrl && !pool) return null;
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: databaseUrl });
    }
    if (!schemaReady) {
      await ensureSchema(pool);
      schemaReady = true;
    }
    return pool;
  }

  async function publicUserFromAuthUser(authUser = {}) {
    if (!authUser?.id) return null;
    const profile = await getOrCreateProfile(authUser);
    if (profile.status === 'disabled') return null;
    const entitlements = await listEntitlementsDetailed(authUser.id, profile.tier, authUser.email);
    const permissions = unique(entitlements.map((entitlement) => entitlement.code));
    const roles = ['learner'];
    if (profile.tier === 'plus') roles.push('plus');
    if (permissions.includes('admin.console.access')) roles.push('admin');
    return {
      id: authUser.id,
      username: authUser.email || authUser.username || authUser.id,
      email: authUser.email || '',
      displayName: profile.displayName || authUser.name || authUser.email || authUser.id,
      tier: profile.tier,
      roles,
      permissions,
      entitlements,
      authProvider: 'better-auth'
    };
  }

  async function getOrCreateProfile(authUser) {
    const tier = defaultTierFor(authUser);
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const existing = profiles.get(authUser.id);
      if (existing) return existing;
      const profile = {
        userId: authUser.id,
        email: authUser.email || '',
        displayName: authUser.name || authUser.email || authUser.id,
        status: 'active',
        tier,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      profiles.set(authUser.id, profile);
      return profile;
    }
    const result = await poolInstance.query(
      `insert into app_user_profiles (user_id, display_name, status, default_tier)
       values ($1, $2, 'active', $3)
       on conflict (user_id) do update
         set display_name = coalesce(app_user_profiles.display_name, excluded.display_name),
             updated_at = now()
       returning user_id, display_name, status, default_tier`,
      [authUser.id, authUser.name || authUser.email || authUser.id, tier]
    );
    const row = result.rows[0];
    return {
      userId: row.user_id,
      displayName: row.display_name,
      status: row.status,
      tier: row.default_tier
    };
  }

  async function listEntitlements(userId, tier = 'free') {
    const entitlements = await listEntitlementsDetailed(userId, tier);
    return unique(entitlements.map((entitlement) => entitlement.code));
  }

  async function listEntitlementsDetailed(userId, tier = 'free', email = '') {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const codes = tierEntitlementCodes(tier, await loadAiTeacherTierPolicies());
      const tierEntitlements = unique(codes).map((code) => entitlementRecord(code, 'global', '*', code === 'ai.teacher.use' ? 'tier' : 'seed'));
      const manualEntitlements = memoryUserEntitlements.get(userId) || [];
      return dedupeEntitlements([...tierEntitlements, ...manualEntitlements]);
    }
    const result = await poolInstance.query(
      `select entitlement_code, scope, scope_ref, 'tier' as source, null::timestamptz as expires_at
         from tier_entitlements
        where tier_code = $1
       union all
       select entitlement_code, scope, scope_ref, source, expires_at
         from user_entitlements
        where user_id = $2
          and (expires_at is null or expires_at > now())
        order by entitlement_code, scope, scope_ref`,
      [tier, userId]
    );
    return dedupeEntitlements(result.rows.map((row) => ({
      code: row.entitlement_code,
      scope: row.scope || 'global',
      scopeRef: row.scope_ref || '*',
      source: row.source || 'manual',
      expiresAt: row.expires_at || null
    })));
  }

  async function recordAuthAudit(event = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      if (event.eventType === 'login_succeeded' && event.userId && profiles.has(event.userId)) {
        const profile = profiles.get(event.userId);
        profiles.set(event.userId, { ...profile, lastLoginAt: new Date().toISOString() });
      }
      return;
    }
    await poolInstance.query(
      `insert into auth_audit_events (user_id, event_type, provider, ip_hash, user_agent_hash, request_id, metadata_json)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.userId || null,
        event.eventType || 'login_succeeded',
        event.provider || null,
        event.ipHash || null,
        event.userAgentHash || null,
        event.requestId || null,
        JSON.stringify(event.metadata || {})
      ]
    );
    if (event.eventType === 'login_succeeded' && event.userId) {
      await poolInstance.query(
        `update app_user_profiles
            set last_login_at = now()
          where user_id = $1`,
        [event.userId]
      );
    }
  }

  async function recordPlatformActivity({ userId = '', seconds = 0, now = null } = {}) {
    if (!userId) return null;
    const requestedSeconds = Math.min(Math.max(Math.floor(Number(seconds || 0)), 0), 120);
    const observedAt = now ? new Date(now) : new Date();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const profile = profiles.get(userId);
      if (!profile) return null;
      const previous = profile.lastActivityAt ? new Date(profile.lastActivityAt) : null;
      const elapsedSeconds = previous && Number.isFinite(previous.getTime())
        ? Math.max(0, Math.floor((observedAt.getTime() - previous.getTime()) / 1000))
        : requestedSeconds;
      const creditedSeconds = Math.min(requestedSeconds, elapsedSeconds);
      const next = {
        ...profile,
        activeSeconds: Number(profile.activeSeconds || 0) + creditedSeconds,
        lastActivityAt: observedAt.toISOString()
      };
      profiles.set(userId, next);
      return { activeDurationSeconds: next.activeSeconds, lastActivityAt: next.lastActivityAt };
    }
    const result = await poolInstance.query(
      `update app_user_profiles
          set active_seconds = active_seconds + least(
                $2::bigint,
                case
                  when last_activity_at is null then $2::bigint
                  else greatest(0, floor(extract(epoch from ($3::timestamptz - last_activity_at)))::bigint)
                end
              ),
              last_activity_at = $3::timestamptz
        where user_id = $1
        returning active_seconds, last_activity_at`,
      [userId, requestedSeconds, observedAt.toISOString()]
    );
    if (!result.rows[0]) return null;
    return {
      activeDurationSeconds: Number(result.rows[0].active_seconds || 0),
      lastActivityAt: result.rows[0].last_activity_at || null
    };
  }

  async function recordAiAccessEvent(event = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) return;
    await poolInstance.query(
      `insert into ai_access_events (user_id, decision, entitlement_code, reason, lesson_id, request_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        event.userId || null,
        event.decision || 'deny',
        event.entitlementCode || 'ai.teacher.use',
        event.reason || '',
        event.lessonId || null,
        event.requestId || null
      ]
    );
  }

  async function recordAiExchange(event = {}) {
    const poolInstance = await ensurePool();
    const budgetReservationId = String(event.budgetReservationId || '').trim();
    const threadId = event.threadId || crypto.randomUUID();
    const userMessageId = event.userMessageId || crypto.randomUUID();
    const assistantMessageId = event.assistantMessageId || crypto.randomUUID();
    if (!event.userId) return null;
    if (!poolInstance) {
      const usage = normalizeTokenUsage(event.tokenUsage);
      const budgetReservation = budgetReservationId ? memoryAiBudgetReservations.get(budgetReservationId) : null;
      if (budgetReservationId && (!budgetReservation || budgetReservation.userId !== event.userId || budgetReservation.status !== 'active')) {
        throw budgetReservationStateError();
      }
      const providerUsage = normalizeTokenUsage(event.providerTokenUsage || event.providerUsage || event.tokenUsage);
      const current = memoryAiUsage.get(event.userId) || { messageCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
      current.messageCount += 1;
      current.totalTokens += usage.totalTokens;
      current.promptTokens += usage.promptTokens;
      current.completionTokens += usage.completionTokens;
      memoryAiUsage.set(event.userId, current);
      memoryAiUsageLedger.push({
        userId: event.userId,
        tenantId: event.tenantId || '',
        threadId,
        messageId: assistantMessageId,
        requestId: event.requestId || '',
        capability: event.capability || 'answer',
        model: event.model || null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        providerPromptTokens: providerUsage.promptTokens,
        providerCompletionTokens: providerUsage.completionTokens,
        providerReasoningTokens: providerUsage.reasoningTokens,
        providerTotalTokens: providerUsage.totalTokens,
        usageSource: event.usageSource || usage.usageSource || 'provider',
        status: event.status || 'succeeded',
        budgetReservationId: budgetReservationId || null,
        createdAt: event.createdAt ? new Date(event.createdAt) : new Date()
      });
      if (budgetReservation) {
        budgetReservation.status = 'settled';
        budgetReservation.actualTokens = usage.totalTokens;
        budgetReservation.settledAt = new Date();
      }
      const createdAt = event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString();
      memoryAiThreads.set(threadId, {
        id: threadId,
        userId: event.userId,
        lessonId: event.lessonId || null,
        title: String(event.title || event.lessonId || 'AI 教师对话').slice(0, 120),
        createdAt: memoryAiThreads.get(threadId)?.createdAt || createdAt,
        updatedAt: createdAt
      });
      memoryAiMessages.push({
        id: userMessageId,
        threadId,
        role: 'user',
        content: String(event.prompt || ''),
        model: event.model || null,
        tokenUsage: event.promptTokenUsage || {},
        createdAt
      });
      memoryAiMessages.push({
        id: assistantMessageId,
        threadId,
        role: 'assistant',
        content: String(event.reply || ''),
        model: event.model || null,
        tokenUsage: event.tokenUsage || {},
        createdAt
      });
      return { threadId, userMessageId, assistantMessageId };
    }
    const usage = normalizeTokenUsage(event.tokenUsage);
    const providerUsage = normalizeTokenUsage(event.providerTokenUsage || event.providerUsage || event.tokenUsage);
    const nowTitle = String(event.title || event.lessonId || 'AI 教师对话').slice(0, 120);
    const client = budgetReservationId ? await poolInstance.connect() : null;
    const queryTarget = client || poolInstance;
    try {
      if (client) await client.query('begin');
      if (budgetReservationId) {
        const reservation = await queryTarget.query(
          `select reservation_id from ai_teacher_budget_reservations
            where reservation_id = $1 and user_id = $2 and status = 'active'
            for update`,
          [budgetReservationId, event.userId]
        );
        if (!reservation.rows[0]) throw budgetReservationStateError();
      }
      await queryTarget.query(
        `insert into ai_teacher_threads (id, user_id, lesson_id, title)
         values ($1, $2, $3, $4)
         on conflict (id) do update set updated_at = now(), lesson_id = coalesce(excluded.lesson_id, ai_teacher_threads.lesson_id)`,
        [threadId, event.userId, event.lessonId || null, nowTitle]
      );
      await queryTarget.query(
        `insert into ai_teacher_messages (id, thread_id, role, content, model, token_usage_json)
         values ($1, $2, 'user', $3, $4, $5)
         on conflict (id) do nothing`,
        [userMessageId, threadId, String(event.prompt || ''), event.model || null, JSON.stringify(event.promptTokenUsage || {})]
      );
      await queryTarget.query(
        `insert into ai_teacher_messages (id, thread_id, role, content, model, token_usage_json)
         values ($1, $2, 'assistant', $3, $4, $5)
         on conflict (id) do nothing`,
        [assistantMessageId, threadId, String(event.reply || ''), event.model || null, JSON.stringify(event.tokenUsage || {})]
      );
      await queryTarget.query(
        `insert into ai_usage_ledger
          (user_id, thread_id, message_id, capability, model, prompt_tokens, completion_tokens, total_tokens,
           estimated_cost_json, entitlement_code, request_id, tenant_id, metered_prompt_tokens,
           metered_completion_tokens, metered_reasoning_tokens, metered_total_tokens, provider_prompt_tokens,
           provider_completion_tokens, provider_reasoning_tokens, provider_total_tokens, usage_source, status,
           budget_reservation_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, coalesce($24::timestamptz, now()))`,
        [
          event.userId,
          threadId,
          assistantMessageId,
          event.capability || 'answer',
          event.model || null,
          usage.promptTokens,
          usage.completionTokens,
          usage.totalTokens,
          JSON.stringify(event.estimatedCost || {}),
          event.entitlementCode || 'ai.teacher.use',
          event.requestId || null,
          event.tenantId || '',
          usage.promptTokens,
          usage.completionTokens,
          usage.reasoningTokens,
          usage.totalTokens,
          providerUsage.promptTokens,
          providerUsage.completionTokens,
          providerUsage.reasoningTokens,
          providerUsage.totalTokens,
          event.usageSource || usage.usageSource || 'provider',
          event.status || 'succeeded',
          budgetReservationId || null,
          event.createdAt || null
        ]
      );
      if (budgetReservationId) {
        await queryTarget.query(
          `update ai_teacher_budget_reservations
              set status = 'settled', actual_tokens = $3, settled_at = now()
            where reservation_id = $1 and user_id = $2 and status = 'active'`,
          [budgetReservationId, event.userId, usage.totalTokens]
        );
      }
      if (client) await client.query('commit');
      return { threadId, userMessageId, assistantMessageId };
    } catch (error) {
      if (client) await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client?.release();
    }
  }

  async function getAiUsageSummary(userId, options = {}) {
    const poolInstance = await ensurePool();
    const policies = await loadAiTeacherTierPolicies(poolInstance);
    if (!poolInstance || !userId) {
      const summary = summarizeMemoryAiUsage(userId, options.now, memoryAiUsageLedger, memoryAiUsage, memoryAiQuotaResets.get(userId));
      const reserved = summarizeMemoryAiBudgetReservations(
        userId,
        options.now,
        memoryAiBudgetReservations,
        memoryAiQuotaResets.get(userId)
      );
      return withAiTeacherQuotaSummary(userId, { ...summary, ...reserved }, options.user, policies);
    }
    const resetResult = await poolInstance.query(
      'select reset_at from ai_teacher_quota_resets where user_id = $1',
      [userId]
    );
    const resetAt = resetResult.rows[0]?.reset_at || null;
    const result = await poolInstance.query(
      `select count(*)::int as message_count,
              coalesce(sum(coalesce(nullif(metered_total_tokens, 0), total_tokens)), 0)::int as total_tokens,
              coalesce(sum(coalesce(nullif(metered_prompt_tokens, 0), prompt_tokens)), 0)::int as prompt_tokens,
              coalesce(sum(coalesce(nullif(metered_completion_tokens, 0), completion_tokens)), 0)::int as completion_tokens,
              coalesce(sum(case when created_at >= greatest(date_trunc('day', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as daily_tokens,
              coalesce(sum(case when created_at >= greatest(date_trunc('week', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as weekly_tokens,
              coalesce(sum(case when created_at >= date_trunc('month', now()) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as monthly_tokens
         from ai_usage_ledger
        where user_id = $1
          and coalesce(status, 'succeeded') = 'succeeded'`,
      [userId, resetAt]
    );
    const row = result.rows[0] || {};
    const reservationResult = await poolInstance.query(
      `select coalesce(sum(case when created_at >= greatest(date_trunc('day', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then reserved_tokens else 0 end), 0)::int as reserved_daily_tokens,
              coalesce(sum(case when created_at >= greatest(date_trunc('week', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then reserved_tokens else 0 end), 0)::int as reserved_weekly_tokens
         from ai_teacher_budget_reservations
        where user_id = $1
          and status = 'active'
          and expires_at > now()`,
      [userId, resetAt]
    );
    const reservationRow = reservationResult.rows[0] || {};
    return withAiTeacherQuotaSummary(userId, {
      userId,
      messageCount: row.message_count || 0,
      totalTokens: row.total_tokens || 0,
      promptTokens: row.prompt_tokens || 0,
      completionTokens: row.completion_tokens || 0,
      dailyTokens: row.daily_tokens || 0,
      weeklyTokens: row.weekly_tokens || 0,
      monthlyTokens: row.monthly_tokens || 0,
      reservedDailyTokens: reservationRow.reserved_daily_tokens || 0,
      reservedWeeklyTokens: reservationRow.reserved_weekly_tokens || 0
    }, options.user || await getUserProfile(userId), policies);
  }

  async function resetAiTeacherQuota({ actorUserId = '', userId = '', requestId = '' } = {}) {
    const user = await getUserProfile(userId);
    if (!user) throwUserNotFound();
    const resetAt = new Date().toISOString();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAiQuotaResets.set(userId, resetAt);
    } else {
      await poolInstance.query(
        `insert into ai_teacher_quota_resets (user_id, reset_at, reset_by)
         values ($1, $2, $3)
         on conflict (user_id) do update
           set reset_at = excluded.reset_at,
               reset_by = excluded.reset_by`,
        [userId, resetAt, actorUserId || null]
      );
    }
    await recordAdminAudit({
      actorUserId,
      eventType: 'ai_teacher.quota.reset',
      targetType: 'user',
      targetRef: userId,
      requestId,
      metadata: { resetAt, windows: ['daily', 'weekly'] }
    });
    return { user: publicAdminUser(user), resetAt, usage: await getAiUsageSummary(userId, { user }) };
  }

  async function checkAiTeacherQuota(input = {}) {
    const user = input.user || {};
    const userId = user.id || input.userId || '';
    const policies = await loadAiTeacherTierPolicies();
    const policy = resolveAiTeacherPolicy(user, policies);
    const estimatedTokens = Math.max(0, Math.ceil(Number(input.estimatedTokens || input.estimatedTotalTokens || 0)));
    const requestId = input.requestId || input.envelope?.requestId || '';
    const tenantId = input.tenantId || input.envelope?.tenant?.tenantId || '';
    const capability = input.capability || 'answer';
    if (!userId) {
      return { allowed: false, status: 401, code: 'AUTH_REQUIRED', reason: 'auth_required' };
    }
    if (isAdminUser(user)) {
      return { allowed: true, reason: 'admin_override', estimatedTokens, policy };
    }
    if (!policy.enabled) {
      const decision = {
        allowed: false,
        status: 403,
        code: 'AI_TEACHER_POLICY_DENIED',
        reason: 'tier_policy_disabled',
        estimatedTokens,
        policy
      };
      await recordAiQuotaEvent({ userId, tenantId, requestId, capability, decision: 'deny', reason: decision.reason, policy });
      return decision;
    }
    const usage = await getAiUsageSummary(userId, { user, now: input.now });
    const exceeded = quotaExceededReason(usage, policy, estimatedTokens);
    if (!exceeded) {
      return { allowed: true, reason: 'within_quota', estimatedTokens, usage, policy };
    }
    const decision = {
      allowed: false,
      status: 429,
      code: 'AI_TEACHER_QUOTA_EXCEEDED',
      reason: exceeded,
      message: quotaExceededMessage(exceeded),
      estimatedTokens,
      usage,
      policy
    };
    await recordAiQuotaEvent({
      userId,
      tenantId,
      requestId,
      capability,
      decision: 'deny',
      reason: exceeded,
      dailyUsedTokens: usage.dailyTokens,
      weeklyUsedTokens: usage.weeklyTokens,
      dailyLimitTokens: policy.dailyTokenLimit,
      weeklyLimitTokens: policy.weeklyTokenLimit,
      metadata: { estimatedTokens }
    });
    return decision;
  }

  async function reserveAiTeacherBudget(input = {}) {
    const user = input.user || {};
    const userId = String(user.id || input.userId || '').trim();
    const estimatedTokens = Math.max(1, Math.ceil(Number(input.estimatedTokens || input.estimatedTotalTokens || 0)));
    const estimatedInputTokens = Math.max(0, Math.ceil(Number(input.estimatedInputTokens || 0)));
    const estimatedOutputTokens = Math.max(0, Math.ceil(Number(input.estimatedOutputTokens || 0)));
    const resourcePolicyVersion = String(input.resourcePolicyVersion || '').slice(0, 160);
    const requestId = String(input.requestId || input.envelope?.requestId || '').trim();
    const tenantId = String(input.tenantId || input.envelope?.tenant?.tenantId || '');
    const capability = String(input.capability || 'answer');
    if (!userId) return { allowed: false, status: 401, code: 'AUTH_REQUIRED', reason: 'auth_required' };

    const poolInstance = await ensurePool();
    const policies = await loadAiTeacherTierPolicies(poolInstance);
    const policy = resolveAiTeacherPolicy(user, policies);
    if (isAdminUser(user)) {
      return { allowed: true, reason: 'admin_override', estimatedTokens, policy, reservationId: '' };
    }
    if (!policy.enabled) {
      const decision = budgetDeniedDecision('tier_policy_disabled', estimatedTokens, policy, null, 403, 'AI_TEACHER_POLICY_DENIED');
      await recordAiQuotaEvent({ userId, tenantId, requestId, capability, decision: 'deny', reason: decision.reason, policy });
      return decision;
    }

    let decision;
    if (!poolInstance) {
      decision = await withMemoryAiBudgetLock(memoryAiBudgetLocks, userId, async () => {
        const now = input.now ? new Date(input.now) : new Date();
        expireMemoryAiBudgetReservations(memoryAiBudgetReservations, userId, now);
        if (requestId && findMemoryAiBudgetReservation(memoryAiBudgetReservations, userId, requestId, capability)) {
          return budgetDeniedDecision('duplicate_request', estimatedTokens, policy, null, 409, 'AI_TEACHER_REQUEST_DUPLICATE');
        }
        const usage = summarizeMemoryAiUsage(userId, now, memoryAiUsageLedger, memoryAiUsage, memoryAiQuotaResets.get(userId));
        const reserved = summarizeMemoryAiBudgetReservations(userId, now, memoryAiBudgetReservations, memoryAiQuotaResets.get(userId));
        const quotaUsage = withAiTeacherQuotaSummary(userId, { ...usage, ...reserved }, user, policies);
        const exceeded = quotaExceededReason(quotaUsage, policy, estimatedTokens);
        if (exceeded) return budgetDeniedDecision(exceeded, estimatedTokens, policy, quotaUsage);
        const reservationId = `budget_${crypto.randomUUID()}`;
        const expiresAt = new Date(now.getTime() + aiTeacherBudgetReservationTtlMs);
        memoryAiBudgetReservations.set(reservationId, {
          reservationId,
          userId,
          tenantId,
          requestId,
          capability,
          tierCode: user.tier || 'free',
          reservedTokens: estimatedTokens,
          status: 'active',
          createdAt: now,
          expiresAt
        });
        return {
          allowed: true,
          reason: 'budget_reserved',
          estimatedTokens,
          reservationId,
          expiresAt: expiresAt.toISOString(),
          usage: quotaUsage,
          policy
        };
      });
    } else {
      const client = await poolInstance.connect();
      try {
        await client.query('begin');
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ai-teacher-budget:${userId}`]);
        await client.query(
          `update ai_teacher_budget_reservations
              set status = 'expired', released_at = now(), release_reason = 'lease_expired'
            where user_id = $1 and status = 'active' and expires_at <= now()`,
          [userId]
        );
        if (requestId) {
          const duplicate = await client.query(
            `select reservation_id from ai_teacher_budget_reservations
              where user_id = $1 and request_id = $2 and capability = $3 and status in ('active', 'settled') limit 1`,
            [userId, requestId, capability]
          );
          if (duplicate.rows[0]) {
            decision = budgetDeniedDecision('duplicate_request', estimatedTokens, policy, null, 409, 'AI_TEACHER_REQUEST_DUPLICATE');
          }
        }
        if (!decision) {
          const resetResult = await client.query('select reset_at from ai_teacher_quota_resets where user_id = $1', [userId]);
          const resetAt = resetResult.rows[0]?.reset_at || null;
          const usageResult = await client.query(
            `select count(*)::int as message_count,
                    coalesce(sum(coalesce(nullif(metered_total_tokens, 0), total_tokens)), 0)::int as total_tokens,
                    coalesce(sum(coalesce(nullif(metered_prompt_tokens, 0), prompt_tokens)), 0)::int as prompt_tokens,
                    coalesce(sum(coalesce(nullif(metered_completion_tokens, 0), completion_tokens)), 0)::int as completion_tokens,
                    coalesce(sum(case when created_at >= greatest(date_trunc('day', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as daily_tokens,
                    coalesce(sum(case when created_at >= greatest(date_trunc('week', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as weekly_tokens,
                    coalesce(sum(case when created_at >= date_trunc('month', now()) then coalesce(nullif(metered_total_tokens, 0), total_tokens) else 0 end), 0)::int as monthly_tokens
               from ai_usage_ledger
              where user_id = $1 and coalesce(status, 'succeeded') = 'succeeded'`,
            [userId, resetAt]
          );
          const reservedResult = await client.query(
            `select coalesce(sum(case when created_at >= greatest(date_trunc('day', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then reserved_tokens else 0 end), 0)::int as reserved_daily_tokens,
                    coalesce(sum(case when created_at >= greatest(date_trunc('week', now()), coalesce($2::timestamptz, '-infinity'::timestamptz)) then reserved_tokens else 0 end), 0)::int as reserved_weekly_tokens
               from ai_teacher_budget_reservations
              where user_id = $1 and status = 'active' and expires_at > now()`,
            [userId, resetAt]
          );
          const row = usageResult.rows[0] || {};
          const reservedRow = reservedResult.rows[0] || {};
          const quotaUsage = withAiTeacherQuotaSummary(userId, {
            messageCount: row.message_count || 0,
            totalTokens: row.total_tokens || 0,
            promptTokens: row.prompt_tokens || 0,
            completionTokens: row.completion_tokens || 0,
            dailyTokens: row.daily_tokens || 0,
            weeklyTokens: row.weekly_tokens || 0,
            monthlyTokens: row.monthly_tokens || 0,
            reservedDailyTokens: reservedRow.reserved_daily_tokens || 0,
            reservedWeeklyTokens: reservedRow.reserved_weekly_tokens || 0
          }, user, policies);
          const exceeded = quotaExceededReason(quotaUsage, policy, estimatedTokens);
          if (exceeded) {
            decision = budgetDeniedDecision(exceeded, estimatedTokens, policy, quotaUsage);
          } else {
            const reservationId = `budget_${crypto.randomUUID()}`;
            const insertResult = await client.query(
              `insert into ai_teacher_budget_reservations
                (reservation_id, user_id, tenant_id, request_id, capability, tier_code, reserved_tokens, status, expires_at)
               values ($1, $2, $3, $4, $5, $6, $7, 'active', now() + ($8::bigint * interval '1 millisecond'))
               returning expires_at`,
              [reservationId, userId, tenantId, requestId, capability, user.tier || 'free', estimatedTokens, aiTeacherBudgetReservationTtlMs]
            );
            decision = {
              allowed: true,
              reason: 'budget_reserved',
              estimatedTokens,
              reservationId,
              expiresAt: insertResult.rows[0]?.expires_at?.toISOString?.() || insertResult.rows[0]?.expires_at || null,
              usage: quotaUsage,
              policy
            };
          }
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    await recordAiQuotaEvent({
      userId,
      tenantId,
      requestId,
      capability,
      decision: decision.allowed ? 'reserve' : 'deny',
      reason: decision.reason,
      dailyUsedTokens: decision.usage?.dailyTokens || 0,
      weeklyUsedTokens: decision.usage?.weeklyTokens || 0,
      dailyLimitTokens: policy.dailyTokenLimit,
      weeklyLimitTokens: policy.weeklyTokenLimit,
      metadata: {
        estimatedTokens,
        estimatedInputTokens,
        estimatedOutputTokens,
        resourcePolicyVersion,
        reservationId: decision.reservationId || '',
        reservedDailyTokens: decision.usage?.reservedDailyTokens || 0,
        reservedWeeklyTokens: decision.usage?.reservedWeeklyTokens || 0
      }
    });
    return decision;
  }

  async function releaseAiTeacherBudget(input = {}) {
    const reservationId = String(input.reservationId || '').trim();
    const userId = String(input.userId || input.user?.id || '').trim();
    if (!reservationId) return { released: false, reason: 'reservation_not_required' };
    const releaseReason = String(input.reason || 'run_not_completed').slice(0, 120);
    const poolInstance = await ensurePool();
    let released = false;
    if (!poolInstance) {
      released = await withMemoryAiBudgetLock(memoryAiBudgetLocks, userId, async () => {
        const reservation = memoryAiBudgetReservations.get(reservationId);
        if (!reservation || reservation.userId !== userId || reservation.status !== 'active') return false;
        reservation.status = 'released';
        reservation.releasedAt = new Date();
        reservation.releaseReason = releaseReason;
        return true;
      });
    } else {
      const result = await poolInstance.query(
        `update ai_teacher_budget_reservations
            set status = 'released', released_at = now(), release_reason = $3
          where reservation_id = $1 and user_id = $2 and status = 'active'`,
        [reservationId, userId, releaseReason]
      );
      released = result.rowCount === 1;
    }
    if (released) {
      await recordAiQuotaEvent({
        userId,
        tenantId: input.tenantId || '',
        requestId: input.requestId || '',
        capability: input.capability || 'answer',
        decision: 'release',
        reason: releaseReason,
        metadata: { reservationId }
      });
    }
    return { released, reason: released ? releaseReason : 'reservation_not_active' };
  }

  async function getAiTeacherTierPolicies() {
    const policies = await loadAiTeacherTierPolicies();
    const window = aiTeacherUsageWindow();
    return {
      resetPolicy: {
        daily: 'calendar_day',
        weekly: 'iso_week',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
        dayStartAt: window.dayStartAt,
        weekStartAt: window.weekStartAt,
        weekEndAt: window.weekEndAt,
        nextWeeklyResetAt: window.nextWeeklyResetAt
      },
      policies: Object.fromEntries(Object.entries(policies).map(([tier, policy]) => [tier, publicAiTeacherPolicy(policy)]))
    };
  }

  async function updateAiTeacherTierPolicies({ policies = {}, actorUserId = '' } = {}) {
    const normalized = mergeAiTeacherTierPolicies(await loadAiTeacherTierPolicies(), policies);
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAiTeacherTierPolicies = cloneAiTeacherTierPolicies(normalized);
      return getAiTeacherTierPolicies();
    }
    await poolInstance.query('begin');
    try {
      for (const [tier, policy] of Object.entries(normalized)) {
        await poolInstance.query(
          `insert into ai_teacher_tier_policies
            (tier_code, enabled, daily_token_limit, weekly_token_limit, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (tier_code) do update
             set enabled = excluded.enabled,
                 daily_token_limit = excluded.daily_token_limit,
                 weekly_token_limit = excluded.weekly_token_limit,
                 updated_by = excluded.updated_by,
                 updated_at = now()`,
          [tier, policy.enabled, policy.dailyTokenLimit, policy.weeklyTokenLimit, actorUserId || null]
        );
      }
      await syncAiTeacherTierEntitlements(poolInstance, normalized);
      await poolInstance.query('commit');
    } catch (error) {
      await poolInstance.query('rollback');
      throw error;
    }
    return getAiTeacherTierPolicies();
  }

  async function ensureAiTeacherRuntimeAssignment(options = {}) {
    const userId = String(options.userId || '').trim();
    if (!userId) {
      const error = new Error('AI Teacher runtime assignment requires an authenticated user.');
      error.status = 401;
      error.code = 'AI_TEACHER_ASSIGNMENT_USER_REQUIRED';
      throw error;
    }
    const requestedThreadId = normalizeAiTeacherThreadId(options.threadId);
    const threadId = requestedThreadId || `thread_${crypto.randomUUID()}`;
    const tenantId = String(options.tenantId || 'local-dev');
    const lessonId = options.lessonId || null;
    const policyVersion = String(options.policyVersion || 'single-entry-v1');
    const bucket = 0;
    const runtime = 'ai-sdk';
    const assignedAt = new Date().toISOString();
    const assignment = {
      threadId,
      runtimeAssignmentId: `assign_${crypto.randomUUID()}`,
      runtime,
      policyVersion,
      bucket,
      assignedAt,
      overrideReason: ''
    };
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const existing = memoryAiThreads.get(threadId);
      assertAiTeacherThreadOwner(existing, userId);
      if (existing?.runtimeAssignmentId) {
        const migrated = {
          ...existing,
          runtime: 'ai-sdk',
          policyVersion,
          bucket: 0,
          overrideReason: ''
        };
        memoryAiThreads.set(threadId, migrated);
        return aiTeacherRuntimeAssignmentFromRow(migrated);
      }
      memoryAiThreads.set(threadId, {
        ...(existing || {}),
        id: threadId,
        userId,
        tenantId,
        lessonId: lessonId || existing?.lessonId || null,
        title: existing?.title || String(options.title || lessonId || 'AI 教师对话').slice(0, 120),
        createdAt: existing?.createdAt || assignedAt,
        updatedAt: assignedAt,
        ...assignment
      });
      return assignment;
    }

    const client = await poolInstance.connect();
    try {
      await client.query('begin');
      const existingResult = await client.query(
        `select id, user_id, runtime_assignment_id, runtime, policy_version, bucket, assigned_at, override_reason
           from ai_teacher_threads
          where id = $1
          for update`,
        [threadId]
      );
      const existing = existingResult.rows[0] || null;
      assertAiTeacherThreadOwner(existing && { userId: existing.user_id }, userId);
      if (existing?.runtime_assignment_id) {
        await client.query(
          `update ai_teacher_threads
              set runtime = 'ai-sdk', policy_version = $2, bucket = 0, override_reason = '', updated_at = now()
            where id = $1`,
          [threadId, policyVersion]
        );
        await client.query('commit');
        return aiTeacherRuntimeAssignmentFromRow({
          ...existing,
          runtime: 'ai-sdk',
          policy_version: policyVersion,
          bucket: 0,
          override_reason: ''
        });
      }
      if (existing) {
        await client.query(
          `update ai_teacher_threads
              set tenant_id = $2, lesson_id = coalesce($3, lesson_id), runtime_assignment_id = $4,
                  runtime = $5, policy_version = $6, bucket = $7, assigned_at = $8, updated_at = now()
            where id = $1`,
          [threadId, tenantId, lessonId, assignment.runtimeAssignmentId, runtime, policyVersion, bucket, assignedAt]
        );
      } else {
        await client.query(
          `insert into ai_teacher_threads
             (id, user_id, tenant_id, lesson_id, title, runtime_assignment_id, runtime, policy_version, bucket, assigned_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            threadId,
            userId,
            tenantId,
            lessonId,
            String(options.title || lessonId || 'AI 教师对话').slice(0, 120),
            assignment.runtimeAssignmentId,
            runtime,
            policyVersion,
            bucket,
            assignedAt
          ]
        );
      }
      await client.query('commit');
      return assignment;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadAiTeacherTierPolicies(poolInstance = null) {
    const existingPool = poolInstance || await ensurePool();
    if (!existingPool) return cloneAiTeacherTierPolicies(memoryAiTeacherTierPolicies);
    const result = await existingPool.query(
      `select tier_code, enabled, daily_token_limit, weekly_token_limit
         from ai_teacher_tier_policies
        where tier_code in ('guest', 'free', 'plus')`
    );
    if (!result.rows.length) return cloneAiTeacherTierPolicies(defaultAiTeacherTierPolicies);
    const policies = cloneAiTeacherTierPolicies(defaultAiTeacherTierPolicies);
    for (const row of result.rows) {
      policies[row.tier_code] = normalizeAiTeacherPolicy({
        enabled: row.enabled,
        dailyTokenLimit: row.daily_token_limit,
        weeklyTokenLimit: row.weekly_token_limit
      });
    }
    return policies;
  }

  async function getAiTeacherAdminUsageSummary(options = {}) {
    const users = await listUsers({ search: options.search || '', limit: options.userLimit || 200 });
    const rows = [];
    for (const user of users) {
      rows.push({ user, usage: await getAiUsageSummary(user.id, { user, now: options.now }) });
    }
    const quotaEvents = await listAiQuotaEvents({ limit: options.quotaLimit || 200 });
    const totals = rows.reduce((summary, row) => {
      summary.userCount += 1;
      summary.messageCount += row.usage.messageCount || 0;
      summary.totalTokens += row.usage.totalTokens || 0;
      summary.promptTokens += row.usage.promptTokens || 0;
      summary.completionTokens += row.usage.completionTokens || 0;
      summary.dailyTokens += row.usage.dailyTokens || 0;
      summary.weeklyTokens += row.usage.weeklyTokens || 0;
      return summary;
    }, { userCount: 0, messageCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, dailyTokens: 0, weeklyTokens: 0 });
    const window = aiTeacherUsageWindow(options.now);
    return {
      ...totals,
      quotaDeniedCount: quotaEvents.filter((event) => event.decision === 'deny').length,
      weekStartAt: window.weekStartAt,
      weekEndAt: window.weekEndAt,
      nextWeeklyResetAt: window.nextWeeklyResetAt
    };
  }

  async function listAiTeacherUsageUsers(options = {}) {
    const users = await listUsers({ search: options.search || '', limit: options.limit || 100 });
    const rows = [];
    for (const user of users) {
      const usage = await getAiUsageSummary(user.id, { user, now: options.now });
      rows.push({
        user: publicAdminUser(user),
        usage: publicAdminAiUsage(usage)
      });
    }
    rows.sort((left, right) => (right.usage.weeklyTokens || 0) - (left.usage.weeklyTokens || 0));
    return rows;
  }

  async function listAiTeacherConversations(options = {}) {
    const poolInstance = await ensurePool();
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 200);
    const search = String(options.search || '').trim().toLowerCase();
    if (!poolInstance) {
      return [...memoryAiThreads.values()]
        .map((thread) => conversationMemoryRow(thread, { profiles, memoryAiMessages, memoryAiUsageLedger }))
        .filter((row) => !search || conversationMatches(row, search))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .slice(0, limit);
    }
    const result = await poolInstance.query(
      `with usage_by_thread as (
         select thread_id,
                coalesce(sum(coalesce(nullif(metered_total_tokens, 0), total_tokens)), 0)::int as total_tokens,
                coalesce(sum(coalesce(nullif(metered_prompt_tokens, 0), prompt_tokens)), 0)::int as prompt_tokens,
                coalesce(sum(coalesce(nullif(metered_completion_tokens, 0), completion_tokens)), 0)::int as completion_tokens,
                max(created_at) as last_usage_at
           from ai_usage_ledger
          group by thread_id
       ), message_by_thread as (
         select thread_id,
                count(*)::int as message_count,
                max(created_at) as last_message_at,
                max(content) filter (where role = 'user') as last_user_message
           from ai_teacher_messages
          group by thread_id
       )
       select t.id, t.user_id, t.lesson_id, t.title, t.created_at, t.updated_at,
              coalesce(p.display_name, u.name, u.email, t.user_id) as display_name,
              coalesce(u.email, '') as email,
              coalesce(p.default_tier, 'free') as tier,
              coalesce(m.message_count, 0) as message_count,
              coalesce(m.last_user_message, '') as last_user_message,
              coalesce(ut.total_tokens, 0) as total_tokens,
              coalesce(ut.prompt_tokens, 0) as prompt_tokens,
              coalesce(ut.completion_tokens, 0) as completion_tokens,
              greatest(coalesce(m.last_message_at, t.updated_at), coalesce(ut.last_usage_at, t.updated_at), t.updated_at) as last_activity_at
         from ai_teacher_threads t
         left join app_user_profiles p on p.user_id = t.user_id
         left join "user" u on u.id = t.user_id
         left join message_by_thread m on m.thread_id = t.id
         left join usage_by_thread ut on ut.thread_id = t.id
        where ($1 = '' or lower(coalesce(p.display_name, '') || ' ' || coalesce(u.email, '') || ' ' || t.user_id || ' ' || coalesce(t.lesson_id, '') || ' ' || coalesce(t.title, '') || ' ' || coalesce(m.last_user_message, '')) like '%' || $1 || '%')
        order by last_activity_at desc
        limit $2`,
      [search, limit]
    );
    return result.rows.map((row) => ({
      threadId: row.id,
      user: {
        id: row.user_id,
        displayName: row.display_name || row.user_id,
        email: row.email || '',
        tier: row.tier || 'free'
      },
      lessonId: row.lesson_id || '',
      title: row.title || 'AI 教师对话',
      lastUserMessage: row.last_user_message || '',
      messageCount: row.message_count || 0,
      totalTokens: row.total_tokens || 0,
      promptTokens: row.prompt_tokens || 0,
      completionTokens: row.completion_tokens || 0,
      createdAt: row.created_at,
      updatedAt: row.last_activity_at || row.updated_at
    }));
  }

  async function listAiTeacherConversationMessages(threadId, options = {}) {
    const poolInstance = await ensurePool();
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 300);
    if (!poolInstance) {
      return memoryAiMessages
        .filter((message) => message.threadId === threadId)
        .slice(-limit)
        .map(publicAdminAiMessage);
    }
    const result = await poolInstance.query(
      `select id, thread_id, role, content, model, token_usage_json, created_at
         from ai_teacher_messages
        where thread_id = $1
        order by created_at asc, id asc
        limit $2`,
      [threadId, limit]
    );
    return result.rows.map((row) => publicAdminAiMessage({
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.content,
      model: row.model,
      tokenUsage: row.token_usage_json || {},
      createdAt: row.created_at
    }));
  }

  async function listLiteLlmConfigVersions(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
    const includeRenderedYaml = options.includeRenderedYaml === true;
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      return memoryLiteLlmConfigVersions
        .slice()
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, limit)
        .map((row) => publicLiteLlmConfigVersion(row, { includeRenderedYaml }));
    }
    const result = await poolInstance.query(
      `select version_id, status, config_json, rendered_yaml, checksum, validation_json, created_by, published_by, notes, created_at, published_at
         from ai_teacher_litellm_config_versions
        order by created_at desc
        limit $1`,
      [limit]
    );
    return result.rows.map((row) => publicLiteLlmConfigVersion(row, { includeRenderedYaml }));
  }

  async function getLiteLlmConfigVersion(versionId, options = {}) {
    const id = String(versionId || '').trim();
    if (!id) return null;
    const includeRenderedYaml = options.includeRenderedYaml === true;
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryLiteLlmConfigVersions.find((item) => item.versionId === id || item.version_id === id);
      return row ? publicLiteLlmConfigVersion(row, { includeRenderedYaml }) : null;
    }
    const result = await poolInstance.query(
      `select version_id, status, config_json, rendered_yaml, checksum, validation_json, created_by, published_by, notes, created_at, published_at
         from ai_teacher_litellm_config_versions
        where version_id = $1`,
      [id]
    );
    return result.rows[0] ? publicLiteLlmConfigVersion(result.rows[0], { includeRenderedYaml }) : null;
  }

  async function getActiveLiteLlmConfigVersion(options = {}) {
    const includeRenderedYaml = options.includeRenderedYaml === true;
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryLiteLlmConfigVersions.find((item) => item.status === 'active') || memoryLiteLlmConfigVersions[0];
      return row ? publicLiteLlmConfigVersion(row, { includeRenderedYaml }) : null;
    }
    const result = await poolInstance.query(
      `select version_id, status, config_json, rendered_yaml, checksum, validation_json, created_by, published_by, notes, created_at, published_at
         from ai_teacher_litellm_config_versions
        where status = 'active'
        order by published_at desc nulls last, created_at desc
        limit 1`
    );
    return result.rows[0] ? publicLiteLlmConfigVersion(result.rows[0], { includeRenderedYaml }) : null;
  }

  async function createLiteLlmConfigVersion({ config, createdBy = '', notes = '', status = 'draft' } = {}) {
    const normalizedConfig = normalizeLiteLlmConfig(config || defaultLiteLlmConfig());
    const renderedYaml = renderLiteLlmConfigYaml(normalizedConfig);
    const validation = validateLiteLlmConfig(normalizedConfig);
    if (!validation.ok) {
      const error = new Error('LiteLLM config validation failed.');
      error.statusCode = 400;
      error.code = 'LITELLM_CONFIG_INVALID';
      error.details = validation.errors;
      throw error;
    }
    const row = {
      versionId: `litellm_cfg_${crypto.randomUUID()}`,
      status: ['draft', 'active'].includes(status) ? status : 'draft',
      config: normalizedConfig,
      renderedYaml,
      checksum: checksumText(renderedYaml),
      validation,
      createdBy,
      publishedBy: status === 'active' ? createdBy : '',
      notes,
      createdAt: new Date().toISOString(),
      publishedAt: status === 'active' ? new Date().toISOString() : null
    };
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      if (row.status === 'active') {
        memoryLiteLlmConfigVersions.forEach((item) => {
          if (item.status === 'active') item.status = 'retired';
        });
      }
      memoryLiteLlmConfigVersions.push(row);
      return publicLiteLlmConfigVersion(row, { includeRenderedYaml: true });
    }
    if (row.status === 'active') {
      await poolInstance.query(`update ai_teacher_litellm_config_versions set status = 'retired' where status = 'active'`);
    }
    await poolInstance.query(
      `insert into ai_teacher_litellm_config_versions
        (version_id, status, config_json, rendered_yaml, checksum, validation_json, created_by, published_by, notes, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.versionId,
        row.status,
        JSON.stringify(row.config),
        row.renderedYaml,
        row.checksum,
        JSON.stringify(row.validation),
        row.createdBy,
        row.publishedBy,
        row.notes,
        row.publishedAt
      ]
    );
    return getLiteLlmConfigVersion(row.versionId, { includeRenderedYaml: true });
  }

  async function publishLiteLlmConfigVersion({ versionId, actorUserId = '' } = {}) {
    const id = String(versionId || '').trim();
    if (!id) {
      const error = new Error('LiteLLM config version id is required.');
      error.statusCode = 400;
      error.code = 'LITELLM_CONFIG_VERSION_REQUIRED';
      throw error;
    }
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryLiteLlmConfigVersions.find((item) => item.versionId === id);
      if (!row) throwNotFoundLiteLlmConfigVersion();
      memoryLiteLlmConfigVersions.forEach((item) => {
        if (item.status === 'active') item.status = 'retired';
      });
      row.status = 'active';
      row.publishedBy = actorUserId;
      row.publishedAt = new Date().toISOString();
      return publicLiteLlmConfigVersion(row, { includeRenderedYaml: true });
    }
    const existing = await poolInstance.query(`select version_id from ai_teacher_litellm_config_versions where version_id = $1`, [id]);
    if (!existing.rows.length) throwNotFoundLiteLlmConfigVersion();
    const client = await poolInstance.connect();
    try {
      await client.query('begin');
      await client.query(`update ai_teacher_litellm_config_versions set status = 'retired' where status = 'active'`);
      await client.query(
        `update ai_teacher_litellm_config_versions
            set status = 'active',
                published_by = $2,
                published_at = now()
          where version_id = $1`,
        [id, actorUserId]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return getLiteLlmConfigVersion(id, { includeRenderedYaml: true });
  }

  async function recordLiteLlmCapabilityProbeRun({ versionId = '', configChecksum = '', run = {}, actorUserId = '' } = {}) {
    const row = normalizeLiteLlmCapabilityProbeRun({
      ...run,
      probeRunId: `litellm_probe_${crypto.randomUUID()}`,
      versionId,
      configChecksum,
      createdBy: actorUserId
    });
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryLiteLlmCapabilityProbeRuns.push(row);
      return publicLiteLlmCapabilityProbeRun(row);
    }
    await poolInstance.query(
      `insert into ai_teacher_llm_capability_probe_runs
        (probe_run_id, version_id, config_checksum, deployment_id, source_digest, status, readiness,
         declared_capabilities_json, base_probe_json, results_json, budget_json, usage_json, evidence_digest,
         error_code, created_by, started_at, completed_at, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        row.probeRunId,
        row.versionId,
        row.configChecksum,
        row.deploymentId,
        row.sourceDigest,
        row.status,
        row.readiness,
        JSON.stringify(row.declaredCapabilities),
        JSON.stringify(row.baseProbe),
        JSON.stringify(row.results),
        JSON.stringify(row.budget),
        JSON.stringify(row.usage),
        row.evidenceDigest,
        row.errorCode,
        row.createdBy,
        row.startedAt,
        row.completedAt,
        row.durationMs
      ]
    );
    return publicLiteLlmCapabilityProbeRun(row);
  }

  async function findLatestLiteLlmCapabilityProbeRun({ deploymentId = '', sourceDigest = '' } = {}) {
    const normalizedDeploymentId = String(deploymentId || '').trim();
    const normalizedSourceDigest = String(sourceDigest || '').trim();
    if (!normalizedDeploymentId || !normalizedSourceDigest) return null;
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryLiteLlmCapabilityProbeRuns
        .filter((item) => item.deploymentId === normalizedDeploymentId && item.sourceDigest === normalizedSourceDigest)
        .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))[0];
      return row ? publicLiteLlmCapabilityProbeRun(row) : null;
    }
    const result = await poolInstance.query(
      `select * from ai_teacher_llm_capability_probe_runs
        where deployment_id = $1 and source_digest = $2
        order by completed_at desc, created_at desc
        limit 1`,
      [normalizedDeploymentId, normalizedSourceDigest]
    );
    return result.rows[0] ? publicLiteLlmCapabilityProbeRun(result.rows[0]) : null;
  }

  async function listLiteLlmCapabilityProbeRuns(options = {}) {
    const versionId = String(options.versionId || '').trim();
    const deploymentId = String(options.deploymentId || '').trim();
    const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      return memoryLiteLlmCapabilityProbeRuns
        .filter((item) => (!versionId || item.versionId === versionId) && (!deploymentId || item.deploymentId === deploymentId))
        .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
        .slice(0, limit)
        .map(publicLiteLlmCapabilityProbeRun);
    }
    const clauses = [];
    const values = [];
    if (versionId) {
      values.push(versionId);
      clauses.push(`version_id = $${values.length}`);
    }
    if (deploymentId) {
      values.push(deploymentId);
      clauses.push(`deployment_id = $${values.length}`);
    }
    values.push(limit);
    const result = await poolInstance.query(
      `select * from ai_teacher_llm_capability_probe_runs
       ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
       order by completed_at desc, created_at desc
       limit $${values.length}`,
      values
    );
    return result.rows.map(publicLiteLlmCapabilityProbeRun);
  }

  async function listAgentResourcePolicyVersions(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      return memoryAgentResourcePolicyVersions
        .slice()
        .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))
        .slice(0, limit)
        .map(publicAgentResourcePolicyVersion);
    }
    const result = await poolInstance.query(
      `select version_id, sequence, status, values_json, checksum, validation_json, source_version_id, notes,
              created_by, validated_at, published_by, created_at, published_at
         from ai_teacher_agent_policy_versions
        order by sequence desc
        limit $1`,
      [limit]
    );
    return result.rows.map(publicAgentResourcePolicyVersion);
  }

  async function getAgentResourcePolicyVersion(versionId) {
    const id = normalizeAgentResourcePolicyVersionId(versionId);
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryAgentResourcePolicyVersions.find((item) => item.versionId === id);
      return row ? publicAgentResourcePolicyVersion(row) : null;
    }
    const result = await poolInstance.query(
      `select version_id, sequence, status, values_json, checksum, validation_json, source_version_id, notes,
              created_by, validated_at, published_by, created_at, published_at
         from ai_teacher_agent_policy_versions
        where version_id = $1`,
      [id]
    );
    return result.rows[0] ? publicAgentResourcePolicyVersion(result.rows[0]) : null;
  }

  async function getActiveAgentResourcePolicyVersion() {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryAgentResourcePolicyVersions.find((item) => item.status === 'active') || memoryAgentResourcePolicyVersions[0];
      return row ? publicAgentResourcePolicyVersion(row) : null;
    }
    const result = await poolInstance.query(
      `select version_id, sequence, status, values_json, checksum, validation_json, source_version_id, notes,
              created_by, validated_at, published_by, created_at, published_at
         from ai_teacher_agent_policy_versions
        where status = 'active'
        order by published_at desc nulls last, sequence desc
        limit 1`
    );
    return result.rows[0] ? publicAgentResourcePolicyVersion(result.rows[0]) : null;
  }

  async function createAgentResourcePolicyVersion({ values, sourceVersionId = '', notes = '', actorUserId = '', modelRegistry } = {}) {
    const source = sourceVersionId
      ? await getAgentResourcePolicyVersion(sourceVersionId)
      : await getActiveAgentResourcePolicyVersion();
    const requestedValues = values === undefined ? source?.values : values;
    const normalizedInput = normalizeAgentResourcePolicyDraftValues(requestedValues);
    const validation = validateAgentResourcePolicyValues(normalizedInput, { baseline: source?.values, modelRegistry });
    if (validation.errors.some((item) => item.code === 'POLICY_FIELD_UNKNOWN')) throwAgentResourcePolicyInvalid(validation);
    const row = {
      versionId: `arp_${crypto.randomUUID()}`,
      sequence: nextMemoryPolicySequence(memoryAgentResourcePolicyVersions),
      status: 'draft',
      values: normalizedInput,
      checksum: checksumAgentResourcePolicyValues(normalizedInput),
      validation,
      sourceVersionId: source?.versionId || '',
      notes: String(notes || '').slice(0, 1000),
      createdBy: actorUserId,
      validatedAt: null,
      publishedBy: '',
      createdAt: new Date().toISOString(),
      publishedAt: null
    };
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAgentResourcePolicyVersions.push(row);
      return publicAgentResourcePolicyVersion(row);
    }
    await poolInstance.query(
      `insert into ai_teacher_agent_policy_versions
        (version_id, status, values_json, checksum, validation_json, source_version_id, notes, created_by)
       values ($1, 'draft', $2, $3, $4, $5, $6, $7)`,
      [row.versionId, JSON.stringify(row.values), row.checksum, JSON.stringify(validation), row.sourceVersionId || null, row.notes, row.createdBy || null]
    );
    return getAgentResourcePolicyVersion(row.versionId);
  }

  async function validateAgentResourcePolicyVersion({ versionId, actorUserId = '', modelRegistry } = {}) {
    const version = await getAgentResourcePolicyVersion(versionId);
    if (!version) throwNotFoundAgentResourcePolicyVersion();
    if (version.status === 'active' || version.status === 'retired') {
      const error = new Error('Only draft or validated Agent resource policy versions can be validated.');
      error.statusCode = 409;
      error.code = 'AGENT_RESOURCE_POLICY_VERSION_IMMUTABLE';
      throw error;
    }
    const active = await getActiveAgentResourcePolicyVersion();
    const validation = validateAgentResourcePolicyValues(version.values, { baseline: active?.values, modelRegistry });
    const nextStatus = validation.ok ? 'validated' : 'draft';
    const validatedAt = new Date().toISOString();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const row = memoryAgentResourcePolicyVersions.find((item) => item.versionId === version.versionId);
      Object.assign(row, { status: nextStatus, validation, validatedAt });
    } else {
      await poolInstance.query(
        `update ai_teacher_agent_policy_versions
            set status = $2, validation_json = $3, validated_at = $4
          where version_id = $1`,
        [version.versionId, nextStatus, JSON.stringify(validation), validatedAt]
      );
    }
    await recordAdminAudit({
      actorUserId,
      eventType: 'ai_teacher.agent_resource_policy.validated',
      targetType: 'ai_teacher_agent_resource_policy',
      targetRef: version.versionId,
      metadata: { ok: validation.ok, errorCount: validation.errors.length, warningCount: validation.warnings.length }
    });
    return getAgentResourcePolicyVersion(version.versionId);
  }

  async function publishAgentResourcePolicyVersion({ versionId, actorUserId = '', modelRegistry } = {}) {
    const version = await getAgentResourcePolicyVersion(versionId);
    if (!version) throwNotFoundAgentResourcePolicyVersion();
    const activeBefore = await getActiveAgentResourcePolicyVersion();
    const validation = validateAgentResourcePolicyValues(version.values, { baseline: activeBefore?.values, modelRegistry });
    if (!validation.ok) throwAgentResourcePolicyInvalid(validation);
    const snapshot = createAgentResourcePolicySnapshot({ versionId: version.versionId, values: validation.values });
    if (snapshot.checksum !== version.checksum) {
      const error = new Error('Agent resource policy checksum changed after validation.');
      error.statusCode = 409;
      error.code = 'AGENT_RESOURCE_POLICY_CHECKSUM_CHANGED';
      throw error;
    }
    const publishedAt = new Date().toISOString();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAgentResourcePolicyVersions.forEach((row) => {
        if (row.status === 'active') row.status = 'retired';
      });
      const row = memoryAgentResourcePolicyVersions.find((item) => item.versionId === version.versionId);
      Object.assign(row, { status: 'active', validation, validatedAt: row.validatedAt || publishedAt, publishedBy: actorUserId, publishedAt });
    } else {
      const client = await poolInstance.connect();
      try {
        await client.query('begin');
        await client.query(`select pg_advisory_xact_lock(hashtext('ai_teacher_agent_resource_policy_active'))`);
        await client.query(`update ai_teacher_agent_policy_versions set status = 'retired' where status = 'active'`);
        const result = await client.query(
          `update ai_teacher_agent_policy_versions
              set status = 'active', validation_json = $2, validated_at = coalesce(validated_at, $3),
                  published_by = $4, published_at = $3
            where version_id = $1
          returning version_id`,
          [version.versionId, JSON.stringify(validation), publishedAt, actorUserId || null]
        );
        if (!result.rows.length) throwNotFoundAgentResourcePolicyVersion();
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    const published = await getAgentResourcePolicyVersion(version.versionId);
    await recordAdminAudit({
      actorUserId,
      eventType: 'ai_teacher.agent_resource_policy.published',
      targetType: 'ai_teacher_agent_resource_policy',
      targetRef: version.versionId,
      metadata: {
        previousVersionId: activeBefore?.versionId || null,
        checksum: published.checksum,
        changedKeys: diffAgentResourcePolicyValues(activeBefore?.values || {}, published.values).map((item) => item.key)
      }
    });
    return published;
  }

  async function rollbackAgentResourcePolicyVersion({ targetVersionId, actorUserId = '', notes = '' } = {}) {
    const target = await getAgentResourcePolicyVersion(targetVersionId);
    if (!target) throwNotFoundAgentResourcePolicyVersion();
    const draft = await createAgentResourcePolicyVersion({
      values: target.values,
      sourceVersionId: target.versionId,
      actorUserId,
      notes: String(notes || `Rollback to ${target.versionId}`).slice(0, 1000)
    });
    await validateAgentResourcePolicyVersion({ versionId: draft.versionId, actorUserId });
    const published = await publishAgentResourcePolicyVersion({ versionId: draft.versionId, actorUserId });
    await recordAdminAudit({
      actorUserId,
      eventType: 'ai_teacher.agent_resource_policy.rolled_back',
      targetType: 'ai_teacher_agent_resource_policy',
      targetRef: published.versionId,
      metadata: { sourceVersionId: target.versionId }
    });
    return published;
  }

  async function recordAiQuotaEvent(event = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAiQuotaEvents.push({
        id: memoryAiQuotaEvents.length + 1,
        userId: event.userId || null,
        tenantId: event.tenantId || '',
        requestId: event.requestId || '',
        capability: event.capability || '',
        decision: event.decision || 'deny',
        reason: event.reason || '',
        dailyUsedTokens: Number(event.dailyUsedTokens || 0),
        weeklyUsedTokens: Number(event.weeklyUsedTokens || 0),
        monthlyUsedTokens: Number(event.monthlyUsedTokens || 0),
        dailyLimitTokens: Number(event.dailyLimitTokens || 0),
        weeklyLimitTokens: Number(event.weeklyLimitTokens || 0),
        monthlyLimitTokens: Number(event.monthlyLimitTokens || 0),
        metadata: event.metadata || {},
        createdAt: new Date().toISOString()
      });
      return;
    }
    await poolInstance.query(
      `insert into ai_teacher_quota_events
        (user_id, tenant_id, request_id, capability, decision, reason, daily_used_tokens,
         weekly_used_tokens, monthly_used_tokens, daily_limit_tokens, weekly_limit_tokens,
         monthly_limit_tokens, metadata_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        event.userId || null,
        event.tenantId || '',
        event.requestId || '',
        event.capability || '',
        event.decision || 'deny',
        event.reason || '',
        Number(event.dailyUsedTokens || 0),
        Number(event.weeklyUsedTokens || 0),
        Number(event.monthlyUsedTokens || 0),
        Number(event.dailyLimitTokens || 0),
        Number(event.weeklyLimitTokens || 0),
        Number(event.monthlyLimitTokens || 0),
        JSON.stringify(event.metadata || {})
      ]
    );
  }

  async function listAiQuotaEvents(options = {}) {
    const poolInstance = await ensurePool();
    const userId = String(options.userId || '').trim();
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 200);
    if (!poolInstance) {
      return memoryAiQuotaEvents
        .filter((event) => !userId || event.userId === userId)
        .slice(-limit)
        .reverse();
    }
    const result = await poolInstance.query(
      `select id, user_id, tenant_id, request_id, capability, decision, reason,
              daily_used_tokens, weekly_used_tokens, monthly_used_tokens,
              daily_limit_tokens, weekly_limit_tokens, monthly_limit_tokens,
              metadata_json, created_at
         from ai_teacher_quota_events
        where ($1 = '' or user_id = $1)
        order by created_at desc
        limit $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      requestId: row.request_id,
      capability: row.capability,
      decision: row.decision,
      reason: row.reason,
      dailyUsedTokens: row.daily_used_tokens,
      weeklyUsedTokens: row.weekly_used_tokens,
      monthlyUsedTokens: row.monthly_used_tokens,
      dailyLimitTokens: row.daily_limit_tokens,
      weeklyLimitTokens: row.weekly_limit_tokens,
      monthlyLimitTokens: row.monthly_limit_tokens,
      metadata: row.metadata_json || {},
      createdAt: row.created_at
    }));
  }

  async function recordAdminAudit(event = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) return recordAdminAuditMemory(event);
    await poolInstance.query(
      `insert into admin_audit_events (actor_user_id, event_type, target_type, target_ref, request_id, metadata_json)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        event.actorUserId || null,
        event.eventType || 'entitlement.changed',
        event.targetType || null,
        event.targetRef || null,
        event.requestId || null,
        JSON.stringify(event.metadata || {})
      ]
    );
  }

  async function listUsers(options = {}) {
    const page = await listUsersPage(options);
    return page.users;
  }

  async function listUsersPage(options = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const rows = [...profiles.values()].map((profile) => ({
        id: profile.userId,
        email: profile.email || '',
        displayName: profile.displayName || profile.userId,
        status: profile.status || 'active',
        tier: profile.tier || 'free',
        createdAt: profile.createdAt || null,
        updatedAt: profile.updatedAt || null,
        lastLoginAt: profile.lastLoginAt || null,
        lastActivityAt: profile.lastActivityAt || null,
        activeDurationSeconds: Number(profile.activeSeconds || 0)
      }));
      return filterSortAndPageUsers(rows, options);
    }
    const search = String(options.search || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 200);
    const rawOffset = Number(options.offset || 0);
    const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.floor(rawOffset), 0), 1_000_000) : 0;
    const { orderBy, orderDirection } = adminUserSqlSort(options);
    const [countResult, result] = await Promise.all([
      poolInstance.query(
        `select count(*)::integer as total
           from app_user_profiles p
           left join "user" u on u.id = p.user_id
          where ($1 = '' or lower(coalesce(u.email, '') || ' ' || coalesce(p.display_name, '') || ' ' || p.user_id) like '%' || $1 || '%')`,
        [search]
      ),
      poolInstance.query(
      `select p.user_id,
              coalesce(u.email, '') as email,
              coalesce(p.display_name, u.name, u.email, p.user_id) as display_name,
              p.status,
               p.default_tier,
               p.created_at,
               p.updated_at,
               p.last_login_at,
               p.last_activity_at,
               p.active_seconds
         from app_user_profiles p
         left join "user" u on u.id = p.user_id
        where ($1 = '' or lower(coalesce(u.email, '') || ' ' || coalesce(p.display_name, '') || ' ' || p.user_id) like '%' || $1 || '%')
        order by ${orderBy} ${orderDirection} nulls last, p.user_id asc
        limit $2 offset $3`,
        [search, limit, offset]
      )
    ]);
    return {
      users: result.rows.map(userRow),
      total: Number(countResult.rows[0]?.total || 0)
    };
  }

  async function getUserProfile(userId) {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const profile = profiles.get(userId);
      if (!profile) return null;
      return {
        id: profile.userId,
        email: profile.email || '',
        displayName: profile.displayName || profile.userId,
        status: profile.status || 'active',
        tier: profile.tier || 'free',
        createdAt: profile.createdAt || null,
        updatedAt: profile.updatedAt || null,
        lastLoginAt: profile.lastLoginAt || null,
        lastActivityAt: profile.lastActivityAt || null,
        activeDurationSeconds: Number(profile.activeSeconds || 0),
        entitlements: await listEntitlementsDetailed(profile.userId, profile.tier, profile.email)
      };
    }
    const result = await poolInstance.query(
      `select p.user_id,
              coalesce(u.email, '') as email,
              coalesce(p.display_name, u.name, u.email, p.user_id) as display_name,
              p.status,
               p.default_tier,
               p.created_at,
               p.updated_at,
               p.last_login_at,
               p.last_activity_at,
               p.active_seconds
         from app_user_profiles p
         left join "user" u on u.id = p.user_id
        where p.user_id = $1`,
      [userId]
    );
    if (!result.rows[0]) return null;
    const user = userRow(result.rows[0]);
    user.entitlements = await listEntitlementsDetailed(user.id, user.tier, user.email);
    return user;
  }

  async function updateUserTier({ actorUserId, userId, tier, requestId }) {
    if (!['free', 'plus'].includes(tier)) {
      const error = new Error('账号档次必须是 free 或 plus。');
      error.statusCode = 400;
      error.code = 'INVALID_TIER';
      throw error;
    }
    const before = await getUserProfile(userId);
    if (!before) throwUserNotFound();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const profile = profiles.get(userId);
      profile.tier = tier;
      profile.updatedAt = new Date().toISOString();
      await recordAdminAuditMemory({ actorUserId, eventType: 'user.tier.changed', targetRef: userId, metadata: { beforeTier: before.tier, afterTier: tier } });
      return { before, after: await getUserProfile(userId) };
    }
    await poolInstance.query(
      `update app_user_profiles
          set default_tier = $2,
              updated_at = now()
        where user_id = $1`,
      [userId, tier]
    );
    const after = await getUserProfile(userId);
    await recordAdminAudit({
      actorUserId,
      eventType: 'user.tier.changed',
      targetType: 'user',
      targetRef: userId,
      requestId,
      metadata: { beforeTier: before.tier, afterTier: after.tier }
    });
    return { before, after };
  }

  async function updateUserStatus({ actorUserId, userId, status, requestId }) {
    if (!['active', 'disabled'].includes(status)) {
      const error = new Error('账号状态必须是 active 或 disabled。');
      error.statusCode = 400;
      error.code = 'INVALID_STATUS';
      throw error;
    }
    const before = await getUserProfile(userId);
    if (!before) throwUserNotFound();
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const profile = profiles.get(userId);
      profile.status = status;
      profile.updatedAt = new Date().toISOString();
      await recordAdminAuditMemory({ actorUserId, eventType: status === 'disabled' ? 'user.disabled' : 'user.enabled', targetRef: userId, metadata: { beforeStatus: before.status, afterStatus: status } });
      return { before, after: await getUserProfile(userId) };
    }
    await poolInstance.query(
      `update app_user_profiles
          set status = $2,
              updated_at = now()
        where user_id = $1`,
      [userId, status]
    );
    const after = await getUserProfile(userId);
    await recordAdminAudit({
      actorUserId,
      eventType: status === 'disabled' ? 'user.disabled' : 'user.enabled',
      targetType: 'user',
      targetRef: userId,
      requestId,
      metadata: { beforeStatus: before.status, afterStatus: after.status }
    });
    return { before, after };
  }

  async function getAuthSettings() {
    const poolInstance = await ensurePool();
    if (!poolInstance) return { ...memoryAuthSettings };
    const result = await poolInstance.query(
      `select registration_enabled, guest_login_enabled, updated_by, updated_at
         from auth_settings
        where singleton_id = true`
    );
    if (!result.rows[0]) return defaultAuthSettings();
    return authSettingsRow(result.rows[0]);
  }

  async function updateAuthSettings({ actorUserId = '', settings = {}, requestId = '' } = {}) {
    const before = await getAuthSettings();
    const next = normalizeAuthSettings({ ...before, ...settings });
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryAuthSettings = next;
      await recordAdminAuditMemory({
        actorUserId,
        eventType: 'auth.settings.changed',
        targetRef: 'auth-settings',
        requestId,
        metadata: { before, after: next }
      });
      return { before, settings: { ...next } };
    }
    const result = await poolInstance.query(
      `insert into auth_settings (singleton_id, registration_enabled, guest_login_enabled, updated_by, updated_at)
       values (true, $1, $2, $3, now())
       on conflict (singleton_id) do update
         set registration_enabled = excluded.registration_enabled,
             guest_login_enabled = excluded.guest_login_enabled,
             updated_by = excluded.updated_by,
             updated_at = now()
       returning registration_enabled, guest_login_enabled, updated_by, updated_at`,
      [next.registrationEnabled, next.guestLoginEnabled, actorUserId || null]
    );
    const after = authSettingsRow(result.rows[0]);
    await recordAdminAudit({
      actorUserId,
      eventType: 'auth.settings.changed',
      targetType: 'auth',
      targetRef: 'auth-settings',
      requestId,
      metadata: { before, after }
    });
    return { before, settings: after };
  }

  async function getExternalModelingToolSettings(toolId = SYSON_TOOL_ID) {
    if (toolId !== SYSON_TOOL_ID) throwExternalModelingToolNotFound(toolId);
    const poolInstance = await ensurePool();
    if (!poolInstance) return { ...memoryExternalModelingToolSettings };
    const result = await poolInstance.query(
      `select tool_id, enabled, frontend_visible, model_generation_enabled, direct_write_enabled, updated_by, updated_at
         from external_modeling_tool_settings
        where tool_id = $1`,
      [toolId]
    );
    return result.rows[0]
      ? externalModelingToolSettingsRow(result.rows[0])
      : defaultExternalModelingToolSettings();
  }

  async function updateExternalModelingToolSettings({ actorUserId = '', toolId = SYSON_TOOL_ID, settings = {}, requestId = '' } = {}) {
    if (toolId !== SYSON_TOOL_ID) throwExternalModelingToolNotFound(toolId);
    const before = await getExternalModelingToolSettings(toolId);
    const next = normalizeExternalModelingToolSettings({ ...before, ...settings }, before);
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      memoryExternalModelingToolSettings = {
        ...next,
        updatedBy: actorUserId || '',
        updatedAt: new Date().toISOString()
      };
      await recordAdminAuditMemory({
        actorUserId,
        eventType: 'external_modeling_tool.settings.changed',
        targetRef: toolId,
        requestId,
        metadata: { before: externalModelingToolAuditView(before), after: externalModelingToolAuditView(memoryExternalModelingToolSettings) }
      });
      return { before, settings: { ...memoryExternalModelingToolSettings } };
    }
    const result = await poolInstance.query(
      `insert into external_modeling_tool_settings
         (tool_id, enabled, frontend_visible, model_generation_enabled, direct_write_enabled, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (tool_id) do update
         set enabled = excluded.enabled,
             frontend_visible = excluded.frontend_visible,
             model_generation_enabled = excluded.model_generation_enabled,
             direct_write_enabled = excluded.direct_write_enabled,
             updated_by = excluded.updated_by,
             updated_at = now()
       returning tool_id, enabled, frontend_visible, model_generation_enabled, direct_write_enabled, updated_by, updated_at`,
      [
        toolId,
        next.enabled,
        next.frontendVisible,
        next.modelGenerationEnabled,
        next.directWriteEnabled,
        actorUserId || null
      ]
    );
    const after = externalModelingToolSettingsRow(result.rows[0]);
    await recordAdminAudit({
      actorUserId,
      eventType: 'external_modeling_tool.settings.changed',
      targetType: 'external_modeling_tool',
      targetRef: toolId,
      requestId,
      metadata: { before: externalModelingToolAuditView(before), after: externalModelingToolAuditView(after) }
    });
    return { before, settings: after };
  }

  async function bootstrapAdmin({ targetUserId = '', targetEmail = '', actor = 'owner-bootstrap', requestId = '', apply = false } = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const error = new Error('AUTH_DATABASE_URL is required for admin bootstrap.');
      error.statusCode = 500;
      error.code = 'AUTH_DATABASE_URL_REQUIRED';
      throw error;
    }
    const id = String(targetUserId || '').trim();
    const email = String(targetEmail || '').trim().toLowerCase();
    if (!id && !email) {
      const error = new Error('bootstrap requires target user id or email.');
      error.statusCode = 400;
      error.code = 'BOOTSTRAP_TARGET_REQUIRED';
      throw error;
    }
    const userResult = await poolInstance.query(
      `select id, email, name, "emailVerified" as email_verified
         from "user"
        where ($1 = '' or id = $1)
          and ($2 = '' or lower(email) = $2)
        limit 2`,
      [id, email]
    );
    if (userResult.rows.length !== 1) {
      const error = new Error(userResult.rows.length ? 'bootstrap target is ambiguous.' : 'bootstrap target user not found.');
      error.statusCode = userResult.rows.length ? 409 : 404;
      error.code = userResult.rows.length ? 'BOOTSTRAP_TARGET_AMBIGUOUS' : 'BOOTSTRAP_TARGET_NOT_FOUND';
      throw error;
    }
    const row = userResult.rows[0];
    if (!row.email_verified) {
      const error = new Error('bootstrap target email is not verified.');
      error.statusCode = 400;
      error.code = 'BOOTSTRAP_EMAIL_NOT_VERIFIED';
      throw error;
    }
    const profile = await getOrCreateProfile({
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: row.email_verified
    });
    if (profile.status !== 'active') {
      const error = new Error('bootstrap target user is not active.');
      error.statusCode = 400;
      error.code = 'BOOTSTRAP_USER_NOT_ACTIVE';
      throw error;
    }
    const before = await listEntitlementsDetailed(row.id, profile.tier, row.email);
    const missing = ADMIN_ENTITLEMENTS.filter((code) => !before.some((entitlement) => entitlement.code === code));
    if (apply) {
      await grantEntitlements({
        actorUserId: actor,
        userId: row.id,
        entitlementCodes: ADMIN_ENTITLEMENTS,
        source: 'bootstrap',
        requestId,
        auditEventType: 'admin.bootstrap',
        auditMetadata: { targetEmail: row.email }
      });
    }
    return {
      apply,
      user: {
        id: row.id,
        email: row.email,
        displayName: profile.displayName,
        status: profile.status,
        tier: profile.tier
      },
      missingEntitlements: missing,
      resultingEntitlements: apply ? await listEntitlementsDetailed(row.id, profile.tier, row.email) : before
    };
  }

  async function grantEntitlements({ actorUserId, userId, entitlementCodes = [], source = 'manual', requestId = '', auditEventType = 'entitlement.granted', auditMetadata = {} } = {}) {
    const target = await getUserProfile(userId);
    if (!target) throwUserNotFound();
    const codes = unique(entitlementCodes.map((code) => String(code || '').trim()).filter(Boolean));
    if (!codes.length) return { user: target, granted: [] };
    const poolInstance = await ensurePool();
    if (!poolInstance) {
      const existing = memoryUserEntitlements.get(userId) || [];
      const next = dedupeEntitlements([
        ...existing,
        ...codes.map((code) => entitlementRecord(code, 'global', '*', source))
      ]);
      memoryUserEntitlements.set(userId, next);
      await recordAdminAuditMemory({
        actorUserId,
        eventType: auditEventType,
        targetRef: userId,
        requestId,
        metadata: { ...auditMetadata, granted: codes, source }
      });
      return { user: await getUserProfile(userId), granted: codes };
    }
    for (const code of codes) {
      await poolInstance.query(
        `insert into user_entitlements (user_id, entitlement_code, scope, scope_ref, source)
         values ($1, $2, 'global', '*', $3)
         on conflict (user_id, entitlement_code, scope, scope_ref) do update set source = excluded.source`,
        [userId, code, source]
      );
    }
    await recordAdminAudit({
      actorUserId,
      eventType: auditEventType,
      targetType: 'user',
      targetRef: userId,
      requestId,
      metadata: { ...auditMetadata, granted: codes, source }
    });
    return { user: await getUserProfile(userId), granted: codes };
  }

  async function listAdminAuditEvents(options = {}) {
    const poolInstance = await ensurePool();
    const targetRef = String(options.targetRef || '').trim();
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 200);
    if (!poolInstance) {
      return memoryAdminAuditEvents
        .filter((event) => !targetRef || event.targetRef === targetRef)
        .slice(-limit)
        .reverse();
    }
    const result = await poolInstance.query(
      `select id, actor_user_id, event_type, target_type, target_ref, request_id, metadata_json, created_at
         from admin_audit_events
        where ($1 = '' or target_ref = $1)
        order by created_at desc
        limit $2`,
      [targetRef, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      eventType: row.event_type,
      targetType: row.target_type,
      targetRef: row.target_ref,
      requestId: row.request_id,
      metadata: row.metadata_json || {},
      createdAt: row.created_at
    }));
  }

  async function recordAdminAuditMemory(event = {}) {
    memoryAdminAuditEvents.push({
      id: memoryAdminAuditEvents.length + 1,
      actorUserId: event.actorUserId || null,
      eventType: event.eventType || 'entitlement.changed',
      targetType: event.targetType || 'user',
      targetRef: event.targetRef || null,
      requestId: event.requestId || null,
      metadata: event.metadata || {},
      createdAt: new Date().toISOString()
    });
  }

  async function recordProgressMetadata(user, progress = {}, packId = '') {
    const poolInstance = await ensurePool();
    if (!poolInstance || !user?.id) return;
    await poolInstance.query(
      `insert into user_course_progress (user_id, course_pack_id, completed_lessons, completed_courses)
       values ($1, $2, $3, $4)
       on conflict (user_id, course_pack_id) do update
         set completed_lessons = excluded.completed_lessons,
             completed_courses = excluded.completed_courses,
             updated_at = now()`,
      [
        user.id,
        progress.coursePackId || packId,
        JSON.stringify(progress.completedLessons || []),
        JSON.stringify(progress.completedCourses || [])
      ]
    );
  }

  async function recordDraftMetadata(user, draftId, draft = {}) {
    const poolInstance = await ensurePool();
    if (!poolInstance || !user?.id) return;
    await poolInstance.query(
      `insert into user_drafts (user_id, draft_id, course_pack_id, lesson_id, entry_file, files_json, template_signature)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, draft_id) do update
         set course_pack_id = excluded.course_pack_id,
             lesson_id = excluded.lesson_id,
             entry_file = excluded.entry_file,
             files_json = excluded.files_json,
             template_signature = excluded.template_signature,
             updated_at = now()`,
      [
        user.id,
        draftId,
        draft.coursePackId || null,
        draft.lessonId || draftId || null,
        draft.entryFile || null,
        JSON.stringify(draft.files || []),
        draft.templateSignature || null
      ]
    );
  }

  async function deleteDraftMetadata(user, draftId) {
    const poolInstance = await ensurePool();
    if (!poolInstance || !user?.id) return;
    await poolInstance.query('delete from user_drafts where user_id = $1 and draft_id = $2', [user.id, draftId]);
  }

  function defaultTierFor(authUser) {
    const email = String(authUser.email || '').toLowerCase();
    if (authUser.isAnonymous) return 'guest';
    return plusEmails.has(email) ? 'plus' : 'free';
  }

  return {
    databaseUrl,
    ensureSchema: async () => ensurePool(),
    publicUserFromAuthUser,
    listEntitlements,
    listEntitlementsDetailed,
    recordAuthAudit,
    recordPlatformActivity,
    recordAiAccessEvent,
    ensureAiTeacherRuntimeAssignment,
    recordAiExchange,
    getAiUsageSummary,
    resetAiTeacherQuota,
    checkAiTeacherQuota,
    reserveAiTeacherBudget,
    releaseAiTeacherBudget,
    getAiTeacherTierPolicies,
    updateAiTeacherTierPolicies,
    getAiTeacherAdminUsageSummary,
    listAiTeacherUsageUsers,
    listAiTeacherConversations,
    listAiTeacherConversationMessages,
    listLiteLlmConfigVersions,
    getLiteLlmConfigVersion,
    getActiveLiteLlmConfigVersion,
    createLiteLlmConfigVersion,
    publishLiteLlmConfigVersion,
    recordLiteLlmCapabilityProbeRun,
    findLatestLiteLlmCapabilityProbeRun,
    listLiteLlmCapabilityProbeRuns,
    listAgentResourcePolicyVersions,
    getAgentResourcePolicyVersion,
    getActiveAgentResourcePolicyVersion,
    createAgentResourcePolicyVersion,
    validateAgentResourcePolicyVersion,
    publishAgentResourcePolicyVersion,
    rollbackAgentResourcePolicyVersion,
    recordAiQuotaEvent,
    listAiQuotaEvents,
    recordAdminAudit,
    listUsers,
    listUsersPage,
    getUserProfile,
    updateUserTier,
    updateUserStatus,
    getAuthSettings,
    updateAuthSettings,
    getExternalModelingToolSettings,
    updateExternalModelingToolSettings,
    bootstrapAdmin,
    grantEntitlements,
    listAdminAuditEvents,
    recordProgressMetadata,
    recordDraftMetadata,
    deleteDraftMetadata
  };
}

async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists app_user_profiles (
      user_id text primary key,
      display_name text,
      status text not null default 'active',
      default_tier text not null default 'free',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_login_at timestamptz,
      last_activity_at timestamptz,
      active_seconds bigint not null default 0
    );
    create table if not exists account_tiers (
      code text primary key,
      name text not null,
      description text
    );
    create table if not exists entitlements (
      code text primary key,
      description text
    );
    create table if not exists tier_entitlements (
      tier_code text not null references account_tiers(code) on delete cascade,
      entitlement_code text not null references entitlements(code) on delete cascade,
      scope text not null default 'global',
      scope_ref text not null default '*',
      primary key (tier_code, entitlement_code, scope, scope_ref)
    );
    create table if not exists user_entitlements (
      user_id text not null,
      entitlement_code text not null references entitlements(code) on delete cascade,
      scope text not null default 'global',
      scope_ref text not null default '*',
      source text not null default 'manual',
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      primary key (user_id, entitlement_code, scope, scope_ref)
    );
    create table if not exists auth_settings (
      singleton_id boolean primary key default true check (singleton_id),
      registration_enabled boolean not null default true,
      guest_login_enabled boolean not null default true,
      updated_by text,
      updated_at timestamptz not null default now()
    );
    create table if not exists external_modeling_tool_settings (
      tool_id text primary key,
      enabled boolean not null default false,
      frontend_visible boolean not null default false,
      model_generation_enabled boolean not null default false,
      direct_write_enabled boolean not null default false,
      updated_by text,
      updated_at timestamptz not null default now()
    );
    create table if not exists subscriptions (
      id text primary key,
      user_id text not null,
      plan_code text not null,
      status text not null,
      starts_at timestamptz,
      ends_at timestamptz,
      provider text,
      provider_order_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists auth_audit_events (
      id bigserial primary key,
      user_id text,
      event_type text not null,
      provider text,
      ip_hash text,
      user_agent_hash text,
      request_id text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists user_course_progress (
      user_id text not null,
      course_pack_id text not null,
      completed_lessons jsonb not null default '[]'::jsonb,
      completed_courses jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now(),
      primary key (user_id, course_pack_id)
    );
    create table if not exists user_drafts (
      user_id text not null,
      draft_id text not null,
      course_pack_id text,
      lesson_id text,
      entry_file text,
      files_json jsonb not null default '[]'::jsonb,
      template_signature text,
      updated_at timestamptz not null default now(),
      primary key (user_id, draft_id)
    );
    create table if not exists user_model_files (
      user_id text not null,
      file_id text not null,
      course_pack_id text,
      lesson_id text,
      filename text not null,
      content_json jsonb,
      storage_uri text,
      source text not null default 'draft',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (user_id, file_id)
    );
    create table if not exists ai_teacher_threads (
      id text primary key,
      user_id text not null,
      tenant_id text not null default '',
      lesson_id text,
      title text,
      runtime_assignment_id text,
      runtime text not null default 'ai-sdk',
      policy_version text not null default 'single-entry-v1',
      bucket integer not null default 0,
      assigned_at timestamptz,
      override_reason text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table ai_teacher_threads add column if not exists tenant_id text not null default '';
    alter table ai_teacher_threads add column if not exists runtime_assignment_id text;
    alter table ai_teacher_threads add column if not exists runtime text not null default 'ai-sdk';
    alter table ai_teacher_threads alter column runtime set default 'ai-sdk';
    alter table ai_teacher_threads add column if not exists policy_version text not null default 'single-entry-v1';
    alter table ai_teacher_threads alter column policy_version set default 'single-entry-v1';
    alter table ai_teacher_threads add column if not exists bucket integer not null default 0;
    alter table ai_teacher_threads add column if not exists assigned_at timestamptz;
    alter table ai_teacher_threads add column if not exists override_reason text not null default '';
    update ai_teacher_threads set runtime = 'ai-sdk', bucket = 0, override_reason = '' where runtime <> 'ai-sdk';
    create table if not exists ai_teacher_messages (
      id text primary key,
      thread_id text not null references ai_teacher_threads(id) on delete cascade,
      role text not null,
      content text not null,
      model text,
      token_usage_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_usage_ledger (
      id bigserial primary key,
      user_id text not null,
      tenant_id text not null default '',
      thread_id text,
      message_id text,
      capability text not null,
      model text,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      total_tokens integer not null default 0,
      metered_prompt_tokens integer not null default 0,
      metered_completion_tokens integer not null default 0,
      metered_reasoning_tokens integer not null default 0,
      metered_total_tokens integer not null default 0,
      provider_prompt_tokens integer not null default 0,
      provider_completion_tokens integer not null default 0,
      provider_reasoning_tokens integer not null default 0,
      provider_total_tokens integer not null default 0,
      usage_source text not null default 'provider',
      status text not null default 'succeeded',
      estimated_cost_json jsonb not null default '{}'::jsonb,
      entitlement_code text,
      request_id text,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_access_events (
      id bigserial primary key,
      user_id text,
      decision text not null,
      entitlement_code text not null,
      reason text,
      lesson_id text,
      request_id text,
      created_at timestamptz not null default now()
    );
    create table if not exists admin_audit_events (
      id bigserial primary key,
      actor_user_id text,
      event_type text not null,
      target_type text,
      target_ref text,
      request_id text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_teacher_quota_events (
      id bigserial primary key,
      user_id text,
      tenant_id text not null default '',
      request_id text not null default '',
      capability text,
      decision text not null,
      reason text not null,
      daily_used_tokens integer not null default 0,
      weekly_used_tokens integer not null default 0,
      monthly_used_tokens integer not null default 0,
      daily_limit_tokens integer not null default 0,
      weekly_limit_tokens integer not null default 0,
      monthly_limit_tokens integer not null default 0,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_teacher_quota_resets (
      user_id text primary key,
      reset_at timestamptz not null default now(),
      reset_by text
    );
    create table if not exists ai_teacher_tier_policies (
      tier_code text primary key references account_tiers(code) on delete cascade,
      enabled boolean not null default false,
      daily_token_limit integer not null default 0,
      weekly_token_limit integer not null default 0,
      updated_by text,
      updated_at timestamptz not null default now()
    );
    create table if not exists ai_teacher_budget_reservations (
      reservation_id text primary key,
      user_id text not null,
      tenant_id text not null default '',
      request_id text not null default '',
      capability text not null default 'answer',
      tier_code text not null default 'free',
      reserved_tokens integer not null check (reserved_tokens > 0),
      actual_tokens integer,
      status text not null default 'active' check (status in ('active', 'settled', 'released', 'expired')),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      settled_at timestamptz,
      released_at timestamptz,
      release_reason text not null default ''
    );
    create table if not exists ai_teacher_litellm_config_versions (
      version_id text primary key,
      status text not null default 'draft',
      config_json jsonb not null,
      rendered_yaml text not null,
      checksum text not null,
      validation_json jsonb not null default '{}'::jsonb,
      created_by text,
      published_by text,
      notes text,
      created_at timestamptz not null default now(),
      published_at timestamptz
    );
    create table if not exists ai_teacher_llm_capability_probe_runs (
      probe_run_id text primary key,
      version_id text not null,
      config_checksum text not null,
      deployment_id text not null,
      source_digest text not null,
      status text not null check (status in ('passed', 'failed', 'blocked', 'inconclusive')),
      readiness text not null,
      declared_capabilities_json jsonb not null default '{}'::jsonb,
      base_probe_json jsonb not null default '{}'::jsonb,
      results_json jsonb not null default '{}'::jsonb,
      budget_json jsonb not null default '{}'::jsonb,
      usage_json jsonb not null default '{}'::jsonb,
      evidence_digest text not null,
      error_code text not null default '',
      created_by text,
      started_at timestamptz not null,
      completed_at timestamptz not null,
      duration_ms integer not null default 0,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_teacher_agent_policy_versions (
      version_id text primary key,
      sequence bigint generated by default as identity,
      status text not null default 'draft',
      values_json jsonb not null,
      checksum text not null,
      validation_json jsonb not null default '{}'::jsonb,
      source_version_id text,
      notes text,
      created_by text,
      validated_at timestamptz,
      published_by text,
      created_at timestamptz not null default now(),
      published_at timestamptz
    );
  `);
  await pool.query(`alter table ai_usage_ledger add column if not exists tenant_id text not null default ''`);
  await pool.query(`alter table app_user_profiles add column if not exists last_login_at timestamptz`);
  await pool.query(`alter table app_user_profiles add column if not exists last_activity_at timestamptz`);
  await pool.query(`alter table app_user_profiles add column if not exists active_seconds bigint not null default 0`);
  await pool.query(`
    update app_user_profiles profile
       set last_login_at = audit.last_login_at
      from (
        select user_id, max(created_at) as last_login_at
          from auth_audit_events
         where event_type = 'login_succeeded' and user_id is not null
         group by user_id
      ) audit
     where profile.user_id = audit.user_id
       and (profile.last_login_at is null or profile.last_login_at < audit.last_login_at)
  `);
  await pool.query(`alter table ai_usage_ledger add column if not exists metered_prompt_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists metered_completion_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists metered_reasoning_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists metered_total_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists provider_prompt_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists provider_completion_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists provider_reasoning_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists provider_total_tokens integer not null default 0`);
  await pool.query(`alter table ai_usage_ledger add column if not exists usage_source text not null default 'provider'`);
  await pool.query(`alter table ai_usage_ledger add column if not exists status text not null default 'succeeded'`);
  await pool.query(`alter table ai_usage_ledger add column if not exists budget_reservation_id text`);
  await pool.query(`create index if not exists ai_usage_ledger_user_created_idx on ai_usage_ledger (user_id, created_at desc)`);
  await pool.query(`create unique index if not exists ai_usage_ledger_budget_reservation_idx on ai_usage_ledger (budget_reservation_id) where budget_reservation_id is not null`);
  await pool.query(`create index if not exists ai_teacher_budget_reservations_user_status_idx on ai_teacher_budget_reservations (user_id, status, created_at desc)`);
  await pool.query(`create index if not exists ai_teacher_llm_capability_probe_runs_source_idx on ai_teacher_llm_capability_probe_runs (deployment_id, source_digest, completed_at desc)`);
  await pool.query(`create index if not exists ai_teacher_llm_capability_probe_runs_version_idx on ai_teacher_llm_capability_probe_runs (version_id, completed_at desc)`);
  await pool.query(`create unique index if not exists ai_teacher_budget_reservations_request_idx on ai_teacher_budget_reservations (user_id, request_id, capability) where request_id <> '' and status in ('active', 'settled')`);
  await pool.query(`create index if not exists ai_teacher_quota_events_user_created_idx on ai_teacher_quota_events (user_id, created_at desc)`);
  await pool.query(`create index if not exists ai_teacher_litellm_config_versions_status_idx on ai_teacher_litellm_config_versions (status, created_at desc)`);
  await pool.query(`create index if not exists ai_teacher_agent_policy_versions_status_idx on ai_teacher_agent_policy_versions (status, sequence desc)`);
  await pool.query(`create unique index if not exists ai_teacher_agent_policy_versions_one_active_idx on ai_teacher_agent_policy_versions ((status)) where status = 'active'`);
  await seedEntitlements(pool);
  await seedAiTeacherTierPolicies(pool);
  await syncPersistedAiTeacherTierEntitlements(pool);
  await seedLiteLlmConfigVersions(pool);
  await migratePostgresAgentResourcePolicyVersions(pool);
}

async function seedAiTeacherTierPolicies(pool) {
  const policies = buildAiTeacherTierPolicies();
  for (const [tier, policy] of Object.entries(policies)) {
    await pool.query(
      `insert into ai_teacher_tier_policies (tier_code, enabled, daily_token_limit, weekly_token_limit, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (tier_code) do nothing`,
      [tier, policy.enabled, policy.dailyTokenLimit, policy.weeklyTokenLimit, AI_TEACHER_TIER_POLICY_SEED]
    );
  }
  const freePolicy = policies.free;
  await pool.query(
    `update ai_teacher_tier_policies
        set enabled = $1,
            daily_token_limit = $2,
            weekly_token_limit = $3,
            updated_by = $4,
            updated_at = now()
      where tier_code = 'free'
        and updated_by = 'system-seed'
        and enabled = false
        and daily_token_limit = 0
        and weekly_token_limit = 0`,
    [freePolicy.enabled, freePolicy.dailyTokenLimit, freePolicy.weeklyTokenLimit, AI_TEACHER_TIER_POLICY_SEED]
  );
}

async function syncPersistedAiTeacherTierEntitlements(pool) {
  const result = await pool.query(
    `select tier_code, enabled, daily_token_limit, weekly_token_limit
       from ai_teacher_tier_policies
      where tier_code in ('guest', 'free', 'plus')`
  );
  const policies = buildAiTeacherTierPolicies();
  for (const row of result.rows) {
    policies[row.tier_code] = normalizeAiTeacherPolicy(row);
  }
  await syncAiTeacherTierEntitlements(pool, policies);
}

async function seedLiteLlmConfigVersions(pool) {
  const result = await pool.query(`select count(*)::integer as count from ai_teacher_litellm_config_versions`);
  if (Number(result.rows[0]?.count || 0) > 0) return;
  const row = seedLiteLlmConfigVersionRow();
  await pool.query(
    `insert into ai_teacher_litellm_config_versions
      (version_id, status, config_json, rendered_yaml, checksum, validation_json, created_by, published_by, notes, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      row.versionId,
      row.status,
      JSON.stringify(row.config),
      row.renderedYaml,
      row.checksum,
      JSON.stringify(row.validation),
      row.createdBy,
      row.publishedBy,
      row.notes
    ]
  );
}

async function seedEntitlements(pool) {
  await pool.query(
    `insert into account_tiers (code, name, description)
     values ('guest', '游客', '受限游客账号'), ('free', '普通', '基础学习账号'), ('plus', 'Plus', 'Plus 学习账号')
     on conflict (code) do update set name = excluded.name, description = excluded.description`
  );
  const allCodes = [...new Set([...DEFAULT_ENTITLEMENTS.guest, ...DEFAULT_ENTITLEMENTS.free, ...DEFAULT_ENTITLEMENTS.plus, ...ADMIN_ENTITLEMENTS])];
  for (const code of allCodes) {
    await pool.query(
      `insert into entitlements (code, description)
       values ($1, $2)
       on conflict (code) do update set description = excluded.description`,
      [code, ENTITLEMENT_DESCRIPTIONS[code] || code]
    );
  }
  for (const [tier, codes] of Object.entries(DEFAULT_ENTITLEMENTS)) {
    for (const code of codes) {
      await pool.query(
        `insert into tier_entitlements (tier_code, entitlement_code, scope, scope_ref)
         values ($1, $2, 'global', '*')
         on conflict do nothing`,
        [tier, code]
      );
    }
  }
}

function entitlementRecord(code, scope = 'global', scopeRef = '*', source = 'tier') {
  return { code, scope, scopeRef, source, expiresAt: null };
}

function dedupeEntitlements(entitlements) {
  const seen = new Set();
  const result = [];
  for (const entitlement of entitlements) {
    const key = `${entitlement.code}\u0000${entitlement.scope || 'global'}\u0000${entitlement.scopeRef || '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      code: entitlement.code,
      scope: entitlement.scope || 'global',
      scopeRef: entitlement.scopeRef || '*',
      source: entitlement.source || 'manual',
      expiresAt: entitlement.expiresAt || null
    });
  }
  return result;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeTokenUsage(tokenUsage = {}) {
  const details = tokenUsage.completion_tokens_details || tokenUsage.completionTokensDetails || tokenUsage.output_token_details || tokenUsage.outputTokenDetails || {};
  const promptTokens = positiveInteger(tokenUsage.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.inputTokens ?? tokenUsage.input_tokens ?? 0);
  const completionTokens = positiveInteger(tokenUsage.completionTokens ?? tokenUsage.completion_tokens ?? tokenUsage.outputTokens ?? tokenUsage.output_tokens ?? 0);
  const reasoningTokens = positiveInteger(tokenUsage.reasoningTokens ?? tokenUsage.reasoning_tokens ?? details.reasoning_tokens ?? details.reasoningTokens ?? 0);
  const totalTokens = positiveInteger(tokenUsage.totalTokens ?? tokenUsage.total_tokens ?? tokenUsage.total ?? promptTokens + completionTokens + reasoningTokens);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    usageSource: tokenUsage.usageSource || tokenUsage.usage_source || tokenUsage.source || null
  };
}

function summarizeMemoryAiUsage(userId, nowValue, ledger = [], legacyUsage = new Map(), resetAtValue = null) {
  const now = nowValue ? new Date(nowValue) : new Date();
  const windows = usageWindowStarts(now);
  const resetAt = resetAtValue ? new Date(resetAtValue) : null;
  const dailyStart = resetAt && resetAt > windows.day ? resetAt : windows.day;
  const weeklyStart = resetAt && resetAt > windows.week ? resetAt : windows.week;
  const rows = ledger.filter((row) => row.userId === userId && (row.status || 'succeeded') === 'succeeded');
  if (!rows.length) {
    const legacy = legacyUsage.get(userId) || { messageCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
    return { ...legacy, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 };
  }
  const summary = { messageCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 };
  for (const row of rows) {
    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    summary.messageCount += 1;
    summary.totalTokens += positiveInteger(row.totalTokens);
    summary.promptTokens += positiveInteger(row.promptTokens);
    summary.completionTokens += positiveInteger(row.completionTokens);
    if (createdAt >= dailyStart) summary.dailyTokens += positiveInteger(row.totalTokens);
    if (createdAt >= weeklyStart) summary.weeklyTokens += positiveInteger(row.totalTokens);
    if (createdAt >= windows.month) summary.monthlyTokens += positiveInteger(row.totalTokens);
  }
  return summary;
}

function summarizeMemoryAiBudgetReservations(userId, nowValue, reservations = new Map(), resetAtValue = null) {
  const now = nowValue ? new Date(nowValue) : new Date();
  const windows = usageWindowStarts(now);
  const resetAt = resetAtValue ? new Date(resetAtValue) : null;
  const dailyStart = resetAt && resetAt > windows.day ? resetAt : windows.day;
  const weeklyStart = resetAt && resetAt > windows.week ? resetAt : windows.week;
  let reservedDailyTokens = 0;
  let reservedWeeklyTokens = 0;
  for (const reservation of reservations.values()) {
    if (reservation.userId !== userId || reservation.status !== 'active') continue;
    const expiresAt = reservation.expiresAt instanceof Date ? reservation.expiresAt : new Date(reservation.expiresAt);
    if (expiresAt <= now) continue;
    const createdAt = reservation.createdAt instanceof Date ? reservation.createdAt : new Date(reservation.createdAt);
    if (createdAt >= dailyStart) reservedDailyTokens += positiveInteger(reservation.reservedTokens);
    if (createdAt >= weeklyStart) reservedWeeklyTokens += positiveInteger(reservation.reservedTokens);
  }
  return { reservedDailyTokens, reservedWeeklyTokens };
}

function expireMemoryAiBudgetReservations(reservations, userId, now = new Date()) {
  for (const reservation of reservations.values()) {
    if (reservation.userId !== userId || reservation.status !== 'active') continue;
    const expiresAt = reservation.expiresAt instanceof Date ? reservation.expiresAt : new Date(reservation.expiresAt);
    if (expiresAt > now) continue;
    reservation.status = 'expired';
    reservation.releasedAt = now;
    reservation.releaseReason = 'lease_expired';
  }
}

function findMemoryAiBudgetReservation(reservations, userId, requestId, capability) {
  for (const reservation of reservations.values()) {
    if (reservation.userId === userId
      && reservation.requestId === requestId
      && reservation.capability === capability
      && ['active', 'settled'].includes(reservation.status)) return reservation;
  }
  return null;
}

async function withMemoryAiBudgetLock(locks, userId, operation) {
  const previous = locks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(userId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(userId) === tail) locks.delete(userId);
  }
}

function normalizeBudgetReservationTtlMs(value) {
  const configured = Number(value || 10 * 60 * 1000);
  if (!Number.isFinite(configured) || configured <= 0) return 10 * 60 * 1000;
  return Math.max(60 * 1000, Math.floor(configured));
}

function budgetDeniedDecision(reason, estimatedTokens, policy, usage = null, status = 429, code = 'AI_TEACHER_QUOTA_EXCEEDED') {
  return {
    allowed: false,
    status,
    code,
    reason,
    message: reason === 'duplicate_request' ? '该 AI Teacher 请求已提交，请勿重复运行。' : quotaExceededMessage(reason),
    estimatedTokens,
    usage,
    policy
  };
}

function budgetReservationStateError() {
  const error = new Error('AI Teacher budget reservation is not active.');
  error.status = 409;
  error.code = 'AI_TEACHER_BUDGET_RESERVATION_INVALID';
  return error;
}

function usageWindowStarts(now = new Date()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  const dayOfWeek = week.getDay() || 7;
  week.setDate(week.getDate() - dayOfWeek + 1);
  const month = new Date(day);
  month.setDate(1);
  return { day, week, month };
}

function buildAiTeacherTierPolicies(overrides = {}) {
  const base = {
    guest: { enabled: false, dailyTokenLimit: 0, weeklyTokenLimit: 0 },
    free: {
      enabled: true,
      dailyTokenLimit: envInteger('AI_TEACHER_FREE_DAILY_TOKEN_LIMIT', 20000),
      weeklyTokenLimit: envInteger('AI_TEACHER_FREE_WEEKLY_TOKEN_LIMIT', 80000)
    },
    plus: {
      enabled: true,
      dailyTokenLimit: envInteger('AI_TEACHER_PLUS_DAILY_TOKEN_LIMIT', 100000),
      weeklyTokenLimit: envInteger('AI_TEACHER_PLUS_WEEKLY_TOKEN_LIMIT', 500000)
    }
  };
  for (const [tier, policy] of Object.entries(overrides || {})) {
    base[tier] = normalizeAiTeacherPolicy({ ...(base[tier] || {}), ...(policy || {}) });
  }
  return Object.fromEntries(Object.entries(base).map(([tier, policy]) => [tier, normalizeAiTeacherPolicy(policy)]));
}

const AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_ACTOR = 'system-policy-schema-migration';

function migrateMemoryAgentResourcePolicyVersions(rows = [], options = {}) {
  const migratedRows = (Array.isArray(rows) ? rows : []).map(cloneAgentResourcePolicyVersion);
  const activeRows = migratedRows
    .filter((row) => row.status === 'active')
    .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0));
  if (activeRows.length > 1) throwAgentResourcePolicyMigrationInvalid('multiple_active_versions');
  if (!activeRows.length) {
    migratedRows.push(seedAgentResourcePolicyVersionRow({
      now: options.now,
      sequence: nextMemoryPolicySequence(migratedRows)
    }));
    return migratedRows;
  }

  const source = activeRows[0];
  const migration = createAgentResourcePolicySchemaMigrationRow(source, options);
  if (!migration) return migratedRows;
  source.status = 'retired';
  migration.sequence = nextMemoryPolicySequence(migratedRows);
  migratedRows.push(migration);
  return migratedRows;
}

async function migratePostgresAgentResourcePolicyVersions(pool, options = {}) {
  const now = options.now || new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('ai_teacher_agent_resource_policy_active'))`);
    const activeResult = await client.query(
      `select version_id, sequence, status, values_json, checksum, validation_json, source_version_id, notes,
              created_by, validated_at, published_by, created_at, published_at
         from ai_teacher_agent_policy_versions
        where status = 'active'
        order by published_at desc nulls last, sequence desc
        limit 1
        for update`
    );

    if (!activeResult.rows.length) {
      await insertActiveAgentResourcePolicyVersion(client, seedAgentResourcePolicyVersionRow({ now }), now);
      await client.query('commit');
      return { action: 'seeded', versionId: `arp_bootstrap_v${AGENT_RESOURCE_POLICY_SCHEMA_VERSION}` };
    }

    const source = publicAgentResourcePolicyVersion(activeResult.rows[0]);
    const migration = createAgentResourcePolicySchemaMigrationRow(source, { now });
    if (!migration) {
      await client.query('commit');
      return { action: 'unchanged', versionId: source.versionId };
    }

    const retired = await client.query(
      `update ai_teacher_agent_policy_versions
          set status = 'retired'
        where version_id = $1
          and status = 'active'`,
      [source.versionId]
    );
    if (retired.rowCount !== 1) throwAgentResourcePolicyMigrationInvalid('active_version_changed');
    await insertActiveAgentResourcePolicyVersion(client, migration, now);
    await client.query('commit');
    return { action: 'migrated', versionId: migration.versionId, sourceVersionId: source.versionId };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createAgentResourcePolicySchemaMigrationRow(sourceRow, options = {}) {
  const source = cloneAgentResourcePolicyVersion(sourceRow);
  const currentValidation = validateAgentResourcePolicyValues(source.values);
  if (currentValidation.ok) return null;
  let migrationResult;
  try {
    migrationResult = migrateAgentResourcePolicyValues(source.values);
  } catch (error) {
    if (error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID') {
      throwAgentResourcePolicyMigrationInvalid('invalid_deprecated_source_values');
    }
    throw error;
  }
  if (migrationResult.unknownKeys.length) {
    throwAgentResourcePolicyMigrationInvalid('unsupported_source_values');
  }
  const validation = validateAgentResourcePolicyValues(migrationResult.values);
  if (!validation.ok) throwAgentResourcePolicyMigrationInvalid('migrated_values_invalid');
  const checksum = checksumAgentResourcePolicyValues(validation.values);
  const migrationId = crypto.createHash('sha256')
    .update(`${source.versionId}\n${checksum}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  const now = options.now || new Date().toISOString();
  return {
    versionId: `arp_schema_v${AGENT_RESOURCE_POLICY_SCHEMA_VERSION}_${migrationId}`,
    sequence: 0,
    status: 'active',
    values: validation.values,
    checksum,
    validation,
    sourceVersionId: source.versionId,
    notes: `Non-destructive Agent resource policy Schema migration from ${source.versionId}; deprecated fields were mapped explicitly.`,
    createdBy: AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_ACTOR,
    validatedAt: now,
    publishedBy: AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_ACTOR,
    createdAt: now,
    publishedAt: now
  };
}

async function insertActiveAgentResourcePolicyVersion(client, row, now) {
  await client.query(
    `insert into ai_teacher_agent_policy_versions
      (version_id, status, values_json, checksum, validation_json, source_version_id, notes,
       created_by, validated_at, published_by, created_at, published_at)
     values ($1, 'active', $2, $3, $4, $5, $6, $7, $8, $7, $8, $8)`,
    [
      row.versionId,
      JSON.stringify(row.values),
      row.checksum,
      JSON.stringify(row.validation),
      row.sourceVersionId || null,
      row.notes,
      row.createdBy,
      now
    ]
  );
}

function cloneAgentResourcePolicyVersion(row = {}) {
  const version = publicAgentResourcePolicyVersion(row);
  return {
    ...version,
    values: cloneJsonValue(version.values),
    validation: cloneJsonValue(version.validation)
  };
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function throwAgentResourcePolicyMigrationInvalid(reason) {
  const error = new Error('Agent resource policy Schema migration cannot proceed safely.');
  error.code = 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID';
  error.reason = reason;
  throw error;
}

async function syncAiTeacherTierEntitlements(pool, policies = {}) {
  for (const tier of ['guest', 'free', 'plus']) {
    const policy = policies[tier] || {};
    if (policy.enabled) {
      await pool.query(
        `insert into tier_entitlements (tier_code, entitlement_code, scope, scope_ref)
         values ($1, 'ai.teacher.use', 'global', '*')
         on conflict do nothing`,
        [tier]
      );
    } else {
      await pool.query(
        `delete from tier_entitlements
          where tier_code = $1
            and entitlement_code = 'ai.teacher.use'
            and scope = 'global'
            and scope_ref = '*'`,
        [tier]
      );
    }
  }
  await pool.query(
    `insert into user_entitlements (user_id, entitlement_code, scope, scope_ref, source)
     select existing_admin.user_id, new_entitlement.code, 'global', '*', 'system-admin-migration'
       from user_entitlements existing_admin
       cross join (values ('syson.model.write'), ('syson.proxy.write')) as new_entitlement(code)
      where existing_admin.entitlement_code = 'admin.console.access'
     on conflict do nothing`
  );
}

function tierEntitlementCodes(tier = 'free', policies = buildAiTeacherTierPolicies()) {
  const normalizedTier = String(tier || 'free');
  const codes = new Set(DEFAULT_ENTITLEMENTS[normalizedTier] || DEFAULT_ENTITLEMENTS.free);
  const policy = policies[normalizedTier] || null;
  if (policy?.enabled) codes.add('ai.teacher.use');
  else codes.delete('ai.teacher.use');
  return [...codes];
}

function cloneAiTeacherTierPolicies(policies = {}) {
  return mergeAiTeacherTierPolicies({}, policies);
}

function mergeAiTeacherTierPolicies(current = {}, updates = {}) {
  const defaults = buildAiTeacherTierPolicies();
  const base = {
    guest: normalizeAiTeacherPolicy(current.guest || defaults.guest),
    free: normalizeAiTeacherPolicy(current.free || defaults.free),
    plus: normalizeAiTeacherPolicy(current.plus || defaults.plus)
  };
  for (const tier of ['guest', 'free', 'plus']) {
    if (!Object.prototype.hasOwnProperty.call(updates || {}, tier)) continue;
    base[tier] = normalizeAiTeacherPolicy({ ...base[tier], ...(updates[tier] || {}) });
  }
  return base;
}

function normalizeAiTeacherPolicy(policy = {}) {
  return {
    enabled: policy.enabled !== false,
    dailyTokenLimit: positiveInteger(policy.dailyTokenLimit ?? policy.daily_token_limit ?? policy.dailyTokens ?? 0),
    weeklyTokenLimit: positiveInteger(policy.weeklyTokenLimit ?? policy.weekly_token_limit ?? policy.weeklyTokens ?? 0)
  };
}

function defaultAuthSettings() {
  return {
    registrationEnabled: envFlag(process.env.AUTH_REGISTRATION_ENABLED, true),
    guestLoginEnabled: envFlag(process.env.AUTH_GUEST_LOGIN_ENABLED, true)
  };
}

function normalizeAuthSettings(settings = {}) {
  return {
    registrationEnabled: settings.registrationEnabled !== undefined
      ? Boolean(settings.registrationEnabled)
      : envFlag(settings.registration_enabled, true),
    guestLoginEnabled: settings.guestLoginEnabled !== undefined
      ? Boolean(settings.guestLoginEnabled)
      : envFlag(settings.guest_login_enabled, true)
  };
}


function authSettingsRow(row = {}) {
  return {
    registrationEnabled: row.registration_enabled !== false,
    guestLoginEnabled: row.guest_login_enabled !== false,
    updatedBy: row.updated_by || '',
    updatedAt: row.updated_at || null
  };
}

function externalModelingToolSettingsRow(row = {}) {
  return normalizeExternalModelingToolSettings(row, defaultExternalModelingToolSettings());
}

function externalModelingToolAuditView(settings = {}) {
  const normalized = normalizeExternalModelingToolSettings(settings);
  return {
    enabled: normalized.enabled,
    frontendVisible: normalized.frontendVisible,
    modelGenerationEnabled: normalized.modelGenerationEnabled,
    directWriteEnabled: normalized.directWriteEnabled
  };
}

function throwExternalModelingToolNotFound(toolId) {
  const error = new Error(`External modeling tool is not supported: ${String(toolId || '')}`);
  error.statusCode = 404;
  error.code = 'EXTERNAL_MODELING_TOOL_NOT_FOUND';
  throw error;
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !/^(0|false|no|off|disabled)$/i.test(String(value).trim());
}

function envInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function withAiTeacherQuotaSummary(userId, usage, user, policies) {
  const policy = resolveAiTeacherPolicy(user || {}, policies);
  const window = aiTeacherUsageWindow();
  return {
    userId,
    messageCount: positiveInteger(usage.messageCount),
    totalTokens: positiveInteger(usage.totalTokens),
    promptTokens: positiveInteger(usage.promptTokens),
    completionTokens: positiveInteger(usage.completionTokens),
    dailyTokens: positiveInteger(usage.dailyTokens),
    weeklyTokens: positiveInteger(usage.weeklyTokens),
    monthlyTokens: positiveInteger(usage.monthlyTokens),
    reservedDailyTokens: positiveInteger(usage.reservedDailyTokens),
    reservedWeeklyTokens: positiveInteger(usage.reservedWeeklyTokens),
    tokenQuota: {
      enabled: Boolean(policy.enabled),
      dailyTokenLimit: policy.dailyTokenLimit,
      weeklyTokenLimit: policy.weeklyTokenLimit,
      weekStartAt: window.weekStartAt,
      weekEndAt: window.weekEndAt,
      nextWeeklyResetAt: window.nextWeeklyResetAt,
      dailyRemainingTokens: remainingTokens(policy.dailyTokenLimit, positiveInteger(usage.dailyTokens) + positiveInteger(usage.reservedDailyTokens)),
      weeklyRemainingTokens: remainingTokens(policy.weeklyTokenLimit, positiveInteger(usage.weeklyTokens) + positiveInteger(usage.reservedWeeklyTokens))
    }
  };
}

function remainingTokens(limit, used) {
  const normalizedLimit = positiveInteger(limit);
  if (!normalizedLimit) return null;
  return Math.max(0, normalizedLimit - positiveInteger(used));
}

function resolveAiTeacherPolicy(user = {}, policies = buildAiTeacherTierPolicies()) {
  if (isAdminUser(user)) return { enabled: true, dailyTokenLimit: 0, weeklyTokenLimit: 0 };
  return policies[user.tier || 'free'] || policies.free;
}

function quotaExceededReason(usage, policy, estimatedTokens) {
  const dailyCommitted = positiveInteger(usage.dailyTokens) + positiveInteger(usage.reservedDailyTokens);
  const weeklyCommitted = positiveInteger(usage.weeklyTokens) + positiveInteger(usage.reservedWeeklyTokens);
  if (policy.dailyTokenLimit && dailyCommitted + estimatedTokens > policy.dailyTokenLimit) return 'daily_quota_exceeded';
  if (policy.weeklyTokenLimit && weeklyCommitted + estimatedTokens > policy.weeklyTokenLimit) return 'weekly_quota_exceeded';
  return '';
}

function quotaExceededMessage(reason) {
  if (reason === 'daily_quota_exceeded') return '今日 AI Teacher tokens 已用完，明日重置后可继续使用。';
  if (reason === 'weekly_quota_exceeded') return '本周 AI Teacher tokens 已用完，下周重置后可继续使用。';
  return 'AI Teacher tokens 已用完，请等待额度重置后继续使用。';
}

function publicAiTeacherPolicy(policy = {}) {
  return {
    enabled: Boolean(policy.enabled),
    dailyTokenLimit: positiveInteger(policy.dailyTokenLimit),
    weeklyTokenLimit: positiveInteger(policy.weeklyTokenLimit)
  };
}

function aiTeacherUsageWindow(now = new Date()) {
  const starts = usageWindowStarts(now);
  const weekEnd = new Date(starts.week);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return {
    dayStartAt: starts.day.toISOString(),
    weekStartAt: starts.week.toISOString(),
    weekEndAt: weekEnd.toISOString(),
    nextWeeklyResetAt: weekEnd.toISOString()
  };
}

function publicAdminUser(user = {}) {
  return {
    id: user.id || user.userId || '',
    email: user.email || '',
    displayName: user.displayName || user.username || user.email || user.id || '',
    tier: user.tier || 'free',
    status: user.status || 'active',
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    lastActivityAt: user.lastActivityAt || null,
    activeDurationSeconds: Number(user.activeDurationSeconds || 0)
  };
}

function publicAdminAiUsage(usage = {}) {
  const quota = usage.tokenQuota || {};
  return {
    messageCount: positiveInteger(usage.messageCount),
    totalTokens: positiveInteger(usage.totalTokens),
    promptTokens: positiveInteger(usage.promptTokens),
    completionTokens: positiveInteger(usage.completionTokens),
    dailyTokens: positiveInteger(usage.dailyTokens),
    weeklyTokens: positiveInteger(usage.weeklyTokens),
    tokenQuota: {
      enabled: Boolean(quota.enabled),
      dailyTokenLimit: positiveInteger(quota.dailyTokenLimit),
      weeklyTokenLimit: positiveInteger(quota.weeklyTokenLimit),
      dailyRemainingTokens: quota.dailyRemainingTokens === null ? null : positiveInteger(quota.dailyRemainingTokens),
      weeklyRemainingTokens: quota.weeklyRemainingTokens === null ? null : positiveInteger(quota.weeklyRemainingTokens),
      weekStartAt: quota.weekStartAt || '',
      weekEndAt: quota.weekEndAt || '',
      nextWeeklyResetAt: quota.nextWeeklyResetAt || ''
    }
  };
}

function conversationMemoryRow(thread, memory = {}) {
  const messages = memoryMessagesForThread(thread.id, memory.memoryAiMessages || []);
  const ledger = (memory.memoryAiUsageLedger || []).filter((row) => row.threadId === thread.id);
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const user = memory.profiles?.get(thread.userId) || {};
  return {
    threadId: thread.id,
    user: {
      id: thread.userId,
      displayName: user.displayName || user.email || thread.userId,
      email: user.email || '',
      tier: user.tier || 'free'
    },
    lessonId: thread.lessonId || '',
    title: thread.title || 'AI 教师对话',
    lastUserMessage: lastUser?.content || '',
    messageCount: messages.length,
    totalTokens: ledger.reduce((sum, row) => sum + positiveInteger(row.totalTokens), 0),
    promptTokens: ledger.reduce((sum, row) => sum + positiveInteger(row.promptTokens), 0),
    completionTokens: ledger.reduce((sum, row) => sum + positiveInteger(row.completionTokens), 0),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt
  };
}

function memoryMessagesForThread(threadId, messages = []) {
  return messages.filter((message) => message.threadId === threadId);
}

function conversationMatches(row, search) {
  return [
    row.threadId,
    row.user?.id,
    row.user?.email,
    row.user?.displayName,
    row.lessonId,
    row.title,
    row.lastUserMessage
  ].join(' ').toLowerCase().includes(search);
}

function publicAdminAiMessage(message = {}) {
  const content = String(message.content || '');
  return {
    id: message.id || '',
    threadId: message.threadId || '',
    role: message.role || '',
    contentPreview: content.slice(0, 600),
    contentLength: content.length,
    model: message.model || '',
    tokenUsage: normalizeTokenUsage(message.tokenUsage || {}),
    createdAt: message.createdAt || null
  };
}

function isAdminUser(user = {}) {
  if (Array.isArray(user.permissions) && user.permissions.includes('admin.console.access')) return true;
  if (Array.isArray(user.roles) && user.roles.includes('admin')) return true;
  return Array.isArray(user.entitlements) && user.entitlements.some((entitlement) => entitlement?.code === 'admin.console.access');
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeAiTeacherThreadId(value) {
  const threadId = String(value || '').trim();
  if (!threadId) return '';
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(threadId)) {
    const error = new Error('Invalid AI Teacher thread id.');
    error.status = 400;
    error.code = 'AI_TEACHER_THREAD_ID_INVALID';
    throw error;
  }
  return threadId;
}

function assertAiTeacherThreadOwner(thread, userId) {
  if (!thread || String(thread.userId || '') === String(userId || '')) return;
  const error = new Error('AI Teacher thread belongs to another user.');
  error.status = 403;
  error.code = 'AI_TEACHER_THREAD_OWNER_MISMATCH';
  throw error;
}

function aiTeacherRuntimeAssignmentFromRow(row = {}) {
  return {
    threadId: row.id || row.thread_id || '',
    runtimeAssignmentId: row.runtimeAssignmentId || row.runtime_assignment_id || '',
    runtime: 'ai-sdk',
    policyVersion: row.policyVersion || row.policy_version || 'single-entry-v1',
    bucket: Number(row.bucket || 0),
    assignedAt: row.assignedAt || row.assigned_at || '',
    overrideReason: row.overrideReason || row.override_reason || ''
  };
}

function filterSortAndPageUsers(rows, options = {}) {
  const search = String(options.search || '').trim().toLowerCase();
  const rawLimit = Number(options.limit || 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 50;
  const rawOffset = Number(options.offset || 0);
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.floor(rawOffset), 0), 1_000_000) : 0;
  const sortKey = Object.hasOwn(ADMIN_USER_SORT_COLUMNS, options.sortBy) ? options.sortBy : 'updatedAt';
  const direction = options.sortDirection === 'ascending' ? 1 : -1;
  const filtered = rows.filter((row) => !search || `${row.email} ${row.displayName} ${row.id}`.toLowerCase().includes(search));
  const sorted = filtered
    .map((row, index) => ({ row, index, value: adminUserMemorySortValue(row, sortKey) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      const comparison = typeof left.value === 'number' && typeof right.value === 'number'
        ? left.value - right.value
        : String(left.value).localeCompare(String(right.value), 'zh-CN', { numeric: true, sensitivity: 'base' });
      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({ row }) => row);
  return { users: sorted.slice(offset, offset + limit), total: sorted.length };
}

function adminUserSqlSort(options = {}) {
  const sortBy = Object.hasOwn(ADMIN_USER_SORT_COLUMNS, options.sortBy) ? options.sortBy : '';
  return {
    orderBy: sortBy ? ADMIN_USER_SORT_COLUMNS[sortBy] : 'p.updated_at',
    orderDirection: sortBy && options.sortDirection === 'ascending' ? 'asc' : 'desc'
  };
}

function adminUserMemorySortValue(user, key) {
  if (key === 'user') return user.displayName || user.email || user.id;
  if (key === 'createdAt' || key === 'lastLoginAt' || key === 'updatedAt') {
    const timestamp = Date.parse(user[key] || '');
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (key === 'activeDurationSeconds') {
    const seconds = Number(user.activeDurationSeconds);
    return Number.isFinite(seconds) ? seconds : null;
  }
  return String(user[key] || '');
}

function userRow(row) {
  return {
    id: row.user_id,
    email: row.email || '',
    displayName: row.display_name || row.email || row.user_id,
    status: row.status || 'active',
    tier: row.default_tier || 'free',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lastLoginAt: row.last_login_at || null,
    lastActivityAt: row.last_activity_at || null,
    activeDurationSeconds: Number(row.active_seconds || 0)
  };
}

function throwUserNotFound() {
  const error = new Error('用户不存在。');
  error.statusCode = 404;
  error.code = 'USER_NOT_FOUND';
  throw error;
}

function throwNotFoundLiteLlmConfigVersion() {
  const error = new Error('LiteLLM config version not found.');
  error.statusCode = 404;
  error.code = 'LITELLM_CONFIG_VERSION_NOT_FOUND';
  throw error;
}

function throwNotFoundAgentResourcePolicyVersion() {
  const error = new Error('Agent resource policy version not found.');
  error.statusCode = 404;
  error.code = 'AGENT_RESOURCE_POLICY_VERSION_NOT_FOUND';
  throw error;
}

function throwAgentResourcePolicyInvalid(validation) {
  const error = new Error('Agent resource policy validation failed.');
  error.statusCode = 400;
  error.code = 'AGENT_RESOURCE_POLICY_INVALID';
  error.details = validation;
  throw error;
}

function normalizeAgentResourcePolicyVersionId(value) {
  const id = String(value || '').trim();
  if (!/^arp_[a-zA-Z0-9_-]{3,120}$/.test(id)) {
    const error = new Error('Agent resource policy version id is invalid.');
    error.statusCode = 400;
    error.code = 'AGENT_RESOURCE_POLICY_VERSION_ID_INVALID';
    throw error;
  }
  return id;
}

function normalizeAgentResourcePolicyDraftValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return JSON.parse(JSON.stringify(values));
}

function nextMemoryPolicySequence(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.sequence || 0)), 0) + 1;
}

function publicAgentResourcePolicyVersion(row = {}) {
  const values = row.values || row.values_json || {};
  const validation = row.validation || row.validation_json || { ok: false, errors: [], warnings: [] };
  return {
    versionId: row.versionId || row.version_id || '',
    sequence: Number(row.sequence || 0),
    status: row.status || 'draft',
    values: typeof values === 'string' ? JSON.parse(values) : values,
    checksum: row.checksum || '',
    validation: typeof validation === 'string' ? JSON.parse(validation) : validation,
    sourceVersionId: row.sourceVersionId || row.source_version_id || '',
    notes: row.notes || '',
    createdBy: row.createdBy || row.created_by || '',
    validatedAt: row.validatedAt || row.validated_at || null,
    publishedBy: row.publishedBy || row.published_by || '',
    createdAt: row.createdAt || row.created_at || null,
    publishedAt: row.publishedAt || row.published_at || null
  };
}

function seedAgentResourcePolicyVersionRow(options = {}) {
  const values = { ...AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES };
  const validation = validateAgentResourcePolicyValues(values);
  const now = options.now || new Date(0).toISOString();
  return {
    versionId: `arp_bootstrap_v${AGENT_RESOURCE_POLICY_SCHEMA_VERSION}`,
    sequence: Number(options.sequence || 1),
    status: 'active',
    values,
    checksum: checksumAgentResourcePolicyValues(values),
    validation,
    sourceVersionId: '',
    notes: 'Bootstrap Agent resource policy seeded from the shared Policy Catalog.',
    createdBy: 'system-seed',
    validatedAt: now,
    publishedBy: 'system-seed',
    createdAt: now,
    publishedAt: now
  };
}

function seedLiteLlmConfigVersionRow() {
  const config = defaultLiteLlmConfig();
  const renderedYaml = renderLiteLlmConfigYaml(config);
  return {
    versionId: DEFAULT_LITELLM_CONFIG_VERSION_ID,
    status: 'active',
    config,
    renderedYaml,
    checksum: checksumText(renderedYaml),
    validation: validateLiteLlmConfig(config),
    createdBy: 'system-seed',
    publishedBy: 'system-seed',
    notes: 'Default LiteLLM config seeded from platform schema.',
    createdAt: new Date(0).toISOString(),
    publishedAt: new Date(0).toISOString()
  };
}

function normalizeLiteLlmCapabilityProbeRun(row = {}) {
  const status = ['passed', 'failed', 'blocked', 'inconclusive'].includes(row.status) ? row.status : 'inconclusive';
  const now = new Date().toISOString();
  return {
    probeRunId: String(row.probeRunId || ''),
    versionId: String(row.versionId || ''),
    configChecksum: String(row.configChecksum || ''),
    deploymentId: String(row.deploymentId || ''),
    sourceDigest: String(row.sourceDigest || ''),
    status,
    readiness: String(row.readiness || (status === 'passed' ? 'ready' : status)),
    declaredCapabilities: cloneJsonValue(row.declaredCapabilities || {}),
    baseProbe: cloneJsonValue(row.baseProbe || {}),
    results: cloneJsonValue(row.results || {}),
    budget: cloneJsonValue(row.budget || {}),
    usage: cloneJsonValue(row.usage || {}),
    evidenceDigest: String(row.evidenceDigest || ''),
    errorCode: String(row.errorCode || ''),
    createdBy: String(row.createdBy || ''),
    startedAt: row.startedAt || now,
    completedAt: row.completedAt || now,
    durationMs: Math.max(0, Math.floor(Number(row.durationMs || 0)))
  };
}

function publicLiteLlmCapabilityProbeRun(row = {}) {
  const jsonValue = (camelName, databaseName) => {
    const value = row[camelName] ?? row[databaseName] ?? {};
    return cloneJsonValue(typeof value === 'string' ? JSON.parse(value) : value);
  };
  return {
    probeRunId: row.probeRunId || row.probe_run_id || '',
    versionId: row.versionId || row.version_id || '',
    configChecksum: row.configChecksum || row.config_checksum || '',
    deploymentId: row.deploymentId || row.deployment_id || '',
    sourceDigest: row.sourceDigest || row.source_digest || '',
    status: row.status || 'inconclusive',
    readiness: row.readiness || 'capability_unverified',
    declaredCapabilities: jsonValue('declaredCapabilities', 'declared_capabilities_json'),
    baseProbe: jsonValue('baseProbe', 'base_probe_json'),
    results: jsonValue('results', 'results_json'),
    budget: jsonValue('budget', 'budget_json'),
    usage: jsonValue('usage', 'usage_json'),
    evidenceDigest: row.evidenceDigest || row.evidence_digest || '',
    errorCode: row.errorCode || row.error_code || '',
    createdBy: row.createdBy || row.created_by || '',
    startedAt: row.startedAt || row.started_at || null,
    completedAt: row.completedAt || row.completed_at || null,
    durationMs: Number(row.durationMs || row.duration_ms || 0)
  };
}

const agentResourcePolicyStoreTesting = Object.freeze({
  migrateMemoryAgentResourcePolicyVersions,
  migratePostgresAgentResourcePolicyVersions
});

module.exports = {
  createAccountStore,
  DEFAULT_ENTITLEMENTS,
  ADMIN_ENTITLEMENTS,
  agentResourcePolicyStoreTesting
};
