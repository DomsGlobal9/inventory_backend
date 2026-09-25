/**
 * Photo jobs: making a set of photographs without anybody having to sit and watch it.
 *
 * Three responsibilities, in three files, because they change for different reasons and are read
 * by different people:
 *
 *   catalog   what the photo studio can photograph, and what it calls each view
 *   queue     making, listing, stopping and clearing the rows -- never talks to the studio
 *   runner    claiming a row and actually doing the work
 *
 * Importers take this folder, not the files inside it, so that split can change without every
 * caller changing with it.
 */
export { photoJobQueue } from './queue';
export type { EnqueueRequest, Refusal } from './queue';
export { PhotoJobRunner, MAX_ATTEMPTS } from './runner';
export { resolveTryOnCategory, pickRandomModelId, VIEW_ORDER, API_VIEW_TO_LOCAL } from './catalog';
