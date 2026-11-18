import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fades an element in by the compositor, without remounting what is inside it. */
export function fadeIn(element: Element | null, from: Keyframe = { opacity: 0, translate: "0 4px" }, duration = 220) {
  if (!element || calm()) return;
  element.animate([from, { opacity: 1, translate: "0 0" }], { duration, easing: "cubic-bezier(.22,.8,.24,1)" });
}

/** A tab, filter or sort swapped what comes after it: that content fades in rather than jumping. The top bar is left out, since its charts tween. */
export function fadeFollowing(host: Element) {
  if (host.closest(".top")) return;
  for (let node: Element | null = host; node && !node.matches(".main"); node = node.parentElement) {
    let found = false;
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      fadeIn(next, { opacity: 0, translate: "0 3px" }, 200);
      found = true;
    }
    if (found) return;
  }
}

/**
 * One shape that travels between the choices of a group. Drop it as the first child: it follows `.on`.
 * It moves by clip-path, so it costs no layout and keeps its corners at every size.
 */
export function Glide({ on, select = ":scope > .on", line, swap }: { on: unknown; select?: string; line?: boolean; swap?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const previous = useRef(on);
  useEffect(() => {
    if (previous.current === on) return;
    previous.current = on;
    if (swap && ref.current?.parentElement) fadeFollowing(ref.current.parentElement);
  }, [on, swap]);
  useLayoutEffect(() => {
    const shape = ref.current;
    const host = shape?.parentElement;
    if (!shape || !host) return;
    const place = () => {
      const target = host.querySelector<HTMLElement>(select);
      if (!target) return shape.style.setProperty("--g-o", "0");
      const outer = host.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const left = box.left - outer.left + host.scrollLeft;
      const top = box.top - outer.top + host.scrollTop;
      const width = host.scrollWidth;
      const height = host.scrollHeight;
      shape.style.setProperty("--g-sw", `${width}px`);
      shape.style.setProperty("--g-sh", `${height}px`);
      shape.style.setProperty("--g-l", `${left}px`);
      shape.style.setProperty("--g-r", `${width - left - box.width}px`);
      shape.style.setProperty("--g-t", `${line ? top + box.height - 1.5 : top}px`);
      shape.style.setProperty("--g-b", `${height - top - box.height}px`);
      shape.style.setProperty("--g-o", "1");
    };
    place();
    // The first placement must not slide in from nowhere, and neither should a resize.
    const frame = requestAnimationFrame(() => shape.classList.add("go"));
    const watcher = new ResizeObserver(place);
    watcher.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      watcher.disconnect();
    };
  }, [on, select, line]);
  return <i ref={ref} className="glide" aria-hidden="true" />;
}

/** Keeps the last value on screen for a moment after it goes, so a panel can leave instead of vanishing. */
export function Presence<T>({ value, children, ms = 120 }: { value: T | null | undefined; children: (value: T, leaving: boolean) => ReactNode; ms?: number }) {
  const [kept, setKept] = useState<T | null | undefined>(value);
  useEffect(() => {
    if (value !== null && value !== undefined) return setKept(value);
    if (calm()) return setKept(value);
    const timer = setTimeout(() => setKept(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  const shown = value ?? kept;
  if (shown === null || shown === undefined) return null;
  return <>{children(shown, value === null || value === undefined)}</>;
}
