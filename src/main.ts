import './style.css'
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EvenAppBridge,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Required app element ${selector} was not found.`)
  return element
}

const root = requireElement<HTMLDivElement>('#app')
root.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Dot assistant home">
        <span class="brand-mark" aria-hidden="true">D</span>
        <span>dot<span class="brand-muted"> / personal assistant</span></span>
      </a>
      <span class="connection-pill"><span class="pulse"></span> n8n + NAS Vosk</span>
    </header>
    <section class="intro">
      <p class="eyebrow">EVEN G2 · VOICE ASSISTANT</p>
      <h1>Ask Dot,<br /><span>hands free.</span></h1>
      <p class="intro-copy">Preview the app on your PC, or open it inside Even Realities to use the glasses microphone. Say Hey Dot, ask a question, and n8n will send its audio to Vosk for transcription.</p>
    </section>
    <section class="voice-card" aria-labelledby="voice-title">
      <div class="section-heading">
        <div><p class="eyebrow">VOICE INPUT</p><h2 id="voice-title">Record a question</h2></div>
        <span id="voice-indicator" class="voice-indicator" data-state="off">MIC OFF</span>
      </div>
      <p id="voice-copy" class="voice-copy">After Hey Dot is detected, ask your question. The app records it and uploads the audio to the Dot Webhook; n8n sends it to NAS Vosk for transcription, then runs the AI Agent.</p>
      <div class="voice-controls">
        <button id="start-wake-button" class="button button-primary" type="button" disabled>Start Hey Dot</button>
        <button id="stop-wake-button" class="button button-secondary" type="button" disabled>Stop listening</button>
      </div>
      <details class="manual-audio-controls">
        <summary>Manual audio-upload fallback</summary>
        <div class="voice-controls"><button id="start-mic-button" class="button button-secondary" type="button" disabled>Start recording</button><button id="stop-mic-button" class="button button-secondary" type="button" disabled>Stop and send</button></div>
      </details>
      <p id="voice-status" class="voice-status" role="status" aria-live="polite">Open Dot in the Even app to connect the glasses microphone.</p>
      <p id="voice-transcript" class="voice-transcript" aria-live="polite">No question sent yet.</p>
      <p id="voice-metrics" class="voice-metrics">No audio recorded.</p>
    </section>
    <section class="reply-card" aria-labelledby="reply-title">
      <div class="reply-heading">
        <div><p class="eyebrow">DOT'S REPLY</p><h2 id="reply-title">Answer</h2></div>
        <span id="glass-status" class="glass-status">Glasses bridge not connected</span>
      </div>
      <div id="reply" class="reply-body" aria-live="polite">Record and send a voice question to Dot.</div>
    </section>
    <section class="glasses-preview-card" aria-labelledby="glasses-preview-title">
      <div class="reply-heading">
        <div><p class="eyebrow">SIMULATED LENS</p><h2 id="glasses-preview-title">What appears on the G2</h2></div>
        <span class="glass-status">576 × 288</span>
      </div>
      <div id="lens-frame" class="lens-frame" aria-label="Preview of the Even G2 display">
        <div class="lens-copy"><span class="lens-brand">DOT</span><p id="glasses-preview-content">Tap Start recording in the app to ask a question.</p><div class="lens-footer"><span id="lens-page-indicator" class="lens-page-indicator">Ready</span><span id="lens-thinking-dots" class="lens-thinking-dots" aria-hidden="true" hidden><i></i><i></i><i></i></span></div></div>
      </div>
      <div class="lens-controls"><button id="previous-page-button" class="button button-secondary" type="button" disabled>Previous page</button><button id="next-page-button" class="button button-secondary" type="button" disabled>Next page</button></div>
      <p class="voice-help">Tap the glasses text to advance, long press to go back, double tap to close. The desktop preview has Previous page and Next page buttons.</p>
    </section>
    <footer class="footer"><span>Built for Even G2</span><span>Wake-word audio streams to NAS Vosk. Question audio goes through the Dot Webhook and Transcribe with NAS Vosk workflow.</span></footer>
  </main>
`

const replyElement = requireElement<HTMLDivElement>('#reply')
const glassStatusElement = requireElement<HTMLSpanElement>('#glass-status')
const startWakeButton = requireElement<HTMLButtonElement>('#start-wake-button')
const stopWakeButton = requireElement<HTMLButtonElement>('#stop-wake-button')
const startMicButton = requireElement<HTMLButtonElement>('#start-mic-button')
const stopMicButton = requireElement<HTMLButtonElement>('#stop-mic-button')
const voiceIndicator = requireElement<HTMLSpanElement>('#voice-indicator')
const voiceStatusElement = requireElement<HTMLParagraphElement>('#voice-status')
const voiceTranscriptElement = requireElement<HTMLParagraphElement>('#voice-transcript')
const voiceMetricsElement = requireElement<HTMLParagraphElement>('#voice-metrics')
const previewElement = requireElement<HTMLParagraphElement>('#glasses-preview-content')
const lensFrameElement = requireElement<HTMLDivElement>('#lens-frame')
const lensThinkingDotsElement = requireElement<HTMLSpanElement>('#lens-thinking-dots')
const pageIndicatorElement = requireElement<HTMLSpanElement>('#lens-page-indicator')
const previousPageButton = requireElement<HTMLButtonElement>('#previous-page-button')
const nextPageButton = requireElement<HTMLButtonElement>('#next-page-button')

const VOSK_STREAM_URL = import.meta.env.VITE_VOSK_STREAM_URL?.trim() ?? ''
const VOSK_STREAM_TOKEN = import.meta.env.VITE_VOSK_STREAM_TOKEN?.trim() ?? ''
const SESSION_ID = localStorage.getItem('dot-session-id') ?? crypto.randomUUID()
localStorage.setItem('dot-session-id', SESSION_ID)
const GLASSES_CONTAINER_ID = 1
const GLASSES_CONTAINER_NAME = 'dot-reply'
const AUDIO_SAMPLE_RATE = 16_000
const WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL?.trim() ?? ''
const MAX_RECORDING_SECONDS = 30
const MAX_RECORDING_BYTES = AUDIO_SAMPLE_RATE * 2 * MAX_RECORDING_SECONDS
const MAX_GLASS_PAGE_CHARS = 240
const CONVERSATION_WINDOW_MS = 20_000
const START_PROMPT = 'Tap Start recording in the app to ask a question.'

let bridge: EvenAppBridge | null = null
let latestReply = ''
let microphoneActive = false
let microphoneBusy = false
let microphoneMode: 'glasses' | 'browser' | null = null
let recordedChunks: Uint8Array[] = []
let recordedBytes = 0
let wakeSocket: WebSocket | null = null
let wakeMode: 'connecting' | 'wake' | 'question' | 'waiting_reply' | 'conversation' | 'followup' | null = null
let wakeStreamReady = false
let wakeReadyTimer: number | null = null
let wakeHeartbeatTimer: number | null = null
let conversationTimer: number | null = null
let conversationCountdownTimer: number | null = null
let conversationEndsAt = 0
let browserStream: MediaStream | null = null
let browserContext: AudioContext | null = null
let browserProcessor: ScriptProcessorNode | null = null
let browserSource: MediaStreamAudioSourceNode | null = null
let browserMute: GainNode | null = null
let questionStartedAt = 0
let lastSpeechAt = 0
let questionSpeechStarted = false
let replyPages = [START_PROMPT]
let currentReplyPage = 0

function isLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
}

function paginateReply(message: string): string[] {
  const remainingText = message.trim()
  if (!remainingText) return ['No reply text was returned.']
  const pages: string[] = []
  let remaining = remainingText
  while (remaining.length > MAX_GLASS_PAGE_CHARS) {
    let splitAt = remaining.lastIndexOf('\n', MAX_GLASS_PAGE_CHARS)
    if (splitAt < MAX_GLASS_PAGE_CHARS * 0.55) splitAt = remaining.lastIndexOf(' ', MAX_GLASS_PAGE_CHARS)
    if (splitAt <= 0) splitAt = MAX_GLASS_PAGE_CHARS
    pages.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) pages.push(remaining)
  return pages
}

function updatePageControls(): void {
  const pageCount = replyPages.length
  const pageSuffix = latestReply ? ` | PAGE ${currentReplyPage + 1}/${pageCount}` : ''
  if (pageIndicatorElement.dataset.state !== 'processing') {
    if (wakeSocket && wakeMode === 'wake') {
      pageIndicatorElement.textContent = `LISTENING FOR HEY DOT${pageSuffix}`
    } else if (wakeSocket && wakeMode === 'question') {
      pageIndicatorElement.textContent = `LISTENING FOR QUESTION${pageSuffix}`
    } else if (wakeSocket && wakeMode === 'followup') {
      pageIndicatorElement.textContent = `LISTENING FOR FOLLOW-UP${pageSuffix}`
    } else if (wakeSocket && wakeMode === 'conversation') {
      const secondsRemaining = Math.max(0, Math.ceil((conversationEndsAt - Date.now()) / 1000))
      pageIndicatorElement.textContent = `FOLLOW-UP OPEN (${secondsRemaining}S)${pageSuffix}`
    } else if (wakeSocket && wakeMode === 'waiting_reply') {
      pageIndicatorElement.textContent = `PROCESSING${pageSuffix}`
    } else if (wakeSocket && wakeMode === 'connecting') {
      pageIndicatorElement.textContent = `CONNECTING${pageSuffix}`
    } else {
      pageIndicatorElement.textContent = latestReply ? `PAGE ${currentReplyPage + 1}/${pageCount}` : 'READY'
    }
  }
  previousPageButton.disabled = currentReplyPage === 0
  nextPageButton.disabled = currentReplyPage >= pageCount - 1
}

function setReply(message: string) {
  latestReply = message
  replyPages = paginateReply(message)
  currentReplyPage = 0
  replyElement.textContent = message
  updatePageControls()
  void updateGlasses(replyPages[0])
}

function setLensThinking(isThinking: boolean): void {
  lensFrameElement.classList.toggle('is-thinking', isThinking)
  lensThinkingDotsElement.hidden = !isThinking
  if (isThinking) {
    pageIndicatorElement.hidden = false
    pageIndicatorElement.textContent = 'PROCESSING'
    pageIndicatorElement.dataset.state = 'processing'
    return
  }

  pageIndicatorElement.hidden = false
  delete pageIndicatorElement.dataset.state
  updatePageControls()
}

function changeReplyPage(direction: -1 | 1): void {
  const nextPage = currentReplyPage + direction
  if (nextPage < 0 || nextPage >= replyPages.length) return
  currentReplyPage = nextPage
  updatePageControls()
  void updateGlasses(replyPages[currentReplyPage])
}

function updateMicrophoneUi(): void {
  if (!microphoneActive) {
    voiceIndicator.textContent = 'MIC OFF'
    voiceIndicator.dataset.state = 'off'
  } else if (wakeSocket && wakeMode === 'question') {
    voiceIndicator.textContent = 'HEY DOT HEARD'
    voiceIndicator.dataset.state = 'heard'
  } else if (wakeSocket && wakeMode === 'followup') {
    voiceIndicator.textContent = 'FOLLOW-UP HEARD'
    voiceIndicator.dataset.state = 'heard'
  } else if (wakeSocket && wakeMode === 'conversation') {
    voiceIndicator.textContent = 'CHAT OPEN'
    voiceIndicator.dataset.state = 'on'
  } else if (wakeSocket && wakeMode === 'waiting_reply') {
    voiceIndicator.textContent = 'THINKING'
    voiceIndicator.dataset.state = 'thinking'
  } else if (wakeSocket && wakeMode === 'connecting') {
    voiceIndicator.textContent = 'CONNECTING'
    voiceIndicator.dataset.state = 'connecting'
  } else if (wakeSocket && wakeMode === 'wake') {
    voiceIndicator.textContent = 'LISTENING FOR HEY DOT'
    voiceIndicator.dataset.state = 'on'
  } else {
    voiceIndicator.textContent = microphoneMode === 'browser' ? 'PC MIC ON' : 'G2 MIC ON'
    voiceIndicator.dataset.state = 'on'
  }
  const canCapture = bridge !== null || isLocalhost()
  startWakeButton.disabled = !canCapture || !VOSK_STREAM_URL || !VOSK_STREAM_TOKEN || microphoneActive || microphoneBusy
  stopWakeButton.disabled = !wakeSocket || microphoneBusy
  startMicButton.disabled = !canCapture || microphoneActive || microphoneBusy
  stopMicButton.disabled = !microphoneActive || microphoneBusy || wakeSocket !== null
  startMicButton.textContent = bridge ? 'Start G2 recording' : 'Start PC mic preview'
  updatePageControls()
}

function makeWav(pcmChunks: Uint8Array[]): Blob {
  const dataLength = pcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const wav = new ArrayBuffer(44 + dataLength)
  const view = new DataView(wav)
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, AUDIO_SAMPLE_RATE, true)
  view.setUint32(28, AUDIO_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataLength, true)
  const output = new Uint8Array(wav, 44)
  let offset = 0
  for (const chunk of pcmChunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Blob([wav], { type: 'audio/wav' })
}

async function sendRecording(chunks: Uint8Array[], source: 'even-g2' | 'localhost-preview'): Promise<void> {
  if (!WEBHOOK_URL) {
    throw new Error('Set VITE_N8N_WEBHOOK_URL in .env.local before sending audio.')
  }
  const wav = makeWav(chunks)
  if (wav.size <= 44) throw new Error('No audio was received from the microphone.')
  const form = new FormData()
  form.append('audio', wav, 'dot-question.wav')
  form.append('sessionId', SESSION_ID)
  form.append('source', source)
  form.append('timestamp', new Date().toISOString())
  setLensThinking(true)
  voiceStatusElement.textContent = 'Uploading audio to n8n for transcription...'
  try {
    const response = await fetch(WEBHOOK_URL, { method: 'POST', body: form })
    if (!response.ok) throw new Error(`The n8n webhook returned HTTP ${response.status}.`)
    const payload = await response.json() as { reply?: unknown; transcript?: unknown }
    const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : ''
    voiceTranscriptElement.textContent = transcript
      ? `Heard: ${transcript}`
      : 'Transcription finished, but the workflow did not return the transcript.'
    const reply = typeof payload.reply === 'string' ? payload.reply.trim() : ''
    if (!reply) throw new Error('The workflow returned no reply. Check that it transcribes the uploaded audio.')
    setReply(reply)
    voiceStatusElement.textContent = 'Dot replied through the n8n workflow.'
  } finally {
    setLensThinking(false)
  }
}
function handleAudioFrame(audioPcm: Uint8Array): void {
  if (!microphoneActive || (microphoneMode !== 'glasses' && microphoneMode !== 'browser')) return
  if (wakeSocket) {
    if (wakeMode === 'question' || wakeMode === 'conversation' || wakeMode === 'followup') {
      captureQuestionFrame(audioPcm)
      return
    }
    if (!wakeStreamReady || wakeMode !== 'wake') return
    if (wakeSocket.readyState === WebSocket.OPEN) {
      const pcmBuffer = new ArrayBuffer(audioPcm.byteLength)
      new Uint8Array(pcmBuffer).set(audioPcm)
      wakeSocket.send(pcmBuffer)
      recordedBytes += audioPcm.byteLength
      voiceMetricsElement.textContent = `${(recordedBytes / 32_000).toFixed(1)} seconds streamed · 16 kHz PCM`
    }
    return
  }
  const remaining = MAX_RECORDING_BYTES - recordedBytes
  if (remaining <= 0) {
    voiceStatusElement.textContent = '30-second recording limit reached. Tap Stop and send.'
    return
  }
  const chunk = audioPcm.slice(0, remaining)
  recordedChunks.push(chunk)
  recordedBytes += chunk.byteLength
  voiceMetricsElement.textContent = `${(recordedBytes / 32_000).toFixed(1)} seconds captured · ${(recordedBytes / 1024).toFixed(0)} KB · 16 kHz PCM`
  if (recordedBytes >= MAX_RECORDING_BYTES) voiceStatusElement.textContent = '30-second recording limit reached. Tap Stop and send.'
}

function captureQuestionFrame(audioPcm: Uint8Array): void {
  const chunk = audioPcm.slice()
  const samples = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const sampleCount = Math.floor(chunk.byteLength / 2)
  let energy = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const value = samples.getInt16(index * 2, true) / 32768
    energy += value * value
  }

  const now = Date.now()
  const rms = sampleCount ? Math.sqrt(energy / sampleCount) : 0

  // During the conversation window, discard silence and wait for the next utterance.
  if (wakeMode === 'conversation') {
    if (rms < 0.018) return
    wakeMode = 'followup'
    recordedChunks = []
    recordedBytes = 0
    questionStartedAt = now
    lastSpeechAt = 0
    questionSpeechStarted = false
    clearConversationTimers()
    updateMicrophoneUi()
    voiceStatusElement.textContent = 'Follow-up heard. Ask your question; I will send it after a short pause.'
    voiceTranscriptElement.textContent = 'Listening for your follow-up...'
  }

  recordedChunks.push(chunk)
  recordedBytes += chunk.byteLength
  if (rms >= 0.018) {
    questionSpeechStarted = true
    lastSpeechAt = now
  }
  voiceMetricsElement.textContent = `${((now - questionStartedAt) / 1000).toFixed(1)} seconds captured · 16 kHz PCM`

  if (recordedBytes >= MAX_RECORDING_BYTES) {
    void finishWakeQuestion('Question reached the 30-second limit; sending it now.')
  } else if (questionSpeechStarted && now - lastSpeechAt >= 1_200) {
    void finishWakeQuestion('Question finished; sending audio to n8n for transcription…')
  } else if (!questionSpeechStarted && now - questionStartedAt >= 20_000) {
    void finishWakeQuestion('No question detected. Say “Hey Dot” to try again.', false)
  }
}

function handleWakeStreamMessage(event: MessageEvent<string>): void {
  let payload: { type?: string; mode?: string; phrase?: string; text?: string; message?: string }
  try {
    payload = JSON.parse(event.data) as typeof payload
  } catch {
    voiceStatusElement.textContent = 'The NAS wake-word bridge returned an invalid message.'
    return
  }

  if (payload.type === 'ready') {
    if (wakeReadyTimer !== null) window.clearTimeout(wakeReadyTimer)
    wakeReadyTimer = null
    wakeStreamReady = true
    wakeMode = 'wake'
    updateMicrophoneUi()
    voiceStatusElement.textContent = 'Listening for “Hey Dot”.'
    if (!latestReply) void updateGlasses('Listening for “Hey Dot”.')
    return
  }
  if (payload.type === 'wake_detected') {
    clearConversationTimers()
    wakeMode = 'question'
    recordedChunks = []
    recordedBytes = 0
    questionStartedAt = Date.now()
    lastSpeechAt = 0
    questionSpeechStarted = false
    updateMicrophoneUi()
    voiceStatusElement.textContent = 'Wake word heard. Ask your question now; I’ll send it after a short pause.'
    voiceTranscriptElement.textContent = 'Listening for your question…'
    void updateGlasses('Hey Dot heard. Ask your question.')
    return
  }
  if (payload.type === 'error') {
    if (wakeReadyTimer !== null) window.clearTimeout(wakeReadyTimer)
    wakeReadyTimer = null
    wakeStreamReady = false
    voiceIndicator.textContent = 'STREAM ERROR'
    voiceIndicator.dataset.state = 'error'
    voiceStatusElement.textContent = payload.message || 'The NAS wake-word bridge reported an error.'
  }
}

async function finishWakeQuestion(status: string, submit = true): Promise<void> {
  if (wakeMode !== 'question' && wakeMode !== 'followup') return
  wakeMode = 'waiting_reply'
  updateMicrophoneUi()
  const chunks = recordedChunks
  const capturedBytes = recordedBytes
  recordedChunks = []
  recordedBytes = 0
  let keepConversationOpen = false
  try {
    if (!submit) {
      voiceStatusElement.textContent = status
      return
    }
    if (!questionSpeechStarted || capturedBytes < 3_200) {
      voiceStatusElement.textContent = 'I did not hear a question. Say Hey Dot to try again.'
      return
    }
    keepConversationOpen = true
    voiceStatusElement.textContent = status
    await sendRecording(chunks, microphoneMode === 'browser' ? 'localhost-preview' : 'even-g2')
    voiceStatusElement.textContent = 'Dot replied. You can ask a follow-up for 20 seconds.'
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown n8n error.'
    voiceStatusElement.textContent = `Could not get Dot's reply: ${detail}`
  } finally {
    if (keepConversationOpen) openConversationWindow()
    else if (microphoneActive) resumeWakeListening('Listening for Hey Dot.')
  }
}

function openConversationWindow(): void {
  if (!microphoneActive || !wakeSocket) return
  clearConversationTimers()
  recordedChunks = []
  recordedBytes = 0
  questionSpeechStarted = false
  lastSpeechAt = 0
  wakeStreamReady = false
  wakeMode = 'conversation'
  conversationEndsAt = Date.now() + CONVERSATION_WINDOW_MS
  updateMicrophoneUi()
  voiceStatusElement.textContent = 'Chat is open for 20 seconds. Ask another question without saying Hey Dot.'
  voiceMetricsElement.textContent = 'Follow-up window: 20 seconds'
  conversationCountdownTimer = window.setInterval(() => {
    if (wakeMode === 'conversation') updatePageControls()
  }, 1_000)
  conversationTimer = window.setTimeout(() => {
    conversationTimer = null
    if (wakeMode === 'conversation') resumeWakeListening('Follow-up window ended. Listening for Hey Dot.')
  }, CONVERSATION_WINDOW_MS)
}

function clearConversationTimers(): void {
  if (conversationTimer !== null) window.clearTimeout(conversationTimer)
  conversationTimer = null
  if (conversationCountdownTimer !== null) window.clearInterval(conversationCountdownTimer)
  conversationCountdownTimer = null
  conversationEndsAt = 0
}

function resumeWakeListening(status: string): void {
  clearConversationTimers()
  const socket = wakeSocket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (microphoneActive) voiceStatusElement.textContent = 'The wake connection closed. Restart Hey Dot listening.'
    return
  }
  wakeStreamReady = false
  wakeMode = 'connecting'
  updateMicrophoneUi()
  voiceStatusElement.textContent = status
  if (wakeReadyTimer !== null) window.clearTimeout(wakeReadyTimer)
  wakeReadyTimer = window.setTimeout(() => {
    if (wakeSocket !== socket || wakeStreamReady) return
    voiceIndicator.textContent = 'STREAM ERROR'
    voiceIndicator.dataset.state = 'error'
    voiceStatusElement.textContent = 'The NAS bridge did not resume wake-word listening.'
    socket.close(4000, 'Wake listener resume timeout')
  }, 10_000)
  socket.send(JSON.stringify({ type: 'resume' }))
}
async function startWakeListening(): Promise<void> {
  if ((!bridge && !isLocalhost()) || microphoneBusy || microphoneActive) return
  if (!VOSK_STREAM_URL || !VOSK_STREAM_TOKEN || !WEBHOOK_URL) {
    voiceStatusElement.textContent = 'Set the Vosk WebSocket URL, stream token, and Dot Webhook URL in .env.local.'
    return
  }

  microphoneBusy = true
  updateMicrophoneUi()
  recordedBytes = 0
  voiceMetricsElement.textContent = 'Connecting to the NAS wake-word service…'
  try {
    if (bridge) {
      const started = await bridge.audioControl(true, AudioInputSource.Glasses)
      if (!started) throw new Error('The Even app could not start the glasses microphone.')
      microphoneMode = 'glasses'
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      browserStream = stream
      const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
      browserContext = context
      await context.resume()
      browserSource = context.createMediaStreamSource(stream)
      browserProcessor = context.createScriptProcessor(4096, 1, 1)
      browserMute = context.createGain()
      browserMute.gain.value = 0
      browserProcessor.onaudioprocess = (audioEvent) => {
        const samples = audioEvent.inputBuffer.getChannelData(0)
        const pcm = new Uint8Array(samples.length * 2)
        const view = new DataView(pcm.buffer)
        for (let index = 0; index < samples.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, samples[index]))
          view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        }
        handleAudioFrame(pcm)
      }
      browserSource.connect(browserProcessor)
      browserProcessor.connect(browserMute)
      browserMute.connect(context.destination)
      microphoneMode = 'browser'
    }

    microphoneActive = true
    wakeStreamReady = false
    wakeMode = 'connecting'
    const socket = new WebSocket(VOSK_STREAM_URL)
    wakeSocket = socket
    let connectionFailure = ''
    wakeReadyTimer = window.setTimeout(() => {
      if (wakeSocket !== socket || wakeStreamReady) return
      connectionFailure = 'The WebSocket opened but the NAS bridge did not become ready within 10 seconds.'
      socket.close(4000, 'Bridge ready timeout')
    }, 10_000)
    socket.onopen = () => {
      voiceStatusElement.textContent = 'WebSocket connected. Authenticating with the NAS bridge…'
      socket.send(JSON.stringify({ token: VOSK_STREAM_TOKEN }))
    }
    socket.onmessage = (event) => {
      handleWakeStreamMessage(event)
    }
    socket.onerror = () => {
      connectionFailure = 'Could not connect to the NAS Vosk WebSocket. Check its WSS proxy and URL.'
      voiceIndicator.textContent = 'STREAM ERROR'
      voiceIndicator.dataset.state = 'error'
      voiceStatusElement.textContent = connectionFailure
    }
    socket.onclose = (event) => {
      if (wakeReadyTimer !== null) window.clearTimeout(wakeReadyTimer)
      wakeReadyTimer = null
      if (wakeHeartbeatTimer !== null) window.clearInterval(wakeHeartbeatTimer)
      wakeHeartbeatTimer = null
      if (wakeSocket !== socket) return
      const reason = event.code === 4401
        ? 'The NAS bridge rejected the stream token. Check VOSK_STREAM_TOKEN in both .env files.'
        : connectionFailure || `Wake-word connection closed before ready (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`
      void stopWakeListening(reason)
    }
    wakeHeartbeatTimer = window.setInterval(() => {
      if (wakeSocket === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }))
      }
    }, 20_000)
    voiceTranscriptElement.textContent = 'Waiting for “Hey Dot”…'
    voiceStatusElement.textContent = microphoneMode === 'browser'
      ? 'PC microphone on. Connecting to wake-word detection…'
      : 'G2 microphone on. Connecting to wake-word detection…'
  } catch (error) {
    if (microphoneMode === 'glasses') await bridge?.audioControl(false)
    browserStream?.getTracks().forEach((track) => track.stop())
    if (browserContext && browserContext.state !== 'closed') await browserContext.close()
    browserStream = null
    browserContext = null
    browserSource = null
    browserProcessor = null
    browserMute = null
    microphoneActive = false
    microphoneMode = null
    const detail = error instanceof Error ? error.message : 'Unknown wake-word setup error.'
    voiceStatusElement.textContent = `Could not start wake-word listening: ${detail}`
  } finally {
    microphoneBusy = false
    updateMicrophoneUi()
  }
}

async function stopWakeListening(status = 'Wake-word listening stopped.'): Promise<void> {
  const socket = wakeSocket
  wakeSocket = null
  if (wakeReadyTimer !== null) window.clearTimeout(wakeReadyTimer)
  wakeReadyTimer = null
  if (wakeHeartbeatTimer !== null) window.clearInterval(wakeHeartbeatTimer)
  wakeHeartbeatTimer = null
  clearConversationTimers()
  wakeStreamReady = false
  wakeMode = null
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close()

  if (microphoneMode === 'glasses') {
    await bridge?.audioControl(false)
  } else if (microphoneMode === 'browser') {
    if (browserProcessor) browserProcessor.onaudioprocess = null
    browserProcessor?.disconnect()
    browserSource?.disconnect()
    browserMute?.disconnect()
    browserStream?.getTracks().forEach((track) => track.stop())
    if (browserContext && browserContext.state !== 'closed') await browserContext.close()
  }
  browserProcessor = null
  browserSource = null
  browserMute = null
  browserStream = null
  browserContext = null
  microphoneActive = false
  microphoneMode = null
  voiceStatusElement.textContent = status
  updateMicrophoneUi()
}

async function startRecording(): Promise<void> {
  if ((!bridge && !isLocalhost()) || microphoneBusy || microphoneActive) return
  microphoneBusy = true
  updateMicrophoneUi()
  recordedChunks = []
  recordedBytes = 0
  voiceMetricsElement.textContent = 'Waiting for glasses audio…'
  try {
    if (bridge) {
      const started = await bridge.audioControl(true, AudioInputSource.Glasses)
      if (!started) throw new Error('The Even app could not start the glasses microphone.')
      microphoneMode = 'glasses'
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      browserStream = stream
      const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
      browserContext = context
      await context.resume()
      browserSource = context.createMediaStreamSource(stream)
      browserProcessor = context.createScriptProcessor(4096, 1, 1)
      browserMute = context.createGain()
      browserMute.gain.value = 0
      browserProcessor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0)
        const pcm = new Uint8Array(samples.length * 2)
        const view = new DataView(pcm.buffer)
        for (let index = 0; index < samples.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, samples[index]))
          view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        }
        handleAudioFrame(pcm)
      }
      browserSource.connect(browserProcessor)
      browserProcessor.connect(browserMute)
      browserMute.connect(context.destination)
      microphoneMode = 'browser'
    }
    microphoneActive = true
    voiceStatusElement.textContent = microphoneMode === 'browser'
      ? 'Recording from the PC microphone. Speak, then tap Stop and send.'
      : 'Recording from the G2. Speak, then tap Stop and send.'
  } catch (error) {
    browserStream?.getTracks().forEach((track) => track.stop())
    if (browserContext && browserContext.state !== 'closed') void browserContext.close()
    browserStream = null
    browserContext = null
    browserSource = null
    browserProcessor = null
    browserMute = null
    const detail = error instanceof Error ? error.message : 'Unknown microphone error.'
    voiceStatusElement.textContent = `Could not start recording: ${detail}`
  } finally {
    microphoneBusy = false
    updateMicrophoneUi()
  }
}

async function stopRecording(submit = true): Promise<void> {
  if (!microphoneActive || microphoneBusy) return
  microphoneBusy = true
  updateMicrophoneUi()
  let chunks: Uint8Array[] = []
  const source = microphoneMode === 'browser' ? 'localhost-preview' : 'even-g2'
  try {
    if (microphoneMode === 'glasses') {
      const stopped = await bridge?.audioControl(false)
      if (!stopped) throw new Error('The Even app did not confirm that the microphone stopped.')
    } else {
      if (browserProcessor) browserProcessor.onaudioprocess = null
      browserProcessor?.disconnect()
      browserSource?.disconnect()
      browserMute?.disconnect()
      browserStream?.getTracks().forEach((track) => track.stop())
      if (browserContext && browserContext.state !== 'closed') await browserContext.close()
      browserProcessor = null
      browserSource = null
      browserMute = null
      browserStream = null
      browserContext = null
    }
    microphoneActive = false
    microphoneMode = null
    chunks = recordedChunks
    recordedChunks = []
    recordedBytes = 0
    if (submit) {
      voiceTranscriptElement.textContent = 'Transcribing…'
      await sendRecording(chunks, source)
    } else {
      recordedChunks = []
      recordedBytes = 0
      voiceStatusElement.textContent = 'Recording discarded.'
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown microphone or upload error.'
    voiceStatusElement.textContent = `Could not send recording: ${detail}`
    if (submit && chunks.length) recordedChunks = chunks
  } finally {
    microphoneBusy = false
    updateMicrophoneUi()
  }
}

startWakeButton.addEventListener('click', () => void startWakeListening())
stopWakeButton.addEventListener('click', () => void stopWakeListening())
startMicButton.addEventListener('click', () => void startRecording())
stopMicButton.addEventListener('click', () => void stopRecording())
previousPageButton.addEventListener('click', () => changeReplyPage(-1))
nextPageButton.addEventListener('click', () => changeReplyPage(1))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (wakeSocket) void stopWakeListening('App went to the background; wake-word listening stopped.')
    else void stopRecording(false)
  }
})
window.addEventListener('pagehide', () => {
  if (wakeSocket) void stopWakeListening('App closed; wake-word listening stopped.')
  else void stopRecording(false)
})

async function updateGlasses(content: string): Promise<void> {
  previewElement.textContent = content
  if (!bridge) return
  try {
    const updated = await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: GLASSES_CONTAINER_ID,
      containerName: GLASSES_CONTAINER_NAME,
      content: `DOT\n\n${content}${replyPages.length > 1 ? `\n\n${currentReplyPage + 1}/${replyPages.length} · tap next · hold prev` : ''}`,
    }))
    if (!updated) glassStatusElement.textContent = 'Glasses did not accept the reply'
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown bridge error.'
    glassStatusElement.textContent = `Glasses update failed: ${detail}`
  }
}

async function connectGlasses(): Promise<void> {
  if (!('flutter_inappwebview' in window)) {
    glassStatusElement.textContent = 'Open this app in Even Realities to connect glasses'
    voiceStatusElement.textContent = isLocalhost()
      ? 'Local preview ready. Use the PC microphone to test the recording and webhook flow.'
      : 'Open this app in the Even app to use the G2 microphone.'
    previewElement.textContent = 'Tap Start recording in the app to ask a question.'
    updateMicrophoneUi()
    return
  }
  try {
    bridge = await waitForEvenAppBridge()
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        paddingLength: 8,
        containerID: GLASSES_CONTAINER_ID,
        containerName: GLASSES_CONTAINER_NAME,
        content: `DOT\n\n${START_PROMPT}`,
        isEventCapture: 1,
      })],
    }))
    if (result !== 0) throw new Error(`The glasses page could not be created (result ${result}).`)
    bridge.onEvenHubEvent((event) => {
      if (event.audioEvent) handleAudioFrame(event.audioEvent.audioPcm)
      const textEvent = event.textEvent
      if (!textEvent || textEvent.containerID !== GLASSES_CONTAINER_ID) return
      if (textEvent.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        void bridge?.shutDownPageContainer(1)
      } else if (textEvent.eventType === OsEventTypeList.CLICK_EVENT || textEvent.eventType === undefined) {
        changeReplyPage(1)
      } else if (textEvent.eventType === OsEventTypeList.LONG_PRESS_EVENT) {
        changeReplyPage(-1)
      }
    })
    glassStatusElement.textContent = 'Glasses connected'
    voiceStatusElement.textContent = 'Ready. Start “Hey Dot” listening or use the manual upload fallback.'
    updateMicrophoneUi()
    updatePageControls()
    if (latestReply) await updateGlasses(replyPages[currentReplyPage])
    await startWakeListening()
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown bridge error.'
    glassStatusElement.textContent = `Glasses connection failed: ${detail}`
  }
}

void connectGlasses()
