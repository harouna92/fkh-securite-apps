# Déploiement du backend GESTION (Cloudflare Worker + D1)

> But : donner à l'appli une base **partagée** (multi-appareils) protégée par un **mot de passe commun**.
> À faire **une seule fois**. Les commandes tournent depuis ce dossier `backend/`.
> `wrangler login` ouvre le navigateur → **c'est Zeus qui autorise Cloudflare** (Claude ne saisit pas d'identifiants).

## Étapes

```bash
cd "C:/Users/Utilisateur/fkh-web/backend"

# 1. Se connecter à Cloudflare (ouvre le navigateur — Zeus autorise)
npx wrangler login

# 2. Créer la base D1
npx wrangler d1 create fkh-gestion
#    -> copie le "database_id" affiché dans wrangler.toml (remplace A_REMPLIR_APRES_CREATE)

# 3. Créer la table dans la base distante
npx wrangler d1 execute fkh-gestion --remote --file=schema.sql

# 4. Définir le mot de passe commun (secret, jamais dans le code)
npx wrangler secret put APP_PASSWORD
#    -> tape le mot de passe commun choisi, puis Entrée

# 5. Déployer le Worker
npx wrangler deploy
#    -> note l'URL affichée, ex. https://fkh-gestion-api.<sous-domaine>.workers.dev
```

## Après le déploiement

1. Ouvrir `../gestion/index.html`, trouver la ligne `var BACKEND_URL = '';`
   et y coller l'URL du Worker :
   ```js
   var BACKEND_URL = 'https://fkh-gestion-api.<sous-domaine>.workers.dev';
   ```
2. Commit + push (déploie l'appli sur GitHub Pages) :
   ```bash
   git -C "C:/Users/Utilisateur/fkh-web" commit -am "Gestion : branche le backend Cloudflare (BACKEND_URL)"
   git -C "C:/Users/Utilisateur/fkh-web" push
   ```
3. Ouvrir l'appli en ligne → l'écran de connexion apparaît → saisir le mot de passe commun.
4. Sur l'appareil qui a déjà des données : bouton **« Importer mes données locales »** (barre ☁︎) une seule fois.

## Vérifier / dépanner

```bash
# Contenu de la base
npx wrangler d1 execute fkh-gestion --remote --command "SELECT k, length(v) AS taille, updated_at FROM store"

# Logs en direct du Worker
npx wrangler tail
```

- **401 dans l'appli** = mauvais mot de passe (ou secret non défini → refaire l'étape 4).
- **Serveur injoignable** = `BACKEND_URL` mal collée, ou Worker non déployé.
- Tant que `BACKEND_URL` est vide, l'appli fonctionne **100 % en local** (comme avant), sans écran de connexion.
