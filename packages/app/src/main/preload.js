// @ts-check
'use strict';
/**
 * The renderer's only bridge to the main process (contextIsolation + sandbox).
 * window.cc = { platform, getConnection(), notify(title, body, agentId?), pickFolder(), onSelectAgent(fn),
 *   setAttention, openDashboard, openExternal, getSettings, setSettings, onSettings, quitAll, trashSkill }  (M2)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  platform: process.platform,
  /** @returns {Promise<{port:number, token:string}>} */
  getConnection: () => ipcRenderer.invoke('cc:getConnection'),
  /** Native notification; clicking it focuses the window and selects the agent. */
  notify: (/** @type {string} */ title, /** @type {string} */ body, /** @type {string|undefined} */ agentId, /** @type {{kind?: string, silent?: boolean}|undefined} */ extra) =>
    ipcRenderer.invoke('cc:notify', {
      title: String(title || ''), body: String(body || ''), agentId: agentId ? String(agentId) : undefined,
      kind: extra && typeof extra.kind === 'string' ? extra.kind : undefined, silent: !!(extra && extra.silent),
    }),
  /** @returns {Promise<string>} the app's version */
  getVersion: () => ipcRenderer.invoke('cc:getVersion'),
  /** @returns {Promise<string|null>} folder path, or null when cancelled */
  pickFolder: () => ipcRenderer.invoke('cc:pickFolder'),
  /** @param {(agentId:string) => void} fn */
  onSelectAgent: (fn) => {
    const h = (/** @type {any} */ _e, /** @type {string} */ id) => fn(String(id));
    ipcRenderer.on('cc:select-agent', h);
    return () => ipcRenderer.removeListener('cc:select-agent', h);
  },
  // ---- M2 (each backed by one module in src/main) ----
  /** Approvals: taskbar count / flash. @param {number} count */
  setAttention: (count) => ipcRenderer.invoke('cc:setAttention', { count: Number(count) || 0 }),
  /** Dashboards: open a page or local URL in a locked-down window. @param {{title?:string, url?:string, file?:string}} spec */
  openDashboard: (spec) => ipcRenderer.invoke('cc:openDashboard', { title: String((spec && spec.title) || ''), url: spec && spec.url ? String(spec.url) : undefined, file: spec && spec.file ? String(spec.file) : undefined }),
  /** Open an http(s) link in the default browser. @param {string} url */
  openExternal: (url) => ipcRenderer.invoke('cc:openExternal', { url: String(url || '') }),
  /** Settings. */
  getSettings: () => ipcRenderer.invoke('cc:getSettings'),
  /** @param {Record<string, any>} patch */
  setSettings: (patch) => ipcRenderer.invoke('cc:setSettings', { patch }),
  /** @param {(settings: Record<string, any>) => void} fn */
  onSettings: (fn) => {
    const h = (/** @type {any} */ _e, /** @type {any} */ v) => fn(v);
    ipcRenderer.on('cc:settings', h);
    return () => ipcRenderer.removeListener('cc:settings', h);
  },
  /** Stop every agent and the core, then quit. */
  quitAll: () => ipcRenderer.invoke('cc:quitAll'),
  /** Library: move a skill's folder to the system trash. @param {string} skillMdPath */
  trashSkill: (skillMdPath) => ipcRenderer.invoke('cc:trashSkill', { path: String(skillMdPath || '') }),
});
