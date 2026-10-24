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
}

contextBridge.exposeInMainWorld('desktop', api)
