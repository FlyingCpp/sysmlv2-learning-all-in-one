import { AlertCircle, Loader2 } from 'lucide-react';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Course, Lesson, ReferenceItem, VisualAsset } from '../../lib/course/types';
import { useCoursePackStore } from '../../app/course-pack-store';
import { localizeWebError } from '../../i18n/error-message';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation('common');
  return (
    <section className="panelState" aria-live="polite">
      <Loader2 size={18} />
      <span>{label || t('states.loading')}</span>
    </section>
  );
}

export function SilentLoadingState() {
  return <section className="routeHydration" aria-hidden="true" />;
}

export function ErrorState({ title, error }: { title?: string; error: unknown }) {
  const { t } = useTranslation(['common', 'errors']);
  const details = localizeWebError(error, t);
  return (
    <section className="panelState error" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{title || t('errors.loadFailed', { ns: 'common' })}</strong>
        <p>{details.message}</p>
      </div>
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <section className="panelState muted">{children}</section>;
}

export function assetUrlForPack(src = '', packId = useCoursePackStore.getState().activeCoursePackId): string {
  if (!src) return '';
  if (!src.startsWith('/api/course-assets/')) return src;
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}coursePackId=${encodeURIComponent(packId || '')}`;
}

export function VisualImage({
  visual,
  className,
  coursePackId
}: {
  visual?: VisualAsset;
  className?: string;
  coursePackId?: string;
}) {
  if (!visual?.src) return null;
  return (
    <img
      className={className}
      src={assetUrlForPack(visual.src, coursePackId)}
      alt={visual.alt || visual.title || '课程视觉图'}
      loading="lazy"
    />
  );
}

export function courseDisplayNumber(course?: Pick<Course, 'id' | 'order'> | null, courses: Course[] = []): string {
  if (course?.order) return String(Number(course.order));
  const courseId = course?.id || '';
  const stateIndex = courses.findIndex((item) => item.id === courseId);
  if (stateIndex >= 0) return String(stateIndex + 1);
  const idMatch = String(courseId).match(/course-(\d+)/i);
  if (idMatch) return String(Number(idMatch[1]));
  return '';
}

export function lessonDisplayNumber(lesson: Partial<Lesson>, course: Course | null, fallbackIndex: number): string {
  const courseNumber = courseDisplayNumber(course);
  const lessonNumber = fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
  if (!courseNumber || !lessonNumber) return '';
  return `${courseNumber}.${lessonNumber}`;
}

export function lessonTypeLabel(type?: string): string {
  const labels: Record<string, string> = {
    'modeling-lesson': '建模练习',
    lesson: '课程练习',
    project: '项目练习'
  };
  return type ? labels[type] || type : '课程练习';
}

export function referenceTypeLabel(type?: string): string {
  const labels: Record<string, string> = {
    standard: '标准章节',
    example: '官方示例',
    guide: '学习材料',
    api: 'API 标准',
    local: '站内示例'
  };
  return type ? labels[type] || type : '材料';
}

export function ReferenceList({ items }: { items?: ReferenceItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const toggleReferenceDrawer = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const drawer = event.currentTarget.closest('.referenceDrawer');
    const drawerTop = drawer?.getBoundingClientRect().top ?? null;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    setOpen((current) => !current);
    requestAnimationFrame(() => {
      if (drawerTop === null || !drawer) {
        window.scrollTo(scrollX, scrollY);
        return;
      }
      const nextTop = drawer.getBoundingClientRect().top;
      window.scrollTo(scrollX, scrollY + nextTop - drawerTop);
      requestAnimationFrame(() => {
        const finalTop = drawer.getBoundingClientRect().top;
        window.scrollTo(scrollX, window.scrollY + finalTop - drawerTop);
      });
    });
  };

  return (
    <details className="referenceDrawer" data-reference-drawer open={open}>
      <summary onClick={toggleReferenceDrawer} aria-expanded={open}>
        <span>参考材料</span>
        <small>{items.length} 个材料 · 默认收起</small>
      </summary>
      <section className="referenceStrip" aria-label="课程参考材料">
        {items.slice(0, 6).map((reference, index) => (
          <article key={`${reference.title || reference.url || index}`} className="referenceCard">
            <span>{referenceTypeLabel(reference.type)}</span>
            <strong>{reference.title || reference.source || '参考材料'}</strong>
            {reference.section ? <p>{reference.section}</p> : null}
            {reference.url || reference.href ? (
              <a href={reference.url || reference.href} target="_blank" rel="noreferrer">打开材料</a>
            ) : null}
          </article>
        ))}
      </section>
    </details>
  );
}
