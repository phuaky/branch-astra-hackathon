import type { Assessment } from '../contracts';

export function assessmentLabel(assessment: Assessment | null): string {
  return assessment?.maximum ? `${assessment.total}/${assessment.maximum}` : 'Not rated';
}

export function compareAssessments(before: Assessment | null, after: Assessment | null) {
  if (!before || !after || before.rubricVersion !== after.rubricVersion) return [];
  return before.dimensions.map(dimension => ({
    id: dimension.id, label: dimension.label, before: dimension.score,
    after: after.dimensions.find(item => item.id === dimension.id)?.score ?? null,
  }));
}
