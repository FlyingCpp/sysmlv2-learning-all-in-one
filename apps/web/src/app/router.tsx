import {
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router';
import { Suspense, lazy, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell } from './AppShell';
import { AuthGate } from '../features/auth/AuthGate';
import { LoginPage } from '../features/auth/LoginPage';
import { Phase0RouteContent } from './Phase0RouteContent';

const AdminPage = lazy(() => import('../features/admin/AdminPage').then((module) => ({ default: module.AdminPage })));
const CoursePackAdminPage = lazy(() => import('../features/admin/AdminPage').then((module) => ({ default: module.CoursePackAdminPage })));
const AiTeacherAdminPage = lazy(() => import('../features/admin/AdminPage').then((module) => ({ default: module.AiTeacherAdminPage })));
const ExternalModelingToolsAdminPage = lazy(() => import('../features/admin/ExternalModelingToolsAdminPage').then((module) => ({ default: module.ExternalModelingToolsAdminPage })));
const AiTeacherPage = lazy(() => import('../features/ai-teacher/AiTeacherPage').then((module) => ({ default: module.AiTeacherPage })));
const AppsPage = lazy(() => import('../features/apps/AppsPage').then((module) => ({ default: module.AppsPage })));
const CourseDetailPage = lazy(() => import('../features/courses/CourseDetailPage').then((module) => ({ default: module.CourseDetailPage })));
const CourseListPage = lazy(() => import('../features/courses/CourseListPage').then((module) => ({ default: module.CourseListPage })));
const CourseShelfPage = lazy(() => import('../features/home/HomePage').then((module) => ({ default: module.CourseShelfPage })));
const GlossaryPage = lazy(() => import('../features/glossary/GlossaryPage').then((module) => ({ default: module.GlossaryPage })));
const BenchPage = lazy(() => import('../features/workbench/BenchPage').then((module) => ({ default: module.BenchPage })));
const HomePage = lazy(() => import('../features/home/HomePage').then((module) => ({ default: module.HomePage })));
const KnowledgeIndexPage = lazy(() => import('../features/knowledge/KnowledgePage').then((module) => ({ default: module.KnowledgeIndexPage })));
const KnowledgePage = lazy(() => import('../features/knowledge/KnowledgePage').then((module) => ({ default: module.KnowledgePage })));
const KnowledgePackAdminPage = lazy(() => import('../features/knowledge/KnowledgePackAdminPage').then((module) => ({ default: module.KnowledgePackAdminPage })));
const FinalProjectWorkbenchPage = lazy(() => import('../features/workbench/WorkbenchPage').then((module) => ({ default: module.FinalProjectWorkbenchPage })));
const LessonWorkbenchPage = lazy(() => import('../features/workbench/WorkbenchPage').then((module) => ({ default: module.LessonWorkbenchPage })));

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: NotFoundRouteContent
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <AuthGate><LazyRoute><HomePage /></LazyRoute></AuthGate>
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: () => <LazyRoute><LoginPage /></LazyRoute>
});

const coursesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'courses',
  component: () => <AuthGate><LazyRoute><CourseListPage /></LazyRoute></AuthGate>
});

const courseShelfRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'course-shelf',
  component: () => <AuthGate><LazyRoute><CourseShelfPage /></LazyRoute></AuthGate>
});

const knowledgeIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'knowledge',
  component: () => <AuthGate><LazyRoute><KnowledgeIndexPage /></LazyRoute></AuthGate>
});

const knowledgeTopicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'knowledge/$packId/$topicId',
  component: KnowledgeTopicRoute
});

const courseDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'courses/$courseId',
  component: CourseDetailRoute
});

const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'apps',
  component: () => <AuthGate><LazyRoute><AppsPage /></LazyRoute></AuthGate>
});

const glossaryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'glossary',
  component: () => <AuthGate><LazyRoute><GlossaryPage /></LazyRoute></AuthGate>
});

const lessonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'lesson/$lessonId',
  component: LessonWorkbenchRoute
});

const finalProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'final-project',
  component: () => <AuthGate><LazyRoute><FinalProjectWorkbenchPage /></LazyRoute></AuthGate>
});

const aiTeacherRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'ai-teacher',
  component: () => <AuthGate><LazyRoute><AiTeacherPage /></LazyRoute></AuthGate>
});

const benchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'bench',
  component: () => <AuthGate><LazyRoute><BenchPage /></LazyRoute></AuthGate>
});

const benchTemplateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'bench/$templateId',
  component: BenchTemplateRoute
});

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workbench',
  component: () => <AuthGate><LazyRoute><BenchPage /></LazyRoute></AuthGate>
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  component: () => <AuthGate><LazyRoute><AdminPage /></LazyRoute></AuthGate>
});

const coursePackAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/course-packs',
  component: () => <AuthGate><LazyRoute><CoursePackAdminPage /></LazyRoute></AuthGate>
});

const knowledgePackAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/knowledge-packs',
  component: () => <AuthGate><LazyRoute><KnowledgePackAdminPage /></LazyRoute></AuthGate>
});

const aiTeacherAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/ai-teacher',
  component: () => <AuthGate><LazyRoute><AiTeacherAdminPage /></LazyRoute></AuthGate>
});

const externalModelingToolsAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/external-modeling-tools',
  component: () => <AuthGate><LazyRoute><ExternalModelingToolsAdminPage /></LazyRoute></AuthGate>
});

const placeholderRoutes = [createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/audit',
  component: AuditLogPlaceholder
})];

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  courseShelfRoute,
  knowledgeIndexRoute,
  knowledgeTopicRoute,
  coursesRoute,
  courseDetailRoute,
  appsRoute,
  glossaryRoute,
  lessonRoute,
  finalProjectRoute,
  aiTeacherRoute,
  benchRoute,
  benchTemplateRoute,
  workbenchRoute,
  adminRoute,
  coursePackAdminRoute,
  knowledgePackAdminRoute,
  aiTeacherAdminRoute,
  externalModelingToolsAdminRoute,
  ...placeholderRoutes
]);

const router = createRouter({
  routeTree,
  history: createHashHistory()
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}

function CourseDetailRoute() {
  const { courseId } = courseDetailRoute.useParams();
  return <AuthGate><LazyRoute><CourseDetailPage courseId={courseId} /></LazyRoute></AuthGate>;
}

function LessonWorkbenchRoute() {
  const { lessonId } = lessonRoute.useParams();
  return <AuthGate><LazyRoute><LessonWorkbenchPage lessonId={lessonId} /></LazyRoute></AuthGate>;
}

function BenchTemplateRoute() {
  const { templateId } = benchTemplateRoute.useParams();
  return <AuthGate><LazyRoute><BenchPage templateId={templateId} /></LazyRoute></AuthGate>;
}

function KnowledgeTopicRoute() {
  const { packId, topicId } = knowledgeTopicRoute.useParams();
  return <AuthGate><LazyRoute><KnowledgePage packId={packId} topicId={topicId} /></LazyRoute></AuthGate>;
}

function LazyRoute({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="routeHydration" aria-hidden="true" />}>
      {children}
    </Suspense>
  );
}

function NotFoundRouteContent() {
  const { t } = useTranslation('shell');
  return (
    <Phase0RouteContent
      eyebrow={t('routes.notFoundEyebrow')}
      title={t('routes.notFoundTitle')}
      description={t('routes.notFoundDescription')}
    />
  );
}

function AuditLogPlaceholder() {
  const { t } = useTranslation('shell');
  return (
    <Phase0RouteContent
      eyebrow={t('routes.adminEyebrow')}
      title={t('routes.auditTitle')}
      description={t('routes.auditDescription')}
    />
  );
}
