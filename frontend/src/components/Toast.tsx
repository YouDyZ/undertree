import { CopyIcon, XIcon } from "./Icons";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  action?: ToastAction;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;
  return (
    <div class="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={`toast toast-${toast.kind}`}>
          <div class="toast-body">
            <span class="toast-msg">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                class="btn-ghost btn-xs toast-action-btn"
                onClick={() => toast.action?.onClick()}
              >
                <CopyIcon size={12} />
                <span>{toast.action.label}</span>
              </button>
            )}
          </div>
          <button
            type="button"
            class="icon-btn"
            aria-label="Schließen"
            onClick={() => onDismiss(toast.id)}
          >
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
