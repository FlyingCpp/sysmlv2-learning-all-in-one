'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, '.tmp', 'web-i18n');
const locales = ['zh-CN', 'en-US'];
const namespaces = ['auth', 'common', 'errors', 'shell'];

cleanOutputDir(outRoot);
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  runTsc();
  testCatalogs();
  testLocaleResolution();
  testPreferencePersistence();
  await testLocaleSwitching();
  testLocaleProjection();
  testErrorLocalization();
  testFormatting();
  testWiringContracts();
  console.log('web i18n tests passed');
}

function testCatalogs() {
  const catalogs = Object.fromEntries(locales.map((locale) => [
    locale,
    Object.fromEntries(namespaces.map((namespace) => [namespace, readCatalog(locale, namespace)]))
  ]));

  for (const namespace of namespaces) {
    const zhEntries = flattenCatalog(catalogs['zh-CN'][namespace]);
    const enEntries = flattenCatalog(catalogs['en-US'][namespace]);
    assert.deepStrictEqual(
      semanticKeys(enEntries),
      semanticKeys(zhEntries),
      `${namespace} semantic keys must match across locales`
    );
    validateCatalogEntries('zh-CN', namespace, zhEntries);
    validateCatalogEntries('en-US', namespace, enEntries);
    validatePlaceholderCompatibility(namespace, zhEntries, enEntries);
  }

  assert.strictEqual(catalogs['zh-CN'].shell.language.zhCN, '中文（简体）');
  assert.strictEqual(catalogs['en-US'].shell.language.zhCN, '中文（简体）');
  assert.strictEqual(catalogs['zh-CN'].shell.language.enUS, 'English');
  assert.strictEqual(catalogs['en-US'].shell.language.enUS, 'English');
}

function testLocaleResolution() {
  const locale = requireCompiled('i18n/locale.js');
  assert.strictEqual(locale.matchSupportedLocale('en-GB'), 'en-US');
  assert.strictEqual(locale.matchSupportedLocale('EN_us'), 'en-US');
  assert.strictEqual(locale.matchSupportedLocale('zh-Hans'), 'zh-CN');
  assert.strictEqual(locale.matchSupportedLocale('zh-SG'), 'zh-CN');
  assert.strictEqual(locale.matchSupportedLocale('zh-Hant'), null);
  assert.strictEqual(locale.matchSupportedLocale('fr-FR'), null);
  assert.strictEqual(locale.resolveInitialLocale('en-US', ['zh-CN']), 'en-US');
  assert.strictEqual(locale.resolveInitialLocale('damaged', ['en-GB']), 'en-US');
  assert.strictEqual(locale.resolveInitialLocale(null, ['fr-FR', 'zh-Hans']), 'zh-CN');
  assert.strictEqual(locale.resolveInitialLocale(null, ['fr-FR']), 'zh-CN');
  assert.strictEqual(
    locale.getResolvedLocale({ resolvedLanguage: 'en-GB', languages: ['en-GB', 'en'], language: 'en-GB' }),
    'en-US'
  );
  assert.strictEqual(
    locale.getResolvedLocale({ resolvedLanguage: undefined, languages: [], language: 'unsupported' }),
    'zh-CN'
  );
}

function testPreferencePersistence() {
  const locale = requireCompiled('i18n/locale.js');
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  assert.strictEqual(locale.readLocalePreference(storage), null);
  assert.strictEqual(locale.persistLocalePreference('en-US', storage), true);
  assert.strictEqual(values.get(locale.LOCALE_PREFERENCE_KEY), 'en-US');
  assert.strictEqual(locale.readLocalePreference(storage), 'en-US');
  const failingStorage = {
    getItem: () => { throw new Error('read denied'); },
    setItem: () => { throw new Error('write denied'); }
  };
  assert.strictEqual(locale.readLocalePreference(failingStorage), null);
  assert.strictEqual(locale.persistLocalePreference('zh-CN', failingStorage), false);
}

async function testLocaleSwitching() {
  const { switchPlatformLocale } = requireCompiled('i18n/locale-switch.js');
  const persisted = [];
  const instance = createLanguageInstance('zh-CN');
  assert.strictEqual(await switchPlatformLocale(instance, 'en-US', (locale) => { persisted.push(locale); return true; }), 'changed');
  assert.strictEqual(instance.resolvedLanguage, 'en-US');
  assert.deepStrictEqual(persisted, ['en-US']);

  const mismatch = createLanguageInstance('zh-CN', { refuse: 'en-US' });
  assert.strictEqual(await switchPlatformLocale(mismatch, 'en-US', () => { throw new Error('must not persist'); }), 'changeFailed');
  assert.strictEqual(mismatch.resolvedLanguage, 'zh-CN');

  const writeFailure = createLanguageInstance('zh-CN');
  assert.strictEqual(await switchPlatformLocale(writeFailure, 'en-US', () => false), 'persistenceFailed');
  assert.strictEqual(writeFailure.resolvedLanguage, 'en-US');
}

function testLocaleProjection() {
  const { applyLocaleProjection } = requireCompiled('i18n/projection.js');
  const target = { documentElement: { lang: 'zh-CN', dir: 'ltr' }, title: '中文' };
  applyLocaleProjection('en-US', 'English title', target);
  assert.deepStrictEqual(target, {
    documentElement: { lang: 'en-US', dir: 'ltr' },
    title: 'English title'
  });
}

function testErrorLocalization() {
  const { localizeErrorCode, localizeWebError } = requireCompiled('i18n/error-message.js');
  const t = (key, options = {}) => `${options.ns || 'common'}:${key}`;
  assert.deepStrictEqual(localizeErrorCode('AUTH_REQUIRED', t, 401), {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: 'errors:codes.AUTH_REQUIRED'
  });
  assert.strictEqual(localizeErrorCode('UNKNOWN', t, 503).message, 'errors:generic.serviceUnavailable');
  assert.strictEqual(localizeErrorCode('UNKNOWN', t, 0).message, 'errors:generic.requestFailed');
  const error = new Error('服务端中文不应成为英文主文案');
  error.code = 'RATE_LIMIT_EXCEEDED';
  error.status = 429;
  assert.strictEqual(localizeWebError(error, t).message, 'errors:codes.RATE_LIMIT_EXCEEDED');
}

function testFormatting() {
  const format = requireCompiled('i18n/format.js');
  assert.strictEqual(format.formatNumber(1234.5, 'en-US'), '1,234.5');
  assert(format.formatPercent(0.5, 'en-US').includes('50'));
  assert(format.formatDate(new Date('2026-08-10T00:00:00Z'), 'zh-CN', { timeZone: 'UTC' }).length > 0);
}

function testWiringContracts() {
  const main = read('apps/web/src/main.tsx');
  const provider = read('apps/web/src/i18n/I18nProvider.tsx');
  const projection = read('apps/web/src/i18n/projection.ts');
  const switcher = read('apps/web/src/i18n/LanguageSwitcher.tsx');
  const appCss = read('apps/web/src/styles/app.css');
  const shell = read('apps/web/src/app/AppShell.tsx');
  const login = read('apps/web/src/features/auth/LoginPage.tsx');
  const sharedUi = read('apps/web/src/features/shared/ui.tsx');
  assert(main.indexOf('await initializeI18n()') < main.indexOf('createRoot(rootElement).render('));
  assert(main.indexOf('applyLocaleProjection(') < main.indexOf('createRoot(rootElement).render('));
  assert(provider.includes('ThemeProvider') && provider.includes('getResolvedLocale(i18n)'));
  assert(provider.includes('useLayoutEffect') && provider.includes('applyLocaleProjection(locale'));
  assert(projection.includes('target.documentElement.lang = locale'));
  assert(switcher.includes('switchPlatformLocale(platformI18n, targetLocale)'));
  assert(switcher.includes('<select') && switcher.includes('className="languageSwitcherSelect"'));
  assert(switcher.includes('<option value="zh-CN">CN</option>'));
  assert(switcher.includes('<option value="en-US">EN</option>'));
  assert(!switcher.includes('languageSwitcherButton') && !switcher.includes('aria-pressed'));
  assert(appCss.includes('.languageSwitcher::after'));
  assert(appCss.includes('appearance: none') && appCss.includes('width: 34px'));
  assert(appCss.includes('height: 30px') && appCss.includes('min-height: 30px'));
  assert(appCss.includes('padding: 0 13px 0 4px'));
  assert(appCss.includes('font: 700 9px/1 var(--font-sans)'));
  assert(shell.includes('<LanguageSwitcher />'));
  assert(shell.includes("t('brand.name')") && shell.includes("t('navigation.guide')"));
  assert(login.includes("t('form.email'") && login.includes('localizeWebError'));
  assert(!sharedUi.includes('details.code ?') && !sharedUi.includes('<small>{details.code}</small>'));
  assert(!read('package.json').includes('i18next-browser-languagedetector'));
}

function createLanguageInstance(initialLocale, options = {}) {
  return {
    language: initialLocale,
    resolvedLanguage: initialLocale,
    languages: [initialLocale],
    async changeLanguage(locale) {
      if (options.refuse === locale) return;
      this.language = locale;
      this.resolvedLanguage = locale;
      this.languages = [locale];
    }
  };
}

function readCatalog(locale, namespace) {
  return JSON.parse(read(`apps/web/src/i18n/resources/${locale}/${namespace}.json`));
}

function flattenCatalog(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output[nextKey] = child;
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenCatalog(child, nextKey, output);
    else assert.fail(`Translation ${nextKey} must be a string or object`);
  }
  return output;
}

function semanticKeys(entries) {
  return [...new Set(Object.keys(entries).map(semanticKey))].sort();
}

function semanticKey(key) {
  return key.replace(/_(zero|one|two|few|many|other)$/, '');
}

function validateCatalogEntries(locale, namespace, entries) {
  for (const [key, value] of Object.entries(entries)) {
    assert(value.trim(), `${locale}/${namespace}:${key} must not be empty`);
    assert(!/\bTODO\b/i.test(value), `${locale}/${namespace}:${key} must not contain TODO`);
    assert(!/<[a-z][^>]*>/i.test(value), `${locale}/${namespace}:${key} must not contain raw HTML`);
  }
}

function validatePlaceholderCompatibility(namespace, zhEntries, enEntries) {
  for (const baseKey of semanticKeys(zhEntries)) {
    const zhPlaceholders = placeholdersForSemanticKey(zhEntries, baseKey);
    const enPlaceholders = placeholdersForSemanticKey(enEntries, baseKey);
    assert.deepStrictEqual(enPlaceholders, zhPlaceholders, `${namespace}:${baseKey} placeholders must match`);
  }
}

function placeholdersForSemanticKey(entries, baseKey) {
  const placeholders = new Set();
  for (const [key, value] of Object.entries(entries)) {
    if (semanticKey(key) !== baseKey) continue;
    for (const match of value.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)) placeholders.add(match[1]);
  }
  return [...placeholders].sort();
}

function runTsc() {
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', 'apps/web/tsconfig.i18n.json'], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function cleanOutputDir(dir) {
  const resolved = path.resolve(dir);
  const allowedRoot = path.resolve(root, '.tmp');
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`Refusing to remove unexpected output: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function requireCompiled(relativePath) {
  return require(path.join(outRoot, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}
