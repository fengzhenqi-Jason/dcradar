/* DC Radar 客户投资组合引擎（纯JS）
 * 参照成熟站点（datacentermap / globaldcwiki / datacenter-atlas / cloudscene）的客户页 IA 重建：
 *   组合摘要(交付/在建/规划 + 披露覆盖) → 按市场 → 按阶段 → 站点总表 → 最大站点
 *   → 近期变更 → 数据缺口 → 客户地图 → 相关新闻
 * 关键口径：容量来自"容量观测"（含 scope/qualifier/as_of/source），不是站点的单一字段。
 */
(function () {
  const SITES = (window.DCR_RELEASE && window.DCR_RELEASE.sites) || [];
  const CAPS = (window.DCR_RELEASE && window.DCR_RELEASE.capacities) || {};
  const EVENTS = (window.DCR_RELEASE && window.DCR_RELEASE.events) || [];
  const MILES = (window.DCR_RELEASE && window.DCR_RELEASE.milestones) || [];

  const STAGE = {
    operating: { zh: '已交付', color: '#0c9b72' },
    under_construction: { zh: '在建', color: '#e88b18' },
    planned: { zh: '规划/已宣布', color: '#7652c8' },
    on_hold: { zh: '暂停', color: '#8a93a0' },
    cancelled: { zh: '已取消', color: '#b04747' },
    unknown: { zh: '状态待核实', color: '#8794a1' }
  };
  // 观测 → 口径归类
  // 五类口径，互不相加
  const Q_LIVE = ['initial_operating', 'current'];                 // 已确认投运
  const Q_PLANNED = ['planned_total', 'up_to', 'exceeding'];       // 该站规划/远期容量
  const Q_DESIGN = ['maximum'];                                   // 设计上限（口径不同于实际投运）
  const Q_PHASE = ['initial_phase', 'planned', 'initial'];         // 分期/单栋
  const SITE_SCOPES = ['full_build', 'campus_full_build', 'planned_total', 'design_capacity', 'site_current'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

  function siteObservations(site) {
    const raw = (CAPS[site.id] || []).slice();
    const out = { live: null, planned: null, design: null, phases: [], excluded: [] };
    for (const o of raw) {
      const v = num(o.v);
      if (v === null) { out.excluded.push(Object.assign({}, o, { why: '无数值' })); continue; }
      if (o.t === 'grid_connection_request') { out.excluded.push(Object.assign({}, o, { why: '电网接入申请，非IT容量' })); continue; }
      if (Q_LIVE.indexOf(o.q) >= 0) { if (!out.live) out.live = o; continue; }
      if (Q_PLANNED.indexOf(o.q) >= 0 && SITE_SCOPES.indexOf(o.sc) >= 0) {
        if (!out.planned || o.best) out.planned = o; continue;
      }
      if (Q_DESIGN.indexOf(o.q) >= 0) { if (!out.design) out.design = o; continue; }
      if (Q_PHASE.indexOf(o.q) >= 0) { out.phases.push(o); continue; }
      out.excluded.push(Object.assign({}, o, { why: '口径不归入站点合计' }));
    }
    return out;
  }

  function buildPortfolio(operator) {
    const sites = SITES.filter(s => s.op === operator);
    const rows = sites.map(s => {
      const obs = siteObservations(s);
      const stage = STAGE[s.status] ? s.status : 'unknown';
      const live = obs.live ? num(obs.live.v) : null;
      const planned = obs.planned ? num(obs.planned.v) : null;
      const design = obs.design ? num(obs.design.v) : null;
      const phaseMW = obs.phases.reduce((a, o) => a + (num(o.v) || 0), 0);
      return {
        site: s, stage: stage, live: live, planned: planned, design: design, phaseMW: phaseMW,
        phases: obs.phases, excluded: obs.excluded,
        disclosed: live !== null || planned !== null || design !== null || phaseMW > 0
      };
    });
    const stageAgg = ['operating', 'under_construction', 'planned', 'unknown'].map(k => {
      const rs = rows.filter(r => r.stage === k);
      const liveSum = rs.reduce((a, r) => a + (r.live || 0), 0);
      const planSum = rs.reduce((a, r) => a + (r.planned || 0), 0);
      const designSum = rs.reduce((a, r) => a + (r.design || 0), 0);
      const disclosedN = rs.filter(r => r.disclosed).length;
      const primary = (k === 'operating') ? liveSum : (k === 'planned' ? planSum : 0);
      return { stage: k, zh: STAGE[k].zh, color: STAGE[k].color, sites: rs.length,
               sitesWithMW: disclosedN, liveMW: liveSum, plannedMW: planSum, designMW: designSum,
               primary: primary, primaryLabel: (k === 'operating' ? '已确认投运' : (k === 'planned' ? '已披露规划' : (k === 'unknown' ? '状态待核实' : '在建'))),
               secondary: designSum > 0 ? ('另有设计上限 ' + designSum + ' MW') : '' };
    });
    const markets = {};
    rows.forEach(r => {
      const k = r.site.country || '未标注';
      if (!markets[k]) markets[k] = { market: k, sites: 0, liveMW: 0, plannedMW: 0, disclosed: 0 };
      markets[k].sites++; markets[k].liveMW += r.live || 0; markets[k].plannedMW += r.planned || 0;
      markets[k].designMW = (markets[k].designMW || 0) + (r.design || 0);
      if (r.disclosed) markets[k].disclosed++;
    });
    const marketRows = Object.keys(markets).map(k => markets[k]).sort((a, b) => b.sites - a.sites || b.liveMW - a.liveMW);
    const largest = rows.filter(r => r.live !== null || r.planned !== null)
      .map(r => ({ name: r.site.name, country: r.site.country, live: r.live, planned: r.planned, stage: r.stage }))
      .sort((a, b) => (b.live || b.planned || 0) - (a.live || a.planned || 0)).slice(0, 6);
    const ids = new Set(sites.map(s => s.id));
    const changes = MILES.filter(m => ids.has(m.site_id)).map(m => ({ date: m.date, text: m.note, site: (SITES.find(s => s.id === m.site_id) || {}).name, type: m.event_type }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const news = EVENTS.filter(e => String(e.site_ids || '').split(';').some(x => ids.has(x)))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const gaps = {
      noCapacity: rows.filter(r => !r.disclosed),
      stale: rows.filter(r => r.site.vstatus === 'stale' || r.site.vstatus === 'conflict'),
      single: rows.filter(r => r.site.vstatus === 'single_source')
    };
    const totalMW = stageAgg.reduce((a, x) => a + x.liveMW + x.plannedMW, 0);
    return {
      operator: operator, rows: rows, stageAgg: stageAgg, marketRows: marketRows, largest: largest,
      changes: changes, news: news, gaps: gaps, sites: sites.length,
      countries: new Set(sites.map(s => s.country).filter(Boolean)).size,
      disclosed: rows.filter(r => r.disclosed).length,
      liveMW: stageAgg[0].liveMW, plannedMW: stageAgg[2].plannedMW, totalMW: totalMW
    };
  }

  function miniMap(p) {
    const pts = p.rows.filter(r => r.site.lat && r.site.lon).map(r => {
      const x = (parseFloat(r.site.lon) + 180) * 1000 / 360, y = (90 - parseFloat(r.site.lat)) * 500 / 180;
      return { x: x, y: y, c: STAGE[r.stage].color, n: r.site.name };
    });
    const paths = window.DCR_PATHS || [];
    const body = paths.map(d => '<path d="' + d + '" class="country"/>').join('');
    const dots = pts.map(q => '<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="3.2" fill="' + q.c + '" stroke="#fff" stroke-width="1.2"><title>' + esc(q.n) + '</title></circle>').join('');
    return '<div class="mini-map"><svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet">' + body + dots + '</svg></div>';
  }

  function render(el, operator) {
    const p = buildPortfolio(operator);
    const pct = p.sites ? Math.round(p.disclosed * 100 / p.sites) : 0;
    let h = '';
    // 客户选择
    const ops = operators();
    h += '<div class="cust-picker">' + ops.map(o => '<button class="chip' + (o === operator ? ' on' : '') + '" data-op="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
    // 组合摘要
    h += '<div class="port-head"><div><div class="eyebrow-dark">PORTFOLIO</div><h2>' + esc(operator) + '</h2>' +
      '<p>' + p.sites + ' 个公开命名站点 · ' + p.countries + ' 个国家/市场 · 容量披露覆盖 ' + p.disclosed + '/' + p.sites + '（' + pct + '%）</p></div>' +
      '<div class="stage-cards">' + p.stageAgg.map(s =>
        '<div class="stage-card" style="--c:' + s.color + '"><b>' + (s.primary ? s.primary : 0) + '</b><span>MW · ' + s.zh + '</span><em>' + s.sitesWithMW + '/' + s.sites + ' 站披露</em>' +
        (s.secondary ? '<em style="color:#c7a86a">' + s.secondary + '</em>' : '') + '</div>').join('') +
      '</div></div>';
    // 覆盖提示
    h += '<div class="notice"><i>ⓘ</i><span><b>口径：</b>已交付=operating站点的当前投运IT容量；在建/规划=该阶段站点已披露的IT容量。' +
      '不同scope（园区总量/分期/电网申请）不互相相加，未披露容量单独计数，不计为0。</span></div>';
    // 按市场
    h += '<div class="section-head"><h2>按市场</h2><small>市场 | 站点数 | 已交付MW | 在建+规划MW | 披露覆盖</small></div>';
    h += '<div class="tbl"><div class="tr th"><span>市场</span><span>站点</span><span>已投运</span><span>已披露规划</span><span>披露</span></div>' +
      p.marketRows.map(m => '<div class="tr"><span>' + esc(m.market) + '</span><span>' + m.sites + '</span><span>' +
        (m.liveMW ? m.liveMW + ' MW' : '—') + '</span><span>' + (m.plannedMW ? m.plannedMW + ' MW' : '—') + '</span><span>' + m.disclosed + '/' + m.sites + '</span></div>').join('') + '</div>';
    // 按阶段
    h += '<div class="section-head"><h2>按阶段</h2><small>阶段 | 站点数 | 已披露容量</small></div>';
    h += '<div class="tbl"><div class="tr th"><span>阶段</span><span>站点</span><span>已交付</span><span>在建/规划</span></div>' +
      p.stageAgg.map(s => '<div class="tr"><span><i class="dot" style="background:' + s.color + '"></i>' + s.zh + '</span><span>' + s.sites +
        '</span><span>' + (s.liveMW ? s.liveMW + ' MW' : '—') + '</span><span>' + (s.plannedMW ? s.plannedMW + ' MW' : '—') + '</span></div>').join('') + '</div>';
    // 站点总表
    h += '<div class="section-head"><h2>全部站点</h2><small>设施 | 位置 | 阶段 | IT容量 | 证据 | 最近核验</small></div>';
    h += '<div class="tbl"><div class="tr th"><span>设施</span><span>位置</span><span>阶段</span><span>IT容量</span><span>证据</span></div>' +
      p.rows.map(r => {
        const bits = [];
        if (r.live !== null) bits.push('投运 ' + r.live);
        if (r.planned !== null) bits.push('规划 ' + r.planned);
        if (r.design !== null) bits.push('设计上限 ' + r.design);
        if (r.phaseMW) bits.push('分期合计 ' + r.phaseMW);
        const cap = bits.length ? bits.join(' / ') + ' MW' : '未披露';
        const capCls = r.live !== null ? 'cap-live' : (r.planned !== null ? 'cap-plan' : 'cap-none');
        return '<div class="tr" data-site="' + esc(r.site.id) + '"><span>' + esc(r.site.name) + '</span><span>' + esc([r.site.city, r.site.country].filter(Boolean).join(' · ')) +
          '</span><span><i class="dot" style="background:' + STAGE[r.stage].color + '"></i>' + STAGE[r.stage].zh + '</span><span class="' + capCls + '">' + cap +
          '</span><span class="ev">' + esc(r.site.vstatus || '-') + '<em>' + esc(r.site.asof || r.site.last || '') + '</em></span></div>';
      }).join('') + '</div>';
    // 容量口径明细
    const withObs = p.rows.filter(r => r.disclosed);
    if (withObs.length) {
      h += '<div class="section-head"><h2>容量口径明细</h2><small>投运 / 规划 / 设计上限 / 分期 互不相加</small></div>';
      h += '<div class="tbl"><div class="tr th"><span>站点</span><span>口径拆分</span><span>阶段</span><span>时点</span><span>来源</span></div>' +
        withObs.map(r => '<div class="tr" data-site="' + esc(r.site.id) + '"><span>' + esc(r.site.name) + '</span><span>' +
          esc([r.live !== null ? '投运' + r.live : '', r.planned !== null ? '规划' + r.planned : '', r.design !== null ? '设计上限' + r.design : '', r.phaseMW ? '分期' + r.phaseMW : ''].filter(Boolean).join(' / ')) +
          ' MW</span><span>' + STAGE[r.stage].zh + '</span><span>' + esc(r.site.asof || r.site.last || '') + '</span><span>' + esc(r.site.vstatus || '') + '</span></div>').join('') + '</div>';
    }
    // 最大站点
    if (p.largest.length) {
      h += '<div class="section-head"><h2>已披露容量的最大站点</h2><small>按单站披露值</small></div>';
      h += '<div class="tbl">' + p.largest.map(l => '<div class="tr"><span>' + esc(l.name) + '</span><span>' + esc(l.country) +
        '</span><span>' + (l.live !== null ? l.live + ' MW 已交付' : (l.planned !== null ? l.planned + ' MW ' + STAGE[l.stage].zh : '—')) + '</span></div>').join('') + '</div>';
    }
    // 近期变更
    if (p.changes.length) {
      h += '<div class="section-head"><h2>近期变更</h2><small>来自已核验里程碑</small></div>';
      h += '<div class="tl">' + p.changes.slice(0, 8).map(c => '<div class="tl-row"><b>' + esc(c.date) + '</b><span>' + esc(c.text || c.type) +
        '</span><em>' + esc(c.site || '') + '</em></div>').join('') + '</div>';
    }
    // 数据缺口
    h += '<div class="section-head"><h2>数据缺口</h2><small>未知不等于0</small></div>';
    h += '<div class="gap-grid">' +
      '<div><b>' + p.gaps.noCapacity.length + '</b><span>个站点未披露IT容量</span></div>' +
      '<div><b>' + p.gaps.stale.length + '</b><span>个站点证据过期/存在冲突</span></div>' +
      '<div><b>' + p.gaps.single.length + '</b><span>个站点仅单一来源</span></div></div>';
    if (p.gaps.noCapacity.length) {
      h += '<div class="gap-list">未披露容量：' + p.gaps.noCapacity.map(r => esc(r.site.name)).join('、') + '</div>';
    }
    // 地图 + 新闻
    h += '<div class="section-head"><h2>该客户全球分布</h2><small>按阶段着色</small></div>' + miniMap(p);
    if (p.news.length) {
      h += '<div class="section-head"><h2>相关动态</h2><small>' + p.news.length + ' 条</small></div>' +
        '<div class="tl">' + p.news.slice(0, 6).map(n => '<div class="tl-row"><b>' + esc(String(n.date).slice(0, 10)) + '</b><span>' + esc(n.title) +
          '</span><em>' + esc(n.source_id || '') + '</em></div>').join('') + '</div>';
    }
    el.innerHTML = h;
    return p;
  }

  function operators() {
    const set = {};
    SITES.forEach(s => { if (s.op) set[s.op] = (set[s.op] || 0) + 1; });
    const wl = ((window.DCR_RELEASE && window.DCR_RELEASE.meta && window.DCR_RELEASE.meta.watchlist_customers) || []);
    const arr = Object.keys(set).map(k => ({ k: k, n: set[k], w: wl.indexOf(k) >= 0 }));
    arr.sort((a, b) => (a.k === 'DAMAC Digital' ? -1 : b.k === 'DAMAC Digital' ? 1 : (b.w - a.w) || (b.n - a.n)));
    const top = arr.filter(x => x.w).slice(0, 30).map(x => x.k);
    const rest = arr.filter(x => !x.w && x.n >= 5).slice(0, 8).map(x => x.k);
    return top.concat(rest);
  }

  window.DCRPortfolio = { build: buildPortfolio, render: render, operators: operators };
})();
