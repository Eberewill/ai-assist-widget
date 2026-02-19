import { contextBridge, ipcRenderer } from 'electron'

const allowedChannels = new Set([
    'capture-screen',
    'resize-window',
    'set-focusable',
    'open-screen-capture-settings',
    'analyze-screen-deep',
    'solve-with-codex',
])

function ensureAllowed(channel: string) {
    if (!allowedChannels.has(channel)) {
        throw new Error(`[PRELOAD] Blocked IPC channel: ${channel}`)
    }
}

contextBridge.exposeInMainWorld('ipcRenderer', {
    on(...args: Parameters<typeof ipcRenderer.on>) {
        const [channel, listener] = args
        ensureAllowed(channel)
        return ipcRenderer.on(channel, (event, ...innerArgs) => listener(event, ...innerArgs))
    },
    off(...args: Parameters<typeof ipcRenderer.off>) {
        const [channel, ...rest] = args
        ensureAllowed(channel)
        return ipcRenderer.off(channel, ...rest)
    },
    send(...args: Parameters<typeof ipcRenderer.send>) {
        const [channel, ...rest] = args
        ensureAllowed(channel)
        return ipcRenderer.send(channel, ...rest)
    },
    invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
        const [channel, ...rest] = args
        ensureAllowed(channel)
        return ipcRenderer.invoke(channel, ...rest)
    },
})
