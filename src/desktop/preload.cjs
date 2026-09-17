const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentBridge', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  saveLocalKey: (value) => ipcRenderer.invoke('localKey:save', value),
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  savePort: (value) => ipcRenderer.invoke('port:save', value),
  saveDelay: (value) => ipcRenderer.invoke('delay:save', value),
  selectModel: (model) => ipcRenderer.invoke('model:select', model),
  testModel: (model) => ipcRenderer.invoke('model:test', model),
  setAutoToggle: (value) => ipcRenderer.invoke('model:setAuto', value),
  setReasoningMode: (value) => ipcRenderer.invoke('reasoning:set', value),
  updateModels: (payload) => ipcRenderer.invoke('models:update', payload),
  setLocale: (locale) => ipcRenderer.invoke('locale:set', locale),
  exportApis: () => ipcRenderer.invoke('export:apis'),
  copy: (value) => ipcRenderer.invoke('clipboard:copy', value),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:changed', listener);
    return () => ipcRenderer.removeListener('status:changed', listener);
  }
});
