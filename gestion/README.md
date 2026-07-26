# GESTION — application interne FKH SÉCURITÉ

Application web mono-fichier (un seul `index.html`, JavaScript « vanilla », aucune dépendance) pour la gestion opérationnelle quotidienne de FKH SÉCURITÉ : demandes clients, prises/fins de service, suivi des demandes, répertoire d'agents, carte de couverture, et supervision des appels de contrôle.

- **En ligne** : https://harouna92.github.io/fkh-securite-apps/gestion/
- **Source de vérité** : ce dépôt (`gestion/index.html`), avec l'historique complet dans les commits.
- **Hébergement** : GitHub Pages (statique). Voir *Déploiement* plus bas.

> ⚠️ **Données locales à l'appareil.** Aujourd'hui toutes les données sont dans le `localStorage` du navigateur : elles ne sont **ni partagées entre appareils/personnes, ni sauvegardées ailleurs**. Pour un usage multi-utilisateurs partagé + temps réel + mot de passe, il faut un backend (voir *Évolution prévue : Cloudflare*).

---

## Les 8 onglets

### 1. Demandes
Saisie d'une demande client → génère un texte prêt à copier-coller (3 formats : **groupe**, **agent**, **mission validée**).
- Combos mémorisés (client, prestation, type d'agent, type de site).
- **Vacations** en répéteur (H24, « dès que possible », « fin à l'arrivée du personnel »).
- **Contexte géographique** : villes proches auto + « mesurer vers » une autre ville (distance à vol d'oiseau + **temps de route** via OSRM).
- Format « mission validée » : **adresse en 3 champs** (n° de voie / type de voie / nom de la voie) + **numéro prise/fin de service** choisi dans un menu de **tous les numéros de tous les clients** (indépendant du client de la demande).
- Bouton **« Envoyer vers Suivi demandes »**.

### 2. Prise de service / 3. Fin de service
Même structure (`svcSection`). Compte-rendu copiable : client, site, agent, heure, photo, client avisé. « En retard » présent **uniquement sur Prise de service**.

### 4. Suivi demandes
Les demandes envoyées ici sont horodatées « prise en compte ». Buckets : **En recherche / Validées / Annulées / Non gérées** (+ motif), avec délai de traitement.
Par carte de demande :
- **📤 Infos agent** / **✅ Mission validée** : sélection ligne à ligne + copie.
- **🔍 Agents proches** : recoupement avec la Fiche agent → agents dans un **rayon réglable (20–150 km, défaut 100)**, filtres ADS/véhicule, triés par distance, bouton « associer » (agents retenus mémorisés). La ville de la demande est géolocalisée (stockée à l'envoi, ou à la volée).
- **🔺 Zone difficile** : marque le **département** de la ville comme difficile → remonte dans *Zone à couvrir*.

### 5. Fiche agent (répertoire)
Nom · **numéro(s) multiples** (unicité stricte **1 numéro = 1 agent**) · ville géolocalisée · fiabilité · 🚗 véhicule · 🛡️ ADS.
Recherche texte + **recherche par rayon** autour d'une ville + filtres.

### 6. Zone à couvrir
Carte choroplèthe des départements de France (GeoJSON chargé au runtime, projection SVG maison).
- **Comptage automatique d'agents par département** (depuis la Fiche agent), dégradé 🟥 peu → 🟩 beaucoup.
- **Zones difficiles** : départements marqués depuis *Suivi demandes* → **contour rouge** sur la carte + liste (avec retrait).

### 7. Thiam — appels de contrôle par site
Saisie d'un site → génère le planning des appels + alimente *Suivi des appels*.
- Champs : nom du site, client, agent, **numéro de l'agent**, heure de début (= prise de service), heure de fin (facultative).
- **Numéro inconnu → création auto de Fiche agent** : si le numéro n'est pas dans le répertoire, un bloc propose ville + CP ; à l'ajout, l'agent est créé (géolocalisé) dans la Fiche agent.
- **Sélecteur de mode** (scinde les 2 dimensions) : *Avant la prise de service* / *Pendant le service* / *Les deux*.
- **Moteur d'appels** :
  - *Pendant le service* : 1ᵉʳ appel au début, puis toutes les 2 h (mode Auto) **ou** un nombre choisi (1–10) équirépartis ; **dernier appel toujours ≤ fin − 30 min**.
  - *Avant la prise de service* : appel **−15 min** (⏰ arrivée à l'heure ?) + appel **départ agent** à −X min paramétrable (🚗 a-t-il pris la route ?).
  - **Décalage anti-collision entre sites** (15/20/30 min) pour que 2 sites n'aient pas les appels au même instant, borné à la fin de mission.
- **Conversion heure France → heure du Mali** pour chaque appel (Mali = UTC+0 ; décalage auto −2 h été / −1 h hiver ; mention « (veille) »).

### 8. Suivi des appels
Tableau de **pointage** des appels (les sites viennent de *Thiam*).
- Par appel : **case à cocher** (au clic → horodatage réel « ✅ appelé à HH:MM »), **commentaire en menu** (Injoignable / RAS / Autre à préciser…), **contrôleur de retard** (ligne rouge « ⚠️ EN RETARD » si non coché **5 min** après l'heure ; bandeau compteur ; réévalué toutes les 30 s).
- **Fiche « Agents injoignables »** : agrège les appels « Injoignable » par agent (nombre + détail site/heure prévue/heure réelle).

---

## Stockage des données (`localStorage`)

| Clé | Contenu |
|---|---|
| `fkh_clients` | liste des clients (combos) |
| `fkh_presta`, `fkh_agents`, `fkh_sites` | listes prestations / types d'agent / types de site |
| `fkh_site_noms`, `fkh_agent_noms` | noms de sites / d'agents mémorisés |
| `fkh_client_tel` | numéros prise/fin par client |
| `fkh_suivi` | demandes du Suivi (`{id,texte,titre,statut,motif,pris,valide,ville,la,lo,assoc,depCode,depNom}`) |
| `fkh_fa` | fiches agents (`{id,nom,tels[],ville,cp,la,lo,dep,depnom,fiab,voiture,ads}`) |
| `fkh_thiam` | sites Thiam (`{id,site,client,agent,tel,deb,fin,calls[]}` ; call = `{fr,lbl,kind,done,at,com,comtxt}`) |
| `fkh_zones_diff` | départements difficiles (`{code:{nom}}`) |

---

## APIs externes utilisées (publiques, sans clé)

- **`geo.api.gouv.fr/communes`** — autocomplétion ville, code postal, département, coordonnées.
- **`router.project-osrm.org`** — temps de route (voiture).
- **`raw.githubusercontent.com/gregoiredavid/france-geojson`** — contours des départements (carte).

---

## Déploiement

Statique sur **GitHub Pages**, dépôt `harouna92/fkh-securite-apps`.

```bash
# éditer gestion/index.html puis :
git -C fkh-web add -A
git -C fkh-web commit -m "…"
git -C fkh-web push
# build GitHub Pages ~1 min, puis en ligne
```

En-têtes `no-cache` présents dans la page pour limiter les versions périmées sur mobile. En cas de cache tenace : ouvrir avec `?v=2`.

---

## Briques réutilisables (pour d'autres projets)

Fonctions autonomes, facilement transposables :
- **Combo maison mobile-friendly** (`mkCombo`) : menu déroulant + saisie libre + mémorisation.
- **Géocodage ville** (`cityAuto`) + **distance Haversine** (`km`) + **recoupement par rayon**.
- **Moteur d'horaires d'appels** (`thOffsets`/`thAllCalls`) : répartition + décalage anti-collision + dernier appel avant fin.
- **Conversion horaire avec DST** (`thToMali`) — adaptable à n'importe quel fuseau.
- **Carte choroplèthe France** sans librairie (projection SVG + `heatColor`).
- **Tableau de pointage** avec contrôleur de retard temps réel.

---

## Évolution prévue : backend Cloudflare

Pour rendre l'appli **multi-utilisateurs** (données partagées entre appareils/personnes, apparition instantanée, mot de passe), le plan est de remplacer le `localStorage` par :
- **Cloudflare D1** — base de données SQL partagée (une seule source pour tous).
- **Cloudflare Worker** — l'API qui lit/écrit dans la base + vérifie le mot de passe.
- **Rafraîchissement auto** (toutes les 3–5 s) pour l'effet « temps réel ».
- Hébergement sur **Cloudflare Pages** (offre gratuite généreuse, sans le gel de crédits qui a bloqué Netlify).

L'interface reste identique ; seule la « couche de stockage » change (+ un écran de connexion).
