import type { Logger } from 'pino';
import type { Config } from './config';
import type { Db } from './db';
import type { Engine } from './engine/client';

/** What every part of the service needs, passed in explicitly so tests can swap any piece. */
export interface Ctx {
  db: Db;
  engine: Engine;
  config: Config;
  log: Logger;
}
