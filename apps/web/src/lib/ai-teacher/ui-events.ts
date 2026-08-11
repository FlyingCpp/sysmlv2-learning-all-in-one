export type AiTeacherPanelAction = 'toggle' | 'open' | 'close';

export const AI_TEACHER_PANEL_EVENT = 'sysmlv2:ai-teacher-panel';
const AI_TEACHER_PANEL_REQUEST_KEY = 'sysmlv2.aiTeacher.pendingPanelAction';

export function requestAiTeacherPanel(action: AiTeacherPanelAction = 'toggle') {
  window.dispatchEvent(new CustomEvent(AI_TEACHER_PANEL_EVENT, { detail: { action } }));
}

export function requestPersistentAiTeacherPanel(action: AiTeacherPanelAction = 'open') {
  try {
    sessionStorage.setItem(AI_TEACHER_PANEL_REQUEST_KEY, action);
  } catch {
    // Session storage can be unavailable in restricted browser modes.
  }
  requestAiTeacherPanel(action);
}

export function consumePendingAiTeacherPanelAction(): AiTeacherPanelAction | null {
  try {
    const value = sessionStorage.getItem(AI_TEACHER_PANEL_REQUEST_KEY);
    sessionStorage.removeItem(AI_TEACHER_PANEL_REQUEST_KEY);
    return value === 'open' || value === 'close' || value === 'toggle' ? value : null;
  } catch {
    return null;
  }
}
