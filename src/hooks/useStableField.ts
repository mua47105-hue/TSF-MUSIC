/**
 * StableField — the uncontrolled-input primitive (the anti-"hihiz").
 *
 * WHY THIS EXISTS (v4.0.1 bug fix):
 *   A fully-controlled RN TextInput (`value={state}` + `onChangeText={setState}`)
 *   races its own value prop: when the JS thread is busy (search debounce,
 *   autocomplete, result-list re-renders), a render can commit a STALE value
 *   back into the field between keystrokes. Fast typing then duplicates the
 *   native text — the reported "type `hi` + `z` → field shows `hihiz`" bug.
 *
 * HOW IT'S FIXED:
 *   The field is UNCONTROLLED — the native text is the single source of
 *   truth while the user types. Every keystroke updates a ref (cheap, zero
 *   re-render) and the React state commits on a short trailing throttle
 *   (~120ms), so heavy result trees stop re-rendering per character.
 *   Programmatic writes (recents/suggestion chips, the clear button) go
 *   through setValue(), which writes the native text directly on all
 *   platforms and commits immediately.
 *
 * PLATFORM MATRIX for setValue(v):
 *   • native (legacy arch — newArchEnabled=false): setNativeProps({text})
 *   • react-native-web: the ref IS the host <input> node → `.value = v`
 *   • '' uses the official clear() on both platforms
 *
 * CONTRACT (locked by tests/ai/input_stability_locks.test.ts):
 *   • field text is NEVER fed back from React state while typing
 *   • handleChange + setValue + getValue have stable identities
 *   • commit fires at most once per commitMs with the LATEST text
 *   • setValue commits synchronously (chip presses search instantly)
 */

import { useCallback, useEffect, useRef } from 'react';
import type { TextInput } from 'react-native';

/** A TextInput ref, widened for the react-native-web host node. */
type FieldRef = TextInput | (null & { value?: string; clear?: () => void });

export interface StableField {
  /** Attach to the TextInput. */
  inputRef: (node: TextInput | null) => void;
  /** Wire to onChangeText — never re-renders the field while typing. */
  handleChange: (text: string) => void;
  /** The exact current field text (fresh in any closure). */
  getValue: () => string;
  /** Programmatic write (chips, clear): sets native text + commits now. */
  setValue: (v: string) => void;
}

export function useStableField(opts?: {
  /** Receives the committed text (drives search + UI conditions). */
  onCommit?: (v: string) => void;
  /** Trailing throttle for typing commits (default 120ms). */
  commitMs?: number;
}): StableField {
  const commitMs = opts?.commitMs ?? 120;
  const nodeRef = useRef<TextInput | null>(null);
  const valueRef = useRef('');
  const pendingRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // KNOWN TRADE-OFF (v4.0.1 triage): onCommitRef is written during render.
  // Impure under concurrent rendering, but every caller passes a stable
  // setState identity, so the write is idempotent in practice — the cost
  // of the useEffect alternative is a one-commit lag on the first paint.
  const onCommitRef = useRef(opts?.onCommit);
  onCommitRef.current = opts?.onCommit;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onCommitRef.current?.(pendingRef.current);
  }, []);

  const inputRef = useCallback((node: TextInput | null) => {
    nodeRef.current = node;
  }, []);

  const handleChange = useCallback(
    (text: string) => {
      valueRef.current = text;
      pendingRef.current = text;
      if (timerRef.current == null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flush();
        }, commitMs);
      }
    },
    [commitMs, flush],
  );

  const setValue = useCallback(
    (v: string) => {
      valueRef.current = v;
      pendingRef.current = v;
      const node = nodeRef.current as FieldRef | null;
      if (node) {
        if (v === '' && typeof node.clear === 'function') {
          node.clear();
        } else if (typeof (node as { setNativeProps?: unknown }).setNativeProps === 'function') {
          // native (legacy arch): direct text write, no re-render, no race
          (node as TextInput).setNativeProps?.({ text: v });
        } else {
          // react-native-web: the ref is the host <input> node
          (node as unknown as { value: string }).value = v;
        }
      }
      flush(); // chip presses / clears search instantly
    },
    [flush],
  );

  const getValue = useCallback(() => valueRef.current, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { inputRef, handleChange, getValue, setValue };
}
