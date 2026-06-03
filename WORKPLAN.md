# Workplan: dp-coupler PoC – Admin-UI-Integration

## Ziel

Mapping-Konfiguration auf ioBroker-Admin-UI (jsonConfig, jsonEditor) umstellen.
Datei `mappings.json` ist Ausgabe (Export/Backup/Template), nicht mehr Eingabe.
Klasse korrekt benennen.

## Architektur-Entscheidungen

- **Config ist primär:** `loadMappings()` liest ausschließlich `this.config.mappingsRaw`
  (ioBroker-DB). Das ist der persistente Speicher — ioBroker verwaltet ihn automatisch.
- **Datei ist Export:** `persistMappingsFile()` schreibt nach jedem erfolgreichen Start
  die Config in `mappings.json` (Seeding, Backup, Deployment-Template). Non-fatal.
- **Mass-Deployment** via `iobroker set dp-coupler.0 --native.mappingsRaw "$(cat mappings.json)"`
  oder direkt im WebUI eintragen.
- **Kein Konflikt** mehr zwischen Datei und Config: Datei ist immer Ausgabe, nie Eingabe.
- **`onUnload()` ist synchron und ruft `callback()` sofort auf** — kein `await` für
  Redis- oder IPC-Operationen. Analysiert: jede awaited async-Operation im Shutdown-Pfad
  hängt indefinit, weil js-controller die IPC-Verbindung abbaut bevor die Antwort
  eintrifft. `setStateAsync("info.connection", false)` wird fire-and-forget abgesetzt.
  `unsubscribeForeignStatesAsync` wurde versucht und aus demselben Grund verworfen.

## Aufgaben

### 1. `src/main.ts` refaktorieren ✓
- [x] `ioBroker.AdapterConfig`-Erweiterung deklarieren: `mappingsRaw: string`
- [x] Klasse `DpRelay` → `DpCoupler` umbenennen (inkl. Instanziierung am Ende)
- [x] `loadMappings()` liest ausschließlich `this.config.mappingsRaw`
- [x] `persistMappingsFile()` schreibt Config nach erfolgreichem Start in Datei
- [x] `fs`/`path` bleiben für `persistMappingsFile()`
- [x] TODO-Kommentare erhalten (bidirectional, ack-filter, fail-counter)
- [x] Build fehlerfrei

### 2. `admin/jsonConfig.json` erstellen ✓
- [x] `"type": "jsonEditor"`, Key `mappingsRaw`, Label `"Mappings (JSON array)"`
- **Gelernt:** Valider ioBroker-jsonConfig-Typ für JSON-Eingabe ist `"jsonEditor"`.
  `"textarea"` und `"json"` sind ungültig → Admin-Fehler `"has an invalid jsonConfig"`.
  Root muss `"type": "tabs"` sein; Felder in `"type": "panel"` verschachteln.

### 3. `io-package.json` aktualisieren ✓
- [x] `common.adminUI: { "config": "json" }` hinzugefügt
- [x] `native.mappingFile` → `native.mappingsRaw: "[]"`

### 4. Cleanup & Verifikation ✓
- [x] `mappings.json` bleibt im Repo als Beispiel/Deployment-Template
- [x] `CLAUDE.md` auf finalen Zustand aktualisieren
- [x] `npm run build` fehlerfrei
- [x] `setObjectNotExistsAsync` für `info` und `info.connection` in `onReady()` —
  notwendig, weil `instanceObjects` in `io-package.json` nur bei Neu-Instanzen angewendet
  werden; bestehende Instanzen bekommen die Objekte sonst nicht.

## Offene TODOs (bewusst zurückgestellt)

### Kurzfristig (nach PoC-Bestätigung)

- **`forwardChangesOnlyDefault` bei Neu-Instanz nicht default-on** — Checkbox
  "Forward value changes only by default" erscheint bei einer neu installierten Instanz
  als deaktiviert, obwohl `def: true` in `jsonConfig.json` und `native` in
  `io-package.json` gesetzt sind. Ursache klären (ioBroker-Initialisierungsreihenfolge?)
  und sicherstellen, dass der Default zuverlässig `true` ist.
  **Lösungsvorschlag:** Flag umbenennen/invertieren, so dass `false` das gewünschte
  Verhalten darstellt — z.B. `forwardChangesOnly` → `forwardRepeated` (default `false`
  = wiederholte Werte werden nicht weitergeleitet). Damit ist default-off korrekt und
  das ioBroker-Checkbox-Problem entfällt.

- [x] **Adapter-Neustart nach Konfigurationsänderung** — behoben + analysiert.

  **Implementierter Fix:**
  1. `this.unloading = true` in `onUnload()` — bricht laufende `onSyncTick()`-Iteration ab.
  2. `setStateAsync("info.connection", false)` fire-and-forget (kein `await`).
  3. `callback()` wird sofort synchron aufgerufen.
  4. `unsubscribeForeignStatesAsync` wurde versucht und verworfen — hängt ebenfalls.

  **Dev-Server-Befund:** Das im dev-server beobachtete ADAPTER_ALREADY_RUNNING-Muster
  (~60 s Zombie) ist eine Eigenheit der nodemon-Architektur und kein Adapter-Bug.
  nodemon ist der direkte Elternprozess des Adapters — wenn der Adapter `process.exit(11)`
  ruft, startet nodemon ihn sofort neu. js-controller weiß davon nichts und sieht den
  neu gestarteten Adapter als Konflikt. In einer echten ioBroker-Installation ist
  js-controller der einzige Lifecycle-Manager; das Problem tritt dort nicht auf.
  **Feldtest steht noch aus.**

- [x] `bidirectional: true` — `targetIndex` + `inFlight`-Zyklus-Guard implementiert
- [x] `forwardOnAck` (ex `forwardAck`) — per Entry + Adapter-Default (`forwardOnAckDefault: false`)
- [x] `forwardChangesOnly` — per Entry + Adapter-Default (`forwardChangesOnlyDefault: true`)
- [x] `propagateAck` — per Entry + Adapter-Default (`propagateAckDefault: false`)
- [x] `setObjectNotExistsAsync` → `setObjectAsync`, initiales `setStateAsync(false)` entfernt
- `info.connection`-Granularität — Fail-Counter pro Eintrag
- Leeres Mapping beim Start → Datei einlesen und als Config übernehmen (Seeding-Weg
  für initiales Deployment ohne UI-Zugang)

### Nach PoC-Bestätigung, schrittweise

- [x] **Enable-Schalter pro Kanal als Datenpunkt** — jede Kopplung erhält einen
  steuerbaren `enabled`-Datenpunkt im Adapter-Namespace. Damit kann ein Kanal
  zur Laufzeit deaktiviert werden, ohne die Konfiguration zu ändern.

  **Implementiert:** `channels.<id>.enabled` (bool, read/write) + `channels.<id>.lastValue`
  (read-only, echter Typ via `getForeignObjectAsync`, echte Zeitstempel aus dem Quell-State).
  Dreistufige Auflösung: `enabledDefault` (Adapter-Setting) → `enabled` per MappingEntry
  → Laufzeit-DP. `lastValue` wird beim Start aus `lastState`-Cache vorbeladen (Zeitstempel
  der Quelle, nicht des Adapter-Starts). In `onStateChange` wird `lastValue` vor dem
  `enabled`-Check aktualisiert — der Wert ist also immer aktuell, auch bei deaktiviertem Kanal.
  `onSyncTick` überspringt deaktivierte Kanäle.

- [x] **Zeitgetaktete Synchronisation** — periodisches Schreiben aller verwalteten
  Ziel-Datenpunkte mit dem zuletzt bekannten Quell-Wert (Heartbeat/Refresh).
  Ganz-oder-gar-nicht pro Instanz: entweder alle Mappings der Instanz werden
  getaktet synchronisiert oder keines. Intervall instanzweit konfigurierbar.
  **Implementiert:** `syncInterval` (ms, 0=off) + `relayOnChange` (bool, default false)
  in Adapter-Settings. `lastState`-Cache wird beim Start per `getForeignStateAsync`
  vorbelegt und in `onStateChange` (nur Vorwärtsrichtung) aktuell gehalten.
  `onSyncTick` nutzt denselben `inFlight`-Guard und respektiert `propagateAck`,
  umgeht aber bewusst die `forwardOnAck`/`forwardChangesOnly`-Filter (Heartbeat muss
  immer schreiben). `relayOnChange`-Checkbox in Admin-UI ausgegraut wenn syncInterval=0.

- [x] **Mehrinstanz-Fähigkeit** — verifiziert: zwei Instanzen über Kreuz unidirektional
  verbunden, keine Loop, vollständig isolierte Konfigurationen.

- **Wert-Konvertierung via JSON/JSONata** — optionaler `transform`-Ausdruck pro
  MappingEntry, ähnlich dem Alias-Mechanismus von ioBroker. Vorerst werden für
  diesen Zweck ioBroker-Aliase verwendet; eigene Implementierung folgt erst wenn
  der Alias-Weg an seine Grenzen stößt.

- **Konfig-Initialisierungsproblem bei Neu-Instanz** — Nach Deinstallation und
  Neuanlage einer Instanz zeigt der Admin-UI alle Felder als undefiniert/leer,
  obwohl `native`-Defaults in `io-package.json` und `def`-Werte in `jsonConfig.json`
  gesetzt sind. Betroffen: `syncUnit` (zeigt "-"), `forwardChangesOnlyDefault`
  (erscheint deaktiviert obwohl default `true`). ioBroker wendet `native`-Defaults
  nicht zuverlässig auf die DB an, oder der Admin liest sie nicht korrekt zurück.
  Vorher bekannt für `forwardChangesOnlyDefault`, durch neue Felder verstärkt sichtbar.

  **Fix-Ansatz: verstecktes Versions-Feld + `onReady()`-Normalisierung**

  1. Feld `configVersion: 0` in `io-package.json` `native` ergänzen — **nicht** in
     `jsonConfig.json` (damit unsichtbar im Admin-UI, wird nie vom User überschrieben).
  2. In `onReady()`: wenn `this.config.configVersion === 0` (Neu-Instanz erkannt),
     alle Felder auf ihre Soll-Defaults normalisieren und per
     `extendForeignObjectAsync("system.adapter.dp-coupler.N", { native: { ...defaults, configVersion: 1 } })`
     in die ioBroker-DB zurückschreiben. Danach Adapter-Neustart auslösen, damit
     ioBroker die korrigierten Werte lädt.
  3. Bei `configVersion >= 1`: Normalisierung überspringen (normaler Start).
  4. Vorteil: das Versions-Feld ermöglicht später auch Schema-Migrationen (z.B.
     `configVersion === 1` → migriere altes Feld X zu neuem Feld Y).

### Ideen-Backlog (noch offen)

- **Zeittakt für Rückwärtsrichtung bidirektionaler Einträge** — aktuell cached der
  Timer nur Vorwärts-Ereignisse (source → target). Option, auch Rückwärts-Ereignisse
  (target → source bei `bidirectional: true`) in den Cache aufzunehmen, damit der
  Timer beide Richtungen periodisch erneuert. Zuerst als adapter-weiter Schalter
  (`syncBidirectional?: boolean`), ggf. später per MappingEntry.

- **Separate Filter-Einstellungen pro Koppelrichtung** — `forwardAck` und
  `forwardChangesOnly` getrennt für Vorwärts- und Rückwärtsrichtung eines
  bidirektionalen Eintrags. Technisch straightforward, aber die zusätzliche
  Konfigurationskomplexität überfordert voraussichtlich viele User.
  Zurückgestellt bis ausreichend User-Nachfrage besteht.

## Status

**PoC-Phase abgeschlossen.** Alle vier Aufgaben erledigt, Build fehlerfrei,
Adapter im dev-server verifiziert. Admin-UI zeigt jsonEditor (Import/Export-Workflow
als PoC-Workaround akzeptiert; jsonEditor-Höhe ist ein bekanntes UI-Quirk).
README dokumentiert den Ist-Zustand und die Roadmap.

Nächste Phase: PoC-Validierung im Feld, dann schrittweise Roadmap-Features.
