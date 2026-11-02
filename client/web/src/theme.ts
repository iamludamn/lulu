export type Theme = "system" | "light" | "dark";

const KEY = "pistack.theme";
const ORDER: readonly Theme[] = ["system", "light", "dark"];

export const THEME_LABEL: Record<Theme, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

export function loadTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }
}

export function nextTheme(theme: Theme): Theme {
  return ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
}
