import React, { useState, useEffect, useRef } from 'react'
import { GoogleGenerativeAI } from '@google/generative-ai'

const COLLAPSED_HEIGHT = 120
const SETTINGS_HEIGHT = 360
const RESPONSE_HEIGHT = 560
const COLLAPSED_WIDTH = 120
const EXPANDED_WIDTH = 960
const DEFAULT_MODEL = 'gemini-2.0-flash'

type ChatMessage = {
    role: 'user' | 'assistant'
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

function readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result)
            } else {
                reject(new Error('Failed to parse audio data'))
            }
        }
        reader.onerror = () => {
            reject(reader.error ?? new Error('Error reading audio blob'))
        }
        reader.readAsDataURL(blob)
    })
}

const AssistantWidget: React.FC = () => {
    const [loading, setLoading] = useState(false)
    const [analyzingDeep, setAnalyzingDeep] = useState(false)
    const [response, setResponse] = useState<string | null>(null)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '')
    const [modelName, setModelName] = useState(localStorage.getItem('gemini_model') || DEFAULT_MODEL)
    const [showSettings, setShowSettings] = useState(!apiKey)
    const [copied, setCopied] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [needsScreenPermission, setNeedsScreenPermission] = useState(false)
    const [listingModels, setListingModels] = useState(false)
    const [followUp, setFollowUp] = useState('')
    const [followUpImage, setFollowUpImage] = useState<FollowUpImage | null>(null)
    const [followUpLoading, setFollowUpLoading] = useState(false)
    const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null)
    const [isRecording, setIsRecording] = useState(false)
    const [interviewMode, setInterviewMode] = useState(false)
    const [interviewContext, setInterviewContext] = useState(localStorage.getItem('gemini_interview_context') || '')
    const [isStreaming, setIsStreaming] = useState(false)
    const [streamedResponse, setStreamedResponse] = useState('')

    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const audioContextRef = useRef<AudioContext | null>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const [recommendations, setRecommendations] = useState<string[]>([])
    const apiKeyInputRef = useRef<HTMLInputElement | null>(null)
    const followUpImageInputRef = useRef<HTMLInputElement | null>(null)
    const chatSessionRef = useRef<any>(null)

    const processResponse = (fullText: string) => {
        const lines = fullText.split('\n')
        const suggestions = lines
            .filter(l => l.startsWith('Suggestion:'))
            .map(l => l.replace('Suggestion:', '').trim())

        const cleanText = lines
            .filter(l => !l.startsWith('Suggestion:'))
            .join('\n')
            .trim()

        return { cleanText, suggestions }
    }

    const toggleRecording = async () => {
        if (isRecording) {
            mediaRecorderRef.current?.stop()
            setIsRecording(false)
            return
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const recorder = new MediaRecorder(stream)
            const chunks: Blob[] = []

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunks.push(e.data)
            }

            recorder.onstop = async () => {
                const audioBlob = new Blob(chunks, { type: 'audio/webm' })
                await processAudio(audioBlob)
                stream.getTracks().forEach(track => track.stop())
            }

            mediaRecorderRef.current = recorder
            recorder.start()
            setIsRecording(true)
        } catch (error) {
            console.error('[RENDERER] Mic access failed:', error)
            setResponse('Microphone access denied or not found.')
        }
    }

    const processAudio = async (blob: Blob) => {
        setLoading(true)
        setIsStreaming(interviewMode)
        setStreamedResponse('')

        try {
            const dataUrl = await readBlobAsDataUrl(blob)
            const [, base64Audio] = dataUrl.split(',')
            if (!base64Audio) {
                throw new Error('Audio conversion failed')
            }
            const genAI = new GoogleGenerativeAI(apiKey)
            const model = genAI.getGenerativeModel({ model: modelName || DEFAULT_MODEL })

            const contextSuffix = interviewContext ? `\n\nINTERVIEW CONTEXT (User's Resume/Job Description):\n${interviewContext}` : ''
            const prompt = `Listen to the audio and answer the user's question directly and concisely. 
DO NOT transcribe what the user said. DO NOT start with "You said" or "I heard". 
Just provide the best possible answer or solution to their query as if having a normal conversation in a technical interview setting.
${contextSuffix}

Also, provide 3 short logical follow-up actions (max 6 words each) at the end, each on a new line starting with 'Suggestion: '.`

            if (interviewMode) {
                const result = await model.generateContentStream([
                    { inlineData: { data: base64Audio, mimeType: 'audio/webm' } },
                    prompt,
                ])

                let fullText = ''
                for await (const chunk of result.stream) {
                    const chunkText = chunk.text()
                    fullText += chunkText
                    setStreamedResponse(fullText)
                }

                const { cleanText, suggestions } = processResponse(fullText)
                setMessages((prev) => [...prev, { role: 'assistant', text: cleanText }])
                setRecommendations(suggestions)
                setIsStreaming(false)
                setStreamedResponse('')
            } else {
                const result = await model.generateContent([
                    { inlineData: { data: base64Audio, mimeType: 'audio/webm' } },
                    prompt,
                ])
                const fullText = result.response.text().trim()
                const { cleanText, suggestions } = processResponse(fullText)
                setMessages([{ role: 'assistant', text: cleanText }])
                setRecommendations(suggestions)
            }
        } catch (error) {
            console.error('[RENDERER] Audio processing failed:', error)
            setResponse(`Audio Error: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            setLoading(false)
            if (interviewMode) {
                setIsStreaming(false)
                setStreamedResponse('')
            }
        }
    }

    useEffect(() => {
        if (interviewMode) {
            startContinuousListening()
        } else {
            stopContinuousListening()
        }
        return () => stopContinuousListening()
    }, [interviewMode])

    const startContinuousListening = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream

            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
            audioContextRef.current = audioContext

            const analyser = audioContext.createAnalyser()
            analyser.fftSize = 256
            analyserRef.current = analyser

            const source = audioContext.createMediaStreamSource(stream)
            source.connect(analyser)

            const recorder = new MediaRecorder(stream)
            mediaRecorderRef.current = recorder
            let chunks: Blob[] = []
            let speechDetected = false

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunks.push(e.data)
            }

            recorder.onstop = async () => {
                if (speechDetected && chunks.length > 0) {
                    const audioBlob = new Blob(chunks, { type: 'audio/webm' })
                    await processAudio(audioBlob)
                }
                chunks = []
                speechDetected = false
                if (interviewMode && streamRef.current) {
                    recorder.start()
                }
            }

            recorder.start()
            setIsRecording(true)

            const bufferLength = analyser.frequencyBinCount
            const dataArray = new Uint8Array(bufferLength)
            let lastInteraction = Date.now()
            const SILENCE_THRESHOLD = 35
            const SILENCE_DURATION = 2000

            const checkVolume = () => {
                if (!analyserRef.current || !interviewMode) return

                analyser.getByteFrequencyData(dataArray)
                const volume = dataArray.reduce((a, b) => a + b) / bufferLength

                if (volume > SILENCE_THRESHOLD) {
                    lastInteraction = Date.now()
                    speechDetected = true
                } else {
                    if (Date.now() - lastInteraction > SILENCE_DURATION && recorder.state === 'recording') {
                        recorder.stop()
                        lastInteraction = Date.now()
                    }
                }

                if (interviewMode) {
                    requestAnimationFrame(checkVolume)
                }
            }

            checkVolume()
        } catch (error) {
            console.error('[RENDERER] Interview mode failed:', error)
            setInterviewMode(false)
        }
    }

    const stopContinuousListening = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop()
        }
        streamRef.current?.getTracks().forEach(track => track.stop())
        streamRef.current = null
        audioContextRef.current?.close()
        audioContextRef.current = null
        analyserRef.current = null
        setIsRecording(false)
    }

    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (ipc) {
            console.log('[RENDERER] IPC Bridge connected')
        }
    }, [])

    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (!ipc?.invoke) {
            return
        }
        // Resize logic accounting for streaming state
        const hasContent = Boolean(response) || messages.length > 0 || isStreaming
        const size = isCollapsed
            ? { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT }
            : {
                width: EXPANDED_WIDTH,
                height: hasContent ? RESPONSE_HEIGHT : showSettings ? SETTINGS_HEIGHT : COLLAPSED_HEIGHT,
            }
        ipc.invoke('resize-window', size).catch((error: unknown) => {
            console.warn('[RENDERER] Window resize failed:', error)
        })
    }, [response, messages.length, showSettings, isCollapsed, isStreaming])

    useEffect(() => {
        const ipc = (window as any).ipcRenderer
        if (!ipc?.invoke) {
            return
        }
        const shouldBeClickable = true
        ipc.invoke('set-focusable', { focusable: shouldBeClickable }).catch((error: unknown) => {
            console.warn('[RENDERER] Interaction toggle failed:', error)
        })
    }, [showSettings, isCollapsed])

    const handleCapture = async () => {
        const ipc = (window as any).ipcRenderer
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
        setMessages([])
        setFollowUp('')
        setFollowUpImage(null)
        chatSessionRef.current = null

        try {
            const captureData = await ipc.invoke('capture-screen')
            if (!captureData) {
                throw new Error('No image data received from capture-screen')
            }
            const base64Image = captureData.includes(',') ? captureData.split(',')[1] : captureData

            const selectedModel = modelName.trim() || DEFAULT_MODEL
            const genAI = new GoogleGenerativeAI(apiKey)
            const model = genAI.getGenerativeModel({ model: selectedModel })

            const systemPrompt = `You are a professional on-screen coding assistant. 
1. Analyze the provided image.
2. If you see code, a technical problem, or a question, solve it concisely.
3. Provide ONLY the solution (code or answer). No conversational filler.
4. If multiple tasks exist, solve the most visible one.`

            const result = await model.generateContent([
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: "image/png"
                    }
                },
                systemPrompt,
            ])

            const text = result.response.text()
            if (!text || text.trim() === '') {
                setResponse('Gemini didn\'t find anything to solve on the screen.')
            } else {
                const cleanText = text.trim()
                setMessages([{ role: 'assistant', text: cleanText }])
                chatSessionRef.current = model.startChat({
                    history: [
                        {
                            role: 'user',
                            parts: [
                                {
                                    inlineData: {
                                        data: base64Image,
                                        mimeType: 'image/png',
                                    },
                                },
                                { text: systemPrompt },
                            ],
                        },
                        { role: 'model', parts: [{ text: cleanText }] },
                    ],
                })
            }
        } catch (error) {
            console.error('[RENDERER] Error in handleCapture:', error)
            const message = error instanceof Error ? error.message : String(error)

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
        const ipc = (window as any).ipcRenderer
        if (!ipc) {
            setResponse('Error: IPC Bridge not found.')
            return
        }

        if (!apiKey || !modelName.trim()) {
            setShowSettings(true)
            return
        }

        setAnalyzingDeep(true)
        setResponse(null)
        setNeedsScreenPermission(false)
        setMessages([])
        setFollowUp('')
        setFollowUpImage(null)
        chatSessionRef.current = null

        try {
            const captureData = await ipc.invoke('capture-screen')
            const structure = await ipc.invoke('analyze-screen-deep')

            if (!captureData) {
                throw new Error('No image data received from capture-screen')
            }
            const base64Image = captureData.includes(',') ? captureData.split(',')[1] : captureData

            const selectedModel = modelName.trim() || DEFAULT_MODEL
            const genAI = new GoogleGenerativeAI(apiKey)
            const model = genAI.getGenerativeModel({ model: selectedModel })

            const systemPrompt = `You are a God-mode macOS assistant. 
You have two sources of context:
1. RAW PIXELS: The provided screenshot.
2. SEMANTIC STRUCTURE: A JSON tree of UI elements (buttons, text fields, values) from the active window.

CONTEXT (Semantic Structure):
${JSON.stringify(structure, null, 2)}

TASK:
Analyze the screen and solve the user's problem. 
BE EXTREMELY PRECISE. If you see code in a text area, use it. 
If you see a button that should be interacted with, guide the user to it by its exact name.

Provide a concise, professional solution.
Also, provide 3 short logical follow-up actions (max 6 words each) at the end, each on a new line starting with 'Suggestion: '.`

            const result = await model.generateContent([
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: "image/png"
                    }
                },
                systemPrompt,
            ])

            const fullText = result.response.text().trim()
            if (!fullText) {
                setResponse('Gemini didn\'t find anything to analyze.')
            } else {
                const { cleanText, suggestions } = processResponse(fullText)
                setMessages([{ role: 'assistant', text: cleanText }])
                setRecommendations(suggestions)

                chatSessionRef.current = model.startChat({
                    history: [
                        {
                            role: 'user',
                            parts: [
                                {
                                    inlineData: {
                                        data: base64Image,
                                        mimeType: 'image/png',
                                    },
                                },
                                { text: systemPrompt },
                            ],
                        },
                        { role: 'model', parts: [{ text: fullText }] },
                    ],
                })
            }
        } catch (error) {
            console.error('[RENDERER] Error in handleDeepAnalysis:', error)
            setResponse(`Deep Analysis Error: ${error instanceof Error ? error.message : String(error)}`)
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
        if (!chatSessionRef.current) {
            setResponse('No active context. Run Quick Solve first.')
            return
        }

        setFollowUpLoading(true)
        setMessages((prev) => [
            ...prev,
            {
                role: 'user',
                text: trimmed,
                image: followUpImage
                    ? {
                        dataUrl: followUpImage.dataUrl,
                        name: followUpImage.name,
                    }
                    : undefined,
            },
        ])
        setFollowUp('')
        setFollowUpImage(null)

        try {
            const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = []
            if (trimmed) parts.push({ text: trimmed })
            if (followUpImage) {
                parts.push({
                    inlineData: {
                        data: followUpImage.base64,
                        mimeType: followUpImage.mimeType,
                    },
                })
            }

            const result = await chatSessionRef.current.sendMessage(parts.length > 1 ? parts : (trimmed || parts[0]))
            const text = result.response.text()
            const { cleanText, suggestions } = processResponse(text)

            setMessages((prev) => [...prev, { role: 'assistant', text: cleanText }])
            setRecommendations(suggestions)
        } catch (error) {
            setMessages((prev) => [...prev, { role: 'assistant', text: `Error: ${error instanceof Error ? error.message : String(error)}` }])
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

    const listModels = async () => {
        if (!apiKey) return
        setListingModels(true)
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
            const data = await res.json()
            if (data.models) {
                const modelIds = data.models.map((m: any) => m.name.replace('models/', ''))
                setResponse(`Available Models:\n\n${modelIds.slice(0, 10).join('\n')}`)
            }
        } catch (error) {
            setResponse(`Failed to list models.`)
        } finally {
            setListingModels(false)
        }
    }

    const saveSettings = (e: React.FormEvent) => {
        e.preventDefault()
        const nextModel = modelName.trim() || DEFAULT_MODEL
        localStorage.setItem('gemini_api_key', apiKey)
        localStorage.setItem('gemini_model', nextModel)
        localStorage.setItem('gemini_interview_context', interviewContext)
        setShowSettings(false)
        setMessages([])
        chatSessionRef.current = null
    }

    const openScreenRecordingSettings = () => {
        const ipc = (window as any).ipcRenderer
        ipc?.invoke('open-screen-capture-settings')
    }

    return (
        <div className="widget-layer flex flex-col items-stretch gap-3 pt-6 w-full px-4" aria-hidden="true">
            {isCollapsed ? (
                <div className="glass drag flex items-center justify-center px-2 py-2 rounded-full shadow-lg cursor-move">
                    <button onClick={() => setIsCollapsed(false)} className="no-drag bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-full text-xs font-bold transition-all shadow-lg active:translate-y-0.5">Open</button>
                </div>
            ) : (
                <>
                    {(response || messages.length > 0 || isStreaming) && (
                        <div
                            className="glass no-drag w-full rounded-2xl animate-in fade-in slide-in-from-bottom-4 duration-300 overflow-hidden shadow-2xl flex flex-col"
                            style={{ maxWidth: 'min(100%, 960px)' }}
                        >
                            {/* macOS Style Title Bar */}
                            <div className="bg-black/40 border-b border-white/5 px-4 py-2.5 flex items-center justify-between drag">
                                <div className="flex gap-1.5 no-drag">
                                    <div className="w-3 h-3 rounded-full bg-[#ff5f57] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#febc2e] border border-black/10" />
                                    <div className="w-3 h-3 rounded-full bg-[#28c840] border border-black/10" />
                                </div>
                                <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Solution Insight</span>
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
                                            chatSessionRef.current = null
                                            setIsStreaming(false)
                                            setStreamedResponse('')
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
                                        <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[90%] rounded-2xl px-4 py-3 border break-words ${msg.role === 'user' ? 'bg-blue-600/20 border-blue-400/20 text-white' : 'bg-white/5 border-white/10 text-white'}`}>
                                                <span className="block text-[10px] uppercase tracking-widest text-white/50 mb-1">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                                                {renderMessageContent(msg.text, `${msg.role}-${index}`)}
                                            </div>
                                        </div>
                                    ))}
                                    {isStreaming && streamedResponse && (
                                        <div className="flex justify-start">
                                            <div className="max-w-[90%] rounded-2xl px-4 py-3 border border-white/10 bg-white/5 text-white">
                                                <span className="block text-[10px] uppercase tracking-widest text-white/50 mb-1">AI Typing...</span>
                                                {renderMessageContent(streamedResponse, 'streaming')}
                                            </div>
                                        </div>
                                    )}
                                    {response && !messages.length && !isStreaming && <div className="text-white text-sm whitespace-pre-wrap break-words">{response}</div>}
                                </div>
                                {needsScreenPermission && (
                                    <button onClick={openScreenRecordingSettings} className="no-drag mt-3 w-full bg-blue-600/20 hover:bg-blue-600/40 text-blue-200 px-3 py-2 rounded-xl text-xs font-bold">Open Screen Recording Settings</button>
                                )}
                                {messages.length > 0 && !isStreaming && (
                                    <div className="no-drag mt-4 border-t border-white/10 pt-3">
                                        <label className="block text-[10px] text-white/40 uppercase font-black mb-2">Follow-up</label>
                                        {recommendations.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {recommendations.map((rec, i) => (
                                                    <button key={i} onClick={() => { setFollowUp(rec); setRecommendations([]); setTimeout(() => document.getElementById('send-followup-btn')?.click(), 50) }} className="no-drag text-[9px] px-3 py-1.5 rounded-full bg-blue-600/10 border border-blue-500/20 text-blue-200 hover:bg-blue-600/20 transition-all font-bold uppercase tracking-tight">{rec}</button>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex gap-2 items-start">
                                            <textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp() } }} placeholder="Ask a follow-up..." rows={2} className="no-drag bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white w-full outline-none focus:border-blue-500/50 resize-none" />
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
                                {(loading || analyzingDeep || !loading) && (
                                    <div className={`absolute inset-0 rounded-full animate-ping ${loading || analyzingDeep ? 'bg-yellow-400/40' : 'bg-green-500/40'}`} />
                                )}
                            </div>
                            <span className="text-white font-medium text-sm tracking-tight">{loading || analyzingDeep ? 'Analyzing...' : 'Online'}</span>
                        </div>
                        <div className="w-[1px] h-6 bg-white/10" />
                        <button onClick={handleCapture} disabled={loading || analyzingDeep || isRecording} className="no-drag bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 text-white px-5 py-2 rounded-full text-xs font-bold transition-all shadow-lg active:translate-y-0.5">Quick Solve</button>
                        <button onClick={handleDeepAnalysis} disabled={loading || analyzingDeep || isRecording} className={`no-drag px-5 py-2 rounded-full text-xs font-bold transition-all border ${analyzingDeep ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200' : 'bg-transparent border-white/20 hover:border-white/40 text-white/80'}`}>{analyzingDeep ? 'Analyzing...' : 'Deep Analysis'}</button>
                        <button onClick={toggleRecording} disabled={loading || analyzingDeep || interviewMode} className={`no-drag px-5 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 ${isRecording ? 'bg-red-600 text-white animate-pulse' : 'bg-white/10 hover:bg-white/20 text-white/90'}`}><div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-white' : 'bg-red-500'}`} />{isRecording ? 'Stop' : 'Record'}</button>
                        <button onClick={() => setInterviewMode(!interviewMode)} disabled={loading || analyzingDeep || isRecording} className={`no-drag px-5 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 ${interviewMode ? 'bg-emerald-600 text-white animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.4)]' : 'bg-white/10 hover:bg-white/20 text-white/90'}`}><div className={`w-2 h-2 rounded-full ${interviewMode ? 'bg-white' : 'bg-emerald-500'}`} />{interviewMode ? 'Stop Interview' : 'Interview'}</button>
                        <button onClick={() => setShowSettings(!showSettings)} className="no-drag text-white/40 hover:text-white/100 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l-.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg></button>
                        <button onClick={() => { setShowSettings(false); setIsCollapsed(true) }} className="no-drag text-white/40 hover:text-white/100 transition-colors text-xs">Hide</button>
                    </div>

                    {showSettings && (
                        <div
                            className="glass no-drag mt-4 rounded-2xl w-full animate-in fade-in zoom-in-95 duration-200 shadow-2xl overflow-hidden flex flex-col border border-white/10"
                            style={{ maxWidth: 'min(100%, 360px)' }}
                        >
                            {/* macOS Style Title Bar for Settings */}
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
                                    <div className="space-y-2">
                                        <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Gemini API Key</label>
                                        <div className="flex gap-2">
                                            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste API key..." ref={apiKeyInputRef} className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50" />
                                            <button type="submit" className="no-drag bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 px-3 py-2 rounded-xl text-xs font-bold transition-colors">Save</button>
                                        </div>
                                    </div>
                                <div className="space-y-2">
                                    <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Gemini Model</label>
                                    <input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder={DEFAULT_MODEL} className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white w-full outline-none focus:border-blue-500/50" />
                                    <div className="flex flex-wrap gap-1">
                                        {['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'].map((m) => (
                                            <button key={m} type="button" onClick={() => setModelName(m)} className="text-[9px] bg-white/5 hover:bg-white/10 text-white/50 hover:text-white px-2 py-1 rounded-full transition-colors">{m}</button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="block text-[10px] text-white/50 uppercase font-black tracking-widest">Interview Context</label>
                                    <textarea
                                        value={interviewContext}
                                        onChange={(e) => setInterviewContext(e.target.value)}
                                        placeholder="Paste job description or resume here..."
                                        rows={3}
                                        className="no-drag bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white w-full outline-none focus:border-blue-500/50 resize-none"
                                    />
                                    <p className="text-[9px] text-white/30 italic">Context helps AI tailor answers to your specific interview.</p>
                                </div>
                                <button type="button" onClick={listModels} disabled={listingModels} className="no-drag w-full bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white/70 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider">{listingModels ? 'Listing...' : 'List Available Models'}</button>
                                <p className="text-[10px] text-white/20 italic text-center">API key and context are saved locally.</p>
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
