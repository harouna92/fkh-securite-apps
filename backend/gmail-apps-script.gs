/************************************************************************
 * FKH SÉCURITÉ — Pipeline mails automatique (#5)
 * ---------------------------------------------------------------------
 * Ce script tourne dans TON compte Gmail (script.google.com) et transfère
 * les mails de bon de commande / demande (BDC) au Worker Cloudflare, qui
 * les passe dans l'IA. Les demandes détectées apparaissent ensuite toutes
 * seules dans l'appli GESTION → Suivi demandes → « en recherche » avec la
 * mention « 🤖 à vérifier » (et, si c'est une intervention/ronde, dans la
 * section Interventions grâce à l'aiguillage #1).
 *
 * ─── INSTALLATION (à faire une seule fois, côté Zeus) ───
 * 1. Va sur https://script.google.com → « Nouveau projet ».
 * 2. Colle TOUT ce fichier (remplace le code par défaut).
 * 3. Dans Gmail, crée un libellé « FKH-BDC » et un filtre qui l'applique
 *    aux mails de demande (ex. expéditeurs Securitas/Sotel…, ou mot-clé
 *    « bon de commande »). Tu peux aussi poser le libellé à la main.
 * 4. (Optionnel mais recommandé) pose le secret côté Worker pour durcir
 *    le token :  npx.cmd wrangler secret put MAIL_INGEST_TOKEN
 *    puis mets la MÊME valeur dans TOKEN ci-dessous. Sinon, laisse la
 *    valeur par défaut (elle marche déjà).
 * 5. Menu « Exécuter » → choisis la fonction  installerDeclencheur  une
 *    fois (autorise l'accès Gmail quand Google le demande). Ça crée un
 *    déclencheur qui lance le traitement toutes les 5 minutes.
 * 6. Pour tester tout de suite : « Exécuter » →  traiterMailsFKH .
 ************************************************************************/

// ⚙️ CONFIG — à ajuster
var WORKER_URL = 'https://fkh-gestion-api.hacamara2.workers.dev';
var TOKEN      = 'fkh-mail-ingest-2026'; // doit être identique au secret MAIL_INGEST_TOKEN (ou laisser tel quel)
var LABEL_A_TRAITER = 'FKH-BDC';         // libellé des mails à analyser
var LABEL_TRAITE    = 'FKH-Traite';      // libellé posé une fois envoyé (anti-doublon)
var MAX_PAR_PASSAGE = 15;                // sécurité : nb max de mails traités par exécution

/** Boucle principale : cherche les mails à traiter et les envoie au Worker. */
function traiterMailsFKH() {
  var traite = getOrCreateLabel(LABEL_TRAITE);
  var query = 'label:' + LABEL_A_TRAITER + ' -label:' + LABEL_TRAITE;
  var threads = GmailApp.search(query, 0, MAX_PAR_PASSAGE);
  var envoyes = 0;
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    var m = msgs[msgs.length - 1]; // le dernier message du fil
    try {
      var payload = {
        msgId:   m.getId(),
        subject: m.getSubject() || '',
        body:    m.getPlainBody() ? m.getPlainBody().slice(0, 8000) : '',
        from:    m.getFrom() || ''
      };
      var res = UrlFetchApp.fetch(WORKER_URL + '/mail/ingest?k=' + encodeURIComponent(TOKEN), {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        threads[i].addLabel(traite); // marqué traité → jamais renvoyé
        envoyes++;
      } else {
        Logger.log('Echec (' + code + ') pour « ' + payload.subject + ' » : ' + res.getContentText());
      }
    } catch (e) {
      Logger.log('Erreur sur un mail : ' + e);
    }
  }
  Logger.log(envoyes + ' mail(s) envoyé(s) au Worker.');
  return envoyes;
}

/** Crée le déclencheur automatique (toutes les 5 min). À lancer UNE fois. */
function installerDeclencheur() {
  // Évite les doublons de déclencheur
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'traiterMailsFKH') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('traiterMailsFKH').timeBased().everyMinutes(5).create();
  Logger.log('Déclencheur installé : traiterMailsFKH toutes les 5 minutes.');
}

/** Utilitaire : récupère un libellé, le crée s'il n'existe pas. */
function getOrCreateLabel(name) {
  var lbl = GmailApp.getUserLabelByName(name);
  return lbl ? lbl : GmailApp.createLabel(name);
}
