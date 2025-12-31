import AssistantWidget from './components/AssistantWidget'

function App() {
    return (
        <div className="w-full h-full flex flex-col items-center justify-end p-4 pointer-events-none" aria-hidden="true">
            <div className="pointer-events-auto">
                <AssistantWidget />
            </div>
        </div>
    )
}

export default App
