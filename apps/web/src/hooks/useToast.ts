import { useCallback, useRef, useState } from "react";

/** How long a toast stays (doubled from 3 seconds at Elliot's request: they went too fast to read). */
export const TOAST_MS = 6000;

/** The toast notification at the bottom right of the screen: shows a message for TOAST_MS. */
export function useToast() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // The pending hide, restarted by each new toast, so a message shown twice in a row gets its full time.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToastMessage(null);
    }, TOAST_MS);
  }, []);

  return { toastMessage, showToast };
}
