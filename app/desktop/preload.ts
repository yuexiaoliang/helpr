import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceBridge, WorkspaceEvent } from '../shared/contracts';

const bridge: WorkspaceBridge = {
  request: (command) =>
    ipcRenderer.invoke('workspace-request', command) as Promise<unknown>,
  subscribe: (listener) => {
    const handler = (_event: unknown, value: WorkspaceEvent) => listener(value);
    ipcRenderer.on('workspace-event', handler);
    return () => ipcRenderer.removeListener('workspace-event', handler);
  },
};
contextBridge.exposeInMainWorld('workspace', Object.freeze(bridge));
