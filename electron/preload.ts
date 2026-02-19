import { contextBridge, ipcRenderer } from 'electron'

console.log('[PRELOAD] Preload script starting...')

const allowedChannels = new Set([
    'capture-screen',
    'resize-window',
    'set-focusable',
    'open-screen-capture-settings',
    'analyze-screen-deep',
])

function ensureAllowed(channel: string) {
    if (!allowedChannels.has(channel)) {
        throw new Error(`[PRELOAD] Blocked IPC channel: ${channel}`)
    }
}
// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
    on(...args: Parameters<typeof ipcRenderer.on>) {
        const [channel, listener] = args
        ensureAllowed(channel)
        return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
    },
    off(...args: Parameters<typeof ipcRenderer.off>) {
        const [channel, ...omit] = args
        ensureAllowed(channel)
        return ipcRenderer.off(channel, ...omit)
    },
    send(...args: Parameters<typeof ipcRenderer.send>) {
        const [channel, ...omit] = args
        ensureAllowed(channel)
        return ipcRenderer.send(channel, ...omit)
    },
    invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
        const [channel, ...omit] = args
        ensureAllowed(channel)
        return ipcRenderer.invoke(channel, ...omit)
    },
})
