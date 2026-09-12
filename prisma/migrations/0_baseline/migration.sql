-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('WOMEN', 'MEN', 'KIDS', 'UNISEX');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('STORE', 'ONLINE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('POS', 'ONLINE', 'MANUAL', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('READY_TO_WEAR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BarcodeType" AS ENUM ('INTERNAL_CODE128');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'TRASHED', 'OUT_OF_STOCK');

-- CreateEnum
CREATE TYPE "ProductImageType" AS ENUM ('COVER', 'GALLERY', 'RAW_UPLOAD');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InventoryReason" AS ENUM ('PURCHASE', 'SALE', 'DAMAGE', 'RETURN', 'CUSTOMER_RETURN', 'ADJUSTMENT', 'RETURN_TO_VENDOR', 'SAMPLE', 'MANUAL_ADJUSTMENT', 'TRANSFER', 'AUDIT', 'INITIAL_STOCK', 'SUPPLIER_DELIVERY', 'MANUAL_CORRECTION', 'AUDIT_CORRECTION', 'PURCHASE_RECEIPT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('WALK_IN', 'REGISTERED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PENDING', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'RECEIVED', 'INSPECTED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('PENDING', 'RESTOCK', 'DAMAGED', 'SCRAP');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DAMAGED_IN_TRANSIT', 'WRONG_ITEM', 'SIZE_ISSUE', 'CUSTOMER_REJECTED', 'DEFECTIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryAlertType" AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK', 'OVERSTOCK', 'REORDER_REQUIRED', 'STOCK_DISCREPANCY', 'SYSTEM_ERROR');

-- CreateEnum
CREATE TYPE "InventoryAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('BUG', 'QUESTION', 'BILLING', 'FEATURE_REQUEST', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StorefrontEventType" AS ENUM ('STOCK_UPDATED', 'PRODUCT_PUBLISHED', 'PRODUCT_UPDATED', 'PRODUCT_UNPUBLISHED', 'PRICE_CHANGED', 'AVAILABILITY_CHANGED');

-- CreateEnum
CREATE TYPE "StorefrontConnectionType" AS ENUM ('GENERIC', 'SHOPIFY', 'WOOCOMMERCE');

-- CreateEnum
CREATE TYPE "StorefrontConnectionStatus" AS ENUM ('PENDING_SYNC', 'ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShopifyInstallSource" AS ENUM ('SCALEEZY', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "ClientService" AS ENUM ('CATALOG_TRYON', 'SHOPPER_TRYON');

-- CreateEnum
CREATE TYPE "ClientServiceCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "catalog_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_template_items" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "metadata" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_catalog_items" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "metadata" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stocks" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_products" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProductCategory" NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "dress_type" TEXT,
    "fabric" TEXT,
    "craft" TEXT,
    "brand" TEXT,
    "base_price" DECIMAL(10,2) NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "trashed_at" TIMESTAMP(3),
    "previous_status" "ProductStatus",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_code" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode_type" "BarcodeType" NOT NULL DEFAULT 'INTERNAL_CODE128',
    "size" TEXT,
    "color_name" TEXT,
    "hex_code" TEXT,
    "compare_at_price" DECIMAL(10,2),
    "cost_price" DECIMAL(10,2),
    "last_purchase_cost" DECIMAL(10,2),
    "selling_price" DECIMAL(10,2),
    "inventory_value" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "average_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "last_cost_updated_at" TIMESTAMP(3),
    "last_received_at" TIMESTAMP(3),
    "last_movement_at" TIMESTAMP(3),
    "reorder_level" INTEGER NOT NULL DEFAULT 0,
    "reorder_qty" INTEGER,
    "barcode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sales_order_item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reserved_qty" INTEGER NOT NULL,
    "dispatched_qty" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_product_images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "variant_id" TEXT,
    "url" TEXT NOT NULL,
    "storage_path" TEXT,
    "file_name" TEXT,
    "file_size" INTEGER,
    "alt_text" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "image_type" "ProductImageType" NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "reason" "InventoryReason" NOT NULL,
    "sku" TEXT,
    "variant_code" TEXT,
    "barcode" TEXT,
    "product_title" TEXT,
    "quantity" INTEGER NOT NULL,
    "balance_before" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "notes" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "unit_cost" DECIMAL(10,2),
    "total_cost" DECIMAL(15,2),
    "metadata" JSONB,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfers" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "transfer_number" TEXT NOT NULL,
    "from_location_id" TEXT NOT NULL,
    "to_location_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requested_by" TEXT,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_label_templates" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "show_price" BOOLEAN NOT NULL DEFAULT true,
    "show_sku" BOOLEAN NOT NULL DEFAULT true,
    "show_barcode" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_label_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_client_sequences" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_client_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_counts" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "location_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "completed_by" TEXT,
    "total_items" INTEGER,
    "matched_items" INTEGER,
    "adjusted_items" INTEGER,
    "accuracy" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_count_items" (
    "id" TEXT NOT NULL,
    "stock_count_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variant_code" TEXT NOT NULL,
    "barcode" TEXT,
    "expected_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "supplier_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_order_date" TIMESTAMP(3),
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_delivery_date" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "total_amount" DECIMAL(65,30),
    "notes" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variant_code" TEXT NOT NULL,
    "barcode" TEXT,
    "supplier_sku" TEXT,
    "product_title" TEXT NOT NULL,
    "color" TEXT,
    "size" TEXT,
    "ordered_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(65,30) NOT NULL,
    "last_received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_daily_snapshots" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "total_value" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_units" INTEGER NOT NULL DEFAULT 0,
    "total_variants" INTEGER NOT NULL DEFAULT 0,
    "active_products" INTEGER NOT NULL DEFAULT 0,
    "low_stock_count" INTEGER NOT NULL DEFAULT 0,
    "dead_stock_value" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "open_po_value" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "customer_code" TEXT NOT NULL,
    "external_customer_id" TEXT,
    "name" TEXT NOT NULL,
    "company_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gst_number" TEXT,
    "billingAddress" TEXT,
    "shippingAddress" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "customer_type" "CustomerType" NOT NULL DEFAULT 'REGISTERED',
    "notes" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "external_order_id" TEXT,
    "source_system" TEXT,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "shipping_address" TEXT,
    "billing_address" TEXT,
    "channel" "SalesChannel" NOT NULL DEFAULT 'POS',
    "location_id" TEXT NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shipping_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_items" (
    "id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fulfilled_qty" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "unit_cost" DECIMAL(10,2) NOT NULL,
    "total_price" DECIMAL(15,2) NOT NULL,
    "total_cost" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "gross_profit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "dispatch_number" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'PENDING',
    "dispatched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_items" (
    "id" TEXT NOT NULL,
    "dispatch_id" TEXT NOT NULL,
    "sales_order_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dispatch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_ledger" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "dispatch_id" TEXT,
    "transaction_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revenue" DECIMAL(15,2) NOT NULL,
    "cost_of_goods" DECIMAL(15,2) NOT NULL,
    "gross_profit" DECIMAL(15,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_returns" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "ReturnReason" NOT NULL,
    "notes" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_items" (
    "id" TEXT NOT NULL,
    "sales_return_id" TEXT NOT NULL,
    "dispatch_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "disposition" "ReturnDisposition" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "password_encrypted" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "phone" TEXT,
    "receive_daily_report" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_error_logs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "user_id" TEXT,
    "user_email" TEXT,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "status_code" INTEGER,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_sessions" (
    "id" TEXT NOT NULL,
    "platform_admin_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "platform_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_actions" (
    "id" TEXT NOT NULL,
    "platform_admin_id" TEXT NOT NULL,
    "admin_email" TEXT NOT NULL,
    "admin_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "target_label" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_location_profiles" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "price_override" DECIMAL(10,2),

    CONSTRAINT "variant_location_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "ticket_number" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_by_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL DEFAULT 'OTHER',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "linked_error_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_alerts" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "type" "InventoryAlertType" NOT NULL,
    "severity" "InventoryAlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "variant_id" TEXT,
    "location_id" TEXT,
    "current_quantity" INTEGER,
    "threshold" INTEGER,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_alert_reads" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_alert_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "previous_quantity" INTEGER,
    "quantity" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_leads" (
    "id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "message" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "converted_client_id" TEXT,
    "converted_at" TIMESTAMP(3),
    "source_ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "supplier_sku" TEXT,
    "cost_price" DECIMAL(18,6),
    "lead_time_days" INTEGER,
    "min_order_qty" INTEGER,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_settings" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "business_name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "logo_url" TEXT,
    "logo_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_daily_location_snapshots" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "total_units" INTEGER NOT NULL DEFAULT 0,
    "total_value" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_daily_location_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_events" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "event_type" "StorefrontEventType" NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "product_code" TEXT,
    "sku" TEXT,
    "variant_id" TEXT,
    "location_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_connections" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StorefrontConnectionType" NOT NULL DEFAULT 'GENERIC',
    "status" "StorefrontConnectionStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "base_url" TEXT NOT NULL,
    "credential_hash" TEXT NOT NULL,
    "credential_prefix" TEXT NOT NULL,
    "location_ids" TEXT[],
    "sync_cursor" TEXT,
    "synced_at" TIMESTAMP(3),
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "last_response_status" INTEGER,
    "last_error" TEXT,
    "last_duration_ms" INTEGER,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_installations" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_shop_id" TEXT,
    "client_id" TEXT,
    "source" "ShopifyInstallSource" NOT NULL DEFAULT 'SCALEEZY',
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "claimed_by_user" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_id_maps" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "shopify_variant_id" TEXT NOT NULL,
    "shopify_inventory_item_id" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MATCHED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_id_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_location_maps" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "shopify_location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_location_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_webhook_receipts" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3),
    "outcome" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_inventory_echoes" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "shopify_inventory_item_id" TEXT NOT NULL,
    "shopify_location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "written_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_inventory_echoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_oauth_states" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "client_id" TEXT,
    "started_by_user" TEXT,
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_service_credentials" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" "ClientService" NOT NULL,
    "key_encrypted" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "status" "ClientServiceCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "added_by_admin" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tryon_usage" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" "ClientService" NOT NULL DEFAULT 'CATALOG_TRYON',
    "day" TEXT NOT NULL,
    "started" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "viewsGenerated" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tryon_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_service_limits" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" "ClientService" NOT NULL,
    "monthly_limit" INTEGER,
    "updated_by_admin" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_service_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_report_jobs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "report_date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_report_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_report_deliveries" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "report_date" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "attempted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_templates_name_key" ON "catalog_templates"("name");

-- CreateIndex
CREATE INDEX "catalog_template_items_template_id_idx" ON "catalog_template_items"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_template_items_template_id_type_value_category_key" ON "catalog_template_items"("template_id", "type", "value", "category");

-- CreateIndex
CREATE INDEX "client_catalog_items_client_id_type_is_active_idx" ON "client_catalog_items"("client_id", "type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "client_catalog_items_client_id_type_value_category_key" ON "client_catalog_items"("client_id", "type", "value", "category");

-- CreateIndex
CREATE INDEX "inventory_locations_client_id_idx" ON "inventory_locations"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_client_id_code_key" ON "inventory_locations"("client_id", "code");

-- CreateIndex
CREATE INDEX "inventory_stocks_client_id_location_id_idx" ON "inventory_stocks"("client_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocks_variant_id_location_id_key" ON "inventory_stocks"("variant_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_products_client_id_title_idx" ON "inventory_products"("client_id", "title");

-- CreateIndex
CREATE INDEX "inventory_products_client_id_status_idx" ON "inventory_products"("client_id", "status");

-- CreateIndex
CREATE INDEX "inventory_products_client_id_category_idx" ON "inventory_products"("client_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_products_client_id_product_code_key" ON "inventory_products"("client_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_products_client_id_slug_key" ON "inventory_products"("client_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variants_barcode_key" ON "inventory_product_variants"("barcode");

-- CreateIndex
CREATE INDEX "inventory_product_variants_product_id_idx" ON "inventory_product_variants"("product_id");

-- CreateIndex
CREATE INDEX "inventory_product_variants_client_id_last_movement_at_idx" ON "inventory_product_variants"("client_id", "last_movement_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variants_client_id_variant_code_key" ON "inventory_product_variants"("client_id", "variant_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variants_client_id_sku_key" ON "inventory_product_variants"("client_id", "sku");

-- CreateIndex
CREATE INDEX "inventory_reservations_variant_id_idx" ON "inventory_reservations"("variant_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_sales_order_item_id_idx" ON "inventory_reservations"("sales_order_item_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_client_id_idx" ON "inventory_reservations"("client_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_location_id_idx" ON "inventory_reservations"("location_id");

-- CreateIndex
CREATE INDEX "inventory_product_images_product_id_idx" ON "inventory_product_images"("product_id");

-- CreateIndex
CREATE INDEX "inventory_product_images_variant_id_idx" ON "inventory_product_images"("variant_id");

-- CreateIndex
CREATE INDEX "inventory_transactions_client_id_created_at_idx" ON "inventory_transactions"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transactions_variant_id_created_at_idx" ON "inventory_transactions"("variant_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transactions_location_id_idx" ON "inventory_transactions"("location_id");

-- CreateIndex
CREATE INDEX "inventory_transactions_type_idx" ON "inventory_transactions"("type");

-- CreateIndex
CREATE INDEX "inventory_transactions_reason_idx" ON "inventory_transactions"("reason");

-- CreateIndex
CREATE INDEX "inventory_transfers_client_id_status_idx" ON "inventory_transfers"("client_id", "status");

-- CreateIndex
CREATE INDEX "inventory_transfers_from_location_id_idx" ON "inventory_transfers"("from_location_id");

-- CreateIndex
CREATE INDEX "inventory_transfers_to_location_id_idx" ON "inventory_transfers"("to_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transfers_client_id_transfer_number_key" ON "inventory_transfers"("client_id", "transfer_number");

-- CreateIndex
CREATE INDEX "inventory_label_templates_client_id_idx" ON "inventory_label_templates"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_client_sequences_client_id_entity_type_key" ON "inventory_client_sequences"("client_id", "entity_type");

-- CreateIndex
CREATE INDEX "inventory_stock_counts_client_id_idx" ON "inventory_stock_counts"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_count_items_stock_count_id_variant_id_key" ON "inventory_stock_count_items"("stock_count_id", "variant_id");

-- CreateIndex
CREATE INDEX "suppliers_client_id_idx" ON "suppliers"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_client_id_supplier_code_key" ON "suppliers"("client_id", "supplier_code");

-- CreateIndex
CREATE INDEX "purchase_orders_client_id_idx" ON "purchase_orders"("client_id");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_client_id_po_number_key" ON "purchase_orders"("client_id", "po_number");

-- CreateIndex
CREATE INDEX "purchase_order_items_po_id_idx" ON "purchase_order_items"("po_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_variant_id_idx" ON "purchase_order_items"("variant_id");

-- CreateIndex
CREATE INDEX "inventory_daily_snapshots_client_id_snapshot_date_idx" ON "inventory_daily_snapshots"("client_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_daily_snapshots_client_id_snapshot_date_key" ON "inventory_daily_snapshots"("client_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "customers_client_id_idx" ON "customers"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_client_id_customer_code_key" ON "customers"("client_id", "customer_code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_client_id_external_customer_id_key" ON "customers"("client_id", "external_customer_id");

-- CreateIndex
CREATE INDEX "sales_orders_client_id_idx" ON "sales_orders"("client_id");

-- CreateIndex
CREATE INDEX "sales_orders_customer_id_idx" ON "sales_orders"("customer_id");

-- CreateIndex
CREATE INDEX "sales_orders_location_id_idx" ON "sales_orders"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_client_id_order_number_key" ON "sales_orders"("client_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_client_id_external_order_id_source_system_key" ON "sales_orders"("client_id", "external_order_id", "source_system");

-- CreateIndex
CREATE INDEX "sales_order_items_sales_order_id_idx" ON "sales_order_items"("sales_order_id");

-- CreateIndex
CREATE INDEX "sales_order_items_variant_id_idx" ON "sales_order_items"("variant_id");

-- CreateIndex
CREATE INDEX "dispatches_sales_order_id_idx" ON "dispatches"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_client_id_dispatch_number_key" ON "dispatches"("client_id", "dispatch_number");

-- CreateIndex
CREATE INDEX "dispatch_items_dispatch_id_idx" ON "dispatch_items"("dispatch_id");

-- CreateIndex
CREATE INDEX "dispatch_items_sales_order_item_id_idx" ON "dispatch_items"("sales_order_item_id");

-- CreateIndex
CREATE INDEX "sales_ledger_client_id_idx" ON "sales_ledger"("client_id");

-- CreateIndex
CREATE INDEX "sales_ledger_sales_order_id_idx" ON "sales_ledger"("sales_order_id");

-- CreateIndex
CREATE INDEX "sales_returns_sales_order_id_idx" ON "sales_returns"("sales_order_id");

-- CreateIndex
CREATE INDEX "sales_returns_client_id_status_idx" ON "sales_returns"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_client_id_return_number_key" ON "sales_returns"("client_id", "return_number");

-- CreateIndex
CREATE INDEX "sales_return_items_sales_return_id_idx" ON "sales_return_items"("sales_return_id");

-- CreateIndex
CREATE INDEX "sales_return_items_dispatch_item_id_idx" ON "sales_return_items"("dispatch_item_id");

-- CreateIndex
CREATE INDEX "users_client_id_idx" ON "users"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_client_id_email_key" ON "users"("client_id", "email");

-- CreateIndex
CREATE INDEX "client_error_logs_client_id_idx" ON "client_error_logs"("client_id");

-- CreateIndex
CREATE INDEX "client_error_logs_created_at_idx" ON "client_error_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_admin_sessions_platform_admin_id_idx" ON "platform_admin_sessions"("platform_admin_id");

-- CreateIndex
CREATE INDEX "platform_admin_sessions_client_id_idx" ON "platform_admin_sessions"("client_id");

-- CreateIndex
CREATE INDEX "platform_admin_actions_platform_admin_id_created_at_idx" ON "platform_admin_actions"("platform_admin_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_admin_actions_action_created_at_idx" ON "platform_admin_actions"("action", "created_at");

-- CreateIndex
CREATE INDEX "platform_admin_actions_created_at_idx" ON "platform_admin_actions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_client_id_name_key" ON "roles"("client_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "audit_logs_client_id_idx" ON "audit_logs"("client_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_location_profiles_variant_id_location_id_key" ON "variant_location_profiles"("variant_id", "location_id");

-- CreateIndex
CREATE INDEX "support_tickets_client_id_idx" ON "support_tickets"("client_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_client_id_ticket_number_key" ON "support_tickets"("client_id", "ticket_number");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticket_id_idx" ON "support_ticket_messages"("ticket_id");

-- CreateIndex
CREATE INDEX "inventory_alerts_client_id_idx" ON "inventory_alerts"("client_id");

-- CreateIndex
CREATE INDEX "inventory_alerts_is_resolved_idx" ON "inventory_alerts"("is_resolved");

-- CreateIndex
CREATE INDEX "inventory_alerts_is_read_idx" ON "inventory_alerts"("is_read");

-- CreateIndex
CREATE INDEX "inventory_alerts_is_pinned_idx" ON "inventory_alerts"("is_pinned");

-- CreateIndex
CREATE INDEX "inventory_alerts_type_idx" ON "inventory_alerts"("type");

-- CreateIndex
CREATE INDEX "inventory_alerts_variant_id_idx" ON "inventory_alerts"("variant_id");

-- CreateIndex
CREATE INDEX "inventory_alerts_location_id_idx" ON "inventory_alerts"("location_id");

-- CreateIndex
CREATE INDEX "inventory_alert_reads_user_id_idx" ON "inventory_alert_reads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_alert_reads_alert_id_user_id_key" ON "inventory_alert_reads"("alert_id", "user_id");

-- CreateIndex
CREATE INDEX "inventory_events_client_id_idx" ON "inventory_events"("client_id");

-- CreateIndex
CREATE INDEX "inventory_events_variant_id_idx" ON "inventory_events"("variant_id");

-- CreateIndex
CREATE INDEX "inventory_events_location_id_idx" ON "inventory_events"("location_id");

-- CreateIndex
CREATE INDEX "inventory_events_event_type_idx" ON "inventory_events"("event_type");

-- CreateIndex
CREATE INDEX "inventory_events_status_idx" ON "inventory_events"("status");

-- CreateIndex
CREATE INDEX "inventory_events_created_at_idx" ON "inventory_events"("created_at");

-- CreateIndex
CREATE INDEX "signup_leads_status_idx" ON "signup_leads"("status");

-- CreateIndex
CREATE INDEX "signup_leads_email_idx" ON "signup_leads"("email");

-- CreateIndex
CREATE INDEX "signup_leads_created_at_idx" ON "signup_leads"("created_at");

-- CreateIndex
CREATE INDEX "supplier_products_client_id_idx" ON "supplier_products"("client_id");

-- CreateIndex
CREATE INDEX "supplier_products_variant_id_idx" ON "supplier_products"("variant_id");

-- CreateIndex
CREATE INDEX "supplier_products_supplier_id_idx" ON "supplier_products"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_supplier_id_variant_id_key" ON "supplier_products"("supplier_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_settings_client_id_key" ON "client_settings"("client_id");

-- CreateIndex
CREATE INDEX "inventory_daily_location_snapshots_client_id_snapshot_date_idx" ON "inventory_daily_location_snapshots"("client_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_daily_location_snapshots_location_id_snapshot_dat_key" ON "inventory_daily_location_snapshots"("location_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "storefront_events_client_id_sequence_idx" ON "storefront_events"("client_id", "sequence");

-- CreateIndex
CREATE INDEX "storefront_events_client_id_created_at_idx" ON "storefront_events"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "storefront_events_event_type_idx" ON "storefront_events"("event_type");

-- CreateIndex
CREATE INDEX "storefront_connections_client_id_idx" ON "storefront_connections"("client_id");

-- CreateIndex
CREATE INDEX "storefront_connections_client_id_status_idx" ON "storefront_connections"("client_id", "status");

-- CreateIndex
CREATE INDEX "storefront_connections_credential_prefix_idx" ON "storefront_connections"("credential_prefix");

-- CreateIndex
CREATE INDEX "storefront_deliveries_status_next_attempt_at_idx" ON "storefront_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "storefront_deliveries_client_id_status_idx" ON "storefront_deliveries"("client_id", "status");

-- CreateIndex
CREATE INDEX "storefront_deliveries_connection_id_created_at_idx" ON "storefront_deliveries"("connection_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_deliveries_event_id_connection_id_key" ON "storefront_deliveries"("event_id", "connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_installations_shop_domain_key" ON "shopify_installations"("shop_domain");

-- CreateIndex
CREATE INDEX "shopify_installations_client_id_idx" ON "shopify_installations"("client_id");

-- CreateIndex
CREATE INDEX "shopify_installations_uninstalled_at_idx" ON "shopify_installations"("uninstalled_at");

-- CreateIndex
CREATE INDEX "shopify_id_maps_client_id_idx" ON "shopify_id_maps"("client_id");

-- CreateIndex
CREATE INDEX "shopify_id_maps_installation_id_sku_idx" ON "shopify_id_maps"("installation_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_id_maps_installation_id_variant_id_key" ON "shopify_id_maps"("installation_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_id_maps_installation_id_shopify_variant_id_key" ON "shopify_id_maps"("installation_id", "shopify_variant_id");

-- CreateIndex
CREATE INDEX "shopify_location_maps_client_id_idx" ON "shopify_location_maps"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_location_maps_installation_id_location_id_key" ON "shopify_location_maps"("installation_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_location_maps_installation_id_shopify_location_id_key" ON "shopify_location_maps"("installation_id", "shopify_location_id");

-- CreateIndex
CREATE INDEX "shopify_webhook_receipts_shop_domain_created_at_idx" ON "shopify_webhook_receipts"("shop_domain", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_webhook_receipts_webhook_id_topic_key" ON "shopify_webhook_receipts"("webhook_id", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_inventory_echoes_installation_id_shopify_inventory__key" ON "shopify_inventory_echoes"("installation_id", "shopify_inventory_item_id", "shopify_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_oauth_states_nonce_key" ON "shopify_oauth_states"("nonce");

-- CreateIndex
CREATE INDEX "shopify_oauth_states_expires_at_idx" ON "shopify_oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "client_service_credentials_client_id_idx" ON "client_service_credentials"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_service_credentials_client_id_service_key" ON "client_service_credentials"("client_id", "service");

-- CreateIndex
CREATE INDEX "tryon_usage_client_id_service_day_idx" ON "tryon_usage"("client_id", "service", "day");

-- CreateIndex
CREATE UNIQUE INDEX "tryon_usage_client_id_service_day_key" ON "tryon_usage"("client_id", "service", "day");

-- CreateIndex
CREATE UNIQUE INDEX "client_service_limits_client_id_service_key" ON "client_service_limits"("client_id", "service");

-- CreateIndex
CREATE INDEX "daily_report_jobs_client_id_report_date_idx" ON "daily_report_jobs"("client_id", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_report_jobs_client_id_report_date_key" ON "daily_report_jobs"("client_id", "report_date");

-- CreateIndex
CREATE INDEX "daily_report_deliveries_client_id_report_date_idx" ON "daily_report_deliveries"("client_id", "report_date");

-- CreateIndex
CREATE INDEX "daily_report_deliveries_job_id_idx" ON "daily_report_deliveries"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_report_deliveries_report_date_user_id_key" ON "daily_report_deliveries"("report_date", "user_id");

-- AddForeignKey
ALTER TABLE "catalog_template_items" ADD CONSTRAINT "catalog_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "catalog_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_product_variants" ADD CONSTRAINT "inventory_product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_product_images" ADD CONSTRAINT "inventory_product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_product_images" ADD CONSTRAINT "inventory_product_images_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_count_items" ADD CONSTRAINT "inventory_stock_count_items_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "inventory_stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_count_items" ADD CONSTRAINT "inventory_stock_count_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "dispatches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_sales_return_id_fkey" FOREIGN KEY ("sales_return_id") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_dispatch_item_id_fkey" FOREIGN KEY ("dispatch_item_id") REFERENCES "dispatch_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_sessions" ADD CONSTRAINT "platform_admin_sessions_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_location_profiles" ADD CONSTRAINT "variant_location_profiles_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_location_profiles" ADD CONSTRAINT "variant_location_profiles_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alert_reads" ADD CONSTRAINT "inventory_alert_reads_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "inventory_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_daily_location_snapshots" ADD CONSTRAINT "inventory_daily_location_snapshots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_deliveries" ADD CONSTRAINT "storefront_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "storefront_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_deliveries" ADD CONSTRAINT "storefront_deliveries_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "storefront_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_id_maps" ADD CONSTRAINT "shopify_id_maps_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_location_maps" ADD CONSTRAINT "shopify_location_maps_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_inventory_echoes" ADD CONSTRAINT "shopify_inventory_echoes_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_report_deliveries" ADD CONSTRAINT "daily_report_deliveries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "daily_report_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_report_deliveries" ADD CONSTRAINT "daily_report_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

