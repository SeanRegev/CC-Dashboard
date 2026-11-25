// @ts-check
'use strict';
/**
 * The renderer's only bridge to the main process (contextIsolation + sandbox).
 * window.cc = { platform, getConnection(), notify(title, body, agentId?), pickFolder(), onSelectAgent(fn) }
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  platform: process.platform,
  /** @returns {Promise<{port:number, token:string}>} */
  getConnection: () => ipcRenderer.invoke('cc:getConnection'),
  /** Native notification; clicking it focuses the window and selects the agent. */
  notify: (/** @type {string} */ title, /** @type {string} */ body, /** @type {string|undefined} */ agentId) =>
    ipcRenderer.invoke('cc:notify', { title: String(title || ''), body: String(body || ''), agentId: agentId ? String(agentId) : undefined }),
  /** @returns {Promise<string|null>} folder path, or null when cancelled */
  pickFolder: () => ipcRenderer.invoke('cc:pickFolder'),
  /** @param {(agentId:string) => void} fn */
  onSelectAgent: (fn) => {
    const h = (/** @type {any} */ _e, /** @type {string} */ id) => fn(String(id));
    ipcRenderer.on('cc:select-agent', h);
    return () => ipcRenderer.removeListener('cc:select-agent', h);
  },
});
