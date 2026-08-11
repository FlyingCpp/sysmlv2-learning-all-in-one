'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createCourseStore } = require('./course-store');
const { createCoursePackRegistry } = require('./course-pack-registry');
const { createKnowledgePackRegistry } = require('./knowledge-pack-registry');
const { createPlatformGlossaryStore } = require('./platform-glossary-store');
const { createAppRegistry } = require('./app-registry');
const { createDataStore } = require('./data-store');
const { createAuthService } = require('./auth-service');
const { evaluateRules } = require('./rules');
const { enhanceOfficialDiagnostics } = require('./diagnostic-hints');
const { validateTeacherCapabilityResponse, diagnosticIdFor, hashContent } = require('../../packages/teacher-contract');
const { validateLiteLlmConfig } = require('./litellm-config');
const { createProviderStatusAggregator, createProviderStatusMonitor } = require('./provider-status');
const { resolveWorkspaceImportClosure } = require('./workspace-import-resolver');
const {
  SYSON_TOOL_ID,
  externalModelingToolAdminView,
  publicExternalModelingTools,
  externalModelingToolAccessAllowed,
  validateExternalModelingToolPatch
} = require('./external-modeling-tools');
const {
  SCHEMA_VERSION: AGENT_RESOURCE_POLICY_SCHEMA_VERSION,
  DEFINITIONS: AGENT_RESOURCE_POLICY_DEFINITIONS,
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  catalog: agentResourcePolicyCatalog,
  createPolicySnapshot: createAgentResourcePolicySnapshot,
  validatePolicySnapshot: validateAgentResourcePolicySnapshot,
  runtimeProjection: agentResourcePolicyRuntimeProjection,
  diffPolicyValues: diffAgentResourcePolicyValues
} = require('../../packages/agent-resource-policy');
const { modelRegistryFromLiteLlmVersion } = require('./ai-teacher-model-registry');
const { assignServerControlPlaneIds, publicAdapterProfileCatalog, probeProviderConnection } = require('./llm-control-plane');
const {
  CAPABILITY_PROBE_KEYS,
  assertCapabilityProbeConfirmation,
  deploymentProbeDescriptor,
  publicCapabilityProbeLimits,
  runDeploymentCapabilityProbe
} = require('./llm-capability-probe');
const {
  listManagedCredentials,
  writeManagedCredential,
  deleteManagedCredential
} = require('./litellm-managed-credentials');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const VALIDATOR_URL = process.env.VALIDATOR_URL || 'http://localhost:9090';
const TEACHER_URL = process.env.TEACHER_URL || 'http://localhost:7070';
const DEFAULT_TEACHER_TIMEOUT_MS = Number(AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES['api.outerTimeoutMs']);
const TEACHER_INTERNAL_TOKEN = process.env.AI_TEACHER_INTERNAL_TOKEN || '';
const TEACHER_TOOL_TOKEN = process.env.AI_TEACHER_TOOL_TOKEN || '';
const STREAM_RESPONSE_HANDLED = Symbol('stream-response-handled');
const EXECUTION_COMPLETION_CONTINUATION = 'execution_completion';
const ENGINEERING_IMPROVEMENT_CONTINUATION = 'engineering_improvement';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 20;
const DEFAULT_VALIDATION_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_VALIDATION_RATE_LIMIT_MAX = 6;
const DEFAULT_MODEL_OUTLINE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_MODEL_OUTLINE_RATE_LIMIT_MAX = 24;
const DEFAULT_SYSON_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_SYSON_READ_RATE_LIMIT_MAX = 240;
const DEFAULT_SYSON_COMPUTE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_SYSON_COMPUTE_RATE_LIMIT_MAX = 12;
const DEFAULT_SYSON_WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_SYSON_WRITE_RATE_LIMIT_MAX = 30;
const AI_TEACHER_TOOL_SCHEMA_VERSION = 'single-entry-v3';
const AI_TEACHER_VALIDATOR_TOOL_SCHEMA_VERSION = 'phase9-v4';
const AI_TEACHER_VALIDATOR_DIAGNOSTIC_LIMIT = 200;
const AI_TEACHER_STRUCTURE_NODE_LIMIT = 200;
const AI_TEACHER_STRUCTURE_DIAGNOSTIC_LIMIT = 100;
const AGENT_RESOURCE_POLICY_BOOTSTRAP_SNAPSHOT = createAgentResourcePolicySnapshot({
  versionId: `arp_bootstrap_v${AGENT_RESOURCE_POLICY_SCHEMA_VERSION}`,
  values: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  frozenAt: new Date(0).toISOString()
});
const AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION = agentResourcePolicyRuntimeProjection(AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES);
const AI_TEACHER_AGENT_TOOL_TIMEOUT_MS = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.teacher.agentToolTimeoutMs;
const AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MARGIN_MS = 2000;
const AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MS = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.validator.toolTimeoutMs;
const AI_TEACHER_VALIDATOR_QUEUE_WAIT_MS = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.validator.queueWaitMs;
const AI_TEACHER_VALIDATOR_EXECUTION_TIMEOUT_MS = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.validator.executionTimeoutMs;
const AI_TEACHER_VALIDATOR_MAX_IN_FLIGHT = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.validator.maxInFlight;

assertValidatorToolTimeoutContract();

function normalizeTeacherTimeout(value, fallback = DEFAULT_TEACHER_TIMEOUT_MS) {
  const configured = Number(value || fallback);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TEACHER_TIMEOUT_MS;
  return Math.floor(configured);
}

function teacherTimeoutMsForCall(options = {}) {
  if (options.timeoutMs !== undefined) return normalizeTeacherTimeout(options.timeoutMs);
  const snapshot = options.body?.runtimeAssignment?.resourcePolicySnapshot;
  if (!snapshot) return DEFAULT_TEACHER_TIMEOUT_MS;
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) {
    const error = new Error('Trusted Agent resource policy snapshot is invalid.');
    error.statusCode = 400;
    error.code = 'AGENT_RESOURCE_POLICY_SNAPSHOT_INVALID';
    error.details = validation;
    throw error;
  }
  if (options.body?.automaticContinuationKind === ENGINEERING_IMPROVEMENT_CONTINUATION) {
    return Number(validation.values['engineeringImprovement.apiOuterTimeoutMs']);
  }
  return agentResourcePolicyRuntimeProjection(validation.values).api.outerTimeoutMs;
}

function envFlag(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return !/^(0|false|no|off|disabled)$/i.test(String(value).trim());
}

function optionFlag(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  return Boolean(value);
}

function createServer(options = {}) {
  assertTeacherToolConfiguration();
  const courseRegistry = options.courseRegistry || createCoursePackRegistry(options);
  const knowledgeRegistry = options.knowledgeRegistry || createKnowledgePackRegistry(options);
  const fixedCourseStore = options.courseStore || null;
  const dataStore = options.dataStore || createDataStore(options.dataDir);
  const features = {
    aiTeacherEnabled: optionFlag(options.aiTeacherEnabled, envFlag(process.env.AI_TEACHER_ENABLED, true))
  };
  const authService = options.authService || createAuthService({ ...options, ...features });
  const providerStatusMonitor = options.providerStatusMonitor || createProviderStatusMonitor({
    aggregator: options.providerStatusAggregator || createProviderStatusAggregator()
  });
  const capabilityProbeRunner = options.capabilityProbeRunner || runDeploymentCapabilityProbe;
  const apiRateLimitEnabled = optionFlag(options.apiRateLimitEnabled, envFlag(process.env.API_RATE_LIMIT_ENABLED, process.env.NODE_ENV !== 'test'));
  const rateLimiters = createApiRateLimiters({
    enabled: apiRateLimitEnabled,
    authWindowMs: options.authRateLimitWindowMs || process.env.API_AUTH_RATE_LIMIT_WINDOW_MS,
    authMax: options.authRateLimitMax || process.env.API_AUTH_RATE_LIMIT_MAX,
    validationWindowMs: options.validateRateLimitWindowMs || process.env.API_VALIDATE_RATE_LIMIT_WINDOW_MS,
    validationMax: options.validateRateLimitMax || process.env.API_VALIDATE_RATE_LIMIT_MAX,
    outlineWindowMs: options.outlineRateLimitWindowMs || process.env.API_MODEL_OUTLINE_RATE_LIMIT_WINDOW_MS,
    outlineMax: options.outlineRateLimitMax || process.env.API_MODEL_OUTLINE_RATE_LIMIT_MAX,
    sysonReadWindowMs: options.sysonReadRateLimitWindowMs || process.env.API_SYSON_READ_RATE_LIMIT_WINDOW_MS,
    sysonReadMax: options.sysonReadRateLimitMax || process.env.API_SYSON_READ_RATE_LIMIT_MAX,
    sysonComputeWindowMs: options.sysonComputeRateLimitWindowMs || process.env.API_SYSON_COMPUTE_RATE_LIMIT_WINDOW_MS,
    sysonComputeMax: options.sysonComputeRateLimitMax || process.env.API_SYSON_COMPUTE_RATE_LIMIT_MAX,
    sysonWriteWindowMs: options.sysonWriteRateLimitWindowMs || process.env.API_SYSON_WRITE_RATE_LIMIT_WINDOW_MS,
    sysonWriteMax: options.sysonWriteRateLimitMax || process.env.API_SYSON_WRITE_RATE_LIMIT_MAX
  });
  const fixedPlatformGlossaryStore = options.platformGlossaryStore || null;
  const appRegistry = options.appRegistry || createAppRegistry(options);
  let memoizedPlatformGlossaryStore = null;
  const getPlatformGlossaryStore = () => {
    if (fixedPlatformGlossaryStore) return fixedPlatformGlossaryStore;
    if (!memoizedPlatformGlossaryStore) memoizedPlatformGlossaryStore = createPlatformGlossaryStore(options);
    return memoizedPlatformGlossaryStore;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') return send(res, 204, {});

    try {
      let memoizedCoursePack = null;
      let memoizedCourseStore = null;
      const getCoursePack = () => {
        if (!memoizedCoursePack) memoizedCoursePack = resolveRequestCoursePack(url);
        return memoizedCoursePack;
      };
      const getCourseStore = () => {
        if (!memoizedCourseStore) {
          const pack = getCoursePack();
          memoizedCourseStore = fixedCourseStore || createCourseStore({ ...options, coursePack: pack.id, packDir: pack.path });
        }
        return memoizedCourseStore;
      };
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, await health(getCourseStore()));
      }

      if (req.method === 'POST' && url.pathname === '/internal/teacher/validate-candidate') {
        requireTeacherToolRequest(req);
        const payload = await readJson(req);
        return send(res, 200, await validateTeacherCandidateWorkspace(payload, getCourseStore(), req));
      }

      if (req.method === 'GET' && url.pathname === '/internal/teacher/model-route-attestation') {
        requireTeacherToolRequest(req);
        const accountStore = authService.betterAuth?.accountStore;
        const activeVersion = accountStore?.getActiveLiteLlmConfigVersion
          ? await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false })
          : null;
        return send(res, 200, await aiTeacherModelRouteAttestation(
          url.searchParams.get('modelAlias'),
          activeVersion
        ));
      }

      if (url.pathname.startsWith('/api/teacher/')) {
        if (!features.aiTeacherEnabled) return send(res, 503, aiTeacherDisabledPayload());
        const result = await handleTeacherRequest(req, url, getCourseStore(), authService, res);
        if (result === STREAM_RESPONSE_HANDLED) return;
        return send(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/apps') {
        return send(res, 200, appRegistry.registry());
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/apps/')) {
        const appId = decodeURIComponent(url.pathname.split('/')[3] || '');
        const app = appRegistry.loadApp(appId);
        return app ? send(res, 200, app) : send(res, 404, { error: 'App not found', code: 'APP_NOT_FOUND' });
      }
      if (req.method === 'GET' && url.pathname === '/api/course-packs') {
        const enabledPacks = courseRegistry.listPacks({ includeDisabled: false });
        return send(res, 200, {
          activeCoursePackId: enabledPacks.find((pack) => pack.id === courseRegistry.defaultPackId)?.id || enabledPacks[0]?.id || '',
          packs: enabledPacks
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/knowledge-packs') {
        return send(res, 200, { packs: knowledgeRegistry.listPacks().map(publicKnowledgePack) });
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/knowledge-packs\/[^/]+$/)) {
        const packId = decodeURIComponent(url.pathname.split('/').pop());
        return send(res, 200, publicKnowledgePack(knowledgeRegistry.loadPack(packId)));
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/knowledge-packs\/[^/]+\/topics\/[^/]+$/)) {
        const parts = url.pathname.split('/').map((part) => decodeURIComponent(part));
        return send(res, 200, publicKnowledgePack(knowledgeRegistry.loadTopic(parts[3], parts[5])));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/knowledge-assets/')) {
        const parts = url.pathname.slice('/api/knowledge-assets/'.length).split('/').map((part) => decodeURIComponent(part));
        const file = knowledgeRegistry.resolveAsset(parts.shift(), parts.shift(), parts.join('/'));
        return sendRaw(res, 200, knowledgeAssetMime(file), fs.readFileSync(file));
      }
      if (url.pathname.match(/^\/api\/knowledge-progress\/[^/]+$/)) {
        const packId = decodeURIComponent(url.pathname.split('/').pop());
        const user = await authService.requireEntitlement(req, 'progress.write');
        if (req.method === 'GET') return send(res, 200, dataStore.readKnowledgeProgress(packId, user));
        if (req.method === 'PUT') return send(res, 200, dataStore.writeKnowledgeProgress(packId, await readJson(req), user));
      }
      if (url.pathname === '/api/admin/knowledge-packs' && req.method === 'GET') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { packs: knowledgeRegistry.listPacks({ includeDisabled: true }).map(publicKnowledgePack) });
      }
      if (url.pathname === '/api/admin/knowledge-packs/upload/preview' && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { ok: true, pendingUpload: knowledgeRegistry.previewUploadedArchive(await readMultipartFile(req, 'file', 26 * 1024 * 1024)) });
      }
      if (url.pathname === '/api/admin/knowledge-packs/upload/pending' && req.method === 'GET') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { pendingUploads: knowledgeRegistry.listPendingUploads() });
      }
      if (url.pathname === '/api/admin/knowledge-packs/upload/confirm' && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        const body = await readJson(req);
        return send(res, 200, { ok: true, pack: publicKnowledgePack(knowledgeRegistry.confirmPendingUpload(body.pendingUploadId)) });
      }
      if (url.pathname.match(/^\/api\/admin\/knowledge-packs\/upload\/[^/]+$/) && req.method === 'DELETE') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, knowledgeRegistry.abandonPendingUpload(decodeURIComponent(url.pathname.split('/').pop())));
      }
      if (url.pathname.match(/^\/api\/admin\/knowledge-packs\/[^/]+\/archive$/) && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { ok: true, pack: publicKnowledgePack(knowledgeRegistry.archivePack(decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]))) });
      }
      if (url.pathname.match(/^\/api\/admin\/knowledge-packs\/[^/]+\/restore$/) && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { ok: true, pack: publicKnowledgePack(knowledgeRegistry.restoreArchivedPack(decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]))) });
      }
      if (url.pathname.match(/^\/api\/admin\/knowledge-packs\/[^/]+$/) && req.method === 'DELETE') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, knowledgeRegistry.deleteArchivedPack(decodeURIComponent(url.pathname.split('/').pop())));
      }
      if (url.pathname.match(/^\/api\/admin\/knowledge-packs\/[^/]+$/) && req.method === 'PATCH') {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').pop());
        const body = await readJson(req);
        return send(res, 200, { ok: true, pack: publicKnowledgePack(knowledgeRegistry.setEnabled(packId, body.enabled)) });
      }
      if (url.pathname === '/api/admin/course-packs' && req.method === 'GET') {
        await authService.requirePermission(req, 'course.pack.manage');
        const enabledPacks = courseRegistry.listPacks({ includeDisabled: false });
        return send(res, 200, {
          activeCoursePackId: enabledPacks.find((pack) => pack.id === courseRegistry.defaultPackId)?.id || enabledPacks[0]?.id || '',
          packs: courseRegistry.listPacks({ includeDisabled: true })
        });
      }
      if (url.pathname === '/api/admin/course-packs/upload' && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        const upload = await readMultipartFile(req, 'file');
        const pack = courseRegistry.installUploadedArchive(upload);
        return send(res, 200, { ok: true, pack });
      }
      if (url.pathname === '/api/admin/course-packs/upload/preview' && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        const upload = await readMultipartFile(req, 'file');
        const pendingUpload = courseRegistry.previewUploadedArchive(upload);
        return send(res, 200, { ok: true, pendingUpload });
      }
      if (url.pathname === '/api/admin/course-packs/upload/pending' && req.method === 'GET') {
        await authService.requirePermission(req, 'course.pack.manage');
        return send(res, 200, { pendingUploads: courseRegistry.listPendingUploads() });
      }
      if (url.pathname === '/api/admin/course-packs/upload/confirm' && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        const body = await readJson(req);
        const pack = courseRegistry.confirmPendingUpload(body.pendingUploadId, body.action || 'confirm');
        return send(res, 200, { ok: true, pack });
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/upload\/[^/]+$/) && req.method === 'DELETE') {
        await authService.requirePermission(req, 'course.pack.manage');
        const pendingUploadId = decodeURIComponent(url.pathname.split('/').pop());
        return send(res, 200, courseRegistry.abandonPendingUpload(pendingUploadId));
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/[^/]+\/archive$/) && (req.method === 'POST' || req.method === 'PATCH')) {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
        const pack = courseRegistry.archivePack(packId);
        return send(res, 200, { ok: true, pack });
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/[^/]+\/restore$/) && (req.method === 'POST' || req.method === 'PATCH')) {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
        const pack = courseRegistry.restoreArchivedPack(packId);
        return send(res, 200, { ok: true, pack });
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/[^/]+\/move$/) && req.method === 'POST') {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
        const body = await readJson(req);
        const packs = courseRegistry.movePack(packId, body.direction);
        return send(res, 200, { ok: true, packs });
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/[^/]+$/) && req.method === 'DELETE') {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').pop());
        return send(res, 200, courseRegistry.deleteArchivedPack(packId));
      }
      if (url.pathname.match(/^\/api\/admin\/course-packs\/[^/]+$/) && (req.method === 'PUT' || req.method === 'PATCH')) {
        await authService.requirePermission(req, 'course.pack.manage');
        const packId = decodeURIComponent(url.pathname.split('/').pop());
        const body = await readJson(req);
        const pack = courseRegistry.setEnabled(packId, body.enabled);
        return send(res, 200, { ok: true, pack });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        enforceRateLimit(rateLimiters.auth, clientIpKey(req), { scope: 'auth', route: '/api/auth/login' });
        return sendAuthResult(res, 200, await authService.login(await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        enforceRateLimit(rateLimiters.auth, clientIpKey(req), { scope: 'auth', route: '/api/auth/register' });
        return sendAuthResult(res, 200, await authService.register(await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/guest') {
        enforceRateLimit(rateLimiters.auth, clientIpKey(req), { scope: 'auth', route: '/api/auth/guest' });
        return sendAuthResult(res, 200, await authService.signInGuest(req));
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = await authService.currentUser(req);
        return send(res, 200, { authenticated: Boolean(user), user });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/activity') {
        const user = await authService.requireUser(req);
        const body = await readJson(req);
        const activity = await authService.betterAuth.accountStore.recordPlatformActivity({
          userId: user.id,
          seconds: body.seconds
        });
        return send(res, 200, { ok: true, activity });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-modeling-tools') {
        const accountStore = requireAdminAccountStore(authService);
        const settings = await accountStore.getExternalModelingToolSettings(SYSON_TOOL_ID);
        return send(res, 200, publicExternalModelingTools(settings));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/syson-access') {
        const body = await readJson(req);
        const access = normalizeSysonAccess(body.access);
        const entitlementCode = access === 'read'
          ? 'course.read'
          : access === 'compute'
            ? 'syson.model.write'
            : 'syson.proxy.write';
        const user = await authService.requireEntitlement(req, entitlementCode);
        const accountStore = requireAdminAccountStore(authService);
        const settings = await accountStore.getExternalModelingToolSettings(SYSON_TOOL_ID);
        if (!externalModelingToolAccessAllowed(settings, access)) {
          const error = new Error(`SysON ${access} access is disabled by external modeling tool policy.`);
          error.statusCode = 403;
          error.code = 'EXTERNAL_MODELING_TOOL_ACCESS_DISABLED';
          throw error;
        }
        const limiter = access === 'read'
          ? rateLimiters.sysonRead
          : access === 'compute'
            ? rateLimiters.sysonCompute
            : rateLimiters.sysonWrite;
        enforceRateLimit(limiter, customerKey(req, user), {
          scope: `syson.${access}`,
          route: String(body.route || '').slice(0, 256)
        });
        return send(res, 200, {
          authorized: true,
          access,
          userId: user.id,
          entitlementCode
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        return send(res, 200, await authService.logout(req));
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
        return send(res, 200, await authService.providers());
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/wechat/start') {
        return send(res, 200, await authService.wechatStart(url.searchParams.get('callbackURL')));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/sign-up/email') {
        const settings = await authService.betterAuth.accountStore.getAuthSettings();
        if (!settings.registrationEnabled) {
          return send(res, 403, { error: '当前平台暂未开放用户注册。', code: 'REGISTRATION_DISABLED' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/sign-in/anonymous') {
        const settings = await authService.betterAuth.accountStore.getAuthSettings();
        if (!settings.guestLoginEnabled) {
          return send(res, 403, { error: '当前平台暂未开放游客登录。', code: 'GUEST_LOGIN_DISABLED' });
        }
      }
      if (url.pathname.startsWith('/api/auth/')) {
        return authService.betterAuth.handleNode(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/api/ai-teacher/status') {
        if (!features.aiTeacherEnabled) {
          return send(res, 200, {
            enabled: false,
            available: false,
            permission: 'ai.teacher.use',
            user: await authService.currentUser(req)
          });
        }
        const user = await authService.requireUser(req);
        const available = authService.hasEntitlement(user, 'ai.teacher.use');
        await recordAiAccess(authService, {
          userId: user.id,
          decision: available ? 'allow' : 'deny',
          entitlementCode: 'ai.teacher.use',
          reason: available ? 'entitlement_present' : 'missing_entitlement'
        });
        return send(res, 200, {
          enabled: true,
          available,
          permission: 'ai.teacher.use',
          user
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/ai-teacher/message') {
        if (!features.aiTeacherEnabled) return send(res, 503, aiTeacherDisabledPayload());
        const user = await requireAiTeacherAccess(req, authService, { lessonId: null });
        const body = await readJson(req);
        const reply = aiTeacherPhase0Reply(body.message);
        await authService.betterAuth?.accountStore?.recordAiExchange({
          userId: user.id,
          lessonId: body.lessonId || null,
          capability: 'answer',
          prompt: body.message || '',
          reply,
          model: 'phase0-placeholder',
          tokenUsage: estimateTokenUsage(body.message, reply),
          entitlementCode: 'ai.teacher.use'
        });
        return send(res, 200, {
          ok: true,
          userId: user.id,
          reply
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/entitlements') {
        const user = await authService.requireUser(req);
        return send(res, 200, { entitlements: user.entitlements || [], permissions: user.permissions || [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/account/tier') {
        const user = await authService.requireUser(req);
        return send(res, 200, { tier: user.tier, userId: user.id });
      }
      if (req.method === 'GET' && url.pathname === '/api/account/usage/ai') {
        const user = await authService.requireUser(req);
        const usage = await authService.betterAuth?.accountStore?.getAiUsageSummary(user.id, { user });
        return send(res, 200, usage || { userId: user.id, messageCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/status') {
        const user = await authService.requireEntitlement(req, 'admin.console.access');
        return send(res, 200, { available: true, userId: user.id, permissions: user.permissions || [] });
      }
      if (url.pathname === '/api/admin/auth/settings' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const settings = await authService.betterAuth.accountStore.getAuthSettings();
        return send(res, 200, { settings });
      }
      if (url.pathname === '/api/admin/auth/settings' && req.method === 'PATCH') {
        const admin = await requireAdminUser(req, authService);
        const body = await readJson(req);
        return send(res, 200, await authService.betterAuth.accountStore.updateAuthSettings({
          actorUserId: admin.id,
          settings: body.settings || body,
          requestId: req.headers['x-request-id'] || ''
        }));
      }
      if (url.pathname === '/api/admin/external-modeling-tools' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const settings = await accountStore.getExternalModelingToolSettings(SYSON_TOOL_ID);
        return send(res, 200, { tools: [externalModelingToolAdminView(settings)] });
      }
      if (url.pathname === '/api/admin/external-modeling-tools/syson' && req.method === 'PATCH') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        const settings = validateExternalModelingToolPatch(body.settings || body);
        const updated = await accountStore.updateExternalModelingToolSettings({
          actorUserId: admin.id,
          toolId: SYSON_TOOL_ID,
          settings,
          requestId: req.headers['x-request-id'] || ''
        });
        return send(res, 200, {
          before: externalModelingToolAdminView(updated.before),
          tool: externalModelingToolAdminView(updated.settings)
        });
      }
      if (url.pathname === '/api/admin/external-modeling-tools/syson/probe' && req.method === 'POST') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const settings = await accountStore.getExternalModelingToolSettings(SYSON_TOOL_ID);
        const probe = options.externalModelingToolHealthProbe || probeSysONHealth;
        const health = await probe({ serviceUrl: process.env.SYSON_VIEW_SERVICE_URL || '' });
        return send(res, 200, { tool: externalModelingToolAdminView(settings, process.env, health) });
      }
      if (url.pathname === '/api/admin/ai-teacher/runtime' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        return send(res, 200, await aiTeacherAdminRuntime(features));
      }
      if (url.pathname === '/api/admin/ai-teacher/failure-observability' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const windowHours = Math.min(168, positiveInteger(url.searchParams.get('windowHours'), 24));
        const limit = Math.min(100, positiveInteger(url.searchParams.get('limit'), 40));
        return send(res, 200, await callTeacher(
          `/v1/admin/failure-observability?windowHours=${encodeURIComponent(windowHours)}&limit=${encodeURIComponent(limit)}`,
          { method: 'GET' }
        ));
      }
      if (url.pathname === '/api/admin/ai-teacher/execution-checkpoints' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const runId = String(url.searchParams.get('runId') || '').trim();
        if (!/^run_[a-zA-Z0-9-]{8,160}$/u.test(runId)) {
          return send(res, 400, publicError('INVALID_RUN_ID', 'runId is invalid', 400));
        }
        return send(res, 200, await callTeacher(
          `/v1/admin/execution-checkpoints?runId=${encodeURIComponent(runId)}`,
          { method: 'GET' }
        ));
      }
      if (url.pathname === '/api/admin/ai-teacher/resource-policy/catalog' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const modelRegistry = await activeAiTeacherModelRegistry(accountStore);
        return send(res, 200, { ...agentResourcePolicyCatalog(), modelRegistry });
      }
      if (url.pathname === '/api/admin/ai-teacher/model-registry' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        return send(res, 200, await activeAiTeacherModelRegistry(accountStore));
      }
      if (url.pathname === '/api/admin/ai-teacher/resource-policy/versions' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const versions = await accountStore.listAgentResourcePolicyVersions({ limit: url.searchParams.get('limit') || 20 });
        return send(res, 200, { versions });
      }
      if (url.pathname === '/api/admin/ai-teacher/resource-policy/active' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        return send(res, 200, await agentResourcePolicyAdminState(accountStore));
      }
      if (url.pathname === '/api/admin/ai-teacher/resource-policy/versions' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        const modelRegistry = await activeAiTeacherModelRegistry(accountStore);
        const version = await accountStore.createAgentResourcePolicyVersion({
          values: body.values,
          sourceVersionId: body.sourceVersionId || '',
          notes: body.notes || '',
          actorUserId: admin.id,
          modelRegistry
        });
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.agent_resource_policy.draft_created',
          targetType: 'ai_teacher_agent_resource_policy',
          targetRef: version.versionId,
          metadata: { sourceVersionId: version.sourceVersionId || null }
        });
        return send(res, 201, { version });
      }
      const agentResourcePolicyValidateMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/resource-policy\/versions\/([^/]+)\/validate$/);
      if (agentResourcePolicyValidateMatch && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const modelRegistry = await activeAiTeacherModelRegistry(accountStore);
        const version = await accountStore.validateAgentResourcePolicyVersion({
          versionId: decodeURIComponent(agentResourcePolicyValidateMatch[1]),
          actorUserId: admin.id,
          modelRegistry
        });
        return send(res, 200, { version });
      }
      const agentResourcePolicyPublishMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/resource-policy\/versions\/([^/]+)\/publish$/);
      if (agentResourcePolicyPublishMatch && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const modelRegistry = await activeAiTeacherModelRegistry(accountStore);
        const versionId = decodeURIComponent(agentResourcePolicyPublishMatch[1]);
        const validated = await accountStore.validateAgentResourcePolicyVersion({ versionId, actorUserId: admin.id, modelRegistry });
        if (!validated.validation?.ok) throwAgentResourcePolicyPublishInvalid(validated.validation);
        const snapshot = resourcePolicySnapshotFromVersion(validated);
        const staged = await callTeacher('/v1/admin/resource-policy/stage', { method: 'POST', body: { snapshot } });
        if (staged?.accepted !== true) throwAgentResourcePolicyOwnerFailed('AGENT_RESOURCE_POLICY_STAGE_FAILED', staged);
        const published = await accountStore.publishAgentResourcePolicyVersion({ versionId, actorUserId: admin.id, modelRegistry });
        let observed;
        try {
          observed = await callTeacher('/v1/admin/resource-policy/activate', { method: 'POST', body: { snapshot } });
        } catch (error) {
          observed = { status: 'degraded', errorCode: error.code || 'AGENT_RESOURCE_POLICY_OWNER_ACTIVATE_FAILED' };
        }
        return send(res, 200, {
          desired: published,
          observed,
          inSync: observed?.versionId === published.versionId && observed?.checksum === published.checksum
        });
      }
      const agentResourcePolicyRollbackMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/resource-policy\/versions\/([^/]+)\/rollback$/);
      if (agentResourcePolicyRollbackMatch && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        const modelRegistry = await activeAiTeacherModelRegistry(accountStore);
        const target = await accountStore.getAgentResourcePolicyVersion(decodeURIComponent(agentResourcePolicyRollbackMatch[1]));
        if (!target) {
          const error = new Error('Agent resource policy version not found.');
          error.statusCode = 404;
          error.code = 'AGENT_RESOURCE_POLICY_VERSION_NOT_FOUND';
          throw error;
        }
        const draft = await accountStore.createAgentResourcePolicyVersion({
          values: target.values,
          sourceVersionId: target.versionId,
          notes: body.notes || `Rollback to ${target.versionId}`,
          actorUserId: admin.id,
          modelRegistry
        });
        const validated = await accountStore.validateAgentResourcePolicyVersion({ versionId: draft.versionId, actorUserId: admin.id, modelRegistry });
        const snapshot = resourcePolicySnapshotFromVersion(validated);
        const staged = await callTeacher('/v1/admin/resource-policy/stage', { method: 'POST', body: { snapshot } });
        if (staged?.accepted !== true) throwAgentResourcePolicyOwnerFailed('AGENT_RESOURCE_POLICY_STAGE_FAILED', staged);
        const published = await accountStore.publishAgentResourcePolicyVersion({ versionId: draft.versionId, actorUserId: admin.id, modelRegistry });
        const observed = await callTeacher('/v1/admin/resource-policy/activate', { method: 'POST', body: { snapshot } });
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.agent_resource_policy.rolled_back',
          targetType: 'ai_teacher_agent_resource_policy',
          targetRef: published.versionId,
          metadata: { sourceVersionId: target.versionId }
        });
        return send(res, 200, {
          desired: published,
          observed,
          inSync: observed?.versionId === published.versionId && observed?.checksum === published.checksum
        });
      }
      if (url.pathname === '/api/admin/ai-teacher/tier-policies' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        return send(res, 200, await accountStore.getAiTeacherTierPolicies());
      }
      if (url.pathname === '/api/admin/ai-teacher/tier-policies' && req.method === 'PATCH') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        return send(res, 200, await accountStore.updateAiTeacherTierPolicies({
          policies: body.policies || body,
          actorUserId: admin.id
        }));
      }
      if (url.pathname === '/api/admin/ai-teacher/litellm/health' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const activeVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        return send(res, 200, await aiTeacherLiteLlmHealth(activeVersion));
      }
      if (url.pathname === '/api/admin/ai-teacher/provider-status' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const activeVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        await providerStatusMonitor.ready?.();
        return send(res, 200, await aiTeacherProviderStatus(providerStatusMonitor, activeVersion));
      }
      if (url.pathname === '/api/admin/ai-teacher/provider-status/refresh' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const activeVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        await providerStatusMonitor.refresh({ trigger: 'manual' });
        const result = await aiTeacherProviderStatus(providerStatusMonitor, activeVersion);
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.provider_status.refreshed',
          targetType: 'ai_teacher_provider_status',
          targetRef: 'official_feeds',
          metadata: {
            trigger: 'manual',
            outcome: result.sync?.lastOutcome || 'unknown',
            generatedAt: result.generatedAt || null
          }
        });
        return send(res, 200, result);
      }
      if (url.pathname === '/api/admin/ai-teacher/domain-web-search' && req.method === 'PATCH') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const payload = domainWebSearchTogglePayload(await readJson(req));
        const updated = await callTeacher('/v1/admin/domain-web-search', {
          method: 'PATCH',
          body: payload
        });
        const activeVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        const result = await aiTeacherProviderStatus(providerStatusMonitor, activeVersion);
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.domain_web_search.toggled',
          targetType: 'ai_teacher_domain_web_search',
          targetRef: 'teacher_runtime',
          metadata: {
            enabled: payload.enabled,
            outcome: boundedPublicStatusValue(updated.probe?.status) || (payload.enabled ? 'enabled' : 'disabled'),
            action: boundedPublicStatusValue(updated.action),
            probeStatus: boundedPublicStatusValue(updated.probe?.status),
            probeAttemptCount: boundedStatusNumber(updated.probe?.attemptCount, 1000),
            controlSource: updated.domainWebSearch?.controlSource || 'runtime',
            controlUpdatedAt: updated.domainWebSearch?.controlUpdatedAt || null
          }
        });
        return send(res, 200, result);
      }
      if (url.pathname === '/api/admin/ai-teacher/domain-web-search/probe' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        emptyObjectPayload(await readJson(req), 'DOMAIN_WEB_SEARCH_PROBE_INVALID');
        const updated = await callTeacher('/v1/admin/domain-web-search/probe', {
          method: 'POST',
          body: {}
        });
        const activeVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        const result = await aiTeacherProviderStatus(providerStatusMonitor, activeVersion);
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.domain_web_search.probed',
          targetType: 'ai_teacher_domain_web_search',
          targetRef: 'teacher_runtime_probe',
          metadata: {
            outcome: boundedPublicStatusValue(updated.probe?.status),
            action: boundedPublicStatusValue(updated.action),
            probeAttemptCount: boundedStatusNumber(updated.probe?.attemptCount, 1000),
            searchRequestCount: boundedStatusNumber(updated.probe?.searchRequestCount, 2),
            sourceCount: boundedStatusNumber(updated.probe?.sourceCount, 20),
            durationMs: boundedStatusNumber(updated.probe?.durationMs, 120000)
          }
        });
        return send(res, 200, result);
      }
      if (url.pathname === '/api/admin/ai-teacher/litellm/usage-summary' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        return send(res, 200, await aiTeacherLiteLlmUsageSummary());
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/catalog' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        return send(res, 200, publicAdapterProfileCatalog());
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/credentials' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const credentials = await listManagedCredentials();
        return send(res, 200, { credentials });
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/credentials' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        assertAdminSecretMutationOrigin(req);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        assertManagedCredentialConfirmation(body.confirmation, body.credentialName);
        const credential = await writeManagedCredential(body);
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.llm_credential.created',
          targetType: 'ai_teacher_llm_credential',
          targetRef: credential.credentialName,
          metadata: { provider: credential.provider }
        });
        return send(res, 201, { credential });
      }
      const managedCredentialMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/llm-control-plane\/credentials\/([^/]+)$/);
      if (managedCredentialMatch && req.method === 'PATCH') {
        const admin = await requireAdminUser(req, authService);
        assertAdminSecretMutationOrigin(req);
        const accountStore = requireAdminAccountStore(authService);
        const credentialName = decodeURIComponent(managedCredentialMatch[1]);
        const body = await readJson(req);
        assertManagedCredentialConfirmation(body.confirmation, credentialName);
        const credential = await writeManagedCredential({ ...body, credentialName });
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.llm_credential.rotated',
          targetType: 'ai_teacher_llm_credential',
          targetRef: credential.credentialName,
          metadata: { provider: credential.provider }
        });
        return send(res, 200, { credential });
      }
      if (managedCredentialMatch && req.method === 'DELETE') {
        const admin = await requireAdminUser(req, authService);
        assertAdminSecretMutationOrigin(req);
        const accountStore = requireAdminAccountStore(authService);
        const credentialName = decodeURIComponent(managedCredentialMatch[1]);
        const body = await readJson(req);
        assertManagedCredentialConfirmation(body.confirmation, credentialName);
        const references = await managedCredentialLiveReferences(accountStore, credentialName);
        if (references.length) {
          return send(res, 409, {
            error: 'Credential is referenced by an active or draft LiteLLM configuration.',
            code: 'LITELLM_CREDENTIAL_IN_USE',
            references
          });
        }
        const result = await deleteManagedCredential(credentialName);
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.llm_credential.deleted',
          targetType: 'ai_teacher_llm_credential',
          targetRef: result.credentialName,
          metadata: {}
        });
        return send(res, 200, result);
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/probe-connection' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        const result = await probeProviderConnection(body.connection || {}, { providerModelId: body.providerModelId });
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.llm_connection.probed',
          targetType: 'ai_teacher_llm_connection',
          targetRef: String(body.connection?.connectionId || '').slice(0, 128),
          metadata: {
            outcome: result.status,
            errorCode: result.errorCode || '',
            httpStatus: Number(result.httpStatus || 0),
            durationMs: Number(result.durationMs || 0)
          }
        });
        return send(res, result.status === 'blocked' ? 409 : 200, result);
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/capability-probes' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const versionId = String(url.searchParams.get('versionId') || '').trim();
        const version = versionId
          ? await accountStore.getLiteLlmConfigVersion(versionId, { includeRenderedYaml: false })
          : await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
        if (!version) return send(res, 404, { error: 'LiteLLM config version not found.', code: 'LITELLM_CONFIG_VERSION_NOT_FOUND' });
        return send(res, 200, await capabilityProbeEvidenceForVersion(accountStore, version));
      }
      if (url.pathname === '/api/admin/ai-teacher/llm-control-plane/capability-probes' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        assertCapabilityProbeConfirmation(body.confirmation);
        const version = await accountStore.getLiteLlmConfigVersion(String(body.versionId || ''), { includeRenderedYaml: false });
        if (!version) return send(res, 404, { error: 'LiteLLM config version not found.', code: 'LITELLM_CONFIG_VERSION_NOT_FOUND' });
        const descriptor = deploymentProbeDescriptor(version.config, body.deploymentId);
        const rawRun = await capabilityProbeRunner(version.config, descriptor.deployment.deploymentId);
        const run = normalizeCapabilityProbeRun(rawRun, descriptor);
        const persisted = await accountStore.recordLiteLlmCapabilityProbeRun({
          versionId: version.versionId,
          configChecksum: version.checksum,
          run,
          actorUserId: admin.id
        });
        await accountStore.recordAdminAudit({
          actorUserId: admin.id,
          eventType: 'ai_teacher.llm_deployment.capability_probed',
          targetType: 'ai_teacher_llm_deployment',
          targetRef: descriptor.deployment.deploymentId,
          metadata: {
            outcome: persisted.status,
            errorCode: persisted.errorCode || '',
            providerCalls: Number(persisted.usage?.providerCalls || 0),
            totalTokens: Number(persisted.usage?.totalTokens || 0),
            durationMs: Number(persisted.durationMs || 0)
          }
        });
        return send(res, 200, { run: persisted, evidence: await capabilityProbeEvidenceForVersion(accountStore, version) });
      }
      if (url.pathname === '/api/admin/ai-teacher/litellm/config-versions' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const versions = await accountStore.listLiteLlmConfigVersions({
          limit: url.searchParams.get('limit') || 20,
          includeRenderedYaml: url.searchParams.get('includeYaml') === '1'
        });
        return send(res, 200, { versions });
      }
      if (url.pathname === '/api/admin/ai-teacher/litellm/config-versions' && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const body = await readJson(req);
        const version = await accountStore.createLiteLlmConfigVersion({
          config: assignServerControlPlaneIds(body.config),
          notes: body.notes || '',
          createdBy: admin.id
        });
        return send(res, 201, { version });
      }
      if (url.pathname === '/api/admin/ai-teacher/litellm/config-versions/active' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const version = await accountStore.getActiveLiteLlmConfigVersion({
          includeRenderedYaml: url.searchParams.get('includeYaml') === '1'
        });
        return send(res, 200, { version });
      }
      const adminLiteLlmConfigPublishMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/litellm\/config-versions\/([^/]+)\/publish$/);
      if (adminLiteLlmConfigPublishMatch && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const draft = await accountStore.getLiteLlmConfigVersion(decodeURIComponent(adminLiteLlmConfigPublishMatch[1]), {
          includeRenderedYaml: true
        });
        if (!draft) return send(res, 404, { error: 'LiteLLM config version not found.', code: 'LITELLM_CONFIG_VERSION_NOT_FOUND' });
        const preflight = await validateLiteLlmPublishPreflight(draft);
        const capabilityEvidence = await capabilityProbeEvidenceForVersion(accountStore, draft);
        assertLiteLlmCapabilityPublishGate(draft, capabilityEvidence);
        preflight.capabilityEvidence = capabilityEvidence;
        const apply = await applyLiteLlmConfigVersion(draft);
        if (apply.status !== 'applied') throwLiteLlmPublishGateFailed('LITELLM_CONFIG_APPLY_FAILED', apply.message || 'LiteLLM admin apply failed.', { preflight, apply });
        const health = await aiTeacherLiteLlmHealth(draft);
        if (health.status !== 'healthy') throwLiteLlmPublishGateFailed('LITELLM_CONFIG_HEALTH_FAILED', health.error || 'LiteLLM health check failed after apply.', { preflight, apply, health });
        const version = await accountStore.publishLiteLlmConfigVersion({
          versionId: draft.versionId,
          actorUserId: admin.id
        });
        const resourcePolicyAdvisory = await agentResourcePolicyAliasAdvisory(accountStore, version);
        return send(res, 200, { version, preflight, apply, health, resourcePolicyAdvisory });
      }
      const adminLiteLlmConfigVersionMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/litellm\/config-versions\/([^/]+)$/);
      if (adminLiteLlmConfigVersionMatch && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const version = await accountStore.getLiteLlmConfigVersion(decodeURIComponent(adminLiteLlmConfigVersionMatch[1]), {
          includeRenderedYaml: url.searchParams.get('includeYaml') === '1'
        });
        if (!version) return send(res, 404, { error: 'LiteLLM config version not found.', code: 'LITELLM_CONFIG_VERSION_NOT_FOUND' });
        return send(res, 200, { version });
      }
      if (url.pathname === '/api/admin/ai-teacher/usage/summary' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        return send(res, 200, await accountStore.getAiTeacherAdminUsageSummary({
          search: url.searchParams.get('search') || '',
          quotaLimit: url.searchParams.get('quotaLimit') || 200
        }));
      }
      if (url.pathname === '/api/admin/ai-teacher/usage/users' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const users = await accountStore.listAiTeacherUsageUsers({
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || 100
        });
        return send(res, 200, { users });
      }
      const adminAiUsageResetMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/usage\/users\/([^/]+)\/reset$/);
      if (adminAiUsageResetMatch && req.method === 'POST') {
        const admin = await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const result = await accountStore.resetAiTeacherQuota({
          actorUserId: admin.id,
          userId: decodeURIComponent(adminAiUsageResetMatch[1]),
          requestId: requestIdFrom(req)
        });
        return send(res, 200, { ok: true, ...result });
      }
      if (url.pathname === '/api/admin/ai-teacher/quota-events' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const events = await accountStore.listAiQuotaEvents({
          userId: url.searchParams.get('userId') || '',
          limit: url.searchParams.get('limit') || 50
        });
        return send(res, 200, { events: events.map(publicAiTeacherQuotaEvent) });
      }
      if (url.pathname === '/api/admin/ai-teacher/conversations' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const conversations = await accountStore.listAiTeacherConversations({
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || 50
        });
        return send(res, 200, { conversations });
      }
      const adminAiConversationMessagesMatch = url.pathname.match(/^\/api\/admin\/ai-teacher\/conversations\/([^/]+)\/messages$/);
      if (adminAiConversationMessagesMatch && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const accountStore = requireAdminAccountStore(authService);
        const messages = await accountStore.listAiTeacherConversationMessages(
          decodeURIComponent(adminAiConversationMessagesMatch[1]),
          { limit: url.searchParams.get('limit') || 100 }
        );
        return send(res, 200, { messages });
      }
      if (url.pathname === '/api/admin/users' && req.method === 'GET') {
        await requireAdminUser(req, authService);
        const result = await authService.betterAuth.accountStore.listUsersPage({
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || 50,
          offset: url.searchParams.get('offset') || 0,
          sortBy: url.searchParams.get('sortBy') || '',
          sortDirection: url.searchParams.get('sortDirection') || ''
        });
        return send(res, 200, result);
      }
      if (url.pathname.startsWith('/api/admin/users/')) {
        const admin = await requireAdminUser(req, authService);
        const adminPath = parseAdminUserPath(url.pathname);
        if (!adminPath.userId) return send(res, 404, { error: 'Not found' });
        if (req.method === 'GET' && adminPath.action === '') {
          const user = await authService.betterAuth.accountStore.getUserProfile(adminPath.userId);
          if (!user) return send(res, 404, { error: '用户不存在。', code: 'USER_NOT_FOUND' });
          return send(res, 200, { user });
        }
        if (req.method === 'GET' && adminPath.action === 'usage/ai') {
          const user = await authService.betterAuth.accountStore.getUserProfile(adminPath.userId);
          if (!user) return send(res, 404, { error: '用户不存在。', code: 'USER_NOT_FOUND' });
          const usage = await authService.betterAuth.accountStore.getAiUsageSummary(adminPath.userId, { user });
          return send(res, 200, usage);
        }
        if (req.method === 'GET' && adminPath.action === 'audit') {
          const events = await authService.betterAuth.accountStore.listAdminAuditEvents({
            targetRef: adminPath.userId,
            limit: url.searchParams.get('limit') || 50
          });
          return send(res, 200, { events });
        }
        if (req.method === 'PATCH' && adminPath.action === 'tier') {
          const body = await readJson(req);
          const result = await authService.betterAuth.accountStore.updateUserTier({
            actorUserId: admin.id,
            userId: adminPath.userId,
            tier: body.tier,
            requestId: requestIdFrom(req)
          });
          return send(res, 200, { user: result.after, before: result.before });
        }
        if (req.method === 'PATCH' && adminPath.action === 'status') {
          const body = await readJson(req);
          const result = await authService.betterAuth.accountStore.updateUserStatus({
            actorUserId: admin.id,
            userId: adminPath.userId,
            status: body.status,
            requestId: requestIdFrom(req)
          });
          return send(res, 200, { user: result.after, before: result.before });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/course-pack') {
        const pack = getCoursePack();
        return send(res, 200, {
          ...getCourseStore().loadPack(),
          lineageId: pack.lineageId || '',
          dataNamespaceId: pack.dataNamespaceId || pack.lineageId || pack.id
        });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/course-assets/')) {
        const assetPath = decodeURIComponent(url.pathname.slice('/api/course-assets/'.length));
        const asset = getCourseStore().loadAsset(assetPath);
        return asset ? sendRaw(res, 200, asset.mimeType, asset.content) : send(res, 404, { error: 'Asset not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/courses') return send(res, 200, getCourseStore().loadCourses());
      if (req.method === 'GET' && url.pathname.startsWith('/api/courses/')) {
        const course = getCourseStore().loadCourse(decodeURIComponent(url.pathname.split('/').pop()));
        return course ? send(res, 200, course) : send(res, 404, { error: 'Course not found' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/lessons/')) {
        const parts = url.pathname.split('/');
        const lesson = getCourseStore().loadLesson(decodeURIComponent(parts[3]));
        return lesson ? send(res, 200, lesson) : send(res, 404, { error: 'Lesson not found' });
      }
      if (req.method === 'GET' && (url.pathname === '/api/examples' || url.pathname.startsWith('/api/examples/'))) {
        return send(res, 410, {
          error: 'Examples have been removed',
          code: 'EXAMPLES_REMOVED'
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/glossary') return send(res, 200, getPlatformGlossaryStore().loadGlossary());
      if (req.method === 'GET' && url.pathname === '/api/platform/glossaries') {
        return send(res, 200, { glossaries: [getPlatformGlossaryStore().loadSummary()] });
      }
      if (url.pathname.startsWith('/api/platform/glossaries/')) {
        const platformGlossaryStore = getPlatformGlossaryStore();
        const parts = url.pathname.split('/').map((part) => decodeURIComponent(part));
        const requestedGlossaryId = parts[4];
        if (requestedGlossaryId !== platformGlossaryStore.glossaryId) return send(res, 404, { error: 'Glossary not found' });
        if (req.method === 'GET' && parts.length === 5) return send(res, 200, platformGlossaryStore.loadSummary());
        if (req.method === 'GET' && parts.length === 6 && parts[5] === 'terms') return send(res, 200, platformGlossaryStore.loadGlossary());
        if (req.method === 'GET' && parts.length === 6 && parts[5] === 'graph') return send(res, 200, platformGlossaryStore.loadGraph());
        if (req.method === 'GET' && parts.length === 7 && parts[5] === 'terms') {
          const term = platformGlossaryStore.loadTerm(parts[6]);
          return term ? send(res, 200, term) : send(res, 404, { error: 'Term not found' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/final-project') {
        const project = getCourseStore().loadFinalProject();
        return project ? send(res, 200, project) : send(res, 404, { error: 'Final project not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/progress') {
        const courseStore = getCourseStore();
        const pack = getCoursePack();
        const dataNamespaceId = pack.dataNamespaceId || pack.lineageId || pack.id;
        const user = await authService.requireEntitlement(req, 'progress.write');
        const progress = dataStore.readProgress(dataNamespaceId, user);
        return send(res, 200, { ...progress, coursePackId: courseStore.packId, dataNamespaceId });
      }
      if (req.method === 'PUT' && url.pathname === '/api/progress') {
        const user = await authService.requireEntitlement(req, 'progress.write');
        const progress = await readJson(req);
        const courseStore = getCourseStore();
        const pack = getCoursePack();
        const dataNamespaceId = pack.dataNamespaceId || pack.lineageId || pack.id;
        const saved = dataStore.writeProgress({ ...progress, coursePackId: dataNamespaceId, dataNamespaceId }, user);
        await authService.betterAuth?.accountStore?.recordProgressMetadata(user, saved, dataNamespaceId);
        return send(res, 200, { ...saved, coursePackId: courseStore.packId, dataNamespaceId });
      }
      if (req.method === 'POST' && url.pathname === '/api/validate') {
        const user = await requireValidationAccess(req, authService);
        enforceRateLimit(rateLimiters.validation, customerKey(req, user), { scope: 'validation', route: '/api/validate' });
        return send(res, 200, await validateWithRules(await readJson(req), [{ type: 'strictValidationPassed' }]));
      }
      if (req.method === 'POST' && url.pathname === '/api/model-outline') {
        const user = await requireValidationAccess(req, authService);
        enforceRateLimit(rateLimiters.outline, customerKey(req, user), { scope: 'model-outline', route: '/api/model-outline' });
        return send(res, 200, await buildModelOutlineResponse(await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/plantuml') {
        const user = await requireValidationAccess(req, authService);
        enforceRateLimit(rateLimiters.validation, customerKey(req, user), { scope: 'validation', route: '/api/plantuml' });
        return send(res, 200, await callPlantUml(await readJson(req)));
      }
      if (url.pathname.startsWith('/api/drafts/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        const user = await authService.requireEntitlement(req, 'draft.write');
        const courseStore = getCourseStore();
        const pack = getCoursePack();
        const dataNamespaceId = pack.dataNamespaceId || pack.lineageId || pack.id;
        const metadataDraftId = `${dataNamespaceId}:${id}`;
        if (req.method === 'GET') {
          const draft = dataStore.readDraft(id, user, dataNamespaceId);
          return send(res, 200, draft
            ? { ...draft, id, coursePackId: courseStore.packId, dataNamespaceId }
            : { id, coursePackId: courseStore.packId, dataNamespaceId, files: [] });
        }
        if (req.method === 'PUT') {
          const body = await readJson(req);
          const draft = dataStore.writeDraft(id, { ...body, coursePackId: courseStore.packId, dataNamespaceId, lessonId: id }, user, dataNamespaceId);
          await authService.betterAuth?.accountStore?.recordDraftMetadata(user, metadataDraftId, draft);
          return send(res, 200, draft);
        }
        if (req.method === 'DELETE') {
          const result = dataStore.deleteDraft(id, user, dataNamespaceId);
          await authService.betterAuth?.accountStore?.deleteDraftMetadata(user, metadataDraftId);
          return send(res, 200, { ...result, coursePackId: courseStore.packId, dataNamespaceId });
        }
      }
      if (req.method === 'POST' && url.pathname.match(/^\/api\/lessons\/[^/]+\/validate$/)) {
        const user = await requireValidationAccess(req, authService);
        enforceRateLimit(rateLimiters.validation, customerKey(req, user), { scope: 'validation', route: '/api/lessons/:lessonId/validate' });
        const lessonId = decodeURIComponent(url.pathname.split('/')[3]);
        const lesson = getCourseStore().loadLesson(lessonId);
        if (!lesson) return send(res, 404, { error: 'Lesson not found' });
        return send(res, 200, await validateWithRules(await readJson(req), lesson.validation?.rules));
      }
      if (req.method === 'POST' && url.pathname === '/api/final-project/validate') {
        const user = await requireValidationAccess(req, authService);
        enforceRateLimit(rateLimiters.validation, customerKey(req, user), { scope: 'validation', route: '/api/final-project/validate' });
        const project = getCourseStore().loadFinalProject();
        if (!project) return send(res, 404, { error: 'Final project not found' });
        return send(res, 200, await validateWithRules(await readJson(req), project.validation?.rules));
      }

      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      const rawStatus = error.statusCode || error.status || (error.code === 'COURSE_PACK_NOT_FOUND' ? 503 : 500);
      const status = Number.isInteger(rawStatus) ? rawStatus : 500;
      const payload = { error: error.message, code: error.code || 'INTERNAL_ERROR' };
      if (error.details) payload.details = error.details;
      if (error.retryableBeforeStart === true) payload.retryableBeforeStart = true;
      if (error.validatorObservation) payload.validatorObservation = error.validatorObservation;
      return send(res, status, payload);
    }
  });

  providerStatusMonitor.start?.();
  server.once('close', () => providerStatusMonitor.stop?.());
  return server;

  function resolveRequestCoursePack(url) {
    const requestedPackId = url.searchParams.get('coursePackId') || url.searchParams.get('packId') || '';
    return courseRegistry.resolvePack(requestedPackId, {
      includeDisabled: url.pathname.startsWith('/api/admin/')
    });
  }
}

async function requireValidationAccess(req, authService) {
  return authService.requireEntitlement(req, 'course.read');
}

function createApiRateLimiters(options = {}) {
  const enabled = Boolean(options.enabled);
  return {
    auth: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.authWindowMs, DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.authMax, DEFAULT_AUTH_RATE_LIMIT_MAX)
    }),
    validation: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.validationWindowMs, DEFAULT_VALIDATION_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.validationMax, DEFAULT_VALIDATION_RATE_LIMIT_MAX)
    }),
    outline: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.outlineWindowMs, DEFAULT_MODEL_OUTLINE_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.outlineMax, DEFAULT_MODEL_OUTLINE_RATE_LIMIT_MAX)
    }),
    sysonRead: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.sysonReadWindowMs, DEFAULT_SYSON_READ_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.sysonReadMax, DEFAULT_SYSON_READ_RATE_LIMIT_MAX)
    }),
    sysonCompute: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.sysonComputeWindowMs, DEFAULT_SYSON_COMPUTE_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.sysonComputeMax, DEFAULT_SYSON_COMPUTE_RATE_LIMIT_MAX)
    }),
    sysonWrite: createFixedWindowRateLimiter({
      enabled,
      windowMs: positiveInteger(options.sysonWriteWindowMs, DEFAULT_SYSON_WRITE_RATE_LIMIT_WINDOW_MS),
      max: positiveInteger(options.sysonWriteMax, DEFAULT_SYSON_WRITE_RATE_LIMIT_MAX)
    })
  };
}

function normalizeSysonAccess(value) {
  const access = String(value || '').trim().toLowerCase();
  if (access === 'read' || access === 'compute' || access === 'write') return access;
  const error = new Error('SysON access type must be read, compute, or write.');
  error.statusCode = 400;
  error.code = 'SYSON_ACCESS_TYPE_INVALID';
  throw error;
}

function createFixedWindowRateLimiter(options = {}) {
  const buckets = new Map();
  const enabled = options.enabled !== false;
  const windowMs = positiveInteger(options.windowMs, DEFAULT_VALIDATION_RATE_LIMIT_WINDOW_MS);
  const max = positiveInteger(options.max, DEFAULT_VALIDATION_RATE_LIMIT_MAX);
  return {
    check(key, metadata = {}) {
      if (!enabled || max <= 0) {
        return { allowed: true, disabled: true, limit: max, remaining: null, resetAt: null, windowMs };
      }
      const now = Date.now();
      pruneExpiredBuckets(buckets, now);
      const normalizedKey = String(key || 'anonymous');
      let bucket = buckets.get(normalizedKey);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(normalizedKey, bucket);
      }
      if (bucket.count >= max) {
        return {
          allowed: false,
          key: normalizedKey,
          limit: max,
          remaining: 0,
          resetAt: bucket.resetAt,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
          windowMs,
          metadata
        };
      }
      bucket.count += 1;
      return {
        allowed: true,
        key: normalizedKey,
        limit: max,
        remaining: Math.max(0, max - bucket.count),
        resetAt: bucket.resetAt,
        windowMs,
        metadata
      };
    }
  };
}

function enforceRateLimit(limiter, key, metadata = {}) {
  const decision = limiter?.check ? limiter.check(key, metadata) : { allowed: true };
  if (decision.allowed) return decision;
  const error = new Error('请求过于频繁，请稍后再试。');
  error.statusCode = 429;
  error.code = 'RATE_LIMIT_EXCEEDED';
  error.details = {
    scope: metadata.scope || 'api',
    limit: decision.limit,
    windowMs: decision.windowMs,
    remaining: decision.remaining,
    retryAfterSeconds: decision.retryAfterSeconds,
    resetAt: decision.resetAt ? new Date(decision.resetAt).toISOString() : null
  };
  throw error;
}

function pruneExpiredBuckets(buckets, now) {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || bucket.resetAt <= now) buckets.delete(key);
  }
}

function customerKey(req, user) {
  if (user?.id) return `user:${user.id}`;
  return clientIpKey(req);
}

function clientIpKey(req) {
  return `ip:${clientIp(req)}`;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  return forwarded || realIp || req.socket?.remoteAddress || 'unknown';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function handleTeacherRequest(req, url, courseStore, authService, res) {
  const route = url.pathname.slice('/api/teacher'.length) || '/';
  if (route === '/health' && req.method === 'GET') {
    return projectPublicTeacherHealth(await callTeacher('/health', { method: 'GET' }));
  }
  if (route === '/capabilities' && req.method === 'GET') {
    return projectPublicTeacherCapabilities(await callTeacher('/v1/capabilities', { method: 'GET' }));
  }
  if (route === '/retrieve-debug' && req.method === 'POST') {
    await requireAdminUser(req, authService);
    await requireAiTeacherAccess(req, authService, { capability: 'retrieve_debug' });
    const payload = await readJson(req);
    return callTeacher('/v1/teacher/retrieve-debug', {
      method: 'POST',
      body: payload
    });
  }
  if (route === '/threads' && req.method === 'GET') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'threads' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher(`/v1/teacher/threads?${teacherQuery(envelope, {
      scope: url.searchParams.get('scope') || 'current',
      limit: url.searchParams.get('limit') || 50
    })}`, { method: 'GET', sanitize: false });
    return projectStudentThreadList(payload);
  }
  if (route === '/threads' && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'threads' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher('/v1/teacher/threads', {
      method: 'POST',
      body: { context: envelope },
      sanitize: false
    });
    return projectStudentThread(payload);
  }
  const threadMatch = route.match(/^\/threads\/([^/]+)$/);
  if (threadMatch && req.method === 'DELETE') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'threads' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher(`/v1/teacher/threads/${encodeURIComponent(threadMatch[1])}?${teacherQuery(envelope)}`, {
      method: 'DELETE',
      sanitize: false
    });
    return {
      deleted: payload?.deleted === true,
      threadId: String(payload?.threadId || '')
    };
  }
  const threadMessagesMatch = route.match(/^\/threads\/([^/]+)\/messages$/);
  if (threadMessagesMatch && req.method === 'GET') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'thread_messages' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher(`/v1/teacher/threads/${encodeURIComponent(threadMessagesMatch[1])}/messages?${teacherQuery(envelope, {
      limit: url.searchParams.get('limit') || 50
    })}`, { method: 'GET', sanitize: false });
    return projectStudentThreadMessages(payload);
  }
  const messageFeedbackMatch = route.match(/^\/messages\/([^/]+)\/feedback$/);
  if (messageFeedbackMatch && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'message_feedback' });
    const payload = await readJson(req);
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    return callTeacher(`/v1/teacher/messages/${encodeURIComponent(messageFeedbackMatch[1])}/feedback`, {
      method: 'POST',
      body: {
        context: envelope,
        outcome: payload.outcome,
        reasonCodes: payload.reasonCodes,
        judgeVersion: payload.judgeVersion,
        judgeLabel: payload.judgeLabel
      }
    });
  }
  const clarificationCancelMatch = route.match(/^\/clarifications\/([^/]+)\/cancel$/);
  if (clarificationCancelMatch && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'answer' });
    const payload = await readJson(req);
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    return callTeacher(`/v1/teacher/clarifications/${encodeURIComponent(clarificationCancelMatch[1])}/cancel`, {
      method: 'POST',
      body: { context: envelope, threadId: String(payload.threadId || '') }
    });
  }
  const runEventsMatch = route.match(/^\/runs\/([^/]+)\/events$/);
  if (runEventsMatch && req.method === 'GET') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'run_events' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const params = new URLSearchParams({
      afterSeq: url.searchParams.get('afterSeq') || '0',
      tenantId: envelope?.tenant?.tenantId || 'local-dev',
      userId: envelope?.tenant?.userId || ''
    });
    const payload = await callTeacher(`/v1/teacher/runs/${encodeURIComponent(runEventsMatch[1])}/events?${params.toString()}`, {
      method: 'GET',
      sanitize: false
    });
    return projectStudentRunEvents(payload);
  }
  const runCancelMatch = route.match(/^\/runs\/([^/]+)\/cancel$/);
  if (runCancelMatch && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'run_cancel' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher(`/v1/teacher/runs/${encodeURIComponent(runCancelMatch[1])}/cancel?${teacherQuery(envelope)}`, {
      method: 'POST',
      sanitize: false
    });
    return projectStudentRunStatus(payload);
  }
  const runMatch = route.match(/^\/runs\/([^/]+)$/);
  if (runMatch && req.method === 'GET') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'run_status' });
    const envelope = await enrichTeacherEnvelope(teacherContextFromQuery(url), courseStore, user);
    const payload = await callTeacher(`/v1/teacher/runs/${encodeURIComponent(runMatch[1])}?${teacherQuery(envelope)}`, {
      method: 'GET',
      sanitize: false
    });
    return projectStudentRunStatus(payload);
  }
  if (route === '/validate-patch' && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'validate_patch' });
    const payload = await readJson(req);
    const envelope = await enrichTeacherEnvelope(payload.context || payload.envelope || payload.hostContext || {}, courseStore, user);
    const teacherResult = await callTeacher('/v1/teacher/validate-patch', {
      method: 'POST',
      body: {
        context: envelope,
        patch: payload.patch
      }
    });
    if (!teacherResult.ok) {
      const error = new Error((teacherResult.errors || []).join('; ') || 'Teacher patch validation failed');
      error.status = 400;
      error.code = teacherResult.code || 'INVALID_PATCH';
      throw error;
    }
    return validateSingleLineTeacherPatch(teacherResult, envelope, courseStore);
  }
  if (route === '/answer' && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'answer' });
    const payload = await readJson(req);
    const envelope = await enrichTeacherEnvelope(payload, courseStore, user);
    const lineageStartedAtMs = Date.now();
    const budgetReservation = await reserveTeacherTokenBudget(authService, user, envelope, 'answer');
    let primarySettled = false;
    try {
      await prepareTeacherDispatch(authService, user, envelope, budgetReservation?.resourcePolicySnapshot);
      const rawResponse = await callTeacher('/v1/teacher/answer', {
        method: 'POST',
        body: envelope,
        sanitize: false
      });
      assertTeacherRuntimePostcondition(rawResponse, envelope);
      const response = projectStudentTeacherResponse(rawResponse);
      const contractResponse = validateTeacherProxyResponse(response, envelope);
      if (!automaticContinuationPending(rawResponse)) {
        await recordTeacherExchange(authService, user, envelope, contractResponse, 'answer', rawResponse, budgetReservation);
        primarySettled = true;
        return contractResponse;
      }

      await recordTeacherExchange(authService, user, envelope, contractResponse, 'answer_auto_source', rawResponse, budgetReservation);
      primarySettled = true;
      let continuationEnvelope = null;
      let continuationReservation = null;
      let continuationStarted = false;
      try {
        continuationEnvelope = automaticContinuationEnvelope(
          envelope,
          rawResponse.continuation.sourceRunId,
          rawResponse.continuation.kind,
          lineageStartedAtMs
        );
        continuationReservation = await reserveTeacherTokenBudget(
          authService,
          user,
          continuationEnvelope,
          'answer_auto_continuation',
          envelope.runtimeAssignment?.resourcePolicySnapshot
        );
        await prepareTeacherDispatch(authService, user, continuationEnvelope, continuationReservation?.resourcePolicySnapshot);
        continuationStarted = true;
        const continuationRaw = await callTeacher('/v1/teacher/answer', {
          method: 'POST',
          body: continuationEnvelope,
          sanitize: false
        });
        assertTeacherRuntimePostcondition(continuationRaw, continuationEnvelope);
        const continuationResponse = validateTeacherProxyResponse(
          projectStudentTeacherResponse(continuationRaw),
          continuationEnvelope
        );
        await recordTeacherExchange(
          authService,
          user,
          continuationEnvelope,
          continuationResponse,
          'answer_auto_continuation',
          continuationRaw,
          continuationReservation
        );
        continuationReservation = null;
        return continuationResponse;
      } catch (error) {
        await releaseTeacherTokenBudget(
          authService,
          user,
          continuationEnvelope,
          'answer_auto_continuation',
          continuationReservation,
          error.code || 'automatic_continuation_failed'
        );
        await recordAutomaticContinuationFailure(authService, user, envelope, rawResponse, error, continuationStarted);
        return validateTeacherProxyResponse(
          projectStudentTeacherResponse(finalizeAutomaticContinuationFallback(rawResponse, error, continuationStarted)),
          envelope
        );
      }
    } catch (error) {
      if (!primarySettled) {
        await releaseTeacherTokenBudget(authService, user, envelope, 'answer', budgetReservation, error.code || 'run_failed');
      }
      throw error;
    }
  }
  if (route === '/answer-stream' && req.method === 'POST') {
    const user = await requireAiTeacherAccess(req, authService, { capability: 'answer_stream' });
    const payload = await readJson(req);
    const envelope = await enrichTeacherEnvelope(payload, courseStore, user);
    const lineageStartedAtMs = Date.now();
    const budgetReservation = await preflightTeacherStreamQuota(authService, user, envelope, 'answer_stream', res);
    if (budgetReservation === STREAM_RESPONSE_HANDLED) return STREAM_RESPONSE_HANDLED;
    let budgetSettled = false;
    let continuationReservation = null;
    let continuationSettled = false;
    let continuationEnvelope = null;
    let continuationStarted = false;
    let continuationSourceRaw = null;
    try {
      await prepareTeacherDispatch(authService, user, envelope, budgetReservation?.resourcePolicySnapshot);
      await callTeacherStream('/v1/teacher/answer-stream', {
        method: 'POST',
        body: envelope,
        keepResponseOpen: true,
        acceptedThreadId: envelope.threadId,
        onStart: async (startEvent) => assertTeacherRuntimePostcondition(startEvent, envelope),
        onFinal: async (rawFinal) => {
          assertTeacherRuntimePostcondition(rawFinal, envelope);
          const response = projectStudentTeacherResponse(rawFinal);
          const contractResponse = validateTeacherProxyResponse(response, envelope);
          if (!automaticContinuationPending(rawFinal)) {
            await recordTeacherExchange(authService, user, envelope, contractResponse, 'answer_stream', rawFinal, budgetReservation);
            budgetSettled = true;
            return { ...contractResponse, type: 'final' };
          }
          await recordTeacherExchange(authService, user, envelope, contractResponse, 'answer_stream_auto_source', rawFinal, budgetReservation);
          budgetSettled = true;
          continuationSourceRaw = rawFinal;
          try {
            continuationEnvelope = automaticContinuationEnvelope(
              envelope,
              rawFinal.continuation.sourceRunId,
              rawFinal.continuation.kind,
              lineageStartedAtMs
            );
            continuationReservation = await reserveTeacherTokenBudget(
              authService,
              user,
              continuationEnvelope,
              'answer_stream_auto_continuation',
              envelope.runtimeAssignment?.resourcePolicySnapshot
            );
            await prepareTeacherDispatch(
              authService,
              user,
              continuationEnvelope,
              continuationReservation?.resourcePolicySnapshot
            );
            continuationStarted = true;
            return {
              type: 'continuation_started',
              kind: rawFinal.continuation.kind,
              message: rawFinal.continuation.kind === ENGINEERING_IMPROVEMENT_CONTINUATION
                ? '已保存并通过官方Validator的基线，正在自动执行工程语义完善。'
                : '首轮达到执行时限，已保存阶段性成果并自动续跑一次。',
              sourceRunId: rawFinal.continuation.sourceRunId
            };
          } catch (error) {
            await releaseTeacherTokenBudget(
              authService,
              user,
              continuationEnvelope,
              'answer_stream_auto_continuation',
              continuationReservation,
              error.code || 'automatic_continuation_admission_failed'
            );
            await recordAutomaticContinuationFailure(authService, user, envelope, rawFinal, error, false);
            continuationReservation = null;
            const fallback = finalizeAutomaticContinuationFallback(rawFinal, error, false);
            const fallbackResponse = validateTeacherProxyResponse(projectStudentTeacherResponse(fallback), envelope);
            return { ...fallbackResponse, type: 'final' };
          }
        }
      }, res, req);

      if (continuationStarted && continuationEnvelope) {
        await callTeacherStream('/v1/teacher/answer-stream', {
          method: 'POST',
          body: continuationEnvelope,
          onStart: async (startEvent) => assertTeacherRuntimePostcondition(startEvent, continuationEnvelope),
          onFinal: async (rawFinal) => {
            assertTeacherRuntimePostcondition(rawFinal, continuationEnvelope);
            const response = validateTeacherProxyResponse(
              projectStudentTeacherResponse(rawFinal),
              continuationEnvelope
            );
            await recordTeacherExchange(
              authService,
              user,
              continuationEnvelope,
              response,
              'answer_stream_auto_continuation',
              rawFinal,
              continuationReservation
            );
            continuationSettled = true;
            return { ...response, type: 'final' };
          },
          onError: async (error) => {
            await recordAutomaticContinuationFailure(
              authService,
              user,
              envelope,
              continuationSourceRaw,
              error,
              true
            );
            const fallback = finalizeAutomaticContinuationFallback(continuationSourceRaw, error, true);
            const response = validateTeacherProxyResponse(projectStudentTeacherResponse(fallback), envelope);
            return { ...response, type: 'final' };
          }
        }, res, req);
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    } finally {
      if (!budgetSettled) {
        await releaseTeacherTokenBudget(authService, user, envelope, 'answer_stream', budgetReservation, 'stream_without_trusted_final');
      }
      if (continuationReservation && !continuationSettled) {
        await releaseTeacherTokenBudget(
          authService,
          user,
          continuationEnvelope || envelope,
          'answer_stream_auto_continuation',
          continuationReservation,
          'automatic_continuation_without_trusted_final'
        );
      }
    }
    return STREAM_RESPONSE_HANDLED;
  }
  const error = new Error('Teacher route not found');
  error.status = 404;
  throw error;
}

function teacherContextFromQuery(url) {
  return {
    course: {
      coursePackId: url.searchParams.get('coursePackId') || url.searchParams.get('packId') || '',
      courseId: url.searchParams.get('courseId') || '',
      lessonId: url.searchParams.get('lessonId') || ''
    }
  };
}

function teacherQuery(envelope, extra = {}) {
  const params = new URLSearchParams();
  params.set('tenantId', envelope?.tenant?.tenantId || 'local-dev');
  params.set('userId', envelope?.tenant?.userId || '');
  params.set('coursePackId', envelope?.course?.coursePackId || '');
  params.set('courseId', envelope?.course?.courseId || '');
  params.set('lessonId', envelope?.course?.lessonId || '');
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  }
  return params.toString();
}

async function prepareTeacherDispatch(authService, user, envelope, trustedResourcePolicySnapshot = null) {
  const accountStore = authService.betterAuth?.accountStore;
  const resourcePolicySnapshot = trustedResourcePolicySnapshot || await loadActiveAgentResourcePolicySnapshot(accountStore);
  const requested = {
    threadId: envelope.threadId || '',
    userId: user.id,
    tenantId: envelope.tenant?.tenantId || 'local-dev',
    lessonId: envelope.course?.lessonId || null,
    title: envelope.course?.lessonTitle || 'AI 教师对话',
    policyVersion: resourcePolicySnapshot.versionId
  };
  const assignment = accountStore?.ensureAiTeacherRuntimeAssignment
    ? await accountStore.ensureAiTeacherRuntimeAssignment(requested)
    : {
      threadId: requested.threadId || `thread_${crypto.randomUUID()}`,
      runtimeAssignmentId: `assign_${crypto.randomUUID()}`,
      runtime: 'ai-sdk',
      policyVersion: requested.policyVersion,
      bucket: 0,
      assignedAt: new Date().toISOString(),
      overrideReason: ''
    };
  envelope.threadId = assignment.threadId;
  envelope.runtimeAssignment = {
    runtimeAssignmentId: assignment.runtimeAssignmentId,
    runtime: 'ai-sdk',
    // Phase2以后所有新Run统一进入V2；不得依据学生文本动态选择旧工作流。
    workflowVersion: 'intent-orchestrator-v2',
    policyVersion: assignment.policyVersion,
    bucket: Number(assignment.bucket || 0),
    assignedAt: assignment.assignedAt,
    overrideReason: assignment.overrideReason || ''
  };
  envelope.runtimeAssignment.resourcePolicySnapshot = resourcePolicySnapshot;
  const capabilities = await callTeacher('/v1/capabilities', { method: 'GET' });
  const supported = Array.isArray(capabilities.supportedRuntimes)
    && capabilities.supportedRuntimes.length === 1
    && capabilities.supportedRuntimes[0] === 'ai-sdk';
  const ready = capabilities.runtimeReadiness?.['ai-sdk'] === true || capabilities.agentRuntime?.ready === true;
  const schemaMatches = capabilities.toolSchemaVersion === AI_TEACHER_TOOL_SCHEMA_VERSION;
  const activeBundle = capabilities.retrieval?.activeBundle;
  const activeBundleRequired = envFlag(process.env.AI_TEACHER_REQUIRE_ACTIVE_BUNDLE, true);
  const persistentKnowledgeStorageReady = capabilities.retrieval?.mode === 'postgres_pgvector'
    && (capabilities.retrieval?.ready === true
      || (!activeBundleRequired
        && capabilities.retrieval?.error === 'ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED'));
  const activeBundleReady = !activeBundleRequired
    || (/^sha256:[a-f0-9]{64}$/.test(String(activeBundle?.sourceRegistryHash || ''))
      && /^sha256:[a-f0-9]{64}$/.test(String(activeBundle?.contentHash || '')));
  const knowledgeReady = persistentKnowledgeStorageReady && activeBundleReady;
  if (!supported || !ready || !schemaMatches || !capabilities.buildVersion || !knowledgeReady) {
    const error = new Error('AI Teacher agent runtime preflight failed.');
    error.status = 503;
    error.code = 'AI_TEACHER_AGENT_PREFLIGHT_FAILED';
    error.details = {
      supported,
      ready,
      schemaMatches,
      knowledgeReady,
      expectedToolSchemaVersion: AI_TEACHER_TOOL_SCHEMA_VERSION
    };
    throw error;
  }
  envelope.runtimeAssignment.toolSchemaVersion = capabilities.toolSchemaVersion;
  envelope.runtimeAssignment.buildVersion = capabilities.buildVersion;
  return envelope.runtimeAssignment;
}

function assertTeacherRuntimePostcondition(value, envelope) {
  const source = value?.data && typeof value.data === 'object' ? value.data : value;
  const expected = envelope.runtimeAssignment;
  const actualWorkflowVersion = source?.workflowVersion;
  if (source?.runtimeUsed !== 'ai-sdk'
    || source?.runtimeAssignmentId !== expected.runtimeAssignmentId
    || actualWorkflowVersion !== expected.workflowVersion
    || source?.toolSchemaVersion !== expected.toolSchemaVersion
    || source?.buildVersion !== expected.buildVersion
    || source?.resourcePolicyVersion !== expected.resourcePolicySnapshot?.versionId
    || source?.resourcePolicyChecksum !== expected.resourcePolicySnapshot?.checksum) {
    const error = new Error('AI Teacher runtime postcondition mismatch.');
    error.status = 503;
    error.code = 'AI_TEACHER_RUNTIME_POSTCONDITION_MISMATCH';
    throw error;
  }
  return value;
}

async function requireAiTeacherAccess(req, authService, context = {}) {
  const user = await authService.currentUser(req);
  const lessonId = context.lessonId || null;
  if (!user) {
    await recordAiAccess(authService, {
      userId: null,
      decision: 'deny',
      entitlementCode: 'ai.teacher.use',
      reason: 'auth_required',
      lessonId
    });
    const error = new Error('请先登录。');
    error.statusCode = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  if (!authService.hasEntitlement(user, 'ai.teacher.use')) {
    await recordAiAccess(authService, {
      userId: user.id,
      decision: 'deny',
      entitlementCode: 'ai.teacher.use',
      reason: 'missing_entitlement',
      lessonId
    });
    const error = new Error('当前账号无权使用该功能。');
    error.statusCode = 403;
    error.code = 'PERMISSION_DENIED';
    throw error;
  }
  await recordAiAccess(authService, {
    userId: user.id,
    decision: 'allow',
    entitlementCode: 'ai.teacher.use',
    reason: context.capability || 'entitlement_present',
    lessonId
  });
  return user;
}

async function requireAdminUser(req, authService) {
  return authService.requireEntitlement(req, 'admin.console.access');
}

function assertAdminSecretMutationOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return;
  const allowed = new Set([
    CORS_ORIGIN,
    ...String(process.env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')
  ].map((value) => String(value || '').trim()).filter(Boolean));
  if (!allowed.has(origin)) {
    const error = new Error('Secret mutation origin is not trusted.');
    error.statusCode = 403;
    error.code = 'ADMIN_SECRET_MUTATION_ORIGIN_REJECTED';
    throw error;
  }
}

function assertManagedCredentialConfirmation(confirmation, credentialName) {
  if (confirmation?.confirmed === true && String(confirmation?.credentialName || '') === String(credentialName || '')) return;
  const error = new Error('Managed credential write requires an explicit credential-name confirmation.');
  error.statusCode = 400;
  error.code = 'LITELLM_CREDENTIAL_CONFIRMATION_REQUIRED';
  throw error;
}

async function managedCredentialLiveReferences(accountStore, credentialName) {
  const versions = await accountStore.listLiteLlmConfigVersions({ limit: 100, includeRenderedYaml: false });
  return versions
    .filter((version) => version.status === 'active' || version.status === 'draft')
    .flatMap((version) => (version.config?.providerConnections || [])
      .filter((connection) => connection.credentialRef?.kind === 'litellm_credential'
        && connection.credentialRef?.referenceName === credentialName)
      .map((connection) => ({
        versionId: version.versionId,
        status: version.status,
        connectionId: connection.connectionId
      })))
    .slice(0, 100);
}

function requireAdminAccountStore(authService) {
  const accountStore = authService.betterAuth?.accountStore;
  if (!accountStore) {
    const error = new Error('Account store is not available.');
    error.statusCode = 503;
    error.code = 'ACCOUNT_STORE_UNAVAILABLE';
    throw error;
  }
  return accountStore;
}

async function probeSysONHealth({ serviceUrl = '' } = {}) {
  const configured = String(serviceUrl || '').trim();
  if (!configured) {
    return { status: 'not_configured', checkedAt: new Date().toISOString(), latencyMs: null, errorCode: 'SYSON_VIEW_SERVICE_NOT_CONFIGURED' };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL('/health', configured), {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    return {
      status: response.ok ? 'healthy' : 'unavailable',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorCode: response.ok ? '' : `SYSON_HEALTH_HTTP_${response.status}`
    };
  } catch (error) {
    return {
      status: 'unavailable',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorCode: error?.name === 'TimeoutError' ? 'SYSON_HEALTH_TIMEOUT' : 'SYSON_HEALTH_UNREACHABLE'
    };
  }
}

function projectPublicTeacherHealth(value) {
  return { ok: value?.ok === true };
}

function projectPublicTeacherCapabilities(value) {
  return {
    available: value?.runtimeReadiness?.['ai-sdk'] === true || value?.agentRuntime?.ready === true
  };
}

async function agentResourcePolicyAdminState(accountStore) {
  const desired = await accountStore.getActiveAgentResourcePolicyVersion();
  let observed = null;
  try {
    observed = await callTeacher('/v1/admin/resource-policy/state', { method: 'GET' });
  } catch (error) {
    observed = {
      status: 'unavailable',
      errorCode: error.code || 'AGENT_RESOURCE_POLICY_OWNER_UNAVAILABLE'
    };
  }
  return {
    desired,
    observed,
    inSync: Boolean(desired && observed?.versionId === desired.versionId && observed?.checksum === desired.checksum),
    diff: desired && observed?.values
      ? diffAgentResourcePolicyValues(observed.values, desired.values)
      : []
  };
}

async function activeAiTeacherModelRegistry(accountStore) {
  const activeLiteLlmVersion = await accountStore.getActiveLiteLlmConfigVersion({ includeRenderedYaml: false });
  return modelRegistryFromLiteLlmVersion(activeLiteLlmVersion || {});
}

async function agentResourcePolicyAliasAdvisory(accountStore, liteLlmVersion) {
  try {
    const activePolicy = await accountStore.getActiveAgentResourcePolicyVersion();
    if (!activePolicy?.values) {
      return { status: 'not_configured', required: false, policyVersionId: '', missingAliases: [], references: [] };
    }
    const modelRegistry = modelRegistryFromLiteLlmVersion(liteLlmVersion || {});
    const registeredAliases = new Set(modelRegistry.aliases || []);
    const references = AGENT_RESOURCE_POLICY_DEFINITIONS
      .filter((definition) => definition.valueType === 'model-ref')
      .map((definition) => ({ key: definition.key, alias: String(activePolicy.values[definition.key] || '').trim() }))
      .filter((reference) => reference.alias && !registeredAliases.has(reference.alias));
    return {
      status: references.length ? 'migration_required' : 'ready',
      required: references.length > 0,
      policyVersionId: activePolicy.versionId,
      missingAliases: [...new Set(references.map((reference) => reference.alias))].sort(),
      references
    };
  } catch {
    return { status: 'unavailable', required: false, policyVersionId: '', missingAliases: [], references: [] };
  }
}

function resourcePolicySnapshotFromVersion(version) {
  if (!version?.versionId || !version?.values) throwAgentResourcePolicyPublishInvalid(version?.validation);
  const snapshot = createAgentResourcePolicySnapshot({ versionId: version.versionId, values: version.values });
  if (version.checksum && version.checksum !== snapshot.checksum) {
    const error = new Error('Agent resource policy version checksum does not match its values.');
    error.statusCode = 409;
    error.code = 'AGENT_RESOURCE_POLICY_CHECKSUM_MISMATCH';
    throw error;
  }
  return snapshot;
}

async function loadActiveAgentResourcePolicySnapshot(accountStore) {
  const activeResourcePolicy = accountStore?.getActiveAgentResourcePolicyVersion
    ? await accountStore.getActiveAgentResourcePolicyVersion()
    : null;
  return activeResourcePolicy
    ? resourcePolicySnapshotFromVersion(activeResourcePolicy)
    : AGENT_RESOURCE_POLICY_BOOTSTRAP_SNAPSHOT;
}

function throwAgentResourcePolicyPublishInvalid(validation) {
  const error = new Error('Agent resource policy must pass deterministic validation before publication.');
  error.statusCode = 400;
  error.code = 'AGENT_RESOURCE_POLICY_INVALID';
  error.details = validation || {};
  throw error;
}

function throwAgentResourcePolicyOwnerFailed(code, details) {
  const error = new Error('Agent resource policy runtime owner rejected the version.');
  error.statusCode = 503;
  error.code = code;
  error.details = details || {};
  throw error;
}

function agentResourcePolicyProjectionFromContext(context) {
  const snapshot = context?.runtimeAssignment?.resourcePolicySnapshot;
  if (!snapshot) return AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION;
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) {
    const error = new Error('Trusted Agent resource policy snapshot is invalid.');
    error.statusCode = 400;
    error.code = 'AGENT_RESOURCE_POLICY_SNAPSHOT_INVALID';
    error.details = validation;
    throw error;
  }
  return agentResourcePolicyRuntimeProjection(validation.values);
}

async function aiTeacherAdminRuntime(features) {
  const teacher = await safeTeacherHealth();
  const provider = teacher.body?.provider || {};
  const liteLlmBaseUrl = publicBaseUrl(process.env.LITELLM_BASE_URL || process.env.AI_TEACHER_BASE_URL || '');
  return {
    enabled: Boolean(features.aiTeacherEnabled),
    teacher: {
      url: TEACHER_URL,
      status: teacher.ok ? 'healthy' : 'unavailable',
      error: teacher.ok ? '' : teacher.error,
      provider
    },
    gateway: provider.gateway || 'unknown',
    providerMode: provider.mode || 'unknown',
    modelGroup: process.env.AI_TEACHER_MODEL || '',
    litellm: {
      configured: provider.gateway === 'litellm' || /litellm/i.test(process.env.AI_TEACHER_PROVIDER || ''),
      baseUrl: liteLlmBaseUrl,
      status: provider.gateway === 'litellm' && teacher.ok ? 'healthy' : provider.gateway === 'litellm' ? 'unknown' : 'not_configured'
    },
    limits: {
      teacherTimeoutMs: DEFAULT_TEACHER_TIMEOUT_MS
    }
  };
}

async function aiTeacherLiteLlmHealth(activeVersion) {
  const baseUrl = process.env.LITELLM_ADMIN_BASE_URL || process.env.LITELLM_BASE_URL || '';
  const publicUrl = publicBaseUrl(baseUrl);
  const result = {
    checkedAt: new Date().toISOString(),
    configured: Boolean(baseUrl),
    baseUrl: publicUrl,
    status: baseUrl ? 'unknown' : 'not_configured',
    secrets: activeVersion ? await liteLlmConfigSecretStatuses(activeVersion) : [],
    activeVersion: activeVersion ? {
      versionId: activeVersion.versionId,
      checksum: activeVersion.checksum,
      validation: activeVersion.validation
    } : null
  };
  if (!baseUrl) return result;
  const healthPath = process.env.LITELLM_ADMIN_HEALTH_PATH || '/health/liveliness';
  try {
    const response = await fetch(new URL(healthPath, baseUrl), {
      method: 'GET',
      headers: litellmAdminHeaders(false)
    });
    result.status = response.ok ? 'healthy' : 'unavailable';
    result.httpStatus = response.status;
  } catch (error) {
    result.status = 'unavailable';
    result.error = error.message || 'LiteLLM health check failed.';
  }
  return result;
}

async function aiTeacherLiteLlmUsageSummary() {
  const baseUrl = process.env.LITELLM_ADMIN_BASE_URL || process.env.LITELLM_BASE_URL || '';
  const usagePath = process.env.LITELLM_ADMIN_USAGE_PATH || '/spend/logs';
  const result = {
    configured: Boolean(baseUrl),
    baseUrl: publicBaseUrl(baseUrl),
    status: baseUrl ? 'unknown' : 'not_configured',
    source: 'litellm',
    path: usagePath,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    spend: 0,
    currency: 'USD',
    rawAvailable: false
  };
  if (!baseUrl) return result;
  try {
    const response = await fetch(new URL(usagePath, baseUrl), {
      method: 'GET',
      headers: litellmAdminHeaders(false)
    });
    const payload = await response.json().catch(() => ({}));
    result.httpStatus = response.status;
    result.rawAvailable = Boolean(payload && typeof payload === 'object');
    if (!response.ok) {
      result.status = 'unavailable';
      result.error = payload?.error || payload?.detail || `LiteLLM usage request failed with ${response.status}.`;
      return result;
    }
    const parsed = parseLiteLlmUsagePayload(payload);
    result.status = 'available';
    result.totalTokens = parsed.totalTokens;
    result.promptTokens = parsed.promptTokens;
    result.completionTokens = parsed.completionTokens;
    result.spend = parsed.spend;
    result.currency = parsed.currency || result.currency;
    result.window = parsed.window || null;
  } catch (error) {
    result.status = 'unavailable';
    result.error = error.message || 'LiteLLM usage summary request failed.';
  }
  return result;
}

async function validateLiteLlmPublishPreflight(version = {}) {
  const validation = validateLiteLlmConfig(version.config || {});
  if (!validation.ok) throwLiteLlmPublishGateFailed('LITELLM_CONFIG_INVALID', 'LiteLLM config validation failed.', { validation });
  const secrets = await liteLlmConfigSecretStatuses(version);
  const missing = secrets.filter((item) => item.required && !item.present);
  if (missing.length) {
    throwLiteLlmPublishGateFailed('LITELLM_SECRET_ENV_MISSING', 'LiteLLM config references missing environment secrets.', {
      validation,
      secrets
    });
  }
  if (!process.env.LITELLM_ADMIN_BASE_URL || !process.env.LITELLM_MASTER_KEY) {
    throwLiteLlmPublishGateFailed('LITELLM_ADMIN_APPLY_NOT_CONFIGURED', 'LiteLLM admin base URL and master key are required before publishing a live config.', {
      validation,
      secrets
    });
  }
  return {
    ok: true,
    validation,
    secrets
  };
}

async function capabilityProbeEvidenceForVersion(accountStore, version = {}) {
  if (Number(version.config?.schemaVersion || 1) < 2) {
    return {
      versionId: version.versionId || '',
      configChecksum: version.checksum || '',
      required: false,
      ready: true,
      enabledDeploymentCount: 0,
      readyDeploymentCount: 0,
      budget: publicCapabilityProbeLimits(),
      deployments: []
    };
  }
  const deployments = [];
  for (const deployment of version.config.modelDeployments || []) {
    const descriptor = deploymentProbeDescriptor(version.config, deployment.deploymentId);
    const latestRun = await accountStore.findLatestLiteLlmCapabilityProbeRun({
      deploymentId: deployment.deploymentId,
      sourceDigest: descriptor.sourceDigest
    });
    const declaredKeys = CAPABILITY_PROBE_KEYS.filter((key) => descriptor.declaredCapabilities[key]);
    const passedCount = declaredKeys.filter((key) => latestRun?.results?.[key]?.status === 'passed').length;
    const ready = deployment.enabled !== false && latestRun?.status === 'passed';
    deployments.push({
      deploymentId: deployment.deploymentId,
      displayName: deployment.displayName,
      providerModelId: deployment.providerModelId,
      enabled: deployment.enabled !== false,
      sourceDigest: descriptor.sourceDigest,
      status: deployment.enabled === false ? 'disabled' : latestRun?.status || 'unverified',
      readiness: deployment.enabled === false ? 'disabled' : latestRun?.readiness || 'capability_unverified',
      ready,
      declaredCount: declaredKeys.length,
      passedCount,
      baseProbe: latestRun?.baseProbe || null,
      results: latestRun?.results || {},
      latestRun
    });
  }
  const enabled = deployments.filter((item) => item.enabled);
  return {
    versionId: version.versionId || '',
    configChecksum: version.checksum || '',
    required: true,
    ready: enabled.length > 0 && enabled.every((item) => item.ready),
    enabledDeploymentCount: enabled.length,
    readyDeploymentCount: enabled.filter((item) => item.ready).length,
    budget: publicCapabilityProbeLimits(),
    deployments
  };
}

function normalizeCapabilityProbeRun(rawRun = {}, descriptor = {}) {
  const status = ['passed', 'failed', 'blocked', 'inconclusive'].includes(rawRun.status) ? rawRun.status : 'inconclusive';
  const startedAt = rawRun.startedAt || new Date().toISOString();
  const completedAt = rawRun.completedAt || new Date().toISOString();
  const results = Object.fromEntries(CAPABILITY_PROBE_KEYS.map((key) => {
    const result = rawRun.results?.[key] || {};
    return [key, {
      status: ['passed', 'failed', 'blocked', 'inconclusive', 'not_declared', 'not_run'].includes(result.status) ? result.status : 'inconclusive',
      errorCode: String(result.errorCode || ''),
      httpStatus: Number(result.httpStatus || 0),
      durationMs: Math.max(0, Number(result.durationMs || 0)),
      responseDigest: String(result.responseDigest || '')
    }];
  }));
  const baseProbe = {
    id: 'minimal_generation',
    status: ['passed', 'failed', 'blocked', 'inconclusive'].includes(rawRun.baseProbe?.status) ? rawRun.baseProbe.status : 'inconclusive',
    errorCode: String(rawRun.baseProbe?.errorCode || ''),
    httpStatus: Number(rawRun.baseProbe?.httpStatus || 0),
    durationMs: Math.max(0, Number(rawRun.baseProbe?.durationMs || 0)),
    responseDigest: String(rawRun.baseProbe?.responseDigest || '')
  };
  const usage = {
    providerCalls: Math.max(0, Number(rawRun.usage?.providerCalls || 0)),
    promptTokens: Math.max(0, Number(rawRun.usage?.promptTokens || 0)),
    completionTokens: Math.max(0, Number(rawRun.usage?.completionTokens || 0)),
    reasoningTokens: Math.max(0, Number(rawRun.usage?.reasoningTokens || 0)),
    totalTokens: Math.max(0, Number(rawRun.usage?.totalTokens || 0))
  };
  const evidence = {
    deploymentId: descriptor.deployment.deploymentId,
    sourceDigest: descriptor.sourceDigest,
    status,
    baseProbe,
    results,
    usage
  };
  return {
    status,
    readiness: status === 'passed' ? 'ready' : status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : 'capability_unverified',
    startedAt,
    completedAt,
    durationMs: Math.max(0, Number(rawRun.durationMs || 0)),
    deploymentId: descriptor.deployment.deploymentId,
    sourceDigest: descriptor.sourceDigest,
    declaredCapabilities: descriptor.declaredCapabilities,
    baseProbe,
    results,
    budget: publicCapabilityProbeLimits(),
    usage,
    errorCode: String(rawRun.errorCode || ''),
    evidenceDigest: crypto.createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex')
  };
}

function assertLiteLlmCapabilityPublishGate(version = {}, evidence = {}) {
  if (Number(version.config?.schemaVersion || 1) < 2) return;
  if (!evidence.ready) {
    throwLiteLlmPublishGateFailed(
      'LITELLM_CAPABILITY_PROBE_REQUIRED',
      'Every enabled Model Deployment requires matching passed Capability Probe evidence before publication.',
      { capabilityEvidence: evidence }
    );
  }
}

async function liteLlmConfigSecretStatuses(version = {}) {
  const refs = new Map();
  const config = version.config || {};
  for (const connection of config.providerConnections || []) {
    const referenceName = connection.credentialRef?.referenceName;
    if (referenceName) refs.set(referenceName, { kind: connection.credentialRef?.kind || 'environment', role: 'api_key', required: connection.enabled !== false });
  }
  for (const group of config.modelGroups || []) {
    for (const deployment of group.deployments || []) {
      if (deployment.apiKeyRef || deployment.apiKeyEnv) refs.set(deployment.apiKeyRef || deployment.apiKeyEnv, { kind: 'environment', role: 'api_key', required: true });
      if (deployment.litellmCredentialName) refs.set(deployment.litellmCredentialName, { kind: 'litellm_credential', role: 'api_key', required: true });
      if (deployment.apiBaseEnv) refs.set(deployment.apiBaseEnv, { kind: 'environment', role: 'api_base', required: false });
    }
  }
  if (config.general?.masterKeyEnv) refs.set(config.general.masterKeyEnv, { kind: 'environment', role: 'master_key', required: true });
  if (config.general?.databaseUrlEnv) refs.set(config.general.databaseUrlEnv, { kind: 'environment', role: 'database_url', required: false });
  let managedNames = new Set();
  if ([...refs.values()].some((item) => item.kind === 'litellm_credential')) {
    try {
      managedNames = new Set((await listManagedCredentials()).map((item) => item.credentialName));
    } catch {
      managedNames = new Set();
    }
  }
  return [...refs.entries()].map(([referenceName, meta]) => {
    const managed = meta.kind === 'litellm_credential';
    return {
      envName: managed ? '' : referenceName,
      referenceName,
      kind: meta.kind,
      role: meta.role,
      required: meta.required,
      present: managed ? managedNames.has(referenceName) : Boolean(process.env[referenceName])
    };
  });
}

async function applyLiteLlmConfigVersion(version = {}) {
  const baseUrl = process.env.LITELLM_ADMIN_BASE_URL || '';
  const masterKey = process.env.LITELLM_MASTER_KEY || '';
  const applyPath = process.env.LITELLM_ADMIN_APPLY_PATH || '/config/update';
  const result = {
    applied: false,
    status: 'skipped',
    mode: 'litellm-admin-api',
    baseUrl: publicBaseUrl(baseUrl),
    path: applyPath,
    message: ''
  };
  if (!baseUrl || !masterKey) {
    result.message = 'LiteLLM admin apply is not configured; publish preflight should block live activation before this step.';
    return result;
  }
  try {
    const response = await fetch(new URL(applyPath, baseUrl), {
      method: 'POST',
      headers: litellmAdminHeaders(true),
      body: JSON.stringify({
        versionId: version.versionId,
        checksum: version.checksum,
        config: version.config,
        renderedYaml: version.renderedYaml,
        config_yaml: version.renderedYaml
      })
    });
    const payload = await response.json().catch(() => ({}));
    result.httpStatus = response.status;
    result.response = publicLiteLlmAdminResponse(payload);
    if (response.ok) {
      result.applied = true;
      result.status = 'applied';
      result.message = 'LiteLLM admin apply request accepted.';
    } else {
      result.status = 'failed';
      result.message = payload?.error || payload?.detail || `LiteLLM admin apply failed with ${response.status}.`;
    }
  } catch (error) {
    result.status = 'failed';
    result.message = error.message || 'LiteLLM admin apply failed.';
  }
  return result;
}

function parseLiteLlmUsagePayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.logs) ? payload.logs
        : Array.isArray(payload?.spend_logs) ? payload.spend_logs
          : [];
  const seed = {
    totalTokens: numeric(payload?.total_tokens ?? payload?.totalTokens ?? payload?.tokens),
    promptTokens: numeric(payload?.prompt_tokens ?? payload?.promptTokens),
    completionTokens: numeric(payload?.completion_tokens ?? payload?.completionTokens),
    spend: numeric(payload?.spend ?? payload?.total_spend ?? payload?.totalSpend),
    currency: payload?.currency || 'USD',
    window: payload?.window || null
  };
  for (const row of rows) {
    seed.promptTokens += numeric(row?.prompt_tokens ?? row?.promptTokens ?? row?.input_tokens ?? row?.inputTokens);
    seed.completionTokens += numeric(row?.completion_tokens ?? row?.completionTokens ?? row?.output_tokens ?? row?.outputTokens);
    seed.totalTokens += numeric(row?.total_tokens ?? row?.totalTokens ?? row?.tokens);
    seed.spend += numeric(row?.spend ?? row?.cost ?? row?.total_spend ?? row?.totalSpend);
  }
  if (!seed.totalTokens) seed.totalTokens = seed.promptTokens + seed.completionTokens;
  return seed;
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function throwLiteLlmPublishGateFailed(code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = code === 'LITELLM_CAPABILITY_PROBE_REQUIRED'
    ? 409
    : code === 'LITELLM_CONFIG_INVALID' || code === 'LITELLM_SECRET_ENV_MISSING' ? 400 : 503;
  error.code = code;
  error.details = details;
  throw error;
}

function litellmAdminHeaders(includeJson) {
  const headers = { accept: 'application/json' };
  if (includeJson) headers['content-type'] = 'application/json';
  if (process.env.LITELLM_MASTER_KEY) headers.authorization = `Bearer ${process.env.LITELLM_MASTER_KEY}`;
  return headers;
}

function publicLiteLlmAdminResponse(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return JSON.parse(JSON.stringify(payload, (key, value) => {
    if (/key|token|secret|password/i.test(key)) return '[redacted]';
    if (typeof value === 'string' && /sk-[A-Za-z0-9_-]{8,}/.test(value)) return '[redacted]';
    return value;
  }));
}

async function safeTeacherHealth() {
  try {
    return { ok: true, body: await callTeacher('/health', { method: 'GET' }) };
  } catch (error) {
    return { ok: false, body: null, error: error.message || 'Teacher unavailable' };
  }
}

function publicBaseUrl(value = '') {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).replace(/\/\/[^/@]+@/, '//***@');
  }
}

function publicAiTeacherQuotaEvent(event = {}) {
  return {
    id: event.id,
    userId: event.userId,
    tenantId: event.tenantId,
    requestId: event.requestId,
    capability: event.capability,
    decision: event.decision,
    reason: event.reason,
    dailyUsedTokens: event.dailyUsedTokens,
    weeklyUsedTokens: event.weeklyUsedTokens,
    dailyLimitTokens: event.dailyLimitTokens,
    weeklyLimitTokens: event.weeklyLimitTokens,
    metadata: event.metadata || {},
    createdAt: event.createdAt
  };
}

function parseAdminUserPath(pathname) {
  const prefix = '/api/admin/users/';
  if (!pathname.startsWith(prefix)) return { userId: '', action: '' };
  const rest = pathname.slice(prefix.length);
  const parts = rest.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  return {
    userId: parts[0] || '',
    action: parts.slice(1).join('/')
  };
}

function requestIdFrom(req) {
  return req?.headers?.['x-request-id'] || req?.headers?.['X-Request-Id'] || null;
}

async function recordAiAccess(authService, event) {
  await authService.betterAuth?.accountStore?.recordAiAccessEvent(event);
}

async function reserveTeacherTokenBudget(authService, user, envelope, capability, trustedResourcePolicySnapshot = null) {
  const accountStore = authService.betterAuth?.accountStore;
  const reserveBudget = accountStore?.reserveAiTeacherBudget;
  if (!reserveBudget) return null;
  const resourcePolicySnapshot = trustedResourcePolicySnapshot
    || await loadActiveAgentResourcePolicySnapshot(accountStore);
  const resourcePolicy = agentResourcePolicyRuntimeProjection(resourcePolicySnapshot.values);
  const estimatedInputTokens = estimateTeacherRequestTokens(envelope);
  const estimatedOutputTokens = resourcePolicy.teacher.agentMediumAnswerMaxOutputTokens;
  const decision = await reserveBudget.call(accountStore, {
    user,
    envelope,
    capability,
    requestId: envelope.requestId || null,
    tenantId: envelope.tenant?.tenantId || '',
    estimatedTokens: estimatedInputTokens + estimatedOutputTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
    resourcePolicyVersion: resourcePolicySnapshot.versionId
  });
  if (decision?.allowed !== false) {
    return {
      ...decision,
      resourcePolicySnapshot,
      estimate: { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens }
    };
  }
  const error = new Error(decision.message || 'AI Teacher token quota exceeded.');
  error.status = decision.status || 429;
  error.code = decision.code || 'AI_TEACHER_QUOTA_EXCEEDED';
  throw error;
}

async function preflightTeacherStreamQuota(authService, user, envelope, capability, res) {
  try {
    return await reserveTeacherTokenBudget(authService, user, envelope, capability);
  } catch (error) {
    if (!['AI_TEACHER_QUOTA_EXCEEDED', 'AI_TEACHER_POLICY_DENIED', 'AI_TEACHER_REQUEST_DUPLICATE'].includes(error.code)) throw error;
    writeTeacherStreamError(res, error.status || 429, error.code, error.message);
    return STREAM_RESPONSE_HANDLED;
  }
}

function writeTeacherStreamError(res, status, code, message) {
  res.writeHead(status, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-credentials': 'true',
    'cache-control': 'no-store'
  });
  res.write(`${JSON.stringify({ type: 'error', code, message, status })}\n`);
  res.end();
}

async function recordTeacherExchange(authService, user, envelope, response, capability, rawResponse = response, budgetReservation = null) {
  const directAnswer = response?.directAnswer || response?.title || '';
  const usage = extractTeacherTokenUsage(rawResponse, envelope, directAnswer);
  await authService.betterAuth?.accountStore?.recordAiExchange({
    userId: user.id,
    tenantId: envelope.tenant?.tenantId || '',
    threadId: response?.threadId || envelope.threadId || null,
    lessonId: envelope.course?.lessonId || envelope.lessonId || null,
    requestId: envelope.requestId || null,
    capability,
    prompt: envelope.question?.text || '',
    reply: directAnswer,
    model: response?.model || response?.modelId || null,
    tokenUsage: usage.meteredUsage,
    providerTokenUsage: usage.providerUsage,
    usageSource: usage.usageSource,
    entitlementCode: 'ai.teacher.use',
    budgetReservationId: budgetReservation?.reservationId || null
  });
}

function extractTeacherTokenUsage(response, envelope, directAnswer = '') {
  const providerUsage = response?.tokenUsage || response?.usage || null;
  if (providerUsage && typeof providerUsage === 'object') {
    return {
      meteredUsage: providerUsage,
      providerUsage,
      usageSource: providerUsage.usageSource || providerUsage.usage_source || 'provider'
    };
  }
  return {
    meteredUsage: estimateTokenUsage(envelope.question?.text, directAnswer),
    providerUsage: {},
    usageSource: 'estimated'
  };
}

function estimateTeacherRequestTokens(envelope = {}) {
  const parts = [
    envelope.question?.text,
    envelope.prompt,
    envelope.message,
    envelope.course?.lessonTitle,
    ...(Array.isArray(envelope.editor?.files) ? envelope.editor.files.map((file) => file.content || '') : []),
    ...(Array.isArray(envelope.diagnostics?.officialValidator) ? envelope.diagnostics.officialValidator.map((item) => item.message || '') : []),
    ...(Array.isArray(envelope.diagnostics?.courseRules) ? envelope.diagnostics.courseRules.map((item) => item.message || '') : [])
  ];
  return Math.max(1, estimateTokens(parts.filter(Boolean).join('\n')));
}

function automaticContinuationPending(response) {
  const kind = automaticContinuationKind(response?.continuation?.kind);
  return response?.continuation?.status === 'automatic_pending'
    && response?.continuation?.autoContinuationUsed === false
    && [EXECUTION_COMPLETION_CONTINUATION, ENGINEERING_IMPROVEMENT_CONTINUATION].includes(kind)
    && /^run_[a-zA-Z0-9-]{8,160}$/.test(String(response?.continuation?.sourceRunId || ''));
}

function automaticContinuationEnvelope(envelope, sourceRunId, requestedKind, lineageStartedAtMs) {
  const next = JSON.parse(JSON.stringify(envelope || {}));
  const continuationKind = automaticContinuationKind(requestedKind);
  const baseRequestId = String(envelope?.requestId || `request-${Date.now()}`).slice(0, 160);
  next.requestId = `${baseRequestId}:auto-1`;
  next.automaticContinuationSourceRunId = String(sourceRunId || '');
  next.automaticContinuationKind = continuationKind;
  if (continuationKind === ENGINEERING_IMPROVEMENT_CONTINUATION) {
    next.automaticContinuationBudget = engineeringImprovementBudget(
      envelope?.runtimeAssignment?.resourcePolicySnapshot,
      lineageStartedAtMs
    );
  }
  delete next.clarificationCheckpointId;
  delete next.manualContinuationSourceRunId;
  delete next.runtimeAssignment;
  return next;
}

function automaticContinuationKind(value) {
  return value === ENGINEERING_IMPROVEMENT_CONTINUATION
    ? ENGINEERING_IMPROVEMENT_CONTINUATION
    : EXECUTION_COMPLETION_CONTINUATION;
}

function engineeringImprovementBudget(snapshot, lineageStartedAtMs) {
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) {
    const error = new Error('Trusted Agent resource policy snapshot is invalid.');
    error.status = 400;
    error.code = 'AGENT_RESOURCE_POLICY_SNAPSHOT_INVALID';
    throw error;
  }
  const values = validation.values;
  const runMaxDurationMs = Number(values['engineeringImprovement.runMaxDurationMs']);
  const lineageMaxDurationMs = Number(values['engineeringImprovement.lineageMaxDurationMs']);
  const orchestrationReserveMs = Number(values['engineeringImprovement.orchestrationReserveMs']);
  const minimumCompleteChainMs = Number(values['engineeringImprovement.minimumCompleteChainMs']);
  const startedAtMs = Number.isFinite(Number(lineageStartedAtMs)) ? Number(lineageStartedAtMs) : Date.now();
  const remainingLineageMs = Math.max(
    0,
    lineageMaxDurationMs - Math.max(0, Date.now() - startedAtMs) - orchestrationReserveMs
  );
  const effectiveDurationMs = Math.min(runMaxDurationMs, remainingLineageMs);
  if (effectiveDurationMs < minimumCompleteChainMs) {
    const error = new Error('Engineering improvement does not have enough time for a complete chain.');
    error.status = 409;
    error.code = 'ENGINEERING_IMPROVEMENT_BUDGET_INSUFFICIENT';
    throw error;
  }
  return Object.freeze({ effectiveDurationMs });
}

function finalizeAutomaticContinuationFallback(response, error, continuationStarted) {
  const next = JSON.parse(JSON.stringify(response || {}));
  const continuation = next.continuation && typeof next.continuation === 'object'
    ? next.continuation
    : {};
  const reason = continuationStarted
    ? '自动续跑未能完成，系统已停止继续执行。'
    : ['AI_TEACHER_QUOTA_EXCEEDED', 'AI_TEACHER_POLICY_DENIED'].includes(String(error?.code || ''))
      ? '当前预算不足，自动续跑未启动。'
      : '自动续跑准入失败，系统未启动第二轮执行。';
  next.continuation = {
    ...continuation,
    status: 'user_confirmation_required',
    autoContinuationUsed: continuationStarted,
    canContinue: true,
    remainingItems: [
      ...(Array.isArray(continuation.remainingItems) ? continuation.remainingItems : []),
      { title: '继续完成剩余工作', detail: reason, status: 'remaining' }
    ].slice(0, 12)
  };
  if (automaticContinuationKind(continuation.kind) === ENGINEERING_IMPROVEMENT_CONTINUATION) {
    next.answerCompletionStatus = 'complete';
    next.validatorStatus = 'validated_passed';
    next.directAnswer = [
      String(next.directAnswer || '').trim(),
      '已保留并返回通过官方Validator的基线；本轮工程语义完善未完成，问题已记录，可稍后继续。'
    ].filter(Boolean).join('\n\n');
    return next;
  }
  next.answerCompletionStatus = 'incomplete';
  next.directAnswer = [
    String(next.directAnswer || '').trim(),
    reason,
    '已完成和未完成事项已保留。是否继续完成剩余工作？'
  ].filter(Boolean).join('\n\n');
  return next;
}

async function recordAutomaticContinuationFailure(authService, user, envelope, response, error, continuationStarted) {
  await recordAiAccess(authService, {
    userId: user?.id || null,
    decision: 'degraded',
    entitlementCode: 'ai.teacher.use',
    reason: `automatic_continuation_${continuationStarted ? 'run' : 'admission'}_${String(error?.code || 'failed')}`.slice(0, 240),
    lessonId: envelope?.course?.lessonId || null,
    requestId: envelope?.requestId || null
  }).catch(() => {});
  return response;
}

function validateTeacherProxyResponse(response, envelope) {
  const result = validateTeacherCapabilityResponse(response, envelope);
  if (result.ok) return response;
  const error = new Error('Teacher returned an invalid response contract');
  error.status = 503;
  error.code = 'TEACHER_INVALID_RESPONSE';
  throw error;
}

async function enrichTeacherEnvelope(payload, courseStore, user = null) {
  const clientPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const clientCourse = clientPayload.course && typeof clientPayload.course === 'object' && !Array.isArray(clientPayload.course)
    ? clientPayload.course
    : {};
  const clientCourseContext = clientPayload.courseContext
    && typeof clientPayload.courseContext === 'object'
    && !Array.isArray(clientPayload.courseContext)
    ? clientPayload.courseContext
    : {};
  const clientDiagnostics = clientPayload.diagnostics
    && typeof clientPayload.diagnostics === 'object'
    && !Array.isArray(clientPayload.diagnostics)
    ? clientPayload.diagnostics
    : {};
  const envelope = { ...clientPayload };
  delete envelope.provider;
  delete envelope.model;
  delete envelope.modelId;
  delete envelope.systemPrompt;
  delete envelope.system;
  delete envelope.toolChoice;
  delete envelope.tools;
  delete envelope.secret;
  delete envelope.quotaHint;
  delete envelope.adminDebug;
  delete envelope.runtime;
  delete envelope.runtimeUsed;
  delete envelope.runtimeAssignment;
  delete envelope.runtimeAssignmentId;
  delete envelope.resourcePolicySnapshot;
  delete envelope.automaticContinuationKind;
  delete envelope.automaticContinuationBudget;
  delete envelope.workflowVersion;
  delete envelope.toolSchemaVersion;
  delete envelope.buildVersion;
  envelope.requestId = envelope.requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  envelope.contractVersion = envelope.contractVersion || '1.0';
  envelope.host = {
    ...(envelope.host || {}),
    hostAppId: 'sysmlv2-learning-platform',
    hostAppVersion: '0.1.0',
    integrationMode: 'embedded-panel'
  };
  envelope.tenant = {
    tenantId: 'local-dev',
    userId: user?.id || '',
    dataPolicy: {
      allowLLM: false,
      allowTelemetry: false,
      allowCrossSessionMemory: false
    },
    workspaceId: envelope.tenant?.workspaceId || 'default'
  };
  envelope.tenant.userId = user?.id || '';
  envelope.tenant.tenantId = user?.tenantId || 'local-dev';
  if (user?.id) {
    envelope.tenant.userId = user.id;
    envelope.tenant.dataPolicy = {
      allowLLM: true,
      allowTelemetry: false,
      allowCrossSessionMemory: false
    };
  }

  const lessonId = String(clientCourse.lessonId || envelope.lessonId || '').slice(0, 160);
  let lesson = null;
  if (lessonId) {
    lesson = courseStore.loadLesson(lessonId);
    if (lesson) {
      envelope.course = {
        coursePackId: courseStore.packId,
        courseId: lesson.courseId || '',
        lessonId: lesson.id || lessonId,
        courseRuleMode: 'lesson_after_official_pass',
        lessonTitle: lesson.title || '',
        learningGoals: lesson.learningGoals || lesson.objectives || [],
        references: lesson.courseReferences || []
      };
      envelope.courseContext = {
        authority: 'server-course-pack',
        todoItems: extractTodoItems(lesson),
        glossary: [],
        references: lesson.courseReferences || [],
        conceptExplanations: lesson.courseConceptExplanations || [],
        codeGuideExplanations: lesson.codeGuideExplanations || [],
        clientSupplement: untrustedCourseContextSupplement(clientCourseContext)
      };
      if (!envelope.editor && lesson.workspace) {
        envelope.editor = {
          language: 'sysmlv2',
          entryFile: lesson.workspace.entryFile || 'main.sysml',
          activeFilePath: lesson.workspace.entryFile || lesson.workspace.files?.[0]?.path || 'main.sysml',
          files: normalizeTeacherFiles(lesson.workspace.files || [])
        };
      }
    }
  }
  if (!lesson) {
    envelope.course = {
      coursePackId: courseStore.packId,
      courseId: String(clientCourse.courseId || '').slice(0, 160),
      lessonId,
      courseRuleMode: 'none',
      lessonTitle: '',
      learningGoals: [],
      references: []
    };
    envelope.courseContext = {
      authority: 'server-course-pack',
      todoItems: [],
      glossary: [],
      references: [],
      conceptExplanations: [],
      codeGuideExplanations: [],
      clientSupplement: untrustedCourseContextSupplement(clientCourseContext)
    };
  }
  if (envelope.editor?.files) {
    envelope.editor.files = resolveWorkspaceImportClosure(normalizeTeacherFiles(envelope.editor.files), {
      entryFile: envelope.editor.entryFile,
      includePaths: [envelope.editor.activeFilePath]
    });
  }
  if (!envelope.question) envelope.question = { text: '' };
  const authoritative = await buildAuthoritativeTeacherContext(envelope, courseStore, clientDiagnostics);
  envelope.diagnostics = authoritative.diagnostics;
  envelope.model = authoritative.model;
  return envelope;
}

async function aiTeacherProviderStatus(providerStatusMonitor, activeVersion) {
  const official = providerStatusMonitor.getSnapshot();
  const [teacher, gateway] = await Promise.all([
    safeTeacherHealth(),
    aiTeacherLiteLlmHealth(activeVersion)
  ]);
  const domainWebSearch = teacher.body?.domainWebSearch || {};
  return {
    generatedAt: official.generatedAt || new Date().toISOString(),
    refreshAfterMs: official.refreshAfterMs || 60000,
    sync: official.sync || null,
    gateway: {
      status: gateway.status,
      source: 'litellm_liveliness',
      configured: gateway.configured,
      baseUrl: gateway.baseUrl,
      httpStatus: gateway.httpStatus
    },
    capabilities: [{
      id: 'deepseek-web-search',
      name: 'DeepSeek Web Search',
      status: domainWebSearchStatus(domainWebSearch),
      enabled: domainWebSearch.enabled === true,
      canEnable: domainWebSearch.canEnable === true,
      configured: domainWebSearch.configured === true,
      ready: domainWebSearch.ready === true,
      reason: boundedPublicStatusValue(domainWebSearch.reason),
      source: 'teacher_runtime',
      checkedAt: domainWebSearch.lastCheckedAt || '',
      warningCode: boundedPublicStatusValue(domainWebSearch.warningCode),
      verificationStatus: boundedPublicStatusValue(domainWebSearch.verificationStatus),
      startupEnabled: domainWebSearch.startupEnabled === true,
      controlSource: boundedPublicStatusValue(domainWebSearch.controlSource),
      controlUpdatedAt: domainWebSearch.controlUpdatedAt || '',
      probe: publicDomainWebSearchProbeState(domainWebSearch.probe)
    }],
    providers: Array.isArray(official.providers) ? official.providers : []
  };
}

function domainWebSearchStatus(state) {
  if (state?.ready === true && state?.verificationStatus === 'complete') return 'operational';
  if (state?.verificationStatus === 'partial' || state?.reason === 'provider_partial') return 'degraded';
  if (state?.configured === false || state?.enabled === false) return 'unavailable';
  if (state?.verificationStatus === 'unavailable' || state?.reason === 'provider_unavailable') return 'incident';
  return 'unknown';
}

function domainWebSearchTogglePayload(payload) {
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
  if (keys.length !== 1 || keys[0] !== 'enabled' || typeof payload.enabled !== 'boolean') {
    const error = new Error('请求体只能包含布尔字段 enabled。');
    error.code = 'DOMAIN_WEB_SEARCH_CONTROL_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return { enabled: payload.enabled };
}

function emptyObjectPayload(payload, code) {
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
  if (keys.length !== 0) {
    const error = new Error('请求体必须为空对象。');
    error.code = code;
    error.statusCode = 400;
    throw error;
  }
  return {};
}

function publicDomainWebSearchProbeState(value) {
  const probe = value && typeof value === 'object' ? value : {};
  return {
    policyEnabled: probe.policyEnabled === true,
    status: boundedPublicStatusValue(probe.status) || 'not_checked',
    inProgress: probe.inProgress === true,
    attemptCount: boundedStatusNumber(probe.attemptCount, 1000),
    cooldownScheduleSeconds: (Array.isArray(probe.cooldownScheduleSeconds) ? probe.cooldownScheduleSeconds : [])
      .slice(0, 8)
      .map((item) => boundedStatusNumber(item, 86400)),
    resetAfterSeconds: boundedStatusNumber(probe.resetAfterSeconds, 86400),
    hourlyLimit: boundedStatusNumber(probe.hourlyLimit, 60),
    remainingHourlyAttempts: boundedStatusNumber(probe.remainingHourlyAttempts, 60),
    lastAttemptAt: String(probe.lastAttemptAt || '').slice(0, 40),
    lastCheckedAt: String(probe.lastCheckedAt || '').slice(0, 40),
    nextAllowedAt: String(probe.nextAllowedAt || '').slice(0, 40),
    retryAfterMs: boundedStatusNumber(probe.retryAfterMs, 86400000),
    warningCode: boundedPublicStatusValue(probe.warningCode),
    durationMs: boundedStatusNumber(probe.durationMs, 120000),
    sourceCount: boundedStatusNumber(probe.sourceCount, 20),
    searchRequestCount: boundedStatusNumber(probe.searchRequestCount, 2),
    lastTrigger: boundedPublicStatusValue(probe.lastTrigger)
  };
}

function boundedStatusNumber(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(maximum, Math.floor(number)));
}

function boundedPublicStatusValue(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_:-]{1,100}$/u.test(text) ? text : '';
}

function untrustedCourseContextSupplement(value) {
  const validEditorStates = new Set(['template', 'draft', 'staleDraft', 'editing', 'saved']);
  return {
    trustLevel: 'untrusted-client',
    editorState: validEditorStates.has(value?.editorState) ? value.editorState : 'unknown',
    lastValidationPassed: typeof value?.lastValidationPassed === 'boolean' ? value.lastValidationPassed : null,
    reportedReferenceCount: Array.isArray(value?.references) ? value.references.length : 0
  };
}

async function buildAuthoritativeTeacherContext(envelope, courseStore, clientDiagnostics) {
  const files = Array.isArray(envelope.editor?.files) ? envelope.editor.files : [];
  const requestedActiveDiagnosticId = /^diag-[0-9a-f]{8}$/.test(String(clientDiagnostics?.activeDiagnosticId || ''))
    ? String(clientDiagnostics.activeDiagnosticId)
    : null;
  const clientSupplement = {
    trustLevel: 'untrusted-client',
    reportedDiagnosticCount: [
      ...(Array.isArray(clientDiagnostics?.officialValidator) ? clientDiagnostics.officialValidator : []),
      ...(Array.isArray(clientDiagnostics?.courseRules) ? clientDiagnostics.courseRules : [])
    ].length,
    requestedActiveDiagnosticId
  };
  if (!files.length) {
    return {
      diagnostics: {
        authority: 'server-validator',
        status: 'not_available_without_workspace',
        officialValidator: [],
        courseRules: [],
        lastValidation: null,
        activeDiagnosticId: null,
        clientSupplement
      },
      model: { modelElements: [], symbolsSummary: {} }
    };
  }

  try {
    const validation = await validateWithRules({
      files,
      entryFile: envelope.editor.entryFile || envelope.editor.activeFilePath || files[0].path
    }, rulesForTeacherEnvelope(envelope, courseStore));
    const allDiagnostics = normalizeAuthoritativeDiagnostics(validation.diagnostics);
    const officialValidator = allDiagnostics.filter((item) => item.source !== 'course-rule');
    const courseRules = allDiagnostics.filter((item) => item.source === 'course-rule');
    const diagnosticIds = new Set(allDiagnostics.map((item) => item.diagnosticId));
    return {
      diagnostics: {
        authority: 'server-validator',
        status: 'validated',
        officialValidator,
        courseRules,
        lastValidation: {
          syntaxValid: Boolean(validation.syntaxValid),
          semanticValid: Boolean(validation.semanticValid),
          coursePassed: Boolean(validation.coursePassed),
          validatedAt: new Date().toISOString(),
          validatorSource: validation.validatorSource || '',
          validationCompleteness: validation.validationCompleteness || '',
          fallbackActive: validation.fallbackActive !== false
        },
        activeDiagnosticId: requestedActiveDiagnosticId && diagnosticIds.has(requestedActiveDiagnosticId)
          ? requestedActiveDiagnosticId
          : null,
        clientSupplement
      },
      model: {
        modelElements: Array.isArray(validation.modelElements) ? validation.modelElements : [],
        symbolsSummary: {}
      }
    };
  } catch {
    return {
      diagnostics: {
        authority: 'server-validator',
        status: 'validator_unavailable',
        officialValidator: [],
        courseRules: [],
        lastValidation: null,
        activeDiagnosticId: null,
        clientSupplement
      },
      model: { modelElements: [], symbolsSummary: {} }
    };
  }
}

function normalizeAuthoritativeDiagnostics(value) {
  const seen = new Set();
  const output = [];
  for (const diagnostic of Array.isArray(value) ? value : []) {
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) continue;
    const diagnosticId = diagnosticIdFor(diagnostic);
    if (seen.has(diagnosticId)) continue;
    seen.add(diagnosticId);
    output.push({ ...diagnostic, diagnosticId });
  }
  return output;
}

function normalizeTeacherFiles(files) {
  return (files || []).map((file) => ({
    path: file.path || 'main.sysml',
    content: String(file.content || ''),
    editable: file.editable !== false,
    source: file.source || 'lesson-workspace',
    loadPolicy: file.loadPolicy || 'always'
  }));
}

function extractTodoItems(lesson) {
  const items = [];
  for (const file of lesson.workspace?.files || []) {
    const lines = String(file.content || '').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('TODO')) items.push({ file: file.path || 'main.sysml', line: index + 1, text: line.trim() });
    });
  }
  return items;
}

async function callTeacher(path, options = {}) {
  assertTeacherInternalToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), teacherTimeoutMsForCall(options));
  const target = new URL(path, TEACHER_URL);
  const headers = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  headers['x-ai-teacher-token'] = TEACHER_INTERNAL_TOKEN;
  try {
    const response = await fetch(target, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = { error: 'Teacher returned non-JSON response' };
    }
    if (!response.ok) {
      const teacherError = normalizeUpstreamError(payload, `Teacher returned ${response.status}`);
      const error = new Error(teacherError.message);
      error.status = response.status === 504 ? 504 : response.status >= 500 ? 503 : response.status;
      error.code = teacherError.code || 'TEACHER_UPSTREAM_ERROR';
      error.details = teacherError;
      throw error;
    }
    return options.sanitize === false ? payload : stripInternalTeacherPayload(payload);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Teacher request timed out');
      timeoutError.status = 504;
      timeoutError.code = 'TEACHER_TIMEOUT';
      throw timeoutError;
    }
    if (!error.status) {
      error.status = 503;
      error.code = 'TEACHER_UNAVAILABLE';
      error.message = `Teacher unavailable: ${error.message}`;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callTeacherStream(path, options = {}, res, request) {
  assertTeacherInternalToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), teacherTimeoutMsForCall(options));
  let clientConnected = true;
  const noteClientDisconnect = () => {
    clientConnected = false;
  };
  request?.once?.('aborted', noteClientDisconnect);
  res.once?.('close', noteClientDisconnect);
  const target = new URL(path, TEACHER_URL);
  const headers = { accept: 'application/x-ndjson' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  headers['x-ai-teacher-token'] = TEACHER_INTERNAL_TOKEN;
  try {
    if (options.acceptedThreadId && clientConnected && !res.destroyed && !res.writableEnded) {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-allow-credentials': 'true',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no'
      });
      res.write(`${JSON.stringify({ type: 'accepted', threadId: String(options.acceptedThreadId) })}\n`);
    }
    const response = await fetch(target, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({ error: `Teacher returned ${response.status}` }));
      const teacherError = normalizeUpstreamError(payload, `Teacher returned ${response.status}`);
      const error = new Error(teacherError.message);
      error.status = response.status === 504 ? 504 : response.status >= 500 ? 503 : response.status;
      error.code = teacherError.code || 'TEACHER_UPSTREAM_ERROR';
      throw error;
    }
    if (clientConnected && !res.destroyed && !res.writableEnded && !res.headersSent) {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-allow-credentials': 'true',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no'
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalRecorded = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const publicLines = await sanitizeTeacherStreamLines(line, options, () => finalRecorded, () => { finalRecorded = true; });
        await writeTeacherStreamLines(res, publicLines, () => clientConnected);
      }
    }
    if (buffer.trim()) {
      const publicLines = await sanitizeTeacherStreamLines(buffer, options, () => finalRecorded, () => { finalRecorded = true; });
      await writeTeacherStreamLines(res, publicLines, () => clientConnected);
    }
    if (!options.keepResponseOpen && clientConnected && !res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (!clientConnected || res.destroyed || res.writableEnded) return;
    if (typeof options.onError === 'function') {
      const fallback = await options.onError(error);
      if (fallback && typeof fallback === 'object') {
        const projected = projectStudentTeacherStreamEvent(fallback);
        if (projected.type === 'final') {
          for (const [index, chunk] of publicAnswerChunks(String(projected.directAnswer || '')).entries()) {
            res.write(`${JSON.stringify({ type: 'answer_delta', sequence: index + 1, text: chunk })}\n`);
          }
        }
        res.write(`${JSON.stringify(projected)}\n`);
        res.end();
        return;
      }
    }
    if (!res.headersSent) {
      const status = error.name === 'AbortError' ? 504 : error.status || 503;
      res.writeHead(status, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-allow-credentials': 'true',
        'cache-control': 'no-store'
      });
    }
    const internalCode = error.name === 'AbortError' ? 'TEACHER_TIMEOUT' : error.code || 'TEACHER_UNAVAILABLE';
    const code = publicTeacherErrorCode(internalCode);
    const message = publicTeacherErrorMessage(code);
    res.write(`${JSON.stringify({ type: 'error', code, message, status: error.status || 503 })}\n`);
    res.end();
  } finally {
    clearTimeout(timeout);
    request?.off?.('aborted', noteClientDisconnect);
    res.off?.('close', noteClientDisconnect);
  }
}

async function releaseTeacherTokenBudget(authService, user, envelope, capability, reservation, reason) {
  const reservationId = String(reservation?.reservationId || '');
  if (!reservationId) return null;
  return authService.betterAuth?.accountStore?.releaseAiTeacherBudget?.({
    reservationId,
    userId: user.id,
    tenantId: envelope.tenant?.tenantId || '',
    requestId: envelope.requestId || '',
    capability,
    reason
  });
}

async function aiTeacherModelRouteAttestation(requestedAlias, activeVersion = null) {
  const modelAlias = String(requestedAlias || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(modelAlias)) {
    const error = new Error('A valid model alias is required for route attestation.');
    error.status = 400;
    error.code = 'LITELLM_MODEL_ALIAS_INVALID';
    throw error;
  }
  const baseUrl = process.env.LITELLM_ADMIN_BASE_URL || '';
  if (!baseUrl || !process.env.LITELLM_MASTER_KEY) {
    const error = new Error('LiteLLM route attestation is not configured.');
    error.status = 503;
    error.code = 'LITELLM_ROUTE_ATTESTATION_NOT_CONFIGURED';
    throw error;
  }
  let response;
  try {
    response = await fetch(new URL('/model/info', baseUrl), {
      method: 'GET',
      headers: litellmAdminHeaders(false)
    });
  } catch {
    const error = new Error('LiteLLM route attestation is unavailable.');
    error.status = 503;
    error.code = 'LITELLM_ROUTE_ATTESTATION_UNAVAILABLE';
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload?.data)) {
    const error = new Error('LiteLLM route attestation returned an invalid response.');
    error.status = 503;
    error.code = 'LITELLM_ROUTE_ATTESTATION_INVALID';
    throw error;
  }
  const deployments = payload.data
    .filter((item) => String(item?.model_name || '') === modelAlias)
    .map((item) => {
      const params = item?.litellm_params || {};
      const providerModel = String(params.model || '');
      const apiBase = String(params.api_base || params.apiBase || '');
      const declaredId = String(item?.model_info?.id || item?.model_id || item?.deployment_id || '');
      const deploymentFingerprint = {
        modelAlias,
        providerModel,
        apiBaseHash: apiBase ? hashContent(apiBase) : '',
        rpm: safeRouteLimit(params.rpm),
        tpm: safeRouteLimit(params.tpm)
      };
      return {
        ...deploymentFingerprint,
        deploymentId: declaredId || `deployment_${hashContent(JSON.stringify(deploymentFingerprint)).slice(7, 23)}`,
        reasoningProfile: safeReasoningRouteProfile(params)
      };
    })
    .filter((item) => item.providerModel)
    .sort((left, right) => `${left.providerModel}:${left.deploymentId}`.localeCompare(`${right.providerModel}:${right.deploymentId}`));
  if (!deployments.length) {
    const error = new Error('The requested LiteLLM model alias has no active deployment.');
    error.status = 503;
    error.code = 'LITELLM_MODEL_ROUTE_NOT_FOUND';
    throw error;
  }
  const controlPlane = publishedRouteControlPlane(activeVersion, modelAlias);
  if (controlPlane && !publishedDeploymentsMatch(controlPlane.deployments, deployments)) {
    const error = new Error('LiteLLM runtime model route differs from the active published control-plane config.');
    error.status = 503;
    error.code = 'LITELLM_MODEL_ROUTE_DRIFT';
    throw error;
  }
  const attestation = {
    source: 'litellm-admin-model-info',
    modelAlias,
    routeCount: deployments.length,
    deployments,
    controlPlane,
    limitations: [
      'Runtime deployment fields come from LiteLLM /model/info.',
      'Router retry/failover settings come from the active published control-plane config, not a runtime-secret-bearing config dump.'
    ]
  };
  return {
    ...attestation,
    configHash: hashContent(JSON.stringify(attestation))
  };
}

function safeRouteLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeReasoningRouteProfile(params = {}) {
  const effort = String(params.reasoning_effort || params.reasoningEffort || '').trim();
  const profile = {
    effort: effort && /^[A-Za-z0-9._:-]{1,80}$/.test(effort) ? effort : '',
    supportsReasoningContent: params.supports_reasoning_content === true,
    thinkingEnabled: params.thinking === true || params.enable_thinking === true
  };
  return profile;
}

function publishedRouteControlPlane(activeVersion, modelAlias) {
  const group = activeVersion?.config?.modelGroups?.find((item) => item.modelName === modelAlias);
  if (!group) return null;
  return {
    evidence: 'active-published-config',
    versionId: String(activeVersion.versionId || ''),
    checksum: String(activeVersion.checksum || ''),
    router: {
      routingStrategy: String(group.router?.routingStrategy || ''),
      numRetries: safeRouteLimit(group.router?.numRetries),
      allowedFails: safeRouteLimit(group.router?.allowedFails),
      cooldownTime: safeRouteLimit(group.router?.cooldownTime)
    },
    deployments: (group.deployments || [])
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        deploymentId: String(item.deploymentId || ''),
        providerModel: String(item.model || ''),
        rpm: safeRouteLimit(item.rpm),
        tpm: safeRouteLimit(item.tpm)
      }))
      .sort((left, right) => `${left.providerModel}:${left.deploymentId}`.localeCompare(`${right.providerModel}:${right.deploymentId}`))
  };
}

function publishedDeploymentsMatch(published, runtime) {
  if (!Array.isArray(published) || !Array.isArray(runtime) || published.length !== runtime.length) return false;
  const publishedSignature = published.map((item) => `${item.providerModel}|${item.rpm}|${item.tpm}`).sort();
  const runtimeSignature = runtime.map((item) => `${item.providerModel}|${item.rpm}|${item.tpm}`).sort();
  return publishedSignature.every((value, index) => value === runtimeSignature[index]);
}

async function sanitizeTeacherStreamLines(line, options = {}, isFinalRecorded = () => false, markFinalRecorded = () => {}) {
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    return [JSON.stringify({
      type: 'error',
      code: 'TEACHER_STREAM_INVALID_EVENT',
      message: 'Teacher returned an invalid stream event',
      status: 503
    })];
  }
  if (event?.type === 'start' && options.onStart) {
    const nextEvent = await options.onStart(event);
    if (nextEvent && typeof nextEvent === 'object') event = nextEvent;
  }
  if (event?.type === 'final' && options.onFinal && !isFinalRecorded()) {
    const nextEvent = await options.onFinal(event);
    if (nextEvent && typeof nextEvent === 'object') event = nextEvent;
    markFinalRecorded();
  }
  const publicEvent = projectStudentTeacherStreamEvent(event);
  const publicLines = [];
  if (publicEvent.type === 'final') {
    const answer = String(publicEvent.directAnswer || '');
    const chunks = publicAnswerChunks(answer);
    for (let index = 0; index < chunks.length; index += 1) {
      publicLines.push(JSON.stringify({
        type: 'answer_delta',
        sequence: index + 1,
        text: chunks[index]
      }));
    }
  }
  publicLines.push(JSON.stringify(publicEvent));
  return publicLines;
}

// Retain the singular helper for focused tests and compatibility with older imports.
async function sanitizeTeacherStreamLine(line, options = {}, isFinalRecorded = () => false, markFinalRecorded = () => {}) {
  return (await sanitizeTeacherStreamLines(line, options, isFinalRecorded, markFinalRecorded)).join('\n');
}

async function writeTeacherStreamLines(res, lines, isClientConnected = () => true) {
  for (const line of lines) {
    if (!isClientConnected() || res.destroyed || res.writableEnded) return;
    res.write(`${line}\n`);
    if (line.includes('"type":"answer_delta"')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

function publicAnswerChunks(value) {
  const characters = Array.from(String(value || ''));
  if (!characters.length) return [];
  const chunkSize = Math.max(48, Math.ceil(characters.length / 96));
  const chunks = [];
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(characters.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

function aiTeacherDisabledPayload() {
  return {
    error: 'AI 教师已在当前环境配置中关闭。',
    code: 'AI_TEACHER_DISABLED',
    enabled: false
  };
}

function normalizeUpstreamError(payload, fallbackMessage) {
  const source = payload?.error || payload;
  if (source && typeof source === 'object') {
    return {
      code: source.code || payload?.code || 'TEACHER_UPSTREAM_ERROR',
      message: source.message || fallbackMessage,
      status: source.status || payload?.status || null
    };
  }
  return {
    code: payload?.code || 'TEACHER_UPSTREAM_ERROR',
    message: String(source || fallbackMessage),
    status: payload?.status || null
  };
}

function stripInternalTeacherPayload(value) {
  const blocked = new Set([
    'providerMeta',
    '__internal',
    'internalProviderDiagnostic',
    'selectedOutputTier',
    'maxCompletionTokens',
    'estimatedInputTokens',
    'completionTokens',
    'reasoningTokens',
    'promptTokens',
    'totalTokens',
    'providerTrace',
    'budgetReport',
    'skillSource',
    'tokenUsage',
    'providerUsage',
    'usage',
    'internalDiagnostic'
  ]);
  if (Array.isArray(value)) return value.map(stripInternalTeacherPayload);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key)) continue;
    clean[key] = stripInternalTeacherPayload(item);
  }
  return clean;
}

function projectStudentTeacherStreamEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'error', code: 'TEACHER_STREAM_INVALID_EVENT', message: 'AI 教师返回了无效事件。' };
  }
  const type = String(value.type || '');
  if (type === 'start') {
    return {
      type,
      threadId: String(value.threadId || ''),
      runId: String(value.runId || '')
    };
  }
  // 上游delta可能在任意字符边界切开内部标识，逐块正则无法可靠清洗。
  // 学生端只消费已完成的final投影；增量阶段返回确定性状态，不转发原始模型文本。
  if (type === 'delta') return { type: 'status', message: '正在组织回答。' };
  if (type === 'thinking') return { type, message: '正在分析问题。' };
  if (type === 'activity') return publicTeacherActivity(value);
  if (type === 'stage') {
    return {
      type,
      stage: String(value.stage || ''),
      message: publicTeacherStageMessage(value)
    };
  }
  if (type === 'baseline_ready') {
    return {
      type: 'activity',
      stage: 'baseline_ready',
      message: '已保存并通过官方Validator的基线，正在准备工程语义完善。'
    };
  }
  if (type === 'continuation_started') {
    return {
      type,
      kind: automaticContinuationKind(value.kind),
      message: value.kind === ENGINEERING_IMPROVEMENT_CONTINUATION
        ? '已保存并通过官方Validator的基线，正在自动执行工程语义完善。'
        : '首轮达到执行时限，已保存阶段性成果并自动续跑一次。'
    };
  }
  if (type === 'final') return { type, ...projectStudentTeacherResponse(value) };
  if (type === 'error' || type === 'cancelled') {
    const code = publicTeacherErrorCode(value.code, type);
    return {
      type,
      code,
      message: publicTeacherErrorMessage(code),
      ...(value.status !== undefined ? { status: Number(value.status) || 500 } : {})
    };
  }
  return {
    type: 'status',
    message: 'AI 教师状态已更新。'
  };
}

function publicTeacherStageMessage(value) {
  const stage = String(value?.stage || '');
  if (stage === 'tool_started' || stage === 'tool_finished') return '正在查阅与问题相关的材料。';
  if (stage === 'plan_ready') return '已完成问题理解。';
  if (stage === 'reasoning_selected') return '正在组织回答。';
  if (stage === 'run_started') return '开始处理问题。';
  if (stage === 'run_finished') return '已完成处理。';
  if (stage === 'step_started' || stage === 'step_finished') return '正在处理当前阶段。';
  const phase = String(value?.phase || '');
  if (['context_started'].includes(phase)) return '正在读取当前模型。';
  if (['request_planning_started'].includes(phase)) return '正在理解问题。';
  if (['knowledge_started', 'skill_started', 'domain_research_started'].includes(phase)) return '正在查阅与问题相关的材料。';
  if (['answer_started'].includes(phase)) return '正在组织回答。';
  if (['validation_started'].includes(phase)) return '正在验证候选。';
  if (['feedback_started', 'revision_started'].includes(phase)) return '正在复核回答。';
  return '正在处理当前阶段。';
}

function publicTeacherErrorCode(value, type = 'error') {
  if (type === 'cancelled') return 'TEACHER_RUN_CANCELLED';
  const code = String(value || '').toUpperCase();
  if (code === 'TOKEN_BUDGET_EXCEEDED') return code;
  if (code === 'TEACHER_TIMEOUT' || code.endsWith('_TIMEOUT')) return 'TEACHER_TIMEOUT';
  if (code === 'PROVIDER_DISABLED' || code === 'AI_TEACHER_DISABLED') return 'AI_TEACHER_UNAVAILABLE';
  return 'TEACHER_RUN_FAILED';
}

function publicTeacherErrorMessage(code) {
  if (code === 'TEACHER_RUN_CANCELLED') return 'AI 教师运行已取消。';
  if (code === 'TOKEN_BUDGET_EXCEEDED') return '本次 AI 教师额度不足，请稍后重试。';
  if (code === 'TEACHER_TIMEOUT') return 'AI 教师处理超时，请稍后重试。';
  return 'AI 教师暂时无法完成本次请求，请稍后重试。';
}

function projectStudentThreadList(value) {
  const threads = Array.isArray(value?.threads) ? value.threads : [];
  return {
    threads: threads.map(projectStudentThread)
  };
}

function projectStudentThread(thread) {
  const state = ['normal', 'approaching', 'critical'].includes(String(thread?.contextUsage?.state || ''))
    ? String(thread.contextUsage.state)
    : 'normal';
  return {
    threadId: String(thread?.threadId || ''),
    coursePackId: String(thread?.coursePackId || ''),
    courseId: String(thread?.courseId || ''),
    lessonId: String(thread?.lessonId || ''),
    title: String(thread?.title || '新对话').slice(0, 80),
    messageCount: Math.max(0, Number(thread?.messageCount) || 0),
    contextUsage: {
      estimatedTokens: Math.max(0, Number(thread?.contextUsage?.estimatedTokens) || 0),
      limitTokens: Math.max(0, Number(thread?.contextUsage?.limitTokens) || 0),
      ratio: Math.max(0, Math.min(1, Number(thread?.contextUsage?.ratio) || 0)),
      state
    },
    createdAt: String(thread?.createdAt || ''),
    updatedAt: String(thread?.updatedAt || '')
  };
}

function projectStudentThreadMessages(value) {
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  const completedAutomaticSources = new Set(messages
    .filter((message) => message?.role === 'assistant'
      && message?.response?.continuation?.autoContinuationUsed === true
      && /^run_[a-zA-Z0-9-]{8,160}$/.test(String(message?.response?.continuation?.sourceRunId || '')))
    .map((message) => String(message.response.continuation.sourceRunId)));
  return {
    threadId: String(value?.threadId || ''),
    messages: messages
      .filter((message) => message && typeof message === 'object' && ['user', 'assistant'].includes(String(message.role || '')))
      .filter((message) => !(message.role === 'assistant'
        && message?.response?.continuation?.status === 'automatic_pending'
        && completedAutomaticSources.has(String(message.runId || ''))))
      .map((message) => {
        const role = String(message.role || 'user');
        const response = role === 'assistant' && message.response
          ? projectStudentTeacherResponse(message.response)
          : undefined;
        const rawContent = String(message.content || '');
        return {
          messageId: String(message.messageId || ''),
          threadId: String(message.threadId || value?.threadId || ''),
          runId: String(message.runId || ''),
          requestId: String(message.requestId || ''),
          role,
          status: String(message.status || ''),
          content: role === 'assistant'
            ? String(response?.directAnswer || '该历史回答缺少可公开的结构化内容。')
            : rawContent,
          ...(response ? { response } : {}),
          createdAt: String(message.createdAt || ''),
          updatedAt: String(message.updatedAt || '')
        };
      })
  };
}

function projectStudentRunEvents(value) {
  const events = Array.isArray(value?.events) ? value.events : [];
  return {
    runId: String(value?.runId || ''),
    events: events.map((event) => {
      const type = String(event?.type || '');
      const streamEvent = projectStudentTeacherStreamEvent({
        ...(event?.payload && typeof event.payload === 'object' ? event.payload : {}),
        type
      });
      const { type: projectedType, ...payload } = streamEvent;
      return {
        eventId: String(event?.eventId || ''),
        runId: String(event?.runId || value?.runId || ''),
        seq: Math.max(0, Number(event?.seq) || 0),
        type: projectedType,
        payload,
        createdAt: String(event?.createdAt || '')
      };
    })
  };
}

function projectStudentRunStatus(value) {
  const run = value?.run && typeof value.run === 'object' ? value.run : {};
  const errorCode = run.errorCode ? publicTeacherErrorCode(run.errorCode) : '';
  return {
    run: {
      runId: String(run.runId || ''),
      threadId: String(run.threadId || ''),
      status: String(run.status || ''),
      errorCode,
      errorMessage: errorCode ? publicTeacherErrorMessage(errorCode) : '',
      startedAt: String(run.startedAt || ''),
      completedAt: String(run.completedAt || ''),
      cancelledAt: String(run.cancelledAt || ''),
      latestEventSeq: Math.max(0, Number(run.latestEventSeq) || 0)
    }
  };
}

const STUDENT_TEACHER_RESPONSE_FIELDS = new Set([
  'contractVersion',
  'responseId',
  'requestId',
  'answerType',
  'title',
  'confidence',
  'directAnswer',
  'answerCompletionStatus',
  'candidateDeliveryStatus',
  'sections',
  'patches',
  'evidence',
  'validatorStatus',
  'knowledgeGrounding',
  'codeBlockValidations',
  'alignmentReview',
  'clarification',
  'continuation',
  'messageId'
]);

/**
 * Public Teacher responses are an explicit projection, not a recursive blocklist.
 * The raw response remains available to trusted persistence/audit code, while the
 * learner receives only the answer, actionable validation state and safe sources.
 */
function projectStudentTeacherResponse(value) {
  const source = stripInternalTeacherPayload(value);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const projected = {};
  for (const [key, item] of Object.entries(source)) {
    if (!STUDENT_TEACHER_RESPONSE_FIELDS.has(key)) continue;
    projected[key] = item;
  }
  projected.sections = publicTeacherSections(projected.sections);
  projected.patches = publicTeacherPatches(projected.patches);
  projected.evidence = publicTeacherEvidence(projected.evidence);
  projected.knowledgeGrounding = publicKnowledgeGrounding(projected.knowledgeGrounding);
  projected.codeBlockValidations = publicCodeBlockValidations(projected.codeBlockValidations);
  if (projected.alignmentReview !== undefined) {
    projected.alignmentReview = publicAlignmentReview(projected.alignmentReview);
  }
  if (projected.clarification !== undefined) {
    projected.clarification = {
      checkpointId: String(projected.clarification?.checkpointId || ''),
      status: projected.clarification?.status === 'waiting' ? 'waiting' : '',
      question: String(projected.clarification?.question || ''),
      expiresAt: String(projected.clarification?.expiresAt || '')
    };
  }
  if (projected.continuation !== undefined) {
    projected.continuation = publicExecutionContinuation(projected.continuation);
  }
  projected.directAnswer = publicTeacherDirectAnswer(projected.directAnswer);
  return projected;
}

function publicExecutionContinuation(value) {
  const status = ['automatic_pending', 'complete', 'user_confirmation_required'].includes(value?.status)
    ? value.status
    : 'user_confirmation_required';
  return {
    kind: automaticContinuationKind(value?.kind),
    status,
    sourceRunId: /^run_[a-zA-Z0-9-]{8,160}$/.test(String(value?.sourceRunId || ''))
      ? String(value.sourceRunId)
      : '',
    autoContinuationUsed: value?.autoContinuationUsed === true,
    canContinue: value?.canContinue === true,
    completedItems: publicContinuationItems(value?.completedItems, 'completed'),
    remainingItems: publicContinuationItems(value?.remainingItems, 'remaining')
  };
}

function publicContinuationItems(value, fallbackStatus) {
  return (Array.isArray(value) ? value : []).slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const title = publicTeacherDirectAnswer(String(item.title || '')).slice(0, 240);
    if (!title) return [];
    const status = ['completed', 'validated', 'remaining', 'blocked'].includes(item.status)
      ? item.status
      : fallbackStatus;
    return [{
      title,
      detail: publicTeacherDirectAnswer(String(item.detail || '')).slice(0, 500),
      status
    }];
  });
}

function publicTeacherSections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((section) => {
      if (!section || typeof section !== 'object') return false;
      const label = `${section.kind || ''} ${section.title || ''} ${section.content || ''}`.toLowerCase();
      return !isInternalTeacherPublicText(label) && ![
      'agent_runtime',
      'agent runtime',
      'agentic teaching process',
      'ai teacher generation',
      'retrieved reviewed knowledge',
      'retrieval_context',
      'retrieval context',
      'llm provider',
      '工具账本',
      'tool ledger',
      'requestplan',
      'request_plan',
      'fast gate',
      'fast_gate'
      ].some((marker) => label.includes(marker));
    })
    .map((section) => ({
      kind: String(section.kind || ''),
      title: String(section.title || ''),
      content: String(section.content || '')
    }));
}

function publicTeacherPatches(value) {
  if (!Array.isArray(value)) return [];
  return value.map((patch) => ({
    patchId: String(patch?.patchId || ''),
    title: String(patch?.title || ''),
    baseFilePath: String(patch?.baseFilePath || ''),
    // This hash is a required optimistic-concurrency guard for safe client apply,
    // not an internal Provider, Ledger or evidence hash.
    baseContentHash: String(patch?.baseContentHash || ''),
    previewText: String(patch?.previewText || ''),
    validatorStatus: String(patch?.validatorStatus || 'not_validated'),
    applyPolicy: String(patch?.applyPolicy || 'copy_only'),
    validationDiagnostics: publicTeacherDiagnostics(patch?.validationDiagnostics),
    ...(Array.isArray(patch?.warnings) ? {
      warnings: patch.warnings
        .filter((item) => typeof item === 'string' && !isInternalTeacherPublicText(item))
        .slice(0, 12)
    } : {}),
    operations: Array.isArray(patch?.operations)
      ? patch.operations.map((operation) => ({
        op: String(operation?.op || ''),
        filePath: String(operation?.filePath || ''),
        startLine: Number(operation?.startLine || 0),
        startColumn: Number(operation?.startColumn || 0),
        endLine: Number(operation?.endLine || 0),
        endColumn: Number(operation?.endColumn || 0),
        replacement: String(operation?.replacement || '')
      }))
      : []
  }));
}

function publicTeacherDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => {
    if (!item || typeof item !== 'object') return { message: String(item || '') };
    const projected = {};
    for (const key of [
      'source',
      'severity',
      'code',
      'ruleId',
      'message',
      'filePath',
      'line',
      'column',
      'endLine',
      'endColumn'
    ]) {
      if (item[key] !== undefined) projected[key] = item[key];
    }
    return projected;
  });
}

function isInternalTeacherPublicText(value) {
  return /(tool ledger|工具账本|skill_[a-f0-9]+|request_?plan|fast[ _]gate|sha256:|runtimeAssignment(?:Id)?|argsHash|requestPlanHash|promptHash|toolTrace|workflowVersion\s*[:=])/iu.test(String(value || ''));
}

function publicTeacherDirectAnswer(value) {
  const answer = String(value || '');
  return isInternalTeacherPublicText(answer)
    ? '当前回答包含不能向学生展示的内部处理信息，因此没有作为正式说明返回。'
    : answer;
}

function publicTeacherEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object'
      && !['llm_provider', 'skill'].includes(String(item.sourceType || '').toLowerCase())
      && !/^skill_[a-f0-9]+$/iu.test(String(item.sourceTitle || '')))
    .map((item) => {
      const projected = {};
      for (const key of [
        'evidenceId',
        'authorityLevel',
        'sourceType',
        'sourceTitle',
        'sourceUrl',
        'sourceVersion',
        'quote',
        'summary',
        'confidence'
      ]) {
        if (item[key] === undefined) continue;
        if (/sha256:/iu.test(String(item[key]))) continue;
        if (['summary', 'quote'].includes(key)
          && /(tool ledger|工具账本|skill_|requestplan|fast gate)/iu.test(String(item[key]))) continue;
        projected[key] = item[key];
      }
      return projected;
    });
}

function publicKnowledgeGrounding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return {
    used: value.used === true,
    uniqueClaimCount: Math.max(0, Number.isInteger(value.uniqueClaimCount) ? value.uniqueClaimCount : 0),
    uniqueEvidenceCount: Math.max(0, Number.isInteger(value.uniqueEvidenceCount) ? value.uniqueEvidenceCount : 0)
  };
}

function publicCodeBlockValidations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => ({
    index: Number.isInteger(item?.index) ? item.index : index,
    language: String(item?.language || ''),
    status: String(item?.status || 'not_validated'),
    label: String(item?.label || ''),
    message: isInternalTeacherPublicText(item?.message) ? '' : String(item?.message || ''),
    source: String(item?.source || ''),
    attempts: Math.max(0, Number(item?.attempts) || 0),
    maxAttempts: Math.max(0, Number(item?.maxAttempts) || 0),
    manualReviewRequired: item?.manualReviewRequired === true,
    diagnostics: publicTeacherDiagnostics(item?.diagnostics),
    validationCompleteness: String(item?.validationCompleteness || 'not_run'),
    syntaxValid: item?.syntaxValid === true,
    semanticValid: item?.semanticValid === true,
    validationScope: String(item?.validationScope || '')
  }));
}

function publicAlignmentReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const projected = {};
  for (const key of [
    'version',
    'label',
    'targetSatisfied',
    'scopePreserved',
    'minimality',
    'summary'
  ]) {
    if (value[key] === undefined || isInternalTeacherPublicText(value[key])) continue;
    projected[key] = value[key];
  }
  return projected;
}

async function validateSingleLineTeacherPatch(teacherResult, envelope, courseStore) {
  const rules = rulesForTeacherEnvelope(envelope, courseStore);
  const validation = await validateWithRules({
    files: teacherResult.files,
    entryFile: envelope.editor?.entryFile || teacherResult.files?.[0]?.path || 'main.sysml'
  }, rules);
  const passed = Boolean(validation.syntaxValid && validation.semanticValid && validation.coursePassed);
  const learningCard = buildValidatedPatchLearningCard(teacherResult.patch, envelope, validation, passed);
  return {
    ok: true,
    mode: 'single_line_patch',
    patch: {
      ...teacherResult.patch,
      validatorStatus: passed ? 'validated_passed' : 'validated_failed',
      validationDiagnostics: validation.diagnostics || [],
      validationResult: validation,
      applyPolicy: passed ? 'user_confirm_required' : 'copy_only',
      learningCard,
      warnings: [
        ...(teacherResult.patch?.warnings || []),
        ...(passed ? [] : ['validation_failed'])
      ]
    },
    files: teacherResult.files,
    validation,
    warnings: teacherResult.warnings || []
  };
}

function buildValidatedPatchLearningCard(patch, envelope, validation, passed) {
  const base = patch?.learningCard && typeof patch.learningCard === 'object' ? patch.learningCard : {};
  const op = Array.isArray(patch?.operations) ? patch.operations[0] : null;
  const diagnostics = Array.isArray(validation?.diagnostics) ? validation.diagnostics : [];
  const lineDiagnostic = diagnostics.find((item) => Number(item.line) === Number(op?.startLine))
    || diagnostics[0]
    || null;
  const goals = Array.isArray(envelope.course?.learningGoals) ? envelope.course.learningGoals.filter(Boolean) : [];
  const goalSummary = summarizeLessonGoalProgress(validation, goals);
  return {
    issue: String(base.issue || lineDiagnostic?.message || '这条单行建议用于处理当前局部建模问题。').slice(0, 240),
    cause: String(base.cause || '建议已经先在临时模型中应用，再交给 validator 和课程规则检查。').slice(0, 240),
    concept: String(base.concept || inferApiPatchConcept(op?.replacement || patch?.previewText || '')).slice(0, 100),
    courseGoal: String(base.courseGoal || goalSummary.currentGoal || goals[0] || envelope.course?.lessonTitle || '').slice(0, 180),
    nextTime: String(base.nextTime || '下次先判断当前行的建模角色，再运行校验确认语法、语义和课程目标同时通过。').slice(0, 240),
    validationSummary: passed
      ? '应用这条单行建议后的临时模型已通过严格语法、语义和课程规则。'
      : '应用这条单行建议后的临时模型仍未通过校验，只能复制参考，不能直接应用。',
    goalProgress: goalSummary
  };
}

function summarizeLessonGoalProgress(validation, goals) {
  const lessonResults = Array.isArray(validation?.lessonResults) ? validation.lessonResults : [];
  const total = goals.length || lessonResults.length || 0;
  const passedRules = lessonResults.filter((item) => item?.passed === true || item?.ok === true).length;
  const failedRule = lessonResults.find((item) => item?.passed === false || item?.ok === false);
  return {
    passed: passedRules,
    total,
    currentGoal: String(failedRule?.message || failedRule?.description || goals[Math.min(passedRules, Math.max(0, goals.length - 1))] || '').slice(0, 180)
  };
}

function inferApiPatchConcept(text) {
  const source = String(text || '');
  if (/\bpart\s+def\b/.test(source)) return 'part definition';
  if (/\bpart\b/.test(source)) return 'part usage';
  if (/\bport\b/.test(source)) return 'port modeling';
  if (/\bitem\b/.test(source)) return 'item modeling';
  if (/\bflow\b/.test(source)) return 'flow';
  if (/\battribute\b/.test(source)) return 'attribute';
  if (/\bsatisfy\b/.test(source)) return 'satisfy';
  if (/\bexpose\b/.test(source)) return 'view expose';
  return 'single-line SysML v2 modeling';
}

function rulesForTeacherEnvelope(envelope, courseStore) {
  if (envelope.course?.courseRuleMode === 'none') {
    return [{ type: 'strictValidationPassed' }];
  }
  const lessonId = envelope.course?.lessonId || '';
  if (lessonId) {
    const lesson = courseStore.loadLesson(lessonId);
    if (lesson?.validation?.rules) return lesson.validation.rules;
  }
  if (envelope.course?.lessonId === 'final-project' || envelope.course?.courseId === 'final-project') {
    const project = courseStore.loadFinalProject();
    if (project?.validation?.rules) return project.validation.rules;
  }
  return [{ type: 'strictValidationPassed' }];
}

function aiTeacherPhase0Reply(message = '') {
  const text = String(message || '').trim();
  if (!text) {
    return 'AI 教师权限已开启。Phase 0 只完成账号与权限门禁，真实模型答疑将在后续阶段接入。';
  }
  return `AI 教师权限已开启。已收到你的问题：“${text.slice(0, 120)}”。Phase 0 当前返回占位答复，后续会接入真实 AI 教师服务。`;
}

function estimateTokenUsage(prompt = '', completion = '') {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completion);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function estimateTokens(text = '') {
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

async function validateTeacherCandidateWorkspace(payload, courseStore, req) {
  const context = payload?.context;
  if (!context || !Array.isArray(context?.editor?.files) || !context.editor.files.length) {
    throw candidateValidationError('VALIDATOR_TOOL_CONTEXT_INVALID', 'Trusted editor workspace is required.');
  }
  const candidate = payload?.candidate;
  assertStrictObject(candidate, ['mode', 'fileName', 'fileId', 'baseHash', 'content', 'edits', 'files'], 'candidate');
  const standaloneMode = candidate?.mode === 'standalone_model';
  const manifest = standaloneMode
    ? { entries: [], byId: new Map() }
    : authorizedCandidateManifest(context);
  const files = applyCandidateWorkspace(candidate, manifest, context);
  const entryPath = standaloneMode
    ? standaloneCandidatePath(candidate.fileName)
    : String(context.editor.entryFile || context.editor.activeFilePath || manifest.entries[0].path);
  const requestAbort = new AbortController();
  const abort = () => requestAbort.abort(new Error('Teacher validator tool request aborted'));
  req?.once?.('aborted', abort);
  const runtimePolicy = agentResourcePolicyProjectionFromContext(context);
  const timeoutSignal = AbortSignal.timeout(runtimePolicy.validator.toolTimeoutMs);
  const signal = AbortSignal.any([requestAbort.signal, timeoutSignal]);
  try {
    const lessonRules = standaloneMode ? [] : rulesForTeacherEnvelope(context, courseStore);
    const normalizedLessonRules = Array.isArray(lessonRules)
      ? lessonRules
      : (Array.isArray(lessonRules?.rules) ? lessonRules.rules : []);
    const courseRuleCount = normalizedLessonRules.filter((rule) => rule?.type !== 'strictValidationPassed').length;
    const validation = await validateWithRules(
      { files, entryFile: entryPath },
      lessonRules,
      { signal, includeValidatorObservation: true }
    );
    const candidateWorkspaceHash = hashContent(canonicalWorkspaceText(files));
    const passed = Boolean(validation.syntaxValid && validation.semanticValid && validation.coursePassed);
    const allDiagnostics = Array.isArray(validation.diagnostics) ? validation.diagnostics : [];
    const diagnostics = allDiagnostics.slice(0, AI_TEACHER_VALIDATOR_DIAGNOSTIC_LIMIT);
    const structureEvidence = buildTeacherCandidateStructureEvidence({
      validation,
      files,
      candidateWorkspaceHash
    });
    return {
      ok: true,
      toolSchemaVersion: AI_TEACHER_VALIDATOR_TOOL_SCHEMA_VERSION,
      candidateId: `candidate_${candidateWorkspaceHash.slice(0, 24)}`,
      candidateWorkspaceHash,
      validatorStatus: passed ? 'validated_passed' : 'validated_failed',
      syntaxValid: Boolean(validation.syntaxValid),
      semanticValid: Boolean(validation.semanticValid),
      coursePassed: Boolean(validation.coursePassed),
      courseRulesExecuted: Boolean(validation.syntaxValid && validation.semanticValid && courseRuleCount > 0),
      courseRuleCount,
      diagnostics,
      diagnosticSummary: {
        total: allDiagnostics.length,
        included: diagnostics.length,
        truncated: allDiagnostics.length > diagnostics.length
      },
      structureEvidence,
      validationCompleteness: validation.validationCompleteness || '',
      validatorSource: validation.validatorSource || '',
      validatorBackend: validation.validatorBackend || '',
      validatorReleaseTag: validation.validatorReleaseTag || '',
      validatorKernelVersion: validation.validatorKernelVersion || '',
      validatorAttestation: validation.validatorAttestation || null,
      fallbackActive: validation.fallbackActive !== false,
      validatorObservation: validation.validatorObservation,
      candidateFiles: standaloneMode
        ? files.map((file) => ({
            fileId: 'standalone_model',
            path: file.path,
            contentHash: hashContent(file.content || '')
          }))
        : manifest.entries.map((entry) => {
            const file = files.find((item) => item.path === entry.path);
            return { fileId: entry.fileId, path: entry.path, contentHash: hashContent(file?.content || '') };
          })
    };
  } catch (error) {
    if (signal.aborted && !error.code) {
      error.code = timeoutSignal.aborted ? 'VALIDATOR_TOOL_TIMEOUT' : 'VALIDATOR_TOOL_ABORTED';
      error.status = timeoutSignal.aborted ? 504 : 499;
    }
    throw error;
  } finally {
    req?.off?.('aborted', abort);
  }
}

function authorizedCandidateManifest(context) {
  const files = context.editor.files || [];
  const entries = files.map((file) => {
    const path = String(file.path || '');
    if (!path || !/\.sysml$/i.test(path)) {
      throw candidateValidationError('VALIDATOR_TOOL_FILE_INVALID', 'Only authorized SysML workspace files may be validated.');
    }
    return {
      fileId: `file_${hashContent(path).slice('sha256:'.length, 'sha256:'.length + 20)}`,
      path,
      content: String(file.content || ''),
      baseHash: hashContent(String(file.content || '')),
      editable: file.editable !== false,
      loadPolicy: file.loadPolicy || 'always'
    };
  });
  return { entries, byId: new Map(entries.map((entry) => [entry.fileId, entry])) };
}

function applyCandidateWorkspace(candidate, manifest, context) {
  const mode = String(candidate?.mode || '');
  if (mode === 'standalone_model') {
    assertStrictObject(candidate, ['mode', 'fileName', 'content'], 'candidate');
    return [{
      path: standaloneCandidatePath(candidate.fileName),
      content: candidateContent(candidate.content),
      editable: false,
      source: 'agent-standalone-candidate'
    }];
  }
  const working = new Map(manifest.entries.map((entry) => [entry.fileId, { ...entry }]));
  if (mode === 'replace_entry') {
    assertStrictObject(candidate, ['mode', 'fileId', 'baseHash', 'content'], 'candidate');
    const entry = requireCandidateFile(working, candidate.fileId, candidate.baseHash, { allowReadOnlySnapshot: true });
    const entryPath = String(context.editor.entryFile || context.editor.activeFilePath || '');
    if (entry.path !== entryPath) {
      throw candidateValidationError('VALIDATOR_TOOL_ENTRY_MISMATCH', 'replace_entry may only target the trusted entry file.');
    }
    const content = candidateContent(candidate.content);
    assertReadOnlySnapshot(entry, content);
    entry.content = content;
  } else if (mode === 'workspace_files') {
    assertStrictObject(candidate, ['mode', 'files'], 'candidate');
    if (!Array.isArray(candidate.files) || !candidate.files.length) {
      throw candidateValidationError('VALIDATOR_TOOL_FILES_REQUIRED', 'workspace_files requires at least one authorized file.');
    }
    const seen = new Set();
    for (const file of candidate.files) {
      assertStrictObject(file, ['fileId', 'baseHash', 'content'], 'candidate.files[]');
      if (seen.has(file.fileId)) throw candidateValidationError('VALIDATOR_TOOL_DUPLICATE_FILE', 'Duplicate candidate file id.');
      seen.add(file.fileId);
      const entry = requireCandidateFile(working, file.fileId, file.baseHash, { allowReadOnlySnapshot: true });
      const content = candidateContent(file.content);
      assertReadOnlySnapshot(entry, content);
      entry.content = content;
    }
  } else if (mode === 'apply_edits') {
    assertStrictObject(candidate, ['mode', 'edits'], 'candidate');
    if (!Array.isArray(candidate.edits) || !candidate.edits.length || candidate.edits.length > 24) {
      throw candidateValidationError('VALIDATOR_TOOL_EDITS_INVALID', 'apply_edits requires 1-24 edits.');
    }
    const grouped = new Map();
    for (const edit of candidate.edits) {
      assertStrictObject(edit, ['fileId', 'baseHash', 'startLine', 'endLine', 'replacement'], 'candidate.edits[]');
      const entry = requireCandidateFile(working, edit.fileId, edit.baseHash);
      const list = grouped.get(entry.fileId) || [];
      list.push(edit);
      grouped.set(entry.fileId, list);
    }
    for (const [fileId, edits] of grouped) {
      const entry = working.get(fileId);
      entry.content = applyAuthorizedLineEdits(entry.content, edits);
    }
  } else {
    throw candidateValidationError('VALIDATOR_TOOL_MODE_INVALID', 'Unsupported candidate workspace mode.');
  }
  return manifest.entries.map((original) => {
    const current = working.get(original.fileId);
    return {
      path: original.path,
      content: current.content,
      editable: original.editable,
      source: 'agent-candidate'
    };
  });
}

function standaloneCandidatePath(value) {
  const fileName = String(value || '').trim();
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*\.sysml$/iu.test(fileName)) {
    throw candidateValidationError(
      'VALIDATOR_TOOL_STANDALONE_FILENAME_INVALID',
      'standalone_model fileName must be a safe .sysml basename.'
    );
  }
  return `standalone/${fileName}`;
}

function requireCandidateFile(working, fileId, baseHash, options = {}) {
  const entry = working.get(String(fileId || ''));
  if (!entry) throw candidateValidationError('VALIDATOR_TOOL_FILE_NOT_AUTHORIZED', 'Candidate file id is not authorized for this run.');
  if (!entry.editable && !options.allowReadOnlySnapshot) {
    throw candidateValidationError('VALIDATOR_TOOL_FILE_READ_ONLY', 'Candidate validation cannot edit a read-only file.');
  }
  if (String(baseHash || '') !== entry.baseHash) {
    throw candidateValidationError('VALIDATOR_TOOL_BASE_HASH_MISMATCH', 'Candidate base hash does not match the trusted workspace.');
  }
  return entry;
}

function assertReadOnlySnapshot(entry, content) {
  if (!entry.editable && content !== entry.content) {
    throw candidateValidationError('VALIDATOR_TOOL_FILE_READ_ONLY', 'Read-only files may only be validated as an unchanged trusted snapshot.');
  }
}

function applyAuthorizedLineEdits(content, edits) {
  let lines = String(content || '').split(/\r\n|\r|\n/);
  const normalized = edits.map((edit) => {
    const startLine = Number(edit.startLine);
    const endLine = Number(edit.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length + 1) {
      throw candidateValidationError('VALIDATOR_TOOL_EDIT_RANGE_INVALID', 'Candidate edit range is outside the trusted file.');
    }
    return { startLine, endLine, replacement: candidateContent(edit.replacement) };
  }).sort((left, right) => right.startLine - left.startLine || right.endLine - left.endLine);
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of normalized) {
    if (edit.endLine >= previousStart) throw candidateValidationError('VALIDATOR_TOOL_EDIT_OVERLAP', 'Candidate edits may not overlap.');
    const replacementLines = edit.replacement.split(/\r\n|\r|\n/);
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines);
    previousStart = edit.startLine;
  }
  return lines.join('\n');
}

function candidateContent(value) {
  const content = String(value ?? '');
  if (content.length > 400000) throw candidateValidationError('VALIDATOR_TOOL_CONTENT_TOO_LARGE', 'Candidate file content is too large.');
  return content;
}

function assertStrictObject(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw candidateValidationError('VALIDATOR_TOOL_SCHEMA_INVALID', `${label} must be an object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) {
    throw candidateValidationError('VALIDATOR_TOOL_SCHEMA_INVALID', `${label} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function canonicalWorkspaceText(files) {
  return [...files]
    .sort((left, right) => String(left.path).localeCompare(String(right.path)))
    .map((file) => `${file.path}\n${hashContent(String(file.content || ''))}`)
    .join('\n');
}

function buildTeacherCandidateStructureEvidence({ validation, files, candidateWorkspaceHash }) {
  const outline = validation?.semanticOutline;
  const expectedOutlineContentHash = hashContent(combineTeacherValidatorFiles(files));
  if (validation?.syntaxValid === true
    && validation?.semanticValid === true
    && outline?.status === 'available'
    && outline?.contentHash === expectedOutlineContentHash) {
    const flattened = flattenTeacherSemanticOutline(outline.roots);
    const diagnostics = normalizeTeacherStructureDiagnostics(outline.diagnostics);
    return {
      source: 'official_semantic_outline',
      authority: 'authoritative',
      status: 'available',
      candidateWorkspaceHash,
      contentHash: outline.contentHash,
      nodes: flattened.nodes,
      diagnostics: diagnostics.items,
      truncated: flattened.truncated || diagnostics.truncated
    };
  }

  const localNodes = normalizeTeacherLocalStructure(validation?.modelElements);
  const localDiagnostics = normalizeTeacherStructureDiagnostics(validation?.structureDiagnostics);
  if (localNodes.nodes.length > 0 || localDiagnostics.items.length > 0) {
    return {
      source: 'local_structure_analyzer',
      authority: 'advisory',
      status: 'partial',
      candidateWorkspaceHash,
      nodes: localNodes.nodes,
      diagnostics: localDiagnostics.items,
      truncated: localNodes.truncated || localDiagnostics.truncated
    };
  }

  const outlineStatus = ['invalid', 'unavailable'].includes(String(outline?.status || ''))
    ? outline.status
    : 'unavailable';
  const bindingDiagnostics = [];
  if (outline?.status === 'available' && outline?.contentHash !== expectedOutlineContentHash) {
    bindingDiagnostics.push({
      severity: 'warning',
      category: 'binding',
      source: 'ai-teacher-api',
      message: '结构证据内容哈希与本次Validator输入不一致，已丢弃该结构视图。'
    });
  }
  return {
    source: 'none',
    authority: 'none',
    status: outlineStatus,
    candidateWorkspaceHash,
    nodes: [],
    diagnostics: bindingDiagnostics,
    truncated: false
  };
}

function combineTeacherValidatorFiles(files) {
  return files
    .map((file) => `// file: ${file.path}\n${String(file.content || '').replace(/^\uFEFF/, '')}`)
    .join('\n\n');
}

function flattenTeacherSemanticOutline(roots) {
  const nodes = [];
  let total = 0;
  const visit = (node, ownerPath = []) => {
    if (!node || typeof node !== 'object') return;
    total += 1;
    const name = String(node.name || node.declaredName || '').trim();
    if (nodes.length < AI_TEACHER_STRUCTURE_NODE_LIMIT) {
      nodes.push(compactTeacherObject({
        kind: String(node.displayKind || node.metaclass || 'element').slice(0, 160),
        ...(name ? { name: name.slice(0, 240) } : {}),
        ...(node.qualifiedName ? { qualifiedName: String(node.qualifiedName).slice(0, 500) } : {}),
        ...(ownerPath.length ? { ownerPath: ownerPath.slice(-20) } : {}),
        ...(Number.isInteger(node.line) && node.line > 0 ? { line: node.line } : {})
      }));
    }
    const nextOwnerPath = name ? [...ownerPath, name].slice(-20) : ownerPath;
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, nextOwnerPath);
  };
  for (const root of Array.isArray(roots) ? roots : []) visit(root, []);
  return { nodes, truncated: total > nodes.length };
}

function normalizeTeacherLocalStructure(modelElements) {
  const elements = Array.isArray(modelElements) ? modelElements : [];
  const byId = new Map(elements
    .filter((element) => element && typeof element === 'object' && element.id)
    .map((element) => [String(element.id), element]));
  const ownerPathFor = (element) => {
    const owners = [];
    const visited = new Set();
    let parentId = element?.parentId;
    while (parentId && owners.length < 20 && !visited.has(String(parentId))) {
      visited.add(String(parentId));
      const parent = byId.get(String(parentId));
      if (!parent) break;
      if (parent.name) owners.unshift(String(parent.name).slice(0, 240));
      parentId = parent.parentId;
    }
    return owners;
  };
  const nodes = elements.slice(0, AI_TEACHER_STRUCTURE_NODE_LIMIT).map((element) => compactTeacherObject({
    kind: String(element?.kind || element?.metaclass || 'element').slice(0, 160),
    ...(element?.name ? { name: String(element.name).slice(0, 240) } : {}),
    ...(element?.qualifiedName ? { qualifiedName: String(element.qualifiedName).slice(0, 500) } : {}),
    ...(ownerPathFor(element).length ? { ownerPath: ownerPathFor(element) } : {}),
    ...(Number.isInteger(element?.line) && element.line > 0 ? { line: element.line } : {})
  }));
  return { nodes, truncated: elements.length > nodes.length };
}

function normalizeTeacherStructureDiagnostics(value) {
  const diagnostics = Array.isArray(value) ? value : [];
  const items = diagnostics.slice(0, AI_TEACHER_STRUCTURE_DIAGNOSTIC_LIMIT).map((item) => ({
    severity: ['error', 'warning', 'info'].includes(String(item?.severity || '').toLowerCase())
      ? String(item.severity).toLowerCase()
      : 'warning',
    ...(item?.category ? { category: String(item.category).slice(0, 120) } : {}),
    ...(item?.source ? { source: String(item.source).slice(0, 160) } : {}),
    message: String(item?.message || '结构分析器返回了未说明的诊断。').slice(0, 4000)
  }));
  return { items, truncated: diagnostics.length > items.length };
}

function compactTeacherObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function candidateValidationError(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

async function validateWithRules(payload, rules, options = {}) {
  const files = normalizeFiles(payload);
  const strictResult = await callValidator({ files, entryFile: payload.entryFile }, options);
  const officialDiagnostics = enhanceOfficialDiagnostics({
    diagnostics: strictResult.diagnostics || [],
    files,
    entryFile: payload.entryFile,
    validatorSource: strictResult.source
  });
  let ruleResult = { coursePassed: false, diagnostics: [], lessonResults: [] };
  if (strictResult.syntaxValid && strictResult.semanticValid) {
    ruleResult = evaluateRules({ rules, files, strictResult });
  } else {
    ruleResult.diagnostics.push({
      file: payload.entryFile || files[0]?.path || 'main.sysml',
      line: 1,
      column: 1,
      severity: 'error',
      category: 'lesson',
      message: '严格语法/语义校验未通过，课程规则未执行。',
      source: 'course-rule'
    });
  }
  return {
    syntaxValid: Boolean(strictResult.syntaxValid),
    semanticValid: Boolean(strictResult.semanticValid),
    coursePassed: Boolean(strictResult.syntaxValid && strictResult.semanticValid && ruleResult.coursePassed),
    diagnostics: [...officialDiagnostics, ...ruleResult.diagnostics],
    modelElements: strictResult.modelElements || [],
    structureDiagnostics: strictResult.structureDiagnostics || [],
    semanticOutline: strictResult.semanticOutline || null,
    lessonResults: ruleResult.lessonResults,
    validatorSource: strictResult.source,
    validatorBackend: strictResult.backend,
    validatorReleaseTag: strictResult.releaseTag || '',
    validatorKernelVersion: strictResult.kernelVersion || '',
    validatorAttestation: strictResult.validatorAttestation || null,
    validationCompleteness: strictResult.validationCompleteness,
    fallbackActive: strictResult.fallbackActive !== false,
    ...(options.includeValidatorObservation
      ? { validatorObservation: strictResult.validatorObservation }
      : {})
  };
}

async function buildModelOutlineResponse(payload) {
  const files = normalizeFiles(payload);
  const strictResult = await callValidator({ files, entryFile: payload.entryFile });
  return {
    syntaxValid: Boolean(strictResult.syntaxValid),
    semanticValid: Boolean(strictResult.semanticValid),
    diagnostics: enhanceOfficialDiagnostics({
      diagnostics: strictResult.diagnostics || [],
      files,
      entryFile: payload.entryFile,
      validatorSource: strictResult.source
    }),
    semanticOutline: strictResult.semanticOutline || null,
    validatorSource: strictResult.source,
    validatorBackend: strictResult.backend,
    validatorReleaseTag: strictResult.releaseTag || '',
    validatorKernelVersion: strictResult.kernelVersion || '',
    validatorAttestation: strictResult.validatorAttestation || null,
    validationCompleteness: strictResult.validationCompleteness,
    fallbackActive: strictResult.fallbackActive !== false
  };
}

async function callValidator(payload, options = {}) {
  const response = await fetch(`${VALIDATOR_URL}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal
  });
  let result = {};
  if (typeof response.text === 'function') {
    const text = await response.text();
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = {};
    }
  } else if (typeof response.json === 'function') {
    result = await response.json();
  }
  if (!response.ok) {
    const error = new Error(
      result?.diagnostics?.[0]?.message || `Validator returned ${response.status}`
    );
    error.code = String(result?.code || `VALIDATOR_HTTP_${response.status}`);
    error.statusCode = response.status;
    error.retryableBeforeStart = result?.retryableBeforeStart === true;
    error.details = result?.details || {};
    if (options.includeValidatorObservation) error.validatorObservation = result?.validatorObservation;
    throw error;
  }
  return result;
}

function publicTeacherActivity(value) {
  const allowedKinds = new Set(['context', 'knowledge', 'web', 'skill', 'validator']);
  const allowedStatuses = new Set(['running', 'complete', 'error']);
  const kind = allowedKinds.has(String(value.kind || '')) ? String(value.kind) : 'knowledge';
  const status = allowedStatuses.has(String(value.status || '')) ? String(value.status) : 'running';
  const items = Array.isArray(value.items)
    ? value.items.slice(0, 3).map(publicTeacherActivityItem).filter(Boolean)
    : [];
  return {
    type: 'activity',
    activityId: publicTeacherText(value.activityId, 120) || `${kind}-activity`,
    kind,
    status,
    message: publicTeacherText(value.message, 240) || '正在查阅与问题相关的材料。',
    ...(Number.isFinite(Number(value.count)) ? { count: Math.max(0, Math.min(999, Math.floor(Number(value.count)))) } : {}),
    ...(items.length ? { items } : {})
  };
}

function publicTeacherActivityItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = publicTeacherText(value.title, 180);
  if (!title) return null;
  const detail = publicTeacherText(value.detail, 240);
  const url = publicTeacherHttpUrl(value.url);
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(url ? { url } : {})
  };
}

function publicTeacherText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function publicTeacherHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

async function callPlantUml(payload) {
  const files = normalizeFiles(payload);
  const response = await fetch(`${VALIDATOR_URL}/plantuml`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, files })
  });
  if (!response.ok) throw new Error(`PlantUML renderer returned ${response.status}`);
  return response.json();
}

async function health(courseStore) {
  const result = { ok: true, coursePack: courseStore.packId, validator: null };
  try {
    result.coursePackLoaded = Boolean(courseStore.loadPack());
  } catch (error) {
    result.ok = false;
    result.coursePackLoaded = false;
    result.coursePackError = error.message;
  }
  try {
    const response = await fetch(`${VALIDATOR_URL}/health`);
    result.validator = await response.json();
  } catch (error) {
    result.ok = false;
    result.validator = { ok: false, error: error.message };
  }
  return result;
}

function normalizeFiles(payload) {
  const files = Array.isArray(payload.files)
    ? payload.files.map((file) => ({
        path: file.path || 'main.sysml',
        content: stripUtf8Bom(file.content),
        loadPolicy: file.loadPolicy || 'always'
      }))
    : [{ path: payload.path || payload.entryFile || 'main.sysml', content: stripUtf8Bom(payload.content), loadPolicy: 'always' }];
  return resolveWorkspaceImportClosure(files, { entryFile: payload.entryFile })
    .map((file) => ({ path: file.path, content: file.content }));
}

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(status === 204 ? '' : JSON.stringify(payload, null, 2));
}

function assertTeacherInternalToken() {
  if (TEACHER_INTERNAL_TOKEN) return;
  if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MISSING_AI_TEACHER_INTERNAL_TOKEN_FOR_LOCAL === 'true') return;
  const error = new Error('AI_TEACHER_INTERNAL_TOKEN is required for AI Teacher proxy calls.');
  error.status = 503;
  error.code = 'AI_TEACHER_INTERNAL_TOKEN_REQUIRED';
  throw error;
}

function assertTeacherToolConfiguration() {
  if (TEACHER_TOOL_TOKEN && TEACHER_INTERNAL_TOKEN && TEACHER_TOOL_TOKEN === TEACHER_INTERNAL_TOKEN) {
    const error = new Error('AI_TEACHER_TOOL_TOKEN must be different from AI_TEACHER_INTERNAL_TOKEN.');
    error.code = 'AI_TEACHER_TOOL_TOKEN_NOT_SEPARATE';
    throw error;
  }
  if (TEACHER_TOOL_TOKEN || process.env.NODE_ENV !== 'production') return;
  const error = new Error('AI_TEACHER_TOOL_TOKEN is required for the Validator tool endpoint in production.');
  error.code = 'AI_TEACHER_TOOL_TOKEN_REQUIRED';
  throw error;
}

function requireTeacherToolRequest(req) {
  if (!TEACHER_TOOL_TOKEN) {
    const error = new Error('AI Teacher Validator tool authentication is not configured.');
    error.status = 503;
    error.code = 'AI_TEACHER_TOOL_TOKEN_REQUIRED';
    throw error;
  }
  const supplied = String(req?.headers?.['x-ai-teacher-tool-token'] || '');
  const expected = Buffer.from(TEACHER_TOOL_TOKEN, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return;
  const error = new Error('Invalid AI Teacher Validator tool token.');
  error.status = 401;
  error.code = 'AI_TEACHER_TOOL_TOKEN_INVALID';
  throw error;
}

function assertValidatorToolTimeoutContract() {
  const margin = AI_TEACHER_AGENT_TOOL_TIMEOUT_MS - AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MS;
  if (margin < AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MARGIN_MS) {
    const error = new Error(
      `AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MS must be at least ${AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MARGIN_MS}ms shorter than AI_TEACHER_AGENT_TOOL_TIMEOUT_MS.`
    );
    error.code = 'AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_INVALID';
    throw error;
  }
  if (AI_TEACHER_VALIDATOR_MAX_IN_FLIGHT !== 1) {
    const error = new Error('AI_TEACHER_VALIDATOR_MAX_IN_FLIGHT must be 1 for the current single-process backend.');
    error.code = 'AI_TEACHER_VALIDATOR_CONCURRENCY_INVALID';
    throw error;
  }
  if (AI_TEACHER_VALIDATOR_QUEUE_WAIT_MS
    + AI_TEACHER_VALIDATOR_EXECUTION_TIMEOUT_MS
    + AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MARGIN_MS
    > AI_TEACHER_VALIDATOR_TOOL_TIMEOUT_MS) {
    const error = new Error('Validator tool timeout must cover queue wait plus execution timeout and a 2000ms margin.');
    error.code = 'AI_TEACHER_VALIDATOR_BUDGET_RELATION_INVALID';
    throw error;
  }
}

function sendAuthResult(res, status, result) {
  const headers = responseHeaders(result?.headers);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(result?.body || {}, null, 2));
}

function responseHeaders(headers) {
  if (!headers || typeof headers.forEach !== 'function') return {};
  const output = {};
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers.getSetCookie();
    if (cookies.length) output['set-cookie'] = cookies;
  }
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'set-cookie') {
      output['set-cookie'] = output['set-cookie'] ? uniqueHeaderValues([].concat(output['set-cookie'], value)) : value;
    }
  });
  return output;
}

function uniqueHeaderValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function sendRaw(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-credentials': 'true',
    'cache-control': 'no-store, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: '0'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 250 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readMultipartFile(req, fieldName, limit) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error('上传请求必须使用 multipart/form-data。');
    error.status = 400;
    error.code = 'INVALID_UPLOAD';
    throw error;
  }
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`, 'utf8');
  const body = await readRawBody(req, limit);
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(boundary, offset);
    if (start < 0) break;
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    let part = body.subarray(start + boundary.length, next);
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === '\r\n') part = part.subarray(0, part.length - 2);
    offset = next;
    if (part.length === 0 || part.subarray(0, 2).toString() === '--') continue;
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator < 0) continue;
    const headerText = part.subarray(0, separator).toString('latin1');
    const content = part.subarray(separator + 4);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || '';
    if (name === fieldName && filename) return { filename, buffer: content };
  }
  const error = new Error('未找到课程包文件字段 file。');
  error.status = 400;
  error.code = 'UPLOAD_FILE_MISSING';
  throw error;
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`api listening on ${HOST}:${PORT}`);
  });
}

module.exports = {
  createServer,
  validateWithRules,
  engineeringImprovementApiForTests: Object.freeze({
    automaticContinuationEnvelope,
    automaticContinuationPending,
    engineeringImprovementBudget,
    finalizeAutomaticContinuationFallback,
    projectStudentTeacherStreamEvent,
    publicExecutionContinuation
  })
};

function publicKnowledgePack(value) {
  if (Array.isArray(value)) return value.map(publicKnowledgePack);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'path' && key !== 'extractedPackDir')
    .map(([key, item]) => [key, publicKnowledgePack(item)]));
}

function knowledgeAssetMime(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf'
  })[extension] || 'application/octet-stream';
}
