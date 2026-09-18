import { prisma } from '../lib/prisma';
import { SECURITY_ONLY } from './security-log';

// Shared by the Platform Console (all clients) and a client's own Team & Users page (their own
// clientId only) -- both need the same merge of AuditLog (real mutations by real users) into
// one standardized, sorted feed.
//
// The one difference is PlatformAdminSession, the record of Scaleezy staff entering a client's
// workspace. The console sees those; a client's own Team & Users page does not.
//
// This used to be shown to clients as deliberate transparency, and that is a genuine argument.
// It is now off by product decision, so what changes is only who can SEE the row -- every
// session is still recorded, still visible in the platform console, and still auditable. This
// hides it from one screen; it does not stop it being written.
export async function buildUnifiedAuditFeed(params: {
  clientId?: string;
  limit?: number;
  /** Scaleezy staff entering a workspace. Console only -- never a client's own feed. */
  includeAdminSessions?: boolean;
}) {
  const limit = params.limit ?? 100;
  const sessionWhere = params.clientId ? { clientId: params.clientId } : {};
  const activityWhere = params.clientId ? { clientId: params.clientId } : {};

  // Defaults to true so the console, which passes nothing, keeps its full picture. A client
  // feed has to ask for the narrower view explicitly, which is the safer direction for a flag
  // to fail in: forgetting it shows too much to an operator, not the reverse.
  const includeAdminSessions = params.includeAdminSessions !== false;

  const [sessions, activity, adminActions] = await Promise.all([
    includeAdminSessions
      ? prisma.platformAdminSession.findMany({
          where: sessionWhere,
          take: limit,
          orderBy: { startedAt: 'desc' },
          include: { platformAdmin: { select: { name: true, email: true } } }
        })
      : Promise.resolve([]),
    prisma.auditLog.findMany({
      where: { ...activityWhere, NOT: [...AUDIT_NOISE, ...SECURITY_ONLY].map(([entityType, action]) => ({ entityType, action })) },
      take: limit,
      orderBy: { createdAt: 'desc' }
    }),
    // Everything a platform admin did that was not entering an account: reading a password,
    // suspending a shop, issuing a service key. Gated on the same flag as sessions, because it
    // is the same category of information -- what Scaleezy staff did -- and belongs on the
    // console rather than in a client's own activity feed.
    //
    // Filtered by targetId when a client feed asks, since a client's id is what these rows
    // carry as their target. A row about a USER is matched through targetLabel, which carries
    // the client id in brackets.
    includeAdminSessions
      ? prisma.platformAdminAction.findMany({
          where: params.clientId
            ? { OR: [{ targetId: params.clientId }, { targetLabel: { contains: params.clientId } }] }
            : {},
          take: limit,
          orderBy: { createdAt: 'desc' }
        })
      : Promise.resolve([])
  ]);

  const userIds = [...new Set(activity.map(a => a.userId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  const sessionEvents = sessions.map(s => ({
    id: `session-${s.id}`,
    type: 'ADMIN_SESSION' as const,
    title: `${s.platformAdmin.name} (Scaleezy Support) accessed this account`,
    clientId: s.clientId,
    actorName: s.platformAdmin.name,
    timestamp: s.startedAt,
    endedAt: s.endedAt
  }));

  const activityEvents = activity.map(a => {
    const user = a.userId ? userMap.get(a.userId) : null;
    const actorName = user?.name || 'A user';
    // Keyed by "entityType:action", not action alone -- the audit-logger middleware infers
    // action purely from the URL's last path segment, so a generic code like STATUS or ROLE
    // is not unique to Team & Users; it's also what /purchase-orders/:id/status produces.
    // A global action->label map would silently mislabel unrelated events.
    const title = describeActivity(actorName, a.entityType, a.action);
    return {
      id: `activity-${a.id}`,
      type: 'USER_ACTIVITY' as const,
      title,
      clientId: a.clientId,
      actorName,
      timestamp: a.createdAt,
      action: a.action,
      entityType: a.entityType
    };
  });

  const adminActionEvents = adminActions.map(a => ({
    id: `admin-action-${a.id}`,
    type: 'ADMIN_ACTION' as const,
    title: `${a.adminName} (Scaleezy) ${ADMIN_ACTION_LABELS[a.action] ?? a.action.replace(/_/g, ' ').toLowerCase()}${a.targetLabel ? ` -- ${a.targetLabel}` : ''}`,
    clientId: a.targetType === 'CLIENT' ? a.targetId ?? '' : '',
    actorName: a.adminName,
    timestamp: a.createdAt,
    action: a.action,
    entityType: a.targetType
  }));

  return [...sessionEvents, ...activityEvents, ...adminActionEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

/*
 * "entityType:action" -> a complete, human phrase, for every action the app records.
 *
 * The keys are what audit-logger infers from each mutation route (resource + last path word),
 * plus the few a route names for itself (res.locals.auditAction) and the credential audit. The
 * old fallback glued those codes together, so a shopkeeper read "Priya Reddy password viewed
 * user credential" and "Priya Reddy status offer". A new route that is not listed here still
 * reads as a sentence -- see areaOf -- but belongs in this list.
 */
const ACTION_LABELS: Record<string, string> = {
  // Team and sign-in
  'TEAM:MEMBERS': 'added a team member',
  'TEAM:ROLE': "changed a team member's role",
  'TEAM:STATUS': 'switched a team member on or off',
  'TEAM:PASSWORD': "set a team member's password",
  'TEAM:RESEND': "sent a team member's sign-in details again",
  'USER_CREDENTIAL:PASSWORD_VIEWED': "viewed a team member's password",
  'USER_CREDENTIAL:PASSWORD_VIEW_REFUSED': "tried to view a team member's password and was refused",
  'USER:CHANGED_PASSWORD': 'changed their password',
  'ACCOUNT:PASSWORD_CHANGED': 'changed their own password',
  'ACCOUNT:SIGNED_OUT_OTHER_DEVICES': 'signed out of every other device',
  'ROLE:CREATED': 'created a role',
  'ROLE:UPDATED': "changed what a role can do",
  'ROLE:DELETED': 'deleted a role',

  // Shop settings
  'BRANDING:DETAILS': 'changed the shop details',
  'BRANDING:NAME': 'renamed the shop',
  'BRANDING:LOGO': 'changed the shop logo',
  'LOCATION:CREATED': 'added a location',
  'LOCATION:UPDATED': 'changed a location',
  'LOCATION:DELETED': 'deleted a location',
  'SUPPORT_TICKET:CREATED': 'opened a support ticket',
  'SUPPORT_TICKET:MESSAGES': 'replied on a support ticket',

  // Products
  'PRODUCT:CREATED': 'added a product',
  'PRODUCT:UPDATED': 'changed a product',
  'PRODUCT:VARIANTS': 'added a size or colour to a product',
  'PRODUCT:BULK': 'added sizes or colours to a product',
  'PRODUCT:BULK_STATUS': 'changed the status of several products',
  'PRODUCT:IMAGES': 'added product photos',
  'PRODUCT:DELETED': 'removed a product photo',
  'PRODUCT:ARCHIVE': 'archived a product',
  'PRODUCT:TRASH': 'moved a product to the bin',
  'PRODUCT:RESTORE': 'restored a product from the bin',
  'PRODUCT:HARD': 'deleted a product for good',
  'PRODUCT:APPLY': 'imported products from a file',
  'VARIANT:UPDATED': 'changed a size or colour of a product',
  'VARIANT:DELETED': 'deleted a size or colour of a product',
  'VARIANT:BULK_UPDATE': 'changed several items at once',
  'CATALOG:ITEMS': 'added a catalogue item',
  'CATALOG:UPDATED': 'changed a catalogue item',
  'CATALOG:DELETED': 'removed a catalogue item',
  'CATALOG_TRYON:GENERATE_CATALOG': 'started making try-on photos',
  'CATALOG_TRYON:CANCEL_JOB': 'stopped making try-on photos',

  // Stock
  'INVENTORY:STOCK_IN': 'added stock',
  'INVENTORY:STOCK_OUT': 'took stock out',
  'INVENTORY:ADJUSTMENT': 'corrected a stock count',
  'INVENTORY:TRANSACTIONS': 'recorded a stock movement',
  'INVENTORY:SET_COST': "set an item's cost",
  'INVENTORY:RECONCILE_VALUATION': 'recalculated the stock value',
  'INVENTORY:DELETED': 'dismissed a stock alert',
  'INVENTORY_TRANSFER:CREATED': 'moved stock between locations',
  'STOCK_COUNT:CREATED': 'set up a stock count',
  'STOCK_COUNT:START': 'started a stock count',
  'STOCK_COUNT:COMPLETE': 'finished a stock count',
  'STOCK_COUNT:CANCEL': 'cancelled a stock count',
  'SHELVE:SHELF_SPOT_CREATED': 'added a rack or shelf',
  'SHELVE:SHELF_SPOTS_CREATED': 'added racks and shelves',
  'SHELVE:SHELF_SPOTS_IMPORTED': 'imported racks and shelves from a file',
  'SHELVE:SHELF_SPOT_UPDATED': 'changed a rack or shelf',
  'SHELVE:SHELF_SPOT_REMOVED': 'removed a rack or shelf',
  'SHELVE:SHELF_PUT_AWAY': 'put stock away on a shelf',
  'SHELVE:SHELF_MOVE': 'moved stock between shelves',
  'SHELVE:SHELF_MOVE_ALL': 'moved everything off a shelf',
  'SHELVE:SHELF_NOT_FOUND': 'reported an item missing from its shelf',
  'SHELVE:SHELF_COUNTED': 'counted a shelf',
  'SHELVE:SHELF_ISSUE_RESOLVED': 'sorted out a shelf problem',

  // Buying
  'SUPPLIER:CREATED': 'added a supplier',
  'SUPPLIER:UPDATED': "changed a supplier's details",
  'SUPPLIER:DELETED': 'deleted a supplier',
  'SUPPLIER_PRODUCT:CREATED': 'linked an item to a supplier',
  'SUPPLIER_PRODUCT:DELETED': 'unlinked an item from a supplier',
  'SUPPLIER_PRODUCT:PREFERRED': 'chose the preferred supplier for an item',
  'PURCHASE_ORDER:CREATED': 'raised a purchase order',
  'PURCHASE_ORDER:MARKED_SENT': 'marked a purchase order as sent',
  'PURCHASE_ORDER:CANCELLED': 'cancelled a purchase order',
  'PURCHASE_ORDER:STATUS': 'marked a purchase order as sent or cancelled', // rows from before the route named it
  'PURCHASE_ORDER:EMAIL': 'emailed a purchase order to the supplier',
  'PURCHASE_ORDER:DELIVER_TO': 'changed where a purchase order is delivered',
  'PURCHASE_ORDER:RECEIVE': 'received goods on a purchase order',
  'REORDER:DRAFT_ORDERS': 'made draft purchase orders from Reorder',

  // Selling
  'COUNTER_SALE:CREATED': 'made a sale at the counter',
  'COUNTER_SALE:COUNTER_SALE': 'made a sale at the counter',
  'SALES_ORDER:CREATED': 'created an order',
  'SALES_ORDER:UPDATED': 'changed an order',
  'SALES_ORDER:ITEMS': 'added an item to an order',
  'SALES_ORDER:DELETED': 'deleted an order, or an item on one',
  'SALES_ORDER:CONFIRM': 'confirmed an order',
  'SALES_ORDER:CANCEL': 'cancelled an order',
  'DISPATCH:CREATED': 'dispatched an order',
  'RETURN:CREATED': 'started a return',
  'RETURN:RECEIVE': 'received returned goods',
  'RETURN:INSPECT': 'checked returned goods',
  'RETURN:COMPLETE': 'completed a return',
  'RETURN:REJECT': 'turned down a return',
  'CUSTOMER:CREATED': 'added a customer',
  'CUSTOMER:UPDATED': "changed a customer's details",

  // Offers
  'OFFER:CREATED': 'created an offer',
  'OFFER:UPDATED': 'changed an offer',
  'OFFER:STARTED': 'started an offer',
  'OFFER:PAUSED': 'paused an offer',
  'OFFER:RETIRED': 'retired an offer',
  'OFFER:STATUS': 'started, paused or retired an offer', // rows from before the route named it
  'OFFER:DUPLICATE': 'copied an offer',
  'OFFER:CODES': 'made discount codes for an offer',
  'OFFER:SETTINGS': 'changed how much the till may take off by hand',
  'OFFER:SHOPIFY': "changed an offer's link to Shopify",
  'OFFER:PUSH': 'sent an offer to Shopify',
  'OFFER:ACCEPT': "took Shopify's version of an offer",

  // Online stores
  'SHOPIFY_CONNECT:INSTALL': 'started connecting Shopify',
  'SHOPIFY_CONNECT:CLAIM': 'connected a Shopify store',
  'SHOPIFY_CONNECT:MATCH': 'matched products with Shopify',
  'SHOPIFY_CONNECT:UPDATED': 'chose which store a Shopify location fills from',
  'SHOPIFY_CONNECT:REPLAY': 'tried a Shopify order again',
  'SHOPIFY_CONNECT:REPLAY_ALL': 'tried all waiting Shopify orders again',
  'SHOPIFY_CONNECT:DISMISS': 'set aside a Shopify order that could not be added',
  'STOREFRONT_CONNECTION:CREATED': 'connected a website',
  'STOREFRONT_CONNECTION:UPDATED': 'changed a website connection',
  'STOREFRONT_CONNECTION:ENABLE': 'switched on a website connection',
  'STOREFRONT_CONNECTION:DISABLE': 'paused a website connection',
  'STOREFRONT_CONNECTION:REVOKE': 'removed a website connection',
  'STOREFRONT_CONNECTION:ROTATE': 'changed the secret key of a website connection',
  'STOREFRONT_CONNECTION:TEST': 'tested a website connection',
  'STOREFRONT_CONNECTION:RETRY': 'sent an update to a website again',

  // Reports
  'REPORT:SNAPSHOTS': 'saved a stock snapshot',
  'REPORT:RUN_SNAPSHOT': 'saved a stock snapshot',
};

/*
 * Recorded requests that change nothing a person would call activity. Leaving them in drowned
 * the feed: every price the till looked up was a "quote pricing" line, six in a row, and the
 * table keeps only the last 30 rows per shop, so they pushed real changes out altogether.
 * audit-logger skips these when writing; the feed skips any written before it did.
 */
export const AUDIT_NOISE: ReadonlyArray<readonly [entityType: string, action: string]> = [
  ['PRICING', 'QUOTE'],                    // the till pricing a bill as it is built
  ['ROLE', 'IMPACT'],                      // "who does this affect?" preview
  ['PRODUCT', 'VALIDATE'],                 // import file checked, nothing saved
  ['PRODUCT', 'UPLOAD_URL'],               // asking where to upload a photo
  ['BRANDING', 'UPLOAD_URL'],              // the same, for the logo
  ['SHELVE', 'BULK'],                      // racks previewed, not saved (a save names itself)
  ['SHELVE', 'IMPORT'],                    // the same, for an import
  ['INVENTORY', 'READ'],                   // an alert marked as read
  ['INVENTORY', 'READ_ALL'],
  ['INVENTORY', 'PIN'],
  ['STOCK_COUNT', 'UPDATED'],              // one line typed into a count; finishing it is logged
  ['COUNTER_SALE', 'COUNTER_SALE_REPEATED'], // the same sale pressed twice, nothing new
  ['TEAM', 'VIEW'],                        // USER_CREDENTIAL:PASSWORD_VIEWED records it already
];

export const isAuditNoise = (entityType: string, action: string) =>
  AUDIT_NOISE.some(([e, a]) => e === entityType && a === action);

/** What part of the app a row is about, for an action not in ACTION_LABELS. */
const AREAS: Record<string, string> = {
  BRANDING: 'shop settings', CATALOG: 'the catalogue', CATALOG_TRYON: 'try-on photos',
  COUNTER_SALE: 'counter sales', CUSTOMER: 'customers', DISPATCH: 'dispatches',
  INVENTORY: 'stock', INVENTORY_TRANSFER: 'stock transfers', LOCATION: 'locations', OFFER: 'offers',
  PRODUCT: 'products', PURCHASE_ORDER: 'purchase orders', REORDER: 'reorder', REPORT: 'reports',
  RETURN: 'returns', ROLE: 'roles', SALES_ORDER: 'orders', SHELVE: 'racks and shelves',
  SHOPIFY_CONNECT: 'Shopify', STOCK_COUNT: 'stock counts', STOREFRONT_CONNECTION: 'website connections',
  SUPPLIER: 'suppliers', SUPPLIER_PRODUCT: 'suppliers', SUPPORT_TICKET: 'support tickets',
  TEAM: 'the team', USER: 'their account', USER_CREDENTIAL: 'team passwords', VARIANT: 'products'
};

const areaOf = (entityType: string) =>
  AREAS[entityType] ?? entityType.replace(/_/g, ' ').toLowerCase();

/** One sentence for a recorded action, whatever it is. */
export function describeActivity(actorName: string, entityType: string, action: string) {
  const label = ACTION_LABELS[`${entityType}:${action}`];
  return label ? `${actorName} ${label}` : `${actorName} made a change in ${areaOf(entityType)}`;
}

/**
 * What each console action reads as in the log.
 *
 * Written as plain statements of what happened, not softened. Someone scanning this list is
 * usually scanning it because they are worried, and "viewed a shop owner's password in plain
 * text" is the sentence that answers them -- "VIEW_PASSWORD" is not.
 */
const ADMIN_ACTION_LABELS: Record<string, string> = {
  VIEW_PASSWORD: "viewed a user's password in plain text",
  RESET_USER_PASSWORD: "set a new password for a user",
  ONBOARD_CLIENT: 'created a new client',
  SUSPEND_CLIENT: "changed a client's suspension",
  DELETE_CLIENT: 'permanently deleted a client',
  SET_SERVICE_KEY: 'issued a service key',
  REVOKE_SERVICE_KEY: 'revoked a service key',
  SET_TRYON_LIMIT: 'changed a try-on limit',
  ASSUME_CLIENT: "entered a client's account",
  END_ASSUMED_SESSION: 'left an assumed account',
  CREATE_PLATFORM_ADMIN: 'created another platform admin',
  SET_PLATFORM_ADMIN_STATUS: "changed a platform admin's status",
  RESET_PLATFORM_ADMIN_PASSWORD: "reset a platform admin's password",
  REPLY_SUPPORT_TICKET: 'replied to a support ticket',
  UPDATE_SUPPORT_TICKET: 'changed a support ticket',
  UPDATE_LEAD: 'updated a lead',
  CONVERT_LEAD: 'converted a lead into a client'
};
