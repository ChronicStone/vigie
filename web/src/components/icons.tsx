import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  overview: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  issues: <><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3.2M8 11.5v.1" /></>,
  logs: <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />,
  requests: <path d="M2 5.5h10.5L10 3M14 10.5H3.5L6 13" />,
  tasks: <><circle cx="4" cy="4" r="1.8" /><circle cx="4" cy="12" r="1.8" /><path d="M4 5.8v4.4M7.5 4H14M7.5 12H14M7.5 8H12" /></>,
  traces: <path d="M2.5 3.5h7M5 8h6M8 12.5h5.5" />,
  queries: <><ellipse cx="8" cy="3.8" rx="5.2" ry="1.9" /><path d="M2.8 3.8v8.4c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V3.8M2.8 8c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9" /></>,
  external: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2.6 3.8 2.6 6S10 12 8 14M8 2C6 4 5.4 5.8 5.4 8S6 12 8 14" /></>,
  emails: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="m2.5 4.5 5.5 4.2 5.5-4.2" /></>,
  alerts: <path d="M4 7a4 4 0 1 1 8 0c0 3.5 1.5 4.5 1.5 4.5h-11S4 10.5 4 7zM6.8 13.7a1.3 1.3 0 0 0 2.4 0" />,
  uptime: <path d="M1.5 8h3l1.8-4.5 3.2 9L11.5 8h3" />,
  releases: <><circle cx="8" cy="8" r="2.3" /><path d="M1.5 8h4.2M10.3 8h4.2" /></>,
  biz: <path d="M2.5 13.5V6.5l4-3 4 3v7M10.5 8.5h3v5M1.5 13.5h13" />,
  dash: <><rect x="2" y="2" width="12" height="12" rx="1.5" /><path d="M2 6.5h12M6.5 6.5V14" /></>,
  chev: <path d="m4 6 4 4 4-4" />,
  up: <path d="m4 10 4-4 4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  check: <path d="m3 8.5 3.2 3 6.8-7" strokeWidth={2.2} />,
  plus: <path d="M8 3v10M3 8h10" />,
  back: <path d="m10 3-5 5 5 5" />,
  code: <path d="m5.5 4-4 4 4 4M10.5 4l4 4-4 4" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  replay: <path d="M3 8a5 5 0 1 0 1.6-3.7L3 6M3 2.5V6h3.5" />,
  spark: <path d="M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6z" />,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" /></>,
  user: <><circle cx="8" cy="5.2" r="2.7" /><path d="M2.8 13.5c.8-2.6 2.8-3.8 5.2-3.8s4.4 1.2 5.2 3.8" /></>,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  workers: <><rect x="2.5" y="3" width="11" height="4" rx="1" /><rect x="2.5" y="9" width="11" height="4" rx="1" /><path d="M5 5h.1M5 11h.1" /></>,
  schedules: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8V8l2.2 1.5" /></>,
  processes: <><circle cx="3.5" cy="8" r="1.6" /><circle cx="12.5" cy="3.8" r="1.6" /><circle cx="12.5" cy="12.2" r="1.6" /><path d="M5 7.4 11 4.4M5 8.6l6 3" /></>,
  metrics: <path d="M2.5 2.5v11h11M5.5 10.5V8M8.5 10.5V5M11.5 10.5V7" />,
  target: <><circle cx="8" cy="8" r="5.8" /><circle cx="8" cy="8" r="2.4" /></>,
};

export function Icon({ name, size, style, className }: { className?: string;  name: keyof typeof PATHS | string; size?: number; style?: React.CSSProperties }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ ...(size ? { width: size, height: size } : null), ...style }}>
      {PATHS[name]}
    </svg>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 22 22" style={{ width: size, height: size, flex: "none" }} aria-hidden="true">
      <defs>
        <linearGradient id="vigie-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E47A6C" />
          <stop offset="1" stopColor="#C4554C" />
        </linearGradient>
      </defs>
      <rect width="22" height="22" rx="6.5" fill="url(#vigie-mark)" />
      <rect x=".5" y=".5" width="21" height="21" rx="6" fill="none" stroke="rgba(255,255,255,.34)" />
      <circle cx="11" cy="11" r="5.2" fill="none" stroke="#fff" strokeWidth="1.7" />
      <circle cx="11" cy="11" r="1.9" fill="#fff" />
    </svg>
  );
}
