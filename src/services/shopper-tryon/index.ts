/**
 * Try-On: the shopper's one, reached by scanning the QR code on a garment.
 *
 * A separate platform service from 4-View Catalog Try-On, with its own key per client at the
 * gateway, its own allowance and its own meter. They are not two modes of one thing: one is a
 * merchant listing stock and the other is a customer in a shop, and a client could reasonably
 * buy either without the other.
 *
 * Two responsibilities, two files:
 *
 *   gateway.service   the outbound call to the gateway, and the garment-category mapping
 *   product.service   turning a scanned code into a garment, and refusing to leak anything else
 *
 * Credentials and usage metering are deliberately NOT duplicated here -- both services share
 * `services/tryon`, because "which key do we present" and "how much have they used" are the
 * same questions with a different service name, and two copies would drift.
 *
 * Importers take this folder, not the files inside it.
 */
export { shopperTryOnGatewayService, categoryFor } from './gateway.service';
export type { TryOnCategory, ShopperTryOnResult } from './gateway.service';
export { shopperTryOnProductService } from './product.service';
export type { ScannedGarment, ScanUrlOptions } from './product.service';
