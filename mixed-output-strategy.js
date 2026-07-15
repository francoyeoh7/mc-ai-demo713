(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MixedOutputStrategy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LABELS = {
    IDENTITY_QUERY: /是什么|属性|掉什么|掉落|危险|怕什么|用途|能做什么/,
    OPERATION_QUERY: /怎么做|怎么合成|怎么激活|怎么种|怎么驯服|能种|能驯服|能附魔/,
    COMPARISON_QUERY: /哪个好|哪个更|区别|比较/,
    DECISION_QUERY: /要不要|该不该|值不值|应该|适合|下一步|干嘛/,
    DIAGNOSIS_QUERY: /为什么|怎么不|没反应|不亮|不了/,
    STATUS_QUERY: /多少|多久|进度|还能用|状态|今天|最近|统计/,
    LOCATION_QUERY: /在哪|哪里|附近|位置|怎么去/,
    ACTION_REQUEST: /帮我|替我|给我去/,
    EMOTIONAL: /好累|难过|生气|害怕|开心/,
    OUT_OF_SCOPE: /开挂|作弊|外挂/,
  };

  function classifyIntent(query, context = {}) {
    const text = String(query || '').trim();
    const selected = (context.selectedObjects || []).length > 0;
    if (!text || (/^(那个|这个|它|那边|然后呢)[？?]?$/.test(text) && !selected)) {
      return { label: 'UNKNOWN', confidence: 0.38, evidence: ['缺少可解析的对象或问法'] };
    }
    for (const [label, pattern] of Object.entries(LABELS)) {
      const hit = text.match(pattern);
      if (hit) return { label, confidence: selected ? 0.96 : 0.9, evidence: [`命中“${hit[0]}”`] };
    }
    return { label: 'UNKNOWN', confidence: 0.55, evidence: ['未命中稳定意图模式'] };
  }

  function needsWikiAsCore(label, query, context) {
    const hasObject = (context.selectedObjects || []).length > 0;
    if (['IDENTITY_QUERY', 'OPERATION_QUERY', 'COMPARISON_QUERY'].includes(label)) return true;
    if (hasObject && /这|它|这个|对象|剑|怪|羊|树/.test(query) && ['STATUS_QUERY', 'DECISION_QUERY', 'DIAGNOSIS_QUERY'].includes(label)) return true;
    return false;
  }

  function needsDynamicState(label, query) {
    if (['DECISION_QUERY', 'DIAGNOSIS_QUERY', 'STATUS_QUERY', 'LOCATION_QUERY'].includes(label)) return true;
    return /当前|现在|附近|我有|还能用|打得过|适合我/.test(query);
  }

  function gDirectionNeedsC(query, context) {
    if (/下一步|需要什么|缺什么|怎么办|材料|修|制作|来源/.test(query)) return true;
    const state = context.playerState || {};
    return state.currentDurability === 0 || state.inventory?.food === 0;
  }

  function resolveRoute({ query, intent, context = {} }) {
    const wikiAsOutput = needsWikiAsCore(intent.label, query, context);
    const dynamicStateRequired = needsDynamicState(intent.label, query);
    if (intent.confidence < 0.7) {
      return { path: 'CLARIFY', wikiAsOutput: false, dynamicStateRequired: false, cDataUsage: 'NONE', reason: 'LOW_CONFIDENCE' };
    }
    if (intent.label === 'EMOTIONAL' || intent.label === 'OUT_OF_SCOPE') {
      return { path: 'FILTERED', wikiAsOutput: false, dynamicStateRequired: false, cDataUsage: 'NONE' };
    }
    if (intent.label === 'ACTION_REQUEST') {
      return { path: 'ACTION_BOUNDARY', wikiAsOutput: false, dynamicStateRequired: true, cDataUsage: 'NONE' };
    }
    if (wikiAsOutput) {
      return {
        path: dynamicStateRequired ? 'C_TO_G' : 'PURE_C',
        wikiAsOutput: true,
        dynamicStateRequired,
        cDataUsage: dynamicStateRequired ? 'PRIMARY_WITH_G' : 'PRIMARY',
      };
    }
    if (dynamicStateRequired) {
      const needsC = gDirectionNeedsC(query, context);
      return {
        path: needsC ? 'G_TO_C' : 'PURE_G',
        wikiAsOutput: false,
        dynamicStateRequired: true,
        cDataUsage: needsC ? 'EMBEDDED' : 'NONE',
      };
    }
    if (intent.label === 'OPERATION_QUERY' || /配方|合成|来源/.test(query)) {
      return { path: 'PURE_C', wikiAsOutput: true, dynamicStateRequired: false, cDataUsage: 'PRIMARY' };
    }
    return { path: 'CLARIFY', wikiAsOutput: false, dynamicStateRequired: false, cDataUsage: 'NONE' };
  }

  function component(id, data) {
    return { id, data };
  }

  function executeC(query, context, intent) {
    const object = (context.selectedObjects || [])[0];
    if (!object?.wiki) return [];
    const wiki = object.wiki;
    const components = [];
    if (intent === 'IDENTITY_QUERY') {
      components.push(component('C1', { summary: wiki.summary, object: object.name }));
      components.push(component('C2', { intro: wiki.intro }));
      if (/掉什么|掉落/.test(query)) components.push(component('C4', { drops: wiki.drops || [] }));
      else if (/数值|属性|危险|耐久/.test(query)) components.push(component('C3', { ...(wiki.stats || {}) }));
    } else if (intent === 'OPERATION_QUERY') {
      components.push(component('C1', { summary: wiki.summary, object: object.name }));
      if (wiki.recipe) components.push(component('C6', { recipe: wiki.recipe }));
      if (wiki.source) components.push(component('C7', { sources: [wiki.source] }));
    } else if (intent === 'STATUS_QUERY') {
      components.push(component('C3', { ...(wiki.stats || {}) }));
    } else {
      components.push(component('C1', { summary: wiki.summary, object: object.name }));
      components.push(component('C2', { intro: wiki.intro }));
    }
    return components;
  }

  function executeG(query, context, intent) {
    const state = context.playerState || {};
    const world = context.worldState || {};
    const components = [];
    let judgment = '需要结合当前状态判断';
    if (/洞穴/.test(query)) judgment = world.cave?.explored ? '这个洞穴已经探索过' : '这个洞穴还没有探索';
    if (/今天砍了多少树/.test(query)) judgment = `你今天砍了 ${state.stats?.treesCutToday ?? '未知'} 棵树`;
    if (/下一步|干嘛/.test(query) && (state.currentDurability === 0 || state.inventory?.food === 0)) judgment = '武器损坏且食物不足';
    if (/还能用/.test(query)) judgment = state.currentDurability == null ? '当前耐久不可读' : `当前耐久 ${state.currentDurability}`;
    components.push(component('G1', { judgment }));

    if (intent === 'DIAGNOSIS_QUERY') components.push(component('G2', { reason: '根据当前状态定位关键原因' }));
    if (intent === 'OPERATION_QUERY' || intent === 'DIAGNOSIS_QUERY') components.push(component('G3', { steps: ['确认条件', '准备材料', '执行操作'] }));
    if (intent === 'DECISION_QUERY') {
      components.push(component('G4', { risk: world.cave?.lightLevel === 0 ? '光照为 0，存在刷怪风险' : '风险可控' }));
      components.push(component('G6', { directions: state.currentDurability === 0 || state.inventory?.food === 0 ? ['先修剑', '再找食物'] : ['继续探索'] }));
    }
    if (intent === 'LOCATION_QUERY') components.push(component('G5', { location: world.nearby?.[0] || null }));
    if (['DECISION_QUERY', 'STATUS_QUERY'].includes(intent)) {
      components.push(component('G7', {
        currentDurability: state.currentDurability,
        positionHint: state.position ? `当前位置 ${state.position.x}, ${state.position.y}, ${state.position.z}` : undefined,
        stats: state.stats,
      }));
    }
    return components;
  }

  function inferCFromG(gComponents, context) {
    const directions = gComponents.find(item => item.id === 'G6')?.data?.directions || [];
    const sources = [];
    for (const direction of directions) {
      if (/修剑/.test(direction)) sources.push('铁锭从铁矿石烧制');
      else if (/食物/.test(direction)) sources.push('食物可在村庄西边牛圈获得');
      else sources.push('打开图鉴查看具体来源');
    }
    if (!sources.length) {
      const selected = (context.selectedObjects || [])[0];
      if (selected?.wiki?.source) sources.push(selected.wiki.source);
    }
    return sources.length ? [component('C7', { sources })] : [];
  }

  function executeComponents({ query, route, context = {} }) {
    let components = [];
    if (route.path === 'PURE_C') components = executeC(query, context, route.intent);
    if (route.path === 'PURE_G') components = executeG(query, context, route.intent);
    if (route.path === 'C_TO_G') components = [...executeC(query, context, route.intent), ...executeG(query, context, route.intent)];
    if (route.path === 'G_TO_C') {
      const g = executeG(query, context, route.intent);
      components = [...g, ...inferCFromG(g, context)];
    }
    return { components };
  }

  function extractCore(components) {
    return components.map(({ id, data }) => ({ id, data }));
  }

  function fuse(path, components) {
    const byId = Object.fromEntries(components.map(item => [item.id, item.data]));
    if (path === 'C_TO_G' && byId.C3?.maxDurability != null && byId.G7?.currentDurability != null) {
      return [`还能用约 ${byId.G7.currentDurability} 次（最大耐久 ${byId.C3.maxDurability}）`, byId.G1?.judgment].filter(Boolean);
    }
    if (path === 'G_TO_C') {
      const directions = byId.G6?.directions || [];
      const sources = byId.C7?.sources || [];
      const lines = directions.map((direction, index) => `${direction}——${sources[index] || '查看对应 Wiki 来源'}`);
      if (byId.G7?.positionHint) lines.push(byId.G7.positionHint);
      return lines;
    }
    if (path === 'PURE_C') {
      const lines = [];
      if (byId.C1?.summary) lines.push(byId.C1.summary);
      if (byId.C2?.intro && byId.C2.intro !== byId.C1?.summary) lines.push(byId.C2.intro);
      if (byId.C4?.drops) lines.push(`掉落：${byId.C4.drops.join('、')}`);
      if (byId.C6?.recipe) lines.push(`配方：${byId.C6.recipe.join(' + ')}`);
      if (byId.C7?.sources) lines.push(`来源：${byId.C7.sources.join('；')}`);
      if (byId.C3?.maxDurability != null) lines.push(`最大耐久 ${byId.C3.maxDurability}`);
      return lines;
    }
    if (path === 'PURE_G') {
      return [byId.G1?.judgment, byId.G2?.reason, byId.G4?.risk, byId.G5?.location ? `最近目标距离 ${byId.G5.location.distance} 格` : null, byId.G6?.directions?.join('，')].filter(Boolean);
    }
    return [];
  }

  function assemble(lines, action = null) {
    const compact = lines.filter(Boolean).slice(0, 4);
    return { lines: compact, text: compact.join('\n'), highlights: [], action, verified: true };
  }

  function integrateResults({ path, intent, components, action = null }) {
    return assemble(fuse(path, extractCore(components)), action);
  }

  function resolveAction(query, intent) {
    if (intent !== 'ACTION_REQUEST') return null;
    if (/找|附近|去哪|带我去/.test(query)) return { type: 'MARK_LOCATION', label: '标记位置' };
    if (/怎么|配方|查看|打开/.test(query)) return { type: 'OPEN_GUIDE', label: '打开指引' };
    return { type: 'OPEN_GUIDE', label: '查看可行步骤' };
  }

  function createContextManager() {
    let last = null;
    return {
      remember(entry) { last = entry; },
      getLast() { return last; },
      resolveFollowUp(query) {
        if (!last) return { hit: false };
        const c7 = (last.components || []).find(item => item.id === 'C7');
        if (c7 && /哪来|来源|怎么获得|哪里找/.test(query)) return { hit: true, component: c7, path: 'CACHE_C7' };
        return { hit: false };
      },
    };
  }

  function fallbackForMissingC(selected) {
    return {
      failure: { code: 'C_DATA_NOT_FOUND', message: '对象 Wiki 数据缺失' },
      output: { lines: ['这个对象没有可验证的 Wiki 数据，我不会把推测当成事实。'], text: '这个对象没有可验证的 Wiki 数据，我不会把推测当成事实。', verified: false },
    };
  }

  function buildComponentPlan(route, intent, components) {
    const ids = components.map(item => item.id);
    if (route.path === 'PURE_C') return { family: 'PURE_C_WIKI', components: ids };
    if (route.path === 'PURE_G' && intent === 'STATUS_QUERY') {
      return { family: 'PURE_G_STAT', components: ['G1', 'G7'].filter(id => ids.includes(id)) };
    }
    if (route.path === 'C_TO_G' || route.path === 'G_TO_C') return { family: 'MIXED_GUIDE', components: ids };
    return { family: 'TEXT', components: ids };
  }

  async function processRequest({ query, context = {}, contextManager = null }) {
    const cached = contextManager?.resolveFollowUp(query);
    if (cached?.hit) {
      const output = integrateResults({ path: 'PURE_C', intent: 'IDENTITY_QUERY', components: [cached.component] });
      return { intent: { label: 'FOLLOW_UP', confidence: 1 }, route: { path: cached.path }, components: [cached.component], output, action: null, cacheHit: true };
    }

    const intent = classifyIntent(query, context);
    let route = resolveRoute({ query, intent, context });
    route.intent = intent.label;
    const selected = (context.selectedObjects || [])[0];

    if (['PURE_C', 'C_TO_G'].includes(route.path) && selected && !selected.wiki) {
      return { intent, route, ...fallbackForMissingC(selected), components: [], action: null };
    }

    if (['PURE_G', 'C_TO_G', 'G_TO_C'].includes(route.path) && !context.playerState && !context.worldState) {
      if (selected?.wiki) {
        route = { path: 'PURE_C', intent: intent.label, wikiAsOutput: true, dynamicStateRequired: false, cDataUsage: 'PRIMARY' };
        const { components } = executeComponents({ query, route, context });
        const output = integrateResults({ path: route.path, intent: intent.label, components });
        return { intent, route, components, output, action: null, failure: { code: 'G_STATE_UNAVAILABLE', message: '动态状态不可读，已降级为纯 C' } };
      }
      return { intent, route, components: [], output: { lines: ['我暂时读不到你的游戏状态。'], text: '我暂时读不到你的游戏状态。', verified: false }, action: null, failure: { code: 'G_STATE_UNAVAILABLE' } };
    }

    if (route.path === 'CLARIFY') {
      return { intent, route, components: [], output: { lines: ['你想问对象属性、操作方法，还是当前状态？'], text: '你想问对象属性、操作方法，还是当前状态？', verified: true }, action: null };
    }
    if (route.path === 'FILTERED') {
      return { intent, route, components: [], output: { lines: ['这个请求不进入游戏问题策略。'], text: '这个请求不进入游戏问题策略。', verified: true }, action: null };
    }
    if (route.path === 'ACTION_BOUNDARY') {
      const action = resolveAction(query, intent.label);
      return { intent, route, components: [], action, output: { lines: ['我可以帮你查看步骤或标记位置，但不会替你执行游戏操作。'], text: '我可以帮你查看步骤或标记位置，但不会替你执行游戏操作。', action, verified: true } };
    }

    const { components } = executeComponents({ query, route, context });
    const action = resolveAction(query, intent.label);
    const output = integrateResults({ path: route.path, intent: intent.label, components, action });
    const componentPlan = buildComponentPlan(route, intent.label, components);
    contextManager?.remember({ query, path: route.path, components });
    return { intent, route, components, componentPlan, output, action, failure: null };
  }

  async function processRequestWithAI(request, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const endpoint = options.endpoint || '/api/strategy';
    const localIntent = classifyIntent(request.query, request.context || {});
    const localRoute = resolveRoute({ query: request.query, intent: localIntent, context: request.context || {} });
    if (localRoute.path === 'PURE_C') {
      const local = await processRequest(request);
      return { ...local, aiEnhanced: false, localInstant: true };
    }
    if (!fetchImpl) {
      const local = await processRequest(request);
      return { ...local, aiEnhanced: false, failure: local.failure || { code: 'AI_PROXY_UNAVAILABLE', message: '浏览器不支持网络请求' } };
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: request.query, context: request.context || {} }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status || 500}`);
      const payload = await response.json();
      if (!payload.ok || !payload.data?.intent || !payload.data?.route) throw new Error(payload.error || 'AI返回格式错误');
      const ai = payload.data;
      const route = { ...ai.route, intent: ai.intent.label };
      const { components } = executeComponents({ query: request.query, route, context: request.context || {} });
      let output = integrateResults({ path: route.path, intent: ai.intent.label, components });
      if (ai.generatedText) {
        const lines = String(ai.generatedText).split(/\n+/).map(item => item.trim()).filter(Boolean).slice(0, 4);
        output = { ...output, lines, text: lines.join('\n') };
      }
      request.contextManager?.remember({ query: request.query, path: route.path, components });
      return { intent: ai.intent, route, components, componentPlan: ai.componentPlan || buildComponentPlan(route, ai.intent.label, components), output, action: null, failure: null, aiEnhanced: true };
    } catch (error) {
      const local = await processRequest(request);
      return {
        ...local,
        aiEnhanced: false,
        failure: local.failure || { code: 'AI_PROXY_UNAVAILABLE', message: error.message },
      };
    }
  }

  return {
    classifyIntent,
    resolveRoute,
    executeComponents,
    extractCore,
    fuse,
    assemble,
    integrateResults,
    buildComponentPlan,
    resolveAction,
    processRequest,
    processRequestWithAI,
    createContextManager,
  };
});
