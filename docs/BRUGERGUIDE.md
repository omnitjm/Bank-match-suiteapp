# Bank Match SuiteApp — Brugerguide

## Indholdsfortegnelse
1. [Hvad er Bank Match?](#1-hvad-er-bank-match)
2. [Adgang til appen — uden at gå i Scripts](#2-adgang-til-appen--uden-at-gå-i-scripts)
3. [Tilføj Bank Match til dit Dashboard](#3-tilføj-bank-match-til-dit-dashboard)
4. [Første opsætning (Setup-siden)](#4-første-opsætning-setup-siden)
5. [Daglig brug — Reconciliation Dashboard](#5-daglig-brug--reconciliation-dashboard)
6. [Import af banktransaktioner (CSV)](#6-import-af-banktransaktioner-csv)
7. [Godkendelse af matchforslag](#7-godkendelse-af-matchforslag)
8. [Manuel matching](#8-manuel-matching)
9. [Historik og fejlsøgning](#9-historik-og-fejlsøgning)

---

## 1. Hvad er Bank Match?

Bank Match er en NetSuite SuiteApp, der automatisk matcher banktransaktioner med NetSuite-posteringer (betalinger, fakturaer, journalindførsler). Den sparer tid ved at:

- Importere CSV-udtog fra din bank
- Automatisk foreslå matches baseret på beløb og dato
- Lade en godkender bekræfte matches inden de bogføres
- Oprette journalindførsler for ukendte transaktioner

---

## 2. Adgang til appen — uden at gå i Scripts

Appen har to sider, som begge er tilgængelige via **NetSuites menu-system**:

### Bank Match Setup (konfiguration)
**Customization > Scripting > Scripts > Deployments**
Find deployment'et **"Bank Match – Setup"** og klik pa linket i kolonnen **URL**.

Eller skriv direkte i adresselinjen (erstat `ACCOUNT_ID` med dit NetSuite konto-ID):
```
https://ACCOUNT_ID.app.netsuite.com/app/site/hosting/scriptlet.nl?script=customscript_bm_setup_sl&deploy=customdeploy_bm_setup_sl
```

### Bank Match Dashboard (daglig brug)
**Customization > Scripting > Scripts > Deployments**
Find **"Bank Match – Reconciliation"** og klik pa URL-linket.

> **Tip:** Gem begge URL'er som bogmarker i din browser — det er den hurtigste adgang.

---

## 3. Tilføj Bank Match til dit Dashboard

Du kan pinne et genvejslink pa dit NetSuite Home-dashboard, sa du altid har det med et klik:

### Trin-for-trin:

**1. Gå til dit Home Dashboard**
Klik pa **Home**-ikonet oppe til venstre i NetSuite.

**2. Tilpas dashboardet**
Klik pa **Personalise** (eller tandhjulet / "Personalise Page") ude til højre pa siden.

**3. Tilføj en Shortcut-portlet**
- Klik pa **+ Add Content** (eller "Add Portlets")
- Søg efter **"Shortcuts"** og tilføj den
- Klik **Done**

**4. Rediger Shortcuts-portletten**
Klik pa blyant-ikonet pa Shortcuts-portletten.

**5. Tilføj dit link**
- Klik **Add Shortcut**
- I feltet **URL**: indsæt URL'en til Bank Match Dashboard (se afsnit 2)
- I feltet **Label**: skriv f.eks. `Bank Match`
- Klik **Save**

Nu vises "Bank Match" som et klikbart link pa dit dashboard.

---

## 4. Første opsætning (Setup-siden)

Åbn **Bank Match Setup** (se afsnit 2). Du skal udfylde følgende felter:

### Bank Settings
| Felt | Hvad du skal vælge |
|------|-------------------|
| **Bank Account** | Den GL-konto i NetSuite der svarer til din bankkonto (f.eks. "Bank — Driftskonto") |
| **Subsidiary** | Din virksomhed / datterselskab. Lad sta blankt for at matche pa tværs af alle |

### Matching Tolerances
| Felt | Anbefaling |
|------|-----------|
| **Amount Tolerance** | Maksimal forskel i kroner/øre — f.eks. `0,01` for nul tolerance, eller `50,00` for at tillade gebyrforskelle |
| **Date Tolerance (days)** | Antal dage forskel tilladt — `5` er standard og dækker de fleste valørforskelle |
| **Auto-suggest Matches on Import** | Sæt hak her for at systemet automatisk foreslår matches ved CSV-import |

### Approval Settings
| Felt | Beskrivelse |
|------|------------|
| **Approver** | Vælg den medarbejder der skal godkende alle matches inden bogføring |

### Advanced — GL Account Defaults
| Felt | Hvornår skal du udfylde det |
|------|---------------------------|
| **Default Bank Fee Account** | Udfyld hvis du vil at kursforskelle/gebyrer bogføres pa en bestemt konto automatisk |
| **Default Suspense Account** | Konto der foreslås ved manuel matching af uidentificerede posteringer |

### Mandatory Segment Defaults
Udfyld kun disse felter, hvis NetSuite tvinger dig til at angive Afdeling, Klasse eller Lokation pa alle linjer i en journalindførsel:

| Felt | Udfyld hvis... |
|------|---------------|
| **Default Department** | Afdeling er obligatorisk i jeres opsætning |
| **Default Class** | Klasse er obligatorisk |
| **Default Location** | Lokation er obligatorisk |

Klik **Save Settings** når alt er udfyldt. Du ser en grøn bekræftelsesbesked.

---

## 5. Daglig brug — Reconciliation Dashboard

Åbn **Bank Match Dashboard** (se afsnit 2).

### Oversigtsvisning (Global Overview)
Første gang du åbner dashboardet vises en oversigt over **alle bankkonti** pa tværs af alle selskaber med:

| Kolonne | Beskrivelse |
|---------|------------|
| Subsidiary | Selskab |
| Account Name | GL bankkontonavn |
| Unmatched Lines | Antal ikke-matchede banklinjer |
| Pending Proposals | Antal forslag der venter godkendelse |
| Go to Matching | Link til matching-arbejdspladsen for den konto |

Klik **Go to Matching** for at gå ind pa en specifik konto.

### Matching Workspace (3 faner)

**Fane 1 — Pending Approvals**
Viser alle matchforslag der venter din godkendelse. Du kan:
- Sætte hak i **Approve**-kolonnen på individuelle linjer
- Klikke **Approve All** for at godkende alle på én gang
- Klikke **Reject** for at afvise et forslag

**Fane 2 — Unmatched Lines**
Viser banklinjer der ingen automatisk match har fået. For hver linje kan du:
- Klikke **Manual Match** for at finde og vælge et NetSuite-bilag manuelt
- Se beløb, dato, beskrivelse og reference fra banken

**Fane 3 — History**
Viser alle afsluttede matches:
- Applied (bogført)
- Rejected (afvist)
- Failed (fejlede ved bogføring)

---

## 6. Import af banktransaktioner (CSV)

For at hente bankdata ind i systemet:

1. Download et **CSV-udtog** fra din netbank
2. Pa Matching Workspace: klik **Import Bank Lines**
3. Upload din CSV-fil
4. Systemet opretter banklinjer og (hvis Auto-suggest er slået til) foreslår automatisk matches

**CSV-format:** Filen skal indeholde kolonnerne: `Date`, `Description`, `Amount`, `Reference`.
Beløb er positive for indbetalinger og negative for udbetalinger.

---

## 7. Godkendelse af matchforslag

Kun brugeren defineret som **Approver** i Setup kan godkende forslag.

1. Gå til **Pending Approvals** (Fane 1)
2. Gennemgå hvert forslag — systemet viser:
   - Bankens beløb og dato
   - NetSuite-bilagets beløb og dato
   - Eventuel difference (variance)
3. Sæt hak i **Approve** ud for de forslag du vil godkende
4. Klik **Save** eller **Approve All**
5. Godkendte forslag bogføres automatisk via Reconcile-scriptet

---

## 8. Manuel matching

Hvis et bankindslag ikke er matchet automatisk:

1. Gå til **Unmatched Lines** (Fane 2)
2. Klik **Manual Match** ud for banklinjens
3. I match-vinduet:
   - Søg efter det relevante NetSuite-bilag (faktura, betaling osv.)
   - Eller vælg **GL Account** for at oprette en journalindførsel direkte
4. Udfyld eventuelle obligatoriske felter (Department, Class, Location)
5. Klik **Create Proposal** — forslaget sendes til godkendelse

---

## 9. Historik og fejlsøgning

**Se bogføringshistorik:** Fane 3 (History) viser alle behandlede matches med status og dato.

**Hvis et match fejlede (status: Failed):**
1. Klik pa linket i History for at se fejlbeskeden
2. Typiske årsager:
   - Manglende obligatorisk segment (Afdeling/Klasse/Lokation) — ret i Setup
   - Bogføringslåst periode — åbn perioden i NetSuite først
   - Utilstrækkelige rettigheder — kontakt din NetSuite-administrator

**Adgang til scripts (kun administrator):**
`Customization > Scripting > Scripts` — Her kan du se logs under fanen **Execution Log** på hvert script.

---

*Bank Match SuiteApp — intern dokumentation*
