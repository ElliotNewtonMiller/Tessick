import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface PickerMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown in red (a delete). */
  danger?: boolean;
}

/**
 * A "⋯" button that opens a short menu of actions: the header's New / Edit / Delete for the
 * project, plan or run. A choice, Escape, a click elsewhere or tabbing away closes it; Up and Down
 * move between items. While it's open, keys don't reach the app's single-key shortcuts
 * (useHotkeyEngine listens on window), so typing "p" in the menu can't record a verdict.
 * Renders nothing when there are no items (the user may do none of them).
 */
export function PickerMenu({ label, items }: { label: string; items: PickerMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const first = itemRefs.current.findIndex((b) => b && !b.disabled);
    if (first >= 0) itemRefs.current[first]?.focus();
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (items.length === 0) return null;

  const close = (refocusButton: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (refocusButton) buttonRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = itemRefs.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
      if (enabled.length === 0) return;
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(at + step + enabled.length) % enabled.length].focus();
    }
  };

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", display: "flex" }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
        style={{
          background: open ? "#1e293b" : "transparent",
          border: "1px solid",
          borderColor: open ? "#3b4a63" : "transparent",
          borderRadius: "6px",
          color: "#cbd5e1",
          padding: "2px 8px",
          fontSize: "16px",
          fontWeight: 700,
          lineHeight: 1,
          height: "30px",
          cursor: "pointer",
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: "180px",
            backgroundColor: "#1e293b",
            border: "1px solid #3b4a63",
            borderRadius: "6px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
            padding: "4px",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onFocus={() => setActiveIndex(i)}
              onMouseEnter={() => !item.disabled && itemRefs.current[i]?.focus()}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              style={{
                textAlign: "left",
                border: "none",
                borderRadius: "4px",
                padding: "7px 10px",
                fontSize: "13px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                outline: "none",
                backgroundColor: activeIndex === i && !item.disabled ? "#2b3a55" : "transparent",
                color: item.disabled ? "#64748b" : item.danger ? "#f87171" : "#e2e8f0",
                cursor: item.disabled ? "not-allowed" : "pointer",
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
