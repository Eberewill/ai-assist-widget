import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell } from 'electron'
import { fileURLToPath } from 'url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import https from 'node:https'

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WINDOW_DEFAULT_WIDTH = 900
const WINDOW_MIN_WIDTH = 120
const WINDOW_MAX_WIDTH = 1000
const WINDOW_MIN_HEIGHT = 120
const WINDOW_MAX_HEIGHT = 720
const WINDOW_BOTTOM_MARGIN = 20

const CAPTURE_HIDE_DELAY_MS = 300
const DEBUG_CAPTURE_ENV = 'ASSISTANT_DEBUG_CAPTURES'
const DEBUG_CAPTURE_DIR = 'debug_captures'
const CODEX_DEFAULT_MODEL = 'gpt-5'
const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash'
const KIMI_DEFAULT_MODEL = 'kimi-k2-0711-preview'
const MAX_HISTORY_MESSAGES = 10
const MAX_SEMANTIC_CHARS = 18000

const PYTHON_BRIDGE_CANDIDATES = [
    path.join(process.cwd(), 'python', 'bridge.py'),
    path.join(__dirname, '../python/bridge.py'),
    path.join(__dirname, '../../python/bridge.py'),
]

const PYTHON_COMMAND_CANDIDATES = Array.from(
    new Set([process.env.PYTHON_PATH, 'python3', 'python'].filter(Boolean)),
) as string[]

const CODEX_COMMAND_CANDIDATES = Array.from(new Set([process.env.CODEX_PATH, 'codex'].filter(Boolean))) as string[]

type AIProvider = 'codex' | 'gemini' | 'kimi'

type ChatRole = 'user' | 'assistant'

type SolveMessage = {
    role: ChatRole
    text: string
}

type SolveRequest = {
    prompt?: string
    model?: string
    provider?: AIProvider
    apiKey?: string
    imageBase64?: string
    imageMimeType?: string
    semanticStructure?: unknown
    messages?: SolveMessage[]
}

type PythonBridgeData = Record<string, unknown>

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

function ensureDebugCaptureDir() {
    const captureDir = path.join(app.getPath('userData'), DEBUG_CAPTURE_DIR)
    if (!fs.existsSync(captureDir)) {
        fs.mkdirSync(captureDir, { recursive: true })
    }
    return captureDir
}

function getActiveDisplay() {
    const cursorPoint = screen.getCursorScreenPoint()
    return screen.getDisplayNearestPoint(cursorPoint)
}

function getActiveDisplayIndex() {
    const targetDisplay = getActiveDisplay()
    const displays = screen.getAllDisplays()
    return displays.findIndex((display) => display.id === targetDisplay.id)
}

function maybeSaveDebugCapture(buffer: Buffer) {
    if (process.env[DEBUG_CAPTURE_ENV] !== '1') {
        return
    }

    try {
        const captureDir = ensureDebugCaptureDir()
        const capturePath = path.join(captureDir, `capture_${Date.now()}.png`)
        fs.writeFileSync(capturePath, buffer)
    } catch (error) {
        console.warn('[MAIN] Failed to save debug capture:', error)
    }
}

async function captureViaDesktopCapturer() {
    const display = getActiveDisplay()
    const width = Math.max(display.size.width, 1)
    const height = Math.max(display.size.height, 1)

    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
    })

    if (!sources.length) {
        throw new Error('No screen sources available')
    }

    const activeDisplayId = String(display.id)
    const source = sources.find((candidate) => candidate.display_id === activeDisplayId) ?? sources[0]
    const pngBuffer = source.thumbnail.toPNG()

    if (!pngBuffer.length) {
        throw new Error('Screen capture returned an empty image')
    }

    maybeSaveDebugCapture(pngBuffer)
    return pngBuffer
}

function runScreencapture(args: string[]) {
    return new Promise<void>((resolve, reject) => {
        execFile('/usr/sbin/screencapture', args, (error, _stdout, stderr) => {
            if (error) {
                const stderrText = stderr?.toString().trim()
                reject(new Error(stderrText || error.message))
                return
            }
            resolve()
        })
    })
}

async function captureViaScreencaptureFallback() {
    if (process.platform !== 'darwin') {
        throw new Error('screencapture fallback is only available on macOS')
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assist-capture-'))
    const capturePath = path.join(tempDir, 'capture.png')
    const displayIndex = getActiveDisplayIndex()
    const args = ['-x']

    if (displayIndex >= 0) {
        args.push('-D', String(displayIndex + 1))
    }

    try {
        await runScreencapture([...args, capturePath])
        if (!fs.existsSync(capturePath)) {
            throw new Error('screencapture produced no file')
        }

        const buffer = fs.readFileSync(capturePath)
        if (!buffer.length) {
            throw new Error('screencapture returned an empty image')
        }

        maybeSaveDebugCapture(buffer)
        return buffer
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

async function captureScreenBase64() {
    const wasVisible = win?.isVisible() ?? false
    if (wasVisible) {
        win?.hide()
        await delay(CAPTURE_HIDE_DELAY_MS)
    }

    try {
        let buffer: Buffer

        try {
            buffer = await captureViaDesktopCapturer()
        } catch (desktopError) {
            if (process.platform !== 'darwin') {
                throw desktopError
            }

            try {
                buffer = await captureViaScreencaptureFallback()
            } catch (fallbackError) {
                const desktopMessage = desktopError instanceof Error ? desktopError.message : String(desktopError)
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                throw new Error(
                    `Screen Recording capture failed. desktopCapturer: ${desktopMessage}. screencapture: ${fallbackMessage}`,
                )
            }
        }

        return buffer.toString('base64')
    } finally {
        if (wasVisible) {
            win?.showInactive()
        }
    }
}

function resolvePythonBridgePath() {
    const candidate = PYTHON_BRIDGE_CANDIDATES.find((candidatePath) => fs.existsSync(candidatePath))
    if (!candidate) {
        throw new Error('Python bridge script not found')
    }
    return candidate
}

function runPythonBridge(pythonCommand: string, bridgePath: string) {
    return new Promise<PythonBridgeData>((resolve, reject) => {
        execFile(pythonCommand, [bridgePath], { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                const message = stderr?.toString().trim() || error.message
                const wrapped = new Error(`[PYTHON] ${message}`)
                ;(wrapped as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code
                reject(wrapped)
                return
            }

            const output = stdout?.toString().trim()
            if (!output) {
                resolve({})
                return
            }

            try {
                const parsed = JSON.parse(output)
                if (typeof parsed === 'object' && parsed !== null) {
                    resolve(parsed as PythonBridgeData)
                    return
                }
                resolve({ value: parsed })
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
            const candidateError = error as NodeJS.ErrnoException
            if (candidateError.code === 'ENOENT') {
                lastError = candidateError
                continue
            }
            throw error
        }
    }

    throw lastError || new Error('Python bridge failed to execute')
}

function toExtensionFromMime(mimeType: string) {
    const normalized = mimeType.toLowerCase()
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('gif')) return 'gif'
    return 'png'
}

function normalizeBase64(raw: string) {
    if (raw.includes(',')) {
        const parts = raw.split(',')
        return parts[1] || ''
    }
    return raw
}

function truncateForPrompt(value: string, maxLength: number) {
    if (value.length <= maxLength) {
        return value
    }
    return `${value.slice(0, maxLength)}\n...[truncated for size]`
}

function formatConversation(messages: SolveMessage[]) {
    if (!messages.length) return ''

    return messages
        .slice(-MAX_HISTORY_MESSAGES)
        .map((message, index) => `${index + 1}. ${message.role.toUpperCase()}: ${message.text}`)
        .join('\n\n')
}

function buildAIPrompt(request: SolveRequest) {
    const sections: string[] = []
    const prompt = request.prompt?.trim()

    if (!prompt) {
        throw new Error('Prompt is required')
    }

    sections.push(
        'System rules:\n' +
            '- Solve the user\'s technical problem accurately and concisely.\n' +
            '- Do not run shell commands or edit files.\n' +
            '- If code is needed, return runnable code.\n' +
            "- End with exactly 3 lines prefixed with 'Suggestion: '. Each must be 6 words or fewer.\n" +
            '- No conversational filler.',
    )

    const history = request.messages ?? []
    if (history.length) {
        sections.push(`Conversation history:\n${formatConversation(history)}`)
    }

    if (request.semanticStructure !== undefined) {
        const serialized = truncateForPrompt(JSON.stringify(request.semanticStructure, null, 2), MAX_SEMANTIC_CHARS)
        sections.push(`Semantic structure JSON:\n${serialized}`)
    }

    sections.push(`Latest user request:\n${prompt}`)
    sections.push('Return only the final assistant answer.')

    return sections.join('\n\n')
}

// ===== Codex Implementation =====

type CodexCommandResult = {
    stdout: string
    stderr: string
}

function runCodexCommand(codexCommand: string, args: string[]) {
    return new Promise<CodexCommandResult>((resolve, reject) => {
        execFile(
            codexCommand,
            args,
            {
                cwd: process.cwd(),
                env: process.env,
                timeout: 120000,
                maxBuffer: 20 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const stdoutText = stdout?.toString() || ''
                const stderrText = stderr?.toString() || ''
                if (error) {
                    const err = error as NodeJS.ErrnoException
                    if (err.code === 'ENOENT') {
                        reject(err)
                        return
                    }
                    reject(new Error(stderrText.trim() || error.message))
                    return
                }
                resolve({ stdout: stdoutText, stderr: stderrText })
            },
        )
    })
}

async function runCodexWithFallback(args: string[]) {
    let lastError: Error | null = null

    for (const codexCommand of CODEX_COMMAND_CANDIDATES) {
        try {
            return await runCodexCommand(codexCommand, args)
        } catch (error) {
            const candidateError = error as NodeJS.ErrnoException
            if (candidateError.code === 'ENOENT') {
                lastError = candidateError
                continue
            }
            throw error
        }
    }

    throw lastError || new Error('Codex CLI not found. Install Codex CLI or set CODEX_PATH.')
}

async function solveWithCodex(request: SolveRequest) {
    const prompt = buildAIPrompt(request)
    const model = request.model?.trim() || CODEX_DEFAULT_MODEL

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assist-codex-'))
    const outputPath = path.join(tempDir, 'last-message.txt')

    let imagePath: string | null = null

    try {
        if (request.imageBase64) {
            const normalizedBase64 = normalizeBase64(request.imageBase64).trim()
            if (!normalizedBase64) {
                throw new Error('Image payload was empty')
            }
            const mimeType = request.imageMimeType || 'image/png'
            const imageBuffer = Buffer.from(normalizedBase64, 'base64')
            if (!imageBuffer.length) {
                throw new Error('Image payload failed to decode')
            }

            const extension = toExtensionFromMime(mimeType)
            imagePath = path.join(tempDir, `input.${extension}`)
            fs.writeFileSync(imagePath, imageBuffer)
        }

        const args = [
            'exec',
            '-c',
            'model_reasoning_effort="high"',
            '-c',
            'experimental_use_rmcp_client=false',
            '-c',
            'mcp_servers={}',
            '--skip-git-repo-check',
            '--color',
            'never',
            '--output-last-message',
            outputPath,
            '--model',
            model,
        ]

        if (imagePath) {
            args.push('--image', imagePath)
        }

        args.push('--', prompt)

        const commandResult = await runCodexWithFallback(args)

        const fileResponse = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : ''
        const stdoutResponse = commandResult.stdout.trim()
        const response = fileResponse || stdoutResponse

        if (!response) {
            const stderrTail = commandResult.stderr.trim().split('\n').slice(-8).join('\n')
            throw new Error(
                stderrTail
                    ? `Codex returned an empty response. CLI stderr:\n${stderrTail}`
                    : 'Codex returned an empty response.',
            )
        }

        return response
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

// ===== Gemini Implementation =====

async function solveWithGemini(request: SolveRequest) {
    const apiKey = request.apiKey
    if (!apiKey) {
        throw new Error('Gemini API key is required. Please add your API key in settings.')
    }

    const model = request.model?.trim() || GEMINI_DEFAULT_MODEL
    const prompt = buildAIPrompt(request)

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
        { text: prompt }
    ]

    if (request.imageBase64) {
        const normalizedBase64 = normalizeBase64(request.imageBase64).trim()
        if (normalizedBase64) {
            parts.unshift({
                inlineData: {
                    mimeType: request.imageMimeType || 'image/png',
                    data: normalizedBase64
                }
            })
        }
    }

    const body = {
        contents: [
            {
                parts
            }
        ],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
        }
    }

    return new Promise<string>((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 60000,
            },
            (res) => {
                let data = ''
                res.on('data', (chunk) => {
                    data += chunk
                })
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data)
                        if (response.error) {
                            reject(new Error(`Gemini API error: ${response.error.message || JSON.stringify(response.error)}`))
                            return
                        }
                        const text = response.candidates?.[0]?.content?.parts?.[0]?.text
                        if (!text) {
                            reject(new Error('Gemini returned an empty response'))
                            return
                        }
                        resolve(text)
                    } catch (parseError) {
                        reject(new Error(`Failed to parse Gemini response: ${(parseError as Error).message}`))
                    }
                })
            }
        )

        req.on('error', (error) => {
            reject(new Error(`Gemini API request failed: ${error.message}`))
        })

        req.on('timeout', () => {
            req.destroy()
            reject(new Error('Gemini API request timed out'))
        })

        req.write(JSON.stringify(body))
        req.end()
    })
}

// ===== Kimi Implementation =====

async function solveWithKimi(request: SolveRequest) {
    const apiKey = request.apiKey
    if (!apiKey) {
        throw new Error('Kimi API key is required. Please add your API key in settings.')
    }

    const model = request.model?.trim() || KIMI_DEFAULT_MODEL
    const prompt = buildAIPrompt(request)

    const url = 'https://api.moonshot.cn/v1/chat/completions'

    const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = []

    // Add conversation history if available
    if (request.messages && request.messages.length > 0) {
        for (const msg of request.messages.slice(-MAX_HISTORY_MESSAGES)) {
            messages.push({
                role: msg.role,
                content: msg.text
            })
        }
    }

    // Build the current message with image if present
    const currentMessage: { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> } = {
        role: 'user',
        content: []
    }

    if (request.imageBase64) {
        const normalizedBase64 = normalizeBase64(request.imageBase64).trim()
        if (normalizedBase64) {
            const mimeType = request.imageMimeType || 'image/png'
            currentMessage.content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${mimeType};base64,${normalizedBase64}`
                }
            })
        }
    }

    currentMessage.content.push({
        type: 'text',
        text: prompt
    })

    messages.push(currentMessage)

    const body = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
    }

    return new Promise<string>((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                timeout: 60000,
            },
            (res) => {
                let data = ''
                res.on('data', (chunk) => {
                    data += chunk
                })
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data)
                        if (response.error) {
                            reject(new Error(`Kimi API error: ${response.error.message || JSON.stringify(response.error)}`))
                            return
                        }
                        const text = response.choices?.[0]?.message?.content
                        if (!text) {
                            reject(new Error('Kimi returned an empty response'))
                            return
                        }
                        resolve(text)
                    } catch (parseError) {
                        reject(new Error(`Failed to parse Kimi response: ${(parseError as Error).message}`))
                    }
                })
            }
        )

        req.on('error', (error) => {
            reject(new Error(`Kimi API request failed: ${error.message}`))
        })

        req.on('timeout', () => {
            req.destroy()
            reject(new Error('Kimi API request timed out'))
        })

        req.write(JSON.stringify(body))
        req.end()
    })
}

// ===== Main AI Router =====

async function solveWithAI(request: SolveRequest) {
    const provider = request.provider || 'codex'

    switch (provider) {
        case 'gemini':
            return solveWithGemini(request)
        case 'kimi':
            return solveWithKimi(request)
        case 'codex':
        default:
            return solveWithCodex(request)
    }
}

function registerIpcHandlers() {
    ipcMain.removeHandler('capture-screen')
    ipcMain.removeHandler('resize-window')
    ipcMain.removeHandler('set-focusable')
    ipcMain.removeHandler('open-screen-capture-settings')
    ipcMain.removeHandler('analyze-screen-deep')
    ipcMain.removeHandler('solve-with-codex')
    ipcMain.removeHandler('solve-with-ai')

    ipcMain.handle('capture-screen', async () => {
        if (captureInProgress) throw new Error('Capture already in progress')
        captureInProgress = true
        try {
            const base64 = await captureScreenBase64()
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

    // Keep backward compatibility
    ipcMain.handle('solve-with-codex', async (_event, request: SolveRequest) => {
        try {
            return await solveWithCodex(request)
        } catch (error) {
            console.error('[MAIN] solve-with-codex failed:', error)
            throw error instanceof Error ? error : new Error(String(error))
        }
    })

    // New unified AI handler
    ipcMain.handle('solve-with-ai', async (_event, request: SolveRequest) => {
        try {
            return await solveWithAI(request)
        } catch (error) {
            console.error('[MAIN] solve-with-ai failed:', error)
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
