/* SVG diagram generator for the machine-tending cell.
   Works in Node (report figures) and in the browser (live simulation). */
(function (root) {
  const M = root.CellModel || (typeof require !== 'undefined' ? require('./cell-model.js') : null);

  const FONT = "'Barlow', 'Segoe UI', Arial, sans-serif";

  // One stylesheet for every diagram. Page themes override the --dg-* variables.
  const CSS = `
.dg-root{font-family:'Barlow','Segoe UI',Arial,sans-serif}
.dg-bg{fill:var(--dg-bg,#ffffff)}
.dg-title{font-family:'Barlow Semi Condensed','Barlow','Segoe UI',sans-serif;font-weight:700;font-size:20px;fill:var(--dg-ink,#14202b)}
.dg-sub{font-size:13px;fill:var(--dg-muted,#56636f)}
.dg-st-rect{fill:var(--dg-st,#f2f5f8);stroke:var(--dg-line,#2f3e4d);stroke-width:1.5}
.dg-st-title{font-family:'Barlow Semi Condensed','Barlow','Segoe UI',sans-serif;font-weight:700;font-size:14.5px;fill:var(--dg-ink,#14202b);letter-spacing:.04em}
.dg-st-do{font-size:12.5px;fill:var(--dg-soft,#3a4754)}
.dg-st-chip{fill:var(--dg-line,#2f3e4d)}
.dg-st-chiptext{font-family:'IBM Plex Mono',Consolas,monospace;font-weight:600;font-size:11px;fill:var(--dg-chipink,#ffffff)}
.dg-tr{fill:none;stroke:var(--dg-arrow,#56636f);stroke-width:1.5}
.dg-head{fill:var(--dg-arrow,#56636f)}
.dg-dash{stroke-dasharray:5 4}
.dg-trk-fault .dg-tr{stroke:var(--dg-red,#c62828)} .dg-trk-fault .dg-head{fill:var(--dg-red,#c62828)}
.dg-trk-hold .dg-tr{stroke:var(--dg-amber,#b7791f)} .dg-trk-hold .dg-head{fill:var(--dg-amber,#b7791f)}
.dg-trk-ok .dg-tr{stroke:var(--dg-green,#1e7d45)} .dg-trk-ok .dg-head{fill:var(--dg-green,#1e7d45)}
.dg-guard{font-size:12.5px;fill:var(--dg-ink2,#1f2a35)}
.dg-halo{paint-order:stroke;stroke:var(--dg-bg,#ffffff);stroke-width:5px;stroke-linejoin:round}
.dg-tag{font-family:'IBM Plex Mono',Consolas,monospace;font-size:11.5px;font-weight:500;fill:var(--dg-blue,#0b5aa6)}
.dg-cp{font-weight:700;fill:var(--dg-cp,#7b3fb5)}
.dg-b{font-weight:700}
.dg-small{font-size:11.5px}
.dg-init{fill:var(--dg-line,#2f3e4d)}
.dg-k-wait .dg-st-rect{stroke-dasharray:5 3}
.dg-k-fault .dg-st-rect{fill:var(--dg-red-t,#fdeceb);stroke:var(--dg-red,#c62828)} .dg-k-fault .dg-st-chip{fill:var(--dg-red,#c62828)}
.dg-k-hold .dg-st-rect{fill:var(--dg-amber-t,#fff4de);stroke:var(--dg-amber,#b7791f)} .dg-k-hold .dg-st-chip{fill:var(--dg-amber,#b7791f)}
.dg-k-ok .dg-st-rect{fill:var(--dg-green-t,#e7f5ec);stroke:var(--dg-green,#1e7d45)} .dg-k-ok .dg-st-chip{fill:var(--dg-green,#1e7d45)}
.dg-k-warn .dg-st-rect{fill:var(--dg-amber-t,#fff4de);stroke:var(--dg-amber,#b7791f)} .dg-k-warn .dg-st-chip{fill:var(--dg-amber,#b7791f)}
.dg-k-stop .dg-st-rect{fill:var(--dg-red-t,#fdeceb);stroke:var(--dg-red,#c62828)} .dg-k-stop .dg-st-chip{fill:var(--dg-red,#c62828)}
.dg-k-op .dg-st-rect{fill:var(--dg-blue-t,#e6effa);stroke:var(--dg-blue,#0b5aa6)} .dg-k-op .dg-st-chip{fill:var(--dg-blue,#0b5aa6)}
.dg-k-check .dg-st-rect{fill:var(--dg-cp-t,#f3ecfa);stroke:var(--dg-cp,#7b3fb5)} .dg-k-check .dg-st-chip{fill:var(--dg-cp,#7b3fb5)}
.dg-band{stroke:none}
.dg-band-idle{fill:var(--dg-amber-b,#fff5e0)} .dg-band-run{fill:var(--dg-blue-b,#e9f1fb)}
.dg-band-stop{fill:var(--dg-green-b,#eaf6ee)} .dg-band-move{fill:var(--dg-gray-b,#eef1f4)}
.dg-band-label{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:11.5px;letter-spacing:.08em;fill:var(--dg-muted,#56636f)}
.dg-band-label.idle{fill:var(--dg-amber-d,#9a6212)} .dg-band-label.run{fill:var(--dg-blue,#0b5aa6)} .dg-band-label.stop{fill:var(--dg-green,#1e7d45)}
.dg-note-rect{fill:var(--dg-note,#f6f7f9);stroke:var(--dg-rule,#c4ccd4);stroke-width:1}
.dg-note{font-size:12.5px;fill:var(--dg-soft,#3a4754)}
.dg-choice{fill:var(--dg-st,#f2f5f8);stroke:var(--dg-line,#2f3e4d);stroke-width:1.5}
.dg-choice-t{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:13.5px;fill:var(--dg-ink,#14202b)}
.dg-node{fill:var(--dg-st,#f2f5f8);stroke:var(--dg-line,#2f3e4d);stroke-width:1.4}
.dg-node.ok{fill:var(--dg-green-t,#e7f5ec);stroke:var(--dg-green,#1e7d45)}
.dg-node.warn{fill:var(--dg-amber-t,#fff4de);stroke:var(--dg-amber,#b7791f)}
.dg-node.stop{fill:var(--dg-red-t,#fdeceb);stroke:var(--dg-red,#c62828)}
.dg-node.check{fill:var(--dg-cp-t,#f3ecfa);stroke:var(--dg-cp,#7b3fb5)}
.dg-node.op{fill:var(--dg-blue-t,#e6effa);stroke:var(--dg-blue,#0b5aa6)}
.dg-node-t{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:14px;fill:var(--dg-ink,#14202b)}
.dg-node-s{font-size:12.5px;fill:var(--dg-soft,#3a4754)}
.dg-owner{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:10.5px;letter-spacing:.08em;fill:#ffffff}
.dg-owner-r{fill:#2f3e4d}
.dg-owner-r.op,.dg-owner-r.light{fill:#0b5aa6} .dg-owner-r.cnc{fill:#a0521d} .dg-owner-r.conv{fill:#2f6f5e} .dg-owner-r.r2{fill:#806000}
.dg-owner-r.cam{fill:#7b3fb5} .dg-owner-r.gauge{fill:#a33a3a} .dg-owner-r.ok{fill:#1e7d45} .dg-owner-r.nok{fill:#c62828}
.dg-conn{fill:var(--dg-bg,#ffffff);stroke:var(--dg-line,#2f3e4d);stroke-width:1.5}
.dg-conn-t{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:13px;fill:var(--dg-ink,#14202b)}
.dg-num{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:14px;fill:var(--dg-muted,#56636f)}
.dg-active .dg-st-rect,.dg-active .dg-node,.dg-active .dg-choice{stroke:var(--dg-active,#0a66e8);stroke-width:3.2;fill:var(--dg-active-t,#dde9fc)}
.dg-active .dg-st-chip{fill:var(--dg-active,#0a66e8)}
.dg-flash .dg-tr{stroke:var(--dg-active,#0a66e8);stroke-width:3} .dg-flash .dg-head{fill:var(--dg-active,#0a66e8)}
/* layout drawing */
.ly-fence{fill:none;stroke:var(--dg-rule,#aab4be);stroke-width:1.3;stroke-dasharray:2 5}
.ly-aisle{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:11px;letter-spacing:.14em;fill:var(--dg-muted,#56636f)}
.ly-mach{fill:var(--ly-mach,#dfe5ea);stroke:var(--dg-line,#2f3e4d);stroke-width:1.6}
.ly-mach-in{fill:var(--ly-mach-in,#eef2f5);stroke:var(--ly-rule2,#9aa6b1);stroke-width:1}
.ly-pallet{fill:var(--ly-pallet,#e9dcc6);stroke:var(--ly-pallet-s,#8a6d3b);stroke-width:1.5}
.ly-slot{fill:none;stroke:var(--ly-slot,#b39a6e);stroke-width:.9;stroke-dasharray:2 2}
.ly-part{fill:var(--ly-raw,#a9b2ba);stroke:var(--ly-raw-s,#56626c);stroke-width:1.1}
.ly-part.fin{fill:var(--ly-fin,#dfe8f0);stroke:var(--ly-fin-s,#43698c)}
.ly-part.nok{stroke:var(--dg-red,#c62828);stroke-width:2.2}
.ly-pocket{fill:none;stroke:var(--ly-fin-s,#43698c);stroke-width:.9}
.ly-belt{fill:var(--ly-belt,#39414a)}
.ly-frame{fill:var(--ly-frame,#8d98a3)}
.ly-roller{stroke:var(--ly-roller,#5b646d);stroke-width:1.1}
.ly-stop{fill:var(--dg-red,#c62828)}
.ly-robot{fill:var(--ly-robot,#2c4a66);stroke:var(--ly-robot-s,#15283a);stroke-width:1.5}
.ly-robot-t{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:11.5px;fill:#ffffff;letter-spacing:.04em}
.ly-link{stroke:var(--ly-link,#5f7d99);stroke-width:13;stroke-linecap:round;fill:none}
.ly-link2{stroke:var(--ly-link2,#7f9ab3);stroke-width:10;stroke-linecap:round;fill:none}
.ly-joint{fill:var(--ly-joint,#243a52)}
.ly-finger{stroke:var(--ly-joint,#243a52);stroke-width:3.2;stroke-linecap:round}
.ly-door{fill:var(--ly-door,#6f8193);stroke:var(--dg-line,#2f3e4d);stroke-width:1}
.ly-track{stroke:var(--ly-rule2,#9aa6b1);stroke-width:1.1;stroke-dasharray:3 3}
.ly-handle{fill:var(--dg-line,#2f3e4d)}
.ly-label{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:14px;fill:var(--dg-ink,#14202b);letter-spacing:.05em}
.ly-sub{font-size:11.5px;fill:var(--dg-soft,#3a4754)}
.ly-tag{font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;font-weight:600;fill:var(--dg-blue,#0b5aa6)}
.ly-tag.cam{fill:var(--dg-cp,#7b3fb5)} .ly-tag.saf{fill:var(--ly-safety,#946c00)}
.ly-sens{fill:var(--dg-bg,#ffffff);stroke:var(--dg-blue,#0b5aa6);stroke-width:1.6}
.ly-sens.safety{stroke:var(--ly-safety,#c79400)}
.ly-led{fill:var(--ly-led-off,#c3cad1)}
.ly-led.on{fill:var(--ly-led-on,#1ea453)}
.ly-led.bad{fill:var(--dg-red,#d32f2f)}
.ly-beam{stroke:var(--ly-beam,#d33b3b);stroke-width:1.1;stroke-dasharray:2 3;opacity:.8}
.ly-fov{fill:var(--ly-fov,rgba(123,63,181,.045));stroke:var(--dg-cp,#7b3fb5);stroke-width:1.3;stroke-dasharray:7 4}
.ly-roi{fill:none;stroke:var(--dg-cp,#7b3fb5);stroke-width:1.1;stroke-dasharray:2 2}
.ly-roi-t{font-family:'IBM Plex Mono',Consolas,monospace;font-size:10px;font-weight:600;fill:var(--dg-cp,#7b3fb5)}
.ly-roi-t.on-belt{fill:#d9c5f5}
.ly-cam{fill:var(--dg-cp,#7b3fb5)}
.ly-nok{fill:var(--ly-nok,#fbe3e1);stroke:var(--dg-red,#c62828);stroke-width:1.6}
.ly-nok-h{stroke:var(--dg-red,#c62828);stroke-width:.9;opacity:.35}
.ly-gauge{fill:var(--ly-gauge,#e9eef3);stroke:var(--dg-line,#2f3e4d);stroke-width:1.5}
.ly-datum{fill:var(--dg-line,#2f3e4d)}
.ly-laser{fill:var(--dg-red,#c62828)}
.ly-cab{fill:var(--ly-mach,#dfe5ea);stroke:var(--dg-line,#2f3e4d);stroke-width:1.3}
.ly-lamp-r{fill:#d32f2f} .ly-lamp-a{fill:#f2a900} .ly-lamp-g{fill:#1e9e52} .ly-lamp-b{fill:#1565c0}
.ly-lamp-off{opacity:.2}
.ly-scan{fill:var(--ly-scan,rgba(199,148,0,.09));stroke:var(--ly-safety,#c79400);stroke-width:1.1;stroke-dasharray:3 3}
.ly-flow{fill:none;stroke:#ffffff;stroke-width:1.8;opacity:.75}
.ly-note{font-size:11.5px;font-style:italic;fill:var(--dg-muted,#56636f)}
.ly-legend{font-size:12px;fill:var(--dg-soft,#3a4754)}
/* timing chart */
.gt-grid{stroke:var(--dg-rule,#d5dbe1);stroke-width:1}
.gt-axis{font-size:11.5px;fill:var(--dg-muted,#56636f)}
.gt-row{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:13.5px;fill:var(--dg-ink,#14202b)}
.gt-bar-t{font-size:11.5px;fill:#ffffff;font-weight:600}
.gt-bar-t.dark{fill:var(--dg-ink,#14202b)}
.gt-mach{fill:#3f73b5} .gt-idle{fill:#e3a21a} .gt-door{fill:#2f3e4d} .gt-move{fill:#7d8b98} .gt-wait{fill:var(--dg-gray-b,#eef1f4);stroke:var(--dg-rule,#c4ccd4)} .gt-belt{fill:#2f6f5e} .gt-gauge{fill:#a33a3a}
.gt-kpi{font-family:'Barlow Semi Condensed','Barlow',sans-serif;font-weight:700;font-size:15px;fill:var(--dg-ink,#14202b)}
.gt-break{fill:var(--dg-bg,#ffffff);stroke:var(--dg-muted,#56636f);stroke-width:1.2}
`;

  // ------------------------------------------------------------------ helpers
  const fmt = (n) => Math.round(n * 10) / 10;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // Mini markup: {TAG} sensor tag, [CP-n] cross-check reference, *bold*
  function rich(s) {
    let out = '', i = 0, m;
    const re = /\{([^}]+)\}|\[([^\]]+)\]|\*([^*]+)\*/g;
    while ((m = re.exec(s))) {
      out += esc(s.slice(i, m.index));
      if (m[1]) out += `<tspan class="dg-tag">${esc(m[1])}</tspan>`;
      else if (m[2]) out += `<tspan class="dg-cp">${esc(m[2])}</tspan>`;
      else out += `<tspan class="dg-b">${esc(m[3])}</tspan>`;
      i = re.lastIndex;
    }
    return out + esc(s.slice(i));
  }
  function roundPath(pts, r) {
    const P = (p) => `${fmt(p[0])} ${fmt(p[1])}`;
    if (pts.length < 3 || !r) return 'M' + pts.map(P).join(' L');
    let d = 'M' + P(pts[0]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0) || 1, l2 = Math.hypot(x2 - x1, y2 - y1) || 1;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      d += ` L${P([x1 - (x1 - x0) / l1 * rr, y1 - (y1 - y0) / l1 * rr])} Q${P([x1, y1])} ${P([x1 + (x2 - x1) / l2 * rr, y1 + (y2 - y1) / l2 * rr])}`;
    }
    return d + ' L' + P(pts[pts.length - 1]);
  }
  function arrowHead(p1, p2) {
    const a = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), L = 9.5, W = 4.5;
    const bx = p2[0] - L * Math.cos(a), by = p2[1] - L * Math.sin(a);
    const q = [[p2[0], p2[1]], [bx + W * Math.sin(a), by - W * Math.cos(a)], [bx - W * Math.sin(a), by + W * Math.cos(a)]];
    return `<polygon class="dg-head" points="${q.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}"/>`;
  }
  function trimEnd(pts, d) {
    const n = pts.length, a = pts[n - 2], b = pts[n - 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const out = pts.slice(0, -1);
    out.push([b[0] - (b[0] - a[0]) / l * d, b[1] - (b[1] - a[1]) / l * d]);
    return out;
  }

  class Diagram {
    constructor(w, h, title, sub, opts) {
      this.w = w; this.h = h; this.title = title; this.sub = sub; this.opts = opts || {};
      this.top = this.opts.noTitle ? 14 : 78;
      this.bg = []; this.tr = []; this.fg = []; this.lb = []; this.st = {};
    }
    band(x, y, w, h, kind) {
      this.bg.push(`<rect class="dg-band dg-band-${kind}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="7"/>`);
    }
    bandLabel(text, x, y, kind) {
      this.bg.push(`<text class="dg-band-label ${kind}" x="${fmt(x)}" y="${fmt(y)}" text-anchor="middle" transform="rotate(-90 ${fmt(x)} ${fmt(y)})" dy="4">${esc(text)}</text>`);
    }
    init(cx, cy) { this.fg.push(`<circle class="dg-init" cx="${fmt(cx)}" cy="${fmt(cy)}" r="7.5"/>`); return { cx, cy, top: cy - 7, bottom: cy + 7, left: cx - 7, right: cx + 7 }; }
    state(id, x, y, w, name, lines, kind) {
      lines = lines || [];
      const h = lines.length ? 40 + 15 * lines.length : 36;
      const cw = 12 + 7.6 * id.length;
      let s = `<g class="dg-state${kind ? ' dg-k-' + kind : ''}" data-state="${esc(id)}">`;
      s += `<rect class="dg-st-rect" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="9"/>`;
      s += `<rect class="dg-st-chip" x="${fmt(x + 10)}" y="${fmt(y + 9)}" width="${fmt(cw)}" height="19" rx="4"/>`;
      s += `<text class="dg-st-chiptext" x="${fmt(x + 10 + cw / 2)}" y="${fmt(y + 22.5)}" text-anchor="middle">${esc(id)}</text>`;
      s += `<text class="dg-st-title" x="${fmt(x + 18 + cw)}" y="${fmt(y + 23.5)}">${esc(name)}</text>`;
      lines.forEach((l, i) => { s += `<text class="dg-st-do" x="${fmt(x + 12)}" y="${fmt(y + 45 + 15 * i)}">${rich(l)}</text>`; });
      this.fg.push(s + '</g>');
      const g = { x, y, w, h, cx: x + w / 2, cy: y + h / 2, top: y, bottom: y + h, left: x, right: x + w };
      this.st[id] = g;
      return g;
    }
    choice(id, cx, cy, w, h, lines) {
      const pts = [[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]];
      let s = `<g class="dg-choiceg" data-state="${esc(id)}"><polygon class="dg-choice" points="${pts.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}"/>`;
      const y0 = cy - ((lines.length - 1) * 15) / 2 + 5;
      lines.forEach((l, i) => { s += `<text class="dg-choice-t" x="${fmt(cx)}" y="${fmt(y0 + 15 * i)}" text-anchor="middle">${rich(l)}</text>`; });
      this.fg.push(s + '</g>');
      const g = { cx, cy, w, h, top: cy - h / 2, bottom: cy + h / 2, left: cx - w / 2, right: cx + w / 2 };
      this.st[id] = g;
      return g;
    }
    // Flowchart node. o.kind: '' | ok | warn | stop | check | op ; o.shape: rect | term ; o.owner chip
    node(id, x, y, w, h, lines, o) {
      o = o || {};
      const rx = o.shape === 'term' ? Math.min(h / 2, 24) : 6;
      let s = `<g class="dg-nodeg" data-state="${esc(id)}"><rect class="dg-node ${o.kind || ''}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(rx)}"/>`;
      if (o.owner) {
        const ow = 12 + o.owner.length * 6.9;
        s += `<rect class="dg-owner-r ${o.ownerCls || ''}" x="${fmt(x + 10)}" y="${fmt(y + 9)}" width="${fmt(ow)}" height="17" rx="3"/>`;
        s += `<text class="dg-owner" x="${fmt(x + 10 + ow / 2)}" y="${fmt(y + 21.2)}" text-anchor="middle">${esc(o.owner)}</text>`;
        if (o.num) s += `<text class="dg-num" x="${fmt(x + w - 12)}" y="${fmt(y + 22)}" text-anchor="end">${esc(o.num)}</text>`;
        lines.forEach((l, i) => {
          s += `<text class="${i === 0 ? 'dg-node-t' : 'dg-node-s'}" x="${fmt(x + 12)}" y="${fmt(y + 44 + (i ? 3 : 0) + 15 * i)}">${rich(l)}</text>`;
        });
      } else {
        const n = lines.length, lh = 15.5;
        const y0 = y + h / 2 - ((n - 1) * lh) / 2 + 5;
        const tx = x + (o.align === 'left' ? 12 : w / 2), anchor = o.align === 'left' ? 'start' : 'middle';
        lines.forEach((l, i) => {
          s += `<text class="${i < (o.titleLines || 1) ? 'dg-node-t' : 'dg-node-s'}" x="${fmt(tx)}" y="${fmt(y0 + lh * i)}" text-anchor="${anchor}">${rich(l)}</text>`;
        });
      }
      this.fg.push(s + '</g>');
      const g = { x, y, w, h, cx: x + w / 2, cy: y + h / 2, top: y, bottom: y + h, left: x, right: x + w };
      this.st[id] = g;
      return g;
    }
    conn(cx, cy, t) {
      this.fg.push(`<circle class="dg-conn" cx="${fmt(cx)}" cy="${fmt(cy)}" r="12"/><text class="dg-conn-t" x="${fmt(cx)}" y="${fmt(cy + 4.6)}" text-anchor="middle">${esc(t)}</text>`);
    }
    arrow(pts, label, o) {
      o = o || {};
      const p2 = o.head === false ? pts : trimEnd(pts, 5);
      let s = `<g class="dg-trg${o.kind ? ' dg-trk-' + o.kind : ''}"${o.id ? ` data-tr="${esc(o.id)}"` : ''}>`;
      s += `<path class="dg-tr${o.dash ? ' dg-dash' : ''}" d="${roundPath(p2, o.r === undefined ? 9 : o.r)}"/>`;
      if (o.head !== false) s += arrowHead(pts[pts.length - 2], pts[pts.length - 1]);
      this.tr.push(s + '</g>');
      if (label && label.length) {
        let at = o.at;
        if (!at) { const a = pts[0], b = pts[pts.length - 1]; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        this.text(label, at, o);
      }
    }
    text(lines, at, o) {
      o = o || {};
      const lh = o.lh || 15, [x, y] = at, anchor = o.anchor || 'middle';
      const y0 = y - ((lines.length - 1) * lh) / 2 + 4.5;
      const rot = o.rotate ? ` transform="rotate(${o.rotate} ${fmt(x)} ${fmt(y)})"` : '';
      let s = `<text class="dg-guard${o.halo === false ? '' : ' dg-halo'}${o.tcls ? ' ' + o.tcls : ''}" x="${fmt(x)}" y="${fmt(y0)}" text-anchor="${anchor}"${rot}>`;
      lines.forEach((l, i) => { s += `<tspan x="${fmt(x)}"${i ? ` dy="${lh}"` : ''}>${rich(l)}</tspan>`; });
      this.lb.push(s + '</text>');
    }
    note(x, y, w, lines) {
      const h = 18 + lines.length * 16;
      this.fg.push(`<rect class="dg-note-rect" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="6"/>` +
        lines.map((l, i) => `<text class="dg-note" x="${fmt(x + 12)}" y="${fmt(y + 23 + i * 16)}">${rich(l)}</text>`).join(''));
      return y + h;
    }
    raw(s, layer) { (layer === 'bg' ? this.bg : layer === 'lb' ? this.lb : this.fg).push(s); }
    svg() {
      const sa = this.opts.standalone !== false;
      const size = sa ? ` width="${fmt(this.w)}" height="${fmt(this.h)}"` : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" class="dg-root" viewBox="0 0 ${fmt(this.w)} ${fmt(this.h)}"${size} font-family="${FONT}" role="img" aria-label="${esc(this.title || 'diagram')}">` +
        (sa ? `<style>${CSS}</style>` : '') +
        `<rect class="dg-bg" x="0" y="0" width="${fmt(this.w)}" height="${fmt(this.h)}"/>` +
        (this.title && !this.opts.noTitle ? `<text class="dg-title" x="20" y="36">${esc(this.title)}</text>` : '') +
        (this.sub && !this.opts.noTitle ? `<text class="dg-sub" x="20" y="58">${rich(this.sub)}</text>` : '') +
        this.bg.join('') + this.tr.join('') + this.fg.join('') + this.lb.join('') + '</svg>';
    }
  }

  // Geometry shared by the vertical state diagrams
  const G = { X: 110, W: 360, SX: 574, SW: 250, LOOP: 38, SKIP: 70, BR: 38 };
  G.CX = G.X + G.W / 2;              // 290
  G.BL = G.X + G.W + G.BR / 2 + 1;   // band label x (inside the right strip of the band)

  // Stack a vertical chain of states joined by straight arrows with centered guard labels.
  function chain(d, X, W, y, seq) {
    const CX = X + W / 2;
    let prev = null, label = null;
    for (const it of seq) {
      if (it.init) { prev = d.init(CX, y + 8); y += 16; continue; }
      if (it.label) { label = it; y += 26 + 15 * it.label.length; continue; }
      const g = d.state(it.id, X, y, W, it.name, it.lines, it.kind);
      if (prev) d.arrow([[CX, prev.bottom], [CX, g.top]], label && label.label, { at: [CX, (prev.bottom + g.top) / 2] });
      prev = g; label = null; y = g.bottom;
    }
    return y;
  }
  function band(d, a, b, kind, label, labelFrom, labelTo) {
    d.band(G.X - 10, a.top - 8, G.W + 10 + G.BR, b.bottom - a.top + 16, kind);
    if (label) d.bandLabel(label, G.BL, ((labelFrom || a).top + (labelTo || b).bottom) / 2, kind);
  }
  function faultHold(d, y, withHold, faultLines, holdLines) {
    const f = d.state('F', G.SX, y, G.SW, 'FAULT', faultLines || ['From any state: timeout or a', 'missing confirmation · red light'], 'fault');
    d.arrow([[G.SX - 34, f.cy], [G.SX, f.cy]], null, { kind: 'fault', dash: true });
    if (!withHold) return f;
    const h = d.state('H', G.SX, f.bottom + 16, G.SW, 'HOLD (LINE STOP)', holdLines || ['LINE STOP: finish the step,', 'park, wait for the reset'], 'hold');
    d.arrow([[G.SX - 34, h.cy], [G.SX, h.cy]], null, { kind: 'hold', dash: true });
    return h;
  }
  const HOLD_FAULT_NOTE = [
    '*F FAULT* and *H HOLD* can be entered from any state. FAULT = a confirmation is missing or a timeout',
    'expired (the alarm names the sensor, no automatic robot retries). HOLD = LINE STOP from the cross-check',
    'supervisor: the current step is finished, the robot parks, and it resumes at the same step after the reset.',
  ];
  function finish(d, y, noteLines) {
    if (noteLines && !d.opts.noNote) y = d.note(20, y + 26, d.w - 40, noteLines);
    d.h = y + 18;
    return d.svg();
  }

  // ------------------------------------------------------------------ SD: Robot 1, Setup 1
  function smRobot1S1(o) {
    const S = M.STATES.R1S1;
    const d = new Diagram(844, 0, 'State diagram: Robot 1 + CNC (Setup 1, single gripper)',
      'Arrow label = the confirmation that allows the transition · {TAG} sensor · [CP-n] camera + proximity cross-check', o);
    const { X, W, CX } = G;
    chain(d, X, W, d.top, [
      { init: true },
      { label: ['Auto mode ON'] },
      { id: 'A0', name: S.A0, lines: ['Home robot · check CNC ready, door closed', '({ZS-32}) and fixture state ({PS-36})'] },
      { label: ['Robot home · CNC ready · {ZS-32} door closed'] },
      { id: 'A1', name: S.A1, lines: ['Robot parked at home, clear of CNC and', 'conveyor · CNC machining the part (120 s)'] },
      { label: ['CNC cycle complete (M30) · spindle stopped', '{ZS-33} guard lock released'] },
      { id: 'A2', name: S.A2, lines: ['Empty gripper grips the door handle, slides', 'the door open, releases it, retracts'] },
      { label: ['{ZS-31} door open = ON · {ZS-32} = OFF'] },
      { id: 'A3', name: S.A3, lines: ['Enter · grip finished part · open vise ·', 'lift the part out · exit the machine'] },
      { label: ['{GR-21} grip OK · {ZS-34} vise open', '{PS-36} = OFF (fixture empty) · R1 clear of CNC'] },
      { id: 'A4', name: S.A4, lines: ['Wait for belt stopped ({ENC-43} = 0) and', 'entry clear ([CP-2]) · place · release'] },
      { label: ['[CP-2] part present ({PE-41} + {CAM-1})', 'R1 clear of conveyor'] },
      { id: 'A5', name: S.A5, lines: ['[CP-1] pallet present ({PX-11} + {CAM-1}) ·', '{CAM-1} gives the pick pose · pick'] },
      { label: ['{GR-21} grip OK · {CAM-1} slot now empty'] },
      { id: 'A6', name: S.A6, lines: ['Enter · place part in the vise · clamp ·', 'open gripper · exit the machine'] },
      { label: ['{ZS-35} clamped · {PS-36} part seated', 'gripper open · R1 clear of CNC'] },
      { id: 'A7', name: S.A7, lines: ['Empty gripper slides the door closed,', 'releases the handle, moves home'] },
      { label: ['{ZS-32} door closed = ON · {ZS-33} locked'] },
      { id: 'A8', name: S.A8, lines: ['Send CYCLE START through the CNC', 'robot interface'] },
    ]);
    const s = d.st;
    band(d, s.A1, s.A1, 'run', 'MACHINING');
    band(d, s.A2, s.A8, 'idle', `CNC IDLE ≈ ${M.KPI.idle1} s`, s.A6, s.A8);
    const yl = s.A8.bottom + 30;
    d.arrow([[CX, s.A8.bottom], [CX, yl], [G.LOOP, yl], [G.LOOP, s.A1.cy + 10], [X, s.A1.cy + 10]], ['CNC in cycle'], { at: [(CX + G.LOOP) / 2 + 24, yl] });
    d.arrow([[X, s.A2.cy], [G.SKIP, s.A2.cy], [G.SKIP, s.A5.cy - 10], [X, s.A5.cy - 10]], ['CNC empty (first cycle)'], { at: [G.SKIP, (s.A2.cy + s.A5.cy) / 2], rotate: -90 });
    const w1 = d.state('W1', G.SX, s.A5.cy - 35, G.SW, S.W1, ['HMI: "Load input pallet"', 'amber light · robot waits'], 'op');
    const mx = (X + W + G.BR + G.SX) / 2;
    d.arrow([[X + W, s.A5.cy - 12], [G.SX, s.A5.cy - 12]], ['no parts left', '({CAM-1})'], { at: [mx, s.A5.cy - 40] });
    d.arrow([[G.SX, s.A5.cy + 14], [X + W, s.A5.cy + 14]], ['pallet loaded', '[CP-1] OK'], { at: [mx, s.A5.cy + 42] });
    faultHold(d, s.A0.top, true);
    return finish(d, yl, HOLD_FAULT_NOTE);
  }

  // ------------------------------------------------------------------ SD: Conveyor
  function smConveyor(o) {
    const S = M.STATES.CONV;
    const d = new Diagram(844, 0, 'State diagram: Conveyor',
      'Robots pick or place at the belt only when it is stopped ({ENC-43} = 0); the belt starts only when both robots are clear.', o);
    const { X, W, CX } = G;
    chain(d, X, W, d.top, [
      { init: true },
      { label: ['Start-up: [CP-2] and [CP-3] clear'] },
      { id: 'C1', name: S.C1, lines: ['Belt stopped ({ENC-43} = 0)', 'Robot 1 may place a part at the entry'] },
      { label: ['Robot 1 "part placed" · [CP-2] part present', '({PE-41} + {CAM-1})'] },
      { id: 'C2', name: S.C2, lines: ['Belt still stopped · wait for the', 'transport permissives'] },
      { label: ['R1 and R2 clear of conveyor · [CP-3] exit clear'] },
      { id: 'C3', name: S.C3, lines: ['Motor ON · {ENC-43} must count pulses', 'within 1 s · exit reached within 15 s'] },
      { label: ['Part at the end stop: {PE-42} ON or {CAM-2} sees it', '(either source is enough to stop the belt)'] },
      { id: 'C4', name: S.C4, lines: ['Motor OFF · wait for zero speed'] },
      { label: ['{ENC-43} zero speed for 0.2 s'] },
      { id: 'C5', name: S.C5, lines: ['[CP-3] part at exit ({PE-42} + {CAM-2}) ·', '{CAM-2} pick pose · "pick allowed" to R2'] },
    ]);
    const s = d.st;
    band(d, s.C1, s.C2, 'stop', 'BELT STOPPED');
    band(d, s.C3, s.C4, 'move', 'BELT MOVING', s.C4, s.C4);
    band(d, s.C5, s.C5, 'stop', 'STOPPED');
    const yl = s.C5.bottom + 44;
    d.arrow([[CX, s.C5.bottom], [CX, yl], [G.LOOP, yl], [G.LOOP, s.C1.cy + 10], [X, s.C1.cy + 10]], ['Robot 2 picked: {GR-51} grip OK', '[CP-3] exit clear · R2 clear of conveyor'], { at: [(CX + G.LOOP) / 2 + 26, yl] });
    const f = d.state('F', G.SX, s.C3.top - 6, G.SW, 'FAULT', ['No {ENC-43} pulses within 1 s', '(belt / drive), or no {PE-42}', 'within 15 s (jam, lost part)'], 'fault');
    d.arrow([[X + W, s.C3.top + 22], [G.SX, s.C3.top + 22]], null, { kind: 'fault' });
    const h = d.state('H', G.SX, s.C1.top, G.SW, 'HOLD (LINE STOP)', ['A running transport finishes at', 'the stop; no new transport starts'], 'hold');
    d.arrow([[G.SX - 42, h.cy], [G.SX, h.cy]], null, { kind: 'hold', dash: true });
    return finish(d, yl + 16, [
      '*Stop logic:* stopping uses *OR* ({PE-42} or {CAM-2}) because stopping is the safe direction;',
      'confirming the part for the pick uses the cross-check [CP-3] (both must agree, otherwise the camera decides).',
    ]);
  }

  // ------------------------------------------------------------------ SD: Robot 2, Setup 1
  function smRobot2S1(o) {
    const S = M.STATES.R2S1;
    const d = new Diagram(844, 0, 'State diagram: Robot 2 + output pallet (Setup 1)',
      'The blue light {LT-53} is the "pallet ready for pickup" signal required by the assignment.', o);
    const { X, W, CX } = G;
    chain(d, X, W, d.top, [
      { init: true },
      { label: ['Auto mode ON'] },
      { id: 'D0', name: S.D0, lines: ['Home · [CP-4] pallet present ({PX-52} + {CAM-2})', '{CAM-2} reads the slot map, sets the count'] },
      { label: ['Robot home · pallet present · free slots'] },
      { id: 'D1', name: S.D1, lines: ['Robot at home, clear of the conveyor'] },
      { label: ['Conveyor in C5: "pick allowed" + pick pose ({CAM-2})'] },
      { id: 'D2', name: S.D2, lines: ['Belt stopped ({ENC-43} = 0) · move to the', 'pick pose · grip · lift · retract'] },
      { label: ['{GR-51} grip OK · [CP-3] exit clear', 'R2 clear of conveyor'] },
      { id: 'D3', name: S.D3, lines: ['[CP-4] pallet present ({PX-52} + {CAM-2}) ·', '{CAM-2} next free slot · place · release'] },
    ]);
    const s = d.st;
    const cy = s.D3.bottom + 72;
    const c = d.choice('Q1', CX, cy, 176, 66, ['Output pallet', 'full?']);
    d.arrow([[CX, s.D3.bottom], [CX, c.top]], ['{CAM-2}: slot occupied · count + 1'], { at: [CX, (s.D3.bottom + c.top) / 2] });
    d.arrow([[c.left, cy], [G.LOOP, cy], [G.LOOP, s.D1.cy], [X, s.D1.cy]], ['No: count < 12'], { at: [(c.left + G.LOOP) / 2 + 6, cy - 13] });
    const d4 = d.state('D4', G.SX, cy - 42, G.SW, S.D4, ['{LT-53} blue light ON · wait for', 'the swap: {PX-52} OFF → ON and', '{CAM-2} sees an empty pallet'], 'op');
    d.arrow([[c.right, cy], [d4.left, cy]], ['Yes: count = 12', '{CAM-2}: all slots full'], { at: [(c.right + d4.left) / 2 - 4, cy - 32], kind: 'ok' });
    const xr = X + W + 50;
    d.arrow([[d4.cx, d4.top], [d4.cx, d4.top - 18], [xr, d4.top - 18], [xr, s.D1.cy], [X + W, s.D1.cy]], ['pallet swapped → count = 0 · {LT-53} OFF'], { at: [xr, (s.D1.cy + d4.top - 18) / 2 + 20], rotate: -90 });
    faultHold(d, s.D0.top, true);
    return finish(d, c.bottom, HOLD_FAULT_NOTE);
  }

  // ------------------------------------------------------------------ SD: Robot 1, Setup 2
  function smRobot1S2(o) {
    const S = M.STATES.R1S2;
    const d = new Diagram(844, 0, 'State diagram: Robot 1 + CNC (Setup 2, dual gripper A / B)',
      'Gripper A carries the raw part, gripper B the finished part. The raw part is picked while the CNC is still machining.', o);
    const { X, W, CX } = G;
    chain(d, X, W, d.top, [
      { init: true },
      { label: ['Auto mode ON'] },
      { id: 'B0', name: S.B0, lines: ['Home robot · check CNC ready, door closed', '({ZS-32}) and fixture state ({PS-36})'] },
      { label: ['Robot home · CNC ready · door closed'] },
      { id: 'B1', name: S.B1, lines: ['[CP-1] pallet present ({PX-11} + {CAM-1}) ·', '{CAM-1} pick pose · gripper A picks'] },
      { label: ['{GR-21A} grip OK · {CAM-1} slot now empty'] },
      { id: 'B2', name: S.B2, lines: ['Hold the raw part at the door-ready pose', 'while the CNC finishes the cycle'] },
      { label: ['CNC cycle complete · spindle stopped', '{ZS-33} guard lock released'] },
      { id: 'B3', name: S.B3, lines: ['Empty gripper B grips the handle, slides', 'the door open, releases it'] },
      { label: ['{ZS-31} door open = ON · {ZS-32} = OFF'] },
      { id: 'B4', name: S.B4, lines: ['B grips finished part · vise opens · lift ·', 'air blast · A places raw part · clamp'] },
      { label: ['{GR-21B} grip OK · {ZS-35} clamped · {PS-36} seated', 'gripper A open · R1 clear of CNC'] },
      { id: 'B5', name: S.B5, lines: ['Empty gripper A slides the door closed,', 'releases the handle'] },
      { label: ['{ZS-32} door closed = ON · {ZS-33} locked'] },
      { id: 'B6', name: S.B6, lines: ['Send CYCLE START · CNC idle time ends'] },
      { label: ['CNC in cycle · gripper B holds a finished part'] },
      { id: 'B7', name: S.B7, lines: ['Wait for {ENC-43} = 0 and [CP-2] entry clear', '· place the finished part · release'] },
    ]);
    const s = d.st;
    band(d, s.B1, s.B2, 'run', 'MACHINING', s.B2, s.B2);
    band(d, s.B3, s.B6, 'idle', `CNC IDLE ≈ ${M.KPI.idle2} s`);
    band(d, s.B7, s.B7, 'run', 'MACHINING');
    const yl = s.B7.bottom + 30;
    d.arrow([[CX, s.B7.bottom], [CX, yl], [G.LOOP, yl], [G.LOOP, s.B1.cy + 10], [X, s.B1.cy + 10]], ['[CP-2] part present ({PE-41} + {CAM-1}) · R1 clear'], { at: [(CX + G.LOOP) / 2 + 44, yl] });
    d.arrow([[X, s.B6.cy], [G.SKIP, s.B6.cy], [G.SKIP, s.B1.cy - 10], [X, s.B1.cy - 10]], ['first cycle: gripper B is empty'], { at: [G.SKIP, (s.B3.top + s.B5.bottom) / 2], rotate: -90 });
    const w1 = d.state('W1', G.SX, s.B1.cy - 35, G.SW, S.W1, ['HMI: "Load input pallet"', 'amber light · robot waits'], 'op');
    const mx = (X + W + G.BR + G.SX) / 2;
    d.arrow([[X + W, s.B1.cy - 12], [G.SX, s.B1.cy - 12]], ['no parts left', '({CAM-1})'], { at: [mx, s.B1.cy - 40] });
    d.arrow([[G.SX, s.B1.cy + 14], [X + W, s.B1.cy + 14]], ['pallet loaded', '[CP-1] OK'], { at: [mx, s.B1.cy + 42] });
    faultHold(d, s.B4.top - 10, true);
    return finish(d, yl, HOLD_FAULT_NOTE);
  }

  // ------------------------------------------------------------------ SD: Robot 2, Setup 2
  function smRobot2S2(o) {
    const S = M.STATES.R2S2;
    const d = new Diagram(860, 0, 'State diagram: Robot 2 + gauge + sorting (Setup 2)',
      'Every part is measured. Accept only if length, width and height are all ≥ 48.00 mm (50 mm nominal − 2 mm).', o);
    const { X, W, CX } = G;
    chain(d, X, W, d.top, [
      { init: true },
      { label: ['Auto mode ON'] },
      { id: 'E0', name: S.E0, lines: ['Home · [CP-4] pallet · [CP-5] nest empty ·', 'master cube check of the 3 lasers'] },
      { label: ['Robot home · pallet ready · gauge verified'] },
      { id: 'E1', name: S.E1, lines: ['Robot at home, clear of the conveyor'] },
      { label: ['Conveyor in C5: "pick allowed" + pick pose ({CAM-2})'] },
      { id: 'E2', name: S.E2, lines: ['Belt stopped ({ENC-43} = 0) · grip · lift'] },
      { label: ['{GR-51} grip OK · [CP-3] exit clear · R2 clear'] },
      { id: 'E3', name: S.E3, lines: ['Place in the corner nest · push against the', '3 datums (force control) · release · retract'] },
      { label: ['[CP-5] part in nest ({PX-64} + {CAM-2})', 'R2 clear of the laser paths'] },
      { id: 'E4', name: S.E4, lines: ['{LS-61}/{LS-62}/{LS-63}: average of 10 samples', 'size = 50.000 + (d master − d part)'] },
    ]);
    const s = d.st;
    const c1y = s.E4.bottom + 80;
    const c1 = d.choice('Q1', CX, c1y, 214, 74, ['L, W and H', '≥ 48.00 mm?']);
    d.arrow([[CX, s.E4.bottom], [CX, c1.top]], ['3 valid readings (re-measure once; still', 'invalid → NOK + sensor error logged)'], { at: [CX, (s.E4.bottom + c1.top) / 2] });
    const e6 = d.state('E6', G.SX, c1y - 42, G.SW, S.E6, ['Re-pick · drop into the locked chute', '{PE-65} confirms · log L, W, H ·', '2 NOK in a row → quality hold'], 'stop');
    d.arrow([[c1.right, c1y], [e6.left, c1y]], ['No:', 'undersized'], { at: [(c1.right + e6.left) / 2, c1y - 26], kind: 'fault' });
    const e5 = d.state('E5', X, c1.bottom + 60, W, S.E5, ['Re-pick from nest · [CP-4] pallet present ·', '{CAM-2} next free slot · place · release'], 'ok');
    d.arrow([[CX, c1.bottom], [CX, e5.top]], ['Yes: OK part'], { at: [CX, (c1.bottom + e5.top) / 2], kind: 'ok' });
    const c2y = e5.bottom + 74;
    const c2 = d.choice('Q2', CX, c2y, 176, 66, ['Output pallet', 'full?']);
    d.arrow([[CX, e5.bottom], [CX, c2.top]], ['{CAM-2}: slot occupied · count + 1'], { at: [CX, (e5.bottom + c2.top) / 2] });
    d.arrow([[c2.left, c2y], [G.LOOP, c2y], [G.LOOP, s.E1.cy], [X, s.E1.cy]], ['No: count < 12'], { at: [(c2.left + G.LOOP) / 2 + 6, c2y - 13] });
    const e7 = d.state('E7', G.SX, c2y - 42, G.SW, S.E7, ['{LT-53} blue light ON · wait for', 'the swap: {PX-52} OFF → ON and', '{CAM-2} sees an empty pallet'], 'op');
    d.arrow([[c2.right, c2y], [e7.left, c2y]], ['Yes: count = 12'], { at: [(c2.right + e7.left) / 2, c2y - 14], kind: 'ok' });
    // E6 -> E1 through the gap; E7 -> E1 along the outer right rail
    const xg = X + W + 40, xo = G.SX + G.SW + 18;
    d.arrow([[e6.cx, e6.top], [e6.cx, e6.top - 16], [xg, e6.top - 16], [xg, s.E1.cy + 10], [X + W, s.E1.cy + 10]], ['{PE-65} part dropped · NOK + 1'], { at: [xg, (s.E1.cy + e6.top) / 2 + 30], rotate: -90 });
    d.arrow([[e7.right, c2y], [xo, c2y], [xo, s.E1.cy - 10], [X + W, s.E1.cy - 10]], ['pallet swapped · count = 0 · {LT-53} OFF'], { at: [(X + W + xo) / 2 + 40, s.E1.cy - 22] });
    faultHold(d, s.E2.top - 6, true);
    return finish(d, c2.bottom, [
      '*Quality hold:* 2 consecutive NOK parts → the CNC finishes the current part and starts no new cycle until the tool',
      'and offsets are checked and the operator resets. *One point per face is enough:* squareness and flatness < 0.1 mm.',
      'F FAULT and H HOLD are entered from any state (see the Robot 1 diagram).',
    ]);
  }

  // ------------------------------------------------------------------ Cross-check flowchart
  function flowCrossCheck(o) {
    const d = new Diagram(860, 0, 'Camera + proximity cross-check (runs at every checkpoint CP-1 … CP-5)',
      'Both sources must agree. If they disagree the camera decides; 3 disagreements within 10 minutes stop the line.', o);
    const t = d.top;
    const LX = 18, LW = 222, LC = LX + LW / 2;
    const MX = 280, MW = 320, MC = MX + MW / 2;
    const RX = 632, RW = 212, RC = RX + RW / 2;
    const n1 = d.node('N1', MX, t + 4, MW, 70, ['CHECKPOINT CP-n REACHED', 'scene static: robot out of the ROI,', 'belt stopped · wait 0.3 s'], { shape: 'term', kind: 'check' });
    const n2 = d.node('N2', MX, n1.bottom + 30, MW, 70, ['READ BOTH SOURCES', 'proximity sensor (debounced 50 ms)', 'camera snapshot of the same ROI']);
    d.arrow([[MC, n1.bottom], [MC, n2.top]]);
    const q1 = d.choice('Q1', MC, n2.bottom + 30 + 40, 244, 80, ['Camera image', 'valid?']);
    d.arrow([[MC, n2.bottom], [MC, q1.top]]);
    d.text(['valid = frame received,', 'exposure OK, calibration', 'marks found'], [q1.right + 14, q1.cy], { anchor: 'start', tcls: 'dg-small' });
    const r1 = d.node('R1', LX, q1.cy - 28, LW, 56, ['RE-TRIGGER ONCE', 'new image of the same ROI']);
    d.arrow([[q1.left, q1.cy], [r1.right, q1.cy]], ['No'], { at: [(q1.left + r1.right) / 2, q1.cy - 13], kind: 'fault' });
    const q1b = d.choice('Q1B', LC, r1.bottom + 30 + 33, 170, 66, ['Valid now?']);
    d.arrow([[LC, r1.bottom], [LC, q1b.top]]);
    const cf = d.node('CF', LX, q1b.bottom + 36, LW, 86, ['CAMERA FAULT', '→ LINE STOP', 'the camera is the reference,', 'so the line never runs blind'], { shape: 'term', kind: 'stop', titleLines: 2 });
    d.arrow([[LC, q1b.bottom], [LC, cf.top]], ['No'], { at: [LC + 14, (q1b.bottom + cf.top) / 2], anchor: 'start', kind: 'fault' });
    const q2 = d.choice('Q2', MC, q1b.cy + 30 + 44, 262, 88, ['Proximity', '= Camera?']);
    d.arrow([[MC, q1.bottom], [MC, q2.top]], ['Yes'], { at: [MC + 14, q1.bottom + 16], anchor: 'start' });
    d.arrow([[q1b.right, q1b.cy], [MC - 3, q1b.cy]], ['Yes'], { at: [(q1b.right + MC) / 2 - 10, q1b.cy - 13] });
    const ag = d.node('AG', RX, q2.cy - 36, RW, 72, ['AGREE', 'use the value, the', 'sequence continues'], { shape: 'term', kind: 'ok' });
    d.arrow([[q2.right, q2.cy], [ag.left, q2.cy]], ['Yes'], { at: [(q2.right + ag.left) / 2, q2.cy - 13], kind: 'ok' });
    const mm = d.node('MM', MX, q2.bottom + 40, MW, 90, ['MISMATCH', 'USE THE CAMERA VALUE', 'log time, CP and both readings', 'amber light · HMI names the sensor'], { kind: 'warn', titleLines: 2 });
    d.arrow([[MC, q2.bottom], [MC, mm.top]], ['No'], { at: [MC + 14, (q2.bottom + mm.top) / 2], anchor: 'start', kind: 'fault' });
    const wn = d.node('WN', MX, mm.bottom + 30, MW, 58, ['ADD TO THE 10-MIN WINDOW', 'events older than 10 min drop out']);
    d.arrow([[MC, mm.bottom], [MC, wn.top]]);
    const q3 = d.choice('Q3', MC, wn.bottom + 30 + 46, 276, 92, ['≥ 3 mismatches', 'in the last 10 min?']);
    d.arrow([[MC, wn.bottom], [MC, q3.top]]);
    const cn = d.node('CN', RX, q3.cy - 36, RW, 72, ['CONTINUE', 'with the camera value,', 'warning stays active'], { shape: 'term', kind: 'warn' });
    d.arrow([[q3.right, q3.cy], [cn.left, q3.cy]], ['No'], { at: [(q3.right + cn.left) / 2, q3.cy - 13] });
    const ls = d.node('LS', MX, q3.bottom + 40, MW, 88, ['LINE STOP', 'SENSOR VERIFICATION', 'controlled stop · red light', '(see the supervisor states)'], { shape: 'term', kind: 'stop', titleLines: 2 });
    d.arrow([[MC, q3.bottom], [MC, ls.top]], ['Yes'], { at: [MC + 14, (q3.bottom + ls.top) / 2], anchor: 'start', kind: 'fault' });
    d.h = ls.bottom + 20;
    return d.svg();
  }

  // ------------------------------------------------------------------ Supervisor states
  function smSupervisor(o) {
    const S = M.STATES.XCHK;
    const d = new Diagram(860, 0, 'State diagram: cross-check supervisor (camera vs proximity)',
      'Runs in parallel with the other state machines and counts disagreements in a 10-minute sliding window.', o);
    const t = d.top + 34;
    const x1 = d.state('X1', 60, t, 300, S.X1, ['All checkpoints agree', 'stack light {LT-01} green'], 'ok');
    const x2 = d.state('X2', 500, t, 300, S.X2, ['1–2 mismatches in the last 10 min', 'camera value used · amber flashing'], 'warn');
    const x3 = d.state('X3', 500, t + 250, 300, S.X3, ['Controlled stop: CNC ends its cycle,', 'robots park, belt stops · red light'], 'stop');
    const x4 = d.state('X4', 60, t + 250, 300, S.X4, ['Technician cleans and aligns sensors,', 'tests each CP, checks camera calibration'], 'check');
    d.init(30, t - 22); d.arrow([[30, t - 14], [30, x1.cy], [x1.left, x1.cy]], null, { r: 8 });
    d.arrow([[x1.right, x1.cy - 14], [x2.left, x2.cy - 14]], ['mismatch at any CP'], { at: [(x1.right + x2.left) / 2, x1.cy - 30] });
    d.arrow([[x2.left, x2.cy + 14], [x1.right, x1.cy + 14]], ['no mismatch for', '10 min (window empty)'], { at: [(x1.right + x2.left) / 2, x1.cy + 44] });
    d.arrow([[x2.right - 50, x2.top], [x2.right - 50, x2.top - 24], [x2.right + 22, x2.top - 24], [x2.right + 22, x2.cy], [x2.right, x2.cy]], ['mismatch, count < 3'], { at: [x2.right - 40, x2.top - 36] });
    d.arrow([[x2.cx, x2.bottom], [x2.cx, x3.top]], ['3rd mismatch', 'within 10 min'], { at: [x2.cx, (x2.bottom + x3.top) / 2], kind: 'fault' });
    const ym = (x1.bottom + x4.top) / 2 + 26;
    d.arrow([[x1.cx + 70, x1.bottom], [x1.cx + 70, ym], [x3.left + 60, ym], [x3.left + 60, x3.top]], ['camera fault (after 1 retry)'], { at: [(x1.cx + 70 + x3.left + 60) / 2, ym], kind: 'fault' });
    d.arrow([[x3.left, x3.cy], [x4.right, x4.cy]], ['all stopped · technician', 'starts the check'], { at: [(x3.left + x4.right) / 2, x3.cy + 30] });
    d.arrow([[x4.cx - 70, x4.top], [x4.cx - 70, x1.bottom]], ['all CP tests pass ·', 'operator reset →', 'counter cleared'], { at: [x4.cx - 70, (x1.bottom + x4.top) / 2 - 10], kind: 'ok' });
    d.arrow([[x4.left + 50, x4.bottom], [x4.left + 50, x4.bottom + 28], [x4.left + 140, x4.bottom + 28], [x4.left + 140, x4.bottom]], ['test fails → repair or replace the sensor, re-test'], { at: [x4.left + 95, x4.bottom + 44] });
    const yN = d.note(500, x3.bottom + 22, 300, ['*The camera never overrides safety:*', 'door interlock, E-stops and scanners', 'stay hardwired to the safety relay.']);
    d.h = Math.max(yN, x4.bottom + 60) + 16;
    return d.svg();
  }

  // ------------------------------------------------------------------ Control architecture
  function archDiagram(o) {
    const d = new Diagram(900, 0, 'Control architecture: four state machines in the cell PLC',
      'Each state machine moves only on its own sensors plus the handshake signals written on the arrows.', o);
    const t = d.top;
    const cnc = d.node('CNC', 40, t + 4, 240, 74, ['CNC + DOOR KIT', 'robot interface · {ZS-31} {ZS-32} {ZS-33}', 'vise {ZS-34} {ZS-35} · {PS-36}']);
    const op = d.node('OP', 620, t + 4, 240, 74, ['OPERATOR / HMI', 'loads input pallet ({PX-11}, [CP-1])', 'swaps output pallet · resets'], { kind: 'op' });
    const yb = t + 170;
    const s1 = d.node('SM1', 40, yb + 26, 240, 92, ['SM-1  ROBOT 1 + CNC', 'states A0–A8 (Setup 1)', 'or B0–B7 (Setup 2)', '{PX-11} {CAM-1} {GR-21}']);
    const s2 = d.node('SM2', 360, yb + 26, 180, 92, ['SM-2  CONVEYOR', 'states C1–C5', '{PE-41} {PE-42}', '{ENC-43}']);
    const s3 = d.node('SM3', 620, yb + 26, 240, 92, ['SM-3  ROBOT 2 + PALLET', 'states D0–D4 (Setup 1)', 'or E0–E7 (Setup 2)', '{CAM-2} {GR-51} {PX-52}']);
    const s4 = d.node('SM4', 40, s1.bottom + 96, 820, 76, ['SM-4  CROSS-CHECK SUPERVISOR  (states X1–X4)', 'compares proximity vs camera at CP-1 … CP-5 · counts mismatches in a 10-min window', 'commands LINE STOP after 3 mismatches in 10 min']);
    d.raw(`<rect x="22" y="${yb}" width="856" height="${s4.bottom + 34 - yb}" rx="12" fill="none" stroke="var(--dg-rule,#aab4be)" stroke-width="1.4" stroke-dasharray="6 5"/><text class="dg-band-label" x="38" y="${s4.bottom + 24}">CELL PLC-01 · runs the 4 state machines</text>`, 'bg');
    d.arrow([[120, s1.top], [120, cnc.bottom]], ['cycle start,', 'door + vise', 'requests'], { at: [114, (s1.top + cnc.bottom) / 2], anchor: 'end' });
    d.arrow([[200, cnc.bottom], [200, s1.top]], ['cycle complete,', 'spindle stopped,', 'door + vise state'], { at: [206, (s1.top + cnc.bottom) / 2], anchor: 'start' });
    d.arrow([[s1.right, s1.cy - 16], [s2.left, s2.cy - 16]], ['part placed', 'R1 clear'], { at: [(s1.right + s2.left) / 2, s1.cy - 40] });
    d.arrow([[s2.left, s2.cy + 16], [s1.right, s1.cy + 16]], ['belt', 'stopped'], { at: [(s1.right + s2.left) / 2, s1.cy + 40] });
    d.arrow([[s2.right, s2.cy - 16], [s3.left, s3.cy - 16]], ['pick allowed', '+ pick pose'], { at: [(s2.right + s3.left) / 2, s2.cy - 40] });
    d.arrow([[s3.left, s3.cy + 16], [s2.right, s2.cy + 16]], ['part picked', 'R2 clear'], { at: [(s2.right + s3.left) / 2, s2.cy + 40] });
    d.arrow([[700, op.bottom], [700, s3.top]], ['pallet', 'swapped', '({PX-52})'], { at: [694, (s3.top + op.bottom) / 2], anchor: 'end' });
    d.arrow([[780, s3.top], [780, op.bottom]], ['{LT-53}', 'pallet full'], { at: [786, (s3.top + op.bottom) / 2], anchor: 'start' });
    [s1, s2, s3].forEach((s, i) => {
      d.arrow([[s.cx - 22, s.bottom], [s.cx - 22, s4.top]], i === 0 ? ['CP results'] : null, { at: [s.cx - 28, (s.bottom + s4.top) / 2], anchor: 'end' });
      d.arrow([[s.cx + 22, s4.top], [s.cx + 22, s.bottom]], i === 2 ? ['LINE STOP', '/ resume'] : null, { at: [s.cx + 28, (s.bottom + s4.top) / 2], anchor: 'start', kind: 'hold', dash: true });
    });
    d.h = s4.bottom + 50;
    return d.svg();
  }

  // ------------------------------------------------------------------ Part flows
  function flowColumns(d, L, R, W, H, Gp, left, right, prefix) {
    let y = d.top + 4, prev = null;
    left.forEach((n) => {
      const g = d.node(prefix + n[0], L, y, W, H, n[3], { owner: n[1], ownerCls: n[2], num: n[0] });
      if (prev) d.arrow([[L + W / 2, prev.bottom], [L + W / 2, g.top]]);
      prev = g; y += H + Gp;
    });
    const lastL = prev;
    y = d.top + 4; prev = null;
    right.forEach((n) => {
      const g = d.node(prefix + n[0], R, y, W, H, n[3], { owner: n[1], ownerCls: n[2], num: n[0] });
      if (prev) d.arrow([[R + W / 2, prev.bottom], [R + W / 2, g.top]]);
      prev = g; y += H + Gp;
    });
    const firstR = d.st[prefix + right[0][0]];
    const gx = (L + W + R) / 2;
    d.arrow([[lastL.right, lastL.cy], [gx, lastL.cy], [gx, firstR.cy], [R, firstR.cy]], null, { r: 10 });
    return { lastL, lastR: prev };
  }
  function flowSetup1(o) {
    const d = new Diagram(880, 0, 'Work flow of one part: Setup 1',
      'Each box: who acts, what happens, and the signal that confirms the step before the next one starts.', o);
    const L = 18, W = 408, R = 454, H = 66, Gp = 20;
    const { lastL, lastR } = flowColumns(d, L, R, W, H, Gp, [
      ['1', 'OPERATOR', 'op', ['Load the input pallet, press "Pallet loaded"', 'confirm: [CP-1] {PX-11} + {CAM-1} pallet present']],
      ['2', 'CAMERA 1', 'cam', ['Locate the next raw part (x, y, angle)', 'confirm: part found → pick pose to Robot 1']],
      ['3', 'ROBOT 1', '', ['Pick the raw part from the pallet', 'confirm: {GR-21} grip OK · {CAM-1} slot empty']],
      ['4', 'ROBOT 1 + CNC', 'cnc', ['Open the CNC door (the robot slides it)', 'needs CNC stopped, {ZS-33} unlocked → {ZS-31} open']],
      ['5', 'ROBOT 1 + CNC', 'cnc', ['Load the part in the vise and clamp', 'confirm: {ZS-35} clamped · {PS-36} seated · R1 clear']],
      ['6', 'ROBOT 1 + CNC', 'cnc', ['Close the CNC door', 'confirm: {ZS-32} closed · {ZS-33} locked']],
      ['7', 'CNC', 'cnc', ['Cycle start → machining (2 min)', 'confirm: in cycle → cycle complete, spindle stop']],
    ], [
      ['8', 'ROBOT 1 + CNC', 'cnc', ['Open the door and unload the part', 'confirm: {ZS-31} · {ZS-34} open · {PS-36} OFF · {GR-21}']],
      ['9', 'ROBOT 1', '', ['Place the part at the conveyor entry', 'needs {ENC-43} = 0 · confirm: [CP-2] {PE-41} + {CAM-1}']],
      ['10', 'CONVEYOR', 'conv', ['Transport to the end stop', 'confirm: {ENC-43} moving · stop on {PE-42} · = 0']],
      ['11', 'CAMERA 2', 'cam', ['Verify the part and locate it', 'confirm: [CP-3] {PE-42} + {CAM-2} · pick pose']],
      ['12', 'ROBOT 2', 'r2', ['Pick the part from the conveyor', 'confirm: {GR-51} grip OK · [CP-3] exit clear']],
      ['13', 'ROBOT 2', 'r2', ['Place the part on the output pallet', 'confirm: [CP-4] {PX-52} + {CAM-2} · slot occupied']],
    ], 'F');
    const qc = R + W / 2, qy = lastR.bottom + 56;
    const q = d.choice('Q', qc, qy, 224, 68, ['Output pallet', 'full (12 parts)?']);
    d.arrow([[qc, lastR.bottom], [qc, q.top]], ['count + 1'], { at: [qc + 12, (lastR.bottom + q.top) / 2], anchor: 'start' });
    d.arrow([[q.right, qy], [q.right + 44, qy]], ['No'], { at: [q.right + 20, qy - 13] });
    d.conn(q.right + 57, qy, 'A');
    d.text(['next part:', 'back to step 2'], [q.right + 57, qy + 34]);
    d.conn(L + 2, d.st.F2.cy, 'A');
    const lt = d.node('F14', R, q.bottom + 30, W, H, ['{LT-53} blue light ON: pallet ready for pickup', 'operator swaps it → {PX-52} OFF → ON · count = 0'], { owner: 'LIGHT + OPERATOR', ownerCls: 'light', num: '14' });
    d.arrow([[qc, q.bottom], [qc, lt.top]], ['Yes'], { at: [qc + 12, (q.bottom + lt.top) / 2], anchor: 'start', kind: 'ok' });
    const yN = d.note(L, lastL.bottom + 30, W, [
      '[CP-n] = the camera and the proximity sensor must',
      'agree. If they disagree the camera value is used',
      'and the mismatch is logged; 3 mismatches within',
      '10 min stop the line for sensor verification.',
    ]);
    d.h = Math.max(lt.bottom, yN) + 20;
    return d.svg();
  }
  function flowSetup2(o) {
    const d = new Diagram(880, 0, 'Work flow of one part: Setup 2 (dual gripper + dimensional gauge)',
      'Robot 1 only tends the CNC; Robot 2 measures and sorts while the CNC is already machining the next part.', o);
    const L = 18, W = 408, R = 454, H = 66, Gp = 20;
    const { lastL, lastR } = flowColumns(d, L, R, W, H, Gp, [
      ['1', 'OPERATOR', 'op', ['Load the input pallet', 'confirm: [CP-1] {PX-11} + {CAM-1}']],
      ['2', 'ROBOT 1', '', ['Pre-pick the next raw part with gripper A', 'during machining · {GR-21A} OK · slot empty']],
      ['3', 'ROBOT 1', '', ['Wait at the CNC door holding the raw part', 'until: cycle complete · spindle stop · {ZS-33} open']],
      ['4', 'ROBOT 1 + CNC', 'cnc', ['Open the door with gripper B', 'confirm: {ZS-31} open · {ZS-32} OFF']],
      ['5', 'ROBOT 1 + CNC', 'cnc', ['Exchange: B unloads, air blast, A loads', 'confirm: {GR-21B} OK · {ZS-35} · {PS-36} seated']],
      ['6', 'ROBOT 1 + CNC', 'cnc', ['Close the door with gripper A, cycle start', 'confirm: {ZS-32} · {ZS-33} locked · CNC in cycle']],
      ['7', 'ROBOT 1', '', ['Place the finished part on the conveyor', 'needs {ENC-43} = 0 · confirm: [CP-2]']],
    ], [
      ['8', 'CONVEYOR', 'conv', ['Transport, stop at the end stop', 'confirm: {ENC-43} · {PE-42} · [CP-3] {PE-42} + {CAM-2}']],
      ['9', 'ROBOT 2', 'r2', ['Pick the part from the conveyor', 'confirm: {GR-51} grip OK · [CP-3] exit clear']],
      ['10', 'ROBOT 2', 'r2', ['Load the gauge nest, push to the datums', 'confirm: [CP-5] {PX-64} + {CAM-2} · robot clear']],
      ['11', 'GAUGE', 'gauge', ['Measure L, W, H ({LS-61} {LS-62} {LS-63})', 'confirm: 3 valid readings (average of 10)']],
    ], 'G');
    const qc = R + W / 2, qy = lastR.bottom + 60;
    const q = d.choice('Q', qc, qy, 236, 74, ['L, W and H', '≥ 48.00 mm?']);
    d.arrow([[qc, lastR.bottom], [qc, q.top]]);
    const bw = 196, by = q.bottom + 40;
    const ok = d.node('G12', R, by, bw, 104, ['Place on output pallet', '[CP-4] · slot occupied', 'at 12 parts → {LT-53} ON', '(as Setup 1, steps 13–14)'], { owner: 'ROBOT 2 · OK', ownerCls: 'ok', num: '12a' });
    const nk = d.node('G13', R + W - bw, by, bw, 104, ['Drop in NOK chute', '{PE-65} confirms the drop', 'log L, W, H', '2 NOK in a row → hold'], { owner: 'ROBOT 2 · NOK', ownerCls: 'nok', num: '12b' });
    d.arrow([[q.left, qy], [ok.cx, qy], [ok.cx, ok.top]], ['Yes'], { at: [(q.left + ok.cx) / 2 - 6, qy - 13], kind: 'ok' });
    d.arrow([[q.right, qy], [nk.cx, qy], [nk.cx, nk.top]], ['No'], { at: [(q.right + nk.cx) / 2 + 6, qy - 13], kind: 'fault' });
    const yN = d.note(L, lastL.bottom + 30, W, [
      `*CNC idle* = steps 4 → 6 only: ≈ ${M.KPI.idle2} s (Setup 1: ${M.KPI.idle1} s).`,
      'Steps 7 and 2 run while the CNC machines, and',
      'Robot 2 measures in parallel, so the quality',
      'check never makes the CNC wait.',
    ]);
    d.h = Math.max(ok.bottom, yN) + 20;
    return d.svg();
  }

  // ------------------------------------------------------------------ Timing chart
  function timingChart(o) {
    const T = M.T, K = M.KPI;
    const d = new Diagram(980, 0, 'Timing of one CNC cycle: Setup 1 vs Setup 2',
      't = 0 is "cycle complete". Amber = CNC idle (waiting for the robot), blue = machining. Axis compressed after 50 s.', o);
    const X0 = 150, BRK = 50, P1 = 10, P2 = (940 - X0 - BRK * P1) / (160 - BRK);
    const xs = (t) => (t <= BRK ? X0 + t * P1 : X0 + BRK * P1 + (t - BRK) * P2);
    const bar = (row, t0, t1, cls, label, dark) => {
      const x = xs(t0), w = Math.max(1.5, xs(t1) - xs(t0));
      let s = `<rect class="${cls}" x="${fmt(x)}" y="${fmt(row)}" width="${fmt(w - 1)}" height="26" rx="3"/>`;
      if (label && w > label.length * 5.4 + 6) s += `<text class="gt-bar-t${dark ? ' dark' : ''}" x="${fmt(x + w / 2)}" y="${fmt(row + 17.5)}" text-anchor="middle">${esc(label)}</text>`;
      d.raw(s);
    };
    const grid = (y0, y1) => {
      [0, 10, 20, 30, 40, 50, 100, 150].forEach((t) => {
        d.raw(`<line class="gt-grid" x1="${fmt(xs(t))}" y1="${y0}" x2="${fmt(xs(t))}" y2="${y1}"/><text class="gt-axis" x="${fmt(xs(t))}" y="${y1 + 16}" text-anchor="middle">${t} s</text>`, 'bg');
      });
      d.raw(`<rect x="${fmt(xs(BRK))}" y="${y0 - 6}" width="${fmt(xs(160) - xs(BRK))}" height="${y1 - y0 + 12}" fill="var(--dg-gray-b,#eef1f4)" opacity=".55"/><text class="ly-note" x="${fmt(xs(160))}" y="${y1 + 30}" text-anchor="end">compressed time scale after 50 s</text>`, 'bg');
    };
    const rowT = (y, t) => d.raw(`<text class="gt-row" x="${X0 - 12}" y="${y + 18}" text-anchor="end">${esc(t)}</text>`);
    const y1 = d.top + 30;
    d.raw(`<text class="gt-kpi" x="20" y="${y1 - 12}">Setup 1 · single gripper · CNC idle ${K.idle1} s · cycle ${K.cycle1} s · CNC utilization ${(K.util1 * 100).toFixed(1)} % · ${K.pph1.toFixed(1)} parts/h</text>`);
    grid(y1, y1 + 72);
    rowT(y1 + 6, 'CNC'); rowT(y1 + 40, 'Robot 1');
    bar(y1 + 6, 0, K.idle1, 'gt-idle', `idle ${K.idle1} s`, true);
    bar(y1 + 6, K.idle1, K.idle1 + T.cncCycle, 'gt-mach', 'machining 120 s');
    [[0, 6.0, 'gt-door', 'door'], [6.0, 12.5, 'gt-door', 'unload'], [12.5, 17.5, 'gt-move', 'to belt'], [17.5, 22.0, 'gt-move', 'pick'], [22.0, 31.5, 'gt-door', 'load'], [31.5, 36.5, 'gt-door', 'door']].forEach((b) => bar(y1 + 40, b[0], b[1], b[2], b[3]));
    bar(y1 + 40, K.idle1, K.idle1 + T.cncCycle, 'gt-wait', 'robot waits at home', true);
    const y2 = y1 + 156;
    d.raw(`<text class="gt-kpi" x="20" y="${y2 - 12}">Setup 2 · dual gripper + gauge at Robot 2 · CNC idle ${K.idle2} s · cycle ${K.cycle2} s · CNC utilization ${(K.util2 * 100).toFixed(1)} % · ${K.pph2.toFixed(1)} parts/h</text>`);
    grid(y2, y2 + 140);
    rowT(y2 + 6, 'CNC'); rowT(y2 + 40, 'Robot 1'); rowT(y2 + 74, 'Conveyor'); rowT(y2 + 108, 'Robot 2');
    const i2 = K.idle2;
    bar(y2 + 6, 0, i2, 'gt-idle', `idle ${i2} s`, true);
    bar(y2 + 6, i2, i2 + T.cncCycle, 'gt-mach', 'machining 120 s');
    [[0, 4.5, 'gt-door', 'door'], [4.5, 15.5, 'gt-door', 'exchange B / A'], [15.5, i2, 'gt-door', 'door']].forEach((b) => bar(y2 + 40, b[0], b[1], b[2], b[3]));
    const tc = i2 + T.doorToConv + T.placeConv + T.check;
    bar(y2 + 40, i2, tc, 'gt-move', 'to belt');
    const tp = tc + T.convToPallet + T.check + T.pickPallet;
    bar(y2 + 40, tc, tp, 'gt-move', 'pick A');
    const td = tp + T.palletToDoor;
    bar(y2 + 40, tp, td, 'gt-move', '');
    bar(y2 + 40, td, i2 + T.cncCycle, 'gt-wait', 'waits at the door with the next raw part', true);
    const b0 = tc + 0.5, b1 = b0 + T.beltStart + T.beltTravel + T.beltStop + T.zeroSpeed;
    bar(y2 + 74, b0, b1, 'gt-belt', 'transport');
    const r2a = b1 + T.check, r2b = r2a + T.r2ToExit + T.r2Pick + T.check;
    const r2c = r2b + T.r2ToGauge + T.r2LoadGauge + T.check, r2d = r2c + T.measure;
    const r2e = r2d + T.r2Repick + T.r2ToPallet + T.check + T.r2Place + T.check;
    bar(y2 + 108, r2a, r2b, 'gt-move', 'pick');
    bar(y2 + 108, r2b, r2c, 'gt-gauge', 'gauge');
    bar(y2 + 108, r2c, r2d, 'gt-gauge', '');
    bar(y2 + 108, r2d, r2e, 'gt-move', 'sort');
    d.raw(`<text class="dg-note" x="${fmt(xs(r2e) + 10)}" y="${y2 + 126}">sorted at t ≈ ${Math.round(r2e)} s, while the CNC machines the next part</text>`);
    const ly = y2 + 178;
    [['gt-mach', 'CNC machining'], ['gt-idle', 'CNC idle'], ['gt-door', 'robot at the CNC (door, unload, load)'], ['gt-move', 'robot moves, picks, places'], ['gt-belt', 'belt moving'], ['gt-gauge', 'gauge'], ['gt-wait', 'waiting']].reduce((x, it) => {
      d.raw(`<rect class="${it[0]}" x="${x}" y="${ly}" width="14" height="14" rx="2"/><text class="ly-legend" x="${x + 20}" y="${ly + 11.5}">${esc(it[1])}</text>`);
      return x + 36 + it[1].length * 6.1;
    }, 20);
    d.h = ly + 30;
    return d.svg();
  }

  // ------------------------------------------------------------------ Cell layout
  const LAYOUT = {
    W: 1110, H: 706,
    cnc: { x: 40, y: 96, w: 160, h: 500 },
    work: { x: 56, y: 210, w: 128, h: 320 },
    vise: { x: 92, y: 336, w: 54, h: 36 },
    fixture: [120, 354],
    door: { x: 200, w: 9, y0: 280, len: 150, travel: 150 },
    handleClosed: [224, 412], handleOpen: [224, 562],
    palletIn: { x: 262, y: 64, w: 150, h: 116 },
    palletOut: { x: 900, y: 300, w: 116, h: 150 },
    r1: { x: 345, y: 360, r: 34, home: [300, 452], doorReady: [250, 392] },
    r2: { x: 790, y: 520, r: 34, home: [846, 606] },
    conv: { x: 440, y: 336, w: 410, h: 72 },
    convEntry: [472, 372], convExit: [833, 372],
    pe41: 474, pe42: 826, enc: [600, 428],
    gauge: { x: 552, y: 494, w: 180, h: 124 }, nest: [620, 556],
    nok: { x: 920, y: 520, w: 104, h: 96 }, nokDrop: [972, 574],
    cab: { x: 250, y: 596, w: 200, h: 56 },
    stack: [474, 598], beacon: [1036, 316],
    fov1: { x: 244, y: 56, w: 316, h: 374 },
    fov2: { 1: { x: 740, y: 262, w: 304, h: 218 }, 2: { x: 540, y: 262, w: 504, h: 390 } },
    arm: { L1: 150, L2: 140 }, elbow: { r1: -1, r2: 1 },
  };
  function slotPos(p, i) {
    if (p === 'in') { const r = Math.floor(i / 4), c = i % 4; return [LAYOUT.palletIn.x + 24 + c * 34, LAYOUT.palletIn.y + 24 + r * 34]; }
    const r = Math.floor(i / 3), c = i % 3; return [LAYOUT.palletOut.x + 24 + c * 34, LAYOUT.palletOut.y + 24 + r * 34];
  }
  function partSvg(x, y, cls, extra) {
    const s = 22;
    return `<g class="ly-partg"${extra || ''}><rect class="ly-part ${cls || ''}" x="${fmt(x - s / 2)}" y="${fmt(y - s / 2)}" width="${s}" height="${s}" rx="2"/>` +
      (cls && cls.indexOf('fin') >= 0 ? `<rect class="ly-pocket" x="${fmt(x - 5)}" y="${fmt(y - 5)}" width="10" height="10" rx="1"/>` : '') + '</g>';
  }
  // Two-link arm drawn from the base to the tool point (top view, schematic)
  function armGeom(base, tool, sign) {
    const { L1, L2 } = LAYOUT.arm;
    const dx = tool[0] - base.x, dy = tool[1] - base.y;
    let dd = Math.hypot(dx, dy);
    const dmax = L1 + L2 - 1, dmin = Math.abs(L1 - L2) + 20;
    const k = dd > dmax ? dmax / dd : dd < dmin ? dmin / Math.max(dd, 1) : 1;
    const tx = base.x + dx * k, ty = base.y + dy * k; dd = Math.hypot(tx - base.x, ty - base.y);
    const a = Math.atan2(ty - base.y, tx - base.x);
    const b = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd))));
    const ex = base.x + L1 * Math.cos(a + sign * b), ey = base.y + L1 * Math.sin(a + sign * b);
    return { ex, ey, tx, ty, ang: Math.atan2(ty - ey, tx - ex) };
  }
  function armSvg(base, tool, sign, fingers, dual) {
    const g = armGeom(base, tool, sign === undefined ? 1 : sign);
    const px = -Math.sin(g.ang), py = Math.cos(g.ang), open = fingers || 13;
    const fx = Math.cos(g.ang), fy = Math.sin(g.ang);
    let s = `<line class="ly-link" x1="${fmt(base.x)}" y1="${fmt(base.y)}" x2="${fmt(g.ex)}" y2="${fmt(g.ey)}"/>` +
      `<line class="ly-link2" x1="${fmt(g.ex)}" y1="${fmt(g.ey)}" x2="${fmt(g.tx - fx * 8)}" y2="${fmt(g.ty - fy * 8)}"/>` +
      `<circle class="ly-joint" cx="${fmt(base.x)}" cy="${fmt(base.y)}" r="9"/><circle class="ly-joint" cx="${fmt(g.ex)}" cy="${fmt(g.ey)}" r="7"/>`;
    const f = (side) => { const ox = g.tx + px * side * open, oy = g.ty + py * side * open; return `<line class="ly-finger" x1="${fmt(ox - fx * 12)}" y1="${fmt(oy - fy * 12)}" x2="${fmt(ox + fx * 4)}" y2="${fmt(oy + fy * 4)}"/>`; };
    s += `<line class="ly-finger" x1="${fmt(g.tx - fx * 12 + px * open)}" y1="${fmt(g.ty - fy * 12 + py * open)}" x2="${fmt(g.tx - fx * 12 - px * open)}" y2="${fmt(g.ty - fy * 12 - py * open)}"/>` + f(1) + f(-1);
    if (dual) s += `<circle class="ly-joint" cx="${fmt(g.tx - fx * 16)}" cy="${fmt(g.ty - fy * 16)}" r="5"/>`;
    return s;
  }
  function sensor(x, y, tag, o) {
    o = o || {};
    const r = 7.5;
    let s = `<g class="ly-sensor" data-sensor="${esc(tag)}">`;
    if (o.shape === 'sq') s += `<rect class="ly-sens${o.safety ? ' safety' : ''}" x="${fmt(x - r)}" y="${fmt(y - r)}" width="${2 * r}" height="${2 * r}" rx="2"/>`;
    else s += `<circle class="ly-sens${o.safety ? ' safety' : ''}" cx="${fmt(x)}" cy="${fmt(y)}" r="${r}"/>`;
    s += `<circle class="ly-led" data-led="${esc(tag)}" cx="${fmt(x)}" cy="${fmt(y)}" r="3.6"/>`;
    if (!o.noTag) {
      const [tx, ty, an] = o.tp || [x + 12, y + 4, 'start'];
      s += `<text class="ly-tag dg-halo${o.safety ? ' saf' : ''}" x="${fmt(tx)}" y="${fmt(ty)}" text-anchor="${an}">${esc(o.label || tag)}</text>`;
    }
    return s + '</g>';
  }
  function camIcon(x, y, tag) {
    return `<g class="ly-camg" data-cam="${esc(tag)}"><rect class="ly-cam" x="${x - 14}" y="${y - 9}" width="28" height="18" rx="3"/><circle cx="${x}" cy="${y}" r="5.5" fill="#ffffff"/><circle cx="${x}" cy="${y}" r="2.8" class="ly-cam"/>` +
      `<text class="ly-tag cam dg-halo" x="${x + 19}" y="${y + 4}">${esc(tag)}</text></g>`;
  }
  // Static layout. o.setup = 1 | 2 ; o.snapshot = draw example parts and arms (report figure)
  function layoutSvg(o) {
    o = o || {};
    const L = LAYOUT, st = o.setup === 2;
    const d = new Diagram(L.W, 0, st ? 'Cell layout and sensor placement: Setup 2' : 'Cell layout and sensor placement: Setup 1',
      st ? 'Added: dimensional gauge station, non-conforming (NOK) chute, dual gripper on Robot 1. Top view, not to scale.' : 'Top view, not to scale. Same arrangement as the assignment layout.', o);
    const oy = o.noTitle ? 0 : 70;
    d.h = L.H + oy;
    const P = [];
    P.push(`<g transform="translate(0 ${oy})">`);
    P.push(`<rect class="ly-fence" x="20" y="46" width="1030" height="618" rx="8"/>`);
    P.push(`<text class="ly-aisle" x="30" y="30">OPERATOR AISLE</text><text class="ly-aisle" x="1046" y="38" text-anchor="end">SAFETY FENCE</text>`);
    // CNC
    const c = L.cnc, v = L.vise, dr = L.door;
    P.push(`<rect class="ly-mach" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="6"/>`);
    P.push(`<rect class="ly-mach-in" x="${L.work.x}" y="${L.work.y}" width="${L.work.w}" height="${L.work.h}" rx="4"/>`);
    P.push(`<rect class="ly-gauge" x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" rx="3"/><rect class="ly-datum" x="${v.x}" y="${v.y}" width="8" height="${v.h}"/>`);
    P.push(`<text class="ly-label" x="${c.x + c.w / 2}" y="${c.y + 30}" text-anchor="middle">CNC</text>`);
    P.push(`<text class="ly-sub" x="${c.x + c.w / 2}" y="${c.y + 47}" text-anchor="middle">vertical machining center</text>`);
    P.push(`<text class="ly-sub" x="${c.x + c.w / 2}" y="${c.y + 66}" text-anchor="middle">door kit: ZS-31 · 32 · 33</text>`);
    P.push(`<text class="ly-sub" x="${c.x + c.w / 2}" y="${c.y + 81}" text-anchor="middle">vise: ZS-34 · 35 · PS-36</text>`);
    P.push(`<text class="ly-sub" x="${v.x + v.w + 6}" y="${v.y + v.h / 2 + 4}">vise</text>`);
    P.push(`<text class="ly-note" x="${c.x + c.w / 2}" y="${L.work.y + 16}" text-anchor="middle">work zone</text>`);
    if (st) P.push(`<text class="ly-note" x="${c.x + c.w / 2}" y="${c.y + c.h - 16}" text-anchor="middle">option: auto door M80/M81</text>`);
    P.push(`<line class="ly-track" x1="${dr.x + dr.w + 5}" y1="${dr.y0}" x2="${dr.x + dr.w + 5}" y2="${dr.y0 + dr.len + dr.travel}"/>`);
    P.push(`<g id="ly-door"><rect class="ly-door" x="${dr.x}" y="${dr.y0}" width="${dr.w}" height="${dr.len}" rx="2"/><rect class="ly-handle" x="${dr.x + dr.w}" y="${dr.y0 + dr.len - 26}" width="7" height="16" rx="2"/></g>`);
    P.push(sensor(238, dr.y0 + 8, 'ZS-32', { shape: 'sq', tp: [250, dr.y0 + 12, 'start'], label: 'ZS-32 closed' }));
    P.push(sensor(238, dr.y0 - 18, 'ZS-33', { shape: 'sq', safety: true, tp: [250, dr.y0 - 14, 'start'], label: 'ZS-33 lock' }));
    P.push(sensor(238, dr.y0 + dr.len + dr.travel - 8, 'ZS-31', { shape: 'sq', tp: [250, dr.y0 + dr.len + dr.travel - 4, 'start'], label: 'ZS-31 open' }));
    P.push(sensor(v.x + 14, v.y + v.h + 18, 'ZS-34', { shape: 'sq', noTag: true }));
    P.push(sensor(v.x + 40, v.y + v.h + 18, 'ZS-35', { shape: 'sq', noTag: true }));
    P.push(`<text class="ly-tag dg-halo" x="${v.x + 27}" y="${v.y + v.h + 43}" text-anchor="middle">ZS-34 open</text><text class="ly-tag dg-halo" x="${v.x + 27}" y="${v.y + v.h + 57}" text-anchor="middle">ZS-35 clamp</text>`);
    P.push(sensor(v.x - 16, v.y + v.h / 2, 'PS-36', { tp: [v.x - 12, v.y - 12, 'middle'], label: 'PS-36 air' }));
    // input pallet
    const pi = L.palletIn;
    P.push(`<rect class="ly-pallet" x="${pi.x}" y="${pi.y}" width="${pi.w}" height="${pi.h}" rx="4"/>`);
    for (let i = 0; i < 12; i++) { const [x, y] = slotPos('in', i); P.push(`<rect class="ly-slot" x="${x - 13}" y="${y - 13}" width="26" height="26" rx="2"/>`); }
    P.push(`<text class="ly-label" x="${pi.x + pi.w + 14}" y="${pi.y + 20}">INPUT PALLET</text><text class="ly-sub" x="${pi.x + pi.w + 14}" y="${pi.y + 36}">12 raw parts (3 × 4)</text><text class="ly-sub" x="${pi.x + pi.w + 14}" y="${pi.y + 51}">loaded from the aisle</text>`);
    P.push(sensor(pi.x - 14, pi.y + pi.h / 2, 'PX-11', { tp: [pi.x - 26, pi.y + pi.h / 2 + 4, 'end'] }));
    P.push(`<path class="ly-scan" d="M${pi.x + 25} 46 A50 50 0 0 1 ${pi.x + 125} 46 Z"/><text class="ly-tag dg-halo saf" x="${pi.x + 132}" y="34">SC-01</text>`);
    // output pallet
    const po = L.palletOut;
    P.push(`<rect class="ly-pallet" x="${po.x}" y="${po.y}" width="${po.w}" height="${po.h}" rx="4"/>`);
    for (let i = 0; i < 12; i++) { const [x, y] = slotPos('out', i); P.push(`<rect class="ly-slot" x="${x - 13}" y="${y - 13}" width="26" height="26" rx="2"/>`); }
    P.push(`<text class="ly-label" x="${po.x + po.w / 2}" y="${po.y - 22}" text-anchor="middle">OUTPUT PALLET</text><text class="ly-sub" x="${po.x + po.w / 2}" y="${po.y - 8}" text-anchor="middle">12 finished parts</text>`);
    P.push(sensor(po.x - 14, po.y + po.h - 14, 'PX-52', { tp: [po.x - 26, po.y + po.h - 10, 'end'] }));
    P.push(`<path class="ly-scan" d="M1050 ${po.y + 25} A50 50 0 0 1 1050 ${po.y + 125} Z"/><text class="ly-tag dg-halo saf" x="1056" y="${po.y + 142}">SC-02</text>`);
    const [bx, by] = L.beacon;
    P.push(`<g id="ly-beacon"><circle class="ly-lamp-b ly-lamp-off" data-lamp="blue" cx="${bx}" cy="${by}" r="9"/><circle cx="${bx}" cy="${by}" r="9" fill="none" stroke="#1565c0" stroke-width="1.2"/></g><text class="ly-tag dg-halo" x="${bx}" y="${by - 15}" text-anchor="middle">LT-53</text>`);
    // conveyor
    const cv = L.conv;
    P.push(`<rect class="ly-frame" x="${cv.x - 4}" y="${cv.y - 7}" width="${cv.w + 8}" height="${cv.h + 14}" rx="4"/>`);
    P.push(`<rect class="ly-belt" x="${cv.x}" y="${cv.y}" width="${cv.w}" height="${cv.h}" rx="2"/>`);
    P.push(`<clipPath id="ly-beltclip"><rect x="${cv.x}" y="${cv.y}" width="${cv.w}" height="${cv.h}"/></clipPath><g clip-path="url(#ly-beltclip)"><g id="ly-beltlines">`);
    for (let x = cv.x - 12; x < cv.x + cv.w; x += 24) P.push(`<line class="ly-roller" x1="${x}" y1="${cv.y + 2}" x2="${x}" y2="${cv.y + cv.h - 2}"/>`);
    P.push(`</g></g>`);
    P.push(`<path class="ly-flow" d="M${cv.x + 200} ${cv.y + cv.h / 2} h80 m-11 -7 l11 7 l-11 7"/>`);
    P.push(`<rect class="ly-stop" x="${cv.x + cv.w - 6}" y="${cv.y + 4}" width="6" height="${cv.h - 8}" rx="1"/>`);
    if (!o.sim) P.push(`<text class="ly-label" x="682" y="${cv.y + cv.h + 44}" text-anchor="middle">CONVEYOR</text><text class="ly-sub" x="682" y="${cv.y + cv.h + 59}" text-anchor="middle">2 m at 0.25 m/s</text>`);
    const tb = (x, tag) => {
      P.push(`<rect class="ly-sens" x="${x - 5}" y="${cv.y - 18}" width="10" height="10" rx="2"/><rect class="ly-sens" x="${x - 5}" y="${cv.y + cv.h + 8}" width="10" height="10" rx="2"/>`);
      P.push(`<line class="ly-beam" x1="${x}" y1="${cv.y - 8}" x2="${x}" y2="${cv.y + cv.h + 8}"/>`);
      P.push(`<g class="ly-sensor" data-sensor="${tag}"><circle class="ly-led" data-led="${tag}" cx="${x}" cy="${cv.y + cv.h + 13}" r="3.2"/><text class="ly-tag dg-halo" x="${x}" y="${cv.y - 24}" text-anchor="middle">${tag}</text></g>`);
    };
    tb(L.pe41, 'PE-41'); tb(L.pe42, 'PE-42');
    const [ex, ey] = L.enc;
    P.push(`<g class="ly-sensor" data-sensor="ENC-43"><circle class="ly-sens" cx="${ex}" cy="${ey}" r="9"/><line x1="${ex}" y1="${ey - 9}" x2="${ex}" y2="${ey - 3}" stroke="#0b5aa6" stroke-width="1.6"/><circle class="ly-led" data-led="ENC-43" cx="${ex}" cy="${ey + 1}" r="3.4"/><text class="ly-tag dg-halo" x="${ex + 14}" y="${ey + 5}">ENC-43</text></g>`);
    const roi = (x, y, w, h, t, lx, ly, cls) => P.push(`<rect class="ly-roi" data-roi="${t}" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/><text class="ly-roi-t${cls ? ' ' + cls : ' dg-halo'}" x="${lx}" y="${ly}">${t}</text>`);
    roi(pi.x - 6, pi.y - 6, pi.w + 12, pi.h + 12, 'ROI-A', pi.x - 6, pi.y + pi.h + 19);
    roi(446, cv.y - 3, 62, cv.h + 6, 'ROI-B', 450, cv.y + cv.h - 6, 'on-belt');
    roi(796, cv.y - 3, 56, cv.h + 6, 'ROI-C', 800, cv.y + cv.h - 6, 'on-belt');
    roi(po.x - 6, po.y - 6, po.w + 12, po.h + 12, 'ROI-D', po.x + po.w - 30, po.y + po.h + 19);
    // robots
    if (!o.sim) [[L.r1, 'ROBOT 1', st ? 'UR10e · dual gripper A/B' : 'UR10e'], [L.r2, 'ROBOT 2', 'UR10e']].forEach(([r, n, sub]) => {
      P.push(`<text class="ly-sub" x="${r.x}" y="${n === 'ROBOT 1' ? r.y - r.r - 9 : r.y + r.r + 16}" text-anchor="middle">${sub}</text>`);
    });
    // Setup 2 stations
    if (st) {
      const g = L.gauge, [nx, ny] = L.nest;
      P.push(`<rect class="ly-gauge" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="5"/>`);
      P.push(`<rect class="ly-datum" x="${nx - 18}" y="${ny - 18}" width="7" height="44"/><rect class="ly-datum" x="${nx - 18}" y="${ny - 18}" width="44" height="7"/>`);
      P.push(`<polygon class="ly-laser" points="${nx + 56},${ny - 6} ${nx + 56},${ny + 6} ${nx + 44},${ny}"/><line class="ly-beam" x1="${nx + 44}" y1="${ny}" x2="${nx + 12}" y2="${ny}"/>`);
      P.push(`<polygon class="ly-laser" points="${nx - 6},${ny + 44} ${nx + 6},${ny + 44} ${nx},${ny + 32}"/><line class="ly-beam" x1="${nx}" y1="${ny + 32}" x2="${nx}" y2="${ny + 12}"/>`);
      P.push(`<circle class="ly-laser" cx="${g.x + g.w - 22}" cy="${g.y + 18}" r="7"/><circle cx="${g.x + g.w - 22}" cy="${g.y + 18}" r="2.6" fill="#fff"/>`);
      P.push(`<text class="ly-tag dg-halo" x="${nx + 60}" y="${ny + 4}">LS-61 X</text><text class="ly-tag dg-halo" x="${nx + 12}" y="${ny + 42}">LS-62 Y</text><text class="ly-tag dg-halo" x="${g.x + g.w - 34}" y="${g.y + 22}" text-anchor="end">LS-63 Z (top)</text>`);
      P.push(sensor(g.x + 18, g.y + g.h - 14, 'PX-64', { tp: [g.x + 30, g.y + g.h - 10, 'start'] }));
      P.push(`<text class="ly-label" x="${g.x + g.w / 2}" y="${g.y - 10}" text-anchor="middle">GAUGE STATION</text>`);
      roi(g.x - 4, g.y - 4, g.w + 8, g.h + 8, 'ROI-E', g.x - 4, g.y + g.h + 19);
      const n = L.nok;
      P.push(`<rect class="ly-nok" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5"/>`);
      for (let k = -n.h; k < n.w; k += 14) {
        const x1 = n.x + Math.max(0, k), y1 = n.y + Math.max(0, -k);
        const len = Math.min(n.w - Math.max(0, k), n.h - Math.max(0, -k));
        P.push(`<line class="ly-nok-h" x1="${x1}" y1="${y1}" x2="${x1 + len}" y2="${y1 + len}"/>`);
      }
      P.push(`<text class="ly-label" x="${n.x + n.w / 2}" y="${n.y - 24}" text-anchor="middle">NOK CHUTE</text><text class="ly-sub" x="${n.x + n.w / 2}" y="${n.y - 9}" text-anchor="middle">locked bin · QA hold</text>`);
      P.push(`<rect class="ly-sens" x="${n.x + 6}" y="${n.y + 8}" width="10" height="10" rx="2"/><rect class="ly-sens" x="${n.x + n.w - 16}" y="${n.y + 8}" width="10" height="10" rx="2"/><line class="ly-beam" x1="${n.x + 16}" y1="${n.y + 13}" x2="${n.x + n.w - 16}" y2="${n.y + 13}"/>`);
      P.push(`<g class="ly-sensor" data-sensor="PE-65"><circle class="ly-led" data-led="PE-65" cx="${n.x + n.w - 11}" cy="${n.y + 13}" r="3"/><text class="ly-tag dg-halo" x="${n.x + n.w / 2}" y="${n.y + n.h + 18}" text-anchor="middle">PE-65 drop check</text></g>`);
    }
    // cabinet, stack light
    const cb = L.cab;
    P.push(`<rect class="ly-cab" x="${cb.x}" y="${cb.y}" width="${cb.w}" height="${cb.h}" rx="4"/><text class="ly-label" x="${cb.x + 12}" y="${cb.y + 20}">CELL CABINET</text><text class="ly-sub" x="${cb.x + 12}" y="${cb.y + 35}">PLC-01 · HMI-01 · safety relay</text><text class="ly-sub" x="${cb.x + 12}" y="${cb.y + 49}">camera / proximity cross-check</text>`);
    const [sx, sy] = L.stack;
    P.push(`<g id="ly-stack"><rect x="${sx - 9}" y="${sy}" width="18" height="52" rx="3" fill="#39424b"/><circle class="ly-lamp-r ly-lamp-off" data-lamp="red" cx="${sx}" cy="${sy + 10}" r="6"/><circle class="ly-lamp-a ly-lamp-off" data-lamp="amber" cx="${sx}" cy="${sy + 26}" r="6"/><circle class="ly-lamp-g" data-lamp="green" cx="${sx}" cy="${sy + 42}" r="6"/></g><text class="ly-tag dg-halo" x="${sx + 16}" y="${sy + 30}">LT-01</text>`);
    // camera fields of view
    const f1 = L.fov1, f2 = L.fov2[st ? 2 : 1];
    P.push(`<rect class="ly-fov" data-fov="CAM-1" x="${f1.x}" y="${f1.y}" width="${f1.w}" height="${f1.h}" rx="10"/>`);
    P.push(`<rect class="ly-fov" data-fov="CAM-2" x="${f2.x}" y="${f2.y}" width="${f2.w}" height="${f2.h}" rx="10"/>`);
    P.push(camIcon(488, 262, 'CAM-1'));
    P.push(st ? camIcon(598, 290, 'CAM-2') : camIcon(768, 286, 'CAM-2'));
    // snapshot content for the report figures
    if (o.snapshot) {
      for (let i = 3; i < 12; i++) { const [x, y] = slotPos('in', i); P.push(partSvg(x, y, '')); }
      P.push(partSvg(L.fixture[0], L.fixture[1], 'fin'));
      for (let i = 0; i < 7; i++) { const [x, y] = slotPos('out', i); P.push(partSvg(x, y, 'fin')); }
      P.push(partSvg(640, 372, 'fin'));
      if (st) P.push(partSvg(L.nest[0], L.nest[1], 'fin'));
    }
    // robots on top
    if (!o.sim) [[L.r1, 'ROBOT 1'], [L.r2, 'ROBOT 2']].forEach(([r, n], i) => {
      if (o.snapshot) P.push(armSvg(r, r.home, i ? L.elbow.r2 : L.elbow.r1, 13, st && !i));
      P.push(`<circle class="ly-robot" cx="${r.x}" cy="${r.y}" r="${r.r}"/><text class="ly-robot-t" x="${r.x}" y="${r.y + 4}" text-anchor="middle">${n}</text>`);
    });
    // legend
    const ly = 690;
    let lx = 30;
    [['prox', 'IR proximity sensor'], ['tb', 'IR through-beam'], ['sq', 'door / vise sensor (kit)'], ['saf', 'safety interlock'],
      ['cam', 'camera + FOV'], ['laser', 'laser displacement'], ['scan', 'safety scanner']].forEach(([k, t]) => {
      let sym = '', sw = 16;
      if (k === 'prox') sym = `<circle class="ly-sens" cx="${lx + 7}" cy="${ly}" r="7"/><circle class="ly-led on" cx="${lx + 7}" cy="${ly}" r="3.2"/>`;
      if (k === 'tb') { sym = `<rect class="ly-sens" x="${lx}" y="${ly - 5}" width="9" height="9" rx="1"/><line class="ly-beam" x1="${lx + 9}" y1="${ly - 0.5}" x2="${lx + 23}" y2="${ly - 0.5}"/><rect class="ly-sens" x="${lx + 23}" y="${ly - 5}" width="9" height="9" rx="1"/>`; sw = 32; }
      if (k === 'sq') sym = `<rect class="ly-sens" x="${lx}" y="${ly - 7}" width="14" height="14" rx="2"/>`;
      if (k === 'saf') sym = `<rect class="ly-sens safety" x="${lx}" y="${ly - 7}" width="14" height="14" rx="2"/>`;
      if (k === 'cam') { sym = `<rect class="ly-cam" x="${lx}" y="${ly - 8}" width="24" height="16" rx="3"/><circle cx="${lx + 12}" cy="${ly}" r="4.5" fill="#fff"/>`; sw = 24; }
      if (k === 'laser') sym = `<polygon class="ly-laser" points="${lx},${ly - 7} ${lx},${ly + 7} ${lx + 13},${ly}"/>`;
      if (k === 'scan') { sym = `<path class="ly-scan" d="M${lx} ${ly + 7} A12 12 0 0 1 ${lx + 24} ${ly + 7} Z"/>`; sw = 24; }
      P.push(sym + `<text class="ly-legend" x="${lx + sw + 6}" y="${ly + 4.5}">${esc(t)}</text>`);
      lx += sw + 26 + t.length * 5.9;
    });
    P.push(`<g id="ly-dyn"></g></g>`);
    d.raw(P.join(''));
    return d.svg();
  }

  const API = {
    CSS, LAYOUT, slotPos, partSvg, armSvg, armGeom,
    smRobot1S1, smRobot1S2, smConveyor, smRobot2S1, smRobot2S2, smSupervisor,
    flowCrossCheck, archDiagram, flowSetup1, flowSetup2, timingChart, layoutSvg,
  };
  root.CellDiagrams = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
