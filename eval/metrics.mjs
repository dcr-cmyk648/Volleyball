export function clampMetric(value, min = 0, max = 100) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(min, Math.min(max, Number(value)));
}

export function weightedMean(components) {
  const usable = components.filter(component =>
    component &&
    component.value !== null &&
    Number.isFinite(Number(component.value)) &&
    Number(component.weight) > 0
  );
  const totalWeight = usable.reduce((sum, component) => sum + Number(component.weight), 0);
  if (totalWeight <= 0) return null;

  return clampMetric(
    usable.reduce((sum, component) => sum + Number(component.value) * Number(component.weight), 0) / totalWeight
  );
}

export function accuracyComponent(summary) {
  return summary?.accuracy === null ? null : clampMetric(Number(summary.accuracy) * 100);
}

export function brierComponent(summary) {
  return summary?.brier === null ? null : clampMetric((1 - Number(summary.brier)) * 100);
}

export function marginComponent(summary) {
  return summary?.marginMAE === null ? null : clampMetric(100 - Number(summary.marginMAE) * 5);
}

export function predictedGapComponent(gap, blowoutGap = 8) {
  if (!Number.isFinite(Number(gap)) || !Number.isFinite(Number(blowoutGap)) || Number(blowoutGap) <= 0) {
    return null;
  }
  return clampMetric(100 - (Number(gap) / Number(blowoutGap)) * 100);
}

export function closeSplitComponent(summary) {
  return summary?.selectedLowRiskRate === null
    ? null
    : clampMetric(Number(summary.selectedLowRiskRate) * 100);
}

export function blowoutAvoidanceComponent(summary) {
  return summary?.selectedHighRiskRate === null
    ? null
    : clampMetric((1 - Number(summary.selectedHighRiskRate)) * 100);
}

export function calibrationComponent(summary) {
  return summary?.actualMarginMAE === null ? null : clampMetric(100 - Number(summary.actualMarginMAE) * 10);
}

export function computeBalanceIQ(summary) {
  return weightedMean([
    { value: predictedGapComponent(summary?.avgPredictedBestGap), weight: 45 },
    { value: closeSplitComponent(summary), weight: 25 },
    { value: blowoutAvoidanceComponent(summary), weight: 20 },
    { value: calibrationComponent(summary), weight: 10 },
  ]);
}

export function computeSinglePassAccIQ(summary) {
  return weightedMean([
    { value: accuracyComponent(summary), weight: 45 },
    { value: brierComponent(summary), weight: 35 },
    { value: marginComponent(summary), weight: 20 },
  ]);
}

export function computeFwdAccIQ(forward) {
  return computeSinglePassAccIQ(forward);
}

export function computeBackAccIQ(back) {
  return computeSinglePassAccIQ(back);
}

export function computeAccIQ({ forward, back }) {
  return weightedMean([
    { value: computeFwdAccIQ(forward), weight: 65 },
    { value: computeBackAccIQ(back), weight: 35 },
  ]);
}

export function compareAccIQDesc(a, b) {
  return (Number(b?.accIQ) || -Infinity) - (Number(a?.accIQ) || -Infinity);
}

export function compareBalanceIQDesc(a, b) {
  return (Number(b?.balanceIQ) || -Infinity) - (Number(a?.balanceIQ) || -Infinity);
}

export function attachAccIQDeltas(rows, baselinePredicate) {
  const baseline = rows.find(baselinePredicate);
  const baselineAccIQ = Number(baseline?.accIQ);
  const baselineFwdAccIQ = Number(baseline?.fwdAccIQ);
  const baselineBackAccIQ = Number(baseline?.backAccIQ);
  rows.forEach(row => {
    row.accIQDelta = Number.isFinite(baselineAccIQ) && Number.isFinite(Number(row.accIQ))
      ? Number(row.accIQ) - baselineAccIQ
      : null;
    row.fwdAccIQDelta = Number.isFinite(baselineFwdAccIQ) && Number.isFinite(Number(row.fwdAccIQ))
      ? Number(row.fwdAccIQ) - baselineFwdAccIQ
      : null;
    row.backAccIQDelta = Number.isFinite(baselineBackAccIQ) && Number.isFinite(Number(row.backAccIQ))
      ? Number(row.backAccIQ) - baselineBackAccIQ
      : null;
  });
  return rows;
}

export function attachBalanceIQDeltas(rows, baselinePredicate) {
  const baseline = rows.find(baselinePredicate);
  const baselineBalanceIQ = Number(baseline?.balanceIQ);
  rows.forEach(row => {
    row.balanceIQDelta = Number.isFinite(baselineBalanceIQ) && Number.isFinite(Number(row.balanceIQ))
      ? Number(row.balanceIQ) - baselineBalanceIQ
      : null;
  });
  return rows;
}
