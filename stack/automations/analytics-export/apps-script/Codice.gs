/**
 * Archivio di Simple Analytics dentro il Google Sheet, partendo dai CSV.
 *
 * Gira su Apps Script, cioe' sui server di Google. Ogni notte guarda in una
 * cartella di Drive, prende i CSV che ci trova, li accumula nel foglio e
 * sposta i file gia' digeriti in una sottocartella.
 *
 * PERCHE' DAI CSV E NON DALL'API. L'Export API di Simple Analytics vuole una
 * coppia sa_api_key_ / sa_user_id_ che il piano gratuito non da'. La URL che
 * la dashboard mostra nel browser funziona solo li', perche' si porta dietro
 * il cookie di sessione: chiamata da fuori risponde «No permission to access
 * data». Verificato il 19/08/2026.
 *
 * Quindi il download resta a mano, ed e' l'unico pezzo a mano: scaricare il
 * CSV e lasciarlo cadere nella cartella. Tutto il resto succede da solo.
 *
 * PERCHE' SERVE. Il piano gratuito di Simple Analytics conserva 30 GIORNI e
 * poi cancella. Il foglio non e' uno specchio della dashboard: e' l'archivio,
 * ed e' l'unico posto dove i dati piu' vecchi di un mese continuano a
 * esistere. Per questo lo script non cancella mai righe che non stia
 * riscrivendo con dati appena arrivati.
 *
 * COSA FA A OGNI CORSA
 *   1. cerca i file CSV nella cartella d'ingresso
 *   2. per ognuno, legge quali GIORNI contiene
 *   3. riscrive quei giorni nelle schede, lasciando intatto tutto il resto
 *   4. ricalcola gli aggregati di quei giorni dai grezzi
 *   5. sposta il file in «importati», cosi' non viene riletto
 *
 * Caricare due volte lo stesso file non duplica niente. Caricare periodi che
 * si sovrappongono nemmeno: vince sempre il file arrivato per ultimo, che e'
 * anche il piu' assestato.
 *
 * CONFIGURAZIONE, nelle Proprieta' script (Impostazioni progetto):
 *   SA_CARTELLA   facoltativa, nome della cartella su Drive.
 *                 Default «Simple Analytics export».
 * Nessuna credenziale: non ce n'e' bisogno e non ne va messa nessuna.
 */

var CARTELLA_DEFAULT = 'Simple Analytics export';
var SOTTOCARTELLA_FATTI = 'importati';
var FUSO = 'Europe/Rome';

// Le colonne della scheda dei grezzi. Il CSV puo' averne di piu' o di meno e
// in qualsiasi ordine: si mappa per NOME leggendo l'intestazione del file, e
// quelle che mancano restano vuote invece di far saltare l'importazione.
var CAMPI = [
  'added_date', 'added_iso', 'datapoint', 'path', 'query',
  'document_referrer', 'referrer_hostname', 'utm_source', 'utm_medium',
  'utm_campaign', 'country_code', 'device_type', 'browser_name', 'os_name',
  'lang_language', 'is_unique', 'session_id', 'duration_seconds',
  'scrolled_percentage', 'uuid'
];

var TAB_GREZZI = 'SA Grezzi';
var TAB_LOG = 'SA Log';

var AGGREGATI = [
  { nome: 'SA Totali',   etichetta: null,                titolo: null },
  { nome: 'SA Pagine',   etichetta: 'path',              titolo: 'pagina' },
  { nome: 'SA Referrer', etichetta: 'referrer_hostname', titolo: 'referrer' },
  { nome: 'SA UTM',      etichetta: 'utm_source',        titolo: 'utm_source' }
];

// ---------------------------------------------------------------------------
// I comandi che si usano
// ---------------------------------------------------------------------------

/** Il punto di ingresso del trigger notturno. */
function importaNuoviCsv() {
  var cartella = trovaCartella_();
  var file = cartella.getFilesByType(MimeType.CSV);

  var elenco = [];
  while (file.hasNext()) elenco.push(file.next());

  // Anche i CSV che Drive non riconosce come tali (capita quando il browser
  // li salva come text/plain) vanno presi, altrimenti restano li' per sempre.
  var altri = cartella.getFilesByType(MimeType.PLAIN_TEXT);
  while (altri.hasNext()) {
    var f = altri.next();
    if (f.getName().toLowerCase().indexOf('.csv') >= 0) elenco.push(f);
  }

  if (!elenco.length) {
    scriviLog_('importa', 0, 'nessun file nuovo nella cartella «' + cartella.getName() + '»');
    return;
  }

  // Dal piu' vecchio al piu' recente: se due file coprono lo stesso giorno,
  // deve restare quello caricato per ultimo.
  elenco.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });

  var fatti = 0, righeTotali = 0, problemi = [];
  for (var i = 0; i < elenco.length; i++) {
    try {
      righeTotali += importaFile_(elenco[i]);
      archivia_(elenco[i], cartella);
      fatti++;
    } catch (e) {
      // Un file rotto non deve bloccare gli altri, e non va archiviato:
      // resta nella cartella cosi' lo si ritrova e lo si guarda.
      problemi.push(elenco[i].getName() + ' (' + e.message + ')');
    }
  }

  var esito = fatti + ' file importati, ' + righeTotali + ' righe';
  if (problemi.length) esito += '; NON riusciti: ' + problemi.join(', ');
  scriviLog_('importa', fatti, esito);
}

/**
 * Legge il primo CSV della cartella e dice cosa contiene, senza scrivere
 * niente nel foglio e senza spostare il file. E' la prova da fare per prima.
 */
function provaPrimoFile() {
  var cartella = trovaCartella_();
  var file = cartella.getFiles();
  if (!file.hasNext()) return 'La cartella «' + cartella.getName() + '» e\' vuota.';

  var f = file.next();
  var letto = leggiCsv_(f);
  var giorni = {};
  var tipi = {};
  for (var i = 0; i < letto.righe.length; i++) {
    giorni[letto.righe[i].added_date] = (giorni[letto.righe[i].added_date] || 0) + 1;
    var t = letto.righe[i].datapoint || '(vuoto)';
    tipi[t] = (tipi[t] || 0) + 1;
  }

  var out = [];
  out.push('File: ' + f.getName());
  out.push('Righe valide: ' + letto.righe.length);
  out.push('Colonne trovate: ' + letto.intestazioni.join(', '));
  var mancanti = [];
  for (var c = 0; c < CAMPI.length; c++) {
    if (letto.intestazioni.indexOf(CAMPI[c]) < 0) mancanti.push(CAMPI[c]);
  }
  out.push('Colonne attese che mancano: ' + (mancanti.length ? mancanti.join(', ') : 'nessuna'));
  out.push('');
  out.push('Valori della colonna «datapoint»:');
  for (var t2 in tipi) out.push('   ' + t2 + ': ' + tipi[t2]);
  out.push('');
  out.push('Giorni coperti:');
  var chiavi = Object.keys(giorni).sort();
  for (var g = 0; g < chiavi.length; g++) out.push('   ' + chiavi[g] + ': ' + giorni[chiavi[g]]);

  var testo = out.join('\n');
  Logger.log(testo);
  return testo;
}

/** Installa il trigger notturno. Lanciarlo due volte non lo sdoppia. */
function installaTriggerGiornaliero() {
  var esistenti = ScriptApp.getProjectTriggers();
  for (var i = 0; i < esistenti.length; i++) {
    if (esistenti[i].getHandlerFunction() === 'importaNuoviCsv') {
      ScriptApp.deleteTrigger(esistenti[i]);
    }
  }
  ScriptApp.newTrigger('importaNuoviCsv')
           .timeBased().atHour(5).everyDays(1).inTimezone(FUSO).create();
  Logger.log('Trigger installato: ogni notte fra le 5 e le 6.');
}

// ---------------------------------------------------------------------------
// Il lavoro
// ---------------------------------------------------------------------------

function importaFile_(file) {
  var letto = leggiCsv_(file);
  if (!letto.righe.length) throw new Error('nessuna riga con una data leggibile');

  // I giorni da riscrivere sono quelli che il file contiene, e solo quelli.
  var toccate = {};
  for (var i = 0; i < letto.righe.length; i++) toccate[letto.righe[i].added_date] = true;

  scriviGrezzi_(letto.righe, toccate);
  scriviAggregati_(letto.righe, toccate);
  return letto.righe.length;
}

/**
 * Legge il CSV e lo mappa sui campi attesi, per nome di colonna.
 *
 * La data del giorno viene da «added_date» se c'e', altrimenti dai primi
 * dieci caratteri di «added_iso»: cosi' il file va bene comunque, anche se
 * l'export e' stato fatto con una scelta di campi diversa.
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
    // Una riga senza data non e' collocabile nell'archivio: si scarta invece
    // di finire in fondo al foglio con la chiave vuota.
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
 * Ricalcola le quattro schede per giorno a partire dai grezzi.
 *
 * «visitors» e' il conteggio delle righe marcate is_unique, che e' come Simple
 * Analytics stessa definisce il visitatore: la prima pagina vista in una
 * sessione. Non e' una persona seguita nel tempo, e senza cookie non puo'
 * esserlo.
 */
function scriviAggregati_(righe, toccate) {
  for (var a = 0; a < AGGREGATI.length; a++) {
    var agg = AGGREGATI[a];
    var conti = {};

    for (var i = 0; i < righe.length; i++) {
      var riga = righe[i];
      if (!toccate[riga.added_date]) continue;
      if (!eUnaPagina_(riga)) continue;

      var etichetta = agg.etichetta ? (riga[agg.etichetta] || '(nessuno)') : '';
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

    // I giorni coperti dal file ma senza nessuna pagina vista vanno scritti a
    // zero nella scheda dei totali: e' quella riga a dire «questo giorno c'e'
    // gia' stato guardato», e distingue un giorno vuoto da un giorno mancante.
    if (!agg.etichetta) {
      var visti = {};
      for (var v = 0; v < valori.length; v++) visti[valori[v][0]] = true;
      for (var g in toccate) if (!visti[g]) valori.push([g, 0, 0]);
    }

    var colonne = agg.etichetta
      ? ['data', agg.titolo, 'pageviews', 'visitors']
      : ['data', 'pageviews', 'visitors'];
    riversa_({ nome: agg.nome, colonne: colonne }, valori, toccate);
  }
}

/**
 * Distingue una pagina vista da un evento. L'export porta tutti e due quando
 * si chiede «type=all», e la colonna «datapoint» dice quale sia. Il valore
 * esatto usato per le pagine si vede con provaPrimoFile() sui dati veri: qui
 * si accetta sia «pageview» sia la casella vuota, cosi' il conteggio regge in
 * entrambi i casi invece di azzerarsi in silenzio.
 */
function eUnaPagina_(riga) {
  var d = String(riga.datapoint === undefined ? '' : riga.datapoint).toLowerCase();
  return d === '' || d === 'pageview' || d === 'pageviews';
}

/**
 * Toglie dalla scheda le righe dei giorni contenuti nel file, ci rimette
 * quelle nuove e riscrive in ordine di data. Le righe dei giorni non toccati
 * non vengono mai riscritte ne' cancellate.
 *
 * Riscrive solo la CODA del foglio, dalla prima riga con data maggiore o
 * uguale al giorno piu' vecchio toccato: cosi' lo storico vecchio non viene
 * nemmeno riletto, ed e' quello che tiene la corsa corta quando la scheda dei
 * grezzi sara' arrivata a decine di migliaia di righe.
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
    throw new Error('Cartella «' + nome + '» non trovata su Drive. ' +
                    'Creala, oppure cambia la proprieta\' SA_CARTELLA.');
  }
  return trovate.next();
}

/** Sposta il file in «importati», cosi' la corsa dopo non lo rilegge. */
function archivia_(file, cartella) {
  var sotto = cartella.getFoldersByName(SOTTOCARTELLA_FATTI);
  var destinazione = sotto.hasNext() ? sotto.next()
                                     : cartella.createFolder(SOTTOCARTELLA_FATTI);
  destinazione.addFile(file);
  cartella.removeFile(file);
}

// ---------------------------------------------------------------------------
// Minuteria
// ---------------------------------------------------------------------------

/**
 * Trova la scheda o la crea con le intestazioni giuste. Le prime due colonne
 * sono formattate come testo: senza, il foglio trasforma «2026-08-19» in una
 * data e le chiavi non combaciano piu' alla corsa dopo.
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
          .setValues([['quando', 'comando', 'file', 'esito']]).setFontWeight('bold');
    foglio.setFrozenRows(1);
  }
  foglio.appendRow([
    Utilities.formatDate(new Date(), FUSO, 'yyyy-MM-dd HH:mm:ss'),
    etichetta, quanti, esito
  ]);
  Logger.log(etichetta + ': ' + esito);
}
