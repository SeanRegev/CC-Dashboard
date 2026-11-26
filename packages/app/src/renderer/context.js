// @ts-check
/**
 * The context every view and component gets from app.js (owner: lead). Views read state through it
 * and act through it; they never import app.js. Add to it only through the lead.
 *
 * @typedef {Object} ViewContext
 * @property {() => any} state              the app state S (read-only by convention): spaces, entries (Map), currentSpace, tabs, layout, view, conn
 * @property {import('./client.js').CoreClient} client
 * @property {(method: string, params?: any) => Promise<any>} rpc   client.call that shows a toast on failure and resolves undefined
 * @property {(id: string) => void} openAgent        show the agent in the Terminals view (tab + focused pane)
 * @property {(spaceId?: string, preset?: {prompt?: string}) => void} newAgent   the New agent dialog (optionally preset to a space and a first prompt)
 * @property {(id: string) => void} editAgent        rename / change role (Settings track's dialog)
 * @property {(name: ViewName) => void} setView
 * @property {(id: string|null) => void} selectSpace
 * @property {() => void} render                     schedule a re-render of the chrome and the current view
 * @property {(text: string, kind?: 'info'|'error') => void} toast
 * @property {(spaceId: string) => string} spaceName
 * @property {any} bridge                            window.cc from preload.js
 * @property {string} mod                            'Ctrl' or '⌘'
 * @property {string} platform
 * @property {(id: string) => import('./terminal.js').TerminalView} terminal  the agent's live TerminalView (created and attached on demand)
 * @property {(id: string) => void} releaseTerminal  detach a TerminalView no tab, pane or tile shows any more
 *
 * @typedef {'terminals'|'grid'|'board'|'inbox'|'library'|'dashboards'} ViewName
 *
 * @typedef {Object} View
 * @property {HTMLElement} el
 * @property {() => void} update     called on every render while the view is shown
 * @property {() => void} [show]
 * @property {() => void} [hide]
 */
export {};
