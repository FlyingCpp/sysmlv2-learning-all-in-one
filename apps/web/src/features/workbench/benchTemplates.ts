import type { WorkspaceSnapshot } from '../../lib/course/types';

export interface BenchTemplate {
  id: string;
  title: string;
  description: string;
  workspace: WorkspaceSnapshot;
  taskPrompt?: string;
}

const SANDBOX_MODEL = `package Sandbox {
  part def Vehicle;
  part vehicle : Vehicle;
}
`;

const INTERFACE_MODEL = `package InterfaceSandbox {
  part def Controller;
  part def Actuator;

  item def Command;

  port def CommandPort {
    out item command : Command;
  }

  part controller : Controller;
  part actuator : Actuator;
}
`;

export const BENCH_TEMPLATES: BenchTemplate[] = [
  {
    id: 'sandbox',
    title: '空白 SysML v2 模型',
    description: '从最小 SysML v2 package 开始自由建模，使用官方 validator 做严格语法/语义检查。',
    taskPrompt: '扩展 Sandbox package，并运行严格语法/语义校验。',
    workspace: {
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: SANDBOX_MODEL, editable: true, source: 'workspace' }]
    }
  },
  {
    id: 'interface-sandbox',
    title: '接口与命令流模型',
    description: '从控制器、执行器和命令对象出发，自由练习 part、item、port 与接口边界建模。',
    taskPrompt: '扩展 InterfaceSandbox package，补充部件边界、端口和命令对象，并运行严格校验。',
    workspace: {
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: INTERFACE_MODEL, editable: true, source: 'workspace' }]
    }
  }
];

export function resolveBenchTemplate(templateId?: string): BenchTemplate {
  return BENCH_TEMPLATES.find((template) => template.id === templateId) || BENCH_TEMPLATES[0];
}
