import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { XIcon } from "./Icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  /** While busy, Esc / close button do nothing (e.g. clone in progress). */
  busy?: boolean;
  class?: string;
  children: ComponentChildren;
}

/** Native `<dialog>` (focus trap, Esc, backdrop for free). Mount to open, unmount to close. */
export function Modal({ title, onClose, busy = false, class: cls, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      class={cls ? `modal ${cls}` : "modal"}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div class="modal-header">
        <h2>{title}</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Schließen"
          disabled={busy}
          onClick={onClose}
        >
          <XIcon size={14} />
        </button>
      </div>
      <div class="modal-body">{children}</div>
    </dialog>
  );
}

interface ConfirmModalProps {
  title: string;
  message: ComponentChildren;
  confirmLabel: string;
  /** If set, the user must type this text before confirming. */
  requireText?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** In-app replacement for `window.confirm` for destructive actions. */
export function ConfirmModal({
  title,
  message,
  confirmLabel,
  requireText,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = requireText === undefined || typed === requireText;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Aktion fehlgeschlagen.");
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form class="form-stack" onSubmit={(e) => void submit(e)}>
        <div class="muted-text">{message}</div>
        {requireText !== undefined && (
          <label class="field">
            <span>
              Zum Bestätigen <code>{requireText}</code> eintippen
            </span>
            <input
              type="text"
              class="text-input"
              value={typed}
              disabled={busy}
              autoFocus
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
          </label>
        )}
        {error && <div class="alert alert-error">{error}</div>}
        <div class="form-actions">
          <button type="button" class="btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" class="btn-danger btn-sm" disabled={busy || !ready}>
            {busy ? "Bitte warten…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
