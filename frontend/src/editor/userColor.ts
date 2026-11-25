export interface UserColor {
  color: string;
  colorLight: string;
}

const PALETTE: readonly string[] = [
  "#38bdf8", // sky
  "#34d399", // emerald
  "#a78bfa", // violet
  "#f472b6", // pink
  "#fbbf24", // amber
  "#fb7185", // rose
  "#2dd4bf", // teal
  "#f97316", // orange
];

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getUserColor(seed: string | number): UserColor {
  const idx = hashString(String(seed)) % PALETTE.length;
  const color = PALETTE[idx] ?? "#38bdf8";
  return {
    color,
    colorLight: `${color}33`,
  };
}
