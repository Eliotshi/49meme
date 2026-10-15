// Partage : on « cuit » le mème dans une image JPEG (texte + bandeau 49.MÈME) pour les réseaux.
// GIF et vidéos : on prend la première image (les réseaux n'acceptent pas nos calques de texte).

const W = 1080, FOOTER = 130;

function loadMedia(src, kind) {
  return new Promise((ok, ko) => {
    if (kind === 'video') {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous', src });
      v.onloadeddata = () => { v.currentTime = Math.min(0.1, v.duration || 0); };
      v.onseeked = () => ok({ el: v, w: v.videoWidth, h: v.videoHeight });
      v.onerror = ko;
    } else {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => ok({ el: i, w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = ko;
      i.src = src;
    }
  });
}

function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

export async function memeImage(src, tpl, texts) {
  await Promise.all([document.fonts.load('80px Anton'), document.fonts.load('40px "Lilita One"')]).catch(() => {});
  const m = await loadMedia(src, tpl.kind);
  const H = Math.round(m.h * (W / m.w));
  const c = document.createElement('canvas');
  c.width = W; c.height = H + FOOTER;
  const ctx = c.getContext('2d');
  ctx.drawImage(m.el, 0, 0, W, H);

  // mêmes règles que le rendu HTML : taille = s × largeur, ancrage haut/centre/bas selon y
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (const t of texts) {
    if (!t.t?.trim()) continue;
    const size = t.s * W;
    ctx.font = `${size}px Anton, Impact, sans-serif`;
    const lines = wrap(ctx, t.t.toUpperCase(), W * 0.94);
    const lh = size * 1.05, block = lh * lines.length;
    const top = t.y < 0.25 ? t.y * H : t.y > 0.75 ? t.y * H - block : t.y * H - block / 2;
    ctx.lineWidth = size * 0.14; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
    lines.forEach((l, i) => {
      const y = top + lh * (i + 0.82);
      ctx.strokeText(l, t.x * W, y);
      ctx.fillText(l, t.x * W, y);
    });
  }

  // bandeau de marque
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, H, W, FOOTER);
  ctx.textAlign = 'left'; ctx.font = '72px "Lilita One", Impact, sans-serif';
  ctx.fillStyle = '#3d4451'; ctx.fillText('49', 40, H + 88);
  const w49 = ctx.measureText('49').width;
  ctx.fillStyle = '#ff3434'; ctx.fillText('.MÈME', 40 + w49, H + 88);
  const wLogo = w49 + ctx.measureText('.MÈME').width;
  // bande bleu/rouge sous le logo
  ctx.save(); ctx.transform(1, 0, -0.5, 1, 0, 0);
  ctx.fillStyle = '#14c2ee'; ctx.fillRect(40 + (H + 100) * 0.5, H + 100, wLogo / 2, 10);
  ctx.fillStyle = '#ff3434'; ctx.fillRect(40 + (H + 100) * 0.5 + wLogo / 2, H + 100, wLogo / 2, 10);
  ctx.restore();
  // étiquette inclinée
  ctx.save(); ctx.translate(W - 210, H + 62); ctx.rotate(-0.05);
  ctx.fillStyle = '#3d4451'; ctx.beginPath(); ctx.roundRect(-170, -32, 340, 64, 10); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '36px "Lilita One", Impact, sans-serif';
  ctx.fillText('ADOPTÉ SANS VOTE', 0, 13); ctx.restore();

  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  return new File([blob], '49meme.jpg', { type: 'image/jpeg' });
}

const TEXT = 'Adopté sans vote 🏛️ Viens jouer à 49.meme';

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
}

// Instagram n'a pas de lien de partage web : seule la feuille de partage native (avec l'image) y mène.
// WhatsApp et X : feuille native avec l'image si possible, sinon lien direct (texte + lien, sans image).
export async function shareTo(net, file, toast) {
  const url = location.origin;
  if (file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: `${TEXT} ${url}` }); } catch {}
    return;
  }
  if (net === 'whatsapp') return void open(`https://wa.me/?text=${encodeURIComponent(`${TEXT} ${url}`)}`, '_blank');
  if (net === 'x') return void open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(TEXT)}&url=${encodeURIComponent(url)}`, '_blank');
  if (file) { download(file); toast('Image enregistrée : publie-la en story Insta !'); }
}
