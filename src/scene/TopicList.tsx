import { ChevronRight, GitBranch } from 'lucide-react';
import type { Session } from '../contracts';
import { formatTime } from '../input/transcript';

export default function TopicList({ session, selectedTopicId, onSelectTopic, mapping, error, onRetry }: {
  session: Session;
  selectedTopicId: string | null;
  onSelectTopic: (id: string) => void;
  mapping: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const pending = session.turns.filter(turn => turn.final && !session.turnTopics[turn.id]).length;
  const aiTopics = Boolean(session.mapHistory?.length);
  const previewTopics = session.coachHistory.some(update => update.provider === 'local-preview');
  return <section className="topic-list" aria-label="Conversation topics">
    <div className="topic-list-heading">
      <div><span className="eyebrow">THE CONVERSATION SO FAR</span><h1>Topics</h1></div>
      <span className="topic-provider">{aiTopics ? previewTopics ? 'Preview + AI' : 'AI topics' : session.topics.length ? 'Preview topics' : 'Waiting for speech'}</span>
    </div>
    <p className="topic-list-intro">Related exchanges stay together. Select a topic to see its latest exchange.</p>
    <div className="topic-list-scroll">
      {!session.topics.length && <div className="topic-empty"><GitBranch size={28} /><h2>{pending ? 'Finding the first topic…' : 'Start with the conversation.'}</h2><p>{pending ? 'The completed exchange is ready. Topics will appear here when analysis finishes.' : session.mode === 'replay' ? 'Press Play or Next exchange. Topics appear after each completed exchange.' : 'Speak or type a response. Topics will appear here.'}</p></div>}
      {session.topics.map((topic, index) => {
        const turns = session.turns.filter(turn => session.turnTopics[turn.id] === topic.id);
        const latest = turns.at(-1);
        const current = topic.id === session.activeTopicId;
        const selected = topic.id === selectedTopicId;
        return <button key={topic.id} className={`topic-row ${current ? 'current' : ''} ${selected ? 'selected' : ''}`} aria-label={`View topic: ${topic.label}`} aria-pressed={selected} onClick={() => onSelectTopic(topic.id)}>
          <span className="topic-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="topic-row-content">
            <span className="topic-row-heading"><strong>{topic.label}</strong>{current && <span className="topic-current">Current</span>}{selected && <span className="topic-selected">Viewing</span>}</span>
            {latest && <span className="topic-excerpt">“{latest.text}”</span>}
            <span className="topic-row-meta">{turns.length} {turns.length === 1 ? 'exchange' : 'exchanges'}{latest && <> · Latest: {latest.speaker} at {formatTime(latest.atMs)}</>}</span>
          </span>
          <ChevronRight size={17} />
        </button>;
      })}
    </div>
    <div className="topic-list-status" role="status">
      {error ? <><span>Topics could not update. Your transcript is still available.</span><button className="text-button" onClick={onRetry}>Retry analysis</button><details><summary>Error details</summary>{error}</details></>
        : mapping || pending ? <><span className="pulse-dot" />Grouping {pending || 'new'} {pending === 1 ? 'exchange' : 'exchanges'}…</>
          : <><span className="soft-dot" />{aiTopics ? 'Topics are up to date.' : 'Local preview · topics use keyword rules.'}</>}
    </div>
  </section>;
}
