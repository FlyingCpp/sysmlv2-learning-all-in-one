import { Link } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useCourseQuery, useCoursesQuery } from '../../app/data-hooks';
import type { Course, Lesson } from '../../lib/course/types';
import {
  ErrorState,
  LoadingState,
  ReferenceList,
  VisualImage,
  courseDisplayNumber,
  lessonDisplayNumber,
  lessonTypeLabel
} from '../shared/ui';

export function CourseDetailPage({ courseId }: { courseId: string }) {
  const courseQuery = useCourseQuery(courseId);
  const coursesQuery = useCoursesQuery();
  if (courseQuery.isLoading) return <LoadingState label="正在加载课程" />;
  if (courseQuery.error) return <ErrorState error={courseQuery.error} />;
  const course = courseQuery.data;
  if (!course) return <ErrorState error={new Error('Course not found')} />;
  const courses = coursesQuery.data || [];
  const order = courseDisplayNumber(course, courses);
  const lessons = normalizeLessons(course);
  const thumbnail = course.thumbnail || course.visual;

  return (
    <section className="courseDetailPage" data-course-detail-page>
      <CourseQuickNav course={course} courses={courses} />
      <div className="courseDetailHero">
        <div className="courseDetailCopy">
          <span className="missionEyebrow">{order ? `Course ${String(order).padStart(2, '0')}` : 'Course'}</span>
          <h2>{course.title || course.id}</h2>
          <p>{course.summary || course.description || ''}</p>
          {course.objectives?.length ? (
            <div className="courseDetailOutcomes">
              <h3>学完后应能做到</h3>
              <ul>{course.objectives.slice(0, 4).map((item) => <li key={item}>{rephraseCourseOutcome(item)}</li>)}</ul>
            </div>
          ) : null}
          {course.concepts?.length ? (
            <div className="courseConceptChips">
              {course.concepts.slice(0, 10).map((concept) => <span key={concept}>{concept}</span>)}
            </div>
          ) : null}
        </div>
        <figure className="courseDetailVisual">
          <VisualImage visual={thumbnail} />
          <figcaption>{courseDetailImageCaption(course)}</figcaption>
        </figure>
      </div>

      <div className="courseLessonHeader">
        <h3>{order ? `Course ${order} Lessons` : 'Lessons'}</h3>
        <span>{lessons.length} 个练习</span>
      </div>
      <div className="courseLessonGrid">
        {lessons.map((lesson, index) => (
          <LessonCard key={lesson.id || index} lesson={lesson} course={course} index={index} />
        ))}
      </div>
      <ConceptStrip course={course} />
      <ReferenceList items={course.references} />
    </section>
  );
}

function CourseQuickNav({ course, courses }: { course: Course; courses: Course[] }) {
  const currentIndex = courses.findIndex((item) => item.id === course.id);
  const previousCourse = currentIndex > 0 ? courses[currentIndex - 1] : null;
  const nextCourse = currentIndex >= 0 && currentIndex < courses.length - 1 ? courses[currentIndex + 1] : null;
  return (
    <nav className="courseDetailNav" data-course-detail-nav aria-label="Course 快速跳转">
      {previousCourse ? (
        <Link to="/courses/$courseId" params={{ courseId: previousCourse.id }}><ArrowLeft size={16} />上一课</Link>
      ) : <span aria-disabled="true">上一课</span>}
      <Link to="/courses">返回课程主页</Link>
      {nextCourse ? (
        <Link to="/courses/$courseId" params={{ courseId: nextCourse.id }}>下一课<ArrowRight size={16} /></Link>
      ) : <span aria-disabled="true">下一课</span>}
    </nav>
  );
}

function LessonCard({ lesson, course, index }: { lesson: Lesson; course: Course; index: number }) {
  const number = lessonDisplayNumber(lesson, course, index);
  return (
    <article className="courseLessonCard">
      <span>Lesson {number || index + 1}</span>
      <h3>{number ? `${number} ${lesson.title || lesson.id}` : lesson.title || lesson.id}</h3>
      <p>{lessonTypeLabel(lesson.type)}</p>
      <a href={`#/lesson/${encodeURIComponent(lesson.id)}`}>开始学习</a>
    </article>
  );
}

function ConceptStrip({ course }: { course: Course }) {
  const concepts = course.conceptExplanations || [];
  if (!concepts.length) return null;
  return (
    <details className="conceptDrawer" data-concept-drawer>
      <summary>本 Course 概念解释 · {concepts.length} 项</summary>
      <div className="conceptGrid">
        {concepts.slice(0, 8).map((concept) => (
          <article key={concept.id || concept.term} className="conceptCard" data-concept-card>
            <h4>{concept.term || concept.name || concept.id}</h4>
            {concept.aliases?.length ? <p>{concept.aliases.join(' / ')}</p> : null}
            <strong>{concept.metamodelType || concept.source}</strong>
            <p>{concept.explanation || concept.definition || concept.description}</p>
            {concept.engineeringExample ? <small>{concept.engineeringExample}</small> : null}
          </article>
        ))}
      </div>
    </details>
  );
}

function normalizeLessons(course: Course): Lesson[] {
  return (course.lessons || []).map((lesson, index) => {
    if (typeof lesson === 'string') {
      return { id: lesson.split('/').slice(-2, -1)[0] || `lesson-${index}`, title: lesson, courseId: course.id };
    }
    return { ...lesson, courseId: lesson.courseId || course.id };
  });
}

function rephraseCourseOutcome(text = '') {
  const value = String(text || '').trim();
  if (!value) return '能把本课工程问题落到可检查的 SysML v2 模型元素。';
  if (/^理解/.test(value)) return value.replace(/^理解/, '能用自己的话说明');
  if (/^识别/.test(value)) return value.replace(/^识别/, '能在模型中找到');
  if (/^能/.test(value)) return value;
  return `能${value}`;
}

function courseDetailImageCaption(course: Course) {
  const order = Number(course.order || 0);
  const prefix = order ? `Course ${String(order).padStart(2, '0')}` : '本 Course';
  const conceptText = course.concepts?.slice(0, 3).join('、');
  return conceptText
    ? `${prefix} 的工程视图：先看图中的对象边界，再回到 lesson 中查找 ${conceptText}。`
    : `${prefix} 的工程视图：先看图中的对象边界，再回到 lesson 中写模型。`;
}
