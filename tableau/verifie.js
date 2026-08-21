#!/usr/bin/env node
/* Garde-fou du tableau de bord des états.
   Compare les builds réellement poussés (messages de commit « Gestion bNNN »)
   avec ceux inscrits dans tableau/etats.json, et signale les manquants.
   Sort en code 1 s'il en manque : un hook peut donc bloquer/alerter dessus.
   Usage : node tableau/verifie.js            */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const FICHIER = path.join(RACINE, 'tableau', 'etats.json');

function builds_pousses() {
  // on ne regarde que ce qui est sur la branche publiée
  const log = execSync('git log --pretty=%s origin/main -400', { cwd: RACINE, encoding: 'utf8' });
  const vus = new Set();
  log.split('\n').forEach((ligne) => {
    // « Gestion b311 : … » mais aussi « Builds b237 a b247 … »
    const m = ligne.match(/\bGestion\s+b(\d{2,4})\b/i);
    if (m) vus.add(+m[1]);
    // « b459 — ... » : depuis aout 2026 les messages de commit commencent directement par
    // le build, sans le mot « Gestion ». Sans cette ligne le garde-fou repondait « a jour »
    // en ne voyant que les anciens builds (constate le 21/08 : 106 vus alors qu'on est a b459).
    const seul = ligne.match(/^b(\d{2,4})/i);
    if (seul) vus.add(+seul[1]);
    const plage = ligne.match(/\bBuilds?\s+b(\d{2,4})\s+a\s+b(\d{2,4})\b/i);
    if (plage) for (let n = +plage[1]; n <= +plage[2]; n++) vus.add(n);
  });
  return vus;
}

function builds_inscrits() {
  const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  // le champ `b` est tantot un nombre (222), tantot un texte ("b440"), tantot un autre
  // chantier ("d3"). On normalise, sinon des builds inscrits passaient pour absents.
  const nums = (j.items || []).map((x) => {
    if (typeof x.b === 'number') return x.b;
    const m = String(x.b || '').match(/^b(\d{2,4})$/i);
    return m ? +m[1] : null;
  }).filter((n) => n !== null);
  return new Set(nums);
}

const pousses = builds_pousses();
const inscrits = builds_inscrits();
const manquants = [...pousses].filter((b) => !inscrits.has(b)).sort((a, b) => a - b);

if (!manquants.length) {
  console.log('Tableau de bord a jour : les ' + pousses.size + ' builds publies y figurent.');
  process.exit(0);
}

console.log('');
console.log('=== TABLEAU DE BORD INCOMPLET ===');
console.log(manquants.length + ' build(s) publie(s) mais absent(s) de tableau/etats.json :');
manquants.forEach((b) => {
  let titre = '';
  try {
    titre = execSync('git log --pretty=%s origin/main -400', { cwd: RACINE, encoding: 'utf8' })
      .split('\n').find((l) => new RegExp('\\bGestion\\s+b' + b + '\\b', 'i').test(l)) || '';
  } catch (e) {}
  console.log('  b' + b + (titre ? '  — ' + titre.slice(0, 90) : ''));
});
console.log('');
console.log('A faire : ajouter ces builds dans tableau/etats.json (items),');
console.log('avec titre, source, theme et « pourquoipas » (comment Zeus le constate).');
console.log('');
process.exit(1);
