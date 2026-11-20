const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewer', {
  state: () => ipcRenderer.invoke('viewer:state'),
  sources: () => ipcRenderer.invoke('viewer:sources'),
  profile: (id) => ipcRenderer.invoke('viewer:profile', id),
  actions: (id) => ipcRenderer.invoke('viewer:actions', id),
  saveLayout: (draft) => ipcRenderer.invoke('viewer:save-layout', draft),
  verifyLayout: (id, revision) => ipcRenderer.invoke('viewer:verify-layout', id, revision),
  nextLaunchStatus: () => ipcRenderer.invoke('viewer:next-launch-status'),
  applyNextLaunch: (request) => ipcRenderer.invoke('viewer:apply-next-launch', request),
  restorePreviousBindings: (request) => ipcRenderer.invoke('viewer:restore-previous-bindings', request),
  chooseInstall: () => ipcRenderer.invoke('viewer:choose-install'),
  onInput: (listener) => {
    const handle = (_event, value) => listener(value);
    ipcRenderer.on('viewer:input', handle);
    return () => ipcRenderer.removeListener('viewer:input', handle);
  },
});
