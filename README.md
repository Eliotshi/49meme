# 49.meme — « Adopté sans vote. »

Jeu de mèmes multijoueur sur mobile, thème présidentielle 2027 (inspiré de Make It Meme).
Chaque joueur légende une image/GIF en 45 s → les mèmes défilent sur tous les écrans → on vote
🔥 **Macron démission** (+2) · 😐 **Valls revient** (0) · 🧨 **49.3** (−1) → top 3.

**Stack :** HTML/JS sans build (`public/`) → GitHub → Vercel · Supabase (Postgres + Realtime + Storage + Auth anonyme).

## Tester tout de suite (sans backend)
Tant que `public/js/config.js` est vide, l'app tourne en **mode démo** (3 bots, images factices).
Forcer le mode démo même configuré : ajouter `?demo` à l'URL. Sur ordinateur : `?desktop` pour passer l'écran « joue sur mobile ».

```bash
cd public && python3 -m http.server 5173
```

## Brancher Supabase (≈10 min)
1. **Créer le projet** sur supabase.com → région **Paris (eu-west-3)**.
2. **SQL Editor** → New query → coller tout `supabase/migrations/0001_init.sql` → **Run**.
3. **Authentication → Sign In / Providers** → activer **Allow anonymous sign-ins**.
4. **Storage → bucket `memes`** (créé par le SQL) → créer le dossier `library` → y glisser vos 40-60 images/GIF.
   Nommage conseillé : `macron-debat-01.gif`, `bardella-tiktok-02.jpg` (les mots deviennent des tags).
5. **SQL Editor** : `select public.sync_library();` → renvoie le nombre d'images importées. À relancer après chaque ajout.
6. **Project Settings → API** : copier *Project URL* et la clé *anon / publishable* dans `public/js/config.js`.

## Mettre en ligne (GitHub → Vercel)
1. Créer un repo **privé** sur github.com (ex. `49meme`), puis dans ce dossier :
   ```bash
   git init && git add . && git commit -m "V1 49.meme" && git branch -M main
   git remote add origin https://github.com/<vous>/49meme.git && git push -u origin main
   ```
2. vercel.com → **Add New Project** → importer le repo → Framework : **Other** → Deploy (le `vercel.json` gère tout).
3. Chaque `git push` sur `main` redéploie ; chaque branche/PR a son URL de preview.

> ⚠️ Le dossier est dans OneDrive : la synchro peut corrompre `.git`. Idéalement, cloner le repo hors OneDrive.

## Architecture
```
public/
  index.html, app.css          UI (refonte design prévue — tout est en variables CSS)
  js/app.js                    écrans + machine à états côté client
  js/meme.js                   rendu mème (image + calques texte) + éditeur (tap, drag, taille)
  js/api-supabase.js           adaptateur Supabase (RPC + realtime + storage)
  js/api-mock.js               même interface, simulée en mémoire avec bots
supabase/migrations/0001_init.sql   tout le backend
```

**Principes backend**
- **Serveur autoritaire** : aucune écriture directe en table. 11 RPC Postgres `security definer` vérifient l'appartenance à la room (`create_room`, `join_room`, `host_next`, `update_settings`, `reroll`, `submit_meme`, `cast_vote`, `tick`, `add_room_template`, `report`, `room_state`).
- **Realtime minimal** : les clients écoutent uniquement la ligne `rooms` ; chaque action fait `version++` → le client recharge `room_state()` (qui ne révèle que ce que le joueur a le droit de voir : pas les légendes des autres avant le vote, pas les auteurs avant les résultats). Polling 4 s en filet de sécurité.
- **Pas de blocage si l'hôte part** : n'importe quel joueur appelle `tick()` quand le chrono expire ; le serveur vérifie l'heure et verrouille la ligne (idempotent).
- **Mèmes = image + JSON de textes** (`[{t,x,y,s}]`, coordonnées relatives). Le texte n'est jamais incrusté → GIF animés conservés, stockage minimal, rendu identique sur tous les écrans.
- **Banque d'images** : table `templates` (bibliothèque globale `room_id NULL` + uploads joueurs liés à la room). Tirage : uploads de la room non joués d'abord, puis bibliothèque jamais jouée dans la room. `plays` / `total_score` mesurent quelles images font rire.
- **Uploads joueurs** : redimensionnés côté client (1280 px JPEG), GIF ≤ 5 Mo, stockés dans `memes/uploads/<room_id>/`, policy Storage = membres de la room uniquement. Un signalement retire l'image immédiatement.

## Points d'attention (scalabilité)
- Supabase Free : **200 connexions realtime simultanées** et **5 Go de bande passante** → passer en Pro (25 $/mois) avant toute campagne de com'.
- Les GIF coûtent cher en bande passante : à terme, convertir en MP4/WebM.
- Vercel Hobby = usage non commercial uniquement.
