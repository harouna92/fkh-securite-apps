'use strict';
// Contrôle "pas d'interrupteur non câblé" — à lancer AVANT chaque push (node gestion/wire_check.js).
// Un bouton = data-act="X". Son fil = un handler act==='X'. Un bouton sans handler = interrupteur non câblé.
var fs=require('fs');
var path=process.argv[2]||require('path').join(__dirname,'index.html');
var html=fs.readFileSync(path,'utf8');

var emit={}, m, re1=/data-act="([a-zA-Z0-9_]+)"/g;
while((m=re1.exec(html))){ emit[m[1]]=(emit[m[1]]||0)+1; }

var handle={}, re2=/act===(?:'|")([a-zA-Z0-9_]+)(?:'|")/g;
while((m=re2.exec(html))){ handle[m[1]]=(handle[m[1]]||0)+1; }

var boutonsSansFil=Object.keys(emit).filter(function(k){return !handle[k];}).sort();
var handlersOrphelins=Object.keys(handle).filter(function(k){return !emit[k];}).sort();

console.log('Fichier :', path);
console.log('Boutons (data-act) distincts :', Object.keys(emit).length);
console.log('Handlers (act===) distincts  :', Object.keys(handle).length);
console.log('');
console.log('🔴 INTERRUPTEURS NON CÂBLÉS (bouton sans handler) :', boutonsSansFil.length?boutonsSansFil.join(', '):'AUCUN ✅');
console.log('🟠 Handlers orphelins (fil posé, aucun bouton — souvent OK : boutons générés ailleurs) :', handlersOrphelins.length?handlersOrphelins.join(', '):'aucun');

// Le GATE bloquant = un bouton sans handler. Les orphelins sont juste informatifs (beaucoup de boutons sont créés hors data-act, ex. onclick direct).
if(boutonsSansFil.length){ console.log('\n❌ LIVRAISON REFUSÉE : '+boutonsSansFil.length+' bouton(s) non câblé(s). Brancher ou retirer avant push.'); process.exit(1); }
console.log('\n✅ Tous les boutons ont leur fil. Livraison autorisée (côté câblage).');
