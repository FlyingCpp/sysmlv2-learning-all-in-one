import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useAppApiClient } from '../../app/use-api-client';
import type { Lesson, ValidationResult, WorkspaceSnapshot } from '../../lib/course/types';
import { BENCH_TEMPLATES, resolveBenchTemplate, type BenchTemplate } from './benchTemplates';
import { WorkbenchPage, type BenchHeaderConfig } from './WorkbenchPage';

export function BenchPage({ templateId = 'sandbox' }: { templateId?: string }) {
  const navigate = useNavigate();
  const selectedTemplate = resolveBenchTemplate(templateId);
  const benchHeader = useMemo<BenchHeaderConfig>(() => ({
    description: selectedTemplate.description,
    selectedTemplateId: selectedTemplate.id,
    selectedTemplateTitle: selectedTemplate.title,
    templates: BENCH_TEMPLATES.map((template) => ({ id: template.id, title: template.title })),
    onTemplateChange: (nextTemplateId) => {
      void navigate({ to: '/bench/$templateId', params: { templateId: nextTemplateId } });
    }
  }), [navigate, selectedTemplate]);
  return (
    <section className="benchPage" data-bench-page>
      <BenchTemplateWorkbench template={selectedTemplate} benchHeader={benchHeader} />
    </section>
  );
}

function BenchTemplateWorkbench({ template, benchHeader }: { template: BenchTemplate; benchHeader: BenchHeaderConfig }) {
  const api = useAppApiClient();
  const entity = useMemo<Lesson>(() => ({
    id: `bench-${template.id}`,
    title: template.title,
    type: 'modeling-bench',
    scenario: {
      body: template.description
    },
    tasks: [{
      id: `${template.id}-validate`,
      prompt: template.taskPrompt || '自由扩展当前 SysML v2 模型，并运行严格语法/语义校验。'
    }],
    workspace: template.workspace
  }), [template]);
  const validateWorkspace = (workspace: WorkspaceSnapshot) => api.request<ValidationResult>('/api/validate', {
    method: 'POST',
    body: workspace
  });
  return (
    <WorkbenchPage
      entity={entity}
      draftId={`bench-${template.id}`}
      mode="bench"
      validateWorkspace={validateWorkspace}
      benchHeader={benchHeader}
    />
  );
}
