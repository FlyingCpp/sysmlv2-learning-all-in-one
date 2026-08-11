import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  Course,
  CoursePack,
  GlossaryGraph,
  GlossaryTerm,
  Lesson,
  PlatformAppsRegistry,
  ValidationResult,
  WorkspaceSnapshot
} from '../lib/course/types';
import { useCoursePackStore } from './course-pack-store';
import { useRuntimeConfigStore } from './runtime-config-store';
import { useSessionStore } from './session-store';
import { useAppApiClient } from './use-api-client';

export type CoursePackListResponse = {
  activeCoursePackId: string;
  packs: CoursePack[];
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: import('../lib/course/types').UserProfile | null;
};

export type DraftSnapshot = WorkspaceSnapshot & {
  id?: string;
  coursePackId?: string;
  dataNamespaceId?: string;
  templateSignature?: string;
};

export type ProgressSnapshot = {
  coursePackId?: string;
  dataNamespaceId?: string;
  completedLessons?: string[];
  lessonProgressSteps?: Record<string, number>;
  [key: string]: unknown;
};

export function useRuntimeReady() {
  return useRuntimeConfigStore((state) => state.status === 'ready');
}

export function useAuthMeQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  return useQuery({
    queryKey: ['auth', 'me'],
    enabled: ready,
    retry: false,
    queryFn: () => api.request<AuthMeResponse>('/api/auth/me')
  });
}

export function useCoursePacksQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const user = useSessionStore((state) => state.user);
  return useQuery({
    queryKey: ['course-packs'],
    enabled: ready && Boolean(user),
    queryFn: () => api.request<CoursePackListResponse>('/api/course-packs')
  });
}

export function useCoursePackQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['course-pack', activeCoursePackId],
    enabled: ready,
    placeholderData: keepPreviousData,
    queryFn: () => api.request<CoursePack>('/api/course-pack')
  });
}

export function useCoursesQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['courses', activeCoursePackId],
    enabled: ready,
    placeholderData: keepPreviousData,
    queryFn: () => api.request<Course[]>('/api/courses')
  });
}

export function useCourseQuery(courseId: string) {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['course', activeCoursePackId, courseId],
    enabled: ready && Boolean(courseId),
    queryFn: () => api.request<Course>(`/api/courses/${encodeURIComponent(courseId)}`)
  });
}

export function useLessonQuery(lessonId: string) {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['lesson', activeCoursePackId, lessonId],
    enabled: ready && Boolean(lessonId),
    queryFn: () => api.request<Lesson>(`/api/lessons/${encodeURIComponent(lessonId)}`)
  });
}

export function useFinalProjectQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['final-project', activeCoursePackId],
    enabled: ready,
    queryFn: () => api.request<Lesson>('/api/final-project')
  });
}

export function useDraftQuery(draftId: string) {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['draft', activeCoursePackId, draftId],
    enabled: ready && Boolean(draftId),
    retry: false,
    queryFn: () => api.request<DraftSnapshot>(`/api/drafts/${encodeURIComponent(draftId)}`)
  });
}

export function useProgressQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  return useQuery({
    queryKey: ['progress', activeCoursePackId],
    enabled: ready,
    retry: false,
    queryFn: () => api.request<ProgressSnapshot>('/api/progress')
  });
}

export function useLessonValidationRequest(lessonId: string) {
  const api = useAppApiClient();
  return (workspace: WorkspaceSnapshot) => api.request<ValidationResult>(`/api/lessons/${encodeURIComponent(lessonId)}/validate`, {
    method: 'POST',
    body: workspace
  });
}

export function useFinalProjectValidationRequest() {
  const api = useAppApiClient();
  return (workspace: WorkspaceSnapshot) => api.request<ValidationResult>('/api/final-project/validate', {
    method: 'POST',
    body: workspace
  });
}

export function useAppsQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  return useQuery({
    queryKey: ['platform-apps'],
    enabled: ready,
    queryFn: () => api.request<PlatformAppsRegistry>('/api/apps')
  });
}

export function useGlossaryQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  return useQuery({
    queryKey: ['glossary'],
    enabled: ready,
    queryFn: async () => {
      const result = await api.request<GlossaryTerm[] | { terms?: GlossaryTerm[] }>('/api/glossary');
      return Array.isArray(result) ? result : result.terms || [];
    }
  });
}

export function useGlossaryGraphQuery() {
  const api = useAppApiClient();
  const ready = useRuntimeReady();
  return useQuery({
    queryKey: ['platform-glossary', 'sysml-v2-core', 'graph'],
    enabled: ready,
    queryFn: () => api.request<GlossaryGraph>('/api/platform/glossaries/sysml-v2-core/graph')
  });
}
