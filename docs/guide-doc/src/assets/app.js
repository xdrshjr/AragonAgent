/* app.js — spec §7.6/§7.7/§9.1/§9.2；单文档委托，无依赖，只建节点不拼 HTML。 */
(() => {
  const d = document, h = d.documentElement, MAX = 12, N = 'search-hit';
  const Q = '[data-search-input]', R = '[data-search-results]', C = '[data-search-count]';
  const HINT = '搜索需要 http(s) 环境；本地请用 node docs/guide-doc/serve.mjs';
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, SEP = /[^\p{L}\p{N}_-]+/u;
  const TABS = 'a[href], button:not([disabled]), input:not([disabled])';
  const $ = (s) => d.querySelector(s), $$ = (s) => Array.from(d.querySelectorAll(s));
  const L = (v) => String(v == null ? '' : v).toLowerCase();
  const E = (t, c, x) => {
    const n = d.createElement(t);
    if (c) n.className = c;
    if (x) n.textContent = x;
    return n;
  };
  const U = () => {
    const p = location.pathname.split('/').filter(Boolean);
    return '../'.repeat(p.length && p[p.length - 1].includes('.') ? p.length - 1 : p.length);
  };
  const theme = () => {
    const n = h.dataset.theme === 'light' ? 'dark' : 'light';
    h.dataset.theme = n;
    try { localStorage.setItem('aragon-docs:theme', n); } catch (e) { /* file:// */ }
  };
  let back = null, open = false, from = null, busy = null, active = -1, timer = 0, toc = [];
  let armed = false, armedAt = 0;
  const nav = () => d.getElementById('site-nav');
  const isOpen = () => !!nav() && nav().classList.contains('is-open');
  const G = (on, src) => {
    const bar = nav(), sc = $('.nav-scrim');
    if (!bar) return;
    bar.classList.toggle('is-open', on);
    if (sc) sc.hidden = !on;
    $$('[data-nav-toggle]').forEach((b) => b.setAttribute('aria-expanded', String(on)));
    if (!on) { if (back && back.focus) back.focus(); back = null; return; }
    back = src || d.activeElement;
    const f1 = bar.querySelector(TABS);
    if (f1) f1.focus();
  };
  const F = (ev, bx) => {
    const it = bx ? Array.from(bx.querySelectorAll(TABS)) : [], last = it.length - 1;
    if (last < 0) return;
    const at = it.indexOf(d.activeElement);
    if (at > -1 && at !== (ev.shiftKey ? 0 : last)) return;
    ev.preventDefault();
    it[ev.shiftKey ? last : 0].focus();
  };
  const M = (tx, k) => (tx.includes(k) ? 1 : CJK.test(k[0]) ? 0
    : tx.split(SEP).some((w) => w.startsWith(k)) ? 0.7 : 0);
  // 与 src/render/search.mjs 同构：8*title+4*heading+3*keywords+1*section*coverage+0.5*desc。
  const search = (ix, q) => {
    const rw = [], fd = [], ot = [], ks = [];
    for (const w of L(q).trim().split(SEP).filter(Boolean)) {
      if (CJK.test(w[0])) for (let i = 0; i < w.length - 1; i += 1) rw.push(w.slice(i, i + 2));
      rw.push(w);
    }
    for (const w of rw) if (!ks.includes(w)) ks.push(w);
    const all = ks.length;
    if (!all || !ix || !Array.isArray(ix.pages)) return { ks, ot };
    ix.pages.forEach((pg, order) => {
      const ttl = L(pg.t), kws = L((pg.k || []).join(' ')), dsc = L(pg.d || '');
      let tS = 0, kS = 0, dS = 0;
      for (const k of ks) { tS += M(ttl, k); kS += M(kws, k); dS += M(dsc, k); }
      (pg.s || []).forEach((sn, at) => {
        const hd = L(sn.h), bd = L(sn.x);
        let hS = 0, bS = 0, met = 0;
        for (const k of ks) {
          const x = M(hd, k), y = M(bd, k);
          hS += x;
          bS += y;
          if (x || y) met += 1;
        }
        // 本节没命中时，只有「页面级命中 + 这是第一节」才保留（否则关键词命中的页面会消失）。
        if (!met && (at !== 0 || !(tS || kS || dS))) return;
        const cov = met / all;
        fd.push({ pg, sn, at, order, score: 8 * tS + 4 * hS + 3 * kS + bS * cov + dS * 0.5 +
          (met === all ? 2 : 0) });
      });
    });
    fd.sort((a, b) => b.score - a.score || a.order - b.order || a.at - b.at);
    const sn = {};
    for (const f of fd) {
      const us = sn[f.pg.u] || 0;
      if (us < 2) { sn[f.pg.u] = us + 1; ot.push(f); }
      if (ot.length === MAX) break;
    }
    return { ks, ot };
  };
  const W = (bx, tx, ks) => {
    const pat = '(' + ks.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    String(tx == null ? '' : tx).split(new RegExp(pat, 'i')).forEach((part, i) => {
      if (part) bx.appendChild(i % 2 ? E('mark', null, part) : d.createTextNode(part));
    });
  };
  // 索引的 u 是站根绝对路径，缺 --base 前缀；U() 回站根、BS 进前缀，站内链接仍全相对。
  const BS = (h.dataset.base || '/').replace(/^\/+|\/+$/g, '');
  const LK = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u
    : U() + (u.startsWith('/') ? (BS ? BS + '/' : '') + u.slice(1) : u));
  const K = (hit, at, ks) => {
    const li = E('li', N), a = li.appendChild(E('a', N + '-link')), sn = hit.sn, u = hit.pg.u;
    li.id = N + '-' + at;
    li.setAttribute('role', 'option');
    a.setAttribute('href', LK(u) + (sn.a ? '#' + sn.a : ''));
    a.dataset.u = u, a.dataset.t = hit.pg.t;
    W(a.appendChild(E('span', N + '-title')), hit.pg.t, ks);
    if (sn.h !== hit.pg.t) W(a.appendChild(E('span', N + '-section')), sn.h, ks);
    return li;
  };
  const A = (nx) => {
    const it = $$('.' + N), n = it.length;
    if (!n) return;
    active = ((nx % n) + n) % n;
    it.forEach((li, i) => li.classList.toggle('is-active', i === active));
    $(Q).setAttribute('aria-activedescendant', it[active].id);
  };
  const V = (it, ks, label) => {
    const bx = $(R), sd = $(C);
    active = -1;
    if (bx) {
      bx.textContent = '';
      it.forEach((hit, at) => bx.appendChild(K(hit, at, ks)));
    }
    if (sd) sd.textContent = label;
    if (it.length) A(0);
    else if ($(Q)) $(Q).removeAttribute('aria-activedescendant');
  };
  const D = () => (busy = busy || fetch(U() + 'search-index.json', { cache: 'no-cache' })
    .then((res) => res.json(), () => null)
    .then((ix) => (ix && Array.isArray(ix.pages) ? ix : null), () => null));
  // 最近访问只写本机 sessionStorage，不上报（§7.7）；file:// 与隐私模式下读不到就退化。
  const REC = 'aragon-docs:recent';
  const recent = () => {
    try { const a = JSON.parse(sessionStorage.getItem(REC) || '[]');
      return Array.isArray(a) ? a.filter((x) => x && x.u && x.t).slice(0, 6) : []; } catch (e) { return []; }
  };
  const remember = (hit) => {
    try { sessionStorage.setItem(REC, JSON.stringify(
      [{ u: hit.pg.u, t: hit.pg.t }].concat(recent().filter((x) => x.u !== hit.pg.u)).slice(0, 6)));
    } catch (e) { /* 不可写就退化 */ }
  };
  const X = () => {
    const fld = $(Q), q = fld ? fld.value : '', tx = String(q).trim();
    if (!tx) { const rs = recent().map((r) => ({ pg: r, sn: { h: r.t, a: '' }, at: 0, order: 0 }));
      return V(rs, [], rs.length ? '最近访问' : '输入关键词，或按 / 聚焦搜索'); }
    if (!CJK.test(tx) && tx.replace(SEP, '').length < 2) return V([], [], '输入至少 2 个字符');
    if (!window.fetch) return V([], [], HINT);
    return D().then((ix) => {
      if (!open) return undefined;
      if (!ix) return V([], [], HINT);
      const fd = search(ix, q);
      return V(fd.ot, fd.ks, '找到 ' + fd.ot.length + ' 条');
    });
  };
  const Y = (btn) => {
    const bx = d.getElementById('search'), pre = from, fld = $(Q);
    if (!bx) return;
    open = !open;
    bx.hidden = !open;
    from = open ? btn || d.activeElement : null;
    if (!open) {
      if (pre && pre.focus) pre.focus();
      return;
    }
    if (fld) fld.value = '';
    X();
    if (fld) fld.focus();
    D();
  };
  const copy = (btn) => {
    let pre = null;
    try { pre = d.querySelector(btn.getAttribute('data-copy')); } catch (e) { pre = null; }
    if (!pre) return;
    const lb = btn.querySelector('.copy-label'), was = lb && lb.textContent;
    const pick = () => {
      const sel = getSelection(), range = d.createRange();
      range.selectNodeContents(pre);
      sel.removeAllRanges();
      sel.addRange(range);
      pre.focus();
    };
    if (!navigator.clipboard) return pick();
    return navigator.clipboard.writeText(pre.textContent || '').then(() => {
      if (!lb) return;
      lb.textContent = '已复制';
      setTimeout(() => { lb.textContent = was; }, 1200);
    }, pick);
  };
  const O = () => {
    toc = $$('[data-toc] [data-toc-link]');
    if (!toc.length || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((list) => {
      const lv = list.filter((e) => e.isIntersecting);
      if (!lv.length) return;
      const tp = lv.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
      const id = '#' + tp.target.id;
      toc.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === id));
    }, { rootMargin: '-72px 0px -68% 0px' });
    for (const a of toc) {
      const hd = d.getElementById(String(a.getAttribute('href') || '').slice(1));
      if (hd) io.observe(hd);
    }
  };
  const P = () => {
    const tp = window.scrollY || h.scrollTop || 0, bar = $('.toc-progress');
    if (bar) {
      const rm = h.scrollHeight - window.innerHeight;
      const pct = rm > 0 ? Math.min(100, Math.round((tp / rm) * 100)) : 0;
      (bar.firstElementChild || bar).style.width = pct + '%';
    }
    const up = $('[data-top]');
    if (up) up.classList.toggle('is-visible', tp > 600);
  };
  const B = (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const at = (s) => t.closest(s), navBtn = at('[data-nav-toggle]'), opener = at('[data-search-open]');
    const lk = at('.' + N + '-link');
    if (lk && lk.dataset.u) remember({ pg: { u: lk.dataset.u, t: lk.dataset.t } });
    if (at('[data-theme-toggle]')) theme();
    else if (navBtn) G(true, navBtn);
    else if (at('[data-nav-close]') || at('.nav-scrim')) G(false);
    else if (opener) Y(opener);
    else if (at('[data-search-close]')) Y();
    else if (at('[data-copy]')) copy(at('[data-copy]'));
    else if (at('[data-top]')) window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const J = (ev) => {
    const k = L(ev.key), t = ev.target, meta = ev.ctrlKey || ev.metaKey;
    const ty = !!t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);
    const bx = open ? d.getElementById('search') : isOpen() ? nav() : null;
    if (k === 'tab' && bx) return F(ev, bx);
    if (k === 'escape' && bx) {
      ev.preventDefault();
      return open ? Y() : G(false);
    }
    if (ty) {
      if (!open || !/^(enter|arrowup|arrowdown)$/.test(k)) return undefined;
      ev.preventDefault();
      if (k !== 'enter') return A(active + (k === 'arrowdown' ? 1 : -1));
      const a = $(R).querySelectorAll('.' + N + '-link')[active > -1 ? active : 0];
      return a && location.assign(a.getAttribute('href'));
    }
    if (k === '/' || (meta && k === 'k')) { ev.preventDefault(); return Y(null); }
    if (k === '[' || k === ']') {
      const pz = $(k === '[' ? '.pager-prev' : '.pager-next');
      return pz && pz.click();
    }
    if (meta || ev.altKey) return undefined;
    if (k === 't') return theme();
    if (k === 'g') {
      armed = true;
      clearTimeout(armedAt);
      armedAt = setTimeout(() => { armed = false; }, 1000);
    }
    if (k === 'h' && armed) location.assign(U());
    return undefined;
  };
  const I = (ev) => {
    if (!ev.target.matches(Q)) return;
    clearTimeout(timer);
    timer = setTimeout(X, 90);
  };
  d.addEventListener('click', B);
  d.addEventListener('keydown', J);
  d.addEventListener('input', I);
  d.addEventListener('scroll', P, { passive: true });
  const Z = () => { O(); P(); };
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', Z);
  else Z();
})();
