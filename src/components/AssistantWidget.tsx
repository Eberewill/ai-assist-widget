import React, { useEffect, useRef, useState } from 'react'

const COLLAPSED_HEIGHT = 120
const SETTINGS_HEIGHT = 520
const RESPONSE_HEIGHT = 560
const COLLAPSED_WIDTH = 120
const EXPANDED_WIDTH = 960
const DEFAULT_MODEL = 'gpt-5'
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'
const DEFAULT_KIMI_MODEL = 'kimi-k2-0711-preview'

type ChatRole = 'user' | 'assistant'

type ChatMessage = {
    role: ChatRole
    text: string
    image?: {
        dataUrl: string
        name?: string
    }
}

type FollowUpImage = {
    dataUrl: string
    base64: string
    mimeType: string
    name?: string
}

type MessagePart = {
    type: 'text' | 'code'
    content: string
    language?: string
}

type AIProvider = 'codex' | 'gemini' | 'kimi'

type IpcRendererBridge = {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

type SolveRequest = {
    prompt: string
    model: string
    provider: AIProvider
    apiKey?: string
    imageBase64?: string
    imageMimeType?: string
    semanticStructure?: unknown
    messages?: Array<{
        role: ChatRole
        text: string
    }>
}

function getIpcBridge() {
    const win = window as Window & { ipcRenderer?: IpcRendererBridge }
    return win.ipcRenderer ?? null
}

function splitMessageParts(text: string): MessagePart[] {
    const parts: MessagePart[] = []
    const regex = /```(\w+)?\n?([\s\S]*?)```/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const chunk = text.slice(lastIndex, match.index).trim()
            if (chunk) {
                parts.push({ type: 'text', content: chunk })
            }
        }
        const code = match[2]?.replace(/\s+$/, '')
        if (code) {
            parts.push({ type: 'code', content: code, language: match[1] })
        }
        lastIndex = regex.lastIndex
    }

    if (lastIndex < text.length) {
        const chunk = text.slice(lastIndex).trim()
        if (chunk) {
            parts.push({ type: 'text', content: chunk })
        }
    }

    return parts.length ? parts : [{ type: 'text', content: text }]
}

function processResponse(fullText: string) {
    const lines = fullText.split('\n')
    const suggestions = lines
        .filter((line) => line.trim().startsWith('Suggestion:'))
        .map((line) => line.replace('Suggestion:', '').trim())
        .filter(Boolean)

    const cleanText = lines
        .filter((line) => !line.trim().startsWith('Suggestion:'))
        .join('\n')
        .trim()

    return { cleanText, suggestions }
}

function buildQuickSolvePrompt(sessionContext: string) {
    return `You are a professional on-screen coding assistant.
1. Analyze the provided screenshot.
2. If you see code, a technical problem, or a question, solve it concisely.
3. Provide only the solution (code or answer), no filler.
4. If multiple tasks exist, solve the most visible one.
${sessionContext ? `\nSession Context:\n${sessionContext}` : ''}`
}

function buildDeepSolvePrompt(sessionContext: string) {
    return `You are a precision macOS assistant.
You will receive a screenshot and semantic structure JSON from the active window.
Use both to solve the user's visible technical task with exact UI/code references where possible.
Provide a concise, professional solution.
${sessionContext ? `\nSession Context:\n${sessionContext}` : ''}`
}

function buildFollowUpPrompt(userPrompt: string, sessionContext: string) {
    const basePrompt = userPrompt || 'Analyze the attached image and continue helping with the same task.'
    if (!sessionContext) {
        return basePrompt
    }
    return `${basePrompt}\n\nSession Context:\n${sessionContext}`
}

const AssistantWidget: React.FC = () => {
    const [loading, setLoading] = useState(false)
    const [analyzingDeep, setAnalyzingDeep] = useState(false)
    const [response, setResponse] = useState<string | null>(null)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [showSettings, setShowSettings] = useState(false)
    const [copied, setCopied] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [needsScreenPermission, setNeedsScreenPermission] = useState(false)
    const [followUp, setFollowUp] = useState('')
    const [followUpImage, setFollowUpImage] = useState<FollowUpImage | null>(null)
    const [followUpLoading, setFollowUpLoading] = useState(false)
    const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null)
    const [recommendations, setRecommendations] = useState<string[]>([])
    const [sessionContext, setSessionContext] = useState('')

    // Provider and API settings
    const [provider, setProvider] = useState<AIProvider>(
        (localStorage.getItem('ai_provider') as AIProvider) || 'codex'
    )
    const [modelName, setModelName] = useState(localStorage.getItem('ai_model') || DEFAULT_MODEL)
    const [geminiApiKey, setGeminiApiKey] = useState(localStorage.getItem('gemini_api_key') || '')
    const [kimiApiKey, setKimiApiKey] = useState(localStorage.getItem('kimi_api_key') || '')

    const followUpImageInputRef = useRef<HTMLInputElement | null>(null)

    useEffect(() => {
        // Update model when provider changes to appropriate default
        const savedModel = localStorage.getItem('ai_model')
        if (!savedModel) {
            switch (provider) {
                case 'gemini':
                    setModelName(DEFAULT_GEMINI_MODEL)
                    break
                case 'kimi':
                    setModelName(DEFAULT_KIMI_MODEL)
                    break
                default:
                    setModelName(DEFAULT_MODEL)
            }
        }
    }, [provider])

    useEffect(() => {
        const ipc = getIpcBridge()
        if (!ipc?.invoke) {
            return
        }

        const hasContent = Boolean(response) || messages.length > 0
        const size = isCollapsed
            ? { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT }
            : {
                width: EXPANDED_WIDTH,
                height: hasContent ? RESPONSE_HEIGHT : showSettings ? SETTINGS_HEIGHT : COLLAPSED_HEIGHT,
            }

        ipc.invoke('resize-window', size).catch((error: unknown) => {
            console.warn('[RENDERER] Window resize failed:', error)
        })
    }, [response, messages.length, showSettings, isCollapsed])

    useEffect(() => {
        const ipc = getIpcBridge()
        if (!ipc?.invoke) {
            return
        }

        ipc.invoke('set-focusable', { focusable: true }).catch((error: unknown) => {
            console.warn('[RENDERER] Interaction toggle failed:', error)
        })
    }, [showSettings, isCollapsed])

    const runAISolve = async (request: SolveRequest) => {
        const ipc = getIpcBridge()
        if (!ipc?.invoke) {
            throw new Error('IPC Bridge not found.')
        }

        const result = await ipc.invoke('solve-with-ai', request)
        if (typeof result !== 'string' || !result.trim()) {
            throw new Error('AI returned an empty response')
        }

        return result.trim()
    }

    const getApiKey = (): string | undefined => {
        switch (provider) {
            case 'gemini':
                return geminiApiKey || undefined
            case 'kimi':
                return kimiApiKey || undefined
            default:
                return undefined
        }
    }

    const handleCapture = async () => {
        const ipc = getIpcBridge()
        if (!ipc?.invoke) {
            setResponse('Error: IPC Bridge not found.')
            return
        }

        const selectedModel = modelName.trim() || (
            provider === 'gemini' ? DEFAULT_GEMINI_MODEL :
            provider === 'kimi' ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL
        )

        setLoading(true)
        setResponse(null)
        setNeedsScreenPermission(false)
        setMessages([])
        setFollowUp('')
        setFollowUpImage(null)

        try {
            const captureData = await ipc.invoke('capture-screen')
            if (typeof captureData !== 'string' || !captureData) {
                throw new Error('No image data received from capture-screen')
            }

            const fullText = await runAISolve({
                provider,
                model: selectedModel,
                apiKey: getApiKey(),
                prompt: buildQuickSolvePrompt(sessionContext),
                imageBase64: captureData,
                imageMimeType: 'image/png',
            })

            const { cleanText, suggestions } = processResponse(fullText)
            if (!cleanText) {
                setResponse('AI did not return a usable answer.')
                setRecommendations([])
                return
            }

            setMessages([{ role: 'assistant', text: cleanText }])
            setRecommendations(suggestions)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[RENDERER] Error in handleCapture:', message)

            if (/Screen capture returned an empty image|Screen Recording/i.test(message)) {
                setNeedsScreenPermission(true)
                setResponse('Screen capture is blocked. Grant Screen Recording permission in System Settings.')
            } else {
                setResponse(`Error: ${message}`)
            }
        } finally {
            setLoading(false)
        }
    }

    const handleDeepAnalysis = async () => {
        const ipc = getIpcBridge()
        if (!ipc?.invoke) {
            setResponse('Error: IPC Bridge not found.')
            return
        }

        const selectedModel = modelName.trim() || (
            provider === 'gemini' ? DEFAULT_GEMINI_MODEL :
            provider === 'kimi' ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL
        )

        setAnalyzingDeep(true)
        setResponse(null)
        setNeedsScreenPermission(false)
        setMessages([])
        setFollowUp('')
        setFollowUpImage(null)

        try {
            const captureData = await ipc.invoke('capture-screen')
            const structure = await ipc.invoke('analyze-screen-deep')

            if (typeof captureData !== 'string' || !captureData) {
                throw new Error('No image data received from capture-screen')
            }

            const fullText = await runAISolve({
                provider,
                model: selectedModel,
                apiKey: getApiKey(),
                prompt: buildDeepSolvePrompt(sessionContext),
                imageBase64: captureData,
                imageMimeType: 'image/png',
                semanticStructure: structure,
            })

            const { cleanText, suggestions } = processResponse(fullText)
            if (!cleanText) {
                setResponse('AI did not return a usable deep analysis.')
                setRecommendations([])
                return
            }

            setMessages([{ role: 'assistant', text: cleanText }])
            setRecommendations(suggestions)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[RENDERER] Error in handleDeepAnalysis:', message)
            setResponse(`Deep Analysis Error: ${message}`)
        } finally {
            setAnalyzingDeep(false)
        }
    }

    const copyToClipboard = () => {
        const lastAssistant = [...messages].reverse().find((msg) => msg.role === 'assistant')?.text
        const textToCopy = lastAssistant || response
        if (!textToCopy) return
        navigator.clipboard.writeText(textToCopy)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const sendFollowUp = async () => {
        const trimmed = followUp.trim()
        if ((!trimmed && !followUpImage) || followUpLoading) return

        if (!messages.length) {
            setResponse('No active context. Run Quick Solve first.')
            return
        }

        const selectedModel = modelName.trim() || (
            provider === 'gemini' ? DEFAULT_GEMINI_MODEL :
            provider === 'kimi' ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL
        )
        const userText = trimmed || '[Attached image for follow-up]'

        const userMessage: ChatMessage = {
            role: 'user',
            text: userText,
            image: followUpImage
                ? {
                    dataUrl: followUpImage.dataUrl,
                    name: followUpImage.name,
                }
                : undefined,
        }

        const nextMessages = [...messages, userMessage]

        setFollowUpLoading(true)
        setMessages(nextMessages)
        setFollowUp('')
        setFollowUpImage(null)
        setRecommendations([])

        try {
            const fullText = await runAISolve({
                provider,
                model: selectedModel,
                apiKey: getApiKey(),
                prompt: buildFollowUpPrompt(trimmed, sessionContext),
                imageBase64: followUpImage?.base64,
                imageMimeType: followUpImage?.mimeType,
                messages: nextMessages.map(({ role, text }) => ({ role, text })),
            })

            const { cleanText, suggestions } = processResponse(fullText)
            setMessages((prev) => [...prev, { role: 'assistant', text: cleanText || fullText }])
            setRecommendations(suggestions)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            setMessages((prev) => [...prev, { role: 'assistant', text: `Error: ${message}` }])
        } finally {
            setFollowUpLoading(false)
        }
    }

    const handleFollowUpImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file?.type.startsWith('image/')) return

        const reader = new FileReader()
        reader.onload = () => {
            if (typeof reader.result !== 'string') return
            const [header, base64] = reader.result.split(',')
            if (!base64) return
            setFollowUpImage({
                dataUrl: reader.result,
                base64,
                mimeType: header.match(/data:(.*);base64/)?.[1] || file.type || 'image/png',
                name: file.name,
            })
        }
        reader.readAsDataURL(file)
    }

    const copyCodeBlock = (code: string, id: string) => {
        navigator.clipboard.writeText(code)
        setCopiedCodeId(id)
        setTimeout(() => setCopiedCodeId(null), 2000)
    }

    const renderMessageContent = (text: string, keyPrefix: string) => {
        const parts = splitMessageParts(text)
        return parts.map((part, index) => {
            const partKey = `${keyPrefix}-${index}`
            if (part.type === 'code') {
                return (
                    <div key={partKey} className="mt-2 rounded-xl border border-white/10 bg-black/60 p-3 overflow-hidden">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] uppercase tracking-widest text-white/50">{part.language || 'code'}</span>
                            <button
                                onClick={() => copyCodeBlock(part.content, partKey)}
                                className="no-drag text-[10px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80 transition-colors"
                            >
                                {copiedCodeId === partKey ? 'Copied' : 'Copy'}
                            </button>
                        </div>
                        <pre className="text-xs text-emerald-200 whitespace-pre-wrap break-all font-mono leading-relaxed">{part.content}</pre>
                    </div>
                )
            }
            return <div key={partKey} className="text-sm text-white whitespace-pre-wrap break-words leading-relaxed">{part.content}</div>
        })
    }

    const saveSettings = (e: React.FormEvent) => {
        e.preventDefault()
        const nextModel = modelName.trim() || (
            provider === 'gemini' ? DEFAULT_GEMINI_MODEL :
            provider === 'kimi' ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL
        )
        localStorage.setItem('ai_provider', provider)
        localStorage.setItem('ai_model', nextModel)
        localStorage.setItem('gemini_api_key', geminiApiKey)
        localStorage.setItem('kimi_api_key', kimiApiKey)
        setShowSettings(false)
        setResponse(`Settings updated. Using ${provider.toUpperCase()} with model: ${nextModel}`)
    }

    const openScreenRecordingSettings = () => {
        const ipc = getIpcBridge()
        ipc?.invoke('open-screen-capture-settings')
    }

    const getProviderLabel = () => {
        switch (provider) {
            case 'gemini':
                return 'Gemini'
            case 'kimi':
                return 'Kimi'
            default:
                return 'Codex'
        }
    }

    const getModelPlaceholder = () => {
        switch (provider) {
            case 'gemini':
                return DEFAULT_GEMINI_MODEL
            case 'kimi':
                return DEFAULT_KIMI_MODEL
            default:
                return DEFAULT_MODEL
        }
    }

    return (
        <div className="widget-layer flex flex-col items-stretch gap-3 pt-6 w-full px-4" aria-hidden="true">
            {isCollapsed ? (
                <div className="glass drag flex items-center justify-center px-2 py-2 rounded-full shadow-lg cursor-move">
                    <button onClick={() => setIsCollapsed(false)} className="no-drag bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-lg active:translate-y-0.5">Open</button>
                </div>
            ) : (
                <>
                    {(response || messages.length > 0) && (
                        <div
                            className="glass no-drag w-full rounded-2xl animate-in fade-in slide-in-from-bottom-4 duration-300 overflow-hidden shadow-2xl flex flex-col"
                            style={{ maxWidth: 'min(100%, 960px)' }}
                        >
                            <div className="bg-black/40 border-b border-white/5 px-4 py-2.5 flex items-center justify-between drag">
                                <div className="flex gap-1.5 no-drag">
                                    <div className="w-3 h-3 rounded-full bg-[#ff5f57] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#febc2e] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#28c840] border border-black/10" />
                                </div>
                                <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Solution Insight • {getProviderLabel()}</span>
                                <div className="flex gap-2 no-drag">
                                    <button
                                        onClick={copyToClipboard}
                                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${copied ? 'bg-green-500/20 text-green-400' : 'bg-white/5 hover:bg-white/10 text-white/60 hover:text-white'}`}
                                    >
                                        {copied ? 'Copied' : 'Copy'}
                                    </button>
                                    <button
                                        onClick={() => {
                                            setResponse(null)
                                            setMessages([])
                                            setFollowUp('')
                                            setFollowUpImage(null)
                                            setNeedsScreenPermission(false)
                                            setRecommendations([])
                                        }}
                                        className="text-[10px] text-white/30 hover:text-white/60 px-1 transition-colors font-bold"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>

                            <div className="p-4 overflow-auto max-h-[400px] w-full custom-scrollbar">
                                <div className="space-y-4 w-full">
                                    {messages.map((msg, index) => (
                                        <div key={`${msg.role}-${index}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[90%] rounded-2xl px-4 py-3 border break-words ${msg.role === 'user' ? 'bg-blue-600/20 border-blue-400/20 text-white' : 'bg-white/5 border-white/10 text-white'}`}>
                                                <span className="block text-[10px] uppercase tracking-widest text-white/50 mb-1">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                                                {renderMessageContent(msg.text, `${msg.role}-${index}`)}
                                            </div>
                                        </div>
                                    ))}
                                    {response && !messages.length && <div className="text-white text-sm whitespace-pre-wrap break-words">{response}</div>}
                                </div>

                                {needsScreenPermission && (
                                    <button onClick={openScreenRecordingSettings} className="no-drag mt-3 w-full bg-blue-600/20 hover:bg-blue-600/40 text-blue-200 px-3 py-2 rounded-xl text-xs font-bold">Open Screen Recording Settings</button>
                                )}

                                {messages.length > 0 && (
                                    <div className="no-drag mt-4 border-t border-white/10 pt-3">
                                        <label className="block text-[10px] text-white/40 uppercase font-black mb-2">Follow-up</label>
                                        {recommendations.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {recommendations.map((rec, i) => (
                                                    <button
                                                        key={`${rec}-${i}`}
                                                        onClick={() => {
                                                            setFollowUp(rec)
                                                            setRecommendations([])
                                                            setTimeout(() => document.getElementById('send-followup-btn')?.click(), 50)
                                                        }}
                                                        className="no-drag text-[9px] px-3 py-1.5 rounded-full bg-blue-600/10 border border-blue-500/20 text-blue-200 hover:bg-blue-600/20 transition-all font-bold uppercase tracking-tight"
                                                    >
                                                        {rec}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex gap-2 items-start">
                                            <textarea
                                                value={followUp}
                                                onChange={(e) => setFollowUp(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault()
                                                        sendFollowUp()
                                                    }
                                                }}
                                                placeholder="Ask a follow-up..."
                                                rows={2}
                                                className="no-drag bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white w-full outline-none focus:border-blue-500/50 resize-none"
                                            />
                                            <div className="flex flex-col gap-2">
                                                <button type="button" onClick={() => followUpImageInputRef.current?.click()} className="no-drag bg-white/10 hover:bg-white/20 text-white/80 p-2 rounded-xl transition-all hover:scale-105 active:scale-95"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg></button>
                                                <button id="send-followup-btn" type="button" onClick={sendFollowUp} disabled={followUpLoading || (!followUp.trim() && !followUpImage)} className="no-drag bg-blue-600/20 hover:bg-blue-600/40 disabled:opacity-50 text-blue-200 p-2 rounded-xl ">{followUpLoading ? <div className="w-4 h-4 border-2 border-blue-200/30 border-t-blue-200 rounded-full animate-spin" /> : <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>}</button>
                                            </div>
                                        </div>
                                        {followUpImage && (
                                            <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 p-2">
                                                <img src={followUpImage.dataUrl} alt="Attached" className="h-12 w-12 rounded-lg object-cover" />
                                                <div className="flex-1 min-w-0"><div className="text-[10px] text-white/70 truncate">{followUpImage.name || 'Image'}</div></div>
                                                <button type="button" onClick={() => setFollowUpImage(null)} className="no-drag text-[10px] text-white/50 hover:text-white/80">Remove</button>
                                            </div>
                                        )}
                                        <input ref={followUpImageInputRef} type="file" accept="image/*" onChange={handleFollowUpImageChange} className="hidden" />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    <div
                        className={`glass drag h-16 px-6 rounded-full flex items-center gap-4 transition-all duration-500 group cursor-move ${loading || analyzingDeep ? 'opacity-80' : 'opacity-100'}`}
                        style={{ maxWidth: 'min(100%, 960px)' }}
                    >
                        <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full transition-all duration-300 relative ${loading || analyzingDeep ? 'bg-yellow-400' : 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)]'}`}>
                                <div className={`absolute inset-0 rounded-full animate-ping ${loading || analyzingDeep ? 'bg-yellow-400/40' : 'bg-green-500/40'}`} />
                            </div>
                            <span className="text-white font-medium text-sm tracking-tight">{loading || analyzingDeep ? 'Analyzing...' : `${getProviderLabel()} Online`}</span>
                        </div>
                        <div className="w-[1px] h-6 bg-white/10" />
                        <button onClick={handleCapture} disabled={loading || analyzingDeep || followUpLoading} className="no-drag bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 text-white px-5 py-2 rounded-full text-xs font-bold transition-all shadow-lg active:translate-y-0.5">Quick Solve</button>
                        <button onClick={handleDeepAnalysis} disabled={loading || analyzingDeep || followUpLoading} className={`no-drag px-5 py-2 rounded-full text-xs font-bold transition-all border ${analyzingDeep ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200' : 'bg-transparent border-white/20 hover:border-white/40 text-white/80'}`}>{analyzingDeep ? 'Analyzing...' : 'Deep Analysis'}</button>
                        <button onClick={() => setShowSettings(!showSettings)} className="no-drag text-white/40 hover:text-white/100 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l-.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg></button>
                        <button onClick={() => { setShowSettings(false); setIsCollapsed(true) }} className="no-drag text-white/40 hover:text-white/100 transition-colors text-xs">Hide</button>
                    </div>

                    {showSettings && (
                        <div
                            className="glass no-drag mt-4 rounded-2xl w-full animate-in fade-in zoom-in-95 duration-200 shadow-2xl overflow-hidden flex flex-col border border-white/10"
                            style={{ maxWidth: 'min(100%, 420px)' }}
                        >
                            <div className="bg-black/40 border-b border-white/5 px-4 py-2 flex items-center justify-between drag">
                                <div className="flex gap-1.5 no-drag">
                                    <div className="w-3 h-3 rounded-full bg-[#ff5f57] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#febc2e] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#28c840] border border-black/10" />
                                </div>
                                <span className="text-[10px] font-black text-white/30 uppercase tracking-widest">Settings</span>
                                <button type="button" onClick={() => setShowSettings(false)} className="no-drag text-white/30 hover:text-white/60 transition-colors text-xs font-bold">✕</button>
                            </div>

                            <div className="px-2 py-3 overflow-y-auto max-h-[62vh]">
                                <form onSubmit={saveSettings} className="space-y-4">
                                    {/* Provider Selector */}
                                    <div className="space-y-2">
                                        <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">AI Provider</label>
                                        <div className="grid grid-cols-3 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setProvider('codex')}
                                                className={`no-drag px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                                                    provider === 'codex'
                                                        ? 'bg-blue-600 text-white'
                                                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                                                }`}
                                            >
                                                Codex
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setProvider('gemini')}
                                                className={`no-drag px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                                                    provider === 'gemini'
                                                        ? 'bg-blue-600 text-white'
                                                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                                                }`}
                                            >
                                                Gemini
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setProvider('kimi')}
                                                className={`no-drag px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                                                    provider === 'kimi'
                                                        ? 'bg-blue-600 text-white'
                                                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                                                }`}
                                            >
                                                Kimi
                                            </button>
                                        </div>
                                    </div>

                                    {/* Model Input */}
                                    <div className="space-y-2">
                                        <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Model</label>
                                        <input 
                                            type="text" 
                                            value={modelName} 
                                            onChange={(e) => setModelName(e.target.value)} 
                                            placeholder={getModelPlaceholder()} 
                                            className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50" 
                                        />
                                        <p className="text-[9px] text-white/30">
                                            {provider === 'codex' && 'Default: gpt-5'}
                                            {provider === 'gemini' && 'Default: gemini-2.0-flash'}
                                            {provider === 'kimi' && 'Default: kimi-k2-0711-preview'}
                                        </p>
                                    </div>

                                    {/* API Key Inputs - Show based on provider */}
                                    {provider === 'gemini' && (
                                        <div className="space-y-2">
                                            <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Gemini API Key</label>
                                            <input 
                                                type="password" 
                                                value={geminiApiKey} 
                                                onChange={(e) => setGeminiApiKey(e.target.value)} 
                                                placeholder="Enter your Gemini API key..."
                                                className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50" 
                                            />
                                            <p className="text-[9px] text-white/30">Get your key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Google AI Studio</a></p>
                                        </div>
                                    )}

                                    {provider === 'kimi' && (
                                        <div className="space-y-2">
                                            <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Kimi API Key</label>
                                            <input 
                                                type="password" 
                                                value={kimiApiKey} 
                                                onChange={(e) => setKimiApiKey(e.target.value)} 
                                                placeholder="Enter your Kimi API key..."
                                                className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50" 
                                            />
                                            <p className="text-[9px] text-white/30">Get your key from <a href="https://platform.moonshot.cn/console/api-keys" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Kimi Platform</a></p>
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Session Context</label>
                                        <textarea
                                            value={sessionContext}
                                            onChange={(e) => setSessionContext(e.target.value)}
                                            placeholder="Optional context for this session..."
                                            rows={3}
                                            className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white w-full outline-none focus:border-blue-500/50 resize-none"
                                        />
                                        <p className="text-[9px] text-white/30 italic">Session context stays in memory only (not persisted).</p>
                                    </div>

                                    {provider === 'codex' && (
                                        <p className="text-[10px] text-white/25 italic text-center">Run `codex login` in your terminal before using the assistant.</p>
                                    )}

                                    <button 
                                        type="submit" 
                                        className="no-drag w-full bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 px-4 py-2.5 rounded-xl text-xs font-bold transition-colors"
                                    >
                                        Save Settings
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

export default AssistantWidget
