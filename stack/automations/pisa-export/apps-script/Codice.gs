/**
 * Export dei depositi di Pisa dentro il Google Sheet, senza PC acceso.
 *
 * Gira su Apps Script, cioe' sui server di Google: legge l'API del gestionale
 * Onniversum e riscrive due schede del foglio a cui questo script e' agganciato.
 *
 *   - «Depositi Pisa» — una riga per deposito, lo specchio del pannello.
 *   - «Lista invio»   — un indirizzo per persona, solo depositi ritirati con
 *                       email valida. E' la lista da cui parte la richiesta
 *                       di recensione.
 *
 * Le due schede vengono riscritte per intero a ogni corsa, ma le colonne
 * «inviato», «dataInvio» ed «esito» della Lista invio NON si perdono: prima di
 * riscrivere vengono lette e riagganciate per indirizzo email (E-18).
 *
 * Le credenziali del gestionale NON stanno qui dentro: stanno nelle Proprieta'
 * script del progetto (Impostazioni progetto -> Proprieta' script).
 *   PISA_EMAIL     obbligatoria
 *   PISA_PASSWORD  obbligatoria
 *   PISA_HUB_ID    facoltativa, filtra un solo chiosco
 *
 * Gemello Python: C:\path\to\automations\pisa-export\export_depositi.py
 */

var BASE_URL = 'https://api.locker-vendor.example/api';
var PAGE_SIZE = 100; // tetto imposto dal server: valori piu' alti vengono troncati
var FUSO = 'Europe/Rome';

var TAB_DEPOSITI = 'Depositi Pisa';
var TAB_INVII = 'Lista invio';

// Le colonne di stato dell'invio: vivono nel foglio, non nell'API, e vanno
// preservate a ogni riscrittura.
var COLONNE_STATO = ['inviato', 'dataInvio', 'esito'];

// Campi che NON devono finire sul foglio. pickupCode e' il codice che apre il
// cassetto e apiKey e' la chiave del chiosco: su un foglio che puo' essere
// condiviso non ci vanno. Gli altri sono rumore tecnico.
var CAMPI_ESCLUSI = [
  'pickupCode', 'apiKey', 'sessionId',
  'payment.preAuthCode', 'payment.preAuthPaymentId', 'payment._id',
  'billing._id', 'smartsale._id',
  'macAddress', 'deliveryId', '__v', '_id'
];

// Colonne note, nell'ordine in cui vogliamo leggerle. I campi che l'API
// restituisce e che non sono in questa lista vengono aggiunti in coda, cosi'
// se il fornitore ne introduce di nuovi non li perdiamo in silenzio.
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
// il comando
// ---------------------------------------------------------------------------

/**
 * La funzione da lanciare, a mano o dal trigger giornaliero.
 */
function aggiornaDepositi() {
  var prop = PropertiesService.getScriptProperties();
  var email = prop.getProperty('PISA_EMAIL');
  var password = prop.getProperty('PISA_PASSWORD');
  var hubId = prop.getProperty('PISA_HUB_ID');

  if (!email || !password) {
    throw new Error(
      'Mancano PISA_EMAIL o PISA_PASSWORD nelle Proprieta\' script ' +
      '(Impostazioni progetto -> Proprieta\' script).'
    );
  }

  var token = login_(email, password);
  var depositi = scaricaDepositi_(token, hubId);
  Logger.log('Depositi scaricati: ' + depositi.length);

  var foglio = SpreadsheetApp.getActiveSpreadsheet();
  var aggiornato = Utilities.formatDate(new Date(), FUSO, 'dd/MM/yyyy HH:mm');

  // 1. lo specchio del pannello
  var tabella = costruisciTabella_(depositi);
  scriviScheda_(
    foglio, TAB_DEPOSITI, tabella.colonne, tabella.righe,
    'Aggiornato il ' + aggiornato + ' \u2014 ' + tabella.righe.length + ' depositi'
  );

  // 2. la lista d'invio, con le colonne di stato preservate (E-18)
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
    'Aggiornato il ' + aggiornato + ' \u2014 ' + righeInvio.length +
    ' indirizzi distinti, un ritiro a testa \u2014 ' + preservati + ' gia\' contattati'
  );

  Logger.log('Fatto. ' + tabella.righe.length + ' depositi, ' +
             righeInvio.length + ' indirizzi, ' + preservati + ' stati preservati.');
}


// ---------------------------------------------------------------------------
// API del gestionale
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
    throw new Error('Login rifiutato: email o password non validi. ' +
                    'Se hai cambiato la password sul pannello, aggiornala nelle Proprieta\' script.');
  }
  if (codice >= 300) {
    throw new Error('Login fallito, HTTP ' + codice + ': ' +
                    risposta.getContentText().slice(0, 300));
  }

  var token = JSON.parse(risposta.getContentText()).access_token;
  if (!token) {
    throw new Error('Login riuscito ma senza access_token: ' +
                    risposta.getContentText().slice(0, 300));
  }
  return token;
}


/** Scarica tutte le pagine di /admin/deposits. */
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
      throw new Error('Lettura depositi fallita, HTTP ' + risposta.getResponseCode() +
                      ': ' + risposta.getContentText().slice(0, 300));
    }

    var corpo = JSON.parse(risposta.getContentText());
    depositi = depositi.concat(corpo.items || []);
    pagineTotali = corpo.totalPages || 1;
    Logger.log('  pagina ' + pagina + '/' + pagineTotali + ' \u2014 ' +
               depositi.length + ' depositi finora');
    pagina += 1;
  }

  if (!depositi.length) {
    throw new Error('Nessun deposito restituito: l\'account non vede piu\' l\'hub, ' +
                    'oppure il fornitore ha spostato il servizio.');
  }
  return depositi;
}


// ---------------------------------------------------------------------------
// normalizzazione
// ---------------------------------------------------------------------------

/** Riduce l'oggetto annidato a una riga piatta: billing.dueNowEuro, ecc. */
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

  // Colonna calcolata: dice su quanti depositi si puo' davvero mandare una mail.
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
 * Un indirizzo per persona, non per deposito.
 *
 * Chi ha lasciato tre bagagli in tre cassetti ha generato tre righe con la
 * stessa email: senza dedup riceverebbe tre richieste di recensione. Restano
 * fuori i depositi non ritirati, a cui una recensione non si chiede.
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

    // Le date sono ISO 8601, quindi l'ordine alfabetico e' anche cronologico.
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
// E-18: le colonne di stato sopravvivono alla riscrittura
// ---------------------------------------------------------------------------

/**
 * Legge dalla scheda Lista invio cio' che l'invio ha gia' scritto, e lo
 * restituisce indicizzato per email minuscola:
 *   { 'tizio@example.com': ['si', '18/08/2026', 'consegnata'], ... }
 *
 * Tollerante di proposito: se la scheda non c'e', se e' vuota, o se
 * l'intestazione sta su una riga diversa, torna una mappa vuota invece di
 * far fallire tutta la corsa. Perdere una corsa e' peggio che perdere il
 * colore di una colonna.
 */
function leggiStato_(scheda) {
  var mappa = {};
  if (!scheda) { return mappa; }

  var dati = scheda.getDataRange().getValues();
  if (!dati.length) { return mappa; }

  // L'intestazione e' la prima riga che contiene una cella «email»: cosi'
  // funziona sia col foglio scritto da questo script (riga 2) sia con uno
  // importato a mano (riga 1).
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

  // Se nessuna colonna di stato esiste ancora, non c'e' niente da preservare.
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

    // Righe mai toccate dall'invio non vale la pena tenerle in memoria.
    if (valori.some(function (v) { return String(v).trim() !== ''; })) {
      mappa[email] = valori;
    }
  }

  return mappa;
}


// ---------------------------------------------------------------------------
// scrittura
// ---------------------------------------------------------------------------

function scriviScheda_(foglio, nome, colonne, righe, nota) {
  var scheda = foglio.getSheetByName(nome);
  if (!scheda) {
    scheda = foglio.insertSheet(nome);
  }

  var intestazione = colonne.map(function (_, i) { return i === 0 ? nota : ''; });
  var valori = [intestazione, colonne].concat(righe);

  scheda.clear();

  // La griglia va allargata prima di scrivere, altrimenti setValues sbatte
  // contro il bordo del foglio.
  if (scheda.getMaxRows() < valori.length) {
    scheda.insertRowsAfter(scheda.getMaxRows(), valori.length - scheda.getMaxRows() + 10);
  }
  if (scheda.getMaxColumns() < colonne.length) {
    scheda.insertColumnsAfter(scheda.getMaxColumns(), colonne.length - scheda.getMaxColumns() + 2);
  }

  scheda.getRange(1, 1, valori.length, colonne.length).setValues(valori);
  scheda.setFrozenRows(2);

  Logger.log('Scritte ' + righe.length + ' righe nella scheda \u00ab' + nome + '\u00bb.');
}


// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

/**
 * Aggiunge la voce di menu «Nutrie» quando si apre il foglio.
 *
 * L'aggiornamento notturno non si crea da qui: si imposta a mano dall'editor,
 * pannello Attivatori, sulla funzione aggiornaDepositi.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrie')
    .addItem('Aggiorna adesso', 'aggiornaDepositi')
    .addToUi();
}
