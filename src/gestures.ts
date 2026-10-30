/** Quietglass-compatible Even G2 gesture decoding. */
export const EVENT_CLICK = 0
export const EVENT_SCROLL_TOP = 1
export const EVENT_SCROLL_BOTTOM = 2
export const EVENT_DOUBLE_CLICK = 3
export const EVENT_LONG_PRESS = 9
export const EVENT_LONG_PRESS_RELEASE = 10
export type Gesture = 'click' | 'doubleClick' | 'scrollUp' | 'scrollDown' | 'longPress' | 'longPressRelease'
const lastGestureAt = new Map<Gesture, number>()
const debounceMs: Record<Gesture, number> = { click: 250, doubleClick: 500, scrollUp: 300, scrollDown: 300, longPress: 600, longPressRelease: 250 }
export function gestureFromEvent(event: unknown, invertScroll = false): Gesture | null {
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  const payloads = ['textEvent', 'listEvent', 'sysEvent'].map((key) => record[key]).filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
  if (payloads.length === 0) return null
  const payload = payloads.find((item) => readNumber(item, 'eventType', 'event_type', 'type') !== undefined) ?? payloads[0]
  const code = readNumber(payload, 'eventType', 'event_type', 'type') ?? EVENT_CLICK
  let gesture: Gesture | null
  switch (code) {
    case EVENT_CLICK: gesture = 'click'; break
    case EVENT_DOUBLE_CLICK: gesture = 'doubleClick'; break
    case EVENT_LONG_PRESS: gesture = 'longPress'; break
    case EVENT_LONG_PRESS_RELEASE: gesture = 'longPressRelease'; break
    case EVENT_SCROLL_TOP: gesture = invertScroll ? 'scrollDown' : 'scrollUp'; break
    case EVENT_SCROLL_BOTTOM: gesture = invertScroll ? 'scrollUp' : 'scrollDown'; break
    default: gesture = null
  }
  if (!gesture) return null
  const now = Date.now()
  const previous = lastGestureAt.get(gesture)
  if (previous !== undefined && now - previous < debounceMs[gesture]) return null
  lastGestureAt.set(gesture, now)
  return gesture
}
function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}
