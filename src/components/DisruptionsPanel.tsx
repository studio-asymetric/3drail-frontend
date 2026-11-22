import React from 'react';
import type { Copy } from '../i18n';
import type { DisruptionEvent } from '../data/disruptionService';

/** One line saying what the notice means, in the app's language. */
export function describeDisruption(event: DisruptionEvent, t: Copy): string {
  if (event.kind === 'cancel') {
    const what = event.full || !event.section ? t.alertCancelledFull : t.alertCancelledSection(event.section.from, event.section.to);
    if (!event.replacement) {
      return what;
    }
    const replacement =
      event.replacement.kind === 'none' ? t.alertNoReplacement : t.alertReplacement(event.replacement.text);
    return `${what}, ${replacement}`;
  }
  if (event.kind === 'delay') {
    return t.alertDelay(event.minutes ?? 0, event.station ?? '', Boolean(event.forecast));
  }
  return event.note || event.text;
}

const trainLabel = (event: DisruptionEvent) =>
  event.train ? `${event.train.type} ${event.train.number}` : '';

const minutesAgo = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

type Props = {
  events: DisruptionEvent[];
  t: Copy;
  /** Train numbers currently on the map: only those can be opened. */
  liveTrains: Set<string>;
  sourceName: string;
  sourceUrl: string;
  onTrain: (trainNumber: string) => void;
  onSection: (stationName: string) => void;
};

export const DisruptionsPanel: React.FC<Props> = ({
  events,
  t,
  liveTrains,
  sourceName,
  sourceUrl,
  onTrain,
  onSection,
}) => {
  const groups: Array<{ title: string; items: DisruptionEvent[] }> = [
    { title: t.alertsGroupClosures, items: events.filter((event) => event.kind === 'closure') },
    { title: t.alertsGroupCancelled, items: events.filter((event) => event.kind === 'cancel') },
    {
      title: t.alertsGroupDelays,
      items: events.filter((event) => event.kind === 'delay').sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0)),
    },
    { title: t.alertsGroupNotes, items: events.filter((event) => event.kind === 'note' || event.kind === 'info') },
  ].filter((group) => group.items.length > 0);

  return (
    <section className="alerts alerts--dock" aria-label={t.alertsAria}>
      <div className="alerts__body">
        {groups.length === 0 && <p className="alerts__empty">{t.alertsEmpty}</p>}
        {groups.map((group) => (
          <div className="alerts__group" key={group.title}>
            <h3 className="alerts__group-title">
              {group.title}
              <span className="alerts__count">{group.items.length}</span>
            </h3>
            <ul className="alerts__list">
              {group.items.map((event) => {
                const number = event.train?.number ?? '';
                const openTrain = number && liveTrains.has(number);
                const openSection = !number && event.section?.from;
                const clickable = Boolean(openTrain || openSection);
                const body = (
                  <>
                    <span className="alerts__row-top">
                      {event.train && <strong className="alerts__train">{trainLabel(event)}</strong>}
                      {event.from && event.to && (
                        <span className="alerts__route">
                          {event.from.name} {event.from.time} → {event.to.name} {event.to.time}
                        </span>
                      )}
                      <span className="alerts__ago">{t.alertTimeAgo(minutesAgo(event.at))}</span>
                    </span>
                    <span className={`alerts__what alerts__what--${event.kind}`}>
                      {event.kind === 'closure' ? event.text : describeDisruption(event, t)}
                    </span>
                  </>
                );
                return (
                  <li key={event.id}>
                    {clickable ? (
                      <button
                        type="button"
                        className="alerts__row is-clickable"
                        onClick={() => (openTrain ? onTrain(number) : onSection(event.section!.from))}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="alerts__row">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <footer className="alerts__foot">
        <a href={sourceUrl} target="_blank" rel="noreferrer">
          {t.alertsSource} ({sourceName})
        </a>
      </footer>
    </section>
  );
};
