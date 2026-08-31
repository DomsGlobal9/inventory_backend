import fs from 'fs';
import path from 'path';

const schemaPath = path.join(__dirname, 'prisma', 'schema.prisma');
let schema = fs.readFileSync(schemaPath, 'utf8');

const newSchema = `

// ─── ALERT AND OUTBOX SYSTEM ───

enum InventoryAlertType {
  LOW_STOCK
  OUT_OF_STOCK
  OVERSTOCK
  REORDER_REQUIRED
  STOCK_DISCREPANCY
  SYSTEM_ERROR
}

enum InventoryAlertSeverity {
  INFO
  WARNING
  CRITICAL
}

model InventoryAlert {
  id          String   @id @default(uuid())
  clientId    String   @map("client_id")

  type        InventoryAlertType
  severity    InventoryAlertSeverity

  title       String
  message     String

  variantId   String?  @map("variant_id")
  locationId  String?  @map("location_id")

  currentQuantity Int? @map("current_quantity")
  threshold       Int?

  isRead      Boolean  @default(false) @map("is_read")
  isResolved  Boolean  @default(false) @map("is_resolved")

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  variant     ProductVariant? @relation(fields: [variantId], references: [id])
  location    StockLocation?  @relation(fields: [locationId], references: [id])

  @@index([clientId])
  @@index([isResolved])
  @@index([isRead])
  @@index([type])
  @@index([variantId])
  @@index([locationId])
  @@map("inventory_alerts")
}

model InventoryEvent {
  id              String   @id @default(uuid())
  clientId        String   @map("client_id")

  eventType       String   @map("event_type")

  variantId       String   @map("variant_id")
  locationId      String   @map("location_id")

  previousQuantity Int?    @map("previous_quantity")
  quantity         Int

  available       Boolean
  status          String   @default("PENDING") // PENDING or PROCESSED

  createdAt       DateTime @default(now()) @map("created_at")
  processedAt     DateTime? @map("processed_at")

  variant     ProductVariant @relation(fields: [variantId], references: [id])
  location    StockLocation  @relation(fields: [locationId], references: [id])

  @@index([clientId])
  @@index([variantId])
  @@index([locationId])
  @@index([eventType])
  @@index([status])
  @@index([createdAt])
  @@map("inventory_events")
}
`;

if (!schema.includes('model InventoryAlert')) {
  fs.appendFileSync(schemaPath, newSchema);
  console.log('Appended InventoryAlert and InventoryEvent to schema.prisma');
} else {
  console.log('Schema already has models');
}
