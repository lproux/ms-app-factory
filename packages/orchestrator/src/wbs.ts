import { AppFactoryError, createLogger, span } from '@app-factory/shared';

const log = createLogger('orchestrator:wbs');

export interface Step<C> {
  id: string;
  description: string;
  parallelGroup?: string;
  dependsOn?: string[];
  run: (ctx: C) => Promise<void>;
}

export interface RunOptions {
  planOnly?: boolean;
  onStep?: (id: string, phase: 'start' | 'done' | 'fail', err?: Error) => void;
}

export async function execute<C>(steps: Step<C>[], ctx: C, opts: RunOptions = {}): Promise<void> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  if (opts.planOnly) {
    for (const s of steps) {
      log.info({ id: s.id, parallelGroup: s.parallelGroup, dependsOn: s.dependsOn }, s.description);
    }
    return;
  }

  while (done.size < steps.length) {
    const ready = steps.filter(
      (s) => !done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      const missing = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new AppFactoryError('WBS_DEADLOCK', `cannot resolve dependencies for: ${missing.join(', ')}`);
    }
    const groups = new Map<string, Step<C>[]>();
    for (const s of ready) {
      const g = s.parallelGroup ?? s.id;
      const arr = groups.get(g) ?? [];
      arr.push(s);
      groups.set(g, arr);
    }
    const nextGroup = groups.values().next().value as Step<C>[];
    await Promise.all(
      nextGroup.map((s) =>
        span(`step:${s.id}`, async () => {
          opts.onStep?.(s.id, 'start');
          try {
            await s.run(ctx);
            done.add(s.id);
            opts.onStep?.(s.id, 'done');
          } catch (err) {
            opts.onStep?.(s.id, 'fail', err as Error);
            throw err;
          }
        }),
      ),
    );
    if (!byId.has(nextGroup[0]!.id)) {
      throw new AppFactoryError('WBS_INTERNAL', 'unreachable');
    }
  }
}
