export function shouldScopeCoursePack(path: string): boolean {
  const value = String(path || '');
  if (!value.startsWith('/api/')) return false;
  return !(
    value.startsWith('/api/auth/')
    || value.startsWith('/api/course-packs')
    || value.startsWith('/api/admin/')
    || value.startsWith('/api/ai-teacher/')
    || value === '/api/glossary'
    || value.startsWith('/api/glossary?')
  );
}

export function scopeCoursePackPath(path: string, activeCoursePackId?: string | null): string {
  if (!activeCoursePackId || !shouldScopeCoursePack(path)) return path;
  const value = String(path || '');
  const hashIndex = value.indexOf('#');
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);
  if (!params.has('coursePackId')) params.set('coursePackId', activeCoursePackId);
  const suffix = params.toString();
  return `${suffix ? `${pathname}?${suffix}` : pathname}${hash}`;
}
