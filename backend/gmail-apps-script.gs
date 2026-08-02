/************************************************************************
 * FKH SÉCURITÉ — Pipeline mails automatique (#5, mis à niveau 01/08/2026)
 * ---------------------------------------------------------------------
 * Ce script tourne dans le compte Gmail QUI REÇOIT les mails missions
 * (script.google.com) et transfère les mails des donneurs d'ordre au
 * Worker Cloudflare. L'IA les analyse : les demandes détectées arrivent
 * toutes seules dans GESTION → Suivi demandes → « en recherche », et TOUS
 * les mails remontés apparaissent dans la section 📧 Mails missions
 * (super-admin) avec la comparaison mails ↔ Planning.
 *
 * ⚠️ AUCUN filtre/libellé à créer : le script cherche tout seul les mails
 * des 4 expéditeurs connus + mots-clés (décision Zeus 01/08/2026).
 *
 * ─── INSTALLATION (une seule fois, côté Zeus) ───
 * 1. Connecte-toi au compte Gmail qui reçoit les mails missions.
 * 2. https://script.google.com → « Nouveau projet » → colle TOUT ce fichier.
 * 3. Menu « Exécuter » → fonction  installerDeclencheur  (autorise l'accès
 *    Gmail quand Google le demande) → traitement toutes les 5 minutes.
 * 4. Pour tester tout de suite : « Exécuter » →  traiterMailsFKH .
 ************************************************************************/

// ⚙️ CONFIG
var WORKER_URL = 'https://fkh-gestion-api.hacamara2.workers.dev';
var TOKEN      = 'fkh-mail-ingest-2026'; // = secret MAIL_INGEST_TOKEN côté Worker (défaut OK)

// Périmètre (décision Zeus 01/08/2026, révisée) : le script envoie TOUS les mails REÇUS.
// C'est le Worker (IA + critères mission) qui ne GARDE que ce qui concerne les missions —
// le reste est marqué « hors-mission » (jamais ré-analysé) et servira à d'autres sections plus tard.
var ADRESSES_A_NOUS = ['fkhsecurite', 'hacamara2', 'bahalphaba95']; // nos propres adresses : jamais renvoyées
var LABEL_TRAITE   = 'FKH-Traite'; // posé sur les fils envoyés (repère visuel ; l'anti-doublon réel est côté Worker)
var FENETRE        = '1d';         // fenêtre de recherche à chaque passage (le Worker dédoublonne)
var MAX_MESSAGES   = 30;           // sécurité : nb max de messages envoyés par exécution

/** Boucle principale : envoie tous les mails reçus récents au Worker (qui trie). */
/** b223 : point d'entree du declencheur. Il signale TOUJOURS son passage (temoin de vie),
 *  meme s'il n'y a aucun mail ou si le traitement plante : c'est ce signal qui permet a
 *  l'application de dire « la collecte est a l'arret » au lieu de rester silencieuse. */
function traiterMailsFKH() {
  var vus = 0, envoyes = 0, err = '';
  try { var r = _collecterMails(); vus = r.vus; envoyes = r.envoyes; }
  catch (e) { err = String(e); Logger.log('ERREUR : ' + err); }
  pingTemoinDeVie(vus, envoyes, err);
  if (err) throw new Error(err);   // remonte l'erreur dans le journal Apps Script
  return envoyes;
}

/** Envoie le temoin de vie au Worker. Ne doit jamais faire echouer la collecte. */
function pingTemoinDeVie(vus, envoyes, erreur) {
  try {
    UrlFetchApp.fetch(WORKER_URL + '/mail/ping?k=' + encodeURIComponent(TOKEN), {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ vus: vus, envoyes: envoyes, erreur: erreur || '' })
    });
  } catch (e) { Logger.log('Temoin de vie non envoye : ' + e); }
}

function _collecterMails() {
  var traite = getOrCreateLabel(LABEL_TRAITE);
  var query = 'newer_than:' + FENETRE + ' -in:sent -in:chats -in:trash -in:spam';
  var threads = GmailApp.search(query, 0, 40);
  var envoyes = 0, deja = 0;
  for (var i = 0; i < threads.length && envoyes < MAX_MESSAGES; i++) {
    var msgs = threads[i].getMessages();
    var touche = false;
    for (var j = 0; j < msgs.length && envoyes < MAX_MESSAGES; j++) {
      var m = msgs[j];
      // On ne renvoie pas nos propres messages
      var from = m.getFrom() || '';
      var aNous = false;
      for (var k = 0; k < ADRESSES_A_NOUS.length; k++) { if (from.indexOf(ADRESSES_A_NOUS[k]) >= 0) { aNous = true; break; } }
      if (aNous) continue;
      try {
        // b203 : on joint les PDF (bons de commande) en base64 -> le Worker les fait lire par l'IA (adresse exacte du site)
        var pdfs = [];
        try {
          var atts = m.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
          for (var z = 0; z < atts.length && pdfs.length < 2; z++) {
            var at = atts[z];
            if (String(at.getContentType()).indexOf('pdf') < 0) continue;
            if (at.getSize() > 3500000) continue; // 3,5 Mo max par PDF
            pdfs.push({ name: at.getName(), b64: Utilities.base64Encode(at.getBytes()) });
          }
        } catch (ePdf) { Logger.log('PDF ignore : ' + ePdf); }
        var payload = {
          msgId:   m.getId(),
          subject: m.getSubject() || '',
          body:    m.getPlainBody() ? m.getPlainBody().slice(0, 8000) : '',
          from:    from,
          pdfs:    pdfs
        };
        var res = UrlFetchApp.fetch(WORKER_URL + '/mail/ingest?k=' + encodeURIComponent(TOKEN), {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          touche = true;
          if (res.getContentText().indexOf('already') >= 0) deja++; else envoyes++;
        } else {
          Logger.log('Echec (' + code + ') pour « ' + payload.subject + ' » : ' + res.getContentText());
        }
      } catch (e) { Logger.log('Erreur sur un mail : ' + e); }
    }
    if (touche) threads[i].addLabel(traite);
  }
  Logger.log(envoyes + ' nouveau(x) mail(s) envoyé(s), ' + deja + ' déjà connus (dédoublonnés par le Worker).');
  return { vus: envoyes + deja, envoyes: envoyes };
}

/** Crée le déclencheur automatique (toutes les 5 min). À lancer UNE fois. */
function installerDeclencheur() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'traiterMailsFKH') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('traiterMailsFKH').timeBased().everyMinutes(5).create();
  pingTemoinDeVie(0, 0, '');
  var n = ScriptApp.getProjectTriggers().length;
  Logger.log('Déclencheur installé : traiterMailsFKH toutes les 5 minutes. Déclencheurs actifs sur le projet : ' + n);
}

/** Utilitaire : récupère un libellé, le crée s'il n'existe pas. */
function getOrCreateLabel(name) {
  var lbl = GmailApp.getUserLabelByName(name);
  return lbl ? lbl : GmailApp.createLabel(name);
}
