export type TourPlacement = "auto" | "right" | "left" | "bottom" | "top";

export interface TourStep {
  id: string;
  targetSelector: string | null;
  title: string;
  description: string;
  tip?: string;
  shortcut?: string;
  preferredPlacement?: TourPlacement;
}

export const EDITOR_TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    targetSelector: null,
    title: "Willkommen bei Undertree",
    description:
      "Undertree kombiniert kollaboratives LaTeX-Editieren in Echtzeit mit direktem Git- & Submodul-Workflow. Diese kurze Tour zeigt dir in unter einer Minute die wichtigsten Bereiche.",
    tip: "Du kannst die Tour jederzeit über den Tour-Button oben rechts erneut starten oder mit Esc schließen.",
    preferredPlacement: "auto",
  },
  {
    id: "file-tree",
    targetSelector: '[data-tour="file-tree"]',
    title: "Dateibaum & Git-Submodule",
    description:
      "Hier siehst du das Parent-Repository (ROOT) sowie alle eingebundenen Git-Submodule (SUB inkl. Branch/HEAD). Nicht initialisierte Submodule sind ausgegraut und lassen sich per Klick direkt im Git-Panel initialisieren.",
    tip: "Nutze das Filterfeld zur schnellen Dateisuche oder + um neue Dateien anzulegen.",
    preferredPlacement: "right",
  },
  {
    id: "editor",
    targetSelector: '[data-tour="editor-pane"]',
    title: "Kollaborativer LaTeX-Editor",
    description:
      "Mehrere Personen können dieselbe Datei gleichzeitig bearbeiten — Änderungen und Live-Cursors synchronisieren sich in Echtzeit per CRDT (Yjs). Über die Tab-Leiste wechselst du nahtlos zwischen offenen Dateien und Bildvorschauen.",
    shortcut: "Strg + S",
    tip: "Mit Strg + S speicherst du Live-Änderungen sofort auf Disk und stößt direkt die PDF-Kompilierung an.",
    preferredPlacement: "right",
  },
  {
    id: "pdf",
    targetSelector: '[data-tour="pdf-pane"]',
    title: "PDF-Vorschau, Hot-Reload & Diagnostics",
    description:
      "Wähle deine Haupt-.tex-Datei und klicke auf Compile (oder drücke Strg + S). Nach jedem Build aktualisiert PDF.js die Vorschau ohne Seitensprung. Bei Fehlern öffnet sich der Diagnostics-Bereich — ein Klick springt direkt in die passende Editor-Zeile.",
    preferredPlacement: "left",
  },
  {
    id: "git",
    targetSelector: '[data-tour="git-button"]',
    title: "Git & Submodule direkt in der UI",
    description:
      "Über das Git-Panel wechselst du gezielt zwischen Parent-Repo und einzelnen Submodulen: farbigen Diff prüfen, ausgewählte Dateien committen, Pull/Push ausführen und Submodule aktualisieren.",
    preferredPlacement: "bottom",
  },
  {
    id: "live-status",
    targetSelector: '[data-tour="live-status"]',
    title: "Live-Status & Sitzung",
    description:
      "Der Live-Indikator zeigt die Echtzeit-Verbindung zum Server (/ws/events). Externe Änderungen (z. B. nach einem git pull) aktualisieren Dateibaum und offene Dokumente automatisch.",
    tip: "Alles bereit — viel Erfolg beim Schreiben!",
    preferredPlacement: "bottom",
  },
];
