import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell } from 'electron'
import { fileURLToPath } from 'url'
import path from 'node:path'
import { execFile } from 'node:child_process'
import fs from 'node:fs'

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WINDOW_DEFAULT_WIDTH = 900
const WINDOW_MIN_WIDTH = 120
const WINDOW_MAX_WIDTH = 1000
const WINDOW_MIN_HEIGHT = 120
const WINDOW_MAX_HEIGHT = 720
const WINDOW_BOTTOM_MARGIN = 20
const DEFAULT_FOCUSABLE = true

const CAPTURE_HIDE_DELAY_MS = 300

const PYTHON_BRIDGE_CANDIDATES = [
    path.join(process.cwd(), 'python', 'bridge.py'),
    path.join(__dirname, '../python/bridge.py'),
    path.join(__dirname, '../../python/bridge.py'),
]

const PYTHON_COMMAND_CANDIDATES = Array.from(
    new Set([process.env.PYTHON_PATH, 'python3', 'python'].filter(Boolean)),
) as string[]

let win: BrowserWindow | null = null
let captureInProgress = false

function getWindowBounds(targetWidth: number, targetHeight: number) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    return {
        width: targetWidth,
        height: targetHeight,
        x: Math.floor((width - targetWidth) / 2),
        y: Math.max(0, height - targetHeight - WINDOW_BOTTOM_MARGIN),
    }
}

function setWindowSize(targetWidth: number, targetHeight: number) {
    if (!win) return
    const clampedWidth = Math.max(WINDOW_MIN_WIDTH, Math.min(targetWidth, WINDOW_MAX_WIDTH))
    const clampedHeight = Math.max(WINDOW_MIN_HEIGHT, Math.min(targetHeight, WINDOW_MAX_HEIGHT))

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    const nextX = Math.floor((screenWidth - clampedWidth) / 2)
    const nextY = screenHeight - (clampedHeight + WINDOW_BOTTOM_MARGIN)

    win.setBounds({ x: nextX, y: nextY, width: clampedWidth, height: clampedHeight }, true)
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureCaptureDir() {
    const captureDir = path.join(process.cwd(), 'debug_captures')
    if (!fs.existsSync(captureDir)) {
        fs.mkdirSync(captureDir, { recursive: true })
    }
    return captureDir
}

function getActiveDisplayIndex() {
    const cursorPoint = screen.getCursorScreenPoint()
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
    const displays = screen.getAllDisplays()
    return displays.findIndex((display) => display.id === targetDisplay.id)
}

function resolvePythonBridgePath() {
    const candidate = PYTHON_BRIDGE_CANDIDATES.find((candidatePath) => fs.existsSync(candidatePath))
    if (!candidate) {
        throw new Error('Python bridge script not found')
    }
    return candidate
}

function runPythonBridge(pythonCommand: string, bridgePath: string) {
    return new Promise<any>((resolve, reject) => {
        execFile(pythonCommand, [bridgePath], { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                const message = stderr?.toString().trim() || error.message
                const wrapped = new Error(`[PYTHON] ${message}`)
                ;(wrapped as any).code = error.code
                reject(wrapped)
                return
            }

            const output = stdout?.toString().trim()
            if (!output) {
                resolve({})
                return
            }

            try {
                resolve(JSON.parse(output))
            } catch (parseError) {
                reject(new Error(`Failed to parse python bridge output: ${(parseError as Error).message} | Output: ${output}`))
            }
        })
    })
}

async function collectSemanticStructure() {
    const bridgePath = resolvePythonBridgePath()
    let lastError: Error | null = null

    for (const pythonCommand of PYTHON_COMMAND_CANDIDATES) {
        try {
            return await runPythonBridge(pythonCommand, bridgePath)
        } catch (error) {
            if (error instanceof Error && (error as any).code === 'ENOENT') {
                lastError = error
                continue
            }
            throw error
        }
    }

    throw lastError || new Error('Python bridge failed to execute')
}

async function captureViaScreencapture() {
    const captureDir = ensureCaptureDir()
    const capturePath = path.join(captureDir, `capture_${Date.now()}.png`)
    const displayIndex = getActiveDisplayIndex()
    const args = ['-x']

    if (displayIndex >= 0) {
        args.push('-D', String(displayIndex + 1))
    }

    await new Promise<void>((resolve, reject) => {
        // -x: no sound, -D: display index (1-based)
        execFile('/usr/sbin/screencapture', [...args, capturePath], (error) => {
            if (error) {
                console.error('[MAIN] screencapture CLI error:', error)
                reject(error)
                return
            }
            resolve()
        })
    })

    if (!fs.existsSync(capturePath)) {
        throw new Error('Capture file was not created')
    }

    const buffer = fs.readFileSync(capturePath)
    console.log('[MAIN] Capture success. Size on disk:', buffer.length)
    return buffer
}

async function captureScreenBase64() {
    const wasVisible = win?.isVisible() ?? false
    if (wasVisible) {
        win?.hide()
        await delay(CAPTURE_HIDE_DELAY_MS)
    }

    try {
        const buffer = await captureViaScreencapture()
        return buffer.toString('base64')
    } finally {
        if (wasVisible) {
            win?.showInactive()
        }
    }
}

function registerIpcHandlers() {
    ipcMain.removeHandler('capture-screen')
    ipcMain.removeHandler('resize-window')
    ipcMain.removeHandler('set-focusable')
    ipcMain.removeHandler('open-screen-capture-settings')

    ipcMain.handle('capture-screen', async () => {
        if (captureInProgress) throw new Error('Capture already in progress')
        captureInProgress = true
        try {
            console.log('[MAIN] Capture request received')
            const base64 = await captureScreenBase64()
            console.log('[MAIN] Returning base64 length:', base64.length)
            return base64
        } finally {
            captureInProgress = false
        }
    })

    ipcMain.handle('analyze-screen-deep', async () => {
        try {
            return await collectSemanticStructure()
        } catch (error) {
            console.error('[MAIN] analyze-screen-deep failed:', error)
            throw error instanceof Error ? error : new Error(String(error))
        }
    })

    ipcMain.handle('resize-window', (_event, { width, height }) => {
        setWindowSize(width || WINDOW_DEFAULT_WIDTH, height || WINDOW_MIN_HEIGHT)
    })

    ipcMain.handle('set-focusable', (_event, { focusable }) => {
        if (win) {
            win.setIgnoreMouseEvents(!focusable, { forward: true })
            win.setFocusable(focusable)
        }
    })

    ipcMain.handle('open-screen-capture-settings', () => {
        if (process.platform === 'darwin') {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        }
    })
}

function createWindow() {
    const preloadPath = path.join(__dirname, '../preload/preload.js')

    win = new BrowserWindow({
        ...getWindowBounds(WINDOW_DEFAULT_WIDTH, WINDOW_MIN_HEIGHT),
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        hasShadow: false,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
    })

    if (process.platform === 'darwin') {
        win.setWindowButtonVisibility(false)
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        // Make the window invisible to screen capture and recording
        win.setContentProtection(true)
    }

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL)
    } else {
        win.loadFile(path.join(__dirname, '../../dist/index.html'))
    }

    win.on('closed', () => {
        win = null
    })
}

if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
}

app.whenReady().then(() => {
    registerIpcHandlers()
    createWindow()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (win === null) createWindow()
})
