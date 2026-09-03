/**
 * Simple Analytics archive inside the Google Sheet, built from the CSVs.
 *
 * Runs on Apps Script, that is on Google's servers. Every night it looks in a
 * Drive folder, takes the CSVs it finds there, piles them up in the sheet and
 * moves the files it has already digested into a subfolder.
 *
 * WHY FROM THE CSVS AND NOT FROM THE API. The Simple Analytics Export API
 * wants an sa_api_key_ / sa_user_id_ pair that the free plan does not give.
 * The URL the dashboard shows in the browser works only there, because it
 * carries the session cookie with it: called from outside it answers "No
 * permission to access data". Checked on 19 August 2026.
 *
 * So the download stays manual, and it is the only manual piece: download the
 * CSV and drop it into the folder. Everything else happens on its own.
 *
 * WHY IT IS NEEDED. The Simple Analytics free plan keeps 30 DAYS and then
 * deletes. The sheet is not a mirror of the dashboard: it is the archive,
 * and it is the only place where data older than a month keeps on
 * existing. That is why the script never deletes rows it is not
 * rewriting with data that has just arrived.
 *
 * WHAT IT DOES ON EVERY RUN
 *   1. looks for the CSV files in the inbox folder
 *   2. for each one, reads which DAYS it contains
 *   3. rewrites those days in the sheets, leaving everything else untouched
 *   4. recomputes the aggregates for those days from the raw rows
 *   5. moves the file into "importati", so it does not get read again
 *
 * Loading the same file twice duplicates nothing. Loading periods that
 * overlap does not either: the file that arrived last always wins, and it is
 * also the most settled one.
 *
 * CONFIGURATION, in the Script Properties (Project Settings):
 *   SA_CARTELLA   optional, name of the folder on Drive.
 *                 Default "Simple Analytics export".
 * No credentials: none are needed and none should be put in.
 */

var CARTELLA_DEFAULT = 'Simple Analytics export';
// "importati" is the Drive subfolder the digested files are moved into: the
// name has to match the folder, so it stays in Italian.
var SOTTOCARTELLA_FATTI = 'importati';
var FUSO = 'Europe/Rome';

// The columns of the raw sheet. The CSV can carry more of them or fewer and
// in any order: they are mapped by NAME reading the file header, and the ones
// that are missing stay empty instead of breaking the import.
var CAMPI = [
  'added_date', 'added_iso', 'datapoint', 'path', 'query',
  'document_referrer', 'referrer_hostname', 'utm_source', 'utm_medium',
  'utm_campaign', 'country_code', 'device_type', 'browser_name', 'os_name',
  'lang_language', 'is_unique', 'session_id', 'duration_seconds',
  'scrolled_percentage', 'uuid'
];

// Sheet tab names, kept as they are: they have to match the tabs in the Sheet.
var TAB_GREZZI = 'SA Grezzi';
var TAB_LOG = 'SA Log';

// The "nome" values are tab names and stay as they are; "titolo" is the
// header cell written at the top of the second column.
var AGGREGATI = [
  { nome: 'SA Totali',   etichetta: null,                titolo: null },
  { nome: 'SA Pagine',   etichetta: 'path',              titolo: 'page' },
  { nome: 'SA Referrer', etichetta: 'referrer_hostname', titolo: 'referrer' },
  { nome: 'SA UTM',      etichetta: 'utm_source',        titolo: 'utm_source' }
];

// ---------------------------------------------------------------------------
// The commands you use
// ---------------------------------------------------------------------------

/** The entry point of the nightly trigger. */
function importaNuoviCsv() {
  var cartella = trovaCartella_();
  var file = cartella.getFilesByType(MimeType.CSV);

  var elenco = [];
  while (file.hasNext()) elenco.push(file.next());

  // The CSVs Drive does not recognise as such (it happens when the browser
  // saves them as text/plain) have to be taken too, or they sit there forever.
  var altri = cartella.getFilesByType(MimeType.PLAIN_TEXT);
  while (altri.hasNext()) {
    var f = altri.next();
    if (f.getName().toLowerCase().indexOf('.csv') >= 0) elenco.push(f);
  }

  if (!elenco.length) {
    scriviLog_('import', 0, 'no new file in the folder "' + cartella.getName() + '"');
    return;
  }

  // Oldest to newest: if two files cover the same day, the one loaded last
  // has to be the one that stays.
  elenco.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });

  var fatti = 0, righeTotali = 0, problemi = [];
  for (var i = 0; i < elenco.length; i++) {
    try {
      righeTotali += importaFile_(elenco[i]);
      archivia_(elenco[i], cartella);
      fatti++;
    } catch (e) {
      // A broken file must not block the others, and must not be archived:
      // it stays in the folder so it can be found again and looked at.
      problemi.push(elenco[i].getName() + ' (' + e.message + ')');
    }
  }

  var esito = fatti + ' files imported, ' + righeTotali + ' rows';
  if (problemi.length) esito += '; FAILED: ' + problemi.join(', ');
  scriviLog_('import', fatti, esito);
}

/**
 * Reads the first CSV in the folder and says what it contains, without
 * writing anything in the sheet and without moving the file. It is the check
 * to run first.
 */
function provaPrimoFile() {
  var cartella = trovaCartella_();
  var file = cartella.getFiles();
  if (!file.hasNext()) return 'The folder "' + cartella.getName() + '" is empty.';

  var f = file.next();
  var letto = leggiCsv_(f);
  var giorni = {};
  var tipi = {};
  for (var i = 0; i < letto.righe.length; i++) {
    giorni[letto.righe[i].added_date] = (giorni[letto.righe[i].added_date] || 0) + 1;
    var t = letto.righe[i].datapoint || '(empty)';
    tipi[t] = (tipi[t] || 0) + 1;
  }

  var out = [];
  out.push('File: ' + f.getName());
  out.push('Valid rows: ' + letto.righe.length);
  out.push('Columns found: ' + letto.intestazioni.join(', '));
  var mancanti = [];
  for (var c = 0; c < CAMPI.length; c++) {
    if (letto.intestazioni.indexOf(CAMPI[c]) < 0) mancanti.push(CAMPI[c]);
  }
  out.push('Expected columns missing: ' + (mancanti.length ? mancanti.join(', ') : 'none'));
  out.push('');
  out.push('Values of the "datapoint" column:');
  for (var t2 in tipi) out.push('   ' + t2 + ': ' + tipi[t2]);
  out.push('');
  out.push('Days covered:');
  var chiavi = Object.keys(giorni).sort();
  for (var g = 0; g < chiavi.length; g++) out.push('   ' + chiavi[g] + ': ' + giorni[chiavi[g]]);

  var testo = out.join('\n');
  Logger.log(testo);
  return testo;
}

/** Installs the nightly trigger. Running it twice does not double it. */
function installaTriggerGiornaliero() {
  var esistenti = ScriptApp.getProjectTriggers();
  for (var i = 0; i < esistenti.length; i++) {
    if (esistenti[i].getHandlerFunction() === 'importaNuoviCsv') {
      ScriptApp.deleteTrigger(esistenti[i]);
    }
  }
  ScriptApp.newTrigger('importaNuoviCsv')
           .timeBased().atHour(5).everyDays(1).inTimezone(FUSO).create();
  Logger.log('Trigger installed: every night between 5 and 6.');
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

function importaFile_(file) {
  var letto = leggiCsv_(file);
  if (!letto.righe.length) throw new Error('no row with a readable date');

  // The days to rewrite are the ones the file contains, and only those.
  var toccate = {};
  for (var i = 0; i < letto.righe.length; i++) toccate[letto.righe[i].added_date] = true;

  scriviGrezzi_(letto.righe, toccate);
  scriviAggregati_(letto.righe, toccate);
  return letto.righe.length;
}

/**
 * Reads the CSV and maps it onto the expected fields, by column name.
 *
 * The day comes from "added_date" if it is there, otherwise from the first
 * ten characters of "added_iso": that way the file works anyway, even if the
 * export was made with a different choice of fields.
 */
function leggiCsv_(file) {
  var testo = file.getBlob().getDataAsString('UTF-8');
  var tabella = Utilities.parseCsv(testo);
  if (!tabella.length) return { intestazioni: [], righe: [] };

  var intestazioni = tabella[0];
  var indice = {};
  for (var c = 0; c < intestazioni.length; c++) {
    indice[String(intestazioni[c]).trim()] = c;
  }

  var righe = [];
  for (var r = 1; r < tabella.length; r++) {
    var grezza = tabella[r];
    if (!grezza || !grezza.length) continue;

    var riga = {};
    for (var k = 0; k < CAMPI.length; k++) {
      var pos = indice[CAMPI[k]];
      riga[CAMPI[k]] = pos === undefined ? '' : String(grezza[pos] === undefined ? '' : grezza[pos]);
    }

    if (!riga.added_date && riga.added_iso) {
      riga.added_date = riga.added_iso.slice(0, 10);
    }
    // A row without a date has no place in the archive: it gets dropped
    // instead of landing at the bottom of the sheet with an empty key.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(riga.added_date)) continue;

    righe.push(riga);
  }
  return { intestazioni: intestazioni, righe: righe };
}

function scriviGrezzi_(righe, toccate) {
  var valori = [];
  for (var i = 0; i < righe.length; i++) {
    if (!toccate[righe[i].added_date]) continue;
    var riga = [];
    for (var c = 0; c < CAMPI.length; c++) riga.push(righe[i][CAMPI[c]]);
    valori.push(riga);
  }
  riversa_({ nome: TAB_GREZZI, colonne: CAMPI }, valori, toccate);
}

/**
 * Recomputes the four sheets day by day starting from the raw rows.
 *
 * "visitors" is the count of the rows marked is_unique, which is how Simple
 * Analytics itself defines a visitor: the first page seen in a session. It is
 * not a person followed over time, and without cookies it cannot be.
 */
function scriviAggregati_(righe, toccate) {
  for (var a = 0; a < AGGREGATI.length; a++) {
    var agg = AGGREGATI[a];
    var conti = {};

    for (var i = 0; i < righe.length; i++) {
      var riga = righe[i];
      if (!toccate[riga.added_date]) continue;
      if (!eUnaPagina_(riga)) continue;

      var etichetta = agg.etichetta ? (riga[agg.etichetta] || '(none)') : '';
      var chiave = riga.added_date + ' ' + etichetta;
      if (!conti[chiave]) {
        conti[chiave] = { data: riga.added_date, etichetta: etichetta, pv: 0, vis: 0 };
      }
      conti[chiave].pv += 1;
      if (String(riga.is_unique).toLowerCase() === 'true') conti[chiave].vis += 1;
    }

    var valori = [];
    for (var k in conti) {
      var c = conti[k];
      valori.push(agg.etichetta ? [c.data, c.etichetta, c.pv, c.vis] : [c.data, c.pv, c.vis]);
    }

    // The days the file covers but with no pageview at all have to be written
    // as zero in the totals sheet: it is that row that says "this day has
    // been looked at already", and it tells an empty day from a missing one.
    if (!agg.etichetta) {
      var visti = {};
      for (var v = 0; v < valori.length; v++) visti[valori[v][0]] = true;
      for (var g in toccate) if (!visti[g]) valori.push([g, 0, 0]);
    }

    var colonne = agg.etichetta
      ? ['date', agg.titolo, 'pageviews', 'visitors']
      : ['date', 'pageviews', 'visitors'];
    riversa_({ nome: agg.nome, colonne: colonne }, valori, toccate);
  }
}

/**
 * Tells a pageview from an event. The export brings both when you ask for
 * "type=all", and the "datapoint" column says which is which. The exact value
 * used for pages shows up by running provaPrimoFile() on the real data: here
 * both "pageview" and the empty cell are accepted, so the count holds in
 * either case instead of going to zero in silence.
 */
function eUnaPagina_(riga) {
  var d = String(riga.datapoint === undefined ? '' : riga.datapoint).toLowerCase();
  return d === '' || d === 'pageview' || d === 'pageviews';
}

/**
 * Takes out of the sheet the rows of the days contained in the file, puts the
 * new ones in their place and rewrites them in date order. The rows of the
 * days not touched are never rewritten nor deleted.
 *
 * It rewrites only the TAIL of the sheet, from the first row with a date
 * greater than or equal to the oldest day touched: that way the old history
 * is not even read again, and that is what keeps the run short once the raw
 * sheet has reached tens of thousands of rows.
 */
function riversa_(scheda, righeNuove, dateToccate) {
  var foglio = prendiScheda_(scheda);
  var nCol = scheda.colonne.length;
  var ultimaRiga = foglio.getLastRow();

  var minToccata = null;
  for (var g in dateToccate) if (minToccata === null || g < minToccata) minToccata = g;
  if (minToccata === null) return;

  var esistenti = [];
  if (ultimaRiga > 1) esistenti = foglio.getRange(2, 1, ultimaRiga - 1, nCol).getValues();

  var inizioCoda = esistenti.length;
  for (var i = 0; i < esistenti.length; i++) {
    if (normalizzaData_(esistenti[i][0]) >= minToccata) { inizioCoda = i; break; }
  }

  var tenute = [];
  for (var j = inizioCoda; j < esistenti.length; j++) {
    var data = normalizzaData_(esistenti[j][0]);
    if (!data) continue;
    esistenti[j][0] = data;
    if (!dateToccate[data]) tenute.push(esistenti[j]);
  }

  var soloToccate = [];
  for (var k = 0; k < righeNuove.length; k++) {
    if (dateToccate[righeNuove[k][0]]) soloToccate.push(righeNuove[k]);
  }

  var coda = tenute.concat(soloToccate);
  coda.sort(function (a, b) {
    if (a[0] === b[0]) return String(a[1]) < String(b[1]) ? -1 : 1;
    return a[0] < b[0] ? -1 : 1;
  });

  var primaRigaFoglio = 2 + inizioCoda;
  var daPulire = esistenti.length - inizioCoda;
  if (daPulire > 0) foglio.getRange(primaRigaFoglio, 1, daPulire, nCol).clearContent();
  if (coda.length) foglio.getRange(primaRigaFoglio, 1, coda.length, nCol).setValues(coda);
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function trovaCartella_() {
  var nome = PropertiesService.getScriptProperties().getProperty('SA_CARTELLA')
             || CARTELLA_DEFAULT;
  var trovate = DriveApp.getFoldersByName(nome);
  if (!trovate.hasNext()) {
    throw new Error('Folder "' + nome + '" not found on Drive. ' +
                    'Create it, or change the SA_CARTELLA property.');
  }
  return trovate.next();
}

/** Moves the file into "importati", so the next run does not read it again. */
function archivia_(file, cartella) {
  var sotto = cartella.getFoldersByName(SOTTOCARTELLA_FATTI);
  var destinazione = sotto.hasNext() ? sotto.next()
                                     : cartella.createFolder(SOTTOCARTELLA_FATTI);
  destinazione.addFile(file);
  cartella.removeFile(file);
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/**
 * Finds the sheet or creates it with the right headers. The first two columns
 * are formatted as text: without that, the sheet turns "2026-08-19" into a
 * date and the keys stop matching on the next run.
 */
function prendiScheda_(scheda) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var foglio = libro.getSheetByName(scheda.nome);
  if (!foglio) {
    foglio = libro.insertSheet(scheda.nome);
    foglio.getRange(1, 1, 1, scheda.colonne.length)
          .setValues([scheda.colonne]).setFontWeight('bold');
    foglio.setFrozenRows(1);
    foglio.getRange(1, 1, foglio.getMaxRows(), 2).setNumberFormat('@');
  }
  return foglio;
}

function normalizzaData_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, FUSO, 'yyyy-MM-dd');
  return String(v).trim();
}

function scriviLog_(etichetta, quanti, esito) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var foglio = libro.getSheetByName(TAB_LOG);
  if (!foglio) {
    foglio = libro.insertSheet(TAB_LOG);
    foglio.getRange(1, 1, 1, 4)
          .setValues([['when', 'command', 'file', 'outcome']]).setFontWeight('bold');
    foglio.setFrozenRows(1);
  }
  foglio.appendRow([
    Utilities.formatDate(new Date(), FUSO, 'yyyy-MM-dd HH:mm:ss'),
    etichetta, quanti, esito
  ]);
  Logger.log(etichetta + ': ' + esito);
}
