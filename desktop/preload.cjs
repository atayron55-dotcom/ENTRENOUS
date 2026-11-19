'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('entreNousDesktop', {
  getSettings: () => ipcRenderer.invoke('entre-nous:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('entre-nous:save-settings', settings),
  openExternal: (url) => ipcRenderer.invoke('entre-nous:open-external', url),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('entre-nous:open-settings', listener);
    return () => ipcRenderer.removeListener('entre-nous:open-settings', listener);
  }
});
