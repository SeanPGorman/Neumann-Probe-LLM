import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  loadConfig: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('load-config'),
  saveConfig: (config: Record<string, string>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-config', config),
});
