import { useEffect, type RefObject } from 'react'

const SCROLLING = new Set(['auto', 'scroll', 'overlay'])

/**
 * The Host settings page scrolls in a pane that does not reserve the scrollbar
 * gutter, so every appearance or disappearance of the vertical scrollbar shifts
 * the whole page sideways. Reserve it on the nearest scrolling ancestor while
 * this subtree is mounted and restore the previous inline value on unmount.
 * Scoped to one page, never a Host stylesheet edit, and skipped when the Host
 * already manages the guttering itself or the view exposes no style resolver.
 */
export function useStableScrollbarGutter(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const origin = ref.current
    const doc = origin?.ownerDocument
    const view = doc?.defaultView
    if (!origin || !doc || !view || typeof view.getComputedStyle !== 'function') return
    const readStyle = (node: HTMLElement) => view.getComputedStyle(node)
    let node: HTMLElement | null = origin.parentElement
    let target: HTMLElement | null = null
    while (node) {
      if (SCROLLING.has(readStyle(node).overflowY)) { target = node; break }
      if (node === doc.body) break
      node = node.parentElement
    }
    if (!target || readStyle(target).scrollbarGutter === 'stable') return
    const previous = target.style.scrollbarGutter
    target.style.scrollbarGutter = 'stable'
    return () => { target!.style.scrollbarGutter = previous }
  }, [ref])
}
