/**
 * Export degli incassi di Venezia dentro il Google Sheet, senza PC acceso.
 *
 * Gira su Apps Script, cioe' sui server di Google: entra nel pannello PromoTec
 * (panel.kiosk-vendor.example), apre la pagina Counters, scarica i mesi disponibili e li
 * accumula nella scheda «Incassi Venezia» del foglio a cui e' agganciato.
 *
 * DIFFERENZA CHE CONTA RISPETTO A PISA. Lo script di Pisa riscrive il foglio
 * per intero a ogni corsa, perche' l'API del gestionale conserva tutto lo
 * storico. Qui no: il pannello di Venezia tiene SOLO TRE MESI, quindi il
 * foglio e' l'archivio e non uno specchio. Questo script non cancella MAI
 * righe gia' presenti: legge quelle che ci sono, ci sovrascrive i mesi appena
 * scaricati indicizzando per numero di scontrino, e riscrive l'unione. Un mese
 * uscito dalla finestra dei tre resta nel foglio per sempre.
 *
 * IL PANNELLO E' UN TELECOMANDO, NON UN GESTIONALE DI SOLA LETTURA. Accanto ai
 * bottoni che servono a leggere ce ne sono altri che agiscono sull'hardware di
 * Cannaregio: «Unbook All» libera tutte le prenotazioni, «Reboot sysytem»
 * riavvia l'impianto, «Open Ex.Door» apre la porta esterna, e i 56 bottoni
 * «Locker100»-«Locker155» aprono un cassetto ciascuno. Nel browser quei
 * bottoni chiedono conferma, ma la conferma e' JavaScript: un client HTTP la
 * scavalca senza accorgersene, quindi qui quella protezione non esiste.
 *
 * Per questo lo script ragiona per LISTA DI CIO' CHE E' CONSENTITO, non per
 * lista di cio' che e' vietato: puo' premere soltanto i quattro bottoni
 * elencati in BOTTONI_CONSENTITI, e controllaDati_() rifiuta qualunque altro
 * nome di bottone finisca nel payload. Una lista di divieti avrebbe il difetto
 * di non riconoscere un bottone pericoloso rinominato dal fornitore.
 *
 * LE PAGINE SI SERVONO IN DUE TEMPI. La prima risposta del server e' uno
 * scheletro senza dati: la tendina dei mesi arriva vuota e i bottoni dei
 * cassetti non ci sono. In fondo alla pagina c'e' uno <script> con
 * __doPostBack('__Page','PBArg') che il browser esegue subito, ed e' quel
 * secondo postback a riempire tutto. Ci pensa Sessione_.posta(). Senza, si
 * vede una pagina vuota e si crede che il pannello sia cambiato: e' costato
 * una sessione, il 18/08/2026.
 *
 * Le credenziali NON stanno qui dentro: stanno nelle Proprieta' script del
 * progetto (Impostazioni progetto -> Proprieta' script).
 *   VENEZIA_USER      obbligatoria, lo User Name della prima schermata
 *   VENEZIA_PASSWORD  obbligatoria, la System password della seconda
 *   VENEZIA_SISTEMA   facoltativa, default «Luggage Cannaregio Dyn»
 *
 * Gemello Python, che fa lo stesso lavoro sul PC e accumula in un CSV:
 * C:\path\to\automations\venezia-export\export_incassi.py
 */

var BASE_URL = 'https://panel.kiosk-vendor.example/';
var FUSO = 'Europe/Rome';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

var TAB_INCASSI = 'Incassi Venezia';
var SISTEMA_DEFAULT = 'Luggage Cannaregio Dyn';

// Le stesse colonne del CSV prodotto dal gemello Python, nello stesso ordine,
// cosi' i due archivi restano confrontabili riga per riga.
var COLONNE = ['mese', 'data', 'importoIvaInclusa', 'cassetto', 'scontrino', 'sconto'];

// La colonna su cui si deduplica: il pannello non riusa mai un numero di
// scontrino, quindi rileggere un mese due volte non crea doppioni.
var COL_SCONTRINO = 4;

// Formato di ogni colonna. «@» vuol dire testo: serve perche' altrimenti il
// foglio interpreta «08/2026» come una data e «2026-06-01 09:31:56» come un
// timestamp, e l'archivio smette di somigliare a quello che il pannello ha
// davvero mandato. Importo e sconto restano numeri, cosi' si sommano.
var FORMATI = ['@', '@', '0.00', '@', '@', '0.00'];

// I SOLI bottoni che questo script puo' premere. Tutto il resto viene
// rifiutato da controllaDati_(), compreso cio' che oggi non esiste.
var BOTTONI_CONSENTITI = [
  /^btnSelecUser$/i,          // «Select», conferma lo User Name
  /^btnSelectSystem_\d+$/i,   // sceglie l'impianto
  /^BtnCounters$/i,           // apre la pagina Counters
  /^BtnGetCounterRecords$/i   // «Get Incoming», scarica il mese
];

// Non globale di proposito: una regexp con /g si porta dietro lastIndex fra
// una .test() e l'altra e comincia a dare risposte alternate.
var AUTO_POSTBACK = /__doPostBack\(\s*'__Page'\s*,\s*'PBArg'\s*\)/;

// IL PANNELLO VA IN LETARGO. kiosk-vendor.example spegne l'applicazione dopo un periodo
// di inattivita' e la riavvia alla prima richiesta: chi bussa mentre si sta
// svegliando resta appeso e va in timeout. Misurato il 2026-08-19, sei
// chiamate di fila da freddo: timeout a 25s, poi 12,3s, 7,8s, 2,7s, 3,8s,
// 0,5s. Da qui la sveglia e i tentativi qui sotto.
var SVEGLIE = 4;          // chiamate a vuoto per far ripartire l'applicazione
var PAUSA_SVEGLIA = 10000;
var TENTATIVI = 2;        // corse complete, se la prima cade in timeout
var PAUSA_TENTATIVO = 15000;


// ---------------------------------------------------------------------------
// il comando
// ---------------------------------------------------------------------------

/**
 * La funzione da lanciare, a mano dal menu «Nutrie» o da un attivatore.
 *
 * L'attivatore non si crea da qui: si imposta a mano dall'editor, pannello
 * Attivatori, su questa funzione. Una volta al mese basta, ma una volta al
 * giorno non fa danno e mette al riparo da un mese saltato.
 */
function aggiornaIncassi() {
  // Due esecuzioni sovrapposte riscriverebbero la scheda insieme e potrebbero
  // lasciarla a meta'. Capita facilmente con un attivatore giornaliero e una
  // corsa lanciata a mano nello stesso momento.
  var lucchetto = LockService.getScriptLock();
  if (!lucchetto.tryLock(30000)) {
    throw new Error('Un\'altra corsa e\' gia\' in esecuzione. Riprova fra qualche minuto.');
  }

  try {
    svegliaPannello_();

    for (var tentativo = 1; tentativo <= TENTATIVI; tentativo++) {
      try {
        eseguiAggiornamento_();
        return;
      } catch (errore) {
        // Si riparte da capo solo per i timeout, che sono il letargo del
        // pannello. Un errore di merito — credenziali sbagliate, pannello
        // cambiato — va mostrato subito, non ritentato.
        if (!eTimeout_(errore) || tentativo === TENTATIVI) throw errore;
        Logger.log('Tentativo ' + tentativo + ' caduto in timeout, ricomincio da capo.');
        Utilities.sleep(PAUSA_TENTATIVO);
      }
    }
  } finally {
    lucchetto.releaseLock();
  }
}


/**
 * Bussa al pannello finche' non risponde, prima di cominciare sul serio.
 *
 * Sono chiamate buttate via: non servono i dati e non serve la sessione, che
 * la corsa vera si apre da sola. Servono solo a far riavviare l'applicazione
 * mentre nessuno dipende ancora dal risultato. Se falliscono tutte si prova
 * lo stesso: magari e' lenta ma viva.
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
        Logger.log('Pannello sveglio alla chiamata ' + i + '.');
        return;
      }
      Logger.log('Sveglia ' + i + ': il pannello ha risposto ' + risposta.getResponseCode() + '.');
    } catch (errore) {
      Logger.log('Sveglia ' + i + ': ' + errore.message);
    }
    Utilities.sleep(PAUSA_SVEGLIA);
  }
  Logger.log('Il pannello non ha risposto alle chiamate di sveglia: provo lo stesso.');
}


/**
 * Se un errore e' il pannello che non risponde, e non un errore di merito.
 *
 * Si guarda il testo perche' UrlFetchApp non alza tipi distinti: il timeout
 * arriva come Exception con dentro «Timeout: https://panel.kiosk-vendor.example/».
 */
function eTimeout_(errore) {
  var testo = String(errore && errore.message ? errore.message : errore).toLowerCase();
  return testo.indexOf('timeout') !== -1 ||
         testo.indexOf('address unavailable') !== -1 ||
         testo.indexOf('dns error') !== -1 ||
         testo.indexOf('ha risposto 5') !== -1;  // il 500 di kiosk-vendor sotto sforzo
}


function eseguiAggiornamento_() {
  var prop = PropertiesService.getScriptProperties();
  var utente = prop.getProperty('VENEZIA_USER');
  var password = prop.getProperty('VENEZIA_PASSWORD');
  var sistema = prop.getProperty('VENEZIA_SISTEMA') || SISTEMA_DEFAULT;

  if (!utente || !password) {
    throw new Error(
      'Mancano VENEZIA_USER o VENEZIA_PASSWORD nelle Proprieta\' script ' +
      '(Impostazioni progetto -> Proprieta\' script).'
    );
  }

  var sessione = new Sessione_();
  var pagina = entra_(sessione, utente, password, sistema);
  pagina = apriCounters_(sessione, pagina);

  var mesi = pagina.opzioni('monthList');
  if (!mesi.length) {
    throw new Error(
      'La pagina Counters non espone la lista dei mesi. Se l\'auto-postback ' +
      '__Page/PBArg non basta piu\', il pannello e\' cambiato.'
    );
  }
  Logger.log('Mesi disponibili sul pannello: ' + mesi.join(', '));

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
    riepilogo.push(mesi[i] + ': ' + esito.righe.length + ' transazioni, ' + totale.toFixed(2) + ' EUR');
    Logger.log('  ' + riepilogo[riepilogo.length - 1]);
  }

  var righe = ordina_(archivio);
  var incasso = 0;
  for (var k = 0; k < righe.length; k++) incasso += Number(righe[k][2]) || 0;

  var nota = 'Archivio incassi Venezia (pannello PromoTec). Aggiornato il ' +
    Utilities.formatDate(new Date(), FUSO, 'yyyy-MM-dd HH:mm') + '. ' +
    righe.length + ' transazioni, ' + incasso.toFixed(2) + ' EUR. ' +
    'Nuove in questa corsa: ' + (righe.length - prima) + '. ' +
    'Il pannello tiene solo tre mesi: questo foglio e\' l\'archivio, non uno specchio. ' +
    'Non cancellare ne\' riordinare righe a mano.';

  scriviScheda_(foglio, TAB_INCASSI, COLONNE, righe, nota);

  var messaggio = riepilogo.join('  |  ') + '  ->  nuove: ' + (righe.length - prima);
  Logger.log(messaggio);
  try {
    foglio.toast(messaggio, 'Incassi Venezia', 10);
  } catch (e) {
    // Da un attivatore non c'e' nessuno a guardare il toast: non e' un errore.
  }
}


// ---------------------------------------------------------------------------
// navigazione del pannello
// ---------------------------------------------------------------------------

/**
 * Login in due schermate.
 *
 * 1. «User Name» -> campo txtUserName, bottone btnSelecUser.
 * 2. «System password» -> campo txtSysPsw, piu' i tre bottoni di impianto.
 *    La password e la scelta dell'impianto viaggiano nello stesso POST, come
 *    fa il browser quando si scrive la password e si preme il bottone.
 */
function entra_(sessione, utente, password, sistema) {
  var pagina = sessione.apri();

  var campoUtente = pagina.campoTesto('user');
  if (!campoUtente) {
    throw new Error('Pagina di login inattesa: non trovo il campo dello User Name.');
  }
  var bottone = pagina.bottonePerValore('Select');
  if (!bottone) {
    throw new Error(
      'Pagina di login inattesa: non trovo il bottone «Select». ' +
      'I bottoni presenti sono: ' + pagina.valoriBottoni().join(', ') + '.'
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
        'Sistema «' + sistema + '» non trovato. Quelli disponibili sono: ' +
        pagina.valoriBottoni().join(', ') + '. Correggi VENEZIA_SISTEMA nelle Proprieta\' script.'
      );
    }
    dati = pagina.statoForm();
    dati[campoPassword] = password;
    pagina = sessione.posta(pagina, dati, impianto);
  }

  if (!pagina.bottonePerValore('Counters')) {
    throw new Error(
      'Login non riuscito: dopo l\'accesso non trovo il bottone «Counters». ' +
      'Controlla utente, System password e nome del sistema.'
    );
  }
  return pagina;
}


function apriCounters_(sessione, pagina) {
  var bottone = pagina.bottonePerValore('Counters');
  if (!bottone) {
    throw new Error('Bottone «Counters» sparito dal menu.');
  }
  return sessione.posta(pagina, pagina.statoForm(), bottone);
}


/**
 * Sceglie un mese e preme «Get Incoming».
 *
 * Torna la pagina nuova, che serve per il postback successivo, insieme alle
 * righe lette. Il mese va rimesso a ogni giro: la pagina che torna porta la
 * selezione precedente.
 */
function scaricaMese_(sessione, pagina, mese) {
  var bottone = pagina.bottonePerNome('BtnGetCounterRecords');
  if (!bottone) {
    throw new Error(
      'Non trovo il bottone «Get Incoming» (BtnGetCounterRecords) nella pagina Counters.'
    );
  }

  var dati = pagina.statoForm();
  dati['monthList'] = mese;

  var nuova = sessione.posta(pagina, dati, bottone);
  var celle = righeIncassi_(nuova);
  if (celle === null) {
    throw new Error(
      'La tabella dgIncassi non c\'e\' nella risposta per il mese ' + mese + '. ' +
      'O il pannello e\' cambiato, o la sessione e\' scaduta a meta\' corsa.'
    );
  }

  var righe = [];
  for (var i = 0; i < celle.length; i++) {
    var c = celle[i];
    // data, importo, cassetto, scontrino, sconto -> con il mese davanti
    righe.push([mese, c[0], Number(c[1]) || 0, c[2], c[3], Number(c[4]) || 0]);
  }
  return { pagina: nuova, righe: righe };
}


/**
 * Le righe della tabella degli incassi.
 *
 * Ancorata all'id «dgIncassi» e non alla posizione: la pagina e' piena di
 * tabelle usate per impaginare, e pescare «la prima» sarebbe fragile.
 * Torna null se la tabella manca del tutto, che e' cosa diversa da un mese
 * senza transazioni, il quale torna una lista vuota.
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
    // L'intestazione usa <th>, quindi non produce celle e cade da sola.
    if (celle.length >= 5) righe.push(celle);
  }
  return righe;
}


// ---------------------------------------------------------------------------
// la sessione HTTP
// ---------------------------------------------------------------------------

/**
 * UrlFetchApp non tiene i cookie da solo, e il pannello e' tutto sessione:
 * senza ASP.NET_SessionId ogni postback ricomincia dal login. Qui i cookie si
 * raccolgono a mano dalle intestazioni Set-Cookie e si rimandano indietro.
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
    throw new Error('Il pannello ha risposto ' + codice + '. Corsa interrotta.');
  }
  return risposta.getContentText();
};

Sessione_.prototype.apri = function () {
  return new Pagina_(this.chiama_({ method: 'get' }));
};

/**
 * Un postback e il suo seguito.
 *
 * `pagina` e' quella da cui il postback parte, e serve a controllare che nel
 * payload non finisca il nome di un bottone che non siamo autorizzati a
 * premere. `bottone` e' il solo comando che questa chiamata preme.
 *
 * Dopo il POST, finche' la risposta chiede l'auto-postback lo rifa' al posto
 * del browser. Il tetto di tre giri esiste solo per non entrare in un ciclo
 * infinito se un giorno il pannello lo chiedesse per sempre: al 2026-08-19 ne
 * basta sempre uno.
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
    // Un postback della pagina su se stessa: nessun bottone premuto.
    seguito['__EVENTTARGET'] = '__Page';
    seguito['__EVENTARGUMENT'] = 'PBArg';
    controllaDati_(intermedia, seguito);
    html = this.chiama_({ method: 'post', payload: seguito });
  }
  return new Pagina_(html);
};

/**
 * L'ultima rete prima che un POST parta.
 *
 * Ragiona per lista di cio' che e' consentito. Una chiave del payload puo'
 * passare solo se e' un campo tecnico di WebForms, oppure un campo di testo
 * che la pagina ha dichiarato (quelli non possono premere niente), oppure uno
 * dei quattro bottoni di BOTTONI_CONSENTITI. Qualunque altro nome di bottone
 * fa fallire la corsa, anche uno che oggi non esiste.
 */
function controllaDati_(pagina, dati) {
  for (var nome in dati) {
    if (nome.indexOf('__') === 0 || nome === 'monthList') continue;

    // I campi non-submit della pagina: testo, password, hidden. Non sono
    // comandi, qualunque cosa il fornitore decida di chiamarli.
    if (pagina.campi.hasOwnProperty(nome) && pagina.tipi[nome] !== 'submit') continue;

    if (bottoneConsentito_(nome)) continue;

    throw new Error(
      'Rifiuto di mandare «' + nome + '» al pannello: non e\' fra i comandi che ' +
      'questo script puo\' premere. Se il pannello e\' cambiato, va aggiornata ' +
      'la lista BOTTONI_CONSENTITI, a ragion veduta.'
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
// lettura dell'HTML
// ---------------------------------------------------------------------------

/**
 * Una pagina WebForms: i campi del form, i bottoni, e l'html grezzo per il
 * resto. Niente parser vero, che su Apps Script non c'e': espressioni
 * regolari, che su un HTML generato sempre allo stesso modo bastano.
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

/** I campi che ogni postback deve riportare indietro: viewstate e compagnia. */
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
 * Un bottone dal testo che ci sta scritto sopra, per corrispondenza ESATTA.
 *
 * Niente ricerca parziale, di proposito. «Luggage Cannaregio» e' contenuto
 * dentro «Luggage Cannaregio cloud»: una corrispondenza approssimativa
 * sceglierebbe l'impianto sbagliato senza dirlo. E in generale, il momento in
 * cui una ricerca esatta fallisce e' il momento in cui il pannello e'
 * cambiato, cioe' il peggiore per tirare a indovinare: meglio fermarsi.
 */
Pagina_.prototype.bottonePerValore = function (testo) {
  testo = String(testo).trim().toLowerCase();
  for (var i = 0; i < this.bottoni.length; i++) {
    if (this.bottoni[i].valore.trim().toLowerCase() === testo) return this.bottoni[i];
  }
  return null;
};

/** Un bottone dal suo name, per corrispondenza esatta. Stessa ragione. */
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
 * Un campo di testo il cui nome contiene il frammento dato.
 *
 * Ristretto ai campi di tipo «text»: cosi' non puo' mai pescare un hidden
 * tecnico ne', tanto meno, un bottone.
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
 * Il campo della System password, cercato per tipo e non per nome: sul
 * pannello si chiama «txtSysPsw», che non contiene la parola «password».
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
    .replace(/&amp;/g, '&');  // per ultimo, o si mangia le altre entita'
}


// ---------------------------------------------------------------------------
// archivio
// ---------------------------------------------------------------------------

/**
 * Le righe gia' nel foglio, indicizzate per numero di scontrino.
 *
 * E' la parte che rende lo script sicuro da rilanciare: quello che c'e' non si
 * perde, e i mesi usciti dalla finestra dei tre restano.
 */
function leggiArchivio_(scheda) {
  var esistenti = {};
  if (!scheda) return esistenti;

  var ultima = scheda.getLastRow();
  if (ultima < 3) return esistenti;  // riga 1 nota, riga 2 intestazione

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

/** Ordinate per data, che e' l'ordine in cui uno le vuole leggere. */
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
// scrittura
// ---------------------------------------------------------------------------

function scriviScheda_(foglio, nome, colonne, righe, nota) {
  var scheda = foglio.getSheetByName(nome);
  if (!scheda) scheda = foglio.insertSheet(nome);

  var intestazione = colonne.map(function (_, i) { return i === 0 ? nota : ''; });
  var valori = [intestazione, colonne].concat(righe);

  // NIENTE clear() qui. Prima si scriveva sopra un foglio svuotato, e fra lo
  // svuotamento e la scrittura c'era una finestra di qualche secondo in cui la
  // scheda era vuota: se l'esecuzione moriva li' — e questo pannello va in
  // timeout facile — l'archivio spariva, e i mesi usciti dalla finestra dei
  // tre non li ha piu' nessuno. Ora si sovrascrive e basta, e la coda vecchia
  // si toglie solo DOPO che i dati nuovi sono a posto.

  // La griglia va allargata prima di scrivere, altrimenti setValues sbatte
  // contro il bordo del foglio.
  if (scheda.getMaxRows() < valori.length) {
    scheda.insertRowsAfter(scheda.getMaxRows(), valori.length - scheda.getMaxRows() + 10);
  }
  if (scheda.getMaxColumns() < colonne.length) {
    scheda.insertColumnsAfter(scheda.getMaxColumns(), colonne.length - scheda.getMaxColumns() + 2);
  }

  // I formati vanno messi PRIMA di scrivere, o il foglio converte «08/2026» in
  // una data e la riga non torna piu' uguale a quella del pannello.
  if (righe.length) {
    for (var c = 0; c < colonne.length; c++) {
      scheda.getRange(3, c + 1, righe.length, 1).setNumberFormat(FORMATI[c]);
    }
  }

  scheda.getRange(1, 1, valori.length, colonne.length).setValues(valori);

  // Ora che i dati nuovi sono scritti, via l'eventuale coda della versione
  // precedente. Con un archivio che cresce non succede quasi mai, ma se un
  // giorno succedesse senza questo taglio resterebbero righe fantasma in
  // fondo, che IMPORTRANGE porterebbe sul foglio di gestione.
  var ultima = scheda.getLastRow();
  if (ultima > valori.length) {
    scheda.deleteRows(valori.length + 1, ultima - valori.length);
  }
  scheda.setFrozenRows(2);

  Logger.log('Scritte ' + righe.length + ' righe nella scheda «' + nome + '».');
}


// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrie')
    .addItem('Aggiorna incassi Venezia', 'aggiornaIncassi')
    .addToUi();
}
