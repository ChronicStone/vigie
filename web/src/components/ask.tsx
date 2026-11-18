import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useLocation } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Icon } from "./icons.tsx";

/** Ask Vigie: answers from the same read-only tools as MCP, under your own role. */
export default function AskPanel({ onClose }: { onClose: () => void }) {
  const location = useLocation({ select: (l) => l.href });
  const [text, setText] = useState("");
  const [thread] = useState(() => crypto.randomUUID());
  const end = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, isLoading, error } = useChat({ connection: fetchServerSentEvents("/api/ai/chat"), threadId: thread, forwardedProps: { context: location } });
  return (
    <aside className="ask" aria-label="Ask Vigie">
      <div className="phead">
        <Icon name="spark" size={14} />
        <span style={{ fontWeight: 500 }}>Ask Vigie</span>
        <span className="grow" />
        <button className="ib" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="askb">
        {!messages.length && (
          <div className="home-ask-starts">
            {["What is failing right now?", "Why is this route slow?", "Which accounts were hit by that error?"].map((question) => (
              <button key={question} className="btn" onClick={() => void sendMessage(question)}>{question}</button>
            ))}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`askm ${message.role}`}>
            {message.parts.map((part, i) => (part.type === "text" ? <span key={i}>{part.content}</span> : part.type === "tool-call" ? <div className="askt" key={i}>Read {part.name}</div> : null))}
          </div>
        ))}
        {isLoading && <div className="askt">Reading telemetry…</div>}
        {error && <div className="err">{error.message}</div>}
        <div ref={end} />
      </div>
      <form
        style={{ padding: 10, borderTop: "1px solid var(--line)" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || isLoading) return;
          void sendMessage(text.trim());
          setText("");
        }}
      >
        <input className="input" autoFocus value={text} placeholder="Ask about this system" aria-label="Your question" onChange={(e) => setText(e.target.value)} />
      </form>
    </aside>
  );
}
