/** ZSSK mimoriadnosti as the proxy serves them (parsed from @zssk_mimoriadne, see proxy/mimoriadnosti.mjs). */
export interface DisruptionEvent {
  id: string;
  postId: string;
  /** When ZSSK posted it (ISO). */
  at: string;
  url: string;
  /** The post's own words. */
  text: string;
  kind: 'delay' | 'cancel' | 'note' | 'info' | 'closure';
  train?: { type: string; number: string } | null;
  from?: { name: string; time: string };
  to?: { name: string; time: string };
  /** delay: station the delay is reported from, minutes, and whether it is a forecast. */
  station?: string;
  minutes?: number;
  forecast?: boolean;
  /** cancel: the whole run, or just a section; what replaces it. */
  full?: boolean;
  section?: { from: string; to: string } | null;
  replacement?: { kind: 'none' | 'train' | 'bus'; text: string } | null;
  /** note / info: what to tell the passenger. */
  note?: string;
  /** closure: replacement buses run. */
  bus?: boolean;
}

export interface DisruptionPayload {
  fetchedAt: string;
  source: { name: string; url: string };
  events: DisruptionEvent[];
}

export async function fetchDisruptions(signal?: AbortSignal): Promise<DisruptionPayload | null> {
  try {
    const response = await fetch('/proxy/disruptions', { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Partial<DisruptionPayload>;
    return Array.isArray(body.events)
      ? { fetchedAt: body.fetchedAt ?? '', source: body.source ?? { name: '', url: '' }, events: body.events }
      : null;
  } catch {
    return null;
  }
}

/** Events about one train, most important first (cancellations, then forecasts, notes). */
export function eventsForTrain(events: DisruptionEvent[], trainNumber: string | undefined | null): DisruptionEvent[] {
  if (!trainNumber) {
    return [];
  }
  const order: Record<DisruptionEvent['kind'], number> = { cancel: 0, delay: 1, info: 2, note: 3, closure: 4 };
  return events
    .filter((event) => event.train?.number === trainNumber)
    .sort((left, right) => order[left.kind] - order[right.kind]);
}
