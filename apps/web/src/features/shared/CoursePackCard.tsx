import { useNavigate } from '@tanstack/react-router';
import { startTransition, type KeyboardEvent, type MouseEvent } from 'react';
import type { CoursePack } from '../../lib/course/types';
import { useCoursePackStore } from '../../app/course-pack-store';
import { VisualImage } from './ui';

export function CoursePackCard({
  pack
}: {
  pack: CoursePack;
}) {
  const navigate = useNavigate();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  const setActiveCoursePackId = useCoursePackStore((state) => state.setActiveCoursePackId);
  const active = pack.id === activeCoursePackId;
  const enterActiveCourse = () => {
    if (!active) return;
    void navigate({ to: '/courses' });
  };
  const switchPack = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (active) {
      enterActiveCourse();
      return;
    }
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    startTransition(() => {
      setActiveCoursePackId(pack.id);
    });
    requestAnimationFrame(() => {
      window.scrollTo(scrollX, scrollY);
      requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
    });
  };
  const activateCard = () => {
    enterActiveCourse();
  };
  const activateCardWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    enterActiveCourse();
  };

  return (
    <article
      className={`coursePackGalleryCard${active ? ' isActive' : ''}`}
      data-active-course-pack-card={active ? pack.id : undefined}
      tabIndex={active ? 0 : undefined}
      onClick={activateCard}
      onKeyDown={activateCardWithKeyboard}
    >
      {pack.homeVisual?.src ? (
        <VisualImage visual={pack.homeVisual} coursePackId={pack.id} />
      ) : (
        <div className="coursePackGalleryFallback" aria-hidden="true" />
      )}
      <div className="coursePackGalleryBody">
        <div>
          <span>{pack.domain || pack.language || '课程包'}</span>
          <h4>{pack.title || pack.id}</h4>
          <p>{pack.description || ''}</p>
        </div>
        <div className="coursePackGalleryFooter">
          <small>{pack.version || ''} · SysML {pack.sysmlVersion || ''}</small>
          <button
            type="button"
            data-switch-course-pack={pack.id}
            aria-pressed={active}
            onClick={switchPack}
          >
            {active ? '正在学习' : '切换学习'}
          </button>
        </div>
      </div>
    </article>
  );
}
