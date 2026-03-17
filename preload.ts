import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  createSession: (): Promise<unknown> => ipcRenderer.invoke('session:create'),
  killSession: (id: string): Promise<void> => ipcRenderer.invoke('session:kill', id),
  listSessions: (): Promise<unknown[]> => ipcRenderer.invoke('session:list'),
  getBuffer: (id: string): Promise<string> => ipcRenderer.invoke('session:buffer', id),

  setActiveSession: (id: string): void => ipcRenderer.send('session:active', id),
  sendInput: (id: string, data: string): void => ipcRenderer.send('session:input', id, data),
  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('session:resize', id, cols, rows),

  onOutput: (callback: (id: string, data: string) => void): void => {
    ipcRenderer.on('session:output', (_, id, data) => callback(id, data));
  },
  onStateChange: (callback: (id: string, state: string) => void): void => {
    ipcRenderer.on('session:state', (_, id, state) => callback(id, state));
  },
  onExit: (callback: (id: string, code: number) => void): void => {
    ipcRenderer.on('session:exit', (_, id, code) => callback(id, code));
  },
  onNewSession: (callback: () => void): void => {
    ipcRenderer.on('new-session', () => callback());
  },
  onSwitchSession: (callback: (id: string) => void): void => {
    ipcRenderer.on('switch-session', (_, id) => callback(id));
  },
});
