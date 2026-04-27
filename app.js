/**
 * ICD 以需定产 — 数据模型与业务逻辑
 * Target / Conversion_Model / Strategy_Rule + 天鉴评级 & 历史转化率（模拟）
 */

/** @typedef {'Revenue'|'Volume'} TargetType */

/**
 * @typedef {Object} Target
 * @property {string} target_id
 * @property {TargetType} target_type
 * @property {number} target_value
 * @property {number} current_predict_value
 */

/**
 * @typedef {Object} ConversionModelRow
 * @property {string} from_stage
 * @property {string} to_stage
 * @property {number} avg_rate
 * @property {number} std_dev
 * @property {string} [source] 历史表版本
 */

/**
 * @typedef {Object} StrategyRule
 * @property {string} id
 * @property {string} trigger_condition
 * @property {'资源倾斜'|'流程变更'|'组织升级'} strategy_type
 * @property {string} content
 * @property {string} scene
 * @property {string} expected_effect
 */

/**
 * 数据源映射（PRD / 升级方案）——对接数仓时替换为实查
 * @readonly
 */
const DATA_SOURCES = {
  tianjianLeads: "comp.tianjian_cpr_sku_summary_df",
  tianjianGrade: "comp.tianjian_material_grade_summary_df",
  gradeField: "material_grade_3month",
  copyrightInfo: "copyright.tb_cpr_info (content_type=1)",
};

/** 天鉴评级（PRD 筛选项默认 A/S/SS）：用于加权单专辑收入预测 */
const TIANJIAN_RATINGS = [
  { tier: "SS", weight: 1.48, label: "SS" },
  { tier: "S", weight: 1.35, label: "S" },
  { tier: "A", weight: 1.12, label: "A" },
  { tier: "B", weight: 1.0, label: "B" },
  { tier: "C", weight: 0.85, label: "C" },
];

/**
 * PRD「线索流转数据漏斗」五段转化率（相邻环节）
 * 生成线索→版权跟进→入库版权→发单→接单→上架
 */
const DEFAULT_CONVERSION_CHAIN = [
  { from_stage: "生成线索", to_stage: "版权跟进", avg_rate: 0.72, std_dev: 0.04, source: "hist_netnovel_Q4" },
  { from_stage: "版权跟进", to_stage: "入库版权", avg_rate: 0.38, std_dev: 0.05, source: "copyright_workbench" },
  { from_stage: "入库版权", to_stage: "发单", avg_rate: 0.78, std_dev: 0.05, source: "adm.content_production_dashboard" },
  { from_stage: "发单", to_stage: "接单", avg_rate: 0.88, std_dev: 0.04, source: "A+_production" },
  { from_stage: "接单", to_stage: "上架", avg_rate: 0.75, std_dev: 0.06, source: "album_wide_table" },
];

/** 历史季度峰值产能（用于难度系数） */
const CAPACITY_BENCHMARK = {
  maxQuarterRevenue: 8_000_000,
  maxQuarterShelf: 180,
  avgRevenuePerAlbum: 50_000,
};

/** 策略规则表（IF-THEN） */
const STRATEGY_RULES = [
  {
    id: "SR-LEAD",
    trigger_condition: "生成线索或版权跟进低于拆解目标",
    strategy_type: "资源倾斜",
    content: "扩大垂类搜索范围；激活存量回捞线索（对齐 A+ 线索池监控）",
    scene: "A",
    expected_effect: "预计线索供给 +15%～25%",
  },
  {
    id: "SR-INTRO",
    trigger_condition: "入库版权低于拆解目标",
    strategy_type: "组织升级",
    content: "升级谈判人（高阶版权经理介入）；调整保底/分成；推进待入库子状态",
    scene: "B",
    expected_effect: "预计跟进→入库转化 +8%～15%",
  },
  {
    id: "SR-PROD",
    trigger_condition: "发单/接单/上架低于拆解目标",
    strategy_type: "流程变更",
    content: "切换发单类型（海选/定向/AI）；申请 AI 制作权益；资源置换替代版权",
    scene: "C",
    expected_effect: "预计周期缩短 3～7 天；制作吞吐 +10% 量级",
  },
];

/** 与 PRD 主漏斗统计列一致（线索 cohort 至今累计） */
const STAGE_ORDER = ["生成线索", "版权跟进", "入库版权", "发单", "接单", "上架"];

/** @type {Target} */
let currentTarget = {
  target_id: "T-" + new Date().toISOString().slice(0, 10),
  target_type: "Revenue",
  target_value: 10_000_000,
  current_predict_value: 0,
};

/** 用户覆盖的转化率 key: `${from}->${to}` */
const rateOverrides = {};

/** 各环节模拟「实际」进度（对接天鉴/版权工作台/A+ 后替换） */
let actualByStage = {
  生成线索: 680,
  版权跟进: 470,
  入库版权: 92,
  发单: 78,
  接单: 68,
  上架: 21,
};

/** @type {{ text: string; ts: string }[]} */
let adoptedStrategies = loadAdopted();

function loadAdopted() {
  try {
    const raw = localStorage.getItem("icd-adopted-strategies");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveAdopted() {
  localStorage.setItem("icd-adopted-strategies", JSON.stringify(adoptedStrategies));
}

/**
 * 有效转化率（含覆盖）
 * @param {ConversionModelRow[]} chain
 */
function getEffectiveRates(chain) {
  return chain.map((row) => {
    const key = `${row.from_stage}->${row.to_stage}`;
    const v = rateOverrides[key];
    const rate = typeof v === "number" ? v : row.avg_rate;
    return { ...row, avg_rate: Math.min(0.99, Math.max(0.01, rate)) };
  });
}

/**
 * 连乘：线索 → 上架 总转化
 */
function compoundRateToShelf(chain) {
  const eff = getEffectiveRates(chain);
  return eff.reduce((acc, r) => acc * r.avg_rate, 1);
}

/**
 * 由末端上架目标反推各阶段需求量（五段转化率、六环节）
 * @param {number} shelfTarget 上架专辑数
 * @param {ConversionModelRow[]} chain
 */
function decomposeFromShelf(shelfTarget, chain) {
  const eff = getEffectiveRates(chain);
  const r = eff.map((x) => x.avg_rate);
  const stages = STAGE_ORDER;
  const out = {};
  out[stages[stages.length - 1]] = shelfTarget;
  let v = shelfTarget;
  for (let i = r.length - 1; i >= 0; i--) {
    v /= r[i];
    out[stages[i]] = v;
  }
  return out;
}

/**
 * 收入目标 → 上架数（天鉴加权平均单价）
 */
function revenueToShelfCount(revenue, avgPerAlbum = CAPACITY_BENCHMARK.avgRevenuePerAlbum) {
  const weighted = TIANJIAN_RATINGS.reduce((s, t) => s + t.weight, 0) / TIANJIAN_RATINGS.length;
  const effectiveUnit = avgPerAlbum * weighted;
  return revenue / effectiveUnit;
}

/**
 * 难度系数：相对历史峰值
 */
function assessDifficulty(targetType, targetValue) {
  if (targetType === "Revenue") {
    const peak = CAPACITY_BENCHMARK.maxQuarterRevenue;
    const ratio = targetValue / peak;
    let label = "合理";
    if (ratio >= 1.15) label = "激进";
    else if (ratio <= 0.75) label = "保守";
    return {
      label,
      ratio,
      detail: `对比历史季度收入峰值约 ${(peak / 10000).toFixed(0)} 万，当前目标为参照峰值的 ${(ratio * 100).toFixed(1)}%。`,
    };
  }
  const peakShelf = CAPACITY_BENCHMARK.maxQuarterShelf;
  const ratio = targetValue / peakShelf;
  let label = "合理";
  if (ratio >= 1.12) label = "激进";
  else if (ratio <= 0.78) label = "保守";
  return {
    label,
    ratio,
    detail: `对比历史单季上架峰值约 ${peakShelf.toFixed(0)} 部，当前目标为参照峰值的 ${(ratio * 100).toFixed(1)}%。`,
  };
}

/**
 * 季度预测收入（简化的产能曲线）
 */
function predictQuarterCurve(targetType, targetValue) {
  const weeks = 13;
  const labels = Array.from({ length: weeks }, (_, i) => `W${i + 1}`);
  const targetLine = [];
  const predictLine = [];
  let cumPredict = 0;
  const weeklyEfficiency = targetType === "Revenue" ? 0.82 : 0.88;
  for (let i = 0; i < weeks; i++) {
    const linear = (targetValue / weeks) * (i + 1);
    targetLine.push(linear);
    cumPredict += (targetValue / weeks) * weeklyEfficiency * (0.92 + Math.sin(i / 2) * 0.04);
    predictLine.push(cumPredict);
  }
  currentTarget.current_predict_value = predictLine[weeks - 1] ?? 0;
  return { labels, targetLine, predictLine };
}

/** 拆解结果快照（供策略与漏斗使用） */
let lastDecompose = { shelf: 0, byStage: {}, chain: [] };

function recalcDecompose() {
  const chain = getEffectiveRates(DEFAULT_CONVERSION_CHAIN);
  let shelf =
    currentTarget.target_type === "Volume"
      ? currentTarget.target_value
      : revenueToShelfCount(currentTarget.target_value);

  const byStage = decomposeFromShelf(shelf, DEFAULT_CONVERSION_CHAIN);
  lastDecompose = { shelf, byStage, chain };
  return lastDecompose;
}

function renderDifficulty() {
  const d = assessDifficulty(currentTarget.target_type, currentTarget.target_value);
  const el = document.getElementById("difficultyText");
  const det = document.getElementById("difficultyDetail");
  if (el) el.textContent = `${d.label}（难度系数参考：${d.ratio.toFixed(2)}× 历史峰值）`;
  if (det) det.textContent = d.detail;
}

let chartGap = null;
function renderGapChart() {
  const ctx = document.getElementById("chartGap");
  if (!ctx || typeof Chart === "undefined") return;
  const { labels, targetLine, predictLine } = predictQuarterCurve(
    currentTarget.target_type,
    currentTarget.target_value
  );
  const unit = currentTarget.target_type === "Revenue" ? "元" : "部";
  const fmt = (v) =>
    currentTarget.target_type === "Revenue" ? (v / 10000).toFixed(1) + "万" : v.toFixed(0) + unit;

  if (chartGap) chartGap.destroy();
  chartGap = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "目标进度（线性拆解）",
          data: targetLine,
          borderColor: "#1890ff",
          backgroundColor: "rgba(24,144,255,0.08)",
          fill: true,
          tension: 0.2,
        },
        {
          label: "基于当前产能的预测",
          data: predictLine,
          borderColor: "#ed7b2f",
          borderDash: [6, 4],
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "rgba(0,0,0,0.55)" } },
        tooltip: {
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: "rgba(0,0,0,0.45)" }, grid: { color: "rgba(0,0,0,0.06)" } },
        y: {
          ticks: {
            color: "rgba(0,0,0,0.45)",
            callback: (v) => fmt(v),
          },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
      },
    },
  });

  const gap = targetLine[targetLine.length - 1] - predictLine[predictLine.length - 1];
  const cap = document.getElementById("gapSummary");
  if (cap) {
    cap.textContent = `期末 Gap 约 ${fmt(Math.abs(gap))}（预测低于目标时，需结合模块二拆解与模块三策略补位）。`;
  }
}

function renderRatesEditor() {
  const host = document.getElementById("ratesEditor");
  if (!host) return;
  host.innerHTML = "";
  DEFAULT_CONVERSION_CHAIN.forEach((row) => {
    const key = `${row.from_stage}->${row.to_stage}`;
    const overridden = typeof rateOverrides[key] === "number";
    const wrap = document.createElement("div");
    wrap.className = "rate-row";
    wrap.innerHTML = `
      <span class="stage-pair">${row.from_stage} → ${row.to_stage}</span>
      <label for="rate-${key}">转化率（历史 ${(row.avg_rate * 100).toFixed(1)}% ± ${row.std_dev}）</label>
      <input type="number" id="rate-${key}" data-key="${key}" step="0.01" min="0.01" max="0.99" value="${(overridden ? rateOverrides[key] : row.avg_rate).toFixed(2)}" />
      ${overridden ? '<span class="override-badge">已覆盖</span>' : ""}
    `;
    host.appendChild(wrap);
  });
  host.querySelectorAll('input[type="number"]').forEach((inp) => {
    inp.addEventListener("input", () => {
      const key = inp.getAttribute("data-key");
      if (!key) return;
      rateOverrides[key] = parseFloat(inp.value);
      refreshDerived();
    });
  });
}

function renderWaterfall() {
  const { shelf, byStage } = recalcDecompose();
  const host = document.getElementById("waterfallBars");
  const hint = document.getElementById("sankeyHint");
  if (!host) return;

  const revenueWan = (currentTarget.target_value / 10000).toFixed(1);
  const rows = [];
  if (currentTarget.target_type === "Revenue") {
    rows.push({ label: "季度收入目标", value: currentTarget.target_value, kind: "purple", display: `${revenueWan} 万元` });
  }
  const stageRows = [
    { key: "上架", label: "需上架（PGC 专辑）", display: (v) => `${v.toFixed(1)} 部` },
    { key: "接单", label: "需接单（版权维度）", display: (v) => `${v.toFixed(1)} 部` },
    { key: "发单", label: "需发单", display: (v) => `${v.toFixed(1)} 部` },
    { key: "入库版权", label: "需入库版权", display: (v) => `${v.toFixed(1)} 部` },
    { key: "版权跟进", label: "需版权跟进中", display: (v) => `${v.toFixed(1)} 条` },
    { key: "生成线索", label: "需生成线索", display: (v) => `${v.toFixed(0)} 条` },
  ];
  stageRows.forEach(({ key, label, display }) => {
    const v = byStage[key];
    if (v == null) return;
    rows.push({ label, value: v, kind: "orange", display: display(v) });
  });

  const maxVal = Math.max(...rows.map((r) => r.value), 1);
  host.innerHTML = rows
    .map(
      (r) => `
    <div class="wf-step">
      <span class="wf-label">${r.label}</span>
      <div class="wf-bar-bg"><div class="wf-bar-fill ${r.kind}" style="width:${Math.min(100, (r.value / maxVal) * 100)}%"></div></div>
      <span class="wf-val">${r.display}</span>
    </div>
  `
    )
    .join("");

  if (hint) {
    const p = compoundRateToShelf(DEFAULT_CONVERSION_CHAIN);
    hint.textContent = `与 PRD 主漏斗一致：收入/上架目标 → 五段转化率连乘 ${(p * 100).toFixed(1)}% 反推至生成线索。${DATA_SOURCES.tianjianGrade}.${DATA_SOURCES.gradeField} 参与收入→上架折算；实表：${DATA_SOURCES.tianjianLeads}。`;
  }
}

/**
 * @param {number} gapAbs 绝对缺口
 * @param {number} gapRatio 相对缺口比例 0~1
 * @param {string} stageKey
 */
function generateStrategy(gapAbs, gapRatio, stageKey) {
  if (gapAbs <= 0 || gapRatio <= 0) return null;
  const pct = (gapRatio * 100).toFixed(1);
  const sceneA = ["生成线索", "版权跟进"];
  const sceneB = ["入库版权"];
  const sceneC = ["发单", "接单", "上架"];

  if (sceneA.includes(stageKey)) {
    const rule = STRATEGY_RULES.find((r) => r.id === "SR-LEAD");
    return rule
      ? {
          ...rule,
          diagnosis: "场景 A：线索侧供给或跟进不足",
          gapText: `${stageKey} 低于拆解目标约 ${pct}%（绝对缺口 ${gapAbs.toFixed(0)}）`,
        }
      : null;
  }
  if (sceneB.includes(stageKey)) {
    const rule = STRATEGY_RULES.find((r) => r.id === "SR-INTRO");
    return rule
      ? {
          ...rule,
          diagnosis: "场景 B：版权引入 / 入库滞后",
          gapText: `${stageKey} 低于拆解目标约 ${pct}%（绝对缺口 ${gapAbs.toFixed(0)}）`,
        }
      : null;
  }
  if (sceneC.includes(stageKey)) {
    const rule = STRATEGY_RULES.find((r) => r.id === "SR-PROD");
    return rule
      ? {
          ...rule,
          diagnosis: "场景 C：制作发单 / 接单 / 上架滞后",
          gapText: `缺口集中在 ${stageKey}，低于拆解目标约 ${pct}%（绝对缺口 ${gapAbs.toFixed(0)}）`,
        }
      : null;
  }
  return null;
}

function findWorstStageGaps() {
  recalcDecompose();
  const { byStage } = lastDecompose;
  const gaps = STAGE_ORDER.map((st) => {
    const target = byStage[st];
    const act = actualByStage[st] ?? 0;
    const gap = target - act;
    const ratio = target > 0 ? act / target : 1;
    return { stage: st, target, actual: act, gap, ratio };
  });
  return gaps;
}

function pushAdoptedRecord(moduleLabel, text) {
  adoptedStrategies.unshift({
    ts: new Date().toLocaleString("zh-CN"),
    text: `${moduleLabel}：${text}`,
  });
  saveAdopted();
  renderAdopted();
}

function renderStrategyM1() {
  const host = document.getElementById("strategyCardsM1");
  if (!host) return;
  const d = assessDifficulty(currentTarget.target_type, currentTarget.target_value);
  const { targetLine, predictLine } = predictQuarterCurve(currentTarget.target_type, currentTarget.target_value);
  const tEnd = targetLine[targetLine.length - 1];
  const pEnd = predictLine[predictLine.length - 1];
  const gapRatio = tEnd > 0 ? (tEnd - pEnd) / tEnd : 0;
  const gapNote =
    gapRatio > 0.03
      ? `预测期末进度低于线性目标约 ${(gapRatio * 100).toFixed(1)}%，建议提前两周纠偏。`
      : "预测与线性拆解接近，按周复盘即可。";
  let action = "";
  if (d.label === "激进") action = "建议拆分阶段目标、拉长达成周期或申请资源加码，避免期末集中缺口。";
  else if (d.label === "保守") action = "目标相对历史峰值偏保守，可在确认产能后适度上调子目标。";
  else action = "目标与历史产能匹配度较好，建议按周对齐产能曲线与里程碑。";
  const adoptText = `${action} ${gapNote}`;
  host.innerHTML = `
    <article class="strategy-card scene-a">
      <div class="sc-label">目标与周期</div>
      <p class="sc-diagnosis">难度评估：${d.label}</p>
      <p class="sc-action">${action}</p>
      <p class="sc-effect">${gapNote}</p>
      <button type="button" class="btn-adopt">采纳策略</button>
    </article>`;
  host.querySelector(".btn-adopt")?.addEventListener("click", () => pushAdoptedRecord("目标预测及达成周期拆解", adoptText));
}

function renderStrategyM2() {
  const host = document.getElementById("strategyCardsM2");
  if (!host) return;
  const eff = getEffectiveRates(DEFAULT_CONVERSION_CHAIN);
  let minRow = eff[0];
  for (const row of eff) {
    if (row.avg_rate < minRow.avg_rate) minRow = row;
  }
  const p = compoundRateToShelf(DEFAULT_CONVERSION_CHAIN);
  const diagnosis = `五段转化中「${minRow.from_stage}→${minRow.to_stage}」最低（${(minRow.avg_rate * 100).toFixed(1)}%）。`;
  const action =
    "优先排查该环节产能与流程瓶颈；可在左侧手动覆盖转化率并观察上游「生成线索」需求量变化。";
  const effect = `当前综合连乘约 ${(p * 100).toFixed(1)}%，提升薄弱段对总目标弹性最大。`;
  const adoptText = `${diagnosis} ${action}`;
  host.innerHTML = `
    <article class="strategy-card scene-b">
      <div class="sc-label">拆解杠杆</div>
      <p class="sc-diagnosis">${diagnosis}</p>
      <p class="sc-action">${action}</p>
      <p class="sc-effect">${effect}</p>
      <button type="button" class="btn-adopt">采纳策略</button>
    </article>`;
  host.querySelector(".btn-adopt")?.addEventListener("click", () => pushAdoptedRecord("生产流程目标拆解", adoptText));
}

function renderStrategyMonitor() {
  const host = document.getElementById("strategyCardsMonitor");
  if (!host) return;
  const gaps = findWorstStageGaps();
  const bad = gaps.filter((g) => g.target > 0 && g.ratio < 1);
  if (bad.length === 0) {
    host.innerHTML = '<p class="empty-strategy">当前无负向缺口，或实际已覆盖拆解目标。</p>';
    return;
  }
  const worst = [...bad].sort((a, b) => a.ratio - b.ratio)[0];
  const gapRatio = worst.target > 0 ? 1 - worst.ratio : 0;
  const strat = generateStrategy(worst.gap, gapRatio, worst.stage);
  if (!strat) {
    host.innerHTML = '<p class="empty-strategy">暂无匹配规则。</p>';
    return;
  }
  const sceneClass = strat.scene === "A" ? "scene-a" : strat.scene === "B" ? "scene-b" : "scene-c";
  const adoptText = `${strat.diagnosis} ${strat.content}（${strat.strategy_type}，${strat.id}）`;
  host.innerHTML = `
    <article class="strategy-card ${sceneClass}">
      <div class="sc-label">问题诊断 · ${strat.diagnosis}</div>
      <p class="sc-diagnosis">${strat.gapText}</p>
      <p class="sc-action"><strong>推荐动作：</strong>${strat.content}</p>
      <p class="sc-effect">预计提升效果：${strat.expected_effect}</p>
      <button type="button" class="btn-adopt">采纳策略</button>
    </article>
  `;
  host.querySelector(".btn-adopt")?.addEventListener("click", () => pushAdoptedRecord("全流程监控", adoptText));
}

function renderStrategyFunnel() {
  const host = document.getElementById("strategyCardsFunnel");
  if (!host) return;
  const action =
    "对「暂不引入」「已流失」占比异常类目做归因，反哺线索与选品模型；低效专辑清单优先安排焕新、重制或运营资源评估。";
  const adoptText = action;
  host.innerHTML = `
    <article class="strategy-card scene-c">
      <div class="sc-label">业务漏斗</div>
      <p class="sc-diagnosis">关注子漏斗分布与后验偏差</p>
      <p class="sc-action">${action}</p>
      <p class="sc-effect">结合明细导出与版权工作台联动闭环。</p>
      <button type="button" class="btn-adopt">采纳策略</button>
    </article>`;
  host.querySelector(".btn-adopt")?.addEventListener("click", () => pushAdoptedRecord("业务漏斗数据", adoptText));
}

function renderAllModuleStrategies() {
  renderStrategyM1();
  renderStrategyM2();
  renderStrategyMonitor();
  renderStrategyFunnel();
}

function renderAdopted() {
  const ul = document.getElementById("adoptedList");
  if (!ul) return;
  if (adoptedStrategies.length === 0) {
    ul.innerHTML = "<li>暂无采纳记录</li>";
    return;
  }
  ul.innerHTML = adoptedStrategies.map((a) => `<li><time>${a.ts}</time> — ${a.text}</li>`).join("");
}

function renderGapPills() {
  const host = document.getElementById("gapAlerts");
  if (!host) return;
  const gaps = findWorstStageGaps();
  host.innerHTML = gaps
    .map((g) => {
      const ok = g.gap <= 0;
      return `<span class="gap-pill ${ok ? "ok" : "warn"}">${g.stage}：实际 ${g.actual.toFixed(0)} / 目标 ${g.target.toFixed(0)} ${ok ? "✓" : "缺口 " + g.gap.toFixed(0)}</span>`;
    })
    .join("");
}

let chartFunnel = null;
function renderFunnelChart() {
  const ctx = document.getElementById("chartFunnel");
  if (!ctx || typeof Chart === "undefined") return;
  recalcDecompose();
  const { byStage } = lastDecompose;
  const labels = STAGE_ORDER;
  const actual = labels.map((s) => actualByStage[s] ?? 0);
  const targets = labels.map((s) => byStage[s] ?? 0);

  if (chartFunnel) chartFunnel.destroy();
  chartFunnel = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "实际数量",
          data: actual,
          backgroundColor: "rgba(227,77,89,0.2)",
          borderColor: "#e34d59",
          borderWidth: 1,
          yAxisID: "y",
        },
        {
          label: "拆解目标（参考线）",
          data: targets,
          backgroundColor: "rgba(24,144,255,0.15)",
          borderColor: "#1890ff",
          borderWidth: 1,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "rgba(0,0,0,0.55)" } },
      },
      scales: {
        x: { ticks: { color: "rgba(0,0,0,0.55)" }, grid: { display: false } },
        y: {
          type: "linear",
          position: "left",
          title: { display: true, text: "实际数量", color: "#e34d59" },
          ticks: { color: "rgba(0,0,0,0.45)" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        y1: {
          type: "linear",
          position: "right",
          title: { display: true, text: "拆解目标", color: "#1890ff" },
          ticks: { color: "rgba(0,0,0,0.45)" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

/** 重算拆解、监控与策略（转化率编辑时不重建输入框，避免失焦） */
function refreshDerived() {
  renderDifficulty();
  renderGapChart();
  renderWaterfall();
  renderFunnelChart();
  renderGapPills();
  renderAllModuleStrategies();
  renderAdopted();
  renderPrdBoards();
}

function refreshAll() {
  renderRatesEditor();
  refreshDerived();
}

/** PRD ② 版权跟进分布（演示占比，对接天鉴 follow_status 后替换） */
const MOCK_FOLLOW_STATUS = [
  { name: "待跟进", n: 42 },
  { name: "寻源中", n: 118 },
  { name: "已流失", n: 36 },
  { name: "暂不引入", n: 54 },
  { name: "确权中", n: 61 },
  { name: "谈判中", n: 88 },
  { name: "待入库", n: 73 },
];

/** PRD ③ 制作子流程（演示） */
const MOCK_PRODUCTION_FLOW = [
  { name: "邀约", n: 210 },
  { name: "试音中", n: 165 },
  { name: "入库→发单", n: 142 },
  { name: "接单", n: 128 },
  { name: "入库→上架", n: 96 },
];

function renderMainFunnelTable() {
  const tbody = document.getElementById("tbodyMainFunnel");
  if (!tbody) return;
  const mom = ["+4.2%", "+1.1%", "−0.8%", "+2.0%", "+0.5%", "+3.1%"];
  tbody.innerHTML = STAGE_ORDER.map((st, i) => {
    const n = actualByStage[st] ?? 0;
    return `<tr><td>${st}</td><td>${n.toFixed(0)}</td><td>${mom[i] ?? "—"}（演示）</td></tr>`;
  }).join("");
}

function renderFollowBars() {
  const host = document.getElementById("followStatusBars");
  if (!host) return;
  const max = Math.max(...MOCK_FOLLOW_STATUS.map((x) => x.n), 1);
  host.innerHTML = MOCK_FOLLOW_STATUS.map(
    (row) => `
    <div class="prd-bar-row">
      <span>${row.name}</span>
      <div class="prd-bar-track"><div class="prd-bar-fill" style="width:${(row.n / max) * 100}%"></div></div>
      <span>${row.n}</span>
    </div>
  `
  ).join("");
}

function renderProductionBars() {
  const host = document.getElementById("productionFlowBars");
  if (!host) return;
  const max = Math.max(...MOCK_PRODUCTION_FLOW.map((x) => x.n), 1);
  host.innerHTML = MOCK_PRODUCTION_FLOW.map(
    (row) => `
    <div class="prd-bar-row">
      <span>${row.name}</span>
      <div class="prd-bar-track"><div class="prd-bar-fill" style="width:${(row.n / max) * 100}%"></div></div>
      <span>${row.n}</span>
    </div>
  `
  ).join("");
}

function renderAlbumMatrix() {
  const host = document.getElementById("priorPosteriorMatrix");
  if (!host) return;
  const cells = [
    { t: "天鉴 S → 后验达标", v: "82%" },
    { t: "先验 A → 后验 EF", v: "预警 12 条" },
    { t: "低效专辑（演示）", v: "待导出 5 条" },
    { t: "会员收入对齐", v: "datasetId 37" },
  ];
  host.innerHTML = cells
    .map((c) => `<div class="prd-matrix-cell"><strong>${c.t}</strong>${c.v}</div>`)
    .join("");
}

function bindPrdTabs() {
  const tabs = document.querySelectorAll(".prd-tab");
  const panels = document.querySelectorAll(".prd-panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.getAttribute("data-tab");
      tabs.forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      panels.forEach((p) => {
        const show = p.getAttribute("data-panel") === id;
        p.classList.toggle("is-visible", show);
        p.hidden = !show;
      });
    });
  });
}

function renderPrdBoards() {
  renderMainFunnelTable();
  renderFollowBars();
  renderProductionBars();
  renderAlbumMatrix();
}

function bindPageNav() {
  document.querySelectorAll("a[data-nav]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const href = el.getAttribute("href");
      if (!href || href === "#") return;
      const target = document.querySelector(href);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (href === "#top") {
        document.getElementById("top")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      document.querySelectorAll("a.nav-item.active").forEach((a) => a.classList.remove("active"));
      el.classList.add("active");
    });
  });
}

function bindUi() {
  document.getElementById("btnApplyTarget")?.addEventListener("click", () => {
    const type = /** @type {TargetType} */ (document.getElementById("targetType")?.value || "Revenue");
    const val = parseFloat(document.getElementById("targetValue")?.value || "0");
    currentTarget.target_type = type;
    currentTarget.target_value = val;
    currentTarget.target_id = "T-" + Date.now();
    refreshAll();
  });
  bindPageNav();
  bindPrdTabs();
}

document.addEventListener("DOMContentLoaded", () => {
  bindUi();
  refreshAll();
});
