import type { JSX } from "preact";

interface IconProps {
  size?: number;
  class?: string;
}

const baseProps = (size: number, cls?: string): JSX.SVGAttributes<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  class: cls,
  "aria-hidden": "true",
});

export function GitHubIcon({ size = 18, class: cls }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" class={cls} aria-hidden="true">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

export function GoogleIcon({ size = 18, class: cls }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" class={cls} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M12 10.2v3.9h5.5c-.24 1.26-.96 2.33-2.04 3.04l3.3 2.56c1.92-1.77 3.04-4.38 3.04-7.48 0-.72-.06-1.41-.19-2.02H12Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.75 0 5.06-.91 6.75-2.46l-3.3-2.56c-.91.61-2.08.97-3.45.97-2.65 0-4.9-1.79-5.7-4.2H2.89v2.64A10.2 10.2 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.3 13.75A6.13 6.13 0 0 1 5.98 12c0-.61.11-1.2.32-1.75V7.61H2.89A10.2 10.2 0 0 0 1.8 12c0 1.65.4 3.2 1.09 4.39l3.41-2.64Z"
      />
      <path
        fill="#EA4335"
        d="M12 6.05c1.5 0 2.84.52 3.9 1.53l2.92-2.92C17.05 2.99 14.74 2 12 2A10.2 10.2 0 0 0 2.89 7.61l3.41 2.64c.8-2.41 3.05-4.2 5.7-4.2Z"
      />
    </svg>
  );
}

export function FolderIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />
    </svg>
  );
}

export function FolderOpenIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10H5.5L3 17.5V6.5Z" />
      <path d="M3 17.5 5.5 10H21l-2.1 7.8a1.5 1.5 0 0 1-1.45 1.2H4.5A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  );
}

export function SubmoduleIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M21 8.5V16a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8.5a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.73Z" />
      <path d="m3.3 7.4 8.7 5 8.7-5" />
      <path d="M12 22V12.4" />
    </svg>
  );
}

export function FileIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function ImageIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-4.5-4.5L7 20" />
    </svg>
  );
}

export function GitBranchIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 8.5a6.5 6.5 0 0 1-6.5 6.5H6" />
    </svg>
  );
}

export function RefreshIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function PlusIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function TrashIcon({ size = 13, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </svg>
  );
}

export function EditIcon({ size = 13, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function LogOutIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function SearchIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function AlertIcon({ size = 16, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function XIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function TreeLogoIcon({ size = 22, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M12 3 5 11h4l-3 6h12l-3-6h4L12 3Z" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function PlayIcon({ size = 13, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MinusIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function DownloadIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function UploadIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

export function CopyIcon({ size = 13, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function TerminalIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

export function SettingsIcon({ size = 15, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function CheckIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SunIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function MonitorIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function HelpCircleIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 4.8.8c0 1.7-2.3 2.2-2.3 3.2" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function PanelRightIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

export function GlobeIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8" />
      <path d="M3.6 15h16.8" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18" />
      <path d="M12 3a13.5 13.5 0 0 0 0 18" />
    </svg>
  );
}

export function BookOpenIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
    </svg>
  );
}

export function LockIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function EyeIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function UnlinkIcon({ size = 12, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

export function MessageSquareIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  );
}

export function MessageCircleIcon({ size = 14, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

export function RotateCcwIcon({ size = 13, class: cls }: IconProps) {
  return (
    <svg {...baseProps(size, cls)}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
