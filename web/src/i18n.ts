export type LanguageCode = 'en' | 'it' | 'zh-TW'

type TranslationKey =
  | 'app.title'
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
  | 'settings.backend'
  | 'settings.host'
  | 'settings.hostPlaceholder'
  | 'settings.hostHint'
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
  | 'detail.emptyTitle'
  | 'detail.emptyHint'
  | 'detail.composerPlaceholder'
  | 'detail.externalSession'
  | 'detail.waiting'
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

const translations: Record<LanguageCode, Record<TranslationKey, string>> = {
  en: {
    'app.title': 'Harness Remote',
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
    'settings.backend': 'Backend',
    'settings.host': 'Host Address',
    'settings.hostPlaceholder': '192.168.1.100, localhost, or https://example.com',
    'settings.hostHint': "Use the computer's IP address. http:// is optional and only needed as https:// for a TLS server. A Windows computer name such as MY-PC usually cannot be resolved from a phone.",
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
    'sessions.offlineHint': 'Backend is not reachable yet. Check Settings or try Refresh.',
    'sessions.noFileChanges': 'No file changes',
    'sessions.updated': 'Updated {time}',
    'sessions.open': 'Open',
    'sessions.delete': 'Delete',
    'detail.backToSessions': '← Sessions',
    'detail.selectSession': 'Select a session',
    'detail.loading': 'Loading session...',
    'detail.emptyTitle': 'No messages yet',
    'detail.emptyHint': 'Start a conversation below',
    'detail.composerPlaceholder': 'Type a prompt or command (start with / for slash commands)...',
    'detail.externalSession': 'From another client; sending continues it here',
    'detail.waiting': 'Waiting...',
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
    'question.sendAnswer': 'Send answer'
  },
  it: {
    'app.title': 'Harness Remote',
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
    'settings.backend': 'Backend',
    'settings.host': 'Indirizzo host',
    'settings.hostPlaceholder': '192.168.1.100, localhost o https://example.com',
    'settings.hostHint': "Usa l'indirizzo IP del computer. http:// è facoltativo e serve solo come https:// per un server TLS. Un nome di computer Windows come MIO-PC di solito non è risolvibile dal telefono.",
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
    'sessions.offlineHint': 'Backend non ancora raggiungibile. Controlla Impostazioni o riprova con Aggiorna.',
    'sessions.noFileChanges': 'Nessuna modifica ai file',
    'sessions.updated': 'Aggiornata {time}',
    'sessions.open': 'Apri',
    'sessions.delete': 'Elimina',
    'detail.backToSessions': '← Sessioni',
    'detail.selectSession': 'Seleziona una sessione',
    'detail.loading': 'Caricamento sessione...',
    'detail.emptyTitle': 'Ancora nessun messaggio',
    'detail.emptyHint': 'Inizia una conversazione qui sotto',
    'detail.composerPlaceholder': 'Scrivi un prompt o un comando (inizia con / per gli slash command)...',
    'detail.externalSession': 'Da un altro client; inviando la continui qui',
    'detail.waiting': 'Attesa...',
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
    'question.sendAnswer': 'Invia risposta'
  },
  'zh-TW': {
    'app.title': 'Harness Remote',
    'nav.settings': '設定',
    'nav.sessions': '工作階段',
    'nav.detail': '詳情',
    'nav.help': '說明',
    'menu.title': '選單',
    'menu.settingsDescription': '設定伺服器連線',
    'menu.sessionsDescription': '管理工作階段',
    'menu.detailDescription': '與已選後端對話',
    'menu.helpDescription': '文件與支援',
    'settings.title': '伺服器設定',
    'settings.backend': '後端',
    'settings.host': '主機位址',
    'settings.hostPlaceholder': '192.168.1.100、localhost 或 https://example.com',
    'settings.hostHint': '請使用電腦的 IP 位址。http:// 可省略，僅在使用 TLS 伺服器時需寫成 https://。像 MY-PC 這樣的 Windows 電腦名稱通常無法從手機解析。',
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
    'sessions.offlineHint': '尚無法連線到後端。請檢查設定或重新整理。',
    'sessions.noFileChanges': '沒有檔案變更',
    'sessions.updated': '更新於 {time}',
    'sessions.open': '開啟',
    'sessions.delete': '刪除',
    'detail.backToSessions': '← 工作階段',
    'detail.selectSession': '選擇工作階段',
    'detail.loading': '載入工作階段...',
    'detail.emptyTitle': '尚無訊息',
    'detail.emptyHint': '在下方開始對話',
    'detail.composerPlaceholder': '輸入提示或命令（以 / 開頭使用斜線命令）...',
    'detail.externalSession': '來自其他用戶端；傳送後將在此繼續',
    'detail.waiting': '等待中...',
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
    'question.sendAnswer': '傳送回答'
  }
}

export const languageOptions: Array<{ code: LanguageCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'zh-TW', label: '繁體中文' }
]

export function normalizeLanguage(value: string | null | undefined): LanguageCode {
  if (value === 'it' || value?.toLowerCase().startsWith('it')) return 'it'
  if (value === 'zh-TW' || value?.toLowerCase().startsWith('zh')) return 'zh-TW'
  return 'en'
}

export function createTranslator(language: LanguageCode) {
  return (key: string, params: Record<string, string | number> = {}) => {
    const template = translations[language][key as TranslationKey] ?? translations.en[key as TranslationKey] ?? key
    return Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      template
    )
  }
}
