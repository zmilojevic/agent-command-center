import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types'

const on = <T>(channel: string) => (cb: (payload: T) => void) => {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DesktopApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getMessages: (sessionId, cwd) => ipcRenderer.invoke('sessions:messages', sessionId, cwd),
  getSessionMeta: (items) => ipcRenderer.invoke('sessions:meta', items),
  renameSession: (sessionId, title, cwd) => ipcRenderer.invoke('sessions:rename', sessionId, title, cwd),
  deleteSession: (sessionId, cwd) => ipcRenderer.invoke('sessions:delete', sessionId, cwd),
  deleteProject: (cwd, sessionIds) => ipcRenderer.invoke('sessions:deleteProject', cwd, sessionIds),
  startChat: (opts) => ipcRenderer.invoke('chat:start', opts),
  send: (chatId, content, uuid) => ipcRenderer.invoke('chat:send', chatId, content, uuid),
  respond: (chatId, requestId, response) => ipcRenderer.invoke('chat:respond', chatId, requestId, response),
  interrupt: (chatId) => ipcRenderer.invoke('chat:interrupt', chatId),
  setModel: (chatId, model) => ipcRenderer.invoke('chat:setModel', chatId, model),
  setEffort: (chatId, effort) => ipcRenderer.invoke('chat:setEffort', chatId, effort),
  setPermissionMode: (chatId, mode) => ipcRenderer.invoke('chat:setPermissionMode', chatId, mode),
  closeChat: (chatId) => ipcRenderer.invoke('chat:close', chatId),
  listModels: (chatId) => ipcRenderer.invoke('chat:models', chatId),
  listCommands: (chatId) => ipcRenderer.invoke('chat:commands', chatId),
  listAgents: (chatId) => ipcRenderer.invoke('chat:agents', chatId),
  warmCache: (chatId) => ipcRenderer.invoke('chat:warm', chatId),
  requestContext: (chatId) => ipcRenderer.invoke('chat:context', chatId),
  getUsage: (force) => ipcRenderer.invoke('usage:get', force),
  gitChanges: (cwd) => ipcRenderer.invoke('git:changes', cwd),
  notify: (n) => ipcRenderer.invoke('app:notify', n),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  homeDir: () => ipcRenderer.invoke('app:home'),
  chatsDir: () => ipcRenderer.invoke('app:chatsDir'),
  window: (action) => ipcRenderer.send('window:action', action),
  setTheme: (theme) => ipcRenderer.send('app:theme', theme),
  onAgentEvent: on('agent:event'),
  onPermissionRequest: on('permission:request'),
  onPermissionCancel: on('permission:cancel'),
  onChatExit: on('chat:exit'),
  onChatContext: on('chat:context'),
  onUsage: on('usage:changed'),
  onSessionsChanged: on('sessions:changed'),
  onNotificationClick: on('notification:click'),
  onTrayNewChat: on('tray:newChat'),
  // ---- @file mentions / plan mode
  fileSuggestions: (chatId, query) => ipcRenderer.invoke('chat:files', chatId, query),
  // ---- background tasks
  taskOutput: (chatId, taskId) => ipcRenderer.invoke('chat:taskOutput', chatId, taskId),
  stopTask: (chatId, taskId) => ipcRenderer.invoke('chat:stopTask', chatId, taskId),
  backgroundTasks: (chatId, toolUseId) => ipcRenderer.invoke('chat:backgroundTasks', chatId, toolUseId),
  // ---- mcp / worktrees
  mcpStatus: (chatId) => ipcRenderer.invoke('chat:mcpStatus', chatId),
  mcpToggle: (chatId, name, enabled) => ipcRenderer.invoke('chat:mcpToggle', chatId, name, enabled),
  mcpReconnect: (chatId, name) => ipcRenderer.invoke('chat:mcpReconnect', chatId, name),
  worktreeAdd: (cwd, name) => ipcRenderer.invoke('git:worktreeAdd', cwd, name),
  worktreeRemove: (path, force) => ipcRenderer.invoke('git:worktreeRemove', path, force),
  // ---- changes actions / open in editor
  gitSetStaged: (cwd, file, staged) => ipcRenderer.invoke('git:setStaged', cwd, file, staged),
  gitDiscardFile: (cwd, file) => ipcRenderer.invoke('git:discardFile', cwd, file),
  gitDiscardHunk: (cwd, patch) => ipcRenderer.invoke('git:discardHunk', cwd, patch),
  appTools: () => ipcRenderer.invoke('app:tools'),
  openInEditor: (path, line, editorId) => ipcRenderer.invoke('app:openInEditor', path, line, editorId),
  openTerminal: (dir, terminalId) => ipcRenderer.invoke('app:openTerminal', dir, terminalId),

  // ---- remote control
  remoteEnable: (chatId, info) => ipcRenderer.invoke('remote:enable', chatId, info),
  remoteDisable: (chatId) => ipcRenderer.invoke('remote:disable', chatId),
  onRemoteState: on('remote:state'),
  onRemoteMessage: on('chat:remoteMessage'),
  onRemoteSetting: on('remote:setting'),
}

contextBridge.exposeInMainWorld('desktop', api)
