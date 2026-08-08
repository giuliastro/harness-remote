export type LanguageCode = 'en' | 'it' | 'zh-TW' | 'zh-CN'

type TranslationKey =
  | 'app.title'
  | 'notification.title'
  | 'notification.body'
  | 'notification.overlayDescription'
  | 'app.jumpToTop'
  | 'app.jumpToBottom'
  | 'nav.settings'
  | 'nav.sessions'
  | 'nav.detail'
  | 'nav.help'
  | 'menu.title'
  | 'menu.settingsDescription'
  | 'menu.sessionsDescription'
  | 'menu.detailDescription'
  | 'menu.helpDescription'
  | 'settings.title'
  | 'settings.serverProfile'
  | 'settings.serverName'
  | 'settings.newServerName'
  | 'settings.addServer'
  | 'settings.deleteServer'
  | 'settings.deleteServerTitle'
  | 'settings.deleteLastServerHint'
  | 'settings.backend'
  | 'settings.host'
  | 'settings.hostPlaceholder'
  | 'settings.port'
  | 'settings.username'
  | 'settings.password'
  | 'settings.passwordPlaceholder'
  | 'settings.save'
  | 'settings.saving'
  | 'settings.test'
  | 'settings.testing'
  | 'settings.testingConnection'
  | 'settings.saved'
  | 'settings.connectedSaved'
  | 'settings.connectionFailed'
  | 'settings.connectedTo'
  | 'settings.language'
  | 'settings.theme'
  | 'settings.themeSystem'
  | 'settings.themeLight'
  | 'settings.themeDark'
  | 'settings.draftHint'
  | 'settings.testedNotSaved'
  | 'settings.savedButton'
  | 'settings.testOk'
  | 'settings.testNeedsFields'
  | 'settings.testAlreadyPassed'
  | 'settings.readyToTest'
  | 'settings.unsavedChanges'
  | 'settings.noUnsavedChanges'
  | 'connection.connecting'
  | 'connection.loadingSessions'
  | 'connection.refreshing'
  | 'connection.reconnecting'
  | 'connection.connected'
  | 'connection.offline'
  | 'events.live'
  | 'events.connecting'
  | 'events.reconnecting'
  | 'events.fallback'
  | 'events.unknownError'
  | 'sessions.loadingTitle'
  | 'sessions.loadingHint'
  | 'sessions.offlineHint'
  | 'sessions.retry'
  | 'sessions.title'
  | 'sessions.summary'
  | 'sessions.new'
  | 'sessions.creating'
  | 'sessions.refresh'
  | 'sessions.projectDirectoryLabel'
  | 'sessions.projectDirectoryPlaceholder'
  | 'sessions.projectDirectoryActive'
  | 'sessions.projectDirectoryDefault'
  | 'sessions.newSessionTitle'
  | 'sessions.remoteSessionTitle'
  | 'sessions.useServerDefault'
  | 'sessions.useThisFolder'
  | 'sessions.parentFolder'
  | 'sessions.folderPickerLoading'
  | 'sessions.folderPickerEmpty'
  | 'sessions.projectDirectoryInvalid'
  | 'sessions.searchPlaceholder'
  | 'sessions.emptyTitle'
  | 'sessions.emptyHint'
  | 'sessions.noFileChanges'
  | 'sessions.updated'
  | 'sessions.open'
  | 'sessions.delete'
  | 'detail.backToSessions'
  | 'detail.selectSession'
  | 'detail.loading'
  | 'detail.loadFailed'
  | 'detail.emptyTitle'
  | 'detail.emptyHint'

  | 'detail.composerPlaceholder'
  | 'detail.externalSession'
  | 'detail.waiting'
  | 'detail.copyText'
  | 'detail.copyMarkdown'
  | 'detail.undo'
  | 'detail.redo'
  | 'detail.sessionActions'
  | 'detail.nothingToUndo'
  | 'detail.nothingToRedo'
  | 'detail.revertToMessage'
  | 'detail.undoConfirm'
  | 'detail.revertConfirm'
  | 'detail.send'
  | 'detail.jumpToLatest'
  | 'detail.you'
  | 'detail.opencode'
  | 'detail.projectDashboardLabel'
  | 'detail.projectLabel'
  | 'detail.vcsLabel'
  | 'detail.loadingProject'
  | 'detail.unavailable'
  | 'detail.aheadBehind'
  | 'detail.fileStatusLabel'
  | 'detail.fileStatusSource'
  | 'detail.dashboardError'
  | 'detail.changedFilesTitle'
  | 'detail.changedFilesHint'
  | 'detail.filesCount'
  | 'detail.miniDiffAria'
  | 'detail.linesAddedDeleted'
  | 'detail.modelPanelLabel'
  | 'detail.aiTitle'
  | 'detail.refreshAi'
  | 'detail.agentTitle'
  | 'detail.agentSelectLabel'
  | 'detail.agentLoading'
  | 'detail.agentLoadError'
  | 'detail.agentMode'
  | 'detail.modelTitle'
  | 'detail.modelHint'
  | 'detail.refreshModels'
  | 'detail.modelSelectLabel'
  | 'detail.modelSearchPlaceholder'
  | 'detail.modelSearchEmpty'
  | 'detail.modelDefault'
  | 'detail.modelProvider'
  | 'detail.modelContext'
  | 'detail.modelToolsYes'
  | 'detail.modelToolsNo'
  | 'detail.modelVariant'
  | 'detail.modelLoading'
  | 'detail.modelNotSupported'
  | 'detail.modelUnavailable'
  | 'detail.modelLoadError'
  | 'detail.contextStripLabel'
  | 'detail.aiChip'
  | 'detail.filesChip'
  | 'detail.detailsChip'
  | 'detail.sessionDetailsTitle'
  | 'detail.sessionDetailsHint'
  | 'detail.closeSheet'
  | 'todo.title'
  | 'todo.hide'
  | 'todo.show'
  | 'session.deleteTitle'
  | 'session.deleteBodyPrefix'
  | 'session.cancel'
  | 'session.deleteConfirm'
  | 'session.renameTitle'
  | 'session.renamePlaceholder'
  | 'session.renameConfirm'
  | 'help.title'
  | 'help.overview'
  | 'help.server'
  | 'help.network'
  | 'help.troubleshooting'
  | 'help.commands'
  | 'menubar.file'
  | 'menubar.session'
  | 'menubar.view'
  | 'menubar.help'
  | 'command.newSession'
  | 'command.refreshSessions'
  | 'command.addServer'
  | 'command.openSettings'
  | 'command.focusComposer'
  | 'command.stopAgent'
  | 'command.commandPalette'
  | 'command.searchSessions'
  | 'command.toggleInspector'
  | 'command.openHelp'
  | 'command.groupSession'
  | 'command.groupServer'
  | 'command.groupView'
  | 'command.groupOpenSession'
  | 'command.switchTo'
  | 'command.manageServers'
  | 'command.palettePlaceholder'
  | 'command.paletteEmpty'
  | 'command.navigate'
  | 'command.run'
  | 'command.close'
  | 'connect.title'
  | 'connect.subtitle'
  | 'connect.step.harness'
  | 'connect.step.address'
  | 'connect.step.credentials'
  | 'connect.harness.opencode'
  | 'connect.harness.omp'
  | 'connect.harness.pi'
  | 'connect.harness.claude'
  | 'connect.harness.codex'
  | 'connect.addressHint'
  | 'connect.runOnHost'
  | 'connect.copyCommand'
  | 'connect.copied'
  | 'connect.credentialsHint'
  | 'connect.back'
  | 'connect.save'
  | 'connect.next'
  | 'sessions.recentProjects'
  | 'sessions.browseFolders'
  | 'sessions.typePathLabel'
  | 'sessions.typePathPlaceholder'
  | 'sessions.goToPath'
  | 'action.close'
  | 'action.thinking'
  | 'action.thoughtFor'
  | 'action.durationSeconds'
  | 'action.durationMinutes'
  | 'action.readFile'
  | 'action.readFileNamed'
  | 'action.wroteFile'
  | 'action.wroteFileNamed'
  | 'action.editedFile'
  | 'action.editedFileNamed'
  | 'action.ranCommand'
  | 'action.ranCommandNamed'
  | 'action.searchedFiles'
  | 'action.searchedFilesFor'
  | 'action.searchedCode'
  | 'action.searchedCodeFor'
  | 'action.fetchedUrl'
  | 'action.fetchedUrlNamed'
  | 'action.updatedTodos'
  | 'action.todoSummary'
  | 'action.askedQuestion'
  | 'action.askedQuestionNamed'
  | 'action.askedQuestions'
  | 'action.ranSubagent'
  | 'action.ranSubagentNamed'
  | 'action.usedSkill'
  | 'action.usedSkillNamed'
  | 'action.toolFailed'
  | 'action.running'
  | 'action.preparingTool'
  | 'action.showDiffFor'
  | 'action.actionsFallback'
  | 'action.countReadOne'
  | 'action.countReadMany'
  | 'action.countWriteOne'
  | 'action.countWriteMany'
  | 'action.countEditOne'
  | 'action.countEditMany'
  | 'action.countSearchOne'
  | 'action.countSearchMany'
  | 'action.countBashOne'
  | 'action.countBashMany'
  | 'action.countWebfetchOne'
  | 'action.countWebfetchMany'
  | 'action.countTaskOne'
  | 'action.countTaskMany'
  | 'action.countSkillOne'
  | 'action.countSkillMany'
  | 'action.countOtherOne'
  | 'action.countOtherMany'
  | 'action.countTodoOne'
  | 'action.countTodoMany'
  | 'action.countQuestionOne'
  | 'action.countQuestionMany'
  | 'action.madeEditOne'
  | 'action.madeEditMany'
  | 'question.ariaLabel'
  | 'question.otherPlaceholder'
  | 'question.skip'
  | 'question.sendAnswer'
  | 'permission.ariaLabel'
  | 'permission.requested'
  | 'permission.allowOnce'
  | 'permission.allowAlways'
  | 'permission.deny'

const translations: Record<LanguageCode, Partial<Record<TranslationKey, string>>> = {
  en: {
    'app.title': 'Harness Remote',
    'notification.title': 'Harness Remote',
    'notification.body': 'Agent completed a task',
    'notification.overlayDescription': 'Agent completed a task',
    'app.jumpToTop': 'Jump to top',
    'app.jumpToBottom': 'Jump to bottom',
    'nav.settings': 'Settings',
    'nav.sessions': 'Sessions',
    'nav.detail': 'Detail',
    'nav.help': 'Help',
    'menu.title': 'Menu',
    'menu.settingsDescription': 'Configure server connection',
    'menu.sessionsDescription': 'Manage your sessions',
    'menu.detailDescription': 'Chat with your selected backend',
    'menu.helpDescription': 'Documentation & support',
    'settings.title': 'Server Configuration',
    'settings.serverProfile': 'Saved server',
    'settings.serverName': 'Server name',
    'settings.newServerName': 'New server',
    'settings.addServer': 'Add server',
    'settings.deleteServer': 'Delete server',
    'settings.deleteServerTitle': 'Delete saved server?',
    'settings.deleteLastServerHint': 'Keep at least one server configuration.',
    'settings.backend': 'Backend',
    'settings.host': 'Host Address',
    'settings.hostPlaceholder': '192.168.1.100, localhost, or https://example.com',
    'settings.port': 'Port',
    'settings.username': 'Username',
    'settings.password': 'Password',
    'settings.passwordPlaceholder': 'Optional; leave blank for unsecured local server',
    'settings.save': 'Save Configuration',
    'settings.saving': 'Saving...',
    'settings.test': 'Test Connection',
    'settings.testing': 'Testing...',
    'settings.testingConnection': 'Testing connection...',
    'settings.saved': 'Changes saved automatically.',
    'settings.connectedSaved': 'Connected to selected backend {version}. Settings are saved automatically.',
    'settings.draftHint': 'Changes are saved automatically after you pause typing.',
    'settings.testedNotSaved': 'Connection OK: selected backend {version}. Nothing was saved yet.',
    'settings.savedButton': 'Saved',
    'settings.testOk': 'Test OK',
    'settings.testNeedsFields': 'Enter host, port, and username to test.',
    'settings.testAlreadyPassed': 'This draft already passed the connection test.',
    'settings.readyToTest': 'Ready to test these fields.',
    'settings.unsavedChanges': 'Changes will be saved automatically.',
    'settings.noUnsavedChanges': 'Settings are up to date.',
    'connection.connecting': 'Connecting to backend...',
    'connection.loadingSessions': 'Connecting and loading sessions...',
    'connection.refreshing': 'Refreshing sessions...',
    'connection.reconnecting': 'Connection is slow; retrying quietly...',
    'connection.connected': 'Connected',
    'connection.offline': 'Backend is not reachable',
    'events.live': 'Live updates on ({count} events)',
    'events.connecting': 'Starting live updates…',
    'events.reconnecting': 'Live updates reconnecting…',
    'events.fallback': 'Live updates unavailable; using refresh ({error})',
    'events.unknownError': 'unknown error',
    'settings.connectionFailed': 'Connection failed: {message}',
    'settings.connectedTo': 'Connected to selected backend {version}',
    'settings.language': 'Language',
    'settings.theme': 'Theme',
    'settings.themeSystem': 'System',
    'settings.themeLight': 'Light',
    'settings.themeDark': 'Dark',
    'sessions.title': 'Sessions',
    'sessions.summary': '{total} total · {active} active · {changed} changed',
    'sessions.new': 'New Session',
    'sessions.creating': 'Creating...',
    'sessions.refresh': 'Refresh',
    'sessions.projectDirectoryLabel': 'Selected folder',
    'sessions.projectDirectoryPlaceholder': '/home/you/project or C:\\Projects\\App',
    'sessions.projectDirectoryActive': 'New sessions use {directory}.',
    'sessions.projectDirectoryDefault': 'Choose the folder for this new session, or use the server default directory.',
    'sessions.newSessionTitle': 'New session folder',
    'sessions.remoteSessionTitle': 'Remote session',
    'sessions.useServerDefault': 'Use server default',
    'sessions.useThisFolder': 'Create here',
    'sessions.parentFolder': 'Parent folder',
    'sessions.folderPickerLoading': 'Loading folders...',
    'sessions.folderPickerEmpty': 'No folders here.',
    'sessions.projectDirectoryInvalid': '{directory} is not a backend project folder. Pick a project/worktree folder, or use the server default.',
    'sessions.searchPlaceholder': 'Search sessions by title or directory...',
    'sessions.emptyTitle': 'No sessions found',
    'sessions.emptyHint': 'Create a new session to get started',
    'sessions.loadingTitle': 'Connecting to backend',
    'sessions.loadingHint': 'Loading sessions. This can take a few seconds on mobile or after the server wakes up.',
    'sessions.offlineHint': 'The server did not answer. It may be asleep, off, or on another network.',
    'sessions.retry': 'Try again',
    'sessions.noFileChanges': 'No file changes',
    'sessions.updated': 'Updated {time}',
    'sessions.open': 'Open',
    'sessions.delete': 'Delete',
    'detail.backToSessions': '← Sessions',
    'detail.selectSession': 'Select a session',
    'detail.loading': 'Loading session...',
    'detail.loadFailed': 'This session could not be opened',
    'detail.emptyTitle': 'No messages yet',
    'detail.emptyHint': 'Start a conversation below',
    'detail.composerPlaceholder': 'Prompt, or / for commands',
    'detail.externalSession': 'Started by another client',
    'detail.waiting': 'Waiting...',
    'detail.copyText': 'Copy text',
    'detail.copyMarkdown': 'Copy as markdown',
    'detail.undo': 'Undo last turn',
    'detail.redo': 'Redo last undone turn',
    'detail.sessionActions': 'Session actions',
    'detail.nothingToUndo': 'Nothing to undo in this session.',
    'detail.nothingToRedo': 'Nothing to redo in this session.',
    'detail.revertToMessage': 'Revert to this message',
    'detail.undoConfirm': 'Undo the last turn and restore its file changes?',
    'detail.revertConfirm': 'Revert the conversation and file changes to this message?',
    'detail.send': 'Send',
    'detail.jumpToLatest': 'Go to latest',
    'detail.you': '👤 You',
    'detail.opencode': '🤖 OpenCode',
    'detail.projectDashboardLabel': 'Project and VCS dashboard',
    'detail.projectLabel': 'Project',
    'detail.vcsLabel': 'VCS',
    'detail.loadingProject': 'Loading...',
    'detail.unavailable': 'Unavailable',
    'detail.aheadBehind': '{ahead} ahead · {behind} behind',
    'detail.fileStatusLabel': 'Changed files',
    'detail.fileStatusSource': 'From /file/status',
    'detail.dashboardError': 'Error: {message}',
    'detail.changedFilesTitle': 'Changed files',
    'detail.changedFilesHint': 'Tap a file to see the mini diff.',
    'detail.filesCount': '{count} files',
    'detail.miniDiffAria': 'Changed files mini diff',
    'detail.linesAddedDeleted': '+{additions} lines · -{deletions} lines',
    'detail.modelPanelLabel': 'AI model picker',
    'detail.aiTitle': 'AI agent and model',
    'detail.refreshAi': 'Refresh AI options',
    'detail.agentTitle': 'Agent',
    'detail.agentSelectLabel': 'Agent for next prompt',
    'detail.agentLoading': 'Loading configured agents...',
    'detail.agentLoadError': 'Cannot load agents: {message}',
    'detail.agentMode': 'Mode: {mode}',
    'detail.modelTitle': 'AI model',
    'detail.modelHint': 'Applies to the next prompt and to new sessions. Current running replies keep their original model.',
    'detail.refreshModels': 'Refresh models',
    'detail.modelSelectLabel': 'Model for next prompt',
    'detail.modelSearchPlaceholder': 'Search models by name or provider...',
    'detail.modelSearchEmpty': 'No models match your search.',
    'detail.modelDefault': 'default',
    'detail.modelProvider': 'Provider: {provider}',
    'detail.modelContext': 'Context {context} · output {output}',
    'detail.modelToolsYes': 'Tools enabled',
    'detail.modelToolsNo': 'No tools',
    'detail.modelVariant': 'Variant: {variant}',
    'detail.modelLoading': 'Loading configured models...',
    'detail.modelNotSupported': 'This harness does not expose model selection',
    'detail.modelUnavailable': 'Models unavailable — check the server',
    'detail.modelLoadError': 'Cannot load models: {message}',
    'detail.contextStripLabel': 'Session context shortcuts',
    'detail.aiChip': 'AI',
    'detail.filesChip': 'Files',
    'detail.detailsChip': 'Details',
    'detail.sessionDetailsTitle': 'Session details',
    'detail.sessionDetailsHint': 'Advanced project, VCS, file and model information.',
    'detail.closeSheet': 'Close',
    'todo.title': 'Todo Items',
    'todo.hide': 'Hide',
    'todo.show': 'Show',
    'session.deleteTitle': 'Delete session?',
    'session.deleteBodyPrefix': 'This will permanently delete',
    'session.cancel': 'Cancel',
    'session.deleteConfirm': 'Delete session',
    'session.renameTitle': 'Rename session',
    'session.renamePlaceholder': 'Enter new name...',
    'session.renameConfirm': 'Rename',
    'help.title': 'Help & Documentation',
    'help.overview': 'Overview',
    'help.server': 'Server',
    'help.network': 'Network',
    'help.troubleshooting': 'Troubleshooting',
    'help.commands': 'Commands',
    'action.close': 'Close',
    'action.thinking': 'Thinking',
    'action.thoughtFor': 'Thought for {duration}',
    'action.durationSeconds': '{n}s',
    'action.durationMinutes': '{n}m',
    'action.readFile': 'Read file',
    'action.readFileNamed': 'Read {file}',
    'action.wroteFile': 'Wrote file',
    'action.wroteFileNamed': 'Wrote {file}',
    'action.editedFile': 'Edited file',
    'action.editedFileNamed': 'Edited {file}',
    'action.ranCommand': 'Ran command',
    'action.ranCommandNamed': 'Ran {command}',
    'action.searchedFiles': 'Searched files',
    'action.searchedFilesFor': 'Searched files for "{pattern}"',
    'action.searchedCode': 'Searched code',
    'action.searchedCodeFor': 'Searched for "{pattern}"',
    'action.fetchedUrl': 'Fetched a URL',
    'action.fetchedUrlNamed': 'Fetched {url}',
    'action.updatedTodos': 'Updated the to-do list',
    'action.todoSummary': '{done}/{total} to-dos done',
    'action.askedQuestion': 'Asked a question',
    'action.askedQuestionNamed': 'Asked: {question}',
    'action.askedQuestions': 'Asked {n} questions',
    'action.ranSubagent': 'Ran a subagent',
    'action.ranSubagentNamed': 'Ran subagent: {description}',
    'action.usedSkill': 'Used a skill',
    'action.usedSkillNamed': 'Used skill: {name}',
    'action.toolFailed': 'Tool failed',
    'action.running': 'Running…',
    'action.preparingTool': 'Preparing {tool}',
    'action.showDiffFor': 'Show diff for {file}',
    'action.actionsFallback': 'Actions',
    'action.countReadOne': 'read 1 file',
    'action.countReadMany': 'read {n} files',
    'action.countWriteOne': 'wrote 1 file',
    'action.countWriteMany': 'wrote {n} files',
    'action.countEditOne': 'edited 1 file',
    'action.countEditMany': 'edited {n} files',
    'action.countSearchOne': 'searched 1 time',
    'action.countSearchMany': 'searched {n} times',
    'action.countBashOne': 'ran 1 command',
    'action.countBashMany': 'ran {n} commands',
    'action.countWebfetchOne': 'fetched 1 URL',
    'action.countWebfetchMany': 'fetched {n} URLs',
    'action.countTaskOne': 'ran 1 subagent',
    'action.countTaskMany': 'ran {n} subagents',
    'action.countSkillOne': 'used 1 skill',
    'action.countSkillMany': 'used {n} skills',
    'action.countOtherOne': 'ran 1 tool',
    'action.countOtherMany': 'ran {n} tools',
    'action.countTodoOne': 'updated the to-do list',
    'action.countTodoMany': 'updated the to-do list {n} times',
    'action.countQuestionOne': 'asked 1 question',
    'action.countQuestionMany': 'asked {n} questions',
    'action.madeEditOne': 'made 1 edit',
    'action.madeEditMany': 'made {n} edits',
    'question.ariaLabel': 'Question from OpenCode',
    'question.otherPlaceholder': 'Other…',
    'question.skip': 'Skip',
    'question.sendAnswer': 'Send answer',
    'permission.ariaLabel': 'Permission request from OpenCode',
    'permission.requested': 'Permission requested: {permission}',
    'permission.allowOnce': 'Allow once',
    'permission.allowAlways': 'Always allow',
    'permission.deny': 'Deny',
    'menubar.file': 'File',
    'menubar.session': 'Session',
    'menubar.view': 'View',
    'menubar.help': 'Help',
    'command.newSession': 'New session',
    'command.refreshSessions': 'Refresh sessions',
    'command.addServer': 'Connect server',
    'command.openSettings': 'Open settings',
    'command.focusComposer': 'Focus prompt',
    'command.stopAgent': 'Stop agent',
    'command.commandPalette': 'Commands',
    'command.searchSessions': 'Search sessions',
    'command.toggleInspector': 'Toggle inspector',
    'command.openHelp': 'Open help',
    'command.groupSession': 'Session',
    'command.groupServer': 'Servers',
    'command.groupView': 'View',
    'command.groupOpenSession': 'Open session',
    'command.switchTo': 'Switch to {name}',
    'command.manageServers': 'Manage servers',
    'command.palettePlaceholder': 'Search commands and sessions…',
    'command.paletteEmpty': 'No matching commands',
    'command.navigate': 'navigate',
    'command.run': 'run',
    'command.close': 'close',
    'connect.title': 'Connect a server',
    'connect.subtitle': 'Choose a harness, enter its address, then verify the connection.',
    'connect.step.harness': 'Harness',
    'connect.step.address': 'Address',
    'connect.step.credentials': 'Credentials',
    'connect.harness.opencode': 'Connect directly to an OpenCode server.',
    'connect.harness.omp': 'Connect through the bundled Oh My Pi bridge.',
    'connect.harness.pi': 'Connect to PI through the ACP bridge.',
    'connect.harness.claude': 'Connect to Claude Code through the ACP bridge.',
    'connect.harness.codex': 'Connect to Codex CLI through the ACP bridge.',
    'connect.addressHint': 'Use the LAN address of the machine that runs the harness.',
    'connect.runOnHost': 'Run on the host machine',
    'connect.copyCommand': 'Copy command',
    'connect.copied': 'Copied',
    'connect.credentialsHint': 'These credentials must match the command running on the host.',
    'connect.back': 'Back',
    'connect.save': 'Save and connect',
    'connect.next': 'Continue',
    'sessions.recentProjects': 'Recent projects',
    'sessions.browseFolders': 'Browse folders',
    'sessions.typePathLabel': 'Open a path',
    'sessions.typePathPlaceholder': '/home/you/project or C:\\Projects\\App',
    'sessions.goToPath': 'Go'
  },
  it: {
    'app.title': 'Harness Remote',
    'notification.title': 'Harness Remote',
    'notification.body': 'Agente ha completato un’attività',
    'notification.overlayDescription': 'Attività agente completata',
    'app.jumpToTop': 'Vai in alto',
    'app.jumpToBottom': 'Vai in basso',
    'nav.settings': 'Impostazioni',
    'nav.sessions': 'Sessioni',
    'nav.detail': 'Dettaglio',
    'nav.help': 'Aiuto',
    'menu.title': 'Menu',
    'menu.settingsDescription': 'Configura connessione server',
    'menu.sessionsDescription': 'Gestisci le sessioni',
    'menu.detailDescription': 'Chatta con il backend selezionato',
    'menu.helpDescription': 'Documentazione e supporto',
    'settings.title': 'Configurazione server',
    'settings.serverProfile': 'Server salvato',
    'settings.serverName': 'Nome server',
    'settings.newServerName': 'Nuovo server',
    'settings.addServer': 'Aggiungi server',
    'settings.deleteServer': 'Elimina server',
    'settings.deleteServerTitle': 'Eliminare il server salvato?',
    'settings.deleteLastServerHint': 'Mantieni almeno una configurazione server.',
    'settings.backend': 'Backend',
    'settings.host': 'Indirizzo host',
    'settings.hostPlaceholder': '192.168.1.100, localhost o https://example.com',
    'settings.port': 'Porta',
    'settings.username': 'Username',
    'settings.password': 'Password',
    'settings.passwordPlaceholder': 'Opzionale; lascia vuoto per server locale non protetto',
    'settings.save': 'Salva configurazione',
    'settings.saving': 'Salvataggio...',
    'settings.test': 'Test connessione',
    'settings.testing': 'Test...',
    'settings.testingConnection': 'Test connessione...',
    'settings.saved': 'Modifiche salvate automaticamente.',
    'settings.connectedSaved': 'Connesso al backend selezionato {version}. Le impostazioni sono salvate automaticamente.',
    'settings.draftHint': 'Le modifiche vengono salvate automaticamente quando smetti di digitare.',
    'settings.testedNotSaved': 'Connessione OK: backend selezionato {version}. Non è stato ancora salvato nulla.',
    'settings.savedButton': 'Salvato',
    'settings.testOk': 'Test OK',
    'settings.testNeedsFields': 'Inserisci host, porta e username per fare il test.',
    'settings.testAlreadyPassed': 'Questa bozza ha già superato il test connessione.',
    'settings.readyToTest': 'Campi pronti per il test.',
    'settings.unsavedChanges': 'Le modifiche saranno salvate automaticamente.',
    'settings.noUnsavedChanges': 'Impostazioni aggiornate.',
    'connection.connecting': 'Connessione al backend...',
    'connection.loadingSessions': 'Connessione e caricamento sessioni...',
    'connection.refreshing': 'Aggiornamento sessioni...',
    'connection.reconnecting': 'Connessione lenta; riprovo in silenzio...',
    'connection.connected': 'Connesso',
    'connection.offline': 'Backend non raggiungibile',
    'events.live': 'Aggiornamenti live attivi ({count} eventi)',
    'events.connecting': 'Avvio aggiornamenti live…',
    'events.reconnecting': 'Riconnessione aggiornamenti live…',
    'events.fallback': 'Aggiornamenti live non disponibili; uso il refresh ({error})',
    'events.unknownError': 'errore sconosciuto',
    'settings.connectionFailed': 'Connessione fallita: {message}',
    'settings.connectedTo': 'Connesso al backend selezionato {version}',
    'settings.language': 'Lingua',
    'settings.theme': 'Tema',
    'settings.themeSystem': 'Sistema',
    'settings.themeLight': 'Chiaro',
    'settings.themeDark': 'Scuro',
    'sessions.title': 'Sessioni',
    'sessions.summary': '{total} totali · {active} attive · {changed} con modifiche',
    'sessions.new': 'Nuova sessione',
    'sessions.creating': 'Creazione...',
    'sessions.refresh': 'Aggiorna',
    'sessions.projectDirectoryLabel': 'Cartella selezionata',
    'sessions.projectDirectoryPlaceholder': '/home/utente/progetto o C:\\Projects\\App',
    'sessions.projectDirectoryActive': 'La nuova sessione userà {directory}.',
    'sessions.projectDirectoryDefault': 'Scegli la cartella per questa nuova sessione, oppure usa la directory predefinita del server.',
    'sessions.newSessionTitle': 'Cartella nuova sessione',
    'sessions.remoteSessionTitle': 'Sessione remota',
    'sessions.useServerDefault': 'Usa default server',
    'sessions.useThisFolder': 'Crea qui',
    'sessions.parentFolder': 'Cartella superiore',
    'sessions.folderPickerLoading': 'Caricamento cartelle...',
    'sessions.folderPickerEmpty': 'Nessuna cartella qui.',
    'sessions.projectDirectoryInvalid': '{directory} non è una cartella progetto del backend. Scegli una cartella progetto/worktree oppure usa il default del server.',
    'sessions.searchPlaceholder': 'Cerca sessioni per titolo o cartella...',
    'sessions.emptyTitle': 'Nessuna sessione trovata',
    'sessions.emptyHint': 'Crea una nuova sessione per iniziare',
    'sessions.loadingTitle': 'Connessione al backend',
    'sessions.loadingHint': 'Carico le sessioni. Su mobile o dopo il risveglio del server può volerci qualche secondo.',
    'sessions.offlineHint': "Il server non ha risposto. Può essere spento, in standby o su un'altra rete.",
    'sessions.retry': 'Riprova',
    'sessions.noFileChanges': 'Nessuna modifica ai file',
    'sessions.updated': 'Aggiornata {time}',
    'sessions.open': 'Apri',
    'sessions.delete': 'Elimina',
    'detail.backToSessions': '← Sessioni',
    'detail.selectSession': 'Seleziona una sessione',
    'detail.loading': 'Caricamento sessione...',
    'detail.loadFailed': 'Impossibile aprire questa sessione',
    'detail.emptyTitle': 'Ancora nessun messaggio',
    'detail.emptyHint': 'Inizia una conversazione qui sotto',
    'detail.composerPlaceholder': 'Prompt, o / per i comandi',
    'detail.externalSession': 'Avviata da un altro client',
    'detail.waiting': 'Attesa...',
    'detail.copyText': 'Copia testo',
    'detail.copyMarkdown': 'Copia come Markdown',
    'detail.undo': 'Annulla ultimo turno',
    'detail.redo': 'Ripristina ultimo turno annullato',
    'detail.sessionActions': 'Azioni sessione',
    'detail.nothingToUndo': 'Non c’è nulla da annullare in questa sessione.',
    'detail.nothingToRedo': 'Non c’è nulla da ripristinare in questa sessione.',
    'detail.revertToMessage': 'Ripristina fino a questo messaggio',
    'detail.undoConfirm': 'Annullare l’ultimo turno e ripristinare le sue modifiche ai file?',
    'detail.revertConfirm': 'Ripristinare conversazione e modifiche ai file fino a questo messaggio?',
    'detail.send': 'Invia',
    'detail.jumpToLatest': 'Vai alla fine',
    'detail.you': '👤 Tu',
    'detail.opencode': '🤖 OpenCode',
    'detail.projectDashboardLabel': 'Dashboard progetto e VCS',
    'detail.projectLabel': 'Progetto',
    'detail.vcsLabel': 'VCS',
    'detail.loadingProject': 'Caricamento...',
    'detail.unavailable': 'Non disponibile',
    'detail.aheadBehind': '{ahead} avanti · {behind} indietro',
    'detail.fileStatusLabel': 'File modificati',
    'detail.fileStatusSource': 'Da /file/status',
    'detail.dashboardError': 'Errore: {message}',
    'detail.changedFilesTitle': 'File modificati',
    'detail.changedFilesHint': 'Tocca un file per vedere il mini diff.',
    'detail.filesCount': '{count} file',
    'detail.miniDiffAria': 'Mini diff dei file modificati',
    'detail.linesAddedDeleted': '+{additions} righe · -{deletions} righe',
    'detail.modelPanelLabel': 'Selettore modello AI',
    'detail.aiTitle': 'Agente e modello AI',
    'detail.refreshAi': 'Aggiorna opzioni AI',
    'detail.agentTitle': 'Agente',
    'detail.agentSelectLabel': 'Agente per il prossimo prompt',
    'detail.agentLoading': 'Caricamento agenti configurati...',
    'detail.agentLoadError': 'Impossibile caricare gli agenti: {message}',
    'detail.agentMode': 'Modalità: {mode}',
    'detail.modelTitle': 'Modello AI',
    'detail.modelHint': 'Si applica al prossimo prompt e alle nuove sessioni. Le risposte già in corso restano sul modello originale.',
    'detail.refreshModels': 'Aggiorna modelli',
    'detail.modelSelectLabel': 'Modello per il prossimo prompt',
    'detail.modelSearchPlaceholder': 'Cerca modelli per nome o provider...',
    'detail.modelSearchEmpty': 'Nessun modello corrisponde alla ricerca.',
    'detail.modelDefault': 'default',
    'detail.modelProvider': 'Provider: {provider}',
    'detail.modelContext': 'Contesto {context} · output {output}',
    'detail.modelToolsYes': 'Tool abilitati',
    'detail.modelToolsNo': 'Nessun tool',
    'detail.modelVariant': 'Variante: {variant}',
    'detail.modelLoading': 'Caricamento modelli configurati...',
    'detail.modelNotSupported': 'Questo harness non espone la scelta del modello',
    'detail.modelUnavailable': 'Modelli non disponibili — controlla il server',
    'detail.modelLoadError': 'Impossibile caricare i modelli: {message}',
    'detail.contextStripLabel': 'Scorciatoie contesto sessione',
    'detail.aiChip': 'AI',
    'detail.filesChip': 'File',
    'detail.detailsChip': 'Dettagli',
    'detail.sessionDetailsTitle': 'Dettagli sessione',
    'detail.sessionDetailsHint': 'Informazioni avanzate su progetto, VCS, file e modello.',
    'detail.closeSheet': 'Chiudi',
    'todo.title': 'Todo',
    'todo.hide': 'Nascondi',
    'todo.show': 'Mostra',
    'session.deleteTitle': 'Eliminare la sessione?',
    'session.deleteBodyPrefix': 'Questo eliminerà definitivamente',
    'session.cancel': 'Annulla',
    'session.deleteConfirm': 'Elimina sessione',
    'session.renameTitle': 'Rinomina sessione',
    'session.renamePlaceholder': 'Inserisci nuovo nome...',
    'session.renameConfirm': 'Rinomina',
    'help.title': 'Aiuto e documentazione',
    'help.overview': 'Panoramica',
    'help.server': 'Server',
    'help.network': 'Rete',
    'help.troubleshooting': 'Risoluzione problemi',
    'help.commands': 'Comandi',
    'action.close': 'Chiudi',
    'action.thinking': 'Sto pensando',
    'action.thoughtFor': 'Pensato per {duration}',
    'action.durationSeconds': '{n}s',
    'action.durationMinutes': '{n}m',
    'action.readFile': 'File letto',
    'action.readFileNamed': 'Letto {file}',
    'action.wroteFile': 'File scritto',
    'action.wroteFileNamed': 'Scritto {file}',
    'action.editedFile': 'File modificato',
    'action.editedFileNamed': 'Modificato {file}',
    'action.ranCommand': 'Comando eseguito',
    'action.ranCommandNamed': 'Eseguito {command}',
    'action.searchedFiles': 'File cercati',
    'action.searchedFilesFor': 'File cercati per "{pattern}"',
    'action.searchedCode': 'Codice cercato',
    'action.searchedCodeFor': 'Cercato "{pattern}"',
    'action.fetchedUrl': 'URL recuperato',
    'action.fetchedUrlNamed': 'Recuperato {url}',
    'action.updatedTodos': 'Elenco to-do aggiornato',
    'action.todoSummary': '{done}/{total} to-do completati',
    'action.askedQuestion': 'Posta una domanda',
    'action.askedQuestionNamed': 'Chiesto: {question}',
    'action.askedQuestions': 'Poste {n} domande',
    'action.ranSubagent': 'Subagente eseguito',
    'action.ranSubagentNamed': 'Eseguito subagente: {description}',
    'action.usedSkill': 'Skill usata',
    'action.usedSkillNamed': 'Usata skill: {name}',
    'action.toolFailed': 'Tool fallito',
    'action.running': 'In esecuzione…',
    'action.preparingTool': 'Preparazione di {tool}',
    'action.showDiffFor': 'Mostra diff per {file}',
    'action.actionsFallback': 'Azioni',
    'action.countReadOne': 'letto 1 file',
    'action.countReadMany': 'letti {n} file',
    'action.countWriteOne': 'scritto 1 file',
    'action.countWriteMany': 'scritti {n} file',
    'action.countEditOne': 'modificato 1 file',
    'action.countEditMany': 'modificati {n} file',
    'action.countSearchOne': 'cercato 1 volta',
    'action.countSearchMany': 'cercato {n} volte',
    'action.countBashOne': 'eseguito 1 comando',
    'action.countBashMany': 'eseguiti {n} comandi',
    'action.countWebfetchOne': 'recuperato 1 URL',
    'action.countWebfetchMany': 'recuperati {n} URL',
    'action.countTaskOne': 'eseguito 1 subagente',
    'action.countTaskMany': 'eseguiti {n} subagenti',
    'action.countSkillOne': 'usata 1 skill',
    'action.countSkillMany': 'usate {n} skill',
    'action.countOtherOne': 'eseguito 1 tool',
    'action.countOtherMany': 'eseguiti {n} tool',
    'action.countTodoOne': 'aggiornato l\'elenco to-do',
    'action.countTodoMany': 'aggiornato l\'elenco to-do {n} volte',
    'action.countQuestionOne': 'posta 1 domanda',
    'action.countQuestionMany': 'poste {n} domande',
    'action.madeEditOne': 'fatta 1 modifica',
    'action.madeEditMany': 'fatte {n} modifiche',
    'question.ariaLabel': 'Domanda da OpenCode',
    'question.otherPlaceholder': 'Altro…',
    'question.skip': 'Salta',
    'question.sendAnswer': 'Invia risposta',
    'permission.ariaLabel': 'Richiesta permesso da OpenCode',
    'permission.requested': 'Permesso richiesto: {permission}',
    'permission.allowOnce': 'Consenti una volta',
    'permission.allowAlways': 'Consenti sempre',
    'permission.deny': 'Nega',
    'menubar.file': 'File',
    'menubar.session': 'Sessione',
    'menubar.view': 'Vista',
    'menubar.help': 'Aiuto',
    'command.newSession': 'Nuova sessione',
    'command.refreshSessions': 'Aggiorna sessioni',
    'command.addServer': 'Connetti server',
    'command.openSettings': 'Apri impostazioni',
    'command.focusComposer': 'Vai al prompt',
    'command.stopAgent': 'Interrompi agente',
    'command.commandPalette': 'Comandi',
    'command.searchSessions': 'Cerca sessioni',
    'command.toggleInspector': 'Mostra o nascondi inspector',
    'command.openHelp': 'Apri aiuto',
    'command.groupSession': 'Sessione',
    'command.groupServer': 'Server',
    'command.groupView': 'Vista',
    'command.groupOpenSession': 'Apri sessione',
    'command.switchTo': 'Passa a {name}',
    'command.manageServers': 'Gestisci server',
    'command.palettePlaceholder': 'Cerca comandi e sessioni…',
    'command.paletteEmpty': 'Nessun comando corrispondente',
    'command.navigate': 'naviga',
    'command.run': 'esegui',
    'command.close': 'chiudi',
    'connect.title': 'Connetti un server',
    'connect.subtitle': 'Scegli un harness, inserisci l’indirizzo e verifica la connessione.',
    'connect.step.harness': 'Harness',
    'connect.step.address': 'Indirizzo',
    'connect.step.credentials': 'Credenziali',
    'connect.harness.opencode': 'Connessione diretta a un server OpenCode.',
    'connect.harness.omp': 'Connessione tramite il bridge incluso per Oh My Pi.',
    'connect.harness.pi': 'Connessione a PI tramite bridge ACP.',
    'connect.harness.claude': 'Connessione a Claude Code tramite bridge ACP.',
    'connect.harness.codex': 'Connessione a Codex CLI tramite bridge ACP.',
    'connect.addressHint': 'Usa l’indirizzo LAN del computer che esegue l’harness.',
    'connect.runOnHost': 'Esegui sul computer host',
    'connect.copyCommand': 'Copia comando',
    'connect.copied': 'Copiato',
    'connect.credentialsHint': 'Le credenziali devono coincidere con il comando in esecuzione sull’host.',
    'connect.back': 'Indietro',
    'connect.save': 'Salva e connetti',
    'connect.next': 'Continua',
    'sessions.recentProjects': 'Progetti recenti',
    'sessions.browseFolders': 'Sfoglia cartelle',
    'sessions.typePathLabel': 'Apri un percorso',
    'sessions.typePathPlaceholder': '/home/utente/progetto o C:\\Progetti\\App',
    'sessions.goToPath': 'Vai'
  },
  'zh-TW': {
    'app.title': 'Harness Remote',
    'app.jumpToTop': '跳到頂部',
    'app.jumpToBottom': '跳到底部',
    'nav.settings': '設定',
    'notification.title': 'Harness Remote',
    'notification.body': '代理程式已完成工作',
    'notification.overlayDescription': '代理程式工作已完成',
    'nav.sessions': '工作階段',
    'nav.detail': '詳情',
    'nav.help': '說明',
    'menu.title': '選單',
    'menu.settingsDescription': '設定伺服器連線',
    'menu.sessionsDescription': '管理工作階段',
    'menu.detailDescription': '與已選後端對話',
    'menu.helpDescription': '文件與支援',
    'settings.title': '伺服器設定',
    'settings.serverProfile': '已儲存的伺服器',
    'settings.serverName': '伺服器名稱',
    'settings.newServerName': '新伺服器',
    'settings.addServer': '新增伺服器',
    'settings.deleteServer': '刪除伺服器',
    'settings.deleteServerTitle': '刪除已儲存的伺服器？',
    'settings.deleteLastServerHint': '請至少保留一個伺服器設定。',
    'settings.backend': '後端',
    'settings.host': '主機位址',
    'settings.hostPlaceholder': '192.168.1.100、localhost 或 https://example.com',
    'settings.port': '連接埠',
    'settings.username': '使用者名稱',
    'settings.password': '密碼',
    'settings.passwordPlaceholder': '選填；未受保護的本機伺服器可留空',
    'settings.save': '儲存設定',
    'settings.saving': '儲存中...',
    'settings.test': '測試連線',
    'settings.testing': '測試中...',
    'settings.testingConnection': '正在測試連線...',
    'settings.saved': '變更已自動儲存。',
    'settings.connectedSaved': '已連線至所選後端 {version}。設定已自動儲存。',
    'settings.draftHint': '停止輸入後，變更會自動儲存。',
    'settings.testedNotSaved': '連線正常：所選後端 {version}。尚未儲存任何變更。',
    'settings.savedButton': '已儲存',
    'settings.testOk': '測試正常',
    'settings.testNeedsFields': '請輸入主機、連接埠與使用者名稱以測試。',
    'settings.testAlreadyPassed': '此草稿已通過連線測試。',
    'settings.readyToTest': '欄位已可測試。',
    'settings.unsavedChanges': '變更會自動儲存。',
    'settings.noUnsavedChanges': '設定已更新。',
    'connection.connecting': '正在連線到後端...',
    'connection.loadingSessions': '正在連線並載入工作階段...',
    'connection.refreshing': '正在重新整理工作階段...',
    'connection.reconnecting': '連線較慢；正在安靜重試...',
    'connection.connected': '已連線',
    'connection.offline': '無法連線到後端',
    'events.live': '即時更新已啟用（{count} 個事件）',
    'events.connecting': '正在啟動即時更新…',
    'events.reconnecting': '即時更新正在重新連線…',
    'events.fallback': '即時更新不可用；改用重新整理（{error}）',
    'events.unknownError': '未知錯誤',
    'settings.connectionFailed': '連線失敗：{message}',
    'settings.connectedTo': '已連線至所選後端 {version}',
    'settings.language': '語言',
    'settings.theme': '主題',
    'settings.themeSystem': '跟隨系統',
    'settings.themeLight': '淺色',
    'settings.themeDark': '深色',
    'sessions.title': '工作階段',
    'sessions.summary': '{total} 總數 · {active} 進行中 · {changed} 有變更',
    'sessions.new': '新增工作階段',
    'sessions.creating': '建立中...',
    'sessions.refresh': '重新整理',
    'sessions.projectDirectoryLabel': '已選資料夾',
    'sessions.projectDirectoryPlaceholder': '/home/you/project 或 C:\\Projects\\App',
    'sessions.projectDirectoryActive': '新工作階段會使用 {directory}。',
    'sessions.projectDirectoryDefault': '為這個新工作階段選擇資料夾，或使用伺服器預設目錄。',
    'sessions.newSessionTitle': '新工作階段資料夾',
    'sessions.remoteSessionTitle': '遠端工作階段',
    'sessions.useServerDefault': '使用伺服器預設',
    'sessions.useThisFolder': '在這裡建立',
    'sessions.parentFolder': '上一層資料夾',
    'sessions.folderPickerLoading': '正在載入資料夾...',
    'sessions.folderPickerEmpty': '這裡沒有資料夾。',
    'sessions.projectDirectoryInvalid': '{directory} 不是後端專案資料夾。請選擇專案/worktree 資料夾，或使用伺服器預設。',
    'sessions.searchPlaceholder': '依標題或目錄搜尋工作階段...',
    'sessions.emptyTitle': '找不到工作階段',
    'sessions.emptyHint': '建立新的工作階段以開始',
    'sessions.loadingTitle': '正在連線到後端',
    'sessions.loadingHint': '正在載入工作階段。行動裝置或伺服器剛喚醒時可能需要幾秒。',
    'sessions.offlineHint': '伺服器未回應。它可能已關機、休眠，或位於另一個網路。',
    'sessions.retry': '重試',
    'sessions.noFileChanges': '沒有檔案變更',
    'sessions.updated': '更新於 {time}',
    'sessions.open': '開啟',
    'sessions.delete': '刪除',
    'detail.backToSessions': '← 工作階段',
    'detail.selectSession': '選擇工作階段',
    'detail.loading': '載入工作階段...',
    'detail.loadFailed': '無法開啟此工作階段',
    'detail.emptyTitle': '尚無訊息',
    'detail.emptyHint': '在下方開始對話',
    'detail.composerPlaceholder': '輸入提示，或以 / 下命令',
    'detail.externalSession': '由其他用戶端啟動',
    'detail.waiting': '等待中...',
    'detail.copyText': '複製文字',
    'detail.copyMarkdown': '複製為 Markdown',
    'detail.undo': '復原上一個回合',
    'detail.redo': '重做上一個復原的回合',
    'detail.sessionActions': '工作階段動作',
    'detail.nothingToUndo': '此工作階段沒有可復原的內容。',
    'detail.nothingToRedo': '此工作階段沒有可重做的內容。',
    'detail.revertToMessage': '還原到這則訊息',
    'detail.undoConfirm': '要復原上一個回合及其檔案變更嗎？',
    'detail.revertConfirm': '要將對話和檔案變更還原到這則訊息嗎？',
    'detail.send': '傳送',
    'detail.jumpToLatest': '前往最新',
    'detail.you': '👤 你',
    'detail.opencode': '🤖 OpenCode',
    'detail.projectDashboardLabel': '專案與 VCS 儀表板',
    'detail.projectLabel': '專案',
    'detail.vcsLabel': 'VCS',
    'detail.loadingProject': '載入中...',
    'detail.unavailable': '無法取得',
    'detail.aheadBehind': '超前 {ahead} · 落後 {behind}',
    'detail.fileStatusLabel': '已變更檔案',
    'detail.fileStatusSource': '來自 /file/status',
    'detail.dashboardError': '錯誤：{message}',
    'detail.changedFilesTitle': '已變更檔案',
    'detail.changedFilesHint': '點選檔案查看迷你 diff。',
    'detail.filesCount': '{count} 個檔案',
    'detail.miniDiffAria': '已變更檔案迷你 diff',
    'detail.linesAddedDeleted': '+{additions} 行 · -{deletions} 行',
    'detail.modelPanelLabel': 'AI 模型選擇器',
    'detail.aiTitle': 'AI 代理與模型',
    'detail.refreshAi': '重新整理 AI 選項',
    'detail.agentTitle': '代理',
    'detail.agentSelectLabel': '下一個提示的代理',
    'detail.agentLoading': '正在載入已設定代理...',
    'detail.agentLoadError': '無法載入代理：{message}',
    'detail.agentMode': '模式：{mode}',
    'detail.modelTitle': 'AI 模型',
    'detail.modelHint': '套用到下一個提示與新工作階段。進行中的回覆仍使用原本模型。',
    'detail.refreshModels': '重新整理模型',
    'detail.modelSelectLabel': '下一個提示的模型',
    'detail.modelSearchPlaceholder': '依名稱或提供者搜尋模型...',
    'detail.modelSearchEmpty': '沒有符合搜尋的模型。',
    'detail.modelDefault': '預設',
    'detail.modelProvider': '提供者：{provider}',
    'detail.modelContext': '上下文 {context} · 輸出 {output}',
    'detail.modelToolsYes': '已啟用工具',
    'detail.modelToolsNo': '無工具',
    'detail.modelVariant': '變體：{variant}',
    'detail.modelLoading': '正在載入已設定模型...',
    'detail.modelNotSupported': '此 harness 未提供模型選擇',
    'detail.modelUnavailable': '無法取得模型 — 請檢查伺服器',
    'detail.modelLoadError': '無法載入模型：{message}',
    'detail.contextStripLabel': '工作階段情境捷徑',
    'detail.aiChip': 'AI',
    'detail.filesChip': '檔案',
    'detail.detailsChip': '詳細資訊',
    'detail.sessionDetailsTitle': '工作階段詳細資訊',
    'detail.sessionDetailsHint': '專案、VCS、檔案與模型的進階資訊。',
    'detail.closeSheet': '關閉',
    'todo.title': '待辦事項',
    'todo.hide': '隱藏',
    'todo.show': '顯示',
    'session.deleteTitle': '刪除工作階段？',
    'session.deleteBodyPrefix': '這會永久刪除',
    'session.cancel': '取消',
    'session.deleteConfirm': '刪除工作階段',
    'session.renameTitle': '重新命名工作階段',
    'session.renamePlaceholder': '輸入新名稱...',
    'session.renameConfirm': '重新命名',
    'help.title': '說明與文件',
    'help.overview': '總覽',
    'help.server': '伺服器',
    'help.network': '網路',
    'help.troubleshooting': '疑難排解',
    'help.commands': '命令',
    'action.close': '關閉',
    'action.thinking': '思考中',
    'action.thoughtFor': '思考了 {duration}',
    'action.durationSeconds': '{n} 秒',
    'action.durationMinutes': '{n} 分',
    'action.readFile': '已讀取檔案',
    'action.readFileNamed': '已讀取 {file}',
    'action.wroteFile': '已寫入檔案',
    'action.wroteFileNamed': '已寫入 {file}',
    'action.editedFile': '已編輯檔案',
    'action.editedFileNamed': '已編輯 {file}',
    'action.ranCommand': '已執行命令',
    'action.ranCommandNamed': '已執行 {command}',
    'action.searchedFiles': '已搜尋檔案',
    'action.searchedFilesFor': '已搜尋檔案「{pattern}」',
    'action.searchedCode': '已搜尋程式碼',
    'action.searchedCodeFor': '已搜尋「{pattern}」',
    'action.fetchedUrl': '已擷取網址',
    'action.fetchedUrlNamed': '已擷取 {url}',
    'action.updatedTodos': '已更新待辦事項清單',
    'action.todoSummary': '已完成 {done}/{total} 個待辦事項',
    'action.askedQuestion': '提出問題',
    'action.askedQuestionNamed': '已提問：{question}',
    'action.askedQuestions': '提出 {n} 個問題',
    'action.ranSubagent': '已執行子代理',
    'action.ranSubagentNamed': '已執行子代理：{description}',
    'action.usedSkill': '已使用技能',
    'action.usedSkillNamed': '已使用技能：{name}',
    'action.toolFailed': '工具失敗',
    'action.running': '執行中…',
    'action.preparingTool': '正在準備 {tool}',
    'action.showDiffFor': '顯示 {file} 的差異',
    'action.actionsFallback': '動作',
    'action.countReadOne': '讀取 1 個檔案',
    'action.countReadMany': '讀取 {n} 個檔案',
    'action.countWriteOne': '寫入 1 個檔案',
    'action.countWriteMany': '寫入 {n} 個檔案',
    'action.countEditOne': '編輯 1 個檔案',
    'action.countEditMany': '編輯 {n} 個檔案',
    'action.countSearchOne': '搜尋 1 次',
    'action.countSearchMany': '搜尋 {n} 次',
    'action.countBashOne': '執行 1 個命令',
    'action.countBashMany': '執行 {n} 個命令',
    'action.countWebfetchOne': '擷取 1 個網址',
    'action.countWebfetchMany': '擷取 {n} 個網址',
    'action.countTaskOne': '執行 1 個子代理',
    'action.countTaskMany': '執行 {n} 個子代理',
    'action.countSkillOne': '使用 1 個技能',
    'action.countSkillMany': '使用 {n} 個技能',
    'action.countOtherOne': '執行 1 個工具',
    'action.countOtherMany': '執行 {n} 個工具',
    'action.countTodoOne': '更新待辦事項清單',
    'action.countTodoMany': '更新待辦事項清單 {n} 次',
    'action.countQuestionOne': '提出 1 個問題',
    'action.countQuestionMany': '提出 {n} 個問題',
    'action.madeEditOne': '進行了 1 次編輯',
    'action.madeEditMany': '進行了 {n} 次編輯',
    'question.ariaLabel': '來自 OpenCode 的問題',
    'question.otherPlaceholder': '其他…',
    'question.skip': '略過',
    'question.sendAnswer': '傳送回答',
    'permission.ariaLabel': '來自 OpenCode 的權限請求',
    'permission.requested': '請求權限：{permission}',
    'permission.allowOnce': '允許一次',
    'permission.allowAlways': '永遠允許',
    'permission.deny': '拒絕'
  },
  'zh-CN': {
    'app.title': 'Harness Remote',
    'app.jumpToTop': '跳到顶部',
    'app.jumpToBottom': '跳到底部',
    'nav.settings': '设置',
    'notification.title': 'Harness Remote',
    'notification.body': '代理已完成任务',
    'notification.overlayDescription': '代理任务已完成',
    'nav.sessions': '会话',
    'nav.detail': '详情',
    'nav.help': '帮助',
    'menu.title': '菜单',
    'menu.settingsDescription': '配置服务器连接',
    'menu.sessionsDescription': '管理你的会话',
    'menu.detailDescription': '与所选后端对话',
    'menu.helpDescription': '文档与支持',
    'settings.title': '服务器配置',
    'settings.serverProfile': '已保存的服务器',
    'settings.serverName': '服务器名称',
    'settings.newServerName': '新服务器',
    'settings.addServer': '添加服务器',
    'settings.deleteServer': '删除服务器',
    'settings.deleteServerTitle': '删除已保存的服务器？',
    'settings.deleteLastServerHint': '请至少保留一个服务器配置。',
    'settings.backend': '后端',
    'settings.host': '主机地址',
    'settings.hostPlaceholder': '192.168.1.100、localhost 或 https://example.com',
    'settings.port': '端口',
    'settings.username': '用户名',
    'settings.password': '密码',
    'settings.passwordPlaceholder': '选填；未受保护的本机服务器可留空',
    'settings.save': '保存配置',
    'settings.saving': '保存中...',
    'settings.test': '测试连接',
    'settings.testing': '测试中...',
    'settings.testingConnection': '正在测试连接...',
    'settings.saved': '更改已自动保存。',
    'settings.connectedSaved': '已连接到所选后端 {version}。设置已自动保存。',
    'settings.draftHint': '停止输入后，更改会自动保存。',
    'settings.testedNotSaved': '连接正常：所选后端 {version}。尚未保存任何更改。',
    'settings.savedButton': '已保存',
    'settings.testOk': '测试正常',
    'settings.testNeedsFields': '请输入主机、端口与用户名以进行测试。',
    'settings.testAlreadyPassed': '此草稿已通过连接测试。',
    'settings.readyToTest': '字段已可测试。',
    'settings.unsavedChanges': '更改将自动保存。',
    'settings.noUnsavedChanges': '设置已是最新。',
    'connection.connecting': '正在连接到后端...',
    'connection.loadingSessions': '正在连接并加载会话...',
    'connection.refreshing': '正在刷新会话...',
    'connection.reconnecting': '连接较慢；正在静默重试...',
    'connection.connected': '已连接',
    'connection.offline': '无法连接到后端',
    'events.live': '实时更新已启用（{count} 个事件）',
    'events.connecting': '正在启动实时更新…',
    'events.reconnecting': '实时更新正在重新连接…',
    'events.fallback': '实时更新不可用；改用刷新（{error}）',
    'events.unknownError': '未知错误',
    'settings.connectionFailed': '连接失败：{message}',
    'settings.connectedTo': '已连接到所选后端 {version}',
    'settings.language': '语言',
    'settings.theme': '主题',
    'settings.themeSystem': '跟随系统',
    'settings.themeLight': '浅色',
    'settings.themeDark': '深色',
    'sessions.title': '会话',
    'sessions.summary': '{total} 总数 · {active} 进行中 · {changed} 有更改',
    'sessions.new': '新建会话',
    'sessions.creating': '创建中...',
    'sessions.refresh': '刷新',
    'sessions.projectDirectoryLabel': '已选文件夹',
    'sessions.projectDirectoryPlaceholder': '/home/you/project 或 C:\\Projects\\App',
    'sessions.projectDirectoryActive': '新会话将使用 {directory}。',
    'sessions.projectDirectoryDefault': '为这个新会话选择文件夹，或使用服务器默认目录。',
    'sessions.newSessionTitle': '新会话文件夹',
    'sessions.remoteSessionTitle': '远程会话',
    'sessions.useServerDefault': '使用服务器默认',
    'sessions.useThisFolder': '在此创建',
    'sessions.parentFolder': '上一级文件夹',
    'sessions.folderPickerLoading': '正在加载文件夹...',
    'sessions.folderPickerEmpty': '这里没有文件夹。',
    'sessions.projectDirectoryInvalid': '{directory} 不是后端项目文件夹。请选择项目/工作树文件夹，或使用服务器默认。',
    'sessions.searchPlaceholder': '按标题或目录搜索会话...',
    'sessions.emptyTitle': '未找到会话',
    'sessions.emptyHint': '创建新会话即可开始',
    'sessions.loadingTitle': '正在连接到后端',
    'sessions.loadingHint': '正在加载会话。在移动设备上或服务器刚唤醒时可能需要几秒钟。',
    'sessions.offlineHint': '服务器没有响应。它可能已关机、休眠，或位于另一个网络。',
    'sessions.retry': '重试',
    'sessions.noFileChanges': '没有文件更改',
    'sessions.updated': '更新于 {time}',
    'sessions.open': '打开',
    'sessions.delete': '删除',
    'detail.backToSessions': '← 会话',
    'detail.selectSession': '选择会话',
    'detail.loading': '正在加载会话...',
    'detail.loadFailed': '无法打开此会话',
    'detail.emptyTitle': '暂无消息',
    'detail.emptyHint': '在下方开始对话',
    'detail.composerPlaceholder': '输入提示，或以 / 输入命令',
    'detail.externalSession': '由其他客户端启动',
    'detail.waiting': '等待中...',
    'detail.copyText': '复制文本',
    'detail.copyMarkdown': '复制为 Markdown',
    'detail.undo': '撤销上一轮',
    'detail.redo': '重做上一轮已撤销的操作',
    'detail.sessionActions': '会话操作',
    'detail.nothingToUndo': '此会话没有可撤销的内容。',
    'detail.nothingToRedo': '此会话没有可重做的内容。',
    'detail.revertToMessage': '还原到这条消息',
    'detail.undoConfirm': '要撤销上一轮及其文件更改吗？',
    'detail.revertConfirm': '要将对话和文件更改还原到这条消息吗？',
    'detail.send': '发送',
    'detail.jumpToLatest': '前往最新',
    'detail.you': '👤 你',
    'detail.opencode': '🤖 OpenCode',
    'detail.projectDashboardLabel': '项目与 VCS 仪表盘',
    'detail.projectLabel': '项目',
    'detail.vcsLabel': 'VCS',
    'detail.loadingProject': '加载中...',
    'detail.unavailable': '不可用',
    'detail.aheadBehind': '领先 {ahead} · 落后 {behind}',
    'detail.fileStatusLabel': '已更改文件',
    'detail.fileStatusSource': '来自 /file/status',
    'detail.dashboardError': '错误：{message}',
    'detail.changedFilesTitle': '已更改文件',
    'detail.changedFilesHint': '点击文件查看迷你 diff。',
    'detail.filesCount': '{count} 个文件',
    'detail.miniDiffAria': '已更改文件迷你 diff',
    'detail.linesAddedDeleted': '+{additions} 行 · -{deletions} 行',
    'detail.modelPanelLabel': 'AI 模型选择器',
    'detail.aiTitle': 'AI 代理与模型',
    'detail.refreshAi': '刷新 AI 选项',
    'detail.agentTitle': '代理',
    'detail.agentSelectLabel': '下一条提示使用的代理',
    'detail.agentLoading': '正在加载已配置的代理...',
    'detail.agentLoadError': '无法加载代理：{message}',
    'detail.agentMode': '模式：{mode}',
    'detail.modelTitle': 'AI 模型',
    'detail.modelHint': '适用于下一条提示和新会话。正在进行的回复仍使用原有模型。',
    'detail.refreshModels': '刷新模型',
    'detail.modelSelectLabel': '下一条提示使用的模型',
    'detail.modelSearchPlaceholder': '按名称或提供商搜索模型...',
    'detail.modelSearchEmpty': '没有符合搜索条件的模型。',
    'detail.modelDefault': '默认',
    'detail.modelProvider': '提供商：{provider}',
    'detail.modelContext': '上下文 {context} · 输出 {output}',
    'detail.modelToolsYes': '已启用工具',
    'detail.modelToolsNo': '无工具',
    'detail.modelVariant': '变体：{variant}',
    'detail.modelLoading': '正在加载已配置的模型...',
    'detail.modelNotSupported': '此 harness 不提供模型选择',
    'detail.modelUnavailable': '无法获取模型 — 请检查服务器',
    'detail.modelLoadError': '无法加载模型：{message}',
    'detail.contextStripLabel': '会话上下文快捷方式',
    'detail.aiChip': 'AI',
    'detail.filesChip': '文件',
    'detail.detailsChip': '详细信息',
    'detail.sessionDetailsTitle': '会话详细信息',
    'detail.sessionDetailsHint': '项目、VCS、文件与模型的进阶信息。',
    'detail.closeSheet': '关闭',
    'todo.title': '待办事项',
    'todo.hide': '隐藏',
    'todo.show': '显示',
    'session.deleteTitle': '删除会话？',
    'session.deleteBodyPrefix': '这将永久删除',
    'session.cancel': '取消',
    'session.deleteConfirm': '删除会话',
    'session.renameTitle': '重命名会话',
    'session.renamePlaceholder': '输入新名称...',
    'session.renameConfirm': '重命名',
    'help.title': '帮助与文档',
    'help.overview': '概览',
    'help.server': '服务器',
    'help.network': '网络',
    'help.troubleshooting': '疑难解答',
    'help.commands': '命令',
    'menubar.file': '文件',
    'menubar.session': '会话',
    'menubar.view': '视图',
    'menubar.help': '帮助',
    'command.newSession': '新建会话',
    'command.refreshSessions': '刷新会话',
    'command.addServer': '连接服务器',
    'command.openSettings': '打开设置',
    'command.focusComposer': '聚焦输入框',
    'command.stopAgent': '停止代理',
    'command.commandPalette': '命令',
    'command.searchSessions': '搜索会话',
    'command.toggleInspector': '切换检查器',
    'command.openHelp': '打开帮助',
    'command.groupSession': '会话',
    'command.groupServer': '服务器',
    'command.groupView': '视图',
    'command.groupOpenSession': '打开会话',
    'command.switchTo': '切换到 {name}',
    'command.manageServers': '管理服务器',
    'command.palettePlaceholder': '搜索命令和会话…',
    'command.paletteEmpty': '没有匹配的命令',
    'command.navigate': '导航',
    'command.run': '运行',
    'command.close': '关闭',
    'connect.title': '连接服务器',
    'connect.subtitle': '选择 harness，输入其地址，然后验证连接。',
    'connect.step.harness': 'Harness',
    'connect.step.address': '地址',
    'connect.step.credentials': '凭据',
    'connect.harness.opencode': '直接连接到 OpenCode 服务器。',
    'connect.harness.omp': '通过附带的 Oh My Pi 桥接器连接。',
    'connect.harness.pi': '通过 ACP 桥接器连接到 PI。',
    'connect.harness.claude': '通过 ACP 桥接器连接到 Claude Code。',
    'connect.harness.codex': '通过 ACP 桥接器连接到 Codex CLI。',
    'connect.addressHint': '请使用运行 harness 的电脑的局域网地址。',
    'connect.runOnHost': '在主机上运行',
    'connect.copyCommand': '复制命令',
    'connect.copied': '已复制',
    'connect.credentialsHint': '这些凭据必须与主机上运行的命令一致。',
    'connect.back': '返回',
    'connect.save': '保存并连接',
    'connect.next': '继续',
    'sessions.recentProjects': '最近的项目',
    'sessions.browseFolders': '浏览文件夹',
    'sessions.typePathLabel': '打开路径',
    'sessions.typePathPlaceholder': '/home/you/project 或 C:\\Projects\\App',
    'sessions.goToPath': '前往',
    'action.close': '关闭',
    'action.thinking': '思考中',
    'action.thoughtFor': '思考了 {duration}',
    'action.durationSeconds': '{n} 秒',
    'action.durationMinutes': '{n} 分',
    'action.readFile': '读取文件',
    'action.readFileNamed': '已读取 {file}',
    'action.wroteFile': '写入文件',
    'action.wroteFileNamed': '已写入 {file}',
    'action.editedFile': '编辑文件',
    'action.editedFileNamed': '已编辑 {file}',
    'action.ranCommand': '运行命令',
    'action.ranCommandNamed': '已运行 {command}',
    'action.searchedFiles': '搜索文件',
    'action.searchedFilesFor': '已搜索文件「{pattern}」',
    'action.searchedCode': '搜索代码',
    'action.searchedCodeFor': '已搜索「{pattern}」',
    'action.fetchedUrl': '获取网址',
    'action.fetchedUrlNamed': '已获取 {url}',
    'action.updatedTodos': '已更新待办事项列表',
    'action.todoSummary': '已完成 {done}/{total} 个待办事项',
    'action.askedQuestion': '提问',
    'action.askedQuestionNamed': '已提问：{question}',
    'action.askedQuestions': '提出 {n} 个问题',
    'action.ranSubagent': '运行子代理',
    'action.ranSubagentNamed': '已运行子代理：{description}',
    'action.usedSkill': '使用技能',
    'action.usedSkillNamed': '已使用技能：{name}',
    'action.toolFailed': '工具失败',
    'action.running': '运行中…',
    'action.preparingTool': '正在准备 {tool}',
    'action.showDiffFor': '显示 {file} 的差异',
    'action.actionsFallback': '操作',
    'action.countReadOne': '读取了 1 个文件',
    'action.countReadMany': '读取了 {n} 个文件',
    'action.countWriteOne': '写入 1 个文件',
    'action.countWriteMany': '写入 {n} 个文件',
    'action.countEditOne': '编辑 1 个文件',
    'action.countEditMany': '编辑 {n} 个文件',
    'action.countSearchOne': '搜索 1 次',
    'action.countSearchMany': '搜索 {n} 次',
    'action.countBashOne': '运行 1 个命令',
    'action.countBashMany': '运行 {n} 个命令',
    'action.countWebfetchOne': '获取 1 个网址',
    'action.countWebfetchMany': '获取 {n} 个网址',
    'action.countTaskOne': '运行 1 个子代理',
    'action.countTaskMany': '运行 {n} 个子代理',
    'action.countSkillOne': '使用 1 个技能',
    'action.countSkillMany': '使用 {n} 个技能',
    'action.countOtherOne': '运行 1 个工具',
    'action.countOtherMany': '运行 {n} 个工具',
    'action.countTodoOne': '更新待办事项列表',
    'action.countTodoMany': '更新待办事项列表 {n} 次',
    'action.countQuestionOne': '提出 1 个问题',
    'action.countQuestionMany': '提出 {n} 个问题',
    'action.madeEditOne': '进行了 1 次编辑',
    'action.madeEditMany': '进行了 {n} 次编辑',
    'question.ariaLabel': '来自 OpenCode 的问题',
    'question.otherPlaceholder': '其他…',
    'question.skip': '跳过',
    'question.sendAnswer': '发送回答',
    'permission.ariaLabel': '来自 OpenCode 的权限请求',
    'permission.requested': '请求权限：{permission}',
    'permission.allowOnce': '允许一次',
    'permission.allowAlways': '始终允许',
    'permission.deny': '拒绝'
  }
}

export const languageOptions: Array<{ code: LanguageCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'zh-CN', label: '简体中文' }
]

export function normalizeLanguage(value: string | null | undefined): LanguageCode {
  if (value === 'it' || value?.toLowerCase().startsWith('it')) return 'it'
  const lower = value?.toLowerCase() ?? ''
  if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower.startsWith('zh-sg') || lower.startsWith('zh-my')) return 'zh-CN'
  if (lower.startsWith('zh')) return 'zh-TW'
  return 'en'
}

export type Translator = (key: string, params?: Record<string, string | number>) => string

export function createTranslator(language: LanguageCode): Translator {
  return (key: string, params: Record<string, string | number> = {}) => {
    const template = translations[language][key as TranslationKey] ?? translations.en[key as TranslationKey] ?? key
    return Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      template
    )
  }
}
