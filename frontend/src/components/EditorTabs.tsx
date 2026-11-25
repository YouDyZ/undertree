import { XIcon } from "./Icons";

export interface OpenTab {
  path: string;
  repo: string;
  kind: "doc" | "image";
}

interface EditorTabsProps {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

function fileBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function EditorTabs({ tabs, activePath, onSelect, onClose }: EditorTabsProps) {
  if (tabs.length === 0) return null;

  return (
    <div class="editor-tabs" role="tablist" aria-label="Geöffnete Dateien">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const isSubmodule = tab.repo !== "";
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            class={`editor-tab ${active ? "is-active" : ""}`}
            title={tab.path}
            onClick={() => onSelect(tab.path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.path);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(tab.path);
              }
            }}
          >
            <span
              class={`tab-repo-dot ${isSubmodule ? "dot-submodule" : "dot-parent"}`}
              title={isSubmodule ? `Submodul: ${tab.repo}` : "Parent-Repo"}
            />
            <span class="tab-label">{fileBasename(tab.path)}</span>
            <button
              type="button"
              class="tab-close"
              aria-label={`${fileBasename(tab.path)} schließen`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
            >
              <XIcon size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
