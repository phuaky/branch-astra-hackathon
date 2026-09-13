import { useState } from 'react';
import { Target, Check } from 'lucide-react';
import type { CallBrief } from '../contracts';
import { emptyBrief } from './strategy';

export default function CallBriefEditor({ brief, onSave }: { brief?: CallBrief; onSave: (brief: CallBrief) => void }) {
  const [draft, setDraft] = useState<CallBrief>(brief ?? emptyBrief);
  const update = (field: keyof CallBrief, value: string) => setDraft(current => ({ ...current, [field]: value }));
  return <form className="call-brief-editor" onSubmit={event => { event.preventDefault(); onSave({ ...draft, goal: draft.goal.trim() }); }}>
    <span className="dialog-symbol"><Target size={26} /></span>
    <h2>Where should this call go?</h2>
    <p>Give the coach a destination and the facts it can use. It will help you decide when to ask, recommend, or move toward a commitment.</p>
    <div className="goal-presets" aria-label="Common call goals">{['Qualify the opportunity', 'Book a demo', 'Agree on a scoped pilot', 'Confirm the purchase'].map(goal => <button key={goal} type="button" aria-pressed={draft.goal === goal} onClick={() => update('goal', goal)}>{goal}</button>)}</div>
    <label className="field-label">Call goal<input aria-label="Call goal" required maxLength={300} value={draft.goal} onChange={event => update('goal', event.target.value)} placeholder="The specific next step you want to agree" /></label>
    <label className="field-label">What you offer<textarea aria-label="What you offer" rows={3} maxLength={2400} value={draft.offer} onChange={event => update('offer', event.target.value)} placeholder="What you do, the problem you solve, and what a first engagement includes" /></label>
    <div className="brief-field-pair">
      <label className="field-label">Who it fits<textarea aria-label="Who it fits" rows={3} maxLength={1200} value={draft.idealCustomer} onChange={event => update('idealCustomer', event.target.value)} placeholder="The customers and situations you can help" /></label>
      <label className="field-label">Pricing & terms<textarea aria-label="Pricing and terms" rows={3} maxLength={1200} value={draft.pricing} onChange={event => update('pricing', event.target.value)} placeholder="Known prices, scope, and terms. Leave unknowns blank." /></label>
    </div>
    <label className="field-label">Limits & things to verify<textarea aria-label="Limits and things to verify" rows={2} maxLength={1600} value={draft.constraints} onChange={event => update('constraints', event.target.value)} placeholder="Promises you cannot make, approval requirements, or open questions" /></label>
    <p className="brief-note">Add supporting examples under Coach & evidence. The brief is sent with coaching requests and saved with your exported session.</p>
    <button className="button button-primary full-width" disabled={!draft.goal.trim()}><Check size={17} />Save call brief</button>
  </form>;
}
