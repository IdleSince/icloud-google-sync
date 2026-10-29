# Änderungsprotokoll

Alle für Anwender sichtbaren Änderungen an iCloud Google Calendar Sync.

## 1.1.0 – 29.10.2026

### Neu

- Du kannst jetzt **mehrere** geteilte iCloud-Kalender gleichzeitig übertragen. Jeder bekommt in
  Google einen eigenen Kalender mit dem Namen des Kalenders und der E-Mail der Person, die ihn
  geteilt hat, z. B. „Arbeit (anna@example.com)“. So kannst du in Google jeden einzeln ein- und
  ausblenden und ihm eine eigene Farbe geben.
- Unter iCloud fügst du jeden Kalender mit einem Klick hinzu, oder alle geteilten Kalender auf
  einmal. Ist Google schon verbunden, wird der passende Google-Kalender sofort angelegt.
- Einzelne Kalender lassen sich pausieren oder aus der Synchronisierung nehmen. Dabei wird weder in
  Google noch in iCloud etwas gelöscht.
- Fertiges Container-Abbild zum Herunterladen, Einrichtungsskript für den Server und eine Vorlage für
  Portainer. Für Portainer genügt der Betrieb nur im eigenen Netz: Die Oberfläche öffnest du über einen
  SSH-Tunnel unter `localhost`, aus dem Internet muss nichts erreichbar sein.

### Verbessert

- Das Dashboard zeigt jeden Kalender mit seinem Zielkalender, der Anzahl der Termine und dem
  letzten Lauf. Im Verlauf steht bei jedem Lauf, welcher Kalender abgeglichen wurde.
- Hat ein Kalender ein Problem, etwa weil die Freigabe beendet wurde, laufen die anderen Kalender
  trotzdem weiter.

### Geändert

- **Bitte prüfen nach dem Update:** Eine bestehende Einrichtung wird automatisch übernommen. Der
  bisherige Kalender und sein Google-Kalender bleiben erhalten. Weitere Kalender fügst du unter
  iCloud hinzu.

## 1.0.0 – 28.10.2026

### Neu

- Ein privat mit dir geteilter iCloud-Kalender erscheint automatisch als eigener Kalender in
  Google Kalender. Neue, geänderte und gelöschte Termine werden alle 5 Minuten übernommen.
- Die Prüfung „Ist mein geteilter Kalender erreichbar?“ zeigt alle Kalender deiner Apple-ID mit
  Eigentümer, Rechten und Anzahl der Termine. Du findest sie in der Weboberfläche unter iCloud
  und als Kommandozeilen-Werkzeug.
- Die Anmeldung bei iCloud erfolgt mit einem app-spezifischen Passwort. Dein normales
  Apple-ID-Passwort wird nie abgefragt.
- Mit einem Klick verbindest du Google und legst den Zielkalender „iCloud Sync“ an. Dein
  Hauptkalender bleibt gesperrt, bis du ihn ausdrücklich freigibst.
- Serientermine, verschobene und abgesagte Einzeltermine, ganztägige Termine, Zeitzonen,
  Verfügbarkeit und Erinnerungen werden übernommen. Teilnehmer bekommen keine Einladungen.
- Löschschutz: Termine werden nur gelöscht, wenn iCloud vollständig geantwortet hat und den
  Termin wirklich nicht mehr kennt. Ungewöhnlich viele Löschungen werden angehalten und
  müssen von dir freigegeben werden.
- Mit „Dry-Run“ siehst du vorab, was angelegt, geändert oder gelöscht würde, ohne dass etwas
  passiert.
- Das Dashboard zeigt Verbindungsstatus, letzten und nächsten Lauf, Anzahl der Termine und aktuelle
  Fehler. Unter Protokolle findest du Verlauf, Fehler, Statistik und eine technische Diagnose.
- Die Oberfläche ist auf Deutsch und Englisch verfügbar, passt sich Handy und PC an und
  unterstützt hellen und dunklen Modus.
- Die Weboberfläche ist durch eine Anmeldung geschützt. Zugangsdaten werden verschlüsselt
  gespeichert.
