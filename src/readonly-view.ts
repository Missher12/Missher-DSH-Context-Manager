import { useLayoutEffect, useRef } from 'react'

/** The host keeps its composer resident so drafts survive view changes.
 * 0.1.7-rc.2 has no per-view composer option. Hide only this occurrence's
 * documented composer seat while the inspector is mounted, then restore it.
 * No global selectors, draft writes, stylesheet changes or host patches.
 */
export function useReadonlyView(target: string) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const content = ref.current?.closest('[data-conversation-content]')
    if (content?.getAttribute('data-conversation-session') !== target) return
    const seat = content.querySelector<HTMLElement>(':scope > [data-conversation-scroll] > [data-composer-seat]')
    if (!seat) return
    const display = seat.style.getPropertyValue('display')
    const priority = seat.style.getPropertyPriority('display')
    const hidden = seat.getAttribute('hidden')
    const inert = seat.getAttribute('inert')
    seat.style.setProperty('display', 'none', 'important')
    seat.setAttribute('hidden', '')
    seat.setAttribute('inert', '')
    return () => {
      if (seat.style.getPropertyValue('display') === 'none' && seat.style.getPropertyPriority('display') === 'important') {
        if (display) seat.style.setProperty('display', display, priority)
        else seat.style.removeProperty('display')
      }
      for (const [name, value] of [['hidden', hidden], ['inert', inert]] as const) {
        if (seat.getAttribute(name) !== '') continue
        if (value === null) seat.removeAttribute(name)
        else seat.setAttribute(name, value)
      }
    }
  }, [target])
  return ref
}
