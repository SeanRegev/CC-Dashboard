// @ts-check
/**
 * Settings dialog (Ctrl+,) and the agent edit dialog (F2: rename + role, "Make Main").
 * Owner: the Settings track (M2). Groundwork stubs.
 * Settings persist through the main process: ctx.bridge.getSettings() / setSettings(patch) / onSettings(fn).
 */
import { toast } from '../dialogs.js';

/** @param {import('../context.js').ViewContext} ctx */
// eslint-disable-next-line no-unused-vars
export function openSettingsDialog(ctx) {
  toast('Settings are coming in this milestone.');
}

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId */
// eslint-disable-next-line no-unused-vars
export function openAgentEditDialog(ctx, agentId) {
  toast('Renaming and roles are coming in this milestone.');
}

/** Apply saved settings (theme, terminal font) at startup and whenever they change. @param {import('../context.js').ViewContext} ctx */
// eslint-disable-next-line no-unused-vars
export function applySettings(ctx) {}
