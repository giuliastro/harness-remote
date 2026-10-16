# Issue #576 — configurazione delle macchine e cartelle dei progetti

## Scelta di UI e comportamento

La lista Machines è un riepilogo: ogni scheda mostra nome, connessione, harness e
cartelle dei progetti, senza aprire un editor. Un solo **Edit** porta allo stesso
form usato da **Add machine**. Il form sostituisce il riepilogo, così è chiaro quale
macchina si sta modificando; **Cancel**, Escape e la chiusura del form tornano alla lista.

La sezione **Project folders** fa parte del form. Per **This computer** il selettore
nativo modifica una bozza; solo **Save machine** applica le cartelle. Il riavvio del
daemon richiede conferma esplicita, con Cancel predefinito. Annullare la conferma
mantiene aperto il form e conserva la bozza, senza modificare il daemon. La
connessione della macchina locale è automatica e quindi in sola lettura.

Le cartelle remote appartengono al daemon remoto. La scheda e il form leggono le
radici dichiarate nel suo catalogo, distinguendole dai repository figli scoperti.
Il selettore locale non viene usato per percorsi remoti. Il daemon attuale non ha
un'API per modificarne le radici: il form le mostra in sola lettura e indica la
configurazione tramite `--root` sulla macchina interessata. Non vengono salvate
copie modificabili delle radici remote nel profilo del client. Daemon vecchi o
cataloghi che non comunicano radici producono uno stato non disponibile; non si
inventa una directory predefinita. Le radici remote non accessibili possono essere
omesse dal catalogo del daemon.

Sul desktop **Test connection** può leggere identità e cartelle anche prima di
salvare una nuova connessione. La verifica usa un canale temporaneo di sola
lettura, limitato a `/v1/machine` e `/v1/projects`, con la validazione dei normali
profili. Non salva il profilo e non invia azioni ai coding agent.

## Avvio della copia Linux

Chiudi l'eventuale vecchia copia di test, poi esegui:

```bash
/home/giulio/Software/harness-remote-issue576-run-test.sh --with-target
```

Il launcher apre l'app Electron, il suo daemon incorporato e un secondo daemon
isolato per provare Add/Edit di una macchina remota. Chiudere l'app termina tutti
i processi avviati da questo launcher. Anche l'interruzione del terminale li
termina, senza fermare servizi estranei. L'opzione `--with-target` è facoltativa.

- Build: `/home/giulio/Software/harness-remote-issue576-test`
- Dati e log: `/home/giulio/.local/share/harness-remote-issue576-test`
- Progetti sandbox: `/home/giulio/Software/harness-remote-issue576-sandbox/project-alpha`
  e `/home/giulio/Software/harness-remote-issue576-sandbox/project-beta`

Profili, storage del renderer, cartelle e stato dei due daemon sono separati
dall'ambiente quotidiano. Le credenziali dei provider rimangono quelle già
configurate nei rispettivi CLI. L'app parte da `/`, come un avvio dall'icona.
Le porte vengono scelte fra quelle libere; il launcher stampa i dati effettivi.

Per aggiungere il target di test, i dati normalmente sono:

| Campo | Valore |
| --- | --- |
| Name | `Issue576 remote target` |
| Host | `127.0.0.1` |
| Port | `4996` (controllare il valore stampato dal launcher) |
| Username | `issue576` |
| Password | `issue576` |
| Cartella del daemon | `/home/giulio/Software/harness-remote-issue576-sandbox/project-beta` |

**This computer** compare automaticamente e non richiede credenziali.

## Checklist per Giulio

1. Apri **Machines**. Le cartelle di **This computer** devono essere visibili nella
   scheda, insieme agli harness. Deve esserci **Edit**, senza il precedente tasto
   Settings separato. Con nessuna cartella configurata compare `/home/giulio`.
2. Premi **Edit**: deve comparire il form della macchina, con connessione gestita
   automaticamente e sezione **Project folders**. Premi **Add folder…** e scegli
   `project-alpha` nel percorso sandbox sopra. Il daemon deve continuare a
   funzionare; non deve comparire ancora una conferma di riavvio.
3. Premi **Cancel**: torna alla lista e la cartella aggiunta in bozza non compare
   nella scheda. Ripeti l'aggiunta e premi **Save machine**, poi **Cancel** nella
   conferma nativa: il form e la bozza restano aperti, la configurazione attiva resta
   invariata. Premi nuovamente Save e conferma **Restart now**: torna alla lista,
   che mostra la nuova cartella. Chiudi e riapri con lo stesso comando: deve restare.
4. Rimuovi una cartella nel form: deve scomparire dalla configurazione attiva solo
   dopo Save e conferma. Se rimuovi tutte le radici, il valore effettivo torna alla home.
5. Aggiungi il target remoto con i dati stampati. **Test connection** deve mostrare
   la connessione e la cartella `project-beta` prima del salvataggio. Cancel non
   aggiunge la macchina; ripeti e salva per vedere una seconda scheda con la sua
   cartella e i suoi harness. Il nome scelto deve comparire nella scheda.
6. Premi Edit sul target: deve aprirsi lo stesso form, con connessione modificabile
   e cartelle remote in sola lettura. Non deve esserci un selettore di cartelle locali
   per il target. Cambiando connessione, non devono restare le cartelle del vecchio
   endpoint: Test connection legge quelle della nuova macchina.
7. Nelle impostazioni generali devono restare lingua e aspetto. Controlla tema
   chiaro/scuro e, nel browser, larghezza desktop e mobile. Il riepilogo vuoto
   “Attention 0 pending / Some status may be stale” non deve esserci; i tab
   All / Live / Attention e le richieste concrete di intervento restano disponibili.

Per provare l'override, chiudi prima la copia di test e avvia:

```bash
HARNESS_REMOTE_ROOT=/home/giulio/Software/harness-remote-issue576-sandbox/project-beta /home/giulio/Software/harness-remote-issue576-run-test.sh
```

La scheda deve mostrare `project-beta`; nel form le cartelle sono in sola lettura
con una spiegazione. Riavviando senza la variabile tornano le cartelle salvate.

## Verifiche dell'agente e verifiche ancora manuali

Build desktop, 48 test Electron, regressioni del bridge e persistenza delle macchine,
UI, impostazioni, i18n e client delle macchine superati. Provati con Electron e daemon
reali: riepilogo delle radici, bozza/Cancel, Save con conferma accettata e annullata,
riavvio del daemon, persistenza, rimozione e override d'ambiente. Nei test automatici
le risposte ai dialoghi nativi sono simulate. Verificato anche Add sul desktop:
Test connection legge il target senza salvare il profilo, Cancel lo scarta e solo
Save registra la macchina e ne mostra le cartelle nella scheda.

Provati nel runtime browser, con daemon HTTP simulati e senza bridge desktop:
più macchine con radici distinte, esclusione dei repository figli dal riepilogo,
daemon senza catalogo, Add/Edit, cambio connessione, salvataggio dell'alias e
layout mobile. Il launcher con secondo daemon è stato avviato e la sua pulizia
è stata verificata.

La prova manuale confermata da Giulio e la regressione completa dei turni reali
sono distinte da questi controlli. Per verificare Session e risposta usa soltanto:
Codex `gpt-6-luna`, OpenCode `opencode/longcat-2.5-preview-free`, OMP `openrouter/free`,
PI `qwen/qwen3.8-27b:free` via OpenRouter. Prima verifica l'identificativo nel catalogo;
se manca, non sostituire il modello. Non eseguire test reali Claude Code.

Prompt innocuo per una Session in `project-alpha`:
`Leggi README.md e rispondi con il nome del progetto. Non modificare file.`
Mentre una risposta è in corso, modifica una cartella e premi Save, poi annulla la
conferma di riavvio: il turno deve continuare senza interruzioni. Verifica anche
arresto, continuazione e riapertura della Session.

Localizzazione: verificati nell’app Electron inglese, italiano, cinese tradizionale
e semplificato, inclusi il selettore nativo, i pulsanti e il testo della conferma,
gli errori di validazione e gli errori del selettore. Electron riceve la lingua
scelta nell’app a ogni operazione; i dialoghi non dipendono dalla lingua del sistema.
