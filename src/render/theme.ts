export type ThemeName = "dark" | "light";

/** Deliberately small palette, borrowed from GitHub's own UI colours so the board sits quietly in a README. */
export interface Theme {
  name: ThemeName;
  bg: string;
  line: string;
  lineSoft: string;
  text: string;
  muted: string;
  faint: string;
  snake: string;
  head: string;
  apple: string;
}

const dark: Theme = {
  name: "dark",
  bg: "#0d1117",
  line: "#30363d",
  lineSoft: "#21262d",
  text: "#e6edf3",
  muted: "#7d8590",
  faint: "#484f58",
  snake: "#3fb950",
  head: "#7ee787",
  apple: "#f85149",
};

const light: Theme = {
  name: "light",
  bg: "#ffffff",
  line: "#d0d7de",
  lineSoft: "#eaeef2",
  text: "#1f2328",
  muted: "#656d76",
  faint: "#afb8c1",
  snake: "#2da44e",
  head: "#116329",
  apple: "#cf222e",
};

export const THEMES: Record<ThemeName, Theme> = { dark, light };

export function parseTheme(v: string | null | undefined): ThemeName {
  return v === "dark" ? "dark" : "light";
}
