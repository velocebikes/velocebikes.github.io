// ═══════════════════════════════════════════════════════════════════
//  Plantilla A4 del informe de desperfectos (la usan el CRM y la web)
//  Tipografía de la web: Cormorant Garamond + Jost (las carga la página).
//  No lleva matrícula ni bastidor: es para enseñarla a los clientes.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const C = { fondo: '#F3F3F1', tinta: '#0A0908', gris: '#5F646B', linea: '#C6C9CE', oro: '#C8AA6E' };
  const W = 1654, H = 2339, M = 120;

  const miles = n => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  function espaciado(ctx, txt, x, y, esp, align) {
    const w = [...txt].reduce((s, ch) => s + ctx.measureText(ch).width + esp, 0) - esp;
    let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    for (const ch of txt) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + esp; }
    return w;
  }
  function lineas(ctx, txt, maxW, maxL) {
    const out = []; let l = '';
    for (const w of String(txt || '').split(/\s+/).filter(Boolean)) {
      const t = l ? l + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && l) { out.push(l); l = w; } else l = t;
    }
    if (l) out.push(l);
    if (out.length > maxL) {
      out.length = maxL; let u = out[maxL - 1];
      while (u && ctx.measureText(u + '…').width > maxW) u = u.slice(0, -1);
      out[maxL - 1] = u + '…';
    }
    return out;
  }
  // Reparto de fotos: 1 grande; 2 en columna; 1+2; 2×2; 1+2×2; 2×3.
  function celdas(n, x, y, w, h, g) {
    const fila = (cy, ch, cols) => Array.from({ length: cols }, (_, i) => ({ x: x + i * ((w - g * (cols - 1)) / cols + g), y: cy, w: (w - g * (cols - 1)) / cols, h: ch }));
    if (n === 1) return fila(y, h, 1);
    if (n === 2) { const ch = (h - g) / 2; return [...fila(y, ch, 1), ...fila(y + ch + g, ch, 1)]; }
    if (n === 3) { const ch = (h - g) / 2; return [...fila(y, ch, 1), ...fila(y + ch + g, ch, 2)]; }
    if (n === 4) { const ch = (h - g) / 2; return [...fila(y, ch, 2), ...fila(y + ch + g, ch, 2)]; }
    const ch = (h - 2 * g) / 3;
    if (n === 5) return [...fila(y, ch, 1), ...fila(y + ch + g, ch, 2), ...fila(y + 2 * (ch + g), ch, 2)];
    return [...fila(y, ch, 2), ...fila(y + ch + g, ch, 2), ...fila(y + 2 * (ch + g), ch, 2)];
  }
  function cargarImg(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('foto'); return r.blob(); })
      .then(b => createImageBitmap(b, { imageOrientation: 'from-image' }));
  }

  // datos: {marca, modelo, año, km, obs, fotos:[{url, nota}]}
  async function lienzo(datos) {
    const fotos = (datos.fotos || []).slice(0, 6);
    if (!fotos.length) throw new Error('Añade al menos una foto.');
    try {
      await Promise.all(['300 80px "Cormorant Garamond"', '400 80px "Cormorant Garamond"', '300 30px Jost', '400 30px Jost', '500 30px Jost'].map(f => document.fonts.load(f)));
    } catch (e) { }
    const imgs = await Promise.all(fotos.map(f => cargarImg(f.url).catch(() => null)));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = C.fondo; x.fillRect(0, 0, W, H); x.textBaseline = 'alphabetic';
    // Cabecera: logotipo como en la web (mayúsculas espaciadas, punto en oro)
    x.font = '300 46px "Cormorant Garamond"'; x.fillStyle = C.tinta;
    let lx = M; lx += espaciado(x, 'VELOCE', lx, M + 40, 10);
    x.fillStyle = C.oro; x.fillText('.', lx + 4, M + 40); lx += x.measureText('.').width + 14;
    x.fillStyle = C.tinta; espaciado(x, 'BIKES', lx, M + 40, 10);
    x.font = '500 22px Jost'; x.fillStyle = C.gris; espaciado(x, 'INFORME DE DESPERFECTOS', W - M, M + 36, 6, 'right');
    x.fillStyle = C.linea; x.fillRect(M, M + 72, W - 2 * M, 2);
    // Moto (sin matrícula)
    const marca = datos.marca === 'Otra' ? '' : (datos.marca || '');
    x.font = '400 82px "Cormorant Garamond"'; x.fillStyle = C.tinta;
    x.fillText(lineas(x, `${marca} ${datos.modelo || ''}`.trim(), W - 2 * M, 1)[0] || '', M, M + 190);
    const info = [datos.año, datos.km ? miles(datos.km) + ' km' : '', new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })].filter(Boolean).join('   ·   ');
    x.font = '300 30px Jost'; x.fillStyle = C.gris; x.fillText(info, M, M + 250);
    // Observaciones
    let top = M + 300;
    const obs = String(datos.obs || '').trim();
    if (obs) {
      x.font = '300 28px Jost';
      const ls = lineas(x, obs, W - 2 * M - 30, 4);
      x.fillStyle = C.oro; x.fillRect(M, top + 4, 3, ls.length * 40 + 4);
      x.fillStyle = C.tinta; ls.forEach((l, i) => x.fillText(l, M + 30, top + 36 + i * 40));
      top += ls.length * 40 + 50;
    }
    // Fotos
    const pie = H - M - 40, hayNotas = fotos.some(f => String(f.nota || '').trim()), cap = hayNotas ? 92 : 52;
    celdas(fotos.length, M, top, W - 2 * M, pie - top - 30, 36).forEach((cel, i) => {
      const ih = cel.h - cap, img = imgs[i];
      x.fillStyle = '#E4E4E1'; x.fillRect(cel.x, cel.y, cel.w, ih);
      if (img) {
        const k = Math.max(cel.w / img.width, ih / img.height), sw = cel.w / k, sh = ih / k;
        x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, cel.x, cel.y, cel.w, ih);
      }
      x.font = '400 34px "Cormorant Garamond"'; x.fillStyle = C.oro; x.fillText(String(i + 1).padStart(2, '0'), cel.x, cel.y + ih + 40);
      const nota = String(fotos[i].nota || '').trim();
      if (nota) { x.font = '300 25px Jost'; x.fillStyle = C.tinta; lineas(x, nota, cel.w - 70, 2).forEach((l, j) => x.fillText(l, cel.x + 60, cel.y + ih + 38 + j * 32)); }
    });
    // Pie
    x.fillStyle = C.linea; x.fillRect(M, pie, W - 2 * M, 2);
    x.font = '400 21px Jost'; x.fillStyle = C.gris;
    espaciado(x, 'VELOCE BIKES  ·  LA FINCA, POZUELO DE ALARCÓN', M, pie + 44, 3);
    espaciado(x, '+34 684 71 47 92  ·  VELOCEBIKES.ES', W - M, pie + 44, 3, 'right');
    return c;
  }

  let jspdfP = null;
  function cargarJsPDF() {
    if (window.jspdf) return Promise.resolve();
    if (!jspdfP) jspdfP = new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s.onload = ok; s.onerror = () => { jspdfP = null; ko(new Error('No se pudo cargar el generador de PDF. Revisa la conexión.')); };
      document.head.appendChild(s);
    });
    return jspdfP;
  }
  // Necesita cargarJsPDF() antes; es síncrono para no perder el "toque" del usuario en el móvil.
  function pdfBlob(canvas) {
    const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297);
    return pdf.output('blob');
  }
  function jpgBlob(canvas) { return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9)); }

  function nombreArchivo(d) {
    return ('desperfectos-' + [d.marca === 'Otra' ? '' : d.marca, d.modelo].filter(Boolean).join('-'))
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  }

  // Guarda o comparte un archivo ya generado. En el móvil abre "Compartir"
  // (Guardar imagen, WhatsApp…); si no se puede, lo descarga.
  async function entregar(blob, nombre) {
    const file = new File([blob], nombre, { type: blob.type });
    const movil = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (movil && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: nombre }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  window.VBPlantilla = { lienzo, cargarJsPDF, pdfBlob, jpgBlob, nombreArchivo, entregar };
})();
