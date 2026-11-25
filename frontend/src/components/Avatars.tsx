import type { JSX } from "preact";
import type { PresenceUser } from "../api";
import { initials, presenceColor, presenceLabel, splitOverflow } from "../lib/presence";

interface AvatarsProps {
  users: PresenceUser[];
  /** username of the logged-in user, marked "(du)" */
  self: string;
  max: number;
  small?: boolean;
  /** set: avatars of users with an open file are buttons opening that file */
  onOpenFile?: (path: string) => void;
  /** set: avatars of users with an open file trigger user selection (e.g. jump to cursor) */
  onSelectUser?: (user: PresenceUser) => void;
}

/** Colored initials of online users (same color as their cursor), "+N" beyond `max`. */
export function Avatars({ users, self, max, small, onOpenFile, onSelectUser }: AvatarsProps) {
  const { shown, rest } = splitOverflow(users, max);
  return (
    <span class={`avatar-stack ${small ? "avatar-stack-sm" : ""}`}>
      {shown.map((u) => {
        const label = presenceLabel(u, self);
        const color = presenceColor(u.username);
        const style = {
          background: color,
          "--avatar-color": color,
        } as JSX.CSSProperties;
        const file = u.file;
        const className = `avatar${file ? " is-active" : ""}`;
        const interactive = Boolean(file && (onSelectUser || onOpenFile));
        return interactive && file ? (
          <button
            key={u.username}
            type="button"
            class={className}
            style={style}
            title={label}
            aria-label={
              onSelectUser && u.username !== self
                ? `${label} — Zur Cursor-Position springen`
                : `${label} — Datei öffnen`
            }
            onClick={(e) => {
              e.stopPropagation();
              if (onSelectUser) {
                onSelectUser(u);
              } else {
                onOpenFile?.(file);
              }
            }}
          >
            {initials(u.display_name)}
          </button>
        ) : (
          <span key={u.username} class={className} style={style} role="img" title={label} aria-label={label}>
            {initials(u.display_name)}
          </span>
        );
      })}
      {rest.length > 0 && (
        <span
          class="avatar avatar-more"
          role="img"
          title={rest.map((u) => presenceLabel(u, self)).join("\n")}
          aria-label={`${rest.length} weitere: ${rest.map((u) => presenceLabel(u, self)).join("; ")}`}
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}
