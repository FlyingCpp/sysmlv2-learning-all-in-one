import { Bot, ShieldCheck } from 'lucide-react';
import { AiTeacherPanel } from './AiTeacherPanel';
import type { Lesson, WorkspaceSnapshot } from '../../lib/course/types';

const sandboxWorkspace: WorkspaceSnapshot = {
  entryFile: 'main.sysml',
  activeFilePath: 'main.sysml',
  files: [{
    path: 'main.sysml',
    content: [
      'package AiTeacherScratch {',
      '  // TODO: 试着描述你想建模的结构、接口或需求。',
      '}'
    ].join('\n'),
    editable: true,
    source: 'workspace'
  }]
};

const sandboxLesson: Lesson = {
  id: 'ai-teacher-page',
  title: 'SysML v2 AI 教师',
  courseId: 'react-phase4',
  tasks: [{
    id: 'ask',
    title: '自由提问',
    prompt: '围绕当前 SysML v2 建模、课程目标或 validator 诊断提问。'
  }],
  workspace: sandboxWorkspace
};

export function AiTeacherPage() {
  return (
    <section className="aiTeacherPage" data-ai-teacher-page data-react-phase4-ai-teacher>
      <header className="phase4Hero">
        <span className="missionEyebrow">AI Assistant</span>
        <h2>SysML v2 AI 教师</h2>
        <p>在独立助手面板中围绕课程、代码、诊断和 TODO 连续提问，必要时给出模型诊断和可验证的单行补全建议。</p>
      </header>
      <div className="aiTeacherPageGrid">
        <section className="panel aiTeacherPageIntro">
          <div className="runtimePanelHeader">
            <Bot size={18} />
            <h3>上下文边界</h3>
          </div>
          <p>页面模式使用一个轻量 scratch workspace；进入 Lesson Workbench 时，AI 教师会使用真实课程、代码、诊断和草稿上下文。</p>
          <div className="phase4Checklist">
            <span><ShieldCheck size={14} />stream drawer</span>
            <span><ShieldCheck size={14} />stop / retry ready</span>
            <span><ShieldCheck size={14} />patch validate</span>
            <span><ShieldCheck size={14} />TODO hint ladder</span>
          </div>
        </section>
        <AiTeacherPanel
          lesson={sandboxLesson}
          workspace={sandboxWorkspace}
          activeFilePath="main.sysml"
          defaultOpen
        />
      </div>
    </section>
  );
}
