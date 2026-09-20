import { z } from 'zod';

/**
 * What the racks-and-shelves screens send. Strict: an unknown field is refused, so a clientId or a
 * locationId in the body can never steer a write (the location comes from the URL and is checked
 * against the shop).
 */

const KINDS = ['AREA', 'RACK', 'CUPBOARD', 'SHELF', 'BOX', 'STACK', 'BUNDLE', 'RAIL', 'RAIL_SECTION', 'COUNTER', 'DRAWER', 'DISPLAY', 'TRUNK', 'OTHER'] as const;

const kind = z.enum(KINDS, { errorMap: () => ({ message: 'Choose what this is: area, rack, cupboard, shelf, box and so on.' }) });
const id = (what: string) => z.string({ required_error: `${what} is needed.` }).min(1, `${what} is needed.`).max(64);
const code = z.union([z.string(), z.number()]);
const name = z.string().trim().max(80, 'A name can be at most 80 characters.').optional().nullable();
const colour = z.string().trim().max(24, 'A colour can be at most 24 characters.').optional().nullable();
const capacity = z.number().int('Capacity is a whole number of pieces.').min(1, 'Capacity is at least 1 piece.').max(100000).optional().nullable();
const walkOrder = z.number().int('Walking order is a whole number.').min(0).max(1_000_000);
const pieces = z.number({ invalid_type_error: 'Quantity must be a number.' })
  .int('Quantity must be a whole number of pieces.').min(1, 'Quantity must be at least 1.').max(100000, 'That is too many pieces at once.');

export const createSpotSchema = z.object({
  parentId: id('The parent').optional().nullable(),
  kind,
  code,
  name,
  walkOrder: walkOrder.optional(),
  isShopFloor: z.boolean().optional(),
  colour,
  capacity,
  isTemporary: z.boolean().optional()
}).strict();

const range = z.union([
  z.object({ codes: z.array(code).min(1).max(2000) }).strict(),
  z.object({ from: z.number().int(), to: z.number().int(), pad: z.number().int().min(0).max(4).optional(), prefix: z.string().max(10).optional() }).strict(),
  z.object({ letterFrom: z.string().length(1), letterTo: z.string().length(1), prefix: z.string().max(10).optional() }).strict()
]);

export const bulkSpotsSchema = z.object({
  parentId: id('The parent').optional().nullable(),
  /** Only used when the first level is an area. */
  isShopFloor: z.boolean().optional(),
  levels: z.array(z.object({
    kind,
    range,
    /** One number per parent above: rack 1 gets 6 shelves, rack 2 gets 4. Checked in setup-plan.ts. */
    perParent: z.array(z.number().int('How many must be a whole number.').min(0).max(2000)).max(2000).optional()
  }).strict()).min(1, 'Add at least one level.').max(4, 'At most 4 levels.'),
  preview: z.boolean().optional()
}).strict();

export const updateSpotSchema = z.object({
  code: code.optional(),
  name,
  walkOrder: walkOrder.optional(),
  isShopFloor: z.boolean().optional(),
  colour,
  capacity,
  isTemporary: z.boolean().optional(),
  active: z.boolean().optional(),
  kind: kind.optional()
}).strict().refine(v => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export const moveSchema = z.object({
  locationId: id('The location'),
  variantId: id('The item'),
  /** Leave out to put away pieces that are not on a shelf yet. */
  fromSpotId: id('The shelf it comes from').optional().nullable(),
  /** Leave out to take pieces off a shelf, back to Not shelved. */
  toSpotId: id('The shelf it goes to').optional().nullable(),
  quantity: pieces,
  note: z.string().trim().max(200).optional().nullable()
}).strict()
  .refine(v => v.fromSpotId || v.toSpotId, { message: 'Say which shelf the pieces come from or go to.' })
  .refine(v => !v.fromSpotId || v.fromSpotId !== v.toSpotId, { message: 'The pieces are already on that shelf.' });

export const putawaySchema = z.object({
  locationId: id('The location'),
  variantId: id('The item'),
  spotId: id('The shelf'),
  quantity: pieces
}).strict();

export const moveAllSchema = z.object({
  fromSpotId: id('The shelf it comes from'),
  toSpotId: id('The shelf it goes to')
}).strict().refine(v => v.fromSpotId !== v.toSpotId, { message: 'Choose a different shelf to move to.' });

export const resolveIssueSchema = z.object({
  note: z.string().trim().max(500, 'A note can be at most 500 characters.').optional().nullable()
}).strict();


/** One shelf's worth of the first fill, saved in one go. */
export const fillShelfSchema = z.object({
  lines: z.array(z.object({
    variantId: id('The item'),
    quantity: pieces
  }).strict()).min(1, 'Add at least one item, or use Skip shelf.').max(200, 'That is a lot for one shelf. Save these, then carry on.'),
  /** Made on the phone, once per shelf visit: a retry after the network drops is not a second save. */
  saveKey: z.string().min(8, 'The save key is missing.').max(64)
}).strict();

export const finishFillSchema = z.object({
  locationId: id('The location'),
  /** The second press, after the screen has named the shelves left over. */
  force: z.boolean().optional()
}).strict();

export type CreateSpotInput = z.infer<typeof createSpotSchema>;
export type BulkSpotsInput = z.infer<typeof bulkSpotsSchema>;
export type UpdateSpotInput = z.infer<typeof updateSpotSchema>;
export type MoveInput = z.infer<typeof moveSchema>;
