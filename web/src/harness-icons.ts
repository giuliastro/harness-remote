// Icons bundled under public/harness-icons, so they ship inside the APK and work offline.
// The Classic skin keeps the project's own generic glyphs, except for the DeepSeek mark requested
// in both skins. The other brand marks under brand/ are used by the Mahurley skin.
const CLASSIC_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  deepseek: "brand/deepseek.svg",
  opencode: "opencode.svg",
  opencode2: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

const BRAND_ICON_FILES: Record<string, string> = {
  codex: "brand/codex.svg",
  claude: "brand/claude.svg",
  copilot: "brand/copilot.svg",
  mimo: "brand/mimo.svg",
  deepseek: "brand/deepseek.svg",
  opencode: "brand/opencode.svg",
  opencode2: "brand/opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

// Model catalogs name providers rather than harnesses; OpenCode in particular lists many.
const BRAND_PROVIDER_ICON_FILES: Record<string, string> = {
  ...BRAND_ICON_FILES,
  openai: "brand/codex.svg",
  anthropic: "brand/claude.svg",
  "github-copilot": "brand/copilot.svg",
  xiaomi: "brand/mimo.svg",
  "deepseek-official": "brand/deepseek.svg",
  "opencode-go": "brand/opencode.svg"
}

function brandSkin(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.skin === "compact"
}

function iconUrl(file: string | undefined): string | undefined {
  return file ? `${import.meta.env?.BASE_URL ?? "/"}harness-icons/${file}` : undefined
}

export function harnessIconUrl(backend: string | undefined): string | undefined {
  if (!backend) return undefined
  const files = brandSkin() ? BRAND_ICON_FILES : CLASSIC_ICON_FILES
  return iconUrl(files[backend.toLowerCase()])
}

/** Provider marks are part of the Mahurley skin only; Classic model lists stay text-only. */
export function providerIconUrl(providerID: string | undefined): string | undefined {
  if (!providerID || !brandSkin()) return undefined
  return iconUrl(BRAND_PROVIDER_ICON_FILES[providerID.toLowerCase()])
}
