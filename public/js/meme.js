// Rendu d'un mème = image/GIF + calques texte en coordonnées relatives (0..1).
// On ne « cuit » jamais le texte dans l'image : les GIF restent animés et le stockage reste léger.

const MAX_VH = 52; // hauteur max de l'image à l'écran

export function renderMeme(src, tpl, texts, { placeholders = false } = {}) {
  const el = document.createElement('div');
  el.className = 'meme';
  const fit = (w, h) => { if (w && h) el.style.width = `min(100%, ${(w / h) * MAX_VH}vh)`; };
  fit(tpl.w, tpl.h);
  let media;
  if (tpl.kind === 'video') {
    // GIF au format vidéo : muet, en boucle, lu automatiquement (playsinline obligatoire sur iPhone)
    media = document.createElement('video');
    Object.assign(media, { src, muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto' });
    media.setAttribute('muted', ''); media.setAttribute('playsinline', '');
    media.onloadedmetadata = () => { if (!tpl.w) fit(media.videoWidth, media.videoHeight); };
  } else {
    media = document.createElement('img');
    media.src = src; media.alt = ''; media.draggable = false; media.decoding = 'async';
    media.onload = () => { if (!tpl.w) fit(media.naturalWidth, media.naturalHeight); };
  }
  el.appendChild(media);
  texts.forEach((t, i) => el.appendChild(caption(t, i, placeholders)));
  return el;
}

// Ancrage auto : zone du haut = collée en haut, du bas = collée en bas (le texte grandit vers l'intérieur).
function place(c, t) {
  c.style.left = t.x * 100 + '%';
  c.style.top = t.y * 100 + '%';
  c.style.setProperty('--ty', t.y < 0.25 ? '0%' : t.y > 0.75 ? '-100%' : '-50%');
}

function caption(t, i, placeholders) {
  const c = document.createElement('div');
  c.className = 'cap';
  c.dataset.i = i;
  place(c, t);
  c.style.fontSize = t.s * 100 + 'cqw';
  c.textContent = t.t || (placeholders ? `TEXTE ${i + 1}` : '');
  if (!t.t) c.classList.add('empty');
  return c;
}

// Éditeur : tap = sélectionner, glisser = déplacer, barre d'outils = ajouter / taille / supprimer.
export function mountEditor(root, src, tpl, initial, onChange, extraTools = '') {
  let texts = initial?.length ? initial.map((t) => ({ ...t }))
    : (tpl.zones || []).map((z) => ({ t: '', x: z.x, y: z.y, s: z.s || 0.09 }));
  let sel = 0;

  root.innerHTML = `
    <div class="ed-stage"></div>
    <div class="ed-tools">
      <button data-a="add">+TEXTE</button>
      <button data-a="smaller" aria-label="Réduire">A−</button>
      <button data-a="bigger" aria-label="Agrandir">A+</button>
      <button data-a="del" aria-label="Supprimer">🗑</button>
      ${extraTools}
    </div>
    <textarea class="ed-input" rows="2" maxlength="140" placeholder="Écris ta punchline…"></textarea>`;
  const stage = root.querySelector('.ed-stage');
  const input = root.querySelector('.ed-input');

  function draw() {
    stage.innerHTML = '';
    const m = renderMeme(src, tpl, texts, { placeholders: true });
    m.querySelectorAll('.cap').forEach((c) => {
      if (+c.dataset.i === sel) c.classList.add('sel');
      bindDrag(c, m);
    });
    stage.appendChild(m);
    input.value = texts[sel]?.t ?? '';
    input.disabled = !texts.length;
    onChange?.(texts);
  }

  function bindDrag(c, m) {
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const i = +c.dataset.i, r = m.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY; let moved = false;
      const ox = texts[i].x - (sx - r.left) / r.width, oy = texts[i].y - (sy - r.top) / r.height;
      c.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        moved = true;
        texts[i].x = Math.min(1, Math.max(0, ox + (ev.clientX - r.left) / r.width));
        texts[i].y = Math.min(1, Math.max(0, oy + (ev.clientY - r.top) / r.height));
        place(c, texts[i]);
      };
      const up = () => {
        c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up);
        sel = i; draw();
        if (!moved) input.focus();
      };
      c.addEventListener('pointermove', move); c.addEventListener('pointerup', up);
    });
  }

  input.addEventListener('input', () => {
    if (!texts[sel]) return;
    texts[sel].t = input.value.toUpperCase();
    const c = stage.querySelector(`.cap[data-i="${sel}"]`);
    c.textContent = texts[sel].t || `TEXTE ${sel + 1}`;
    c.classList.toggle('empty', !texts[sel].t);
    onChange?.(texts);
  });

  root.querySelector('.ed-tools').addEventListener('click', (e) => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'add' && texts.length < 6) { texts.push({ t: '', x: .5, y: .5, s: .08 }); sel = texts.length - 1; }
    if (a === 'del' && texts[sel]) { texts.splice(sel, 1); sel = Math.max(0, sel - 1); }
    if (a === 'bigger' && texts[sel]) texts[sel].s = Math.min(.2, texts[sel].s + .015);
    if (a === 'smaller' && texts[sel]) texts[sel].s = Math.max(.03, texts[sel].s - .015);
    draw();
    if (a === 'add') input.focus();
  });

  draw();
  return { get texts() { return texts; } };
}
