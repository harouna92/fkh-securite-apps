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
    const plage = ligne.match(/\bBuilds?\s+b(\d{2,4})\s+a\s+b(\d{2,4})\b/i);
    if (plage) for (let n = +plage[1]; n <= +plage[2]; n++) vus.add(n);
  });
  return vus;
}

function builds_inscrits() {
  const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  return new Set((j.items || []).map((x) => x.b).filter(Boolean));
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
