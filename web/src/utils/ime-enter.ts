import { useCallback, useRef } from "react";
import type { CompositionEvent, KeyboardEvent } from "react";

export interface ImeEnterState {
  composing: boolean;
  ignoreEnterAfterComposition: boolean;
}

/** True when Enter should trigger submit (not IME conversion / follow-up keydown). */
export function shouldSubmitOnEnter(
  e: Pick<KeyboardEvent, "key" | "keyCode"> & { nativeEvent: Pick<KeyboardEvent["nativeEvent"], "isComposing"> },
  state: ImeEnterState,
): boolean {
  if (e.key !== "Enter") return false;
  if (state.composing || e.nativeEvent.isComposing || e.keyCode === 229) return false;
  if (state.ignoreEnterAfterComposition) return false;
  return true;
}

/** Handlers for text inputs where Enter should submit, but not during IME conversion. */
export function useImeEnterHandler(onEnter: () => void) {
  const composingRef = useRef(false);
  /** Blocks the keydown Enter that immediately follows compositionend (same physical key). */
  const ignoreEnterAfterCompositionRef = useRef(false);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback((_e: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    composingRef.current = false;
    ignoreEnterAfterCompositionRef.current = true;
    window.setTimeout(() => {
      ignoreEnterAfterCompositionRef.current = false;
    }, 0);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (
        !shouldSubmitOnEnter(e, {
          composing: composingRef.current,
          ignoreEnterAfterComposition: ignoreEnterAfterCompositionRef.current,
        })
      ) {
        return;
      }
      e.preventDefault();
      onEnter();
    },
    [onEnter],
  );

  return { onCompositionStart, onCompositionEnd, onKeyDown };
}
