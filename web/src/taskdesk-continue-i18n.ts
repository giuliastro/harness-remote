import type { LanguageCode } from "./i18n"

type ContinueCopy = {
  targetHarness: string
  targetModel: string
  targetUnavailable: string
  runSettings: string
  editSettings: string
  hideSettings: string
  role: string
  roleContinue: string
  roleReview: string
  roleTest: string
  roleDebug: string
  roleRefactor: string
  roleInvestigate: string
  roleCustom: string
  customRole: string
  sessionStrategy: string
  reuseSession: string
  freshSession: string
  noReusableSession: string
  contextTitle: string
  contextHint: string
  contextLoading: string
  contextRevision: string
  objective: string
  currentState: string
  latestOutcome: string
  changedFiles: string
  recentRuns: string
  noChanges: string
  transferredContext: string
  fallbackHint: string
}

const copy: Record<LanguageCode, ContinueCopy> = {
  en: {
    targetHarness: "Target harness",
    targetModel: "Target model",
    targetUnavailable: "The selected harness is unavailable. Choose an available harness before starting the next Run.",
    runSettings: "Next Run",
    editSettings: "Change harness, model and strategy",
    hideSettings: "Done",
    role: "Role / purpose",
    roleContinue: "Continue implementation",
    roleReview: "Review",
    roleTest: "Test / verify",
    roleDebug: "Debug",
    roleRefactor: "Refactor",
    roleInvestigate: "Investigate",
    roleCustom: "Custom",
    customRole: "Custom role",
    sessionStrategy: "Session strategy",
    reuseSession: "Reuse latest native Session",
    freshSession: "Start a fresh native Session",
    noReusableSession: "This harness has no recorded native Session to resume, so the next Run must start fresh.",
    contextTitle: "Task Context preview",
    contextHint: "This is the bounded context TaskDesk will use to continue the durable Task.",
    contextLoading: "Loading Task Context…",
    contextRevision: "Context revision",
    objective: "Objective",
    currentState: "Current state",
    latestOutcome: "Latest outcome",
    changedFiles: "Changed files",
    recentRuns: "Recent Runs",
    noChanges: "No changed files reported.",
    transferredContext: "When the target is not a direct native continuation, TaskDesk transfers this context explicitly. It is not native conversational memory from another harness.",
    fallbackHint: "This daemon does not expose Task Context yet. Continue uses the compatible prompt-only flow."
  },
  it: {
    targetHarness: "Harness di destinazione",
    targetModel: "Modello di destinazione",
    targetUnavailable: "L'harness selezionato non è disponibile. Scegli un harness disponibile prima di avviare il prossimo Run.",
    runSettings: "Prossima Run",
    editSettings: "Cambia harness, modello e strategia",
    hideSettings: "Fatto",
    role: "Ruolo / scopo",
    roleContinue: "Continua implementazione",
    roleReview: "Revisione",
    roleTest: "Test / verifica",
    roleDebug: "Debug",
    roleRefactor: "Refactoring",
    roleInvestigate: "Analisi",
    roleCustom: "Personalizzato",
    customRole: "Ruolo personalizzato",
    sessionStrategy: "Strategia Sessione",
    reuseSession: "Riusa l'ultima Sessione nativa",
    freshSession: "Avvia una nuova Sessione nativa",
    noReusableSession: "Questo harness non ha una Sessione nativa registrata da riprendere, quindi il prossimo Run deve partire da una nuova Sessione.",
    contextTitle: "Anteprima Task Context",
    contextHint: "Questo è il contesto limitato che TaskDesk userà per continuare il Task durevole.",
    contextLoading: "Caricamento Task Context…",
    contextRevision: "Revisione contesto",
    objective: "Obiettivo",
    currentState: "Stato corrente",
    latestOutcome: "Ultimo risultato",
    changedFiles: "File modificati",
    recentRuns: "Run recenti",
    noChanges: "Nessun file modificato segnalato.",
    transferredContext: "Quando non si tratta di una continuazione nativa diretta, TaskDesk trasferisce esplicitamente questo contesto. Non è memoria conversazionale nativa di un altro harness.",
    fallbackHint: "Questo daemon non espone ancora Task Context. Continue usa il flusso compatibile basato solo sul prompt."
  },
  "zh-TW": {
    targetHarness: "目標 Harness",
    targetModel: "目標模型",
    targetUnavailable: "所選 Harness 目前無法使用。請選擇可用的 Harness，再啟動下一個 Run。",
    runSettings: "下一個 Run",
    editSettings: "變更 Harness、模型與策略",
    hideSettings: "完成",
    role: "角色 / 目的",
    roleContinue: "繼續實作",
    roleReview: "審閱",
    roleTest: "測試 / 驗證",
    roleDebug: "除錯",
    roleRefactor: "重構",
    roleInvestigate: "調查",
    roleCustom: "自訂",
    customRole: "自訂角色",
    sessionStrategy: "Session 策略",
    reuseSession: "重用最近的原生 Session",
    freshSession: "啟動新的原生 Session",
    noReusableSession: "此 harness 沒有可恢復的原生 Session 紀錄，因此下一個 Run 必須從新的 Session 開始。",
    contextTitle: "Task Context 預覽",
    contextHint: "這是 TaskDesk 用來延續持久任務的有限上下文。",
    contextLoading: "正在載入 Task Context…",
    contextRevision: "上下文版本",
    objective: "目標",
    currentState: "目前狀態",
    latestOutcome: "最新結果",
    changedFiles: "已變更檔案",
    recentRuns: "最近的 Run",
    noChanges: "沒有回報已變更檔案。",
    transferredContext: "若不是直接延續同一個原生 Session，TaskDesk 會明確轉移此上下文。這不是來自另一個 harness 的原生對話記憶。",
    fallbackHint: "此 daemon 尚未提供 Task Context。Continue 將使用相容的純提示流程。"
  },
  "zh-CN": {
    targetHarness: "目标 Harness",
    targetModel: "目标模型",
    targetUnavailable: "所选 Harness 当前不可用。请选择可用的 Harness，再启动下一个 Run。",
    runSettings: "下一个 Run",
    editSettings: "更改 Harness、模型和策略",
    hideSettings: "完成",
    role: "角色 / 目的",
    roleContinue: "继续实现",
    roleReview: "审阅",
    roleTest: "测试 / 验证",
    roleDebug: "调试",
    roleRefactor: "重构",
    roleInvestigate: "调查",
    roleCustom: "自定义",
    customRole: "自定义角色",
    sessionStrategy: "Session 策略",
    reuseSession: "复用最近的原生 Session",
    freshSession: "启动新的原生 Session",
    noReusableSession: "此 harness 没有可恢复的原生 Session 记录，因此下一个 Run 必须从新的 Session 开始。",
    contextTitle: "Task Context 预览",
    contextHint: "这是 TaskDesk 用来继续持久任务的有限上下文。",
    contextLoading: "正在加载 Task Context…",
    contextRevision: "上下文版本",
    objective: "目标",
    currentState: "当前状态",
    latestOutcome: "最新结果",
    changedFiles: "已更改文件",
    recentRuns: "最近的 Run",
    noChanges: "没有报告已更改文件。",
    transferredContext: "如果不是直接延续同一个原生 Session，TaskDesk 会明确转移此上下文。这不是来自另一个 harness 的原生对话记忆。",
    fallbackHint: "此 daemon 尚未提供 Task Context。Continue 将使用兼容的纯提示流程。"
  }
}

export function taskDeskContinueCopy(language: LanguageCode): ContinueCopy {
  return copy[language]
}
