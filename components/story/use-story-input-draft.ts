"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { loadStoryInputDraft, saveStoryInputDraft } from "@/lib/story-input-draft";

/** The composer is keyed by session, so cleanup always saves the departing session's text. */
export function useStoryInputDraft(sessionId: string) {
  const [draft, setState] = useState(() => loadStoryInputDraft(sessionId));
  const latest = useRef(draft);
  const setDraft = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === "function" ? next(latest.current) : next;
    latest.current = value;
    setState(value);
    // Clearing after send must reach storage before a blur, navigation or unmount can restore it.
    if (!value) saveStoryInputDraft(sessionId, "");
  }, [sessionId]);
  const flush = useCallback(() => saveStoryInputDraft(sessionId, latest.current), [sessionId]);
  useEffect(() => {
    const timer = setTimeout(flush, 350);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  useEffect(() => {
    const viewport = window.visualViewport;
    window.addEventListener("pagehide", flush);
    window.addEventListener("resize", flush);
    viewport?.addEventListener("resize", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("resize", flush);
      viewport?.removeEventListener("resize", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [flush]);
  return { draft, setDraft, flush };
}
