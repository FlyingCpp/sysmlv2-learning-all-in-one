import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useCoursesQuery } from '../../app/data-hooks';
import type { Course } from '../../lib/course/types';
import { ErrorState, LoadingState, VisualImage, courseDisplayNumber } from '../shared/ui';

export function CourseListPage() {
  const coursesQuery = useCoursesQuery();
  if (coursesQuery.isLoading) return <LoadingState label="正在加载课程列表" />;
  if (coursesQuery.error) return <ErrorState error={coursesQuery.error} />;
  const courses = coursesQuery.data || [];
  return (
    <section className="courseListPage" data-course-list-page>
      <div className="sectionHeader">
        <div>
          <span className="missionEyebrow">课程地图</span>
          <h2>从语言基础到工程闭环</h2>
          <p>按 Course 顺序阅读概念，再进入 Lesson Workbench 完成建模练习。</p>
        </div>
        <span>{courses.length} 个 Course</span>
      </div>
      <div className="courseGrid">
        {courses.map((course) => <CourseCard key={course.id} course={course} courses={courses} />)}
      </div>
    </section>
  );
}

function CourseCard({ course, courses }: { course: Course; courses: Course[] }) {
  const number = courseDisplayNumber(course, courses);
  const thumbnail = course.thumbnail || course.visual;
  return (
    <article className="courseCard">
      <VisualImage visual={thumbnail} className="courseThumb" />
      <div className="courseCardBody">
        <span>Course {number || course.id}</span>
        <h3>{course.title || course.id}</h3>
        <p>{course.summary || course.description || ''}</p>
        <div className="courseCardObjectives">
          {course.objectives?.length ? (
            <ul>
              {course.objectives.slice(0, 2).map((objective) => <li key={objective}>{objective}</li>)}
            </ul>
          ) : null}
        </div>
        <Link to="/courses/$courseId" params={{ courseId: course.id }}>
          查看 Course
          <ArrowRight size={16} />
        </Link>
      </div>
    </article>
  );
}
