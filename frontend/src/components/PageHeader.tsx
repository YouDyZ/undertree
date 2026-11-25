import { useState } from "preact/hooks";
import { ApiError, type User, logout } from "../api";
import { linkClick } from "../lib/route";
import { LogOutIcon, TreeLogoIcon } from "./Icons";
import { UserName } from "./ProfileModal";
import { SettingsMenu } from "./SettingsMenu";

interface PageHeaderProps {
  user: User;
  onLoggedOut: () => void;
}

/** Top bar for the non-editor pages (project list, templates, admin). */
export function PageHeader({ user, onLoggedOut }: PageHeaderProps) {
  const [error, setError] = useState<string | null>(null);
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err: unknown) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Abmelden fehlgeschlagen.");
        return;
      }
    }
    onLoggedOut();
  };

  return (
    <header class="topbar">
      <div class="topbar-left">
        <a href="/" class="brand-mark brand-link" onClick={linkClick}>
          <TreeLogoIcon size={18} />
          <span class="brand-name">undertree</span>
        </a>
        <nav class="topbar-nav">
          <a href="/" class={`btn-ghost btn-sm${path === "/" ? " is-active" : ""}`} onClick={linkClick}>
            Projekte
          </a>
          <a
            href="/templates"
            class={`btn-ghost btn-sm${path === "/templates" ? " is-active" : ""}`}
            onClick={linkClick}
          >
            Templates
          </a>
          {user.is_admin && (
            <a
              href="/admin"
              class={`btn-ghost btn-sm${path === "/admin" ? " is-active" : ""}`}
              onClick={linkClick}
            >
              Admin
            </a>
          )}
        </nav>
      </div>
      <div class="topbar-right">
        {error && <span class="form-error">{error}</span>}
        <div class="user-chip" title={user.email ?? user.username}>
          <UserName user={user} />
          {user.is_admin && <span class="badge badge-admin">Admin</span>}
        </div>
        <SettingsMenu />
        <button
          type="button"
          class="icon-btn"
          title="Abmelden"
          aria-label="Abmelden"
          onClick={() => void handleLogout()}
        >
          <LogOutIcon size={15} />
        </button>
      </div>
    </header>
  );
}
