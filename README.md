# iCloud Google Calendar Sync

Selbst gehostete Web-Anwendung, die privat mit deiner Apple-ID geteilte iCloud-Kalender
automatisch und **nur in eine Richtung** nach Google Kalender überträgt. Jeder geteilte Kalender
bekommt dabei einen **eigenen** Google-Kalender, benannt nach dem Muster „Arbeit (anna@example.com)“.
Danach siehst du auf `calendar.google.com` deine eigenen Google-Termine und die Termine der
geteilten iCloud-Kalender nebeneinander und kannst jeden einzeln ein- und ausblenden.

- Der iCloud-Kalender bleibt privat: **keine öffentlichen Links, keine öffentliche Freigabe.**
- iCloud wird **nur gelesen**. Die Anwendung verändert dort niemals einen Termin.
- Neue, geänderte und gelöschte Termine werden alle 5 Minuten übernommen (einstellbar).
- Keine Duplikate, auch nicht nach einem Datenverlust der Anwendung.
- Löschungen nur mit mehreren Sicherheitsprüfungen, Probelauf (Dry-Run) und Sicherheitsgrenze.

> [!IMPORTANT]
> **Technische Voraussetzung:** Die Anwendung funktioniert nur, wenn Apple den geteilten Kalender
> für dein Konto über die CalDAV-Schnittstelle ausliefert. Das prüfst du **vor allem anderen** mit
> der eingebauten Diagnose (siehe [Machbarkeit prüfen](#1-machbarkeit-prüfen-phase-1)). Meldet sie
> „geteilter Kalender nicht gefunden“, gibt es **keinen** zulässigen Umweg. Eine öffentliche Freigabe
> ist ausdrücklich kein Ausweg und wird von dieser Anwendung nicht unterstützt.

---

## Inhalt

1. [Machbarkeit prüfen (Phase 1)](#1-machbarkeit-prüfen-phase-1)
2. [Voraussetzungen](#2-voraussetzungen)
3. [Apple: app-spezifisches Passwort erstellen](#3-apple-app-spezifisches-passwort-erstellen)
4. [Google: Cloud-Projekt, Calendar API, OAuth-Client](#4-google-cloud-projekt-calendar-api-oauth-client)
5. [Installation und Docker-Start](#5-installation-und-docker-start)
6. [Ersteinrichtung in der Weboberfläche](#6-ersteinrichtung-in-der-weboberfläche)
7. [Wie die Synchronisierung arbeitet](#7-wie-die-synchronisierung-arbeitet)
8. [Fehlerbehebung](#8-fehlerbehebung)
9. [Backup und Wiederherstellung](#9-backup-und-wiederherstellung)
10. [Sicherheit](#10-sicherheit)
11. [Bekannte Einschränkungen](#11-bekannte-einschränkungen)
12. [Entwicklung und Tests](#12-entwicklung-und-tests)

---

## 1. Machbarkeit prüfen (Phase 1)

Die Prüfung liest nur. Sie listet alle Kalender, die deine Apple-ID per CalDAV erreicht. Zu jedem
Kalender zeigt sie Name, stabile ID, Eigentümer, ob eigener oder geteilter Kalender, Rechte,
Lesbarkeit und Anzahl der Termine.

**Variante A: Kommandozeile** (vor dem Einrichten von Google und der Weboberfläche)

```sh
# lokal, mit Python 3.13
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m app.cli.discover                         # fragt Apple-ID und App-Passwort ab
```

oder mit dem fertigen Image:

```sh
docker compose build
docker run --rm -it ghcr.io/OWNER/icloud-google-sync:latest python -m app.cli.discover
```

Die Zugangsdaten werden nur abgefragt und nirgends gespeichert. Das Ergebnis endet mit einer
**Schlussfolgerung**:

| Schlussfolgerung | Bedeutung |
|---|---|
| `shared_accessible` | Mindestens ein geteilter Kalender ist sichtbar und lesbar. Die Synchronisierung ist möglich. |
| `shared_not_listed` | Kein geteilter Kalender sichtbar, siehe [Fehlerbehebung](#8-fehlerbehebung). |
| `shared_not_readable` | Geteilte Kalender sind gelistet, aber nicht lesbar. |
| `auth_failed` | Apple lehnt die Anmeldung ab (meist: normales Passwort statt App-Passwort). |
| `unreachable` | iCloud ist nicht erreichbar (Netzwerk, DNS, Proxy). |

Mit `--json` gibt es die Ausgabe maschinenlesbar, mit `--raw` zusätzlich die bereinigten
CalDAV-Eigenschaften je Kalender (ohne Termininhalte und ohne Zugangsdaten).

**Variante B: Weboberfläche.** Nach der Installation unter *iCloud → Diagnose* (gleiche Prüfung,
Schritt für Schritt dargestellt).

---

## 2. Voraussetzungen

- Ein Server mit Docker Engine ≥ 24 und Docker Compose v2 (Linux empfohlen).
- Ein **Hostname mit HTTPS**, z. B. `calsync.example.org`. Google akzeptiert als Rücksprungadresse
  nach der Anmeldung nur `https://…` (oder `localhost`). Eine reine IP-Adresse funktioniert nicht.
- Ein Reverse Proxy mit TLS. Der mitgelieferte, optionale Caddy holt Zertifikate automatisch.
  Ein vorhandener Proxy (Traefik, nginx …) geht genauso.
- Der geteilte Kalender ist auf deinem iPhone angenommen und sichtbar.

---

## 3. Apple: app-spezifisches Passwort erstellen

Dein normales Apple-ID-Passwort wird **nie** benötigt und **nie** gespeichert. Die Anwendung lehnt
alles ab, was nicht wie ein App-Passwort aussieht (`xxxx-xxxx-xxxx-xxxx`).

1. Zwei-Faktor-Authentifizierung muss für die Apple-ID aktiv sein.
2. <https://account.apple.com> öffnen und anmelden.
3. *Anmeldung und Sicherheit* → *App-spezifische Passwörter* → *Passwort generieren*.
4. Eine Bezeichnung vergeben, z. B. „Kalender-Sync“.
5. Das angezeigte Passwort (`abcd-efgh-ijkl-mnop`) kopieren. Apple zeigt es nur einmal an.

Widerrufen lässt es sich jederzeit an derselben Stelle. Eine Änderung des Apple-ID-Passworts
macht alle App-Passwörter ungültig. In dem Fall ein neues erzeugen und in der Weboberfläche
hinterlegen.

> **Warum kein „Mit Apple anmelden“?** Apple bietet Drittanbietern keinen OAuth-Zugang zu iCloud-Kalendern.
> „Mit Apple anmelden“ liefert nur Name und E-Mail-Adresse. Für CalDAV ist das app-spezifische
> Passwort der einzige von Apple vorgesehene Weg.

---

## 4. Google: Cloud-Projekt, Calendar API, OAuth-Client

1. **Projekt anlegen:** <https://console.cloud.google.com> → Projektauswahl → *Neues Projekt*,
   z. B. „iCloud Kalender Sync“.
2. **Google Calendar API aktivieren:** *APIs und Dienste* → *Bibliothek* → „Google Calendar API“ →
   *Aktivieren*.
3. **OAuth-Zustimmungsbildschirm** (*Google Auth Platform* → *Branding* / *Zielgruppe*):
   - Nutzertyp **Extern** (privates Google-Konto) bzw. **Intern** (Google Workspace).
   - App-Name und Support-E-Mail eintragen.
   - Unter *Zielgruppe* bei „Testnutzer“ **deine eigene Google-Adresse** eintragen.
     Im Status „Testen“ laufen Refresh-Tokens nach 7 Tagen ab. Für Dauerbetrieb die App auf
     **„In Produktion“** stellen. Für den Eigengebrauch ist keine Google-Prüfung nötig. Beim
     Verbinden erscheint dann nur ein Hinweis „Google hat diese App nicht überprüft“, den du
     über *Erweitert → Weiter* bestätigst.
   - *Datenzugriff* → Scopes hinzufügen:
     - `https://www.googleapis.com/auth/calendar.app.created`
     - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
     - optional `https://www.googleapis.com/auth/calendar.events.owned` (siehe unten)
4. **OAuth-Client erstellen:** *Clients* → *Client erstellen* → Typ **Webanwendung**.
   - **Autorisierte Weiterleitungs-URI** (exakt so, mit deinem Hostnamen):

     ```
     https://calsync.example.org/api/google/oauth/callback
     ```

     Das ist `APP_BASE_URL` + `/api/google/oauth/callback`. Ein abweichender Wert (anderer Pfad,
     `http` statt `https`, Schrägstrich am Ende) führt zu `redirect_uri_mismatch`.
     *Technische Diagnose* in der Weboberfläche zeigt den genau erwarteten Wert.
   - „Autorisierte JavaScript-Quellen“ bleiben leer.
5. **Client-ID** und **Clientschlüssel** in `secrets/google_client_id` und
   `secrets/google_client_secret` speichern (siehe [Installation](#5-installation-und-docker-start)).

**Welche Rechte die Anwendung bekommt**

| Scope | Wozu | Standard |
|---|---|---|
| `calendar.app.created` | Eigene Zielkalender anlegen und **nur darin** Termine verwalten | ja |
| `calendar.calendarlist.readonly` | Deine Kalender auflisten (Auswahl, Kontoname) | ja |
| `calendar.events.owned` | Termine in einem **bestehenden** eigenen Kalender verwalten | nur wenn du in der Oberfläche „Erweiterten Zugriff erteilen“ wählst |

Ohne den erweiterten Zugriff kann die Anwendung technisch gar nicht in andere Kalender schreiben,
auch nicht in deinen Hauptkalender. Der primäre Google-Kalender bleibt zusätzlich gesperrt, bis du
ihn in den Einstellungen ausdrücklich freigibst **und** die Auswahl in einem Dialog bestätigst.

---

## 5. Installation und Docker-Start

Das fertige Image baut GitHub automatisch bei jeder Änderung und stellt es unter
`ghcr.io/OWNER/icloud-google-sync` bereit, für `amd64` und `arm64`, also auch für einen
Raspberry Pi. Auf dem Server wird **nichts gebaut** und kein Quellcode gebraucht.

**Voraussetzungen auf dem Server:** Docker mit Compose-Plugin, ein Hostname, dessen DNS-Eintrag
auf den Server zeigt, Ports 80/443 frei (für den mitgelieferten Caddy mit automatischem HTTPS),
und der Google-OAuth-Client aus [Abschnitt 4](#4-google-cloud-projekt-calendar-api-oauth-client).

### Variante A: Einrichtungsskript (empfohlen)

```sh
curl -fsSLO https://raw.githubusercontent.com/OWNER/icloud-google-sync/main/deploy/install.sh
less install.sh        # vor dem Ausführen lesen
sh install.sh          # legt ./icloud-google-sync an
```

Das Skript macht Folgendes:

1. Es lädt `docker-compose.yml`, `.env` und die Caddy-Konfiguration herunter.
2. Es fragt nach dem Hostnamen und danach, ob der mitgelieferte Caddy HTTPS übernehmen soll.
3. Es **erzeugt** den Schlüssel für die Verschlüsselung und das Login-Passwort.
4. Es fragt Client-ID und Client-Secret von Google ab.
5. Es setzt die Dateirechte und startet den Container.

Am Ende zeigt es Adresse, Benutzernamen und den Befehl, mit dem du das Passwort anzeigst. Ein
zweiter Aufruf überschreibt keine vorhandenen Geheimnisse und keine Einstellungen.

### Variante B: von Hand

```sh
mkdir icloud-google-sync && cd icloud-google-sync && mkdir -p secrets deploy
BASE=https://raw.githubusercontent.com/OWNER/icloud-google-sync/main
curl -fsSL $BASE/docker-compose.yml -o docker-compose.yml
curl -fsSL $BASE/.env.example       -o .env
curl -fsSL $BASE/deploy/Caddyfile   -o deploy/Caddyfile

# 1. Konfiguration: in .env APP_BASE_URL=https://calsync.example.org eintragen (ohne / am Ende),
#    für den mitgelieferten Caddy zusätzlich PUBLIC_HOSTNAME, FORWARDED_ALLOW_IPS=172.16.0.0/12
#    und COMPOSE_PROFILES=caddy

# 2. Secrets anlegen (siehe secrets/README.md)
openssl rand -base64 32 | tr '+/' '-_' > secrets/app_encryption_key
openssl rand -base64 24 > secrets/admin_password          # Login-Passwort, im Passwortmanager ablegen
printf '%s' '123-abc.apps.googleusercontent.com' > secrets/google_client_id
printf '%s' 'GOCSPX-…'                          > secrets/google_client_secret
chmod 400 secrets/* && sudo chown 10001:10001 secrets/app_encryption_key secrets/admin_password secrets/google_client_id secrets/google_client_secret

# 3. Starten
docker compose up -d
docker compose ps            # Status "healthy" abwarten
docker compose logs -f app   # strukturierte JSON-Logs
```

**Update auf eine neue Version:** `docker compose pull && docker compose up -d`. Datenbank-
migrationen laufen beim Start automatisch. Wer Updates bewusst steuern will, trägt in `.env` eine
feste Version ein, z. B. `ICGS_IMAGE=ghcr.io/OWNER/icloud-google-sync:1.1.0`.

**Selbst bauen statt herunterladen** (im geklonten Repo):
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`

Die Anwendung lauscht standardmäßig nur auf `127.0.0.1:8000`. Davor gehört ein Reverse Proxy mit TLS:

- **Mitgelieferter Caddy:** `PUBLIC_HOSTNAME=calsync.example.org` in `.env`, DNS-Eintrag auf den
  Server zeigen lassen, Ports 80/443 freigeben, dann `docker compose --profile caddy up -d`.
  In diesem Fall `FORWARDED_ALLOW_IPS=172.16.0.0/12` setzen, damit die echte Client-IP für die
  Login-Sperre erkannt wird.
- **Eigener Proxy:** auf `http://127.0.0.1:8000` weiterleiten und `X-Forwarded-For` sowie
  `X-Forwarded-Proto` setzen.

**Wichtige Eigenschaften des Containers**

- Läuft als unprivilegierter Nutzer (UID 10001) mit schreibgeschütztem Dateisystem. Nur `/data`
  (Volume) und `/tmp` (tmpfs) sind beschreibbar. Alle Linux-Capabilities sind entfernt, dazu
  `no-new-privileges`.
- Healthcheck auf `/api/health`, automatischer Neustart (`unless-stopped`).
- Sauberes Herunterfahren: Bei `docker compose stop` wird ein laufender Sync abgebrochen und der
  Zustand gespeichert (Wartezeit bis 40 s).
- Zustand (SQLite-Datenbank) liegt im Volume `data` und übersteht Neustarts und Updates.
  Datenbankmigrationen laufen beim Start automatisch.

**Später auf k3s:** Das Image ist zustandslos bis auf `/data`. Für Kubernetes genügen ein
`Deployment` mit `replicas: 1` und Strategie `Recreate` (SQLite verträgt nur einen Schreiber),
ein `PersistentVolumeClaim` für `/data`, ein `Secret`, gemountet unter `/run/secrets`, mit denselben
`*_FILE`-Variablen, ein `Service` und ein Ingress mit TLS. Die Werte aus `docker-compose.yml`
(`readOnlyRootFilesystem`, `runAsUser: 10001`, `capabilities.drop: [ALL]`, Probes auf
`/api/health`) lassen sich 1:1 übernehmen.

---

## 6. Ersteinrichtung in der Weboberfläche

1. `https://calsync.example.org` öffnen, mit `admin` (bzw. `ADMIN_USERNAME`) und dem Passwort aus
   `secrets/admin_password` anmelden.
2. **iCloud:** Apple-ID und App-Passwort eintragen → *Speichern*. Die Verbindung wird vor dem
   Speichern geprüft. Danach *Diagnose* ansehen: Steht dort „Geteilter Kalender erreichbar“?
3. **Kalender wählen:** In der Kalenderliste bei jedem geteilten Kalender *Synchronisieren*
   wählen, oder alle geteilten Kalender auf einmal hinzufügen. Geteilte Kalender sind als
   „Geteilt“ markiert und zeigen den Eigentümer. Die Zuordnung wird über eine stabile Kennung
   gespeichert, nicht über die Position in der Liste.
4. **Google:** *Mit Google verbinden* → Google-Konto wählen → Zugriff erlauben. Danach für jeden
   Kalender einen Zielkalender anlegen lassen. Der Name lautet „Kalendername (E-Mail der
   Eigentümerin)“, z. B. „Arbeit (anna@example.com)“, und lässt sich vor dem Anlegen ändern.
   Kalender, die du hinzufügst, während Google schon verbunden ist, bekommen ihren Zielkalender
   sofort automatisch.
5. **Synchronisierung:** Zuerst *Dry-Run ausführen*. Er zeigt, was angelegt würde, ohne etwas zu
   schreiben. Dann *Jetzt synchronisieren*. Danach läuft alles automatisch alle 5 Minuten,
   Kalender für Kalender nacheinander.
6. Auf `calendar.google.com` erscheinen die neuen Kalender in der linken Leiste. Mit dem
   Farbpunkt lässt sich jeder einzeln ein- und ausblenden, die Farbe stellst du dort auch ein.

> **Kalender pausieren oder entfernen:** Ein Kalender lässt sich pausieren (wird nicht mehr
> abgeglichen) oder aus der Synchronisierung nehmen. In beiden Fällen löscht die Anwendung weder
> in Google noch in iCloud etwas. Den Google-Kalender entfernst du bei Bedarf selbst in Google.

> **„Weitere Kalender“ vs. „Meine Kalender“:** Google ordnet Kalender selbst ein. Ein Kalender, den
> die Anwendung in deinem Konto anlegt, gehört dir und steht deshalb unter **„Meine Kalender“**.
> Unter „Weitere Kalender“ führt Google nur abonnierte, fremde Kalender. Das lässt sich per API
> nicht beeinflussen. Ein Abo wäre nur über einen öffentlichen Link möglich, und das ist hier
> ausdrücklich nicht gewollt. Sichtbar ist der Kalender in beiden Fällen gleich. Er ist
> **nicht** mit anderen geteilt, die Anwendung legt keine Freigaben an.

---

## 7. Wie die Synchronisierung arbeitet

**Zuordnung:** Jeder Quelltermin wird über Kalender-ID + `UID` + `RECURRENCE-ID` eindeutig
identifiziert. Die Google-Termin-ID wird daraus **berechnet**. Ein erneuter Lauf, auch nach
Verlust der Datenbank, trifft deshalb immer denselben Google-Termin und legt keinen zweiten an.

**Übernommen werden:** Titel, Beginn/Ende mit Zeitzone, ganztägige Termine, Ort, Beschreibung
(abschaltbar), Wiederholungsregeln (`RRULE`, `EXDATE`, `RDATE`), verschobene oder geänderte
Einzeltermine einer Serie, abgesagte Einzeltermine, Verfügbarkeit (frei/belegt), Status
„vorläufig“, Sichtbarkeit „privat“ sowie Erinnerungen (bis zu 5 Popup-Erinnerungen, abschaltbar).

**Nicht übernommen werden:** Teilnehmer und Organisator. Dadurch verschickt Google **keine
Einladungen**. Zusätzlich läuft jeder Schreibzugriff mit `sendUpdates=none`.

**Zeitraum:** Standardmäßig 12 Monate zurück und 24 Monate voraus (einstellbar). Termine, die
später aus dem Zeitraum herausfallen, bleiben in Google stehen.

**Löschungen** werden nur ausgeführt, wenn **alle** Bedingungen erfüllt sind:

1. Der Abruf aus iCloud war vollständig (keine Abbrüche, keine fehlenden Daten, keine
   Lesefehler).
2. Der Quellkalender wurde vor dem Lauf eindeutig als der zugeordnete Kalender bestätigt.
3. Für jeden Kandidaten meldet iCloud bei gezielter Einzelabfrage „nicht vorhanden“, oder der
   Termin ist in iCloud als abgesagt markiert.
4. Der Google-Termin trägt die interne Kennzeichnung dieser Anwendung und dieser
   Kalenderzuordnung.
5. Die **Sicherheitsgrenze** ist nicht überschritten: Standard 25 Löschungen oder 30 % der
   synchronisierten Termine, jeweils pro Kalender. Die Prozentgrenze greift ab 5 Löschungen. Eine leere Quelle bei
   vorhandenen Terminen wird immer gestoppt. Gestoppte Löschungen lassen sich nach Prüfung in der
   Oberfläche einmalig freigeben.

Zusätzlich gibt es einen **Dry-Run nur für Löschungen** (Einstellung). Dann werden Löschungen
geplant und angezeigt, aber nie ausgeführt. Der Button *Dry-Run ausführen* simuliert einen
kompletten Lauf ohne jeden Schreibzugriff.

**Weitere Robustheit**

- Unveränderter iCloud-Kalender (gleicher CTag): Der geplante Lauf überspringt den teuren Abruf,
  für jeden Kalender einzeln.
- **Mehrere Kalender:** Jeder Kalender bekommt einen eigenen Lauf mit eigenem Ergebnis. Fällt ein
  Kalender aus (z. B. Freigabe beendet), laufen die anderen weiter. Nur Anmeldeprobleme bei Apple
  oder Google stoppen alle, weil sie alle betreffen.
  Spätestens alle 6 Stunden gibt es einen vollständigen Abgleich.
- Wird ein Termin in Google von Hand gelöscht, legt der nächste vollständige Lauf ihn wieder an.
- Netzwerkfehler, `429` und `5xx` werden mit exponentiellem Backoff und Zufallsanteil
  wiederholt. Ein `Retry-After` von Google wird beachtet.
- Abgelaufene Google-Zugangstokens werden automatisch erneuert. Ist die Freigabe widerrufen,
  zeigt das Dashboard „Erneut verbinden“.
- Es läuft nie mehr als ein Synchronisierungslauf gleichzeitig.

---

## 8. Fehlerbehebung

| Symptom | Ursache und Lösung |
|---|---|
| Diagnose: **geteilter Kalender nicht gefunden** | Einladung auf dem iPhone angenommen? (*Kalender → Kalender → Einladungen*). Ist der Kalender auf <https://www.icloud.com/calendar> sichtbar? Ist es dieselbe Apple-ID? Danach Diagnose erneut ausführen. Erscheint er weiterhin nicht, liefert Apple ihn nicht über CalDAV aus. Dann ist **keine** Synchronisierung möglich. Eine öffentliche Freigabe ist kein zulässiger Ersatz. |
| Diagnose: **Anmeldung fehlgeschlagen** | App-spezifisches Passwort verwenden, nicht das Apple-ID-Passwort. Nach einer Änderung des Apple-ID-Passworts ein neues App-Passwort erzeugen. |
| Google: `redirect_uri_mismatch` | Weiterleitungs-URI im OAuth-Client muss exakt `APP_BASE_URL/api/google/oauth/callback` sein (siehe *Protokolle → Technische Diagnose*). |
| Google: „Erneut verbinden“ nach ~7 Tagen | OAuth-App steht auf „Testen“. Auf „In Produktion“ stellen und neu verbinden. |
| Google: `google.scope_missing` | Ein bestehender Kalender braucht den erweiterten Zugriff. *Google → Erweiterten Zugriff erteilen* oder einen eigenen Zielkalender anlegen lassen. |
| Lauf „teilweise“: **Löschschutz ausgelöst** | Ungewöhnlich viele Löschungen erkannt. Liste unter *Synchronisierung* prüfen und bei Bedarf *Löschungen einmalig freigeben*. |
| Lauf „teilweise“: **Quelle unvollständig** | iCloud hat nicht alle Daten geliefert. Es wurde nichts gelöscht. Der nächste Lauf wiederholt automatisch. |
| Login gesperrt | Nach 5 Fehlversuchen in 15 Minuten wird die IP für 15 Minuten gesperrt. Hinter einem Proxy `FORWARDED_ALLOW_IPS` richtig setzen. |
| Container startet nicht: `APP_ENCRYPTION_KEY must be 32 bytes` | Schlüssel neu erzeugen (siehe oben). Bei bestehender Datenbank **muss** der alte Schlüssel verwendet werden. |
| Container: `Permission denied` auf `/run/secrets/…` | Secret-Dateien müssen für UID 10001 lesbar sein (`chown 10001:10001`). |

Protokolle enthalten keine Passwörter, Tokens, Termintitel oder Beschreibungen. Termine erscheinen
im Container-Log nur als kurzer Hash. Die Titel in den Lauf-Ergebnissen der Weboberfläche liegen
nur in der Datenbank und sind nur nach Anmeldung sichtbar.

---

## 9. Backup und Wiederherstellung

Gesichert werden müssen **das Volume `data`** (SQLite-Datenbank) und **`secrets/app_encryption_key`**.
Ohne den Schlüssel sind gespeichertes App-Passwort und Google-Token nicht mehr lesbar.

```sh
# Backup (konsistent, im laufenden Betrieb, über die SQLite-Backup-API)
mkdir -p backups
docker compose exec app python -c "import sqlite3; s=sqlite3.connect('/data/icgs.db'); d=sqlite3.connect('/tmp/backup.db'); s.backup(d); d.close()"
docker compose cp app:/tmp/backup.db ./backups/icgs-$(date +%F).db
cp secrets/app_encryption_key ./backups/   # getrennt und sicher aufbewahren!

# Wiederherstellung
docker compose stop app
docker run --rm -v icloud-google-sync_data:/data -v "$PWD/backups:/b" alpine \
  sh -c "cp /b/icgs-2026-10-28.db /data/icgs.db && rm -f /data/icgs.db-wal /data/icgs.db-shm && chown 10001:10001 /data/icgs.db"
docker compose start app
```

Geht die Datenbank ganz verloren, ist das unkritisch. Nach erneuter Einrichtung findet die
Anwendung dank der berechneten Termin-IDs alle vorhandenen Google-Termine wieder und legt keine
Duplikate an.

---

## 10. Sicherheit

- Zugangsdaten (App-Passwort, Google-Refresh-Token, Kontonamen) liegen **AES-256-GCM-verschlüsselt**
  in der Datenbank. Der Schlüssel kommt ausschließlich als Docker Secret.
- Keine Secrets im Repository: `.env` und `secrets/*` sind ausgeschlossen, `.env.example` enthält
  nur Platzhalter.
- Login-Schutz für die gesamte Oberfläche und alle Verwaltungs-Endpunkte. Das Admin-Passwort wird
  mit Argon2 geprüft. Sessions liegen serverseitig. Das Cookie ist `HttpOnly`, `SameSite=Lax` und
  bei HTTPS `Secure` mit `__Host-`-Präfix. Fehlversuche werden pro IP und global begrenzt.
- CSRF-Schutz: Token-Header bei jeder Änderung plus Prüfung von `Origin`/`Referer`.
- OAuth: PKCE, an die Session gebundener, einmal verwendbarer `state` mit 10 Minuten Gültigkeit.
- iCloud-Zugangsdaten werden nur an `*.icloud.com` über HTTPS gesendet. Weiterleitungen anderswohin
  werden verweigert. XML-Antworten werden gegen XXE- und Entity-Angriffe gehärtet gelesen.
- Strikte Security-Header (CSP ohne externe Quellen, `frame-ancestors 'none'`, HSTS bei HTTPS).
- Keine externen Dienste außer Apple iCloud und Google Calendar. Keine CDNs, keine Telemetrie.
- Der Google-Zielkalender wird nie freigegeben. Die Anwendung hat dafür nicht einmal die Rechte.

---

## 11. Bekannte Einschränkungen

- **Zugriff auf privat geteilte Kalender hängt von Apple ab.** Apple dokumentiert die
  CalDAV-Schnittstelle von iCloud nicht offiziell. Die Diagnose zeigt den tatsächlichen Stand für
  dein Konto.
- **Nur Lesen:** Die Freigabe kann „nur lesen“ sein. Das reicht, weil die Anwendung nie schreibt.
- **Erinnerungen:** Nur Erinnerungen relativ zum Beginn oder mit festem Zeitpunkt vor Beginn,
  höchstens 5, höchstens 4 Wochen vorher. Erinnerungen relativ zum Ende kennt Google nicht.
  Alle werden als Popup-Erinnerung angelegt.
- **Erinnerungen eines geteilten Kalenders** stammen oft vom Eigentümer. Wer sie nicht will:
  *Synchronisierung → Erinnerungen übernehmen* ausschalten.
- **Exotische Zeitzonen:** Eigene `VTIMEZONE`-Definitionen ohne IANA-Namen werden auf die
  eingestellte Standardzone abgebildet, wenn der Versatz passt, sonst auf UTC.
- **Wiederholungen mit `RDATE` als Zeitraum** (`PERIOD`) lassen sich in Google nicht abbilden und
  werden ausgelassen.
- **Anhänge, Teilnehmer, Videokonferenz-Links** werden bewusst nicht übertragen.
- **„Weitere Kalender“:** siehe Hinweis in [Abschnitt 6](#6-ersteinrichtung-in-der-weboberfläche).
- **Ein Ziel pro Kalender:** Mehrere iCloud-Kalender in **einen** Google-Kalender zu schreiben, ist
  nicht vorgesehen. Jeder Google-Kalender gehört genau einem iCloud-Kalender, damit Löschungen
  und die Sicherheitsgrenze eindeutig bleiben.

---

## 12. Entwicklung und Tests

```sh
# Backend
cd backend
python -m venv .venv && .venv/Scripts/activate        # Linux/macOS: . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                     # alle Tests, nur mit Fake-iCloud/Fake-Google
ruff check app tests && mypy

# Lokal starten (ohne Docker)
set APP_ENCRYPTION_KEY=...   ADMIN_PASSWORD=...  DATABASE_URL=sqlite:///./dev.db  APP_BASE_URL=http://localhost:5173
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm ci
npm run dev                # http://localhost:5173, /api wird an :8000 weitergereicht
npm test && npm run typecheck && npm run build
```

Die Tests verwenden ausschließlich nachgebaute Server (`backend/tests/fakes.py`) und berühren keine
echten Kalender. Abgedeckt sind unter anderem: neue, geänderte und gelöschte Termine, Duplikate
nach Datenverlust, Serien mit Ausnahmen und Absagen, Zeitzonenwechsel, ganztägige Termine,
Sommer-/Winterzeit, API-Fehler, Rate-Limits, abgelaufene und widerrufene Google-Tokens, nicht
erreichbares iCloud, fehlende Freigaben, Teilausfälle, Löschschutz, Parallelläufe sowie
Login/CSRF/OAuth-State.

Projektstruktur und API: [`docs/api.md`](docs/api.md). Änderungen für Anwender: [`CHANGELOG.md`](CHANGELOG.md).
