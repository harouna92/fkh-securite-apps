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

// Périmètre : expéditeurs connus + mots-clés dans l'OBJET (modifiable ici)
var EXPEDITEURS = [
  'securitas.fr',              // SECURITAS (reponse.nantes@…)
  'reseau-aquila.fr',          // AQUILA (permanence@…)
  'ranc-developpement.fr',     // RANC DEVELOPPEMENT (pc.securite@…)
  'banzai-communication.fr'    // BANZAI (prod@…)
];
var MOTS_CLES_OBJET = ['gardiennage', 'prestation', 'surveillance', 'annulation', '"bon de commande"'];

var LABEL_TRAITE   = 'FKH-Traite'; // posé sur les fils envoyés (repère visuel ; l'anti-doublon réel est côté Worker)
var FENETRE        = '3d';         // on regarde les mails des 3 derniers jours à chaque passage
var MAX_MESSAGES   = 30;           // sécurité : nb max de messages envoyés par exécution

/** Boucle principale : cherche les mails missions et les envoie au Worker. */
function traiterMailsFKH() {
  var traite = getOrCreateLabel(LABEL_TRAITE);
  var qFrom = EXPEDITEURS.map(function (d) { return 'from:' + d; }).join(' OR ');
  var qSubj = MOTS_CLES_OBJET.map(function (k) { return 'subject:' + k; }).join(' OR ');
  var query = '({' + qFrom + '} OR {' + qSubj + '}) newer_than:' + FENETRE + ' -in:sent -in:trash -in:spam';
  var threads = GmailApp.search(query, 0, 40);
  var envoyes = 0, deja = 0;
  for (var i = 0; i < threads.length && envoyes < MAX_MESSAGES; i++) {
    var msgs = threads[i].getMessages();
    var touche = false;
    for (var j = 0; j < msgs.length && envoyes < MAX_MESSAGES; j++) {
      var m = msgs[j];
      // On ne renvoie pas nos propres réponses
      var from = m.getFrom() || '';
      if (from.indexOf('fkhsecurite') >= 0) continue;
      try {
        var payload = {
          msgId:   m.getId(),
          subject: m.getSubject() || '',
          body:    m.getPlainBody() ? m.getPlainBody().slice(0, 8000) : '',
          from:    from
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
  return envoyes;
}

/** Crée le déclencheur automatique (toutes les 5 min). À lancer UNE fois. */
function installerDeclencheur() {
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
