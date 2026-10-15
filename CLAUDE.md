# 49.meme — contexte pour Claude (passation)

Projet multi-personnes : quand un collaborateur atteint sa limite, un autre reprend avec Claude Code dans ce repo.
Lire README.md (setup + archi) avant toute modif. Langue de travail : français.

## Produit
Jeu de mèmes mobile-only (PWA, pas de store) sur la présidentielle 2027. Inspiration : Make It Meme.
Nom : **49.MÈME** — « Adopté sans vote. » DA (V3, inspirée de « 2 Player Games ») : fond bleu très pâle `#e4eef8` + cartes
blanches très arrondies, texte/contours ardoise `#3d4451`, boutons en relief (bleu `#2581cf`, tranche foncée), rouge `#ff3434`,
cyan `#14c2ee`, jaune `#ffc83a`. Typo : Lilita One (titres/boutons) + Baloo 2 (texte) ; légendes des mèmes en Anton (style mème).
Logo : « 49 » ardoise + « .MÈME » rouge, bande cyan/rouge inclinée dessous, étiquette ardoise inclinée. Fond de jeu : rayons blancs.
Chrono de légende : 10 / 20 / 30 / 40 s (40 max, 30 par défaut).
Déroulé (V2, 2026-10-14) : 4 joueurs max (un rond par coin de l'écran) → légende sous chrono géant (5 changements
d'image max, aucune image revue dans la partie) → défilé synchronisé (3 s/mème) → vote pour son mème préféré (bouton VOTER bleu foncé)
→ lauréat « FÉLICITATIONS » + blague parlementaire, +1 manche, boutons de partage Insta/WhatsApp/X (image générée par share.js) → manche suivante auto (12 s) → podium « Fin de la législature ».
Les anciens boutons Macron démission / Valls / 49.3 ont été retirés au profit du vote unique (piste : les remettre en réactions pendant le défilé).
Banque d'images : `images-brutes/` (originaux, hors git) → optimisées dans `public/library/` + `index.json` (utilisé par le mode local).
Profil persistant (table profiles, par compte anonyme) : mème présenté +1 · vote reçu +2 · manche gagnée +5 · partie gagnée +10.
Grades : Militant·e (0) → Attaché·e parlementaire (20) → Député·e (60) → Ministre (150) → Premier·e ministre (300) → Président·e (600).
Option 1 manche pour les tests. Bibliothèque déclarée en base via supabase/seed_library.sql (images servies par le site, pas par le Storage).
Formats : image, GIF, vidéo mp4/webm/mov (lue comme un GIF, muette en boucle).

## Règles techniques
- Pas d'étape de build : HTML + modules ES, supabase-js via CDN version figée. Vercel sert `public/`.
- Toute logique de jeu vit dans `supabase/migrations/*.sql` (RPC security definer). Le client ne lit/écrit jamais les tables directement.
- Changement de schéma = **nouveau fichier** `supabase/migrations/000N_xxx.sql` (ne pas réécrire 0001 une fois déployé).
- `api-mock.js` doit garder la même interface que `api-supabase.js` ; refléter dans le mock tout changement de règle du SQL.
- Pas de Node en local : prévisualiser avec `python3 -m http.server` depuis `public/` (le mode démo marche sans config).

## Statut
- V1 backend — 2026-10-14. V2 game design + UI (accueil polaroïds, coins joueurs, défilé, vote unique, lauréat) — 2026-10-14, testée en mode local.
- Supabase/Vercel pas encore branchés : on itère en local (`?demo`), mise en ligne quand la version plaît.
- À venir : refonte front/design complète ; export top 3 en image partageable (boucle virale) ; modération.

## Backlog priorisé
1. Export du top 3 en image (canvas, watermark « 49.meme » + code room) + bouton partage natif.
2. Transfert d'hôte si l'hôte quitte ; expulsion de joueur.
3. Modération : filtre de mots, file de signalements, CAPTCHA (Turnstile) sur l'auth anonyme.
4. Nettoyage des rooms > 24 h (pg_cron) ; conversion GIF → MP4.
5. Mode streamer (le public vote via lien) ; mode solo « mème du jour ».
