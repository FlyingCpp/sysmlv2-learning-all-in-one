import { create } from 'zustand';

export type RuntimeConfig = {
  apiBaseUrl: string;
  aiTeacherEnabled: boolean;
  sysonViewServiceUrl: string;
  externalModelingTools: ExternalModelingToolRuntime[];
};

export type ExternalModelingToolRuntime = {
  toolId: string;
  displayName: string;
  enabled: boolean;
  frontendVisible: boolean;
  viewServiceUrl: string;
  capabilities: {
    read: boolean;
    modelGeneration: boolean;
    directWrite: boolean;
  };
};

type RuntimeConfigState = {
  config: RuntimeConfig | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string;
  loadConfig: (signal?: AbortSignal) => Promise<void>;
};

export const useRuntimeConfigStore = create<RuntimeConfigState>((set) => ({
  config: null,
  status: 'idle',
  error: '',
  async loadConfig(signal) {
    set({ status: 'loading', error: '' });
    try {
      const response = await fetch('/config.json', {
        credentials: 'include',
        signal
      });
      if (!response.ok) throw new Error(`config request failed: ${response.status}`);
      const staticConfig = await response.json() as Omit<RuntimeConfig, 'externalModelingTools'>;
      const apiBaseUrl = String(staticConfig.apiBaseUrl || '').replace(/\/$/u, '');
      let externalModelingTools: ExternalModelingToolRuntime[] = [];
      try {
        const toolsResponse = await fetch(`${apiBaseUrl}/api/external-modeling-tools`, {
          credentials: 'include',
          signal
        });
        if (toolsResponse.ok) {
          const toolsPayload = await toolsResponse.json() as { tools?: ExternalModelingToolRuntime[] };
          externalModelingTools = Array.isArray(toolsPayload.tools) ? toolsPayload.tools : [];
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
      }
      const syson = externalModelingTools.find((tool) => tool.toolId === 'syson');
      set({
        config: {
          ...staticConfig,
          externalModelingTools,
          sysonViewServiceUrl: syson?.enabled && syson.frontendVisible ? syson.viewServiceUrl : ''
        },
        status: 'ready',
        error: ''
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      set({
        status: 'failed',
        error: error instanceof Error ? error.message : 'config request failed'
      });
    }
  }
}));
