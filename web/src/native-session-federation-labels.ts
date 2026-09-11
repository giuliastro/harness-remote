import type { LanguageCode } from "./i18n"
import type { FederatedSessionBucket } from "./native-session-federation"

export type FederatedOperationalBucket = Extract<FederatedSessionBucket, "failed" | "completed" | "recent">

type Labels = {
  moreStates: string
  failed: string
  completed: string
  recent: string
}

const LABELS: Record<LanguageCode, Labels> = {
  en: {
    moreStates: "More states",
    failed: "Failed",
    completed: "Completed",
    recent: "Recent"
  },
  it: {
    moreStates: "Altri stati",
    failed: "Non riuscite",
    completed: "Completate",
    recent: "Recenti"
  },
  "zh-TW": {
    moreStates: "其他狀態",
    failed: "失敗",
    completed: "已完成",
    recent: "最近"
  },
  "zh-CN": {
    moreStates: "其他状态",
    failed: "失败",
    completed: "已完成",
    recent: "最近"
  }
}

export function federatedMoreStatesLabel(language: LanguageCode): string {
  return LABELS[language].moreStates
}

export function federatedOperationalStateLabel(bucket: FederatedOperationalBucket, language: LanguageCode): string {
  return LABELS[language][bucket]
}
