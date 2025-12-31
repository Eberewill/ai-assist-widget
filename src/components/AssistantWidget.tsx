import React, { useState, useEffect, useRef } from 'react'
import { GoogleGenerativeAI } from '@google/generative-ai'

const COLLAPSED_HEIGHT = 120
const SETTINGS_HEIGHT = 300
const RESPONSE_HEIGHT = 460
const COLLAPSED_WIDTH = 120
const EXPANDED_WIDTH = 600
const DEFAULT_MODEL = 'gemini-2.0-flash'

const AssistantWidget: React.FC = () => {
    const [loading, setLoading] = useState(false)
    const [response, setResponse] = useState<string | null>(null)
    const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '')
    const [modelName, setModelName] = useState(localStorage.getItem('gemini_model') || DEFAULT_MODEL)
    const [showSettings, setShowSettings] = useState(!apiKey)
    const [copied, setCopied] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [needsScreenPermission, setNeedsScreenPermission] = useState(false)
    const [listingModels, setListingModels] = useState(false)
    const apiKeyInputRef = useRef<HTMLInputElement | null>(null)


    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (ipc) {
            console.log('[RENDERER] IPC Bridge connected')
        } else {
            console.error('[RENDERER] IPC Bridge NOT FOUND. Ensure you are running in Electron.')
        }
    }, [])

    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (!ipc?.invoke) {
            return
        }
        const size = isCollapsed
            ? { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT }
            : {
                width: EXPANDED_WIDTH,
                height: response ? RESPONSE_HEIGHT : showSettings ? SETTINGS_HEIGHT : COLLAPSED_HEIGHT,
            }
        ipc.invoke('resize-window', size).catch((error: unknown) => {
            console.warn('[RENDERER] Window resize failed:', error)
        })
    }, [response, showSettings, isCollapsed])

    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (!ipc?.invoke) {
            return
        }
        // The window should ALWAYS be clickable if the widget is visible.
        const shouldBeClickable = true
        ipc.invoke('set-focusable', { focusable: shouldBeClickable }).catch((error: unknown) => {
            console.warn('[RENDERER] Interaction toggle failed:', error)
        })
    }, [showSettings, isCollapsed])

    const handleCapture = async () => {
        const ipc = (window as any).ipcRenderer
        console.log('[RENDERER] Starting Quick Solve...')

        if (!ipc) {
            setResponse('Error: IPC Bridge not found.')
            return
        }

        if (!apiKey || !modelName.trim()) {
            setShowSettings(true)
            return
        }

        setLoading(true)
        setResponse(null)
        setNeedsScreenPermission(false)

        try {
            console.log('[RENDERER] Invoking capture-screen...')
            const base64Image = await ipc.invoke('capture-screen')
            console.log('[RENDERER] Capture received. Length:', base64Image?.length)

            if (!base64Image) {
                throw new Error('No image data received from capture-screen')
            }

            const selectedModel = modelName.trim() || DEFAULT_MODEL
            const genAI = new GoogleGenerativeAI(apiKey)
            console.log('[RENDERER] Using model:', selectedModel)
            const model = genAI.getGenerativeModel({ model: selectedModel })

            const systemPrompt = `You are a professional on-screen coding assistant. 
1. Analyze the provided image.
2. If you see code, a technical problem, or a question, solve it concisely.
3. Provide ONLY the solution (code or answer). No conversational filler like "Here is the code".
4. If multiple tasks exist, solve the most visible one.`

            console.log('[RENDERER] Sending request to Gemini...')
            const result = await model.generateContent([
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: "image/png"
                    }
                },
                systemPrompt,
            ])

            console.log('[RENDERER] Gemini response received.')
            const text = result.response.text()
            console.log('[RENDERER] Response text length:', text?.length)

            if (!text || text.trim() === '') {
                setResponse('Gemini didn\'t find anything to solve on the screen. Make sure the problem is clearly visible.')
            } else {
                // Strip markdown code blocks (e.g., ```typescript ... ```)
                const cleanText = text.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1').trim()
                setResponse(cleanText)
            }
        } catch (error) {
            console.error('[RENDERER] Error in handleCapture:', error)
            const message = error instanceof Error ? error.message : String(error)

            if (/Screen capture returned an empty image|Screen Recording/i.test(message)) {
                setNeedsScreenPermission(true)
                setResponse('Screen capture is blocked. Grant Screen Recording permission in System Settings and try again.')
            } else if (/not found|not supported|404|model/i.test(message)) {
                setResponse(
                    `API Error: The model "${modelName}" was not found.\n\nTry these IDs in settings:\n1. gemini-2.0-flash\n2. gemini-1.5-flash\n3. gemini-2.0-flash-exp\n\nOr click "List Available Models" in settings to check your key.`,
                )
            } else {
                setResponse(`Error: ${message}`)
            }
            setNeedsScreenPermission(false)
        } finally {
            console.log('[RENDERER] Analysis session finished.')
            setLoading(false)
        }
    }

    const copyToClipboard = () => {
        if (response) {
            navigator.clipboard.writeText(response)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        }
    }

    const listModels = async () => {
        if (!apiKey) return
        setListingModels(true)
        try {
            console.log('[RENDERER] Fetching available models...')
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
            const data = await res.json()

            if (data.models) {
                const modelIds = data.models.map((m: any) => m.name.replace('models/', ''))
                console.log('[RENDERER] Available Models:', modelIds)
                setResponse(`Available Models (Check Console for details):\n\n${modelIds.slice(0, 10).join('\n')}${modelIds.length > 10 ? '\n...' : ''}`)
            } else {
                console.warn('[RENDERER] No models list in response:', data)
                setResponse(`API responded but no models were found. Full response in console.`)
            }
        } catch (error) {
            console.error('[RENDERER] List models failed:', error)
            setResponse(`Failed to list models: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            setListingModels(false)
        }
    }

    const saveSettings = (e: React.FormEvent) => {
        e.preventDefault()
        const nextModel = modelName.trim() || DEFAULT_MODEL
        localStorage.setItem('gemini_api_key', apiKey)
        localStorage.setItem('gemini_model', nextModel)
        setModelName(nextModel)
        setShowSettings(false)
        console.log('[RENDERER] Settings updated.')
    }

    const openScreenRecordingSettings = () => {
        const ipc = (window as any).ipcRenderer
        if (!ipc?.invoke) {
            return
        }
        ipc.invoke('open-screen-capture-settings').catch((error: unknown) => {
            console.warn('[RENDERER] Open settings failed:', error)
        })
    }

    return (
        <div className="flex flex-col items-center gap-3" aria-hidden="true">
            {isCollapsed ? (
                <div className="glass drag flex items-center justify-center px-2 py-2 rounded-full shadow-lg cursor-move">
                    <button
                        onClick={() => setIsCollapsed(false)}
                        className="no-drag bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-lg shadow-blue-500/20 active:translate-y-0.5"
                    >
                        Open
                    </button>
                </div>
            ) : (
                <>
                    {/* Response Card */}
                    {response && (
                        <div className="glass no-drag w-[500px] p-4 rounded-2xl animate-in fade-in slide-in-from-bottom-4 duration-300 overflow-auto max-h-[300px]">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-xs font-bold text-white/50 uppercase tracking-widest">Solution</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => {
                                            setResponse(null)
                                            setNeedsScreenPermission(false)
                                        }}
                                        className="no-drag text-xs text-white/40 hover:text-white/80 transition-colors"
                                    >
                                        Clear
                                    </button>
                                    <button
                                        onClick={copyToClipboard}
                                        className={`no-drag text-xs px-2 py-1 rounded transition-colors ${copied ? 'bg-green-500/20 text-green-400' : 'bg-white/10 hover:bg-white/20 text-white'}`}
                                    >
                                        {copied ? 'Copied!' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                            <pre className="text-sm text-blue-100 whitespace-pre-wrap font-mono leading-relaxed">
                                {response}
                            </pre>
                            {needsScreenPermission && (
                                <button
                                    onClick={openScreenRecordingSettings}
                                    className="no-drag mt-3 w-full bg-blue-600/20 hover:bg-blue-600/40 text-blue-200 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
                                >
                                    Open Screen Recording Settings
                                </button>
                            )}
                        </div>
                    )}

                    {/* Main Bar */}
                    <div className={`glass drag h-16 px-6 rounded-full flex items-center gap-4 transition-all duration-500 group cursor-move ${loading ? 'opacity-80' : 'opacity-100'}`}>
                        <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full transition-colors duration-300 ${loading ? 'bg-yellow-400 animate-pulse' : 'bg-blue-500'}`} />
                            <span className="text-white font-medium text-sm tracking-tight">
                                {loading ? 'Analyzing...' : 'On-Screen Assistant'}
                            </span>
                        </div>

                        <div className="w-[1px] h-6 bg-white/10" />

                        <button
                            onClick={handleCapture}
                            disabled={loading}
                            className="no-drag bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 text-white px-5 py-2 rounded-full text-xs font-bold transition-all shadow-lg shadow-blue-500/20 active:translate-y-0.5"
                        >
                            {loading ? 'Working...' : 'Quick Solve'}
                        </button>

                        <button
                            onClick={() => setShowSettings(!showSettings)}
                            className="no-drag text-white/40 hover:text-white/100 transition-colors"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l-.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
                        </button>

                        <button
                            onClick={() => {
                                setShowSettings(false)
                                setIsCollapsed(true)
                            }}
                            className="no-drag text-white/40 hover:text-white/100 transition-colors text-xs"
                        >
                            Hide
                        </button>
                    </div>

                    {/* Settings Modal */}
                    {showSettings && (
                        <div className="glass no-drag mt-4 p-5 rounded-2xl w-80 animate-in fade-in zoom-in-95 duration-200">
                            <form onSubmit={saveSettings}>
                                <label className="block text-[10px] text-white/40 uppercase font-black mb-3">Gemini API Key</label>
                                <div className="flex gap-2">
                                    <input
                                        type="password"
                                        value={apiKey}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        placeholder="Paste API key..."
                                        ref={apiKeyInputRef}
                                        className="no-drag bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50"
                                    />
                                    <button
                                        type="submit"
                                        className="no-drag bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
                                    >
                                        Save
                                    </button>
                                </div>
                                <label className="block text-[10px] text-white/40 uppercase font-black mt-4 mb-3">Gemini Model</label>
                                <input
                                    type="text"
                                    value={modelName}
                                    onChange={(e) => setModelName(e.target.value)}
                                    placeholder={DEFAULT_MODEL}
                                    className="no-drag bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50"
                                />
                                <div className="flex flex-wrap gap-1 mt-2">
                                    {['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'].map((m) => (
                                        <button
                                            key={m}
                                            type="button"
                                            onClick={() => setModelName(m)}
                                            className="text-[9px] bg-white/5 hover:bg-white/10 text-white/40 hover:text-white px-2 py-1 rounded transition-colors"
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    type="button"
                                    onClick={listModels}
                                    disabled={listingModels}
                                    className="no-drag mt-4 w-full bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white/60 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all"
                                >
                                    {listingModels ? 'Listing...' : 'List Available Models'}
                                </button>
                                <p className="text-[10px] text-white/20 mt-3 italic text-center">API key is saved locally in your browser storage.</p>
                            </form>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

export default AssistantWidget
