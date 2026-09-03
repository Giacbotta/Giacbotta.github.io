/**
 * Export of the Venice takings into the Google Sheet, with no PC left running.
 *
 * Runs on Apps Script, that is on Google's servers: it logs into the PromoTec
 * panel (panel.kiosk-vendor.example), opens the Counters page, downloads the
 * available months and piles them into the "Incassi Venezia" tab of the sheet
 * it is attached to.
 *
 * THE DIFFERENCE THAT MATTERS AGAINST PISA. The Pisa script rewrites the sheet
 * in full on every run, because the management API keeps the whole history.
 * Not here: the Venice panel keeps ONLY THREE MONTHS, so the sheet is the
 * archive and not a mirror. This script NEVER deletes rows that are already
 * there: it reads the ones it finds, overwrites them with the months just
 * downloaded, indexing by receipt number, and writes back the union. A month
 * that falls out of the three-month window stays in the sheet forever.
 *
 * THE PANEL IS A REMOTE CONTROL, NOT A READ-ONLY MANAGEMENT TOOL. Next to the
 * buttons you use to read there are others that act on the hardware in
 * Cannaregio: "Unbook All" releases every booking, "Reboot sysytem" restarts
 * the installation, "Open Ex.Door" opens the outer door, and the 56 buttons
 * "Locker100"-"Locker155" each open one locker. In the browser those buttons
 * ask for confirmation, but the confirmation is JavaScript: an HTTP client
 * steps over it without noticing, so here that protection does not exist.
 *
 * That is why the script works from a LIST OF WHAT IS ALLOWED, not from a list
 * of what is forbidden: it can press only the four buttons listed in
 * BOTTONI_CONSENTITI, and controllaDati_() refuses any other button name that
 * ends up in the payload. A list of prohibitions would have the flaw of not
 * recognising a dangerous button the vendor has renamed.
 *
 * THE PAGES ARE SERVED IN TWO STEPS. The server's first response is a skeleton
 * with no data: the month dropdown comes back empty and the locker buttons are
 * not there. At the bottom of the page there is a <script> with
 * __doPostBack('__Page','PBArg') that the browser runs straight away, and it is
 * that second postback that fills everything in. Sessione_.posta() takes care
 * of it. Without it you see an empty page and conclude the panel has changed:
 * that cost a session, on 18/08/2026.
 *
 * The credentials are NOT in here: they live in the project's Script
 * properties (Project settings -> Script properties).
 *   VENEZIA_USER      required, the User Name from the first screen
 *   VENEZIA_PASSWORD  required, the System password from the second
 *   VENEZIA_SISTEMA   optional, defaults to "Luggage Cannaregio Dyn"
 *
 * Python twin, which does the same job on the PC and piles into a CSV:
 * C:\path\to\automations\venezia-export\export_incassi.py
 */

var BASE_URL = 'https://panel.kiosk-vendor.example/';
var FUSO = 'Europe/Rome';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

var TAB_INCASSI = 'Incassi Venezia';
var SISTEMA_DEFAULT = 'Luggage Cannaregio Dyn';

// The same columns as the CSV produced by the Python twin, in the same order,
// so the two archives stay comparable row by row.
var COLONNE = ['mese', 'data', 'importoIvaInclusa', 'cassetto', 'scontrino', 'sconto'];

// The column used for deduplication: the panel never reuses a receipt number,
// so reading a month twice creates no duplicates.
var COL_SCONTRINO = 4;

// Format of each column. "@" means text: it is needed because otherwise the
// sheet reads "08/2026" as a date and "2026-06-01 09:31:56" as a timestamp,
// and the archive stops looking like what the panel actually sent. Amount and
// discount stay numbers, so they add up.
var FORMATI = ['@', '@', '0.00', '@', '@', '0.00'];

// The ONLY buttons this script may press. Everything else is refused by
// controllaDati_(), including what does not exist today.
var BOTTONI_CONSENTITI = [
  /^btnSelecUser$/i,          // "Select", confirms the User Name
  /^btnSelectSystem_\d+$/i,   // picks the installation
  /^BtnCounters$/i,           // opens the Counters page
  /^BtnGetCounterRecords$/i   // "Get Incoming", downloads the month
];

// Deliberately not global: a regexp with /g carries lastIndex from one .test()
// to the next and starts giving alternating answers.
var AUTO_POSTBACK = /__doPostBack\(\s*'__Page'\s*,\s*'PBArg'\s*\)/;

// THE PANEL HIBERNATES. kiosk-vendor.example shuts the application down after a
// spell of inactivity and restarts it on the first request: whoever knocks
// while it is waking up hangs and times out. Measured on 2026-08-19, six calls
// in a row from cold: timeout at 25s, then 12.3s, 7.8s, 2.7s, 3.8s, 0.5s. Hence
// the wake-up calls and the retries below.
var SVEGLIE = 4;          // throwaway calls to get the application going again
var PAUSA_SVEGLIA = 10000;
var TENTATIVI = 2;        // full runs, if the first one times out
var PAUSA_TENTATIVO = 15000;


// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/**
 * The function to launch, by hand from the "Nutrie" menu or from a trigger.
 *
 * The trigger is not created here: you set it by hand from the editor, Triggers
 * panel, on this function. Once a month is enough, but once a day does no harm
 * and protects you from a missed month.
 */
function aggiornaIncassi() {
  // Two overlapping runs would rewrite the tab together and could leave it half
  // done. That happens easily with a daily trigger and a run launched by hand
  // at the same moment.
  var lucchetto = LockService.getScriptLock();
  if (!lucchetto.tryLock(30000)) {
    throw new Error('Another run is already in progress. Try again in a few minutes.');
  }

  try {
    svegliaPannello_();

    for (var tentativo = 1; tentativo <= TENTATIVI; tentativo++) {
      try {
        eseguiAggiornamento_();
        return;
      } catch (errore) {
        // We start over only for timeouts, which are the panel hibernating. A
        // substantive error, wrong credentials, a changed panel, has to be
        // shown at once, not retried.
        if (!eTimeout_(errore) || tentativo === TENTATIVI) throw errore;
        Logger.log('Attempt ' + tentativo + ' timed out, starting over.');
        Utilities.sleep(PAUSA_TENTATIVO);
      }
    }
  } finally {
    lucchetto.releaseLock();
  }
}


/**
 * Knocks at the panel until it answers, before starting for real.
 *
 * These are throwaway calls: the data is not needed and neither is the session,
 * since the real run opens its own. They only serve to restart the application
 * while nobody depends on the result yet. If they all fail we try anyway: it
 * may be slow but alive.
 */
function svegliaPannello_() {
  for (var i = 1; i <= SVEGLIE; i++) {
    try {
      var risposta = UrlFetchApp.fetch(BASE_URL, {
        method: 'get',
        headers: { 'User-Agent': UA },
        followRedirects: true,
        muteHttpExceptions: true
      });
      if (risposta.getResponseCode() === 200) {
        Logger.log('Panel awake at call ' + i + '.');
        return;
      }
      Logger.log('Wake-up ' + i + ': the panel responded ' + risposta.getResponseCode() + '.');
    } catch (errore) {
      Logger.log('Wake-up ' + i + ': ' + errore.message);
    }
    Utilities.sleep(PAUSA_SVEGLIA);
  }
  Logger.log('The panel did not answer the wake-up calls: trying anyway.');
}


/**
 * Whether an error is the panel not answering, rather than a substantive error.
 *
 * We look at the text because UrlFetchApp does not raise distinct types: the
 * timeout arrives as an Exception carrying "Timeout: https://panel.kiosk-vendor.example/".
 */
function eTimeout_(errore) {
  var testo = String(errore && errore.message ? errore.message : errore).toLowerCase();
  return testo.indexOf('timeout') !== -1 ||
         testo.indexOf('address unavailable') !== -1 ||
         testo.indexOf('dns error') !== -1 ||
         testo.indexOf('responded 5') !== -1;  // the kiosk-vendor 500 under load
}


function eseguiAggiornamento_() {
  var prop = PropertiesService.getScriptProperties();
  var utente = prop.getProperty('VENEZIA_USER');
  var password = prop.getProperty('VENEZIA_PASSWORD');
  var sistema = prop.getProperty('VENEZIA_SISTEMA') || SISTEMA_DEFAULT;

  if (!utente || !password) {
    throw new Error(
      'VENEZIA_USER or VENEZIA_PASSWORD is missing from the Script properties ' +
      '(Project settings -> Script properties).'
    );
  }

  var sessione = new Sessione_();
  var pagina = entra_(sessione, utente, password, sistema);
  pagina = apriCounters_(sessione, pagina);

  var mesi = pagina.opzioni('monthList');
  if (!mesi.length) {
    throw new Error(
      'The Counters page does not expose the month list. If the __Page/PBArg ' +
      'auto-postback is no longer enough, the panel has changed.'
    );
  }
  Logger.log('Months available on the panel: ' + mesi.join(', '));

  var foglio = SpreadsheetApp.getActiveSpreadsheet();
  var archivio = leggiArchivio_(foglio.getSheetByName(TAB_INCASSI));
  var prima = contaChiavi_(archivio);

  var riepilogo = [];
  for (var i = 0; i < mesi.length; i++) {
    var esito = scaricaMese_(sessione, pagina, mesi[i]);
    pagina = esito.pagina;

    var totale = 0;
    for (var j = 0; j < esito.righe.length; j++) {
      var riga = esito.righe[j];
      archivio[String(riga[COL_SCONTRINO])] = riga;
      totale += Number(riga[2]) || 0;
    }
    riepilogo.push(mesi[i] + ': ' + esito.righe.length + ' transactions, ' + totale.toFixed(2) + ' EUR');
    Logger.log('  ' + riepilogo[riepilogo.length - 1]);
  }

  var righe = ordina_(archivio);
  var incasso = 0;
  for (var k = 0; k < righe.length; k++) incasso += Number(righe[k][2]) || 0;

  var nota = 'Venice takings archive (PromoTec panel). Updated on ' +
    Utilities.formatDate(new Date(), FUSO, 'yyyy-MM-dd HH:mm') + '. ' +
    righe.length + ' transactions, ' + incasso.toFixed(2) + ' EUR. ' +
    'New in this run: ' + (righe.length - prima) + '. ' +
    'The panel keeps only three months: this sheet is the archive, not a mirror. ' +
    'Do not delete or reorder rows by hand.';

  scriviScheda_(foglio, TAB_INCASSI, COLONNE, righe, nota);

  var messaggio = riepilogo.join('  |  ') + '  ->  new: ' + (righe.length - prima);
  Logger.log(messaggio);
  try {
    foglio.toast(messaggio, 'Incassi Venezia', 10);
  } catch (e) {
    // From a trigger there is nobody watching the toast: that is not an error.
  }
}


// ---------------------------------------------------------------------------
// navigating the panel
// ---------------------------------------------------------------------------

/**
 * Login in two screens.
 *
 * 1. "User Name" -> field txtUserName, button btnSelecUser.
 * 2. "System password" -> field txtSysPsw, plus the three installation buttons.
 *    The password and the choice of installation travel in the same POST, the
 *    way the browser does it when you type the password and press the button.
 */
function entra_(sessione, utente, password, sistema) {
  var pagina = sessione.apri();

  var campoUtente = pagina.campoTesto('user');
  if (!campoUtente) {
    throw new Error('Unexpected login page: I cannot find the User Name field.');
  }
  var bottone = pagina.bottonePerValore('Select');
  if (!bottone) {
    throw new Error(
      'Unexpected login page: I cannot find the "Select" button. ' +
      'The buttons present are: ' + pagina.valoriBottoni().join(', ') + '.'
    );
  }

  var dati = pagina.statoForm();
  dati[campoUtente] = utente;
  pagina = sessione.posta(pagina, dati, bottone);

  var campoPassword = pagina.campoPassword();
  if (campoPassword) {
    var impianto = pagina.bottonePerValore(sistema);
    if (!impianto) {
      throw new Error(
        'System "' + sistema + '" not found. The available ones are: ' +
        pagina.valoriBottoni().join(', ') + '. Fix VENEZIA_SISTEMA in the Script properties.'
      );
    }
    dati = pagina.statoForm();
    dati[campoPassword] = password;
    pagina = sessione.posta(pagina, dati, impianto);
  }

  if (!pagina.bottonePerValore('Counters')) {
    throw new Error(
      'Login failed: after signing in I cannot find the "Counters" button. ' +
      'Check the user, the System password and the system name.'
    );
  }
  return pagina;
}


function apriCounters_(sessione, pagina) {
  var bottone = pagina.bottonePerValore('Counters');
  if (!bottone) {
    throw new Error('The "Counters" button has vanished from the menu.');
  }
  return sessione.posta(pagina, pagina.statoForm(), bottone);
}


/**
 * Picks a month and presses "Get Incoming".
 *
 * Returns the new page, which is needed for the next postback, along with the
 * rows read. The month has to be set again on every pass: the page that comes
 * back carries the previous selection.
 */
function scaricaMese_(sessione, pagina, mese) {
  var bottone = pagina.bottonePerNome('BtnGetCounterRecords');
  if (!bottone) {
    throw new Error(
      'I cannot find the "Get Incoming" button (BtnGetCounterRecords) on the Counters page.'
    );
  }

  var dati = pagina.statoForm();
  dati['monthList'] = mese;

  var nuova = sessione.posta(pagina, dati, bottone);
  var celle = righeIncassi_(nuova);
  if (celle === null) {
    throw new Error(
      'The dgIncassi table is not in the response for month ' + mese + '. ' +
      'Either the panel has changed, or the session expired mid-run.'
    );
  }

  var righe = [];
  for (var i = 0; i < celle.length; i++) {
    var c = celle[i];
    // date, amount, locker, receipt, discount -> with the month in front
    righe.push([mese, c[0], Number(c[1]) || 0, c[2], c[3], Number(c[4]) || 0]);
  }
  return { pagina: nuova, righe: righe };
}


/**
 * The rows of the takings table.
 *
 * Anchored to the id "dgIncassi" and not to the position: the page is full of
 * tables used for layout, and grabbing "the first one" would be fragile.
 * Returns null if the table is missing altogether, which is a different thing
 * from a month with no transactions, which returns an empty list.
 */
function righeIncassi_(pagina) {
  var html = pagina.html;
  var ancora = html.indexOf('id="dgIncassi"');
  if (ancora === -1) return null;

  var inizio = html.lastIndexOf('<table', ancora);
  var fine = html.indexOf('</table>', ancora);
  if (inizio === -1 || fine === -1) return null;
  var blocco = html.slice(inizio, fine);

  var righe = [];
  var reTr = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  var tr;
  while ((tr = reTr.exec(blocco)) !== null) {
    var celle = [];
    var reTd = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    var td;
    while ((td = reTd.exec(tr[1])) !== null) {
      celle.push(decodifica_(td[1].replace(/<[^>]*>/g, '')).trim());
    }
    // The header uses <th>, so it produces no cells and drops out by itself.
    if (celle.length >= 5) righe.push(celle);
  }
  return righe;
}


// ---------------------------------------------------------------------------
// the HTTP session
// ---------------------------------------------------------------------------

/**
 * UrlFetchApp does not keep cookies on its own, and the panel is all session:
 * without ASP.NET_SessionId every postback starts again from the login. Here
 * the cookies are collected by hand from the Set-Cookie headers and sent back.
 */
function Sessione_() {
  this.biscotti = {};
}

Sessione_.prototype.intestazioni_ = function () {
  var testate = { 'User-Agent': UA };
  var pezzi = [];
  for (var nome in this.biscotti) pezzi.push(nome + '=' + this.biscotti[nome]);
  if (pezzi.length) testate['Cookie'] = pezzi.join('; ');
  return testate;
};

Sessione_.prototype.assorbi_ = function (risposta) {
  var testate = risposta.getAllHeaders();
  var grezzi = testate['Set-Cookie'] || testate['set-cookie'];
  if (!grezzi) return;
  if (typeof grezzi === 'string') grezzi = [grezzi];
  for (var i = 0; i < grezzi.length; i++) {
    var primo = String(grezzi[i]).split(';')[0];
    var taglio = primo.indexOf('=');
    if (taglio > 0) {
      this.biscotti[primo.slice(0, taglio).trim()] = primo.slice(taglio + 1).trim();
    }
  }
};

Sessione_.prototype.chiama_ = function (opzioni) {
  opzioni.headers = this.intestazioni_();
  opzioni.followRedirects = true;
  opzioni.muteHttpExceptions = true;
  var risposta = UrlFetchApp.fetch(BASE_URL, opzioni);
  this.assorbi_(risposta);
  var codice = risposta.getResponseCode();
  if (codice !== 200) {
    throw new Error('The panel responded ' + codice + '. Run stopped.');
  }
  return risposta.getContentText();
};

Sessione_.prototype.apri = function () {
  return new Pagina_(this.chiama_({ method: 'get' }));
};

/**
 * One postback and what follows it.
 *
 * `pagina` is the page the postback starts from, and it serves to check that
 * the payload does not end up carrying the name of a button we are not allowed
 * to press. `bottone` is the only command this call presses.
 *
 * After the POST, for as long as the response asks for the auto-postback it
 * redoes it in place of the browser. The ceiling of three passes exists only to
 * avoid an infinite loop should the panel one day ask for it forever: as of
 * 2026-08-19 one is always enough.
 */
Sessione_.prototype.posta = function (pagina, dati, bottone) {
  if (bottone) {
    dati[bottone.nome] = bottone.valore;
  }
  controllaDati_(pagina, dati);
  var html = this.chiama_({ method: 'post', payload: dati });

  for (var giro = 0; giro < 3; giro++) {
    if (!AUTO_POSTBACK.test(html)) break;
    var intermedia = new Pagina_(html);
    var seguito = intermedia.statoForm();
    // A postback of the page onto itself: no button pressed.
    seguito['__EVENTTARGET'] = '__Page';
    seguito['__EVENTARGUMENT'] = 'PBArg';
    controllaDati_(intermedia, seguito);
    html = this.chiama_({ method: 'post', payload: seguito });
  }
  return new Pagina_(html);
};

/**
 * The last net before a POST leaves.
 *
 * It works from a list of what is allowed. A payload key can pass only if it is
 * a WebForms technical field, or a text field the page has declared (those
 * cannot press anything), or one of the four buttons in BOTTONI_CONSENTITI.
 * Any other button name fails the run, including one that does not exist today.
 */
function controllaDati_(pagina, dati) {
  for (var nome in dati) {
    if (nome.indexOf('__') === 0 || nome === 'monthList') continue;

    // The page's non-submit fields: text, password, hidden. They are not
    // commands, whatever the vendor decides to call them.
    if (pagina.campi.hasOwnProperty(nome) && pagina.tipi[nome] !== 'submit') continue;

    if (bottoneConsentito_(nome)) continue;

    throw new Error(
      'Refusing to send "' + nome + '" to the panel: it is not among the commands ' +
      'this script may press. If the panel has changed, the BOTTONI_CONSENTITI ' +
      'list has to be updated, with good reason.'
    );
  }
}

function bottoneConsentito_(nome) {
  for (var i = 0; i < BOTTONI_CONSENTITI.length; i++) {
    if (BOTTONI_CONSENTITI[i].test(nome)) return true;
  }
  return false;
}


// ---------------------------------------------------------------------------
// reading the HTML
// ---------------------------------------------------------------------------

/**
 * A WebForms page: the form fields, the buttons, and the raw html for the rest.
 * No real parser, because there is none on Apps Script: regular expressions,
 * which are enough on HTML always generated the same way.
 */
function Pagina_(html) {
  this.html = html;
  this.campi = {};
  this.tipi = {};
  this.bottoni = [];

  var re = /<input\b[^>]*>/gi;
  var tag;
  while ((tag = re.exec(html)) !== null) {
    var nome = attributo_(tag[0], 'name');
    if (!nome) continue;
    var tipo = (attributo_(tag[0], 'type') || 'text').toLowerCase();
    var valore = attributo_(tag[0], 'value') || '';
    this.tipi[nome] = tipo;
    if (tipo === 'submit') {
      this.bottoni.push({ nome: nome, valore: valore });
    } else if (tipo === 'hidden' || tipo === 'text' || tipo === 'password') {
      this.campi[nome] = valore;
    }
  }
}

/** The fields every postback has to send back: viewstate and company. */
Pagina_.prototype.statoForm = function () {
  var dati = {};
  for (var nome in this.campi) {
    if (nome.indexOf('__') === 0 || nome === 'monthList') {
      dati[nome] = this.campi[nome];
    }
  }
  return dati;
};

Pagina_.prototype.opzioni = function (nomeSelect) {
  var re = new RegExp('<select[^>]*name="' + nomeSelect + '"[^>]*>([\\s\\S]*?)</select>', 'i');
  var blocco = this.html.match(re);
  if (!blocco) return [];
  var valori = [];
  var reOpt = /<option[^>]*value="([^"]*)"/gi;
  var opt;
  while ((opt = reOpt.exec(blocco[1])) !== null) valori.push(decodifica_(opt[1]));
  return valori;
};

/**
 * A button from the text written on it, by EXACT match.
 *
 * No partial search, on purpose. "Luggage Cannaregio" is contained inside
 * "Luggage Cannaregio cloud": an approximate match would pick the wrong
 * installation without saying so. And in general, the moment an exact search
 * fails is the moment the panel has changed, that is the worst moment to
 * guess: better to stop.
 */
Pagina_.prototype.bottonePerValore = function (testo) {
  testo = String(testo).trim().toLowerCase();
  for (var i = 0; i < this.bottoni.length; i++) {
    if (this.bottoni[i].valore.trim().toLowerCase() === testo) return this.bottoni[i];
  }
  return null;
};

/** A button from its name, by exact match. Same reason. */
Pagina_.prototype.bottonePerNome = function (nome) {
  nome = String(nome).toLowerCase();
  for (var i = 0; i < this.bottoni.length; i++) {
    if (this.bottoni[i].nome.toLowerCase() === nome) return this.bottoni[i];
  }
  return null;
};

Pagina_.prototype.valoriBottoni = function () {
  var valori = [];
  for (var i = 0; i < this.bottoni.length; i++) valori.push(this.bottoni[i].valore);
  return valori;
};

/**
 * A text field whose name contains the given fragment.
 *
 * Restricted to fields of type "text": that way it can never pick up a
 * technical hidden, let alone a button.
 */
Pagina_.prototype.campoTesto = function (frammento) {
  frammento = String(frammento).toLowerCase();
  for (var nome in this.campi) {
    if (this.tipi[nome] === 'text' && nome.toLowerCase().indexOf(frammento) !== -1) {
      return nome;
    }
  }
  return null;
};

/**
 * The System password field, looked up by type and not by name: on the panel it
 * is called "txtSysPsw", which does not contain the word "password".
 */
Pagina_.prototype.campoPassword = function () {
  for (var nome in this.tipi) {
    if (this.tipi[nome] === 'password') return nome;
  }
  return null;
};

function attributo_(tag, nome) {
  var trovato = tag.match(new RegExp(nome + '\\s*=\\s*"([^"]*)"', 'i'));
  return trovato ? decodifica_(trovato[1]) : null;
}

function decodifica_(testo) {
  return String(testo)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');  // last, or it eats the other entities
}


// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

/**
 * The rows already in the sheet, indexed by receipt number.
 *
 * This is the part that makes the script safe to run again: what is there is
 * not lost, and the months that have left the three-month window stay.
 */
function leggiArchivio_(scheda) {
  var esistenti = {};
  if (!scheda) return esistenti;

  var ultima = scheda.getLastRow();
  if (ultima < 3) return esistenti;  // row 1 note, row 2 header

  var valori = scheda.getRange(3, 1, ultima - 2, COLONNE.length).getValues();
  for (var i = 0; i < valori.length; i++) {
    var riga = valori[i];
    var scontrino = String(riga[COL_SCONTRINO]).trim();
    if (!scontrino) continue;
    esistenti[scontrino] = [
      String(riga[0]).trim(),
      String(riga[1]).trim(),
      Number(riga[2]) || 0,
      String(riga[3]).trim(),
      scontrino,
      Number(riga[5]) || 0
    ];
  }
  return esistenti;
}

/** Sorted by date, which is the order you want to read them in. */
function ordina_(archivio) {
  var righe = [];
  for (var chiave in archivio) righe.push(archivio[chiave]);
  righe.sort(function (a, b) {
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return righe;
}

function contaChiavi_(oggetto) {
  var n = 0;
  for (var chiave in oggetto) n++;
  return n;
}


// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function scriviScheda_(foglio, nome, colonne, righe, nota) {
  var scheda = foglio.getSheetByName(nome);
  if (!scheda) scheda = foglio.insertSheet(nome);

  var intestazione = colonne.map(function (_, i) { return i === 0 ? nota : ''; });
  var valori = [intestazione, colonne].concat(righe);

  // NO clear() here. It used to write over an emptied sheet, and between the
  // emptying and the writing there was a window of a few seconds in which the
  // tab was empty: if the execution died there, and this panel times out
  // easily, the archive disappeared, and nobody has the months that left the
  // three-month window any more. Now it just overwrites, and the old tail is
  // removed only AFTER the new data is in place.

  // The grid has to be widened before writing, otherwise setValues runs into
  // the edge of the sheet.
  if (scheda.getMaxRows() < valori.length) {
    scheda.insertRowsAfter(scheda.getMaxRows(), valori.length - scheda.getMaxRows() + 10);
  }
  if (scheda.getMaxColumns() < colonne.length) {
    scheda.insertColumnsAfter(scheda.getMaxColumns(), colonne.length - scheda.getMaxColumns() + 2);
  }

  // The formats have to be set BEFORE writing, or the sheet converts "08/2026"
  // into a date and the row no longer matches the one from the panel.
  if (righe.length) {
    for (var c = 0; c < colonne.length; c++) {
      scheda.getRange(3, c + 1, righe.length, 1).setNumberFormat(FORMATI[c]);
    }
  }

  scheda.getRange(1, 1, valori.length, colonne.length).setValues(valori);

  // Now that the new data is written, away with any tail from the previous
  // version. With an archive that grows it almost never happens, but if one day
  // it did, without this trim there would be ghost rows at the bottom, which
  // IMPORTRANGE would carry over to the management sheet.
  var ultima = scheda.getLastRow();
  if (ultima > valori.length) {
    scheda.deleteRows(valori.length + 1, ultima - valori.length);
  }
  scheda.setFrozenRows(2);

  Logger.log('Wrote ' + righe.length + ' rows to the "' + nome + '" tab.');
}


// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrie')
    .addItem('Update Venice takings', 'aggiornaIncassi')
    .addToUi();
}
