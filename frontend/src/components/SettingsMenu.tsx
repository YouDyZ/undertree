import { useEffect, useRef, useState } from "preact/hooks";
import { EDITOR_THEMES, type EditorThemeMeta } from "../theme/editorThemes";
import { type AppThemeMode, useThemeSettings } from "../theme/themeStore";
import { CheckIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "./Icons";

const APP_THEME_OPTIONS: readonly { mode: AppThemeMode; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Hell" },
  { mode: "dark", label: "Dunkel" },
];

const DARK_EDITOR_THEMES: readonly EditorThemeMeta[] = EDITOR_THEMES.filter(
  (t) => t.group === "dark"
);
const LIGHT_EDITOR_THEMES: readonly EditorThemeMeta[] = EDITOR_THEMES.filter(
  (t) => t.group === "light"
);

export function SettingsMenu() {
  const { appTheme, editorTheme, setAppTheme, setEditorTheme } = useThemeSettings();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (anchorRef.current && target && !anchorRef.current.contains(target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const renderThemeGroup = (title: string, items: readonly EditorThemeMeta[]) => (
    <div class="theme-group">
      <div class="theme-group-label">{title}</div>
      <div class="theme-option-list" role="radiogroup" aria-label={`Editor-Theme (${title})`}>
        {items.map((theme) => {
          const active = editorTheme === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={active}
              class={`theme-option ${active ? "is-active" : ""}`}
              onClick={() => setEditorTheme(theme.id)}
            >
              <span
                class="theme-swatch"
                style={{ backgroundColor: theme.swatch.bg }}
                aria-hidden="true"
              >
                <span class="theme-swatch-dot" style={{ backgroundColor: theme.swatch.keyword }} />
                <span class="theme-swatch-dot" style={{ backgroundColor: theme.swatch.accent }} />
                <span class="theme-swatch-dot" style={{ backgroundColor: theme.swatch.fg }} />
              </span>
              <span class="theme-option-label">{theme.label}</span>
              <span class="theme-option-check" aria-hidden="true">
                {active && <CheckIcon size={13} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div class="settings-menu-anchor" ref={anchorRef}>
      <button
        type="button"
        class={`icon-btn ${open ? "is-active" : ""}`}
        title="Darstellung & Editor-Theme"
        aria-label="Darstellung & Editor-Theme"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SettingsIcon size={15} />
      </button>

      {open && (
        <div class="settings-popover" role="dialog" aria-label="Darstellungseinstellungen">
          <div class="settings-popover-section">
            <div class="settings-popover-title">Erscheinungsbild</div>
            <div class="theme-segmented" role="radiogroup" aria-label="Erscheinungsbild">
              {APP_THEME_OPTIONS.map((opt) => {
                const active = appTheme === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    class={`theme-seg-btn ${active ? "is-active" : ""}`}
                    onClick={() => setAppTheme(opt.mode)}
                  >
                    {opt.mode === "system" && <MonitorIcon size={13} />}
                    {opt.mode === "light" && <SunIcon size={13} />}
                    {opt.mode === "dark" && <MoonIcon size={13} />}
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div class="settings-popover-section">
            <div class="settings-popover-title">Editor-Theme</div>
            {renderThemeGroup("Dunkel", DARK_EDITOR_THEMES)}
            {renderThemeGroup("Hell", LIGHT_EDITOR_THEMES)}
          </div>
        </div>
      )}
    </div>
  );
}
