type TaskCopyKey =
  | "newTask"
  | "startTask"
  | "starting"
  | "subtitle"
  | "project"
  | "task"
  | "agent"
  | "machine"
  | "loading"
  | "promptPlaceholder"
  | "isolatedWorktree"
  | "nonGit"
  | "activeAgent"
  | "requiresDaemon"
  | "noProjects"
  | "agentUnavailable"

const copy: Record<string, Record<TaskCopyKey, string>> = {
  en: {
    newTask: "New Task",
    startTask: "Start Task",
    starting: "Starting…",
    subtitle: "Start agent work on {machine}.",
    project: "Project",
    task: "Task",
    agent: "Agent",
    machine: "Machine",
    loading: "Loading machine projects and agents…",
    promptPlaceholder: "Describe the work the agent should complete…",
    isolatedWorktree: "Use a new isolated Git worktree",
    nonGit: "This project is not a Git repository, so the task will run in the project directory.",
    activeAgent: "This task stays on the active agent profile so its launched session remains in the current session workflow.",
    requiresDaemon: "Task launch requires the Harness machine daemon.",
    noProjects: "This machine has no known projects. Configure a project root on the daemon before starting a task.",
    agentUnavailable: "The active agent {agent} is unavailable on this machine."
  },
  it: {
    newTask: "Nuovo task",
    startTask: "Avvia task",
    starting: "Avvio…",
    subtitle: "Avvia un lavoro con un agente su {machine}.",
    project: "Progetto",
    task: "Task",
    agent: "Agente",
    machine: "Macchina",
    loading: "Caricamento di progetti e agenti della macchina…",
    promptPlaceholder: "Descrivi il lavoro che l’agente deve completare…",
    isolatedWorktree: "Usa un nuovo worktree Git isolato",
    nonGit: "Questo progetto non è un repository Git, quindi il task verrà eseguito nella directory del progetto.",
    activeAgent: "Il task resta sull’agente attivo così la sessione avviata rimane nel flusso delle sessioni corrente.",
    requiresDaemon: "L’avvio dei task richiede il daemon Harness della macchina.",
    noProjects: "Questa macchina non ha progetti noti. Configura una root di progetto nel daemon prima di avviare un task.",
    agentUnavailable: "L’agente attivo {agent} non è disponibile su questa macchina."
  },
  "zh-TW": {
    newTask: "新增任務",
    startTask: "開始任務",
    starting: "正在啟動…",
    subtitle: "在 {machine} 上開始代理工作。",
    project: "專案",
    task: "任務",
    agent: "代理",
    machine: "機器",
    loading: "正在載入機器的專案與代理…",
    promptPlaceholder: "描述代理應完成的工作…",
    isolatedWorktree: "使用新的隔離 Git worktree",
    nonGit: "此專案不是 Git 儲存庫，因此任務將在專案目錄中執行。",
    activeAgent: "此任務會使用目前的代理設定檔，讓啟動的工作階段留在目前的工作流程中。",
    requiresDaemon: "啟動任務需要 Harness machine daemon。",
    noProjects: "此機器沒有已知專案。請先在 daemon 設定專案根目錄。",
    agentUnavailable: "目前的代理 {agent} 在此機器上不可用。"
  },
  "zh-CN": {
    newTask: "新建任务",
    startTask: "开始任务",
    starting: "正在启动…",
    subtitle: "在 {machine} 上启动代理工作。",
    project: "项目",
    task: "任务",
    agent: "代理",
    machine: "机器",
    loading: "正在加载机器的项目和代理…",
    promptPlaceholder: "描述代理应完成的工作…",
    isolatedWorktree: "使用新的隔离 Git worktree",
    nonGit: "此项目不是 Git 仓库，因此任务将在项目目录中运行。",
    activeAgent: "此任务会使用当前代理配置，使启动的会话保留在当前会话流程中。",
    requiresDaemon: "启动任务需要 Harness machine daemon。",
    noProjects: "此机器没有已知项目。请先在 daemon 中配置项目根目录。",
    agentUnavailable: "当前代理 {agent} 在此机器上不可用。"
  }
}

function locale(language: string): string {
  if (language === "zh-TW" || language === "zh-CN") return language
  if (language.toLowerCase().startsWith("it")) return "it"
  return "en"
}

export function taskCopy(language: string, key: TaskCopyKey, vars: Record<string, string> = {}): string {
  let value = copy[locale(language)]?.[key] ?? copy.en[key]
  for (const [name, replacement] of Object.entries(vars)) value = value.replace(`{${name}}`, replacement)
  return value
}
