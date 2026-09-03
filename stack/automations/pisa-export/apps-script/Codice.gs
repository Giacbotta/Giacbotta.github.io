/**
 * Export of the Pisa deposits into the Google Sheet, with no PC left running.
 *
 * Runs on Apps Script, that is on Google's servers: it reads the Onniversum
 * management API and rewrites two tabs of the sheet this script is attached
 * to.
 *
 *   - "Depositi Pisa" - one row per deposit, the mirror of the panel.
 *   - "Lista invio"   - one address per person, only picked-up deposits with
 *                       a valid email. It is the list the review request
 *                       starts from.
 *
 * The two tabs get rewritten in full on every run, but the "inviato",
 * "dataInvio" and "esito" columns of Lista invio are NOT lost: before
 * rewriting they are read back and re-attached by email address (E-18).
 *
 * The management-system credentials do NOT live in here: they live in the
 * project's Script Properties (Project Settings -> Script Properties).
 *   PISA_EMAIL     required
 *   PISA_PASSWORD  required
 *   PISA_HUB_ID    optional, filters to a single kiosk
 *
 * Python twin: C:\path\to\automations\pisa-export\export_depositi.py
 */

var BASE_URL = 'https://api.locker-vendor.example/api';
var PAGE_SIZE = 100; // cap set by the server: higher values get truncated
var FUSO = 'Europe/Rome';

var TAB_DEPOSITI = 'Depositi Pisa';
var TAB_INVII = 'Lista invio';

// The status columns for the send step: they live in the sheet, not in the
// API, and must be preserved on every rewrite.
var COLONNE_STATO = ['inviato', 'dataInvio', 'esito'];

// Fields that must NOT end up on the sheet. pickupCode is the code that opens
// the locker and apiKey is the kiosk's key: on a sheet that can be shared,
// they do not belong. The others are technical noise.
var CAMPI_ESCLUSI = [
  'pickupCode', 'apiKey', 'sessionId',
  'payment.preAuthCode', 'payment.preAuthPaymentId', 'payment._id',
  'billing._id', 'smartsale._id',
  'macAddress', 'deliveryId', '__v', '_id'
];

// Known columns, in the order we want to read them. Fields the API returns
// that are not in this list get appended at the end, so if the vendor
// introduces new ones we do not lose them in silence.
var COLONNE_PREFERITE = [
  'paccoId', 'status', 'createdAt', 'depositStartAt', 'depositConfirmedAt',
  'pickupStartedAt', 'pickupCompletedAt', 'lockerNumber', 'dimensione',
  'locale', 'emailMittente', 'phoneMittente',
  'billing.durationLabel', 'billing.durationMinutes', 'billing.billingHours',
  'billing.rateLabel', 'billing.totalNowEuro', 'billing.alreadyPaidEuro',
  'billing.dueNowEuro', 'billing.pickupSettled', 'billing.billingNote',
  'payment.preAuthAmount', 'payment.capturedAmount', 'payment.totalCharged',
  'payment.totalAmount',
  'smartsale.status', 'smartsale.progressivo', 'smartsale.totale',
  'smartsale.emittedAt', 'hubName'
];


// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/**
 * The function to run, by hand or from the daily trigger.
 */
function aggiornaDepositi() {
  var prop = PropertiesService.getScriptProperties();
  var email = prop.getProperty('PISA_EMAIL');
  var password = prop.getProperty('PISA_PASSWORD');
  var hubId = prop.getProperty('PISA_HUB_ID');

  if (!email || !password) {
    throw new Error(
      'Missing PISA_EMAIL or PISA_PASSWORD in Script Properties ' +
      '(Project Settings -> Script Properties).'
    );
  }

  var token = login_(email, password);
  var depositi = scaricaDepositi_(token, hubId);
  Logger.log('Deposits downloaded: ' + depositi.length);

  var foglio = SpreadsheetApp.getActiveSpreadsheet();
  var aggiornato = Utilities.formatDate(new Date(), FUSO, 'dd/MM/yyyy HH:mm');

  // 1. the mirror of the panel
  var tabella = costruisciTabella_(depositi);
  scriviScheda_(
    foglio, TAB_DEPOSITI, tabella.colonne, tabella.righe,
    'Updated on ' + aggiornato + ', ' + tabella.righe.length + ' deposits'
  );

  // 2. the send list, with the status columns preserved (E-18)
  var lista = costruisciListaInvio_(depositi);
  var stato = leggiStato_(foglio.getSheetByName(TAB_INVII));
  var colonneInvio = lista.colonne.concat(COLONNE_STATO);
  var righeInvio = lista.righe.map(function (riga) {
    var chiave = String(riga[0]).trim().toLowerCase();
    var salvato = stato[chiave] || [];
    return riga.concat(COLONNE_STATO.map(function (_, i) {
      return salvato[i] === undefined ? '' : salvato[i];
    }));
  });

  var preservati = righeInvio.filter(function (r) {
    return String(r[lista.colonne.length]).trim() !== '';
  }).length;

  scriviScheda_(
    foglio, TAB_INVII, colonneInvio, righeInvio,
    'Updated on ' + aggiornato + ', ' + righeInvio.length +
    ' distinct addresses, one pickup each, ' + preservati + ' already contacted'
  );

  Logger.log('Done. ' + tabella.righe.length + ' deposits, ' +
             righeInvio.length + ' addresses, ' + preservati + ' statuses preserved.');
}


// ---------------------------------------------------------------------------
// management-system API
// ---------------------------------------------------------------------------

function login_(email, password) {
  var risposta = UrlFetchApp.fetch(BASE_URL + '/auth/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: email, password: password }),
    muteHttpExceptions: true
  });

  var codice = risposta.getResponseCode();
  if (codice === 401) {
    throw new Error('Login rejected: invalid email or password. ' +
                    'If you changed the password on the panel, update it in Script Properties.');
  }
  if (codice >= 300) {
    throw new Error('Login failed, HTTP ' + codice + ': ' +
                    risposta.getContentText().slice(0, 300));
  }

  var token = JSON.parse(risposta.getContentText()).access_token;
  if (!token) {
    throw new Error('Login succeeded but no access_token: ' +
                    risposta.getContentText().slice(0, 300));
  }
  return token;
}


/** Downloads every page of /admin/deposits. */
function scaricaDepositi_(token, hubId) {
  var depositi = [];
  var pagina = 1;
  var pagineTotali = 1;

  while (pagina <= pagineTotali) {
    var url = BASE_URL + '/admin/deposits?page=' + pagina + '&pageSize=' + PAGE_SIZE;
    if (hubId) {
      url += '&hubId=' + encodeURIComponent(hubId);
    }

    var risposta = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (risposta.getResponseCode() >= 300) {
      throw new Error('Reading deposits failed, HTTP ' + risposta.getResponseCode() +
                      ': ' + risposta.getContentText().slice(0, 300));
    }

    var corpo = JSON.parse(risposta.getContentText());
    depositi = depositi.concat(corpo.items || []);
    pagineTotali = corpo.totalPages || 1;
    Logger.log('  page ' + pagina + '/' + pagineTotali + ', ' +
               depositi.length + ' deposits so far');
    pagina += 1;
  }

  if (!depositi.length) {
    throw new Error('No deposits returned: the account no longer sees the hub, ' +
                    'or the vendor has moved the service.');
  }
  return depositi;
}


// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/** Flattens the nested object into one flat row: billing.dueNowEuro, etc. */
function appiattisci_(oggetto, prefisso) {
  prefisso = prefisso || '';
  var piatto = {};

  Object.keys(oggetto).forEach(function (chiave) {
    var nome = prefisso + chiave;
    var valore = oggetto[chiave];

    if (valore && typeof valore === 'object' && !Array.isArray(valore)) {
      var interno = appiattisci_(valore, nome + '.');
      Object.keys(interno).forEach(function (k) { piatto[k] = interno[k]; });
    } else if (Array.isArray(valore)) {
      piatto[nome] = valore.length ? JSON.stringify(valore) : '';
    } else {
      piatto[nome] = valore === null || valore === undefined ? '' : valore;
    }
  });

  return piatto;
}


function costruisciTabella_(depositi) {
  var righe = depositi.map(function (d) { return appiattisci_(d); });

  var presenti = {};
  righe.forEach(function (riga) {
    Object.keys(riga).forEach(function (k) {
      if (CAMPI_ESCLUSI.indexOf(k) === -1) { presenti[k] = true; }
    });
  });

  var colonne = COLONNE_PREFERITE.filter(function (c) { return presenti[c]; });
  var extra = Object.keys(presenti).filter(function (c) {
    return COLONNE_PREFERITE.indexOf(c) === -1;
  }).sort();
  colonne = colonne.concat(extra);

  // Computed column: says how many deposits can actually get an email.
  var colonneFinali = colonne.concat(['haEmail']);

  var tabella = righe.map(function (riga) {
    var valori = colonne.map(function (c) {
      var v = riga[c];
      return v === undefined || v === null ? '' : v;
    });
    var email = String(riga.emailMittente || '').trim();
    valori.push(email.indexOf('@') !== -1 ? 'si' : 'no');
    return valori;
  });

  return { colonne: colonneFinali, righe: tabella };
}


/**
 * One address per person, not per deposit.
 *
 * Someone who left three bags in three lockers generated three rows with
 * the same email: without dedup they would get three review requests. Not
 * picked-up deposits are left out, since we do not ask for a review on
 * those.
 */
function costruisciListaInvio_(depositi) {
  var perIndirizzo = {};

  depositi.forEach(function (deposito) {
    if (deposito.status !== 'picked_up') { return; }

    var email = String(deposito.emailMittente || '').trim();
    if (email.indexOf('@') === -1) { return; }

    var chiave = email.toLowerCase();
    var voce = perIndirizzo[chiave];
    if (!voce) {
      voce = { email: email, locale: '', depositi: 0, ultimoRitiro: '' };
      perIndirizzo[chiave] = voce;
    }
    voce.depositi += 1;

    // Dates are ISO 8601, so alphabetical order is also chronological.
    var ritiro = String(deposito.pickupCompletedAt || '');
    if (ritiro > voce.ultimoRitiro) {
      voce.ultimoRitiro = ritiro;
      voce.locale = deposito.locale || voce.locale;
    }
  });

  var righe = Object.keys(perIndirizzo)
    .map(function (k) { return perIndirizzo[k]; })
    .sort(function (a, b) { return a.ultimoRitiro < b.ultimoRitiro ? 1 : -1; })
    .map(function (v) { return [v.email, v.locale, v.depositi, v.ultimoRitiro]; });

  return { colonne: ['email', 'locale', 'depositi', 'ultimoRitiro'], righe: righe };
}


// ---------------------------------------------------------------------------
// E-18: the status columns survive the rewrite
// ---------------------------------------------------------------------------

/**
 * Reads back from the Lista invio tab what the send step has already
 * written, and returns it indexed by lowercase email:
 *   { 'tizio@example.com': ['si', '18/08/2026', 'consegnata'], ... }
 *
 * Deliberately tolerant: if the tab does not exist, if it is empty, or if
 * the header sits on a different row, it returns an empty map instead of
 * failing the whole run. Losing a run is worse than losing one column's
 * color.
 */
function leggiStato_(scheda) {
  var mappa = {};
  if (!scheda) { return mappa; }

  var dati = scheda.getDataRange().getValues();
  if (!dati.length) { return mappa; }

  // The header is the first row that contains an "email" cell: this way it
  // works both with a sheet written by this script (row 2) and with one
  // imported by hand (row 1).
  var rigaIntestazione = -1;
  for (var i = 0; i < Math.min(dati.length, 5); i++) {
    var trovata = dati[i].some(function (c) {
      return String(c).trim().toLowerCase() === 'email';
    });
    if (trovata) { rigaIntestazione = i; break; }
  }
  if (rigaIntestazione === -1) { return mappa; }

  var intestazione = dati[rigaIntestazione].map(function (c) {
    return String(c).trim().toLowerCase();
  });
  var colEmail = intestazione.indexOf('email');
  var indici = COLONNE_STATO.map(function (nome) {
    return intestazione.indexOf(nome.toLowerCase());
  });

  // If none of the status columns exist yet, there is nothing to preserve.
  if (indici.every(function (i) { return i === -1; })) { return mappa; }

  for (var r = rigaIntestazione + 1; r < dati.length; r++) {
    var email = String(dati[r][colEmail] || '').trim().toLowerCase();
    if (!email) { continue; }

    var valori = indici.map(function (idx) {
      if (idx === -1) { return ''; }
      var v = dati[r][idx];
      if (v instanceof Date) {
        return Utilities.formatDate(v, FUSO, 'dd/MM/yyyy HH:mm');
      }
      return v === null || v === undefined ? '' : v;
    });

    // Rows never touched by the send step are not worth keeping in memory.
    if (valori.some(function (v) { return String(v).trim() !== ''; })) {
      mappa[email] = valori;
    }
  }

  return mappa;
}


// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function scriviScheda_(foglio, nome, colonne, righe, nota) {
  var scheda = foglio.getSheetByName(nome);
  if (!scheda) {
    scheda = foglio.insertSheet(nome);
  }

  var intestazione = colonne.map(function (_, i) { return i === 0 ? nota : ''; });
  var valori = [intestazione, colonne].concat(righe);

  scheda.clear();

  // The grid has to be widened before writing, otherwise setValues runs
  // into the sheet's edge.
  if (scheda.getMaxRows() < valori.length) {
    scheda.insertRowsAfter(scheda.getMaxRows(), valori.length - scheda.getMaxRows() + 10);
  }
  if (scheda.getMaxColumns() < colonne.length) {
    scheda.insertColumnsAfter(scheda.getMaxColumns(), colonne.length - scheda.getMaxColumns() + 2);
  }

  scheda.getRange(1, 1, valori.length, colonne.length).setValues(valori);
  scheda.setFrozenRows(2);

  Logger.log('Wrote ' + righe.length + ' rows to the "' + nome + '" tab.');
}


// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

/**
 * Adds the "Nutrie" menu entry when the sheet is opened.
 *
 * The nightly update is not created from here: it is set up by hand from
 * the editor, Triggers panel, on the aggiornaDepositi function.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrie')
    .addItem('Update now', 'aggiornaDepositi')
    .addToUi();
}
